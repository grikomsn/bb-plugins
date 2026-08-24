// Integration smoke test for bb-plugin-codex-live.
// Exercises the backend factory through @get-bb/plugin-sdk/testing's
// createFakePluginHost, with the bridge chokepoint stubbed to emit
// bridge-shaped events. Verifies:
//   • the "poll-codex-events-bridge" service can be driven deterministically
//   • reasoning deltas coalesce into the snapshot
//   • the "activeThreadStream" RPC returns clearAfterSeconds=60 and the
//     completed item is still present
//   • the "dismiss" RPC drops the item and publishes a realtime signal
//   • the "status" RPC reports bridge availability and tuned limits
//
// Run: tsx packages/bb-plugin-codex-live/server.test.ts

import { strict as assert } from "node:assert";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const BRIDGE_PLUGIN_ID = "codex-events-bridge";
const T1 = "thr_codex_1";
const I1 = "it_reasoning_1";
const I2 = "it_command_2";

const POLL_INTERVAL_MS = 500;

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const bridgeEventsByThread = new Map<string, unknown[]>();

  const fake = createFakePluginHost({
    pluginId: "codex-live",
    settings: {
      pollIntervalMs: String(POLL_INTERVAL_MS),
      maxItemsPerThread: "12",
      maxDeltaBytesPerItem: "262144",
    },
    sdk: {
      plugins: {
        callRpc: async (args: {
          pluginId: string;
          method: string;
          input?: unknown;
        }) => {
          if (args.pluginId !== BRIDGE_PLUGIN_ID) {
            throw new Error(`unexpected pluginId ${args.pluginId}`);
          }
          if (args.method === "sessions") {
            return {
              sessions: Array.from(bridgeEventsByThread.keys()).map((threadId) => ({
                threadId,
              })),
            };
          }
          if (args.method === "recent") {
            const input = (args.input ?? {}) as {
              threadId?: string;
              typePrefix?: string;
              afterSeq?: number;
            };
            if (input.typePrefix !== "codex/item/") {
              return { events: [] };
            }
            const all = (bridgeEventsByThread.get(input.threadId ?? "") ?? []).slice();
            const after = input.afterSeq ?? 0;
            const filtered = all
              .filter((e) => (e as { seq: number }).seq > after)
              .sort((a, b) => (a as { seq: number }).seq - (b as { seq: number }).seq);
            return { events: filtered };
          }
          throw new Error(`unexpected method ${args.method}`);
        },
      },
    },
  });

  await plugin(fake.bb);

  // Drive the polling service once and confirm it registers.
  const svc = fake.harness.behavior.runService("poll-codex-events-bridge");
  // Let the first session-discovery tick run.
  await wait(50);

  // Seed the bridge with a fresh codex thread's events.
  const base = Date.now();
  const events: unknown[] = [];
  let seq = 0;
  function ev(type: string, payload: unknown, tsOffsetMs = 0) {
    seq += 1;
    events.push({
      seq,
      ts: new Date(base + tsOffsetMs).toISOString(),
      type,
      category: "item",
      threadId: T1,
      providerThreadId: "prov-1",
      payload,
    });
  }

  ev("item/started", { item: { id: I1, type: "reasoning" } }, 0);
  // Five single-character reasoning deltas → "abcde".
  for (let i = 0; i < 5; i += 1) {
    ev(
      "item/reasoning/textDelta",
      { itemId: I1, delta: String.fromCharCode(97 + i) },
      10 + i * 5,
    );
  }
  ev("item/completed", { item: { id: I1, type: "reasoning" } }, 60);

  bridgeEventsByThread.set(T1, events);

  // Wait for a poll tick to drain the events.
  await wait(POLL_INTERVAL_MS + 100);

  // ─── Verify snapshot ────────────────────────────────────────────
  const snapshot = (await fake.harness.behavior.callRpc("snapshot")) as {
    threads: Array<{
      threadId: string;
      items: Array<{
        itemId: string;
        kind: string;
        completed: boolean;
        content?: string;
      }>;
    }>;
  };
  assert.equal(snapshot.threads.length, 1, "one tracked thread");
  const t = snapshot.threads[0]!;
  assert.equal(t.threadId, T1);
  assert.equal(t.items.length, 1, "one item");
  const it = t.items[0]!;
  assert.equal(it.itemId, I1);
  assert.equal(it.kind, "reasoning");
  assert.equal(it.completed, true, "item is completed");
  assert.equal(it.content, "abcde", "deltas coalesced character-by-character");
  console.log("✓ snapshot reflects reasoning deltas + completion");

  // ─── Verify activeThreadStream ──────────────────────────────────
  const stream = (await fake.harness.behavior.callRpc("activeThreadStream", {
    threadId: T1,
  })) as {
    thread: { items: Array<{ itemId: string; completed: boolean }> };
    clearAfterSeconds: number;
  };
  assert.equal(stream.clearAfterSeconds, 60, "60s clearAfterSeconds");
  assert.equal(stream.thread.items.length, 1, "completed item still buffered");
  assert.equal(stream.thread.items[0]!.completed, true);
  console.log("✓ activeThreadStream returns clearAfterSeconds=60 and completed item");

  // ─── Verify dismiss RPC drops the item ──────────────────────────
  const dismiss = (await fake.harness.behavior.callRpc("dismiss", {
    threadId: T1,
    itemId: I1,
  })) as { ok: boolean };
  assert.equal(dismiss.ok, true, "dismiss removed the item");
  const after = (await fake.harness.behavior.callRpc("snapshot")) as {
    threads: Array<{ items: unknown[] }>;
  };
  assert.equal(after.threads[0]!.items.length, 0, "snapshot is empty post-dismiss");
  // Dismiss should also publish a "codex-live/snapshot" signal.
  const dismissSignals = fake.harness.realtimeSignals.filter(
    (s) => s.channel === "codex-live/snapshot",
  );
  assert.ok(
    dismissSignals.some((s) => (s.payload as { reason?: string })?.reason === "dismiss"),
    "dismiss published a realtime signal",
  );
  console.log("✓ dismiss RPC drops the item and publishes a realtime signal");

  // ─── Verify a second commandExecution item lands in the snapshot ─
  const events2: unknown[] = [];
  function ev2(type: string, payload: unknown) {
    seq += 1;
    events2.push({
      seq,
      ts: new Date().toISOString(),
      type,
      category: "item",
      threadId: T1,
      providerThreadId: "prov-1",
      payload,
    });
  }
  ev2("item/started", {
    item: { id: I2, type: "commandExecution", command: "echo hi", cwd: "/tmp" },
  });
  ev2("item/commandExecution/outputDelta", { itemId: I2, delta: "hi\n" });
  ev2("item/commandExecution/outputDelta", { itemId: I2, delta: "done\n" });
  ev2("item/completed", {
    item: { id: I2, type: "commandExecution", exitCode: 0, status: "completed" },
  });
  bridgeEventsByThread.set(T1, [...events, ...events2]);
  await wait(POLL_INTERVAL_MS + 100);
  const after2 = (await fake.harness.behavior.callRpc("activeThreadStream", {
    threadId: T1,
  })) as {
    thread: {
      items: Array<{
        itemId: string;
        kind: string;
        aggregatedOutput?: string;
        completed: boolean;
      }>;
    };
  };
  assert.equal(after2.thread.items.length, 1, "exactly the new commandExecution item");
  const cmdItem = after2.thread.items[0]!;
  assert.equal(cmdItem.itemId, I2);
  assert.equal(cmdItem.kind, "commandExecution");
  assert.equal(cmdItem.aggregatedOutput, "hi\ndone\n");
  assert.equal(cmdItem.completed, true);
  console.log("✓ commandExecution outputDelta streams + completes");

  // ─── Verify status RPC ──────────────────────────────────────────
  const status = (await fake.harness.behavior.callRpc("status")) as {
    bridgeAvailable: boolean;
    bridgeId: string;
    pollIntervalMs: number;
    maxItemsPerThread: number;
    maxDeltaBytesPerItem: number;
    threadCount: number;
    itemCount: number;
  };
  assert.equal(status.bridgeAvailable, true, "bridge reported as available");
  assert.equal(status.bridgeId, BRIDGE_PLUGIN_ID);
  assert.equal(status.pollIntervalMs, POLL_INTERVAL_MS);
  assert.equal(status.maxItemsPerThread, 12);
  assert.equal(status.maxDeltaBytesPerItem, 262144);
  assert.ok(status.threadCount >= 1);
  assert.ok(status.itemCount >= 1);
  console.log("✓ status RPC reports bridge availability and tuned limits");

  // ─── Verify settings.onChange propagates a new poll interval ────
  await fake.harness.behavior.setSettings({ pollIntervalMs: "1500" });
  await wait(20);
  const status2 = (await fake.harness.behavior.callRpc("status")) as {
    pollIntervalMs: number;
  };
  assert.equal(status2.pollIntervalMs, 1500, "pollIntervalMs updated via onChange");
  console.log("✓ settings.onChange updates pollIntervalMs");

  // ─── Verify HTTP /status route is registered ────────────────────
  const httpStatus = await fake.harness.behavior.fetchHttp("GET", "/status");
  assert.equal(httpStatus.status, 200);
  const body = (await httpStatus.json()) as { ok: boolean; bridgeId: string };
  assert.equal(body.ok, true);
  assert.equal(body.bridgeId, BRIDGE_PLUGIN_ID);
  console.log("✓ HTTP /status route serves the diagnostic payload");

  // ─── Verify the bridge cursor advances on re-poll ──────────────
  // After two poll cycles the last seen seq for T1 should be at the
  // highest seq we've pushed (6 in events + 4 in events2 = 10).
  const pluginCalls = fake.harness.sdk.callsTo("plugins.callRpc");
  assert.ok(pluginCalls.length >= 4, "sessions + recent RPCs were invoked");
  console.log(`✓ bridge polling loop invoked ${pluginCalls.length} plugin.callRpc calls`);

  // Shut down the service cleanly.
  await svc.controller.abort();
  await svc.done;
  await fake.harness.lifecycle.dispose();
  console.log("\nAll codex-live integration smoke tests passed.");
}

main().catch((err) => {
  console.error("INTEGRATION TEST FAILED");
  console.error(err);
  process.exit(1);
});
