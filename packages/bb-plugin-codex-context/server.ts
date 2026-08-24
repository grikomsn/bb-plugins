// bb-plugin-codex-context — backend entry.
//
// Subscribes (via the `bb-plugin-codex-events-bridge` chokepoint's RPC) to
// the five Codex state events we care about:
//
//   codex/thread/tokenUsage/updated       cumulative token spend + last turn
//   codex/thread/contextWindowUsage/updated  estimated usage vs window
//   codex/thread/compacted                a manual/auto compact
//   codex/thread/context/cleared          user cleared context
//   codex/account/rateLimits/updated      subscription-window/spend-control
//
// maintains a per-thread snapshot, a timestamped compaction history, and a
// daily-aggregate cross-thread spend counter (keyed `daily:<date>:<project>`
// in `bb.storage.kv` with TTL-style 30-day expiry), and exposes the result
// over the contract declared in `contract.ts`.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract } from "./contract.js";
import type {
  CompactionRecord,
  CrossThreadTotals,
  DailyTotalEntry,
  PerThreadContext,
  RateLimitRecord,
} from "./contract.js";

// ─── Constants ───────────────────────────────────────────────────────────

const CHOKEPOINT_PLUGIN_ID = "codex-events-bridge";
const POLL_INTERVAL_MS_DEFAULT = 1500;
const MAX_COMPACTIONS_PER_THREAD = 32;
const MAX_RATE_LIMIT_SNAPSHOTS = 16;
const RETENTION_DAYS_DEFAULT = 30;
const STALE_AFTER_MS = 30_000;
const KV_KEY_DAILY_PREFIX = "daily:";
const KV_KEY_RING_LIMIT = "ring-limit:";
const KV_KEY_LAST_PROJECT = "last-project:";
const KV_KEY_THREAD_STATE = "thread-state:";

// ─── Settings ────────────────────────────────────────────────────────────

const SETTINGS_SCHEMA = {
  pollIntervalMs: {
    type: "select" as const,
    label: "Poll chokepoint interval",
    options: ["750", "1500", "3000", "6000"],
    default: "1500",
  },
  retentionDays: {
    type: "select" as const,
    label: "Daily aggregate retention (days)",
    options: ["7", "14", "30", "60"],
    default: "30",
  },
  includeHidden: {
    type: "boolean" as const,
    label: "Track hidden codex worker threads",
    default: true,
  },
};

// ─── Chokepoint wire types ───────────────────────────────────────────────
//
// We poll the chokepoint's `recent` rpc for the five prefixes we care about.
// The chokepoint's events have already been validated through its own ring
// buffer, so the loose `z.object` shapes here just keep us from crashing on
// unexpected payloads.

const BridgeEventSchema = z.object({
  seq: z.number().int(),
  ts: z.string(),
  type: z.string(),
  category: z.enum(["thread", "turn", "item", "account"]),
  threadId: z.string(),
  providerThreadId: z.string().nullable(),
  payload: z.unknown(),
});

const BridgeRecentResultSchema = z.object({ events: z.array(BridgeEventSchema) });

// ─── Per-thread state shape ──────────────────────────────────────────────

type ThreadState = {
  threadId: string;
  firstSeenAt: string;
  lastUpdatedAt: string | null;
  // Per-type watermarks. The bridge reorders ring events; we honour a
  // `seen` watermark per prefix so a slow-streaming rate-limit arrives
  // without forcing a dedupe-by-min-watermark for unrelated prefixes.
  lastSeqByPrefix: {
    tokenUsage: number;
    contextWindowUsage: number;
    compacted: number;
    contextCleared: number;
    rateLimits: number;
  };
  // Token usage (cumulative + last-turn): preferred source for totalTokens.
  totalTokens: number;
  lastTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  reasoningOutputTokens: number | null;
  modelContextWindow: number | null;
  // Context-window usage: percent window (preferred when present).
  usedTokens: number | null;
  percentUsed: number | null;
  contextEstimated: boolean | null;
  // Compaction history.
  compactions: CompactionRecord[];
  contextClearCount: number;
  // Resolved at applyEvent from bb.events.on threadId→providerThreadId map;
  // also remembered for cross-thread roll-ups.
  providerThreadId: string | null;
  // Project id (best-effort, see threadMappingFromThreadResponse below).
  projectId: string | null;
  threadTitle: string;
};

