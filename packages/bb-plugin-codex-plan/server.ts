// bb-plugin-codex-plan — backend entry.
//
// Consumes `codex/turn/plan/updated` and `codex/item/plan/delta` events from
// `bb-plugin-codex-events-bridge` (DOCK-4), maintains the latest plan snapshot
// per session/thread in memory (capped at 50 plans per thread), and exposes
// it through a small RPC surface + a `<plan_decision>...</plan_decision>`-envelope
// `decide` action that synthesises a steer message via `bb.sdk.threads.send`.
//
// Why in-memory only: the source of truth is the (provider->events DB)
// timeline; we just clone the latest view per thread so the UI can read
// without each panel having its own poll loop.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract } from "./contract.js";
import {
  type CodexPlanSnapshot,
  parseExplanation,
  parsePlanSteps,
} from "./lib/codex-plan.js";

const CHOKEPOINT_PLUGIN_ID = "codex-events-bridge";
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const MAX_PLANS_PER_THREAD = 50;
const MAX_STREAMING_DELTA_CHARS = 64_000;

// ─── Wire types for the chokepoint's `recent` RPC ─────────────────────

const CodexEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  type: z.string(),
  category: z.enum(["thread", "turn", "item", "account"]),
  threadId: z.string(),
  providerThreadId: z.string().nullable(),
  payload: z.unknown(),
});
const BridgeRecentResultSchema = z.object({ events: z.array(CodexEventSchema) });

type CodexEvent = z.infer<typeof CodexEventSchema>;

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

