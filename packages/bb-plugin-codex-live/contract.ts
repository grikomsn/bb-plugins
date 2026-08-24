// bb-plugin-codex-live — RPC contract shared between server and frontend.

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ─── Schemas mirror the runtime state ──────────────────────────────────

const reasoningItemSchema = z
  .object({
    itemId: z.string(),
    threadId: z.string(),
    kind: z.literal("reasoning"),
    parentToolCallId: z.string().nullable(),
    startedAt: z.string(),
    lastEventAt: z.string(),
    completed: z.boolean(),
    completedAt: z.string().nullable(),
    status: z.string().nullable(),
    byteLength: z.number().int().nonnegative(),
    truncated: z.boolean(),
    content: z.string(),
    summary: z.string(),
  })
  .strict();

const commandExecutionItemSchema = z
  .object({
    itemId: z.string(),
    threadId: z.string(),
    kind: z.literal("commandExecution"),
    parentToolCallId: z.string().nullable(),
    startedAt: z.string(),
    lastEventAt: z.string(),
    completed: z.boolean(),
    completedAt: z.string().nullable(),
    status: z.string().nullable(),
    byteLength: z.number().int().nonnegative(),
    truncated: z.boolean(),
    command: z.string(),
    cwd: z.string(),
    aggregatedOutput: z.string(),
    exitCode: z.number().int().nullable(),
  })
  .strict();

const fileChangeItemSchema = z
  .object({
    itemId: z.string(),
    threadId: z.string(),
    kind: z.literal("fileChange"),
    parentToolCallId: z.string().nullable(),
    startedAt: z.string(),
    lastEventAt: z.string(),
    completed: z.boolean(),
    completedAt: z.string().nullable(),
    status: z.string().nullable(),
    byteLength: z.number().int().nonnegative(),
    truncated: z.boolean(),
    diff: z.string(),
  })
  .strict();

const toolCallItemSchema = z
  .object({
    itemId: z.string(),
    threadId: z.string(),
    kind: z.literal("toolCall"),
    parentToolCallId: z.string().nullable(),
    startedAt: z.string(),
    lastEventAt: z.string(),
    completed: z.boolean(),
    completedAt: z.string().nullable(),
    status: z.string().nullable(),
    byteLength: z.number().int().nonnegative(),
    truncated: z.boolean(),
    tool: z.string(),
    message: z.string().nullable(),
    progressCurrent: z.number().nullable(),
    progressTotal: z.number().nullable(),
  })
  .strict();

const mcpToolCallItemSchema = z
  .object({
    itemId: z.string(),
    threadId: z.string(),
    kind: z.literal("mcpToolCall"),
    parentToolCallId: z.string().nullable(),
    startedAt: z.string(),
    lastEventAt: z.string(),
    completed: z.boolean(),
    completedAt: z.string().nullable(),
    status: z.string().nullable(),
    byteLength: z.number().int().nonnegative(),
    truncated: z.boolean(),
    server: z.string().nullable(),
    tool: z.string(),
    message: z.string().nullable(),
    progressCurrent: z.number().nullable(),
    progressTotal: z.number().nullable(),
  })
  .strict();

const backgroundTaskItemSchema = z
  .object({
    itemId: z.string(),
    threadId: z.string(),
    kind: z.literal("backgroundTask"),
    parentToolCallId: z.string().nullable(),
    startedAt: z.string(),
    lastEventAt: z.string(),
    completed: z.boolean(),
    completedAt: z.string().nullable(),
    status: z.string().nullable(),
    byteLength: z.number().int().nonnegative(),
    truncated: z.boolean(),
    description: z.string(),
    taskType: z.string(),
    taskStatus: z.string(),
    progress: z.number().nullable(),
    workflowSummary: z.string().nullable(),
    progressHistory: z.array(z.number()),
  })
  .strict();

export const liveItemSchema = z.discriminatedUnion("kind", [
  reasoningItemSchema,
  commandExecutionItemSchema,
  fileChangeItemSchema,
  toolCallItemSchema,
  mcpToolCallItemSchema,
  backgroundTaskItemSchema,
]);

const threadSnapshotSchema = z
  .object({
    threadId: z.string(),
    itemCount: z.number().int().nonnegative(),
    inFlightCount: z.number().int().nonnegative(),
    items: z.array(liveItemSchema),
    updatedAt: z.string(),
  })
  .strict();

const snapshotSchema = z
  .object({
    threads: z.array(threadSnapshotSchema),
    updatedAt: z.string(),
  })
  .strict();

const activeStreamSchema = z
  .object({
    threadId: z.string(),
    thread: threadSnapshotSchema,
    clearAfterSeconds: z.number().int().positive(),
    updatedAt: z.string(),
  })
  .strict();

const statusSchema = z
  .object({
    bridgeAvailable: z.boolean(),
    bridgeId: z.string(),
    pollIntervalMs: z.number().int().positive(),
    maxItemsPerThread: z.number().int().positive(),
    maxDeltaBytesPerItem: z.number().int().positive(),
    threadCount: z.number().int().nonnegative(),
    itemCount: z.number().int().nonnegative(),
    inFlightCount: z.number().int().nonnegative(),
    lastEventAt: z.string().nullable(),
    pollIteration: z.number().int().nonnegative(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: statusSchema,
  },
  snapshot: {
    input: z.null(),
    output: snapshotSchema,
  },
  activeThreadStream: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: activeStreamSchema,
  },
  dismiss: {
    input: z
      .object({
        threadId: z.string().min(1),
        itemId: z.string().min(1),
      })
      .strict(),
    output: z.object({ ok: z.boolean(), reason: z.string().nullable() }).strict(),
  },
});

export type CodexLiveSnapshot = z.infer<typeof snapshotSchema>;
export type ThreadSnapshot = z.infer<typeof threadSnapshotSchema>;
export type LiveItemRpc = z.infer<typeof liveItemSchema>;
export type ActiveThreadStream = z.infer<typeof activeStreamSchema>;
export type CodexLiveStatus = z.infer<typeof statusSchema>;

// Re-export for callers that import from contract.ts
export type { BbPluginApi };