function newThreadState(threadId: string, now: () => string): ThreadState {
  return {
    threadId,
    firstSeenAt: now(),
    lastUpdatedAt: null,
    lastSeqByPrefix: {
      tokenUsage: 0,
      contextWindowUsage: 0,
      compacted: 0,
      contextCleared: 0,
      rateLimits: 0,
    },
    totalTokens: 0,
    lastTokens: null,
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    reasoningOutputTokens: null,
    modelContextWindow: null,
    usedTokens: null,
    percentUsed: null,
    contextEstimated: null,
    compactions: [],
    contextClearCount: 0,
    providerThreadId: null,
    projectId: null,
    threadTitle: "",
  };
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
  bb.log.info("codex-context loading");

  const settings = bb.settings.define(SETTINGS_SCHEMA);
  const initial = await settings.get();
  let pollIntervalMs =
    Number.parseInt(String(initial.pollIntervalMs ?? ""), 10) || POLL_INTERVAL_MS_DEFAULT;
  let retentionDays =
    Number.parseInt(String(initial.retentionDays ?? ""), 10) || RETENTION_DAYS_DEFAULT;
  let includeHidden = initial.includeHidden !== false;

  settings.onChange((next) => {
    pollIntervalMs =
      Number.parseInt(String(next.pollIntervalMs ?? pollIntervalMs), 10) || pollIntervalMs;
    retentionDays =
      Number.parseInt(String(next.retentionDays ?? retentionDays), 10) || retentionDays;
    includeHidden = next.includeHidden !== false;
  });

  // Per-thread state keyed by bb threadId. The chokepoint already maintains
  // its own per-thread view; we keep a separate but congruent map because we
  // track derived state (lastSeqByPrefix, compactions, dailyTotals).
  const threadStates = new Map<string, ThreadState>();

  // Latest rate-limit snapshots across all codex threads (capped).
  const rateLimits: RateLimitRecord[] = [];

  // Per-thread → bb project id mapping (best effort, derived from bb.events).
  // We persist this in bb.storage.kv under `last-project:<threadId>` so a
  // reload/restart keeps the project attribution for daily aggregates.
  const lastProjectByThread = new Map<string, string>();

  // bb.pluginId (used for log lines only — bb exposes it).
  void bb.pluginId;

  let lastEventAt: string | null = null;
  let pollIteration = 0;
  let chokepointConnected = true;

  // ─── Helpers ──────────────────────────────────────────────────────────

  const nowIso = (): string => new Date().toISOString();

  function ensureThread(threadId: string): ThreadState {
    let s = threadStates.get(threadId);
    if (!s) {
      s = newThreadState(threadId, nowIso);
      threadStates.set(threadId, s);
    }
    return s;
  }

  function rememberProject(threadId: string, projectId: string | null): void {
    if (!projectId) return;
    if (lastProjectByThread.get(threadId) !== projectId) {
      lastProjectByThread.set(threadId, projectId);
      void bb.storage.kv
        .set(`${KV_KEY_LAST_PROJECT}${threadId}`, projectId)
        .catch(() => {
          /* ignore — kv writes are best-effort */
        });
    }
    const s = ensureThread(threadId);
    if (s.projectId !== projectId) s.projectId = projectId;
  }

  function rememberProviderThread(threadId: string, pid: string | null): void {
    const s = ensureThread(threadId);
    s.providerThreadId = pid;
  }

  function rememberTitle(threadId: string, title: string | null): void {
    if (!title) return;
    const s = ensureThread(threadId);
    if (title.length > 0 && s.threadTitle !== title) s.threadTitle = title.slice(0, 200);
  }

  function replaceRateLimit(rec: RateLimitRecord): void {
    // The chokepoint forwards `provider/rateLimits/updated` (renamed to
    // `codex/account/rateLimits/updated`). The same `provider/rateLimits/updated`
    // event typically arrives once per account per update cycle, so we
    // dedupe by (providerId + sorted windows) to avoid ratcheting n.
    const idx = rateLimits.findIndex(
      (r) =>
        r.providerId === rec.providerId &&
        JSON.stringify(r.windows) === JSON.stringify(rec.windows),
    );
    if (idx === 0) {
      rateLimits[0] = rec;
      return;
    }
    if (idx > 0) {
      rateLimits.splice(idx, 1);
    }
    rateLimits.unshift(rec);
    if (rateLimits.length > MAX_RATE_LIMIT_SNAPSHOTS) {
      rateLimits.length = MAX_RATE_LIMIT_SNAPSHOTS;
    }
  }

  function appendCompaction(record: CompactionRecord): void {
    const s = ensureThread(record.threadId);
    s.compactions.unshift(record);
    if (s.compactions.length > MAX_COMPACTIONS_PER_THREAD) {
      s.compactions.length = MAX_COMPACTIONS_PER_THREAD;
    }
    if (record.kind === "context_cleared") s.contextClearCount += 1;
  }

  // ─── Apply providers → cross-thread dailyTotals aggregator ────────────

  type TokenDelta = {
    threadId: string;
    projectId: string | null;
    addedTotal: number;
    addedInput: number;
    addedOutput: number;
    addedCached: number;
    addedReasoning: number;
    compactedOne: boolean;
    clearedOne: boolean;
    atMs: number;
  };

  // Live delta accumulator — flushed into bb.storage.kv on each event and
  // drained/aged once per poll cycle.
  let lastDailyFlushAt = Date.now();
  const dailyBuffer = new Map<
    string,
    {
      date: string;
      projectId: string | null;
      totalTokens: number;
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      reasoningOutputTokens: number;
      compactionCount: number;
      contextClearCount: number;
      threadIds: Set<string>;
    }
  >();

  function bufferKey(date: string, projectId: string | null): string {
    return `${KV_KEY_DAILY_PREFIX}${date}:${projectId ?? "_"}`;
  }

  async function recordDelta(delta: TokenDelta): Promise<void> {
    if (delta.addedTotal <= 0 && !delta.compactedOne && !delta.clearedOne) return;
    const date = localDateKey(delta.atMs);
    const key = bufferKey(date, delta.projectId);
    let buf = dailyBuffer.get(key);
    if (!buf) {
      buf = {
        date,
        projectId: delta.projectId,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        compactionCount: 0,
        contextClearCount: 0,
        threadIds: new Set<string>(),
      };
      dailyBuffer.set(key, buf);
    }
    buf.totalTokens += delta.addedTotal;
    buf.inputTokens += delta.addedInput;
    buf.outputTokens += delta.addedOutput;
    buf.cachedInputTokens += delta.addedCached;
    buf.reasoningOutputTokens += delta.addedReasoning;
    if (delta.compactedOne) buf.compactionCount += 1;
    if (delta.clearedOne) buf.contextClearCount += 1;
    buf.threadIds.add(delta.threadId);
  }

  async function flushDailyBuffer(reason: "tick" | "dispose"): Promise<void> {
    if (dailyBuffer.size === 0) return;
    let flushed = 0;
    for (const [key, buf] of Array.from(dailyBuffer.entries())) {
      try {
        const existing = await bb.storage.kv.get<DailyTotalEntry>(key);
        const merged: DailyTotalEntry = {
          date: buf.date,
          projectId: buf.projectId,
          totalTokens: (existing?.totalTokens ?? 0) + buf.totalTokens,
          inputTokens: (existing?.inputTokens ?? 0) + buf.inputTokens,
          outputTokens: (existing?.outputTokens ?? 0) + buf.outputTokens,
          cachedInputTokens: (existing?.cachedInputTokens ?? 0) + buf.cachedInputTokens,
          reasoningOutputTokens: (existing?.reasoningOutputTokens ?? 0) + buf.reasoningOutputTokens,
          compactionCount: (existing?.compactionCount ?? 0) + buf.compactionCount,
          contextClearCount: (existing?.contextClearCount ?? 0) + buf.contextClearCount,
          threadIds: dedupeStrings((existing?.threadIds ?? []).concat(Array.from(buf.threadIds))),
        };
        await bb.storage.kv.set(key, merged);
        dailyBuffer.delete(key);
        flushed += 1;
      } catch (err) {
        // Keep this entry buffered. Overwriting with a partial replacement on
        // a failed read would lose previously persisted accounting.
        bb.log.warn(`daily buffer flush failed for ${key}: ${String(err)}`);
      }
    }
    lastDailyFlushAt = Date.now();
    if (flushed > 0) bb.log.debug(`flushed ${flushed} daily aggregate(s) (${reason})`);
  }

  async function pruneOldDaily(): Promise<void> {
    // Read the existing kv list for `daily:` and delete anything older than
    // retentionDays. Cheap: only ~entries. We avoid a separate schedule and
    // roll it into the poll loop so cold servers don't keep doing this.
    try {
      const keys = await bb.storage.kv.list(KV_KEY_DAILY_PREFIX);
      if (keys.length === 0) return;
      const cutoff = Date.now() - retentionDays * 86_400_000;
      const cutoffDate = localDateKey(cutoff);
      for (const key of keys) {
        // Daily key format: `daily:<YYYY-MM-DD>:<projectId>`.
        const datePart = key.slice(
          KV_KEY_DAILY_PREFIX.length,
          KV_KEY_DAILY_PREFIX.length + "YYYY-MM-DD".length,
        );
        if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) continue;
        if (datePart < cutoffDate) {
          await bb.storage.kv.delete(key);
        }
      }
    } catch (err) {
      bb.log.debug(`prune old daily failed: ${String(err)}`);
    }
  }

  // ─── Apply event reducer ──────────────────────────────────────────────

  function applyEvent(event: z.infer<typeof BridgeEventSchema>): {
    delta: TokenDelta | null;
    rateLimit: RateLimitRecord | null;
  } {
    if (!event || typeof event !== "object") return { delta: null, rateLimit: null };
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const providerThreadId =
      event.providerThreadId ??
      (typeof p.providerThreadId === "string" ? p.providerThreadId : null);
    const threadId = event.threadId;
    rememberProviderThread(threadId, providerThreadId);

    const seq = event.seq;
    const tsMs = new Date(event.ts).getTime();
    const state = ensureThread(threadId);

    if (event.type === "thread/tokenUsage/updated") {
      if (seq <= state.lastSeqByPrefix.tokenUsage) {
        return { delta: null, rateLimit: null };
      }
      state.lastSeqByPrefix.tokenUsage = seq;
      const tu = p.tokenUsage as
        | {
            total?: {
              totalTokens?: number;
              inputTokens?: number;
              outputTokens?: number;
              cachedInputTokens?: number;
              reasoningOutputTokens?: number;
            } | null;
            last?: {
              totalTokens?: number;
              inputTokens?: number;
              outputTokens?: number;
              cachedInputTokens?: number;
              reasoningOutputTokens?: number;
            } | null;
            modelContextWindow?: number | null;
          }
        | undefined;
      const total = readNumber(tu?.total?.totalTokens) ?? readNumber(tu?.last?.totalTokens);
      const last = readNumber(tu?.last?.totalTokens);
      const input = readNumber(tu?.total?.inputTokens);
      const output = readNumber(tu?.total?.outputTokens);
      const cached = readNumber(tu?.total?.cachedInputTokens);
      const reasoning = readNumber(tu?.total?.reasoningOutputTokens);
      const modelWindow = readNullableNumber(tu?.modelContextWindow);

      const previousTotal = state.totalTokens;
      const previousInput = state.inputTokens ?? 0;
      const previousOutput = state.outputTokens ?? 0;
      const previousCached = state.cachedInputTokens ?? 0;
      const previousReasoning = state.reasoningOutputTokens ?? 0;

      if (total !== null) state.totalTokens = total;
      if (last !== null) state.lastTokens = last;
      if (input !== null) state.inputTokens = input;
      if (output !== null) state.outputTokens = output;
      if (cached !== null) state.cachedInputTokens = cached;
      if (reasoning !== null) state.reasoningOutputTokens = reasoning;
      if (modelWindow !== null) state.modelContextWindow = modelWindow;
      state.lastUpdatedAt = event.ts;
      lastEventAt = event.ts;

      // Cumulative values can decrease after a provider session reset. Keep
      // the provider's current absolute snapshot, but persist only positive
      // deltas so replayed events and resets cannot subtract or double count.
      const added = total !== null ? Math.max(0, total - previousTotal) : 0;
      const addedInput = input !== null ? Math.max(0, input - previousInput) : 0;
      const addedOutput = output !== null ? Math.max(0, output - previousOutput) : 0;
      const addedCached = cached !== null ? Math.max(0, cached - previousCached) : 0;
      const addedReasoning = reasoning !== null ? Math.max(0, reasoning - previousReasoning) : 0;

      return {
        delta: {
          threadId,
          projectId: state.projectId,
          addedTotal: added,
          addedInput: addedInput,
          addedOutput: addedOutput,
          addedCached: addedCached,
          addedReasoning: addedReasoning,
          compactedOne: false,
          clearedOne: false,
          atMs: tsMs,
        },
        rateLimit: null,
      };
    }

    if (event.type === "thread/contextWindowUsage/updated") {
      if (seq <= state.lastSeqByPrefix.contextWindowUsage) {
        return { delta: null, rateLimit: null };
      }
      state.lastSeqByPrefix.contextWindowUsage = seq;
      const cu = p.contextWindowUsage as
        | {
            estimated?: boolean | null;
            modelContextWindow?: number | null;
            usedTokens?: number | null;
          }
        | undefined;

      const estimated = readBool(cu?.estimated);
      const used = readNullableNumber(cu?.usedTokens);
      const modelWindow = readNullableNumber(cu?.modelContextWindow);

      if (estimated !== null) state.contextEstimated = estimated;
      if (used !== null) state.usedTokens = used;
      if (modelWindow !== null) state.modelContextWindow = modelWindow;

      // Compute percentUsed from usedTokens / modelContextWindow when both
      // are present. The SDK payload doesn't carry a percent field — this
      // is the canonical way to derive it. We cap at 100 to avoid >100%
      // rendering for near-contextWindow snapshots with sub-second rounding.
      let pct: number | null = state.percentUsed;
      if (
        used !== null &&
        modelWindow !== null &&
        modelWindow > 0
      ) {
        const raw = (used / modelWindow) * 100;
        pct = Math.max(0, Math.min(100, raw));
      } else if (used !== null && state.modelContextWindow !== null && state.modelContextWindow > 0) {
        const raw = (used / state.modelContextWindow) * 100;
        pct = Math.max(0, Math.min(100, raw));
      }
      if (pct !== null) state.percentUsed = pct;
      state.lastUpdatedAt = event.ts;
      lastEventAt = event.ts;
      return { delta: null, rateLimit: null };
    }

    if (event.type === "thread/compacted") {
      if (seq <= state.lastSeqByPrefix.compacted) {
        return { delta: null, rateLimit: null };
      }
      state.lastSeqByPrefix.compacted = seq;
      const record: CompactionRecord = {
        ts: event.ts,
        kind: "compacted",
        threadId,
        providerThreadId,
      };
      appendCompaction(record);
      lastEventAt = event.ts;
      return {
        delta: {
          threadId,
          projectId: state.projectId,
          addedTotal: 0,
          addedInput: 0,
          addedOutput: 0,
          addedCached: 0,
          addedReasoning: 0,
          compactedOne: true,
          clearedOne: false,
          atMs: tsMs,
        },
        rateLimit: null,
      };
    }

    if (event.type === "thread/context/cleared") {
      if (seq <= state.lastSeqByPrefix.contextCleared) {
        return { delta: null, rateLimit: null };
      }
      state.lastSeqByPrefix.contextCleared = seq;
      const record: CompactionRecord = {
        ts: event.ts,
        kind: "context_cleared",
        threadId,
        providerThreadId,
      };
      appendCompaction(record);
      state.usedTokens = 0;
      state.percentUsed = 0;
      state.lastUpdatedAt = event.ts;
      lastEventAt = event.ts;
      return {
        delta: {
          threadId,
          projectId: state.projectId,
          addedTotal: 0,
          addedInput: 0,
          addedOutput: 0,
          addedCached: 0,
          addedReasoning: 0,
          compactedOne: false,
          clearedOne: true,
          atMs: tsMs,
        },
        rateLimit: null,
      };
    }

    if (event.type === "provider/rateLimits/updated") {
      if (seq <= state.lastSeqByPrefix.rateLimits) {
        return { delta: null, rateLimit: null };
      }
      state.lastSeqByPrefix.rateLimits = seq;

      const rl = p.rateLimits as
        | {
            kind?: string;
            providerId?: string;
            status?: string;
            overageReason?: string | null;
            overageStatus?: string | null;
            reachedReason?: string | null;
            windows?: Array<{
              label?: string | null;
              providerKey?: string | null;
              resetsAtMs?: number | null;
              status?: string;
            }>;
          }
        | undefined;
      const kind = parseRateLimitKind(rl?.kind);
      const status = parseRateLimitStatus(rl?.status);
      const overage = parseRateLimitOverageStatus(rl?.overageStatus);
      const windows = Array.isArray(rl?.windows)
        ? rl!.windows!.map((w) => ({
            label: typeof w?.label === "string" ? w.label : null,
            providerKey: typeof w?.providerKey === "string" ? w.providerKey : null,
            resetsAtMs:
              typeof w?.resetsAtMs === "number" && Number.isFinite(w.resetsAtMs)
                ? w.resetsAtMs
                : null,
            status: parseRateLimitStatus(w?.status),
          }))
        : [];
      const rec: RateLimitRecord = {
        ts: event.ts,
        kind,
        providerId: typeof rl?.providerId === "string" ? rl.providerId : "codex",
        status,
        overageReason: typeof rl?.overageReason === "string" ? rl.overageReason : null,
        overageStatus: overage,
        reachedReason: typeof rl?.reachedReason === "string" ? rl.reachedReason : null,
        windows,
      };
      replaceRateLimit(rec);
      lastEventAt = event.ts;
      return { delta: null, rateLimit: rec };
    }
    return { delta: null, rateLimit: null };
  }

  // ─── Chokepoint polling ────────────────────────────────────────────────

  async function fetchThreadEvents(): Promise<{
    events: z.infer<typeof BridgeEventSchema>[];
    ok: boolean;
  }> {
    if (!bb.sdk) return { events: [], ok: false };
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: CHOKEPOINT_PLUGIN_ID,
        method: "recent",
        input: { limit: 200, typePrefix: "codex/thread/" },
        outputSchema: BridgeRecentResultSchema,
      });
      chokepointConnected = true;
      return { events: result.events, ok: true };
    } catch (err) {
      bb.log.debug(`chokepoint thread poll failed: ${String(err)}`);
      chokepointConnected = false;
      return { events: [], ok: false };
    }
  }

  async function fetchAccountEvents(): Promise<{
    events: z.infer<typeof BridgeEventSchema>[];
    ok: boolean;
  }> {
    if (!bb.sdk) return { events: [], ok: false };
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: CHOKEPOINT_PLUGIN_ID,
        method: "recent",
        input: { limit: 200, typePrefix: "codex/account/" },
        outputSchema: BridgeRecentResultSchema,
      });
      chokepointConnected = true;
      return { events: result.events, ok: true };
    } catch (err) {
      bb.log.debug(`chokepoint account poll failed: ${String(err)}`);
      chokepointConnected = false;
      return { events: [], ok: false };
    }
  }

  async function refreshThreadMetadata(signal?: AbortSignal): Promise<void> {
    try {
      const result = await bb.sdk.threads.list({
        ...(includeHidden ? { includeHidden: true } : {}),
        limit: 200,
        ...(signal ? { signal } : {}),
      });
      for (const thread of result as Array<{
        id?: unknown;
        providerId?: unknown;
        providerThreadId?: unknown;
        projectId?: unknown;
        title?: unknown;
      }>) {
        if (thread.providerId !== "codex" || typeof thread.id !== "string") continue;
        rememberProviderThread(
          thread.id,
          typeof thread.providerThreadId === "string" ? thread.providerThreadId : null,
        );
        rememberProject(
          thread.id,
          typeof thread.projectId === "string" ? thread.projectId : null,
        );
        rememberTitle(thread.id, typeof thread.title === "string" ? thread.title : null);
      }
    } catch (err) {
      bb.log.debug(`thread metadata refresh failed: ${String(err)}`);
    }
  }

  // ─── Snapshot builders ────────────────────────────────────────────────

  function perThread(state: ThreadState): PerThreadContext {
    const used = state.usedTokens;
    const window = state.modelContextWindow;
    let pct = state.percentUsed;
    if (pct === null && used !== null && window !== null && window > 0) {
      pct = Math.max(0, Math.min(100, (used / window) * 100));
    }
    const lastCompaction = state.compactions[0] ?? null;
    return {
      threadId: state.threadId,
      totalTokens: state.totalTokens,
      lastTokens: state.lastTokens,
      contextWindowTokens: window,
      modelContextWindow: window,
      usedTokens: used,
      percentUsed: pct,
      contextEstimated: state.contextEstimated,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      cachedInputTokens: state.cachedInputTokens,
      reasoningOutputTokens: state.reasoningOutputTokens,
      compactionCount: state.compactions.filter((c) => c.kind === "compacted").length,
      lastUpdatedAt: state.lastUpdatedAt,
      firstSeenAt: state.firstSeenAt,
    };
  }

  function crossThreadFromThreads(states: ThreadState[]): CrossThreadTotals {
    let totalTokens = 0;
    let input = 0;
    let output = 0;
    let cached = 0;
    let reasoning = 0;
    let compactions = 0;
    let clears = 0;
    let oldest: string | null = null;
    let newest: string | null = null;
    for (const s of states) {
      totalTokens += s.totalTokens;
      input += s.inputTokens ?? 0;
      output += s.outputTokens ?? 0;
      cached += s.cachedInputTokens ?? 0;
      reasoning += s.reasoningOutputTokens ?? 0;
      compactions += s.compactions.filter((c) => c.kind === "compacted").length;
      clears += s.contextClearCount;
      if (oldest === null || s.firstSeenAt < oldest) oldest = s.firstSeenAt;
      if (s.lastUpdatedAt && (newest === null || s.lastUpdatedAt > newest))
        newest = s.lastUpdatedAt;
    }
    return {
      threadCount: states.length,
      totalTokens,
      totalInputTokens: input,
      totalOutputTokens: output,
      totalCachedInputTokens: cached,
      totalReasoningOutputTokens: reasoning,
      compactionCount: compactions,
      contextClearCount: clears,
      oldestSeenAt: oldest,
      newestSeenAt: newest,
    };
  }

  function gatherCompactions(cap = 64): CompactionRecord[] {
    const out: CompactionRecord[] = [];
    for (const s of threadStates.values()) {
      out.push(...s.compactions);
    }
    out.sort((a, b) => (a.ts < b.ts ? 1 : -1));
    return out.slice(0, cap);
  }

  async function readDailyEntries(
    date: string | undefined,
    projectId: string | undefined,
  ): Promise<DailyTotalEntry[]> {
    try {
      const keys = await bb.storage.kv.list(
        date ? `${KV_KEY_DAILY_PREFIX}${date}:` : KV_KEY_DAILY_PREFIX,
      );
      const out: DailyTotalEntry[] = [];
      for (const key of keys) {
        if (date && !key.startsWith(`${KV_KEY_DAILY_PREFIX}${date}:`)) continue;
        if (projectId && !key.endsWith(`:${projectId}`)) continue;
        const v = await bb.storage.kv.get<DailyTotalEntry>(key);
        if (v && typeof v === "object") out.push(v);
      }
      out.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
      return out;
    } catch (err) {
      bb.log.debug(`daily read failed: ${String(err)}`);
      return [];
    }
  }

  // ─── Status / freshness ────────────────────────────────────────────────

  function isStale(): boolean {
    if (lastEventAt === null) return false;
    if (threadStates.size === 0) return false;
    const ts = new Date(lastEventAt).getTime();
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts > STALE_AFTER_MS;
  }

  // ─── HTTP route (debug) ────────────────────────────────────────────────

  bb.http.route("GET", "/context", () => {
    const states = Array.from(threadStates.values()).sort((a, b) =>
      (a.lastUpdatedAt ?? a.firstSeenAt) <
      (b.lastUpdatedAt ?? b.firstSeenAt)
        ? 1
        : -1,
    );
    return Response.json({
      ok: true,
      chokepointConnected,
      pollIteration,
      lastEventAt,
      isStale: isStale(),
      threadCount: threadStates.size,
      crossThread: crossThreadFromThreads(states),
      threads: states.map(perThread),
      rateLimits: rateLimits.slice(0, MAX_RATE_LIMIT_SNAPSHOTS),
      compactions: gatherCompactions(),
      retentionDays,
      pollIntervalMs,
      includeHidden,
    });
  });

  // ─── RPC surface ──────────────────────────────────────────────────────

  bb.rpc.register(rpcContract, {
    status: () => {
      return {
        pollIntervalMs,
        retentionDays,
        includeHidden,
        chokepointConnected,
        threadCount: threadStates.size,
        lastEventAt,
        pollIteration,
        isStale: isStale(),
      };
    },
    snapshot: async () => {
      const states = Array.from(threadStates.values()).sort((a, b) =>
        (a.lastUpdatedAt ?? a.firstSeenAt) <
        (b.lastUpdatedAt ?? b.firstSeenAt)
          ? 1
          : -1,
      );
      return {
        status: {
          pollIntervalMs,
          retentionDays,
          includeHidden,
          chokepointConnected,
          threadCount: threadStates.size,
          lastEventAt,
          pollIteration,
          isStale: isStale(),
        },
        crossThread: crossThreadFromThreads(states),
        threads: states.map(perThread),
        rateLimits: rateLimits.slice(0, MAX_RATE_LIMIT_SNAPSHOTS),
        compactions: gatherCompactions(),
      };
    },
    currentThreadContext: ({ threadId }) => {
      const state = threadStates.get(threadId) ?? null;
      const snapshot: PerThreadContext = state
        ? perThread(state)
        : perThread({
            threadId,
            firstSeenAt: nowIso(),
            lastUpdatedAt: null,
            lastSeqByPrefix: {
              tokenUsage: 0,
              contextWindowUsage: 0,
              compacted: 0,
              contextCleared: 0,
              rateLimits: 0,
            },
            totalTokens: 0,
            lastTokens: null,
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            reasoningOutputTokens: null,
            modelContextWindow: null,
            usedTokens: null,
            percentUsed: null,
            contextEstimated: null,
            compactions: [],
            contextClearCount: 0,
            providerThreadId: null,
            projectId: null,
            threadTitle: "",
          });
      const used = snapshot.usedTokens;
      const window = snapshot.modelContextWindow;
      const pct = snapshot.percentUsed;
      const lastCompaction = state ? state.compactions[0] ?? null : null;
      return {
        threadId,
        providerThreadId: state?.providerThreadId ?? null,
        percentUsed: pct,
        usedTokens: used,
        windowTokens: window,
        totalTokens: snapshot.totalTokens,
        lastTokens: snapshot.lastTokens,
        compactionCount: snapshot.compactionCount,
        contextClearCount: state?.contextClearCount ?? 0,
        lastCompactionAt: lastCompaction?.ts ?? null,
        lastUpdatedAt: state?.lastUpdatedAt ?? null,
        estimated: state?.contextEstimated ?? null,
        modelContextWindow: window,
      };
    },
    threadTotals: () => {
      const states = Array.from(threadStates.values()).sort((a, b) =>
        (a.lastUpdatedAt ?? a.firstSeenAt) <
        (b.lastUpdatedAt ?? b.firstSeenAt)
          ? 1
          : -1,
      );
      return { threads: states.map(perThread) };
    },
    dailyTotals: async ({ date, projectId }) => {
      const entries = await readDailyEntries(date, projectId);
      return { entries };
    },
    rateLimits: () => ({
      entries: rateLimits.slice(0, MAX_RATE_LIMIT_SNAPSHOTS),
    }),
  });

  // ─── Lifecycle: thread mapping + latent project hydration ──────────────

  type LifecycleThread = {
    id?: unknown;
    title?: unknown;
    providerId?: unknown;
    providerThreadId?: unknown;
    projectId?: unknown;
  };
  function maybeTrackLifecycle(t: LifecycleThread | undefined): void {
    if (!t || typeof t.id !== "string") return;
    if (t.providerId !== "codex") return;
    rememberProviderThread(t.id, typeof t.providerThreadId === "string" ? t.providerThreadId : null);
    if (typeof t.title === "string") rememberTitle(t.id, t.title);
    if (typeof t.projectId === "string") rememberProject(t.id, t.projectId);
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
  bb.events.on("thread.archived", async (event) => {
    const t = (event as { thread?: LifecycleThread }).thread;
    if (!t || typeof t.id !== "string") return;
    // Keep state — compacted/cleared events a thread emits before it goes
    // quiet should still be reflected. Soft-evict when chokepoint removes
    // it, not on archive alone.
  });

  // Hydrate reducer baselines/watermarks before the bridge can replay its
  // ring. This prevents a normal reload from counting cumulative usage and
  // compaction events a second time.
  try {
    const keys = await bb.storage.kv.list(KV_KEY_THREAD_STATE);
    for (const key of keys) {
      const value = await bb.storage.kv.get<ThreadState>(key);
      const threadId = key.slice(KV_KEY_THREAD_STATE.length);
      if (
        value &&
        value.threadId === threadId &&
        value.lastSeqByPrefix &&
        Array.isArray(value.compactions)
      ) {
        threadStates.set(threadId, value);
        if (value.projectId) lastProjectByThread.set(threadId, value.projectId);
      }
    }
  } catch (err) {
    bb.log.debug(`thread-state kv hydration failed: ${String(err)}`);
  }

  // Hydrate lastProjectByThread from kv.
  try {
    const keys = await bb.storage.kv.list(KV_KEY_LAST_PROJECT);
    for (const key of keys) {
      const v = await bb.storage.kv.get<string>(key);
      if (typeof v === "string") {
        const tid = key.slice(KV_KEY_LAST_PROJECT.length);
        lastProjectByThread.set(tid, v);
      }
    }
  } catch (err) {
    bb.log.debug(`last-project kv hydration failed: ${String(err)}`);
  }

  // ─── Background poll service ──────────────────────────────────────────

  bb.background.service("poll-codex-context", {
    async start(signal) {
      bb.log.info(
        `codex-context polling ${CHOKEPOINT_PLUGIN_ID} every ${pollIntervalMs}ms`,
      );

      // Soft-bake lastProjectByThread entries into ensureThread so the
      // aggregate's first event pays the right projectId, then reconcile
      // existing Codex threads that predate this plugin generation.
      for (const [tid, pid] of lastProjectByThread.entries()) {
        const s = ensureThread(tid);
        s.projectId = pid;
      }
      await refreshThreadMetadata(signal);

      while (!signal.aborted) {
        pollIteration += 1;
        const startedAt = Date.now();
        try {
              const threadResult = await fetchThreadEvents();
          const accountResult = await fetchAccountEvents();
          chokepointConnected = threadResult.ok && accountResult.ok;
          const events = threadResult.events
            .filter((event) => event.type.startsWith("thread/"))
            .concat(accountResult.events.filter((event) => event.type.startsWith("provider/")));
          events.sort((a, b) => a.seq - b.seq);
          let changed = false;
          for (const event of events) {
            try {
              const beforeUpdatedAt = threadStates.get(event.threadId)?.lastUpdatedAt ?? null;
              const { delta, rateLimit } = applyEvent(event);
              if (delta) await recordDelta(delta);
              const state = threadStates.get(event.threadId);
              const eventChanged =
                delta !== null ||
                rateLimit !== null ||
                (state?.lastUpdatedAt ?? null) !== beforeUpdatedAt;
              if (eventChanged) {
                changed = true;
                if (state) await bb.storage.kv.set(`${KV_KEY_THREAD_STATE}${event.threadId}`, state);
              }
            } catch (err) {
              bb.log.warn(
                `applyEvent failed for ${event.type}: ${String(err)}`,
              );
            }
          }
          // Publish a synthetic snapshot signal every poll — frontends can
          // subscribe to this and re-fetch the full snapshot inline.
          if (changed) {
            bb.realtime.publish("codex-context/snapshot", {
              kind: "delta",
              pollIteration,
              threadId: events[events.length - 1]?.threadId ?? null,
            });
          }
          // Flush the in-memory daily buffer every ~2s so the front end's
          // dailyTotals RPC reflects new spend quickly.
          if (Date.now() - lastDailyFlushAt >= 2000) {
            await flushDailyBuffer("tick");
          }
          // Prune aged daily entries (cheap; whole list is small).
          if (pollIteration % 10 === 0) {
            await refreshThreadMetadata(signal);
          }
          if (pollIteration % 30 === 0) {
            await pruneOldDaily();
          }
        } catch (err) {
          bb.log.warn(`poll loop iteration failed: ${String(err)}`);
        }
        const elapsed = Date.now() - startedAt;
        const sleepFor = Math.max(0, pollIntervalMs - elapsed);
        await abortAwareSleep(sleepFor, signal);
      }

      // Final flush on shutdown so a fast unload doesn't leak in-memory deltas.
      try {
        await flushDailyBuffer("dispose");
      } catch (err) {
        bb.log.warn(`final flush failed: ${String(err)}`);
      }
      bb.log.info("codex-context poll service exiting");
    },
  });

  bb.onDispose(() => {
    bb.log.info(
      `codex-context disposing; tracked ${threadStates.size} thread(s); ${rateLimits.length} rate-limit record(s)`,
    );
  });

  bb.log.info("codex-context loaded; awaiting first chokepoint tick");
}

// ─── Local helpers ───────────────────────────────────────────────────────

function readNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function readNullableNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  return readNumber(v);
}

function readBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  return null;
}

function dedupeStrings(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    if (typeof v !== "string") continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function compKindForType(t: string): CompactionRecord["kind"] {
  if (t === "thread/context/cleared") return "context_cleared";
  return "compacted";
}

function parseRateLimitKind(v: unknown): RateLimitRecord["kind"] {
  switch (v) {
    case "spend-control":
    case "subscription-window":
    case "credits":
      return v;
    default:
      return "unknown";
  }
}

function parseRateLimitStatus(v: unknown): RateLimitRecord["status"] {
  switch (v) {
    case "allowed":
    case "blocked":
    case "warning":
      return v;
    default:
      return "unknown";
  }
}

function parseRateLimitOverageStatus(v: unknown): RateLimitRecord["overageStatus"] {
  switch (v) {
    case "allowed":
    case "rejected":
    case "unavailable":
    case "warning":
      return v;
    default:
      return null;
  }
}

function localDateKey(d: Date | number): string {
  const date = typeof d === "number" ? new Date(d) : d;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
