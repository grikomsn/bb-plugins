// bb-plugin-pi-subagents-fleet — backend entry.
//
// Renders a live fleet view of @tintinweb/pi-subagents sub-agents running in
// the connected pi session. Consumes events from bb-plugin-pi-events-bridge
// (the chokepoint plugin) over bb.sdk.plugins.callRpc, maintains in-memory
// state for each sub-agent, and exposes RPC for steer/stop actions.
//
// Architecture:
//   pi ──subagents:*──▶ pi-bb-bridge ──socket──▶ pi-events-bridge
//                                                        │
//                                  bb.sdk.plugins.callRpc("recent")
//                                                        ▼
//                                              this plugin's state
//                                                        │
//                                                bb.realtime.publish
//                                                        ▼
//                                              frontend fleet view

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ─── State ──────────────────────────────────────────────────────────────

type SubagentStatus = "starting" | "running" | "completed" | "failed" | "steered" | "compacted";

type Subagent = {
  id: string;
  parentSessionId: string | null;
  type: string;
  prompt: string;
  model: string | null;
  runInBackground: boolean;
  status: SubagentStatus;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
  steerCount: number;
  result: unknown;
};

type FleetState = {
  byId: Map<string, Subagent>;
  byParent: Map<string, Set<string>>;
  order: string[]; // insertion order
};

// ─── RPC contract (own) ─────────────────────────────────────────────────

export const rpcContract = defineRpcContract({
  fleet: {
    input: z
      .object({
        parentSessionId: z.string().optional(),
        statusFilter: z
          .union([
            z.literal("active"),
            z.literal("all"),
            z.literal("starting"),
            z.literal("running"),
            z.literal("completed"),
            z.literal("failed"),
            z.literal("steered"),
            z.literal("compacted"),
          ])
          .optional()
          .default("active"),
      })
      .strict(),
    output: z.object({
      source: z.string(),
      active: z.boolean(),
      lastPollAt: z.string().nullable(),
      subagents: z.array(
        z.object({
          id: z.string(),
          parentSessionId: z.string().nullable(),
          type: z.string(),
          promptPreview: z.string(),
          model: z.string().nullable(),
          runInBackground: z.boolean(),
          status: z.string(),
          createdAt: z.string(),
          startedAt: z.string().nullable(),
          completedAt: z.string().nullable(),
          failureReason: z.string().nullable(),
          steerCount: z.number().int().nonnegative(),
          elapsedMs: z.number().int().nullable(),
        }),
      ),
    }),
  },
  steer: {
    input: z.object({ id: z.string(), message: z.string().min(1) }).strict(),
    output: z.object({ ok: z.boolean(), reason: z.string().nullable() }),
  },
  stop: {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ ok: z.boolean(), reason: z.string().nullable() }),
  },
  // Resolve a bb threadId to its provider sessionId (via the chokepoint)
  // and return the sub-agent fleet for that thread. Powers the right-
  // sidebar panel.
  currentThreadFleet: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({
      threadId: z.string(),
      providerSessionId: z.string().nullable(),
      subagents: z.array(
        z.object({
          id: z.string(),
          parentSessionId: z.string().nullable(),
          type: z.string(),
          promptPreview: z.string(),
          model: z.string().nullable(),
          runInBackground: z.boolean(),
          status: z.string(),
          createdAt: z.string(),
          startedAt: z.string().nullable(),
          completedAt: z.string().nullable(),
          failureReason: z.string().nullable(),
          steerCount: z.number().int().nonnegative(),
          elapsedMs: z.number().int().nullable(),
        }),
      ),
    }),
  },
});

// ─── Wire types for the chokepoint's `recent` RPC ──────────────────────

const BridgeEventSchema = z.object({
  seq: z.number().int(),
  ts: z.string(),
  type: z.string(),
  sessionId: z.string().nullable(),
  cwd: z.string(),
  payload: z.unknown(),
});

const BridgeRecentResultSchema = z.object({
  events: z.array(BridgeEventSchema),
});

const BridgeStatusSchema = z.object({
  connected: z.boolean(),
  socketPath: z.string(),
  sessionCount: z.number().int(),
  lastEventAt: z.string().nullable(),
  bufferedSeqs: z.number().int(),
  authToken: z.string().nullable(),
});

