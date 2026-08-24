import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const goalStatusSchema = z.enum([
  "active",
  "paused",
  "budgetLimited",
  "complete",
]);

export const goalSchema = z
  .object({
    goalId: z.string(),
    objective: z.string(),
    status: goalStatusSchema,
    tokenBudget: z.number().int().nonnegative().nullable(),
    usage: z.object({
      tokensUsed: z.number().int().nonnegative(),
      activeSeconds: z.number().int().nonnegative(),
    }),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();

export const goalSnapshotSchema = z
  .object({
    goal: goalSchema.nullable(),
    historyCount: z.number().int().nonnegative(),
    objectivePreview: z.string().nullable(),
    ts: z.string(),
    source: z.string(),
  })
  .strict();

export const historyEntrySchema = z
  .object({
    kind: z.enum(["set", "usage", "clear"]),
    at: z.number(),
    source: z.string().optional(),
    goalId: z.string().nullable().optional(),
    objective: z.string().optional(),
    status: goalStatusSchema.optional(),
    tokensUsed: z.number().int().nonnegative().optional(),
    activeSeconds: z.number().int().nonnegative().optional(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  snapshot: {
    input: z.object({ parentSessionId: z.string().optional() }).strict(),
    output: z
      .object({
        source: z.string(),
        bridgeAvailable: z.boolean(),
        snapshot: goalSnapshotSchema.nullable(),
        sessionId: z.string().nullable(),
        sessionIds: z.array(z.string()),
      })
      .strict(),
  },
  history: {
    input: z
      .object({
        parentSessionId: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional().default(50),
      })
      .strict(),
    output: z
      .object({
        source: z.string(),
        entries: z.array(historyEntrySchema),
      })
      .strict(),
  },
  allSnapshots: {
    input: z.null(),
    output: z
      .object({
        bridgeAvailable: z.boolean(),
        snapshots: z.array(
          z
            .object({
              sessionId: z.string(),
              threadId: z.string(),
              goal: goalSchema.nullable(),
              historyCount: z.number().int().nonnegative(),
              ts: z.string(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  currentThreadSnapshot: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z
      .object({
        threadId: z.string(),
        providerSessionId: z.string().nullable(),
        bridgeAvailable: z.boolean(),
        snapshot: goalSnapshotSchema.nullable(),
      })
      .strict(),
  },
  clearGoal: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
});

export type GoalStatus = z.infer<typeof goalStatusSchema>;
export type Goal = z.infer<typeof goalSchema>;
export type GoalSnapshot = z.infer<typeof goalSnapshotSchema>;
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
