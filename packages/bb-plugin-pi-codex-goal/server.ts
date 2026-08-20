// bb-plugin-pi-codex-goal — backend entry.
//
// Renders pi-codex-goal's CustomEntry state (objective, status, token usage)
// as a composer banner + nav panel history. The pi-side pi-bb-bridge
// extension synthesizes `pi.ext:codex-goal/state` envelopes from the
// pi-codex-goal CustomEntry rows visible in the `context` event's message
// array. This plugin polls the chokepoint's `recent` RPC for those events,
// maintains the latest goal snapshot in memory, and exposes it via RPC.

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ─── State ──────────────────────────────────────────────────────────────

type GoalStatus = "active" | "paused" | "budgetLimited" | "complete";

type Goal = {
  goalId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  usage: { tokensUsed: number; activeSeconds: number };
  createdAt: number;
  updatedAt: number;
};

type GoalSnapshot = {
  goal: Goal | null;
  historyCount: number;
  objectivePreview: string | null;
  ts: string;
  source: string;
};

type HistoryEntry = {
  kind: "set" | "usage" | "clear";
  at: number;
  source?: string;
  goalId?: string | null;
  // For "set" entries we keep the full objective so the history view can
  // render the chain of goals over time.
  objective?: string;
  status?: GoalStatus;
  tokensUsed?: number;
  activeSeconds?: number;
};

// ─── RPC contract (own) ─────────────────────────────────────────────────

