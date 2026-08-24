// bb-plugin-codex-plan — RPC contract.
//
// Surface:
//   * `snapshot`              — every tracked thread's latest plan (in-memory).
//   * `plansBySession`        — keyed by providerThreadId, useful for the
//                               nav panel's per-session picker.
//   * `currentThreadPlan`     — resolve a bb threadId -> plan snapshot.
//   * `decide`                — synthesises a steer message and sends it via
//                               `bb.sdk.threads.send` with the
//                               `<plan_decision>...</plan_decision>` envelope
//                               plannotator/codex already understand.

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const planStepSchema = z.object({
  step: z.string(),
  status: z.enum([
    "pending",
    "in_progress",
    "completed",
    "failed",
    "unknown",
  ]),
});
const planDecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("approved"), at: z.string() }),
  z.object({
    kind: z.literal("rejected"),
    at: z.string(),
    reason: z.string().optional(),
  }),
  z.object({
    kind: z.literal("request-changes"),
    at: z.string(),
    message: z.string(),
  }),
]);

const planSnapshotSchema = z.object({
  threadId: z.string(),
  providerThreadId: z.string().nullable(),
  plan: z.array(planStepSchema),
  explanation: z.string().nullable(),
  ts: z.string(),
  decision: planDecisionSchema.nullable(),
  lastSeq: z.number().int().nonnegative(),
});

export const rpcContract = defineRpcContract({
  snapshot: {
    input: z.union([
      z.null(),
      z.object({ threadId: z.string().min(1).optional() }).strict(),
    ]),
    output: z.object({
      chokepoint: z.string(),
      sessionIds: z.array(z.string()),
      snapshots: z.array(planSnapshotSchema),
    }),
  },
  plansBySession: {
    input: z
      .object({
        threadId: z.string().optional(),
      })
      .strict(),
    output: z.object({
      chokepoint: z.string(),
      snapshots: z.array(planSnapshotSchema),
    }),
  },
  currentThreadPlan: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({
      threadId: z.string(),
      providerThreadId: z.string().nullable(),
      snapshot: planSnapshotSchema.nullable(),
    }),
  },
  decide: {
    input: z
      .object({
        threadId: z.string().min(1),
        decision: z.union([
          z.literal("approve"),
          z.literal("reject"),
          z.literal("request-changes"),
        ]),
        message: z.string().optional(),
      })
      .strict(),
    output: z.object({
      ok: z.boolean(),
      threadId: z.string(),
      decision: z.enum(["approve", "reject", "request-changes"]),
      sentMessage: z.string(),
      reason: z.string().nullable(),
    }),
  },
});