// ─── Backend factory ────────────────────────────────────────────────

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("codex-plan loading");

  const settings = bb.settings.define({
    pollIntervalMs: {
      type: "select" as const,
      label: "Poll interval for codex-events-bridge (ms)",
      options: ["750", "1500", "3000", "6000"],
      default: "1500",
    },
  });

  // ─── State ──────────────────────────────────────────────────────────
  /**
   * Codex thread ids are opaque (we don't know in advance whether the
   * chokepoint key is providerThreadId or threadId). We keep BOTH maps and
   * look up either way. When the bridge publishes both fields on `payload`,
   * we store under the providerThreadId; when it's missing, we fall back
   * to threadId.
   */
  const snapshotsByThreadId = new Map<string, CodexPlanSnapshot>();
  const snapshotsByProviderToThread = new Map<string, string>(); // providerThreadId -> threadId
  const threadPlansHistory = new Map<string, CodexPlanSnapshot[]>(); // full snapshots only
  const streamingDeltaByThread = new Map<string, string>();
  const lastSeqByThread = new Map<string, number>(); // per-thread seq watermark

  function recordHistory(threadId: string, snap: CodexPlanSnapshot): void {
    let h = threadPlansHistory.get(threadId);
    if (!h) {
      h = [];
      threadPlansHistory.set(threadId, h);
    }
    h.push(cloneSnapshot(snap));
    if (h.length > MAX_PLANS_PER_THREAD) {
      h.splice(0, h.length - MAX_PLANS_PER_THREAD);
    }
  }

  function cloneSnapshot(snap: CodexPlanSnapshot): CodexPlanSnapshot {
    return {
      threadId: snap.threadId,
      providerThreadId: snap.providerThreadId,
      plan: snap.plan.map((p) => ({ step: p.step, status: p.status })),
      explanation: snap.explanation,
      ts: snap.ts,
      decision: snap.decision ? { ...snap.decision } : null,
      lastSeq: snap.lastSeq,
    };
  }

  function applyEvent(event: CodexEvent): void {
    const threadId = event.threadId;
    if (event.type !== "turn/plan/updated" && event.type !== "item/plan/delta") {
      return;
    }

    // Per-thread seq watermark: `turn/plan/updated` is a full snapshot; deltas
    // arrive as `item/plan/delta` with monotonically increasing seqs. Drop
    // anything that isn't strictly newer than what we've already applied.
    const lastSeq = lastSeqByThread.get(threadId) ?? -1;
    if (event.seq <= lastSeq) return;

    const payload =
      event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : null;
    if (!payload) return;
    const providerThreadId =
      event.providerThreadId ??
      (typeof payload.providerThreadId === "string"
        ? payload.providerThreadId
        : null);

    if (event.type === "item/plan/delta") {
      // The normalized SDK event carries a textual `delta`, not structured
      // PlanStep rows. Keep the bounded stream in memory for ordering/parity,
      // but never expose a delta as a plan snapshot: only
      // turn/plan/updated is authoritative for the checklist.
      if (typeof payload.delta === "string" && payload.delta.length > 0) {
        const combined = `${streamingDeltaByThread.get(threadId) ?? ""}${payload.delta}`;
        streamingDeltaByThread.set(
          threadId,
          combined.slice(-MAX_STREAMING_DELTA_CHARS),
        );
      }
      lastSeqByThread.set(threadId, event.seq);
      return;
    }

    const steps = parsePlanSteps(payload.plan);
    const explanation = parseExplanation(payload.explanation);
    const next: CodexPlanSnapshot = {
      threadId,
      providerThreadId,
      plan: steps,
      explanation,
      ts: event.ts,
      // A new full plan is a new review cycle, including after a prior
      // request-changes decision.
      decision: null,
      lastSeq: event.seq,
    };

    streamingDeltaByThread.delete(threadId);
    snapshotsByThreadId.set(threadId, next);
    lastSeqByThread.set(threadId, event.seq);
    if (providerThreadId !== null) {
      snapshotsByProviderToThread.set(providerThreadId, threadId);
    }
    recordHistory(threadId, next);

    bb.realtime.publish("codex-plan/snapshot", {
      threadId,
      providerThreadId,
      ts: next.ts,
      planLength: next.plan.length,
      decided: false,
    });
  }

  function buildSynthesizedMessage(d: {
    threadId: string;
    decision: "approve" | "reject" | "request-changes";
    message?: string;
  }): string {
    switch (d.decision) {
      case "approve":
        return d.message
          ? `<plan_decision>approve</plan_decision>\n\n${d.message}`
          : "<plan_decision>approve</plan_decision>";
      case "reject":
        return d.message
          ? `<plan_decision>reject</plan_decision>\n\n${d.message}`
          : "<plan_decision>reject</plan_decision>";
      case "request-changes":
        return `<plan_decision>request-changes</plan_decision>\n\n${
          d.message ?? "Please revise the plan."
        }`;
    }
  }

  function recordDecisionLocally(
    threadId: string,
    decision: "approve" | "reject" | "request-changes",
    userMessage: string | undefined,
  ): void {
    const snap = snapshotsByThreadId.get(threadId);
    if (!snap) return;
    const at = new Date().toISOString();
    const next: CodexPlanSnapshot = {
      ...snap,
      decision:
        decision === "approve"
          ? { kind: "approved", at }
          : decision === "reject"
            ? { kind: "rejected", at, reason: userMessage }
            : {
                kind: "request-changes",
                at,
                message: userMessage ?? "",
              },
    };
    snapshotsByThreadId.set(threadId, next);
    const history = threadPlansHistory.get(threadId);
    if (history && history.length > 0) {
      history[history.length - 1] = cloneSnapshot(next);
    }
    bb.realtime.publish("codex-plan/decided", {
      threadId,
      decision,
      ts: at,
    });
  }

  async function fetchNewEvents(): Promise<CodexEvent[]> {
    try {
      // Fetch the low-volume turn ring separately so a noisy item stream
      // cannot push the authoritative full plan out of a shared limit.
      const [turns, items] = await Promise.all(
        ["codex/turn/", "codex/item/"].map((typePrefix) =>
          bb.sdk.plugins.callRpc({
            pluginId: CHOKEPOINT_PLUGIN_ID,
            method: "recent",
            input: { limit: 500, typePrefix },
            outputSchema: BridgeRecentResultSchema,
          }),
        ),
      );
      const wanted = [...turns.events, ...items.events].filter((e) => {
        if (e.type !== "turn/plan/updated" && e.type !== "item/plan/delta") {
          return false;
        }
        return e.seq > (lastSeqByThread.get(e.threadId) ?? -1);
      });
      wanted.sort((a, b) => a.seq - b.seq);
      return wanted;
    } catch (err) {
      bb.log.debug(`chokepoint poll failed: ${String(err)}`);
      return [];
    }
  }

  // ─── RPC ────────────────────────────────────────────────────────────
  bb.rpc.register(rpcContract, {
    snapshot: (input) => {
      const threadId = input?.threadId;
      const snapshots = Array.from(snapshotsByThreadId.values())
        .filter((snapshot) => !threadId || snapshot.threadId === threadId)
        .sort((a, b) => (a.ts < b.ts ? 1 : -1));
      return {
        chokepoint: CHOKEPOINT_PLUGIN_ID,
        sessionIds: snapshots.map((snapshot) => snapshot.threadId),
        snapshots: snapshots.map(cloneSnapshot),
      };
    },

    plansBySession: ({ threadId }) => {
      if (threadId) {
        return {
          chokepoint: CHOKEPOINT_PLUGIN_ID,
          snapshots: (threadPlansHistory.get(threadId) ?? []).map(cloneSnapshot),
        };
      }
      const snapshots = Array.from(snapshotsByThreadId.values()).sort((a, b) =>
        a.ts < b.ts ? 1 : -1,
      );
      return {
        chokepoint: CHOKEPOINT_PLUGIN_ID,
        snapshots: snapshots.map(cloneSnapshot),
      };
    },

    currentThreadPlan: ({ threadId }) => {
      const fromThread = snapshotsByThreadId.get(threadId) ?? null;
      if (fromThread) {
        return {
          threadId,
          providerThreadId: fromThread.providerThreadId,
          snapshot: cloneSnapshot(fromThread),
        };
      }
      // Maybe the chokepoint knows the thread by providerThreadId
      const reversed = snapshotsByProviderToThread.get(threadId);
      if (reversed) {
        const snap = snapshotsByThreadId.get(reversed) ?? null;
        return {
          threadId: reversed,
          providerThreadId: snap?.providerThreadId ?? threadId,
          snapshot: snap ? cloneSnapshot(snap) : null,
        };
      }
      return { threadId, providerThreadId: null, snapshot: null };
    },

    decide: async ({ threadId, decision, message }) => {
      const sentMessage = buildSynthesizedMessage({ threadId, decision, message });
      await bb.sdk.threads.send({
        threadId,
        input: [{ type: "text", text: sentMessage, mentions: [] }],
        mode: "steer",
      });
      // Dismiss only after the server has accepted the steer. A failed send
      // rejects the RPC and leaves the plan reviewable.
      recordDecisionLocally(threadId, decision, message);
      return {
        ok: true,
        threadId,
        decision,
        sentMessage,
        reason: null,
      };
    },
  });

  // ─── Background poll loop ───────────────────────────────────────────
  bb.background.service("poll-codex-events-bridge", {
    async start(signal) {
      const configured = Number((await settings.get()).pollIntervalMs);
      const pollIntervalMs = Number.isFinite(configured)
        ? configured
        : DEFAULT_POLL_INTERVAL_MS;
      bb.log.info(
        `polling ${CHOKEPOINT_PLUGIN_ID} every ${pollIntervalMs}ms for turn/plan/updated + item/plan/delta`,
      );
      while (!signal.aborted) {
        const events = await fetchNewEvents();
        for (const e of events) {
          try {
            applyEvent(e);
          } catch (err) {
            bb.log.warn(`applyEvent failed for ${e.type}: ${String(err)}`);
          }
        }
        await abortAwareSleep(pollIntervalMs, signal);
      }
    },
  });

  // ─── HTTP routes (debug-only) ───────────────────────────────────────
  bb.http.route("GET", "/snapshot", () => {
    return Response.json({
      ok: true,
      sessions: Array.from(snapshotsByThreadId.values()),
      historyCounts: Array.from(threadPlansHistory.entries()).map(([threadId, h]) => ({
        threadId,
        count: h.length,
      })),
    });
  });

  bb.onDispose(() => bb.log.info("codex-plan disposed"));
  bb.log.info("codex-plan loaded");
}
