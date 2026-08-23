// bb-plugin-codex-events-bridge — backend entry.
//
// Polls every active codex thread's normalized event log
// (`bb.sdk.threads.events.list`) on a single shared tick, ring-buffers new
// rows per `(threadId, typePrefix)`, and republishes them on bb.realtime
// so other bb plugins can subscribe per category without re-polling the
// events DB.
//
// Mirrors `bb-plugin-pi-events-bridge` in shape but pulls from
// `bb.sdk.threads.events.list` instead of a Unix socket — bb's builtin
// `provider-codex` host already normalizes every provider event into the
// thread events DB, so we only need to read.

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  ALL_CODEX_TYPES,
  CODEX_CATEGORIES,
  isCodexType,
  categoryOf,
  eventToChannel,
  normaliseTypePrefix,
  type CodexCategory,
  type CodexType,
} from "./lib/codex-events.js";

// ─── Settings ───────────────────────────────────────────────────────────

const SETTINGS_SCHEMA = {
  /** Maximum events kept in the per-(threadId, typePrefix) replay ring. */
  ringCapacity: {
    type: "select" as const,
    label: "Ring buffer capacity (events per thread × category)",
    options: ["100", "500", "1000", "5000"],
    default: "5000",
  },
  /** Poll cadence — one global tick walks every active codex thread. */
  pollIntervalMs: {
    type: "select" as const,
    label: "Poll interval",
    options: ["750", "1500", "3000", "6000"],
    default: "1500",
  },
  /** Thread-list walk cadence — refreshes the set of tracked codex threads. */
  threadDiscoveryIntervalMs: {
    type: "select" as const,
    label: "Thread discovery interval",
    options: ["5000", "15000", "30000", "60000"],
    default: "15000",
  },
  /** When true, include hidden worker threads in the tracked set. */
  includeHidden: {
    type: "boolean" as const,
    label: "Include hidden codex worker threads",
    default: true,
  },
};

// ─── Wire types ─────────────────────────────────────────────────────────

const CodexEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  type: z.string(),
  category: z.enum(["thread", "turn", "item", "account"]),
  threadId: z.string(),
  providerThreadId: z.string().nullable(),
  payload: z.unknown(),
});

const SessionSummarySchema = z.object({
  threadId: z.string(),
  providerThreadId: z.string().nullable(),
  title: z.string(),
  status: z.string().nullable(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  lastEventType: z.string().nullable(),
  eventCount: z.number().int().nonnegative(),
  eventCountByCategory: z.object({
    thread: z.number().int().nonnegative(),
    turn: z.number().int().nonnegative(),
    item: z.number().int().nonnegative(),
    account: z.number().int().nonnegative(),
  }),
});

// ─── RPC contract ───────────────────────────────────────────────────────

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      connected: z.boolean(),
      pollIntervalMs: z.number().int().positive(),
      threadDiscoveryIntervalMs: z.number().int().positive(),
      ringCapacity: z.number().int().positive(),
      includeHidden: z.boolean(),
      threadCount: z.number().int().nonnegative(),
      sessionIds: z.array(z.string()),
      lastEventAt: z.string().nullable(),
      bufferedSeqs: z.number().int().nonnegative(),
      pollIteration: z.number().int().nonnegative(),
      trackingCategories: z.array(z.string()),
    }),
  },
  recent: {
    input: z
      .object({
        limit: z.number().int().min(1).max(500).optional().default(50),
        threadId: z.string().optional(),
        typePrefix: z.string().optional(),
      })
      .strict(),
    output: z.object({
      events: z.array(CodexEventSchema),
    }),
  },
  sessions: {
    input: z.null(),
    output: z.object({
      sessions: z.array(SessionSummarySchema),
    }),
  },
  threadSession: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({
      threadId: z.string(),
      providerThreadId: z.string().nullable(),
      sessionActive: z.boolean(),
    }),
  },
});

// ─── State shapes ───────────────────────────────────────────────────────

type CodexEvent = z.infer<typeof CodexEventSchema>;

type EventRing = {
  events: CodexEvent[];
  capacity: number;
  /** Highest seq we've kept (used to drive `afterSeq` on the next poll). */
  lastSeq: number;
};

type ThreadState = {
  threadId: string;
  providerThreadId: string | null;
  title: string;
  status: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastEventType: string | null;
  eventCount: number;
  rings: Record<CodexCategory, EventRing>;
  eventCountByCategory: Record<CodexCategory, number>;
};

function emptyRing(capacity: number): EventRing {
  return { events: [], capacity, lastSeq: 0 };
}

