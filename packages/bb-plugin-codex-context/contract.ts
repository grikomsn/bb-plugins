// bb-plugin-codex-context — RPC + event surface contract.
//
// The chokepoint (`bb-plugin-codex-events-bridge`) emits canonical
// `codex/*` realtime signals for every Codex thread event; this plugin
// keeps a per-thread context-pressure snapshot, a timestamped compaction
// history, and a daily-aggregate cross-thread spend counter.
//
// All consumers (frontend, agent tools, future analytics plugins) read
// through `rpcContract`; the actual reducer lives in `server.ts`.

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ─── Schemas ─────────────────────────────────────────────────────────────

const CompactionRecordSchema = z.object({
  ts: z.string(),
  kind: z.enum(["compacted", "context_cleared"]),
  threadId: z.string(),
  providerThreadId: z.string().nullable(),
});

const PerThreadContextSchema = z.object({
  threadId: z.string(),
  totalTokens: z.number().nonnegative(),
  lastTokens: z.number().int().nonnegative().nullable(),
  contextWindowTokens: z.number().int().nonnegative().nullable(),
  modelContextWindow: z.number().int().nonnegative().nullable(),
  usedTokens: z.number().int().nonnegative().nullable(),
  percentUsed: z.number().min(0).max(100).nullable(),
  contextEstimated: z.boolean().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cachedInputTokens: z.number().int().nonnegative().nullable(),
  reasoningOutputTokens: z.number().int().nonnegative().nullable(),
  compactionCount: z.number().int().nonnegative(),
  lastUpdatedAt: z.string().nullable(),
  firstSeenAt: z.string(),
});

const RateLimitWindowSchema = z.object({
  label: z.string().nullable(),
  providerKey: z.string().nullable(),
  resetsAtMs: z.number().nullable(),
  status: z.enum(["allowed", "blocked", "unknown", "warning"]),
});

const RateLimitRecordSchema = z.object({
  ts: z.string(),
  kind: z.enum(["spend-control", "subscription-window", "credits", "unknown"]),
  providerId: z.string(),
  status: z.enum(["allowed", "blocked", "unknown", "warning"]),
  overageReason: z.string().nullable(),
  overageStatus: z.enum(["allowed", "rejected", "unavailable", "warning"]).nullable(),
  reachedReason: z.string().nullable(),
  windows: z.array(RateLimitWindowSchema),
});

const CrossThreadTotalsSchema = z.object({
  threadCount: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  totalInputTokens: z.number().int().nonnegative(),
  totalOutputTokens: z.number().int().nonnegative(),
  totalCachedInputTokens: z.number().int().nonnegative(),
  totalReasoningOutputTokens: z.number().int().nonnegative(),
  compactionCount: z.number().int().nonnegative(),
  contextClearCount: z.number().int().nonnegative(),
  oldestSeenAt: z.string().nullable(),
  newestSeenAt: z.string().nullable(),
});

const DailyTotalEntrySchema = z.object({
  date: z.string(),
  projectId: z.string().nullable(),
  totalTokens: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
  compactionCount: z.number().int().nonnegative(),
  contextClearCount: z.number().int().nonnegative(),
  threadIds: z.array(z.string()),
});

const PluginStatusSchema = z.object({
  pollIntervalMs: z.number().int().positive(),
  retentionDays: z.number().int().positive(),
  includeHidden: z.boolean(),
  chokepointConnected: z.boolean(),
  threadCount: z.number().int().nonnegative(),
  lastEventAt: z.string().nullable(),
  pollIteration: z.number().int().nonnegative(),
  isStale: z.boolean(),
});

