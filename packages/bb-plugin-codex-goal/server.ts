import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  rpcContract,
  type Goal,
  type GoalSnapshot,
  type GoalStatus,
  type HistoryEntry,
} from "./contract.js";

export { rpcContract } from "./contract.js";

const CHOKEPOINT_PLUGIN_ID = "codex-events-bridge";
const POLL_INTERVAL_MS = 1_500;
const MAX_HISTORY_PER_THREAD = 200;
const GOAL_EVENT_PREFIX = "codex/thread/goal/";
const SNAPSHOT_CHANNEL = "codex-goal/snapshot";

const bridgeEventSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    ts: z.string(),
    type: z.string(),
    category: z.string(),
    threadId: z.string(),
    providerThreadId: z.string().nullable(),
    payload: z.unknown(),
  })
  .strict();

const bridgeRecentResultSchema = z.object({ events: z.array(bridgeEventSchema) }).strict();
const bridgeSessionsResultSchema = z.object({
  sessions: z.array(z.object({ threadId: z.string() })),
});

type BridgeEvent = z.infer<typeof bridgeEventSchema>;

type SessionState = {
  threadId: string;
  providerSessionId: string;
  snapshot: GoalSnapshot;
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

function eventTime(event: BridgeEvent): number {
  const parsed = new Date(event.ts).getTime();
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNonnegativeInteger(
  payload: Record<string, unknown>,
  key: string,
): number | null {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function readStatus(payload: Record<string, unknown>): GoalStatus | null {
  const status = payload.status;
  return status === "active" ||
    status === "paused" ||
    status === "budgetLimited" ||
    status === "complete"
    ? status
    : null;
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("codex-goal loading");

  const settings = bb.settings.define({
    alwaysShowBanner: {
      type: "boolean",
      label: "Show goal state wherever goal UI is available",
      default: true,
    },
    emitOnClear: {
      type: "boolean",
      label: "Emit a realtime snapshot when a goal clears",
      default: true,
    },
  });
  const initialSettings = await settings.get();
  let emitOnClear = initialSettings.emitOnClear;
  settings.onChange((next) => {
    emitOnClear = next.emitOnClear;
  });

  const statesBySession = new Map<string, SessionState>();
  const sessionByThread = new Map<string, string>();
  const histories = new Map<string, HistoryEntry[]>();
  const lastPolledSeqByThread = new Map<string, number>();
  let bridgeAvailable = false;

  function sessionIdFor(event: BridgeEvent): string {
    const payload =
      event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : {};
    return event.providerThreadId ?? readString(payload, "providerThreadId") ?? event.threadId;
  }

  function appendHistory(sessionId: string, entry: HistoryEntry): number {
    const history = histories.get(sessionId) ?? [];
    history.push(entry);
    if (history.length > MAX_HISTORY_PER_THREAD) {
      history.splice(0, history.length - MAX_HISTORY_PER_THREAD);
    }
    histories.set(sessionId, history);
    return history.length;
  }

  function publish(sessionId: string, state: SessionState): void {
    bb.realtime.publish(SNAPSHOT_CHANNEL, {
      threadId: state.threadId,
      providerThreadId: sessionId,
      goal: state.snapshot.goal,
      historyCount: state.snapshot.historyCount,
      ts: state.snapshot.ts,
    });
  }

  function applyEvent(event: BridgeEvent): void {
    if (
      event.type !== "thread/goal/updated" &&
      event.type !== "thread/goal/cleared"
    ) {
      return;
    }

    const payload =
      event.payload && typeof event.payload === "object"
        ? (event.payload as Record<string, unknown>)
        : {};
    const sessionId = sessionIdFor(event);
    const at = eventTime(event);
    const previous = statesBySession.get(sessionId)?.snapshot.goal ?? null;
    sessionByThread.set(event.threadId, sessionId);

    if (event.type === "thread/goal/cleared") {
      const historyCount = appendHistory(sessionId, {
        kind: "clear",
        at,
        source: event.type,
        goalId: previous?.goalId ?? sessionId,
        ...(previous?.objective ? { objective: previous.objective } : {}),
        ...(previous?.status ? { status: previous.status } : {}),
        ...(previous ? { tokensUsed: previous.usage.tokensUsed } : {}),
        ...(previous ? { activeSeconds: previous.usage.activeSeconds } : {}),
      });
      const state: SessionState = {
        threadId: event.threadId,
        providerSessionId: sessionId,
        snapshot: {
          goal: null,
          historyCount,
          objectivePreview: previous?.objective ?? null,
          ts: event.ts,
          source: CHOKEPOINT_PLUGIN_ID,
        },
      };
      statesBySession.set(sessionId, state);
      if (emitOnClear) publish(sessionId, state);
      return;
    }

    const objective = readString(payload, "objective");
    const status = readStatus(payload);
    const tokensUsed = readNonnegativeInteger(payload, "tokensUsed");
    const activeSeconds = readNonnegativeInteger(payload, "timeUsedSeconds");
    const rawBudget = payload.tokenBudget;
    const tokenBudget =
      rawBudget === null
        ? null
        : typeof rawBudget === "number" && Number.isFinite(rawBudget) && rawBudget >= 0
          ? Math.round(rawBudget)
          : undefined;

    if (!objective || !status || tokensUsed === null || activeSeconds === null || tokenBudget === undefined) {
      bb.log.warn(`ignored malformed ${event.type} payload for ${event.threadId}`);
      return;
    }

    const goal: Goal = {
      goalId: sessionId,
      objective,
      status,
      tokenBudget,
      usage: { tokensUsed, activeSeconds },
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
    };
    const kind: HistoryEntry["kind"] =
      previous === null || previous.objective !== objective ? "set" : "usage";
    const historyCount = appendHistory(sessionId, {
      kind,
      at,
      source: event.type,
      goalId: sessionId,
      objective,
      status,
      tokensUsed,
      activeSeconds,
    });
    const state: SessionState = {
      threadId: event.threadId,
      providerSessionId: sessionId,
      snapshot: {
        goal,
        historyCount,
        objectivePreview: objective.slice(0, 160),
        ts: event.ts,
        source: CHOKEPOINT_PLUGIN_ID,
      },
    };
    statesBySession.set(sessionId, state);
    publish(sessionId, state);
  }

  async function fetchNewEvents(): Promise<BridgeEvent[]> {
    try {
      // The bridge's event seq is scoped to a bb thread, so its globally
      // sorted/truncated `recent` response cannot safely replay multiple
      // threads. Discover threads first, then request one bounded page per
      // thread so a busy high-seq thread cannot crowd out another goal.
      const sessionResult = await bb.sdk.plugins.callRpc({
        pluginId: CHOKEPOINT_PLUGIN_ID,
        method: "sessions",
        input: null,
        outputSchema: bridgeSessionsResultSchema,
      });
      const pages = await Promise.all(
        sessionResult.sessions.map(({ threadId }) =>
          bb.sdk.plugins.callRpc({
            pluginId: CHOKEPOINT_PLUGIN_ID,
            method: "recent",
            input: { limit: 500, threadId, typePrefix: GOAL_EVENT_PREFIX },
            outputSchema: bridgeRecentResultSchema,
          }),
        ),
      );
      bridgeAvailable = true;
      const unseen = pages.flatMap((page) => page.events).filter((event) => {
        const lastSeq = lastPolledSeqByThread.get(event.threadId) ?? -1;
        return event.seq > lastSeq;
      });
      unseen.sort((a, b) => {
        if (a.threadId === b.threadId) return a.seq - b.seq;
        return eventTime(a) - eventTime(b);
      });
      for (const event of unseen) {
        lastPolledSeqByThread.set(
          event.threadId,
          Math.max(lastPolledSeqByThread.get(event.threadId) ?? -1, event.seq),
        );
      }
      return unseen;
    } catch (error) {
      bridgeAvailable = false;
      bb.log.debug(`codex-events-bridge poll unavailable: ${String(error)}`);
      return [];
    }
  }

  bb.rpc.register(rpcContract, {
    snapshot: ({ parentSessionId }) => {
      const state = parentSessionId ? statesBySession.get(parentSessionId) : undefined;
      return {
        source: CHOKEPOINT_PLUGIN_ID,
        bridgeAvailable,
        snapshot: state?.snapshot ?? null,
        sessionId: parentSessionId ?? null,
        sessionIds: Array.from(statesBySession.keys()),
      };
    },
    history: ({ parentSessionId, limit }) => {
      const entries = parentSessionId ? histories.get(parentSessionId) ?? [] : [];
      return {
        source: CHOKEPOINT_PLUGIN_ID,
        entries: [...entries].reverse().slice(0, limit),
      };
    },
    allSnapshots: () => ({
      bridgeAvailable,
      snapshots: Array.from(statesBySession.entries())
        .map(([sessionId, state]) => ({
          sessionId,
          threadId: state.threadId,
          goal: state.snapshot.goal,
          historyCount: state.snapshot.historyCount,
          ts: state.snapshot.ts,
        }))
        .sort((a, b) => (a.ts < b.ts ? 1 : -1)),
    }),
    currentThreadSnapshot: async ({ threadId }) => {
      let providerSessionId = sessionByThread.get(threadId) ?? null;
      if (!providerSessionId) {
        try {
          const result = await bb.sdk.plugins.callRpc({
            pluginId: CHOKEPOINT_PLUGIN_ID,
            method: "threadSession",
            input: { threadId },
            outputSchema: z
              .object({
                threadId: z.string(),
                providerThreadId: z.string().nullable(),
                sessionActive: z.boolean(),
              })
              .strict(),
          });
          bridgeAvailable = true;
          providerSessionId = result.providerThreadId;
          if (providerSessionId) sessionByThread.set(threadId, providerSessionId);
        } catch (error) {
          bridgeAvailable = false;
          bb.log.debug(`threadSession lookup unavailable: ${String(error)}`);
        }
      }
      return {
        threadId,
        providerSessionId,
        bridgeAvailable,
        snapshot: providerSessionId
          ? statesBySession.get(providerSessionId)?.snapshot ?? null
          : null,
      };
    },
    clearGoal: async ({ threadId }) => {
      await bb.sdk.threads.clearGoal({ threadId });
      return { ok: true as const };
    },
  });

  bb.background.service("poll-codex-events-bridge", {
    async start(signal) {
      bb.log.info(`polling ${CHOKEPOINT_PLUGIN_ID} every ${POLL_INTERVAL_MS}ms`);
      while (!signal.aborted) {
        const events = await fetchNewEvents();
        for (const event of events) {
          try {
            applyEvent(event);
          } catch (error) {
            bb.log.warn(`failed to apply ${event.type}: ${String(error)}`);
          }
        }
        await abortAwareSleep(POLL_INTERVAL_MS, signal);
      }
    },
  });

  bb.onDispose(() => bb.log.info("codex-goal disposed"));
  bb.log.info("codex-goal loaded");
}