function ringPush(ring: EventRing, event: CodexEvent): void {
  // Out-of-order arrivals (shouldn't happen with an `afterSeq` watermark
  // walk, but be defensive if the SDK hands us slightly out-of-order rows
  // during a chain-resume): splice the event into sorted position.
  let i = ring.events.length;
  while (i > 0 && ring.events[i - 1]!.seq > event.seq) i -= 1;
  ring.events.splice(i, 0, event);
  if (ring.events.length > ring.capacity) {
    ring.events.splice(0, ring.events.length - ring.capacity);
  }
  if (event.seq > ring.lastSeq) ring.lastSeq = event.seq;
}

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

// ─── Backend factory ────────────────────────────────────────────────────

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("codex-events-bridge loading");

  const settings = bb.settings.define(SETTINGS_SCHEMA);
  const initial = await settings.get();
  let ringCapacity = Number.parseInt(initial.ringCapacity, 10) || 5000;
  let pollIntervalMs = Number.parseInt(initial.pollIntervalMs, 10) || 1500;
  let threadDiscoveryIntervalMs =
    Number.parseInt(initial.threadDiscoveryIntervalMs, 10) || 15000;
  let includeHidden = initial.includeHidden !== false;

  settings.onChange((next, _prev) => {
    ringCapacity = Number.parseInt(String(next.ringCapacity ?? ringCapacity), 10) || ringCapacity;
    pollIntervalMs =
      Number.parseInt(String(next.pollIntervalMs ?? pollIntervalMs), 10) || pollIntervalMs;
    threadDiscoveryIntervalMs =
      Number.parseInt(String(next.threadDiscoveryIntervalMs ?? threadDiscoveryIntervalMs), 10) ||
      threadDiscoveryIntervalMs;
    includeHidden = next.includeHidden !== false;
    // Resize existing rings to the new capacity (in place — clamp to the
    // smaller of current length / new capacity to avoid surprises).
    const clamped = Math.max(100, ringCapacity);
    for (const s of threadStates.values()) {
      for (const cat of CODEX_CATEGORIES) {
        const ring = s.rings[cat];
        ring.capacity = clamped;
        if (ring.events.length > clamped) {
          ring.events.splice(0, ring.events.length - clamped);
        }
      }
    }
  });

  const threadStates = new Map<string, ThreadState>();

  let lastEventAt: string | null = null;
  let bufferedSeqs = 0;
  let pollIteration = 0;

  function buildThreadState(thread: {
    id: string;
    providerThreadId?: string | null;
    title?: string | null;
    runtime?: { displayStatus?: string | null } | null;
  }): ThreadState {
    const existing = threadStates.get(thread.id);
    if (existing) {
      const newProvider =
        typeof thread.providerThreadId === "string" ? thread.providerThreadId : null;
      if (newProvider !== null) existing.providerThreadId = newProvider;
      if (typeof thread.title === "string" && thread.title.length > 0) {
        existing.title = thread.title;
      }
      const status = thread.runtime?.displayStatus ?? null;
      if (status !== null && status !== undefined) existing.status = String(status);
      return existing;
    }
    const rings = {
      thread: emptyRing(ringCapacity),
      turn: emptyRing(ringCapacity),
      item: emptyRing(ringCapacity),
      account: emptyRing(ringCapacity),
    } as const satisfies Record<CodexCategory, EventRing>;
    const s: ThreadState = {
      threadId: thread.id,
      providerThreadId:
        typeof thread.providerThreadId === "string" ? thread.providerThreadId : null,
      title: typeof thread.title === "string" ? thread.title : "",
      status: thread.runtime?.displayStatus
        ? String(thread.runtime.displayStatus)
        : null,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      lastEventType: null,
      eventCount: 0,
      rings: rings as Record<CodexCategory, EventRing>,
      eventCountByCategory: { thread: 0, turn: 0, item: 0, account: 0 },
    };
    threadStates.set(thread.id, s);
    return s;
  }

  function untrackThread(threadId: string): void {
    threadStates.delete(threadId);
  }

  function recordEvent(state: ThreadState, event: CodexEvent): void {
    state.lastSeenAt = event.ts;
    state.lastEventType = event.type;
    state.eventCount += 1;
    state.eventCountByCategory[event.category] += 1;
    ringPush(state.rings[event.category], event);
    lastEventAt = event.ts;
    bufferedSeqs += 1;
  }

  async function pollOneThread(threadId: string, signal: AbortSignal | undefined): Promise<void> {
    // One events.list call covers ALL tracked codex types for a thread — the
    // SDK accepts a single types array — so we don't pay 4× RTT per thread.
    // The per-category rings then take rows whose type starts with that
    // category's prefix (defensive in case the host ever slips an
    // off-taxonomy event into the list).
    const state = threadStates.get(threadId);
    if (!state) return;
    const lastOverallSeq = Math.max(
      state.rings.thread.lastSeq,
      state.rings.turn.lastSeq,
      state.rings.item.lastSeq,
      state.rings.account.lastSeq,
    );
    try {
      const rows = await bb.sdk.threads.events.list({
        threadId,
        types: ALL_CODEX_TYPES as readonly [CodexType, ...CodexType[]],
        afterSeq: String(lastOverallSeq),
        order: "asc",
        limit: "200",
        ...(signal !== undefined ? { signal } : {}),
      });
      for (const row of rows) {
        if (!isCodexType(row.type)) continue;
        if (row.seq <= lastOverallSeq) continue; // defensive dedup
        const cat = categoryOf(row.type);
        if (cat === null) continue;
        const event: CodexEvent = {
          seq: row.seq,
          ts: new Date(row.createdAt).toISOString(),
          type: row.type,
          category: cat,
          threadId: row.threadId,
          providerThreadId: state.providerThreadId,
          payload: row.data,
        };
        recordEvent(state, event);
        const channel = eventToChannel(event.type);
        if (channel !== null) {
          bb.realtime.publish(channel, event);
        }
      }
    } catch (err) {
      bb.log.debug(`poll failed for thread ${threadId}: ${String(err)}`);
    }
  }

  async function rediscoverThreads(signal: AbortSignal | undefined): Promise<void> {
    if (!bb.sdk) return;
    try {
      const result = await bb.sdk.threads.list({
        ...(includeHidden ? { includeHidden: true } : {}),
        limit: 200,
        ...(signal !== undefined ? { signal } : {}),
      });
      const seenIds = new Set<string>();
      for (const t of result as Array<{
        id: string;
        providerId?: string | null;
        providerThreadId?: string | null;
        title?: string | null;
        runtime?: { displayStatus?: string | null } | null;
      }>) {
        if (t.providerId !== "codex") continue;
        if (typeof t.id !== "string") continue;
        seenIds.add(t.id);
        buildThreadState(t);
      }
      // Drop tracked threads that are no longer in the discovery result AND
      // have been quiet for >2 minutes — bb.events.on may miss a race, and a
      // deleted thread whose rows we keep polling would spike an error every
      // tick.
      const cutoffMs = Date.now() - 120_000;
      for (const [id, state] of threadStates.entries()) {
        if (seenIds.has(id)) continue;
        const lastSeen = new Date(state.lastSeenAt).getTime();
        if (lastSeen < cutoffMs) {
          untrackThread(id);
        }
      }
    } catch (err) {
      bb.log.debug(`thread discovery failed: ${String(err)}`);
    }
  }

  // ─── Background poll service ──────────────────────────────────────────
  // One shared tick. Sleep abortable so reload/disable shuts down cleanly.
  bb.background.service("poll-codex-events", {
    async start(signal) {
      bb.log.info(
        `codex-events-bridge polling every ${pollIntervalMs}ms; ring=${ringCapacity}; hidden=${includeHidden}`,
      );

      // First pass: discover codex threads before the first tick so the
      // poll loop has somewhere to point events.list.
      await rediscoverThreads(signal);

      let lastDiscoveryAt = Date.now();
      while (!signal.aborted) {
        pollIteration += 1;
        const startedAt = Date.now();
        const snapshot = Array.from(threadStates.values());
        for (const state of snapshot) {
          if (signal.aborted) break;
          await pollOneThread(state.threadId, signal);
        }
        if (Date.now() - lastDiscoveryAt >= threadDiscoveryIntervalMs) {
          await rediscoverThreads(signal);
          lastDiscoveryAt = Date.now();
        }
        const elapsed = Date.now() - startedAt;
        const sleepFor = Math.max(0, pollIntervalMs - elapsed);
        await abortAwareSleep(sleepFor, signal);
      }
      bb.log.info("codex-events-bridge poll service exiting");
    },
  });

  // ─── Thread lifecycle hooks ───────────────────────────────────────────
  // bb.events.on is additive; we register the same handler on every thread
  // lifecycle event we care about.
  type LifecycleThread = {
    id?: unknown;
    providerId?: unknown;
    providerThreadId?: unknown;
    title?: unknown;
    runtime?: { displayStatus?: unknown } | null | undefined;
  };
  function maybeTrackLifecycle(t: LifecycleThread | undefined): void {
    if (!t || typeof t.id !== "string") return;
    if (t.providerId !== "codex") return;
    buildThreadState({
      id: t.id,
      providerThreadId:
        typeof t.providerThreadId === "string" ? t.providerThreadId : null,
      title: typeof t.title === "string" ? t.title : "",
      runtime:
        t.runtime && typeof t.runtime.displayStatus === "string"
          ? { displayStatus: t.runtime.displayStatus }
          : null,
    });
  }
  bb.events.on("thread.created", async (event) => {
    maybeTrackLifecycle((event as { thread?: LifecycleThread }).thread);
  });
  bb.events.on("thread.active", async (event) => {
    maybeTrackLifecycle((event as { thread?: LifecycleThread }).thread);
  });
  bb.events.on("thread.idle", async (event) => {
    maybeTrackLifecycle((event as { thread?: LifecycleThread }).thread);
  });
  for (const name of ["thread.archived", "thread.deleted", "thread.failed"] as const) {
    bb.events.on(name, async (event) => {
      const t = (event as { thread?: LifecycleThread }).thread;
      if (t && typeof t.id === "string") untrackThread(t.id);
    });
  }

  // ─── HTTP routes (debug-only) ─────────────────────────────────────────
  bb.http.route("GET", "/status", () => {
    return Response.json({
      ok: true,
      pollIntervalMs,
      threadDiscoveryIntervalMs,
      ringCapacity,
      includeHidden,
      threadCount: threadStates.size,
      pollIteration,
      lastEventAt,
      bufferedSeqs,
      sessions: Array.from(threadStates.values()).map((s) => ({
        threadId: s.threadId,
        providerThreadId: s.providerThreadId,
        title: s.title,
        status: s.status,
        lastSeenAt: s.lastSeenAt,
        lastEventType: s.lastEventType,
        eventCount: s.eventCount,
        eventCountByCategory: s.eventCountByCategory,
      })),
    });
  });

  bb.http.route("GET", "/events", () => {
    const out: CodexEvent[] = [];
    for (const ring of walkRings({})) {
      out.push(...ring.events);
    }
    out.sort((a, b) => a.seq - b.seq);
    return Response.json({ ok: true, count: out.length, events: out.slice(-500) });
  });

  bb.http.route("GET", "/threads", () => {
    return Response.json({
      ok: true,
      count: threadStates.size,
      threadIds: Array.from(threadStates.keys()),
    });
  });

  // ─── RPC ─────────────────────────────────────────────────────────────
  function* walkRings(filter: {
    threadId?: string;
    typePrefix?: string;
  }): Iterable<EventRing> {
    const wanted = normaliseTypePrefix(filter.typePrefix);
    // Translate the requested prefix into a per-category filter so we only
    // walk the rings the caller asked about.
    const wantedCategories = wanted === "codex/" || wanted === undefined
      ? CODEX_CATEGORIES
      : filterCategoryForPrefix(wanted);
    const threadFilter = filter.threadId;
    for (const state of threadStates.values()) {
      if (threadFilter && state.threadId !== threadFilter) continue;
      for (const cat of wantedCategories) {
        yield state.rings[cat];
      }
    }
  }

  function filterCategoryForPrefix(prefix: string): readonly CodexCategory[] {
    if (prefix.startsWith("codex/thread/")) return ["thread"];
    if (prefix.startsWith("codex/turn/")) return ["turn"];
    if (prefix.startsWith("codex/item/")) return ["item"];
    if (prefix.startsWith("codex/account/")) return ["account"];
    return CODEX_CATEGORIES;
  }

  bb.rpc.register(rpcContract, {
    status: () => ({
      connected: bb.sdk !== undefined && bb.sdk !== null,
      pollIntervalMs,
      threadDiscoveryIntervalMs,
      ringCapacity,
      includeHidden,
      threadCount: threadStates.size,
      sessionIds: Array.from(threadStates.keys()),
      lastEventAt,
      bufferedSeqs,
      pollIteration,
      trackingCategories: Array.from(CODEX_CATEGORIES),
    }),

    recent: (input) => {
      const { limit, threadId, typePrefix } = input;
      const out: CodexEvent[] = [];
      for (const ring of walkRings({ threadId, typePrefix })) {
        for (let i = ring.events.length - 1; i >= 0; i -= 1) {
          out.push(ring.events[i]!);
        }
      }
      out.sort((a, b) => b.seq - a.seq);
      return { events: out.slice(0, limit) };
    },

    sessions: () => ({
      sessions: Array.from(threadStates.values())
        .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1))
        .map((s) => ({
          threadId: s.threadId,
          providerThreadId: s.providerThreadId,
          title: s.title,
          status: s.status,
          firstSeenAt: s.firstSeenAt,
          lastSeenAt: s.lastSeenAt,
          lastEventType: s.lastEventType,
          eventCount: s.eventCount,
          eventCountByCategory: { ...s.eventCountByCategory },
        })),
    }),

    threadSession: ({ threadId }) => {
      const state = threadStates.get(threadId);
      return {
        threadId,
        providerThreadId: state?.providerThreadId ?? null,
        sessionActive: state !== undefined,
      };
    },
  });

  bb.onDispose(() => {
    bb.log.info(`codex-events-bridge disposing; tracked ${threadStates.size} thread(s)`);
  });
  bb.log.info("codex-events-bridge loaded; awaiting first discovery tick");
}