// ─── RPC surface ─────────────────────────────────────────────────────────

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: PluginStatusSchema,
  },
  /**
   * Aggregate cross-thread totals + per-thread context entries. Used by the
   * nav panel (cross-thread totals card) and any future aggregate views.
   */
  snapshot: {
    input: z.null(),
    output: z.object({
      status: PluginStatusSchema,
      crossThread: CrossThreadTotalsSchema,
      threads: z.array(PerThreadContextSchema),
      rateLimits: z.array(RateLimitRecordSchema),
      compactions: z.array(CompactionRecordSchema),
    }),
  },
  /**
   * Per-thread context snapshot for the right-panel action and the thread
   * header pill. Unknown threads return a zero/unknown snapshot so CLI and UI
   * consumers can use one stable object shape.
   */
  currentThreadContext: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({
      threadId: z.string(),
      providerThreadId: z.string().nullable(),
      percentUsed: z.number().min(0).max(100).nullable(),
      usedTokens: z.number().int().nonnegative().nullable(),
      windowTokens: z.number().int().nonnegative().nullable(),
      totalTokens: z.number().int().nonnegative(),
      lastTokens: z.number().int().nonnegative().nullable(),
      compactionCount: z.number().int().nonnegative(),
      contextClearCount: z.number().int().nonnegative(),
      lastCompactionAt: z.string().nullable(),
      lastUpdatedAt: z.string().nullable(),
      estimated: z.boolean().nullable(),
      modelContextWindow: z.number().int().nonnegative().nullable(),
    }),
  },
  /** All known per-thread rows in newest-lastUpdated-first order. */
  threadTotals: {
    input: z.null(),
    output: z.object({
      threads: z.array(PerThreadContextSchema),
    }),
  },
  /**
   * Daily aggregates. Omit `date` to read all retained days; pass `date` to
   * read a specific day. Pass `projectId` to scope to one project (the bb project
   * owning the threads that contributed tokens that day).
   */
  dailyTotals: {
    input: z
      .object({
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        projectId: z.string().optional(),
      })
      .strict(),
    output: z.object({
      entries: z.array(DailyTotalEntrySchema),
    }),
  },
  /** Most-recent rate-limit snapshots keyed by thread / providerId. */
  rateLimits: {
    input: z.null(),
    output: z.object({
      entries: z.array(RateLimitRecordSchema),
    }),
  },
});

// ─── Exported inferred shapes (for the frontend hooks/components) ────────

export type CompactionRecord = z.infer<typeof CompactionRecordSchema>;
export type PerThreadContext = z.infer<typeof PerThreadContextSchema>;
export type RateLimitWindow = z.infer<typeof RateLimitWindowSchema>;
export type RateLimitRecord = z.infer<typeof RateLimitRecordSchema>;
export type CrossThreadTotals = z.infer<typeof CrossThreadTotalsSchema>;
export type DailyTotalEntry = z.infer<typeof DailyTotalEntrySchema>;
export type CodexContextStatus = z.infer<typeof PluginStatusSchema>;

// Output schemas — shared with the rpcContract so the frontend gets the
// same shape that `useRpc().call` returns. We do not derive from
// `rpcContract` because zod schema inference through a Readonly<Record<...>>
// narrows to `unknown`; the explicit StandaloneSchemaV1 alias below keeps
// the inference deterministic.
import type { StandardSchemaV1 } from "@get-bb/plugin-sdk";
type InferOutput<S> = S extends StandardSchemaV1<unknown, infer O> ? O : never;

export type CurrentThreadContext = InferOutput<
  (typeof rpcContract)["currentThreadContext"]["output"]
>;
export type CodexContextSnapshot = InferOutput<
  (typeof rpcContract)["snapshot"]["output"]
>;
export type ThreadTotalsResult = InferOutput<
  (typeof rpcContract)["threadTotals"]["output"]
>;
export type DailyTotalsResult = InferOutput<
  (typeof rpcContract)["dailyTotals"]["output"]
>;
export type RateLimitsResult = InferOutput<
  (typeof rpcContract)["rateLimits"]["output"]
>;
export type CodexContextStatusOutput = InferOutput<
  (typeof rpcContract)["status"]["output"]
>;