// ─── Backend factory ────────────────────────────────────────────────────

const CHOKEPOINT_PLUGIN_ID = "pi-events-bridge";
const POLL_INTERVAL_MS = 1000;

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("pi-subagents-fleet loading");

  const settings = bb.settings.define({
    /** Max sub-agents to keep in memory before dropping the oldest completed. */
    maxRetained: {
      type: "select",
      label: "Max retained sub-agents (drop oldest completed past this)",
      options: ["50", "200", "500", "1000"],
      default: "500",
    },
    /** Sub-agent types to show in the fleet; empty = all. */
    typeFilter: {
      type: "string",
      label: "Sub-agent type filter (comma-separated, empty = all)",
    },
  });
  const { maxRetained, typeFilter } = await settings.get();
  const maxRetainedNum = Number.parseInt(maxRetained, 10) || 500;
  const typeFilterSet = new Set(
    (typeFilter ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );

  const state: FleetState = {
    byId: new Map(),
    byParent: new Map(),
    order: [],
  };
  // Per-session seq watermarks (each pi process numbers events from 1).
  const lastPolledSeqBySession = new Map<string, number>();
  let lastPollAt: string | null = null;

  // ─── Helper: fetch new sub-agent events from the chokepoint ─────────
  async function fetchNewEvents(): Promise<z.infer<typeof BridgeEventSchema>[]> {
    if (!bb.sdk) return [];
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: CHOKEPOINT_PLUGIN_ID,
        method: "recent",
        input: { limit: 200, typePrefix: "pi.ext:subagents:" },
        outputSchema: BridgeRecentResultSchema,
      });
      // Filter to only events we haven't seen (per session).
      const out: z.infer<typeof BridgeEventSchema>[] = [];
      for (const e of result.events) {
        const key = e.sessionId ?? "_";
        const last = lastPolledSeqBySession.get(key);
        if (last === undefined || e.seq > last) out.push(e);
      }
      // events are sorted desc by seq; reverse so we apply oldest-first.
      out.reverse();
      for (const e of out) {
        const key = e.sessionId ?? "_";
        lastPolledSeqBySession.set(key, Math.max(lastPolledSeqBySession.get(key) ?? -1, e.seq));
      }
      lastPollAt = new Date().toISOString();
      return out;
    } catch (err) {
      // Chokepoint may be reloading or disabled; swallow until next tick.
      bb.log.debug(`chokepoint poll failed: ${String(err)}`);
      return [];
    }
  }

  // ─── Helpers: mutate fleet state from one event ──────────────────────
  // Apply an event, creating a placeholder record first when a lifecycle
  // event (started/completed/failed/steered/compacted) arrives before
  // `created` — pi-subagents can emit `started` before `created`.
  function ensureSubagentRecord(
    id: string,
    event: z.infer<typeof BridgeEventSchema>,
  ): Subagent | null {
    let sub = state.byId.get(id);
    if (sub) return sub;
    const p = (event.payload ?? {}) as Record<string, unknown>;
    sub = {
      id,
      parentSessionId: event.sessionId ?? null,
      type: typeof p.type === "string" ? p.type : "general-purpose",
      prompt: typeof p.prompt === "string" ? p.prompt : (typeof p.description === "string" ? p.description : ""),
      model: typeof p.model === "string" ? p.model : null,
      runInBackground: p.runInBackground === true || p.isBackground === true,
      status: "starting",
      createdAt: event.ts,
      startedAt: null,
      completedAt: null,
      failureReason: null,
      steerCount: 0,
      result: null,
    };
    state.byId.set(id, sub);
    state.order.push(id);
    if (!state.byParent.has(sub.parentSessionId ?? "_")) {
      state.byParent.set(sub.parentSessionId ?? "_", new Set());
    }
    state.byParent.get(sub.parentSessionId ?? "_")!.add(id);
    evictIfNeeded();
    return sub;
  }

  function applyEvent(event: z.infer<typeof BridgeEventSchema>): void {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const id = typeof p.id === "string" ? p.id : null;
    if (!id) return;
    const parentSessionId = event.sessionId ?? null;

    switch (event.type) {
      case "pi.ext:subagents:created":
      case "pi.ext:subagents:scheduled": {
        ensureSubagentRecord(id, event);
        break;
      }
      case "pi.ext:subagents:started": {
        const sub = ensureSubagentRecord(id, event);
        if (!sub) return;
        sub.status = "running";
        sub.startedAt = event.ts;
        break;
      }
      case "pi.ext:subagents:completed": {
        const sub = ensureSubagentRecord(id, event);
        if (!sub) return;
        sub.status = "completed";
        sub.completedAt = event.ts;
        sub.result = p.result ?? null;
        break;
      }
      case "pi.ext:subagents:failed": {
        const sub = ensureSubagentRecord(id, event);
        if (!sub) return;
        sub.status = "failed";
        sub.completedAt = event.ts;
        sub.failureReason = typeof p.error === "string" ? p.error : "unknown";
        break;
      }
      case "pi.ext:subagents:steered": {
        const sub = ensureSubagentRecord(id, event);
        if (!sub) return;
        sub.steerCount += 1;
        sub.status = "steered";
        // After a steer, the sub-agent returns to running on its next turn_start.
        // We let the next "started" event re-set status; this just records it.
        break;
      }
      case "pi.ext:subagents:compacted": {
        const sub = ensureSubagentRecord(id, event);
        if (!sub) return;
        sub.status = "compacted";
        break;
      }
      default:
        return;
    }

    // Re-publish fleet state on bb.realtime so the frontend can update.
    publishFleetSnapshot();
  }

  function evictIfNeeded(): void {
    if (state.order.length <= maxRetainedNum) return;
    const dropCount = state.order.length - maxRetainedNum;
    for (let i = 0; i < dropCount; i++) {
      const id = state.order[i];
      const sub = state.byId.get(id);
      if (!sub) continue;
      // Only drop completed/failed/compacted — never live agents.
      if (sub.status === "starting" || sub.status === "running" || sub.status === "steered") {
        continue;
      }
      state.byId.delete(id);
      state.byParent.get(sub.parentSessionId ?? "_")?.delete(id);
    }
    state.order = state.order.filter((id) => state.byId.has(id));
  }

  function publishFleetSnapshot(): void {
    const active = listSubagents("active");
    bb.realtime.publish("pi/subagents-fleet/snapshot", {
      activeCount: active.length,
      totalCount: state.byId.size,
      active: active.map((s) => ({
        id: s.id,
        type: s.type,
        promptPreview: s.prompt.slice(0, 120),
        status: s.status,
        steerCount: s.steerCount,
        startedAt: s.startedAt,
        elapsedMs: elapsedMs(s),
      })),
    });
  }

  function listSubagents(filter: "active" | "all" | SubagentStatus): Subagent[] {
    const out: Subagent[] = [];
    for (const id of state.order) {
      const sub = state.byId.get(id);
      if (!sub) continue;
      if (typeFilterSet.size > 0 && !typeFilterSet.has(sub.type)) continue;
      if (filter === "active") {
        if (sub.status === "starting" || sub.status === "running" || sub.status === "steered") {
          out.push(sub);
        }
      } else if (filter === "all") {
        out.push(sub);
      } else if (sub.status === filter) {
        out.push(sub);
      }
    }
    // Newest first
    out.reverse();
    return out;
  }

  function elapsedMs(sub: Subagent): number | null {
    const start = sub.startedAt ?? sub.createdAt;
    const end = sub.completedAt ?? new Date().toISOString();
    return new Date(end).getTime() - new Date(start).getTime();
  }

  // ─── RPC: write steer/stop requests via the chokepoint's enqueueCommand ─
  // The chokepoint plugin owns the reverse path: it drains its own command
  // queue and writes each item back over the bridge socket as a
  // `bb.bridge:command` envelope. We just call its RPC.
  async function enqueueCommand(
    command: "steer" | "stop",
    id: string,
    message?: string,
  ): Promise<{ ok: boolean; reason: string | null }> {
    if (!bb.sdk) return { ok: false, reason: "sdk not bound" };
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: CHOKEPOINT_PLUGIN_ID,
        method: "enqueueCommand",
        input: {
          command,
          id,
          ...(message ? { message } : {}),
          cwd: process.cwd(),
        },
        outputSchema: z.object({ ok: z.boolean() }),
      });
      bb.log.info(`enqueued ${command} for sub-agent ${id}`);
      return { ok: result.ok, reason: null };
    } catch (err) {
      bb.log.warn(`enqueueCommand failed: ${String(err)}`);
      return { ok: false, reason: `chokepoint RPC failed: ${String(err)}` };
    }
  }

  // ─── RPC registration ────────────────────────────────────────────────
  bb.rpc.register(rpcContract, {
    fleet: ({ parentSessionId, statusFilter }) => {
      let subagents = listSubagents(statusFilter);
      if (parentSessionId) {
        subagents = subagents.filter((s) => s.parentSessionId === parentSessionId);
      }
      return {
        source: CHOKEPOINT_PLUGIN_ID,
        active: state.byId.size > 0,
        lastPollAt,
        subagents: subagents.map((s) => ({
          id: s.id,
          parentSessionId: s.parentSessionId,
          type: s.type,
          promptPreview: s.prompt.slice(0, 200),
          model: s.model,
          runInBackground: s.runInBackground,
          status: s.status,
          createdAt: s.createdAt,
          startedAt: s.startedAt,
          completedAt: s.completedAt,
          failureReason: s.failureReason,
          steerCount: s.steerCount,
          elapsedMs: elapsedMs(s),
        })),
      };
    },

    steer: ({ id, message }) =>
      enqueueCommand("steer", id, message).then((r) => ({
        ok: r.ok,
        reason: state.byId.has(id) ? r.reason : "unknown sub-agent",
      })),

    stop: ({ id }) =>
      enqueueCommand("stop", id).then((r) => ({
        ok: r.ok,
        reason: state.byId.has(id) ? r.reason : "unknown sub-agent",
      })),

    currentThreadFleet: async ({ threadId }) => {
      if (!bb.sdk) {
        return { threadId, providerSessionId: null, subagents: [] };
      }
      let providerSessionId: string | null = null;
      try {
        const r = await bb.sdk.plugins.callRpc({
          pluginId: CHOKEPOINT_PLUGIN_ID,
          method: "threadSession",
          input: { threadId },
          outputSchema: z.object({
            threadId: z.string(),
            providerSessionId: z.string().nullable(),
          }),
        });
        providerSessionId = r.providerSessionId;
      } catch (err) {
        bb.log.debug(`threadSession lookup failed: ${String(err)}`);
      }
      // For pi, the session file is named by the bb thread id, so when the
      // chokepoint has no mapping (e.g. threads active before it loaded), the
      // thread id IS the session id.
      const sessionId = providerSessionId ?? threadId;
      const subagents = listSubagents("active").filter(
        (s) => s.parentSessionId === sessionId,
      );
      return {
        threadId,
        providerSessionId: sessionId,
        subagents: subagents.map((s) => ({
          id: s.id,
          parentSessionId: s.parentSessionId,
          type: s.type,
          promptPreview: s.prompt.slice(0, 200),
          model: s.model,
          runInBackground: s.runInBackground,
          status: s.status,
          createdAt: s.createdAt,
          startedAt: s.startedAt,
          completedAt: s.completedAt,
          failureReason: s.failureReason,
          steerCount: s.steerCount,
          elapsedMs: elapsedMs(s),
        })),
      };
    },
  });

  // ─── Background poll loop ────────────────────────────────────────────
  let stopped = false;
  let pollTickCount = 0;
  bb.background.service("poll-chokepoint", {
    async start(signal) {
      bb.log.info(`polling ${CHOKEPOINT_PLUGIN_ID} every ${POLL_INTERVAL_MS}ms`);
      while (!signal.aborted && !stopped) {
        const events = await fetchNewEvents();
        pollTickCount += 1;
        if (events.length > 0) {
          bb.log.info(`poll #${pollTickCount}: ${events.length} new event(s)`);
        }
        for (const e of events) {
          try {
            applyEvent(e);
          } catch (err) {
            bb.log.warn(`applyEvent failed for ${e.type}: ${String(err)}`);
          }
        }
        // Sleep with abort awareness.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, POLL_INTERVAL_MS);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
      bb.log.info("poll-chokepoint service exiting");
    },
  });

  // ─── Cleanup ──────────────────────────────────────────────────────────
  bb.onDispose(() => {
    stopped = true;
    bb.log.info("pi-subagents-fleet disposed");
  });

  bb.log.info("pi-subagents-fleet loaded");
}
