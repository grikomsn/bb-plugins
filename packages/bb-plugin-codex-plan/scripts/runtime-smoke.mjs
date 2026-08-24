import assert from "node:assert/strict";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../dist/server.js";

const sent = [];
const turnEvent = {
  seq: 10,
  ts: "2026-08-23T12:00:00.000Z",
  type: "turn/plan/updated",
  category: "turn",
  threadId: "thr_plan_smoke",
  providerThreadId: "provider-plan-smoke",
  payload: {
    plan: [
      { step: "Inspect the implementation", status: "completed" },
      { step: "Validate the plugin", status: "active" },
      { step: "Report evidence", status: "pending" },
    ],
    explanation: "## Smoke plan\n\nValidate the focused runtime path.",
  },
};
const deltaOnlyEvent = {
  seq: 4,
  ts: "2026-08-23T11:59:59.000Z",
  type: "item/plan/delta",
  category: "item",
  threadId: "thr_delta_only",
  providerThreadId: "provider-delta-only",
  payload: { itemId: "item_delta", delta: "streaming plan text" },
};

const { bb, harness } = createFakePluginHost({
  pluginId: "codex-plan",
  settings: { pollIntervalMs: "750" },
  sdk: {
    plugins: {
      callRpc: async ({ input }) => ({
        events: input.typePrefix === "codex/turn/" ? [turnEvent] : [deltaOnlyEvent],
      }),
    },
    threads: {
      send: async (args) => {
        sent.push(args);
        return { accepted: true };
      },
    },
  },
});

await plugin(bb);
const service = harness.behavior.runService("poll-codex-events-bridge");
for (let attempt = 0; attempt < 50; attempt += 1) {
  const result = await harness.behavior.callRpc("snapshot", {
    threadId: turnEvent.threadId,
  });
  if (result.snapshots.length === 1) break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
service.controller.abort();
await service.done;

const snapshot = await harness.behavior.callRpc("snapshot", {
  threadId: turnEvent.threadId,
});
assert.equal(snapshot.snapshots.length, 1);
assert.equal(snapshot.snapshots[0].explanation, turnEvent.payload.explanation);
assert.deepEqual(
  snapshot.snapshots[0].plan.map((step) => step.status),
  ["completed", "in_progress", "pending"],
);

const deltaOnly = await harness.behavior.callRpc("snapshot", {
  threadId: deltaOnlyEvent.threadId,
});
assert.equal(deltaOnly.snapshots.length, 0, "a plan delta must not become a snapshot");

const decision = await harness.behavior.callRpc("decide", {
  threadId: turnEvent.threadId,
  decision: "approve",
  message: "looks good",
});
assert.equal(decision.ok, true);
assert.equal(sent.length, 1);
assert.equal(sent[0].mode, "steer");
assert.equal(
  sent[0].input[0].text,
  "<plan_decision>approve</plan_decision>\n\nlooks good",
);

const dismissed = await harness.behavior.callRpc("currentThreadPlan", {
  threadId: turnEvent.threadId,
});
assert.equal(dismissed.snapshot.decision.kind, "approved");

console.log("codex-plan runtime smoke passed");
await harness.lifecycle.dispose();