export const rpcContract = defineRpcContract({
  snapshot: {
    input: z
      .object({
        parentSessionId: z.string().optional(),
      })
      .strict(),
    output: z.object({
      source: z.string(),
      snapshot: z
        .object({
          goal: z
            .object({
              goalId: z.string(),
              objective: z.string(),
              status: z.string(),
              tokenBudget: z.number().nullable(),
              usage: z.object({
                tokensUsed: z.number().int().nonnegative(),
                activeSeconds: z.number().int().nonnegative(),
              }),
              createdAt: z.number(),
              updatedAt: z.number(),
            })
            .nullable(),
          historyCount: z.number().int().nonnegative(),
          objectivePreview: z.string().nullable(),
          ts: z.string(),
          source: z.string(),
        })
        .nullable(),
      sessionId: z.string().nullable(),
      sessionIds: z.array(z.string()),
    }),
  },
  history: {
    input: z
      .object({
        parentSessionId: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional().default(50),
      })
      .strict(),
    output: z.object({
      source: z.string(),
      entries: z.array(
        z.object({
          kind: z.string(),
          at: z.number(),
          source: z.string().optional(),
          goalId: z.string().nullable().optional(),
          objective: z.string().optional(),
          status: z.string().optional(),
          tokensUsed: z.number().optional(),
          activeSeconds: z.number().optional(),
        }),
      ),
    }),
  },
  allSnapshots: {
    input: z.null(),
    output: z.object({
      snapshots: z.array(
        z.object({
          sessionId: z.string(),
          goal: z
            .object({
              goalId: z.string(),
              objective: z.string(),
              status: z.string(),
              tokenBudget: z.number().nullable(),
              usage: z.object({
                tokensUsed: z.number().int().nonnegative(),
                activeSeconds: z.number().int().nonnegative(),
              }),
              createdAt: z.number(),
              updatedAt: z.number(),
            })
            .nullable(),
          historyCount: z.number().int().nonnegative(),
          ts: z.string(),
        }),
      ),
    }),
  },
  // Resolve a bb threadId to its provider sessionId (via the chokepoint)
  // and return the per-thread goal snapshot. Powers the right-sidebar panel.
  currentThreadSnapshot: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({
      threadId: z.string(),
      providerSessionId: z.string().nullable(),
      snapshot: z
        .object({
          goal: z
            .object({
              goalId: z.string(),
              objective: z.string(),
              status: z.string(),
              tokenBudget: z.number().nullable(),
              usage: z.object({
                tokensUsed: z.number().int().nonnegative(),
                activeSeconds: z.number().int().nonnegative(),
              }),
              createdAt: z.number(),
              updatedAt: z.number(),
            })
            .nullable(),
          historyCount: z.number().int().nonnegative(),
          objectivePreview: z.string().nullable(),
          ts: z.string(),
          source: z.string(),
        })
        .nullable(),
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
const BridgeRecentResultSchema = z.object({ events: z.array(BridgeEventSchema) });

// ─── Backend factory ────────────────────────────────────────────────────

const CHOKEPOINT_PLUGIN_ID = "pi-events-bridge";
const POLL_INTERVAL_MS = 1500;
const MAX_HISTORY_PER_SESSION = 200;

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("pi-codex-goal loading");

  const settings = bb.settings.define({
    /** Render the goal banner over the composer even when no thread is active. */
    alwaysShowBanner: {
      type: "boolean",
      label: "Show goal banner over every thread (not just active ones)",
      default: true,
    },
    /** If true, also emit a bb.realtime snapshot when the goal clears. */
    emitOnClear: {
      type: "boolean",
      label: "Emit a bb.realtime snapshot when the goal clears (default true)",
      default: true,
    },
  });
  const { alwaysShowBanner: _alwaysShowBanner, emitOnClear: _emitOnClear } =
    await settings.get();

  // Per-session state. The chokepoint keys events by sessionId (or "_" when
  // absent); we mirror that here.
  type SessionKey = string;
  const snapshots = new Map<SessionKey, GoalSnapshot>();
  const histories = new Map<SessionKey, HistoryEntry[]>();
  let lastPolledSeq: number | null = null;

  function keyOf(sessionId: string | null | undefined): SessionKey {
    return sessionId ?? "_";
  }

  function recordHistory(sessionId: string | null, event: z.infer<typeof BridgeEventSchema>): void {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const kind = typeof p.kind === "string" ? p.kind : "";
    const at = typeof p.at === "number" ? p.at : Date.now();
    let goalIdValue: string | null | undefined;
    if (typeof p.goalId === "string") goalIdValue = p.goalId;
    else if (typeof p.clearedGoalId === "string") goalIdValue = p.clearedGoalId;
    else if (p.goalId === null) goalIdValue = null;
    const entry: HistoryEntry = {
      kind: kind as HistoryEntry["kind"],
      at,
      ...(typeof p.source === "string" ? { source: p.source } : {}),
      ...(goalIdValue !== undefined ? { goalId: goalIdValue } : {}),
      ...(typeof p.objective === "string" ? { objective: p.objective } : {}),
      ...(typeof p.status === "string" ? { status: p.status as GoalStatus } : {}),
      ...(p.tokensUsed !== undefined && typeof p.tokensUsed === "number"
        ? { tokensUsed: p.tokensUsed }
        : {}),
      ...(p.activeSeconds !== undefined && typeof p.activeSeconds === "number"
        ? { activeSeconds: p.activeSeconds }
        : {}),
    };
    if (!entry.kind) return;
    const k = keyOf(sessionId);
    let h = histories.get(k);
    if (!h) {
      h = [];
      histories.set(k, h);
    }
    h.push(entry);
    if (h.length > MAX_HISTORY_PER_SESSION) {
      h.splice(0, h.length - MAX_HISTORY_PER_SESSION);
    }
  }

  function applyEvent(event: z.infer<typeof BridgeEventSchema>): void {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const sessionId = event.sessionId ?? null;
    const k = keyOf(sessionId);

    if (event.type === "pi.ext:codex-goal/entry") {
      // Record this single entry into the per-session history. pi-bb-bridge
      // emits one envelope per set/usage/clear CustomEntry row (fingerprint-
      // deduped per context event).
      recordHistory(sessionId, event);
      return;
    }

    if (event.type !== "pi.ext:codex-goal/state") return;

    // The pi-bb-bridge synthesizes the snapshot in the payload. Trust that,
    // and additionally record any sibling entries that have history detail.
    const snap: GoalSnapshot = {
      goal:
        p.goal && typeof p.goal === "object"
          ? (p.goal as GoalSnapshot["goal"])
          : null,
      historyCount: typeof p.historyCount === "number" ? p.historyCount : 0,
      objectivePreview: typeof p.objectivePreview === "string" ? p.objectivePreview : null,
      ts: event.ts,
      source: CHOKEPOINT_PLUGIN_ID,
    };
    snapshots.set(k, snap);

    bb.realtime.publish("pi/codex-goal/snapshot", {
      sessionId,
      goal: snap.goal,
      historyCount: snap.historyCount,
      ts: snap.ts,
    });
  }

  // ─── Poll the chokepoint ──────────────────────────────────────────────
  async function fetchNewEvents(): Promise<z.infer<typeof BridgeEventSchema>[]> {
    if (!bb.sdk) return [];
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: CHOKEPOINT_PLUGIN_ID,
        method: "recent",
        input: { limit: 200, typePrefix: "pi.ext:codex-goal/" },
        outputSchema: BridgeRecentResultSchema,
      });
      const out: z.infer<typeof BridgeEventSchema>[] = [];
      for (const e of result.events) {
        if (lastPolledSeq === null || e.seq > lastPolledSeq) out.push(e);
      }
      out.reverse();
      if (out.length > 0) {
        lastPolledSeq = Math.max(lastPolledSeq ?? -1, ...out.map((e) => e.seq));
      }
      return out;
    } catch (err) {
      bb.log.debug(`chokepoint poll failed: ${String(err)}`);
      return [];
    }
  }

  // ─── RPC ─────────────────────────────────────────────────────────────
  bb.rpc.register(rpcContract, {
    snapshot: ({ parentSessionId }) => {
      if (parentSessionId) {
        const s = snapshots.get(keyOf(parentSessionId)) ?? null;
        return {
          source: CHOKEPOINT_PLUGIN_ID,
          snapshot: s,
          sessionId: parentSessionId,
          sessionIds: Array.from(snapshots.keys()).filter((k) => k !== "_"),
        };
      }
      // No filter: return all sessions' latest snapshots + the null-session one.
      return {
        source: CHOKEPOINT_PLUGIN_ID,
        snapshot: snapshots.get("_") ?? null,
        sessionId: null,
        sessionIds: Array.from(snapshots.keys()),
      };
    },

    history: ({ parentSessionId, limit }) => {
      const k = keyOf(parentSessionId);
      const h = histories.get(k) ?? [];
      // Newest first.
      const out = [...h].reverse().slice(0, limit).map((e) => ({
        kind: e.kind,
        at: e.at,
        ...(e.source !== undefined ? { source: e.source } : {}),
        ...(e.goalId !== undefined ? { goalId: e.goalId } : {}),
        ...(e.objective !== undefined ? { objective: e.objective } : {}),
        ...(e.status !== undefined ? { status: e.status } : {}),
        ...(e.tokensUsed !== undefined ? { tokensUsed: e.tokensUsed } : {}),
        ...(e.activeSeconds !== undefined ? { activeSeconds: e.activeSeconds } : {}),
      }));
      return { source: CHOKEPOINT_PLUGIN_ID, entries: out };
    },

    allSnapshots: () => ({
      snapshots: Array.from(snapshots.entries()).map(([sessionId, snap]) => ({
        sessionId,
        goal: snap.goal,
        historyCount: snap.historyCount,
        ts: snap.ts,
      })),
    }),

    currentThreadSnapshot: async ({ threadId }) => {
      // Resolve bb threadId -> providerThreadId via the chokepoint, then
      // return the per-session snapshot.
      if (!bb.sdk) {
        return { threadId, providerSessionId: null, snapshot: null };
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
      if (!providerSessionId) {
        return { threadId, providerSessionId: null, snapshot: null };
      }
      const snap = snapshots.get(providerSessionId) ?? null;
      return { threadId, providerSessionId, snapshot: snap };
    },
  });

  // ─── Poll loop ────────────────────────────────────────────────────────
  bb.background.service("poll-chokepoint", {
    async start(signal) {
      bb.log.info(`polling ${CHOKEPOINT_PLUGIN_ID} every ${POLL_INTERVAL_MS}ms`);
      while (!signal.aborted) {
        const events = await fetchNewEvents();
        if (events.length > 0) {
          bb.log.info(`applied ${events.length} new event(s)`);
        }
        for (const e of events) {
          try {
            applyEvent(e);
          } catch (err) {
            bb.log.warn(`applyEvent failed for ${e.type}: ${String(err)}`);
          }
        }
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
    },
  });

  // ─── HTTP route for direct inspection ───────────────────────────────────────
  // Exposes the current snapshot + history at /api/v1/plugins/pi-codex-goal/http/goal
  // with `auth: "local"` so the bb frontend can fetch from any open app
  // page. Useful for debugging; not part of the primary RPC surface.
  bb.http.route("GET", "/goal", () => {
    const arr = Array.from(snapshots.entries()).map(([sessionId, snap]) => ({
      sessionId,
      snapshot: snap,
      historyCount: histories.get(sessionId)?.length ?? 0,
    }));
    return Response.json({ ok: true, sessions: arr });
  });

  // ─── Cleanup ─────────────────────────────────────────────────────────────────
  bb.onDispose(() => bb.log.info("pi-codex-goal disposed"));
  bb.log.info("pi-codex-goal loaded");
}