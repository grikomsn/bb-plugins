// bb-plugin-codex-live — backend entry.
//
// Polls the bb-plugin-codex-events-bridge chokepoint's `recent` RPC
// (filtered on `codex/item/`) once per tick, builds a per-thread in-memory
// stream buffer keyed by `itemId`, coalesces deltas into per-item "live"
// objects, and exposes a fresh snapshot through this plugin's own RPC.
//
// The reducer (lib/codex-live.ts) owns the pure half — server.ts wires the
// bb.realtime republish signal (`codex-live/snapshot`), the auto-clear
// timers, and the discriminator between bridge-available and bridge-not-
// installed states.
//
// Memory budget
// -------------
// Every thread is capped at `maxItemsPerThread` items (default 12). Each
// streaming text buffer is capped at `maxDeltaBytesPerItem` bytes
// (default 256 KiB) and the *tail* is kept when overflow happens — the
// live console cares about what the agent is producing right now, not the
// beginning of a long trace. Completed items auto-clear 60s after the
// terminal event so the buffer cannot grow unbounded over multi-turn
// sessions.

import { type BbPluginApi } from "@get-bb/plugin-sdk";
import {
  BRIDGE_PLUGIN_ID,
  BridgeRecentResultSchema,
  BridgeSessionsResultSchema,
  COMPLETED_CLEAR_DELAY_MS,
  DEFAULT_POLL_INTERVAL_MS,
  applyBridgeEvents,
  limitsFromSettings,
  snapshotOf,
  type CodexBridgeEvent,
  type LiveItem,
  type ThreadLiveState,
} from "./lib/codex-live.js";
import { rpcContract, type CodexLiveSnapshot, type ThreadSnapshot } from "./contract.js";

// ─── Settings ──────────────────────────────────────────────────────────
//
// Three user-tunable knobs: poll cadence, per-thread item cap, per-item
// streaming byte cap. Prefixed `codex-live:` so they group on the
// bb plugin Settings page.

const SETTINGS_SCHEMA = {
  /** Polling cadence against the chokepoint. */
  pollIntervalMs: {
    type: "select" as const,
    label: "Poll interval (against the codex events bridge)",
    options: ["500", "750", "1500", "3000", "6000"],
    default: "500",
  },
  /** Max items kept per thread before oldest-first eviction. */
  maxItemsPerThread: {
    type: "select" as const,
    label: "Max in-flight items per thread",
    options: ["4", "8", "12", "20", "30"],
    default: "12",
  },
  /** Cap on streaming text buffers (reasoning/command/fileChange). */
  maxDeltaBytesPerItem: {
    type: "select" as const,
    label: "Streaming byte cap per item (tail kept)",
    options: ["65536", "131072", "262144", "524288", "1048576"],
    default: "262144",
  },
};

function abortAwareSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

// ─── Backend factory ───────────────────────────────────────────────────

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("codex-live loading");

  const settings = bb.settings.define(SETTINGS_SCHEMA);
  const initial = await settings.get();
  let pollIntervalMs =
    Number.parseInt(String(initial.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS), 10) ||
    DEFAULT_POLL_INTERVAL_MS;
  let activeLimits = limitsFromSettings({
    maxItemsPerThread: initial.maxItemsPerThread,
    maxDeltaBytesPerItem: initial.maxDeltaBytesPerItem,
  });

  settings.onChange((next) => {
    pollIntervalMs =
      Number.parseInt(String(next.pollIntervalMs ?? pollIntervalMs), 10) || pollIntervalMs;
    activeLimits = limitsFromSettings({
      maxItemsPerThread: next.maxItemsPerThread,
      maxDeltaBytesPerItem: next.maxDeltaBytesPerItem,
    });
  });

  // ─── Live state ─────────────────────────────────────────────────────

  const threads = new Map<string, ThreadLiveState>();
  // Per-(threadId, itemId) auto-clear timer (60s after completion).
  const autoClearTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Last seen (threadId, seq) per thread so the watermark walk is sane
  // even when bridgeAvailable flips on/off mid-session.
  const lastSeqByThread = new Map<string, number>();
  let trackedThreadIds: string[] = [];
  let lastSessionRefreshAt = 0;
  let lastEventAt: string | null = null;
  let bridgeAvailable = false;
  let pollIteration = 0;

  function scheduleAutoClear(threadId: string, itemId: string, delayMs: number): void {
    const key = `${threadId}/${itemId}`;
    const existing = autoClearTimers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      autoClearTimers.delete(key);
      const state = threads.get(threadId);
      if (!state) return;
      const item = state.items[itemId];
      if (!item) return;
      // Only drop if it's still completed (an item shouldn't re-open).
      if (!item.completed) return;
      state.order = state.order.filter((id) => id !== itemId);
      delete state.items[itemId];
      if (state.order.length === 0) threads.delete(threadId);
      bb.realtime.publish(REALTIME_CHANNEL, {
        reason: "auto-clear",
        threadId,
        itemId,
      });
    }, delayMs);
    autoClearTimers.set(key, timer);
  }

  function dropItem(threadId: string, itemId: string): boolean {
    const state = threads.get(threadId);
    if (!state) return false;
    if (!state.items[itemId]) return false;
    state.order = state.order.filter((id) => id !== itemId);
    delete state.items[itemId];
    const key = `${threadId}/${itemId}`;
    const t = autoClearTimers.get(key);
    if (t) {
      clearTimeout(t);
      autoClearTimers.delete(key);
    }
    return true;
  }

  // ─── Poll the chokepoint ────────────────────────────────────────────

  async function fetchNewEvents(
    signal: AbortSignal | undefined,
  ): Promise<CodexBridgeEvent[]> {
    if (signal?.aborted) return [];
    try {
      // Refresh bridge sessions frequently enough that a newly-started Codex
      // thread appears in the live console promptly. Poll each thread with a
      // cursor: bridge event seq values are thread-local, so globally sorting
      // and slicing recent rows can starve a new low-seq thread forever.
      if (trackedThreadIds.length === 0 || Date.now() - lastSessionRefreshAt >= 2_000) {
        const result = await bb.sdk.plugins.callRpc({
          pluginId: BRIDGE_PLUGIN_ID,
          method: "sessions",
          input: null,
          outputSchema: BridgeSessionsResultSchema,
        });
        trackedThreadIds = result.sessions.map((session) => session.threadId);
        lastSessionRefreshAt = Date.now();
      }
      if (signal?.aborted) return [];

      const pages = await Promise.all(
        trackedThreadIds.map((threadId) =>
          bb.sdk.plugins.callRpc({
            pluginId: BRIDGE_PLUGIN_ID,
            method: "recent",
            input: {
              limit: 500,
              threadId,
              typePrefix: "codex/item/",
              afterSeq: lastSeqByThread.get(threadId) ?? 0,
            },
            outputSchema: BridgeRecentResultSchema,
          }),
        ),
      );
      bridgeAvailable = true;
      const fresh = pages
        .flatMap((page) => page.events)
        .filter((event) => event.category === "item")
        .sort((a, b) => {
          if (a.threadId < b.threadId) return -1;
          if (a.threadId > b.threadId) return 1;
          return a.seq - b.seq;
        });
      for (const event of fresh) {
        const last = lastSeqByThread.get(event.threadId) ?? 0;
        if (event.seq > last) lastSeqByThread.set(event.threadId, event.seq);
        if (lastEventAt === null || event.ts > lastEventAt) lastEventAt = event.ts;
      }
      return fresh;
    } catch (err) {
      bridgeAvailable = false;
      // Force session reconciliation after dependency reload/recovery.
      trackedThreadIds = [];
      bb.log.debug(`chokepoint poll failed: ${String(err)}`);
      return [];
    }
  }

  function applyAll(events: CodexBridgeEvent[]): boolean {
    if (events.length === 0) return false;
    const result = applyBridgeEvents(threads, events, {
      maxItemsPerThread: activeLimits.maxItemsPerThread,
      maxDeltaBytesPerItem: activeLimits.maxDeltaBytesPerItem,
      nowMs: () => Date.now(),
      scheduleAutoClear: (threadId, itemId) =>
        scheduleAutoClear(threadId, itemId, COMPLETED_CLEAR_DELAY_MS),
    });
    return result.changed;
  }

  // ─── RPC ────────────────────────────────────────────────────────────

  function threadSnapshotOf(threadId: string): ThreadSnapshot | null {
    const state = threads.get(threadId);
    if (!state) return null;
    const items: LiveItem[] = [];
    let inFlight = 0;
    for (const itemId of state.order) {
      const item = state.items[itemId];
      if (!item) continue;
      items.push(item);
      if (!item.completed) inFlight += 1;
    }
    return {
      threadId,
      itemCount: items.length,
      inFlightCount: inFlight,
      items,
      updatedAt: new Date().toISOString(),
    };
  }

  function snapshotAll(): CodexLiveSnapshot {
    return snapshotOf(threads);
  }

  bb.rpc.register(rpcContract, {
    status: () => {
      let itemCount = 0;
      let inFlight = 0;
      for (const state of threads.values()) {
        for (const id of state.order) {
          const item = state.items[id];
          if (!item) continue;
          itemCount += 1;
          if (!item.completed) inFlight += 1;
        }
      }
      return {
        bridgeAvailable,
        bridgeId: BRIDGE_PLUGIN_ID,
        pollIntervalMs,
        maxItemsPerThread: activeLimits.maxItemsPerThread,
        maxDeltaBytesPerItem: activeLimits.maxDeltaBytesPerItem,
        threadCount: threads.size,
        itemCount,
        inFlightCount: inFlight,
        lastEventAt,
        pollIteration,
      };
    },

    snapshot: () => snapshotAll(),

    activeThreadStream: ({ threadId }) => {
      const thread = threadSnapshotOf(threadId) ?? {
        threadId,
        itemCount: 0,
        inFlightCount: 0,
        items: [],
        updatedAt: new Date().toISOString(),
      };
      return {
        threadId,
        thread,
        clearAfterSeconds: Math.round(COMPLETED_CLEAR_DELAY_MS / 1000),
        updatedAt: new Date().toISOString(),
      };
    },

    dismiss: ({ threadId, itemId }) => {
      const ok = dropItem(threadId, itemId);
      if (ok) {
        bb.realtime.publish(REALTIME_CHANNEL, {
          reason: "dismiss",
          threadId,
          itemId,
        });
      }
      return { ok, reason: ok ? null : "no such item" };
    },
  });

  // ─── Background poll loop ───────────────────────────────────────────

  bb.background.service("poll-codex-events-bridge", {
    async start(signal) {
      bb.log.info(
        `codex-live polling ${BRIDGE_PLUGIN_ID} every ${pollIntervalMs}ms; ` +
          `maxItems=${activeLimits.maxItemsPerThread}; ` +
          `maxDeltaBytes=${activeLimits.maxDeltaBytesPerItem}`,
      );
      while (!signal.aborted) {
        pollIteration += 1;
        const events = await fetchNewEvents(signal);
        const changed = applyAll(events);
        if (changed) {
          bb.realtime.publish(REALTIME_CHANNEL, {
            reason: "applied",
            threadIds: Array.from(threads.keys()),
          });
        }
        await abortAwareSleep(pollIntervalMs, signal);
      }
      bb.log.info("codex-live poll service exiting");
    },
  });

  // ─── Thread lifecycle hooks ─────────────────────────────────────────
  // When a thread is archived/deleted/failed, evict its presence so we
  // aren't holding a phantom stream in memory.

  bb.events.on("thread.archived", async (event) => {
    const thread = (event as { thread?: { id?: unknown } }).thread;
    if (!thread || typeof thread.id !== "string") return;
    forgetThread(thread.id);
  });
  bb.events.on("thread.deleted", async (event) => {
    const thread = (event as { thread?: { id?: unknown } }).thread;
    if (!thread || typeof thread.id !== "string") return;
    forgetThread(thread.id);
  });
  function forgetThread(threadId: string): void {
    threads.delete(threadId);
    lastSeqByThread.delete(threadId);
    const prefix = `${threadId}/`;
    for (const [key, timer] of autoClearTimers.entries()) {
      if (key.startsWith(prefix)) {
        clearTimeout(timer);
        autoClearTimers.delete(key);
      }
    }
  }

  // ─── Debug HTTP ─────────────────────────────────────────────────────

  bb.http.route("GET", "/status", () => {
    return Response.json({
      ok: true,
      bridgeAvailable,
      bridgeId: BRIDGE_PLUGIN_ID,
      pollIntervalMs,
      pollIteration,
      lastEventAt,
      threadCount: threads.size,
      autoClearTimers: autoClearTimers.size,
      limits: activeLimits,
    });
  });

  bb.http.route("GET", "/threads", () => {
    return Response.json({
      ok: true,
      threads: Array.from(threads.values()).map((s) => ({
        itemCount: s.order.length,
        order: s.order.slice(0, 25),
      })),
    });
  });

  // ─── Dispose ────────────────────────────────────────────────────────

  bb.onDispose(() => {
    for (const t of autoClearTimers.values()) clearTimeout(t);
    autoClearTimers.clear();
    bb.log.info(`codex-live disposing; ${threads.size} thread(s)`);
  });

  bb.log.info("codex-live loaded; awaiting first poll tick");
}

// ─── Constants & exports ──────────────────────────────────────────────

export const REALTIME_CHANNEL = "codex-live/snapshot";
