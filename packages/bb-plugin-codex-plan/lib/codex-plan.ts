// Shared types and parsers for codex plan state.
//
// Codex emits two flavours of the plan:
//   * `turn/plan/updated` — full snapshot:
//       { threadId, providerThreadId, plan: PlanStep[], explanation?: string }
//   * `item/plan/delta` — same shape as a streaming partial update.
//
// We accept any string-valued `status` (codex has used both
// "pending"/"in_progress"/"completed" and "active"/"completed"/"failed"/"pending"
// across releases) and normalise to a stable vocabulary for rendering.
//
// The snapshot is keyed by (providerThreadId OR threadId) so a single thread
// closes cleanly when its `turn/completed` arrives.

export type CodexPlanStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "unknown";

export type CodexPlanStep = {
  step: string;
  status: CodexPlanStepStatus;
};

export type CodexPlanSnapshot = {
  /** Resolved thread id the snapshot is bound to (bb threadId). */
  threadId: string;
  /** Provider thread id if we know it; null when the bridge has no mapping yet. */
  providerThreadId: string | null;
  plan: CodexPlanStep[];
  explanation: string | null;
  /** ISO ts of the underlying event we built this snapshot from. */
  ts: string;
  /** Whether a user has approved / rejected / requested changes yet. */
  decision:
    | { kind: "approved"; at: string }
    | { kind: "rejected"; at: string; reason?: string }
    | { kind: "request-changes"; at: string; message: string }
    | null;
  /** Last seq we applied — gate so an out-of-order delta can't roll back state. */
  lastSeq: number;
};

const KNOWN_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "active",
]);

export function normalisePlanStepStatus(raw: unknown): CodexPlanStepStatus {
  if (typeof raw !== "string") return "unknown";
  if (raw === "active") return "in_progress";
  if (KNOWN_STATUSES.has(raw)) return raw as CodexPlanStepStatus;
  return "unknown";
}

export function parsePlanSteps(raw: unknown): CodexPlanStep[] {
  if (!Array.isArray(raw)) return [];
  const out: CodexPlanStep[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const step = typeof obj.step === "string" ? obj.step : null;
    if (step === null) continue;
    out.push({
      step,
      status: normalisePlanStepStatus(obj.status),
    });
  }
  return out;
}

export function parseExplanation(raw: unknown): string | null {
  if (typeof raw === "string" && raw.length > 0) return raw;
  return null;
}

export function isPlanStepCompleted(step: CodexPlanStep): boolean {
  return step.status === "completed";
}

export function isPlanReadyForDecision(snap: CodexPlanSnapshot): boolean {
  // Plannotator-style: a plan is reviewable as soon as codex publishes one
  // snapshot, regardless of how many steps are still pending/active. The
  // `codex/turn/plan/updated` event itself means "here's the plan; please
  // decide". A decision is only suppressed once one has already been made
  // (so we don't pester after the user approved).
  if (snap.plan.length === 0 && snap.explanation === null) return false;
  return snap.decision === null;
}

export function summarisePlanCounts(plan: CodexPlanStep[]): {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
} {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  let failed = 0;
  for (const s of plan) {
    if (s.status === "pending") pending += 1;
    else if (s.status === "in_progress") inProgress += 1;
    else if (s.status === "completed") completed += 1;
    else if (s.status === "failed") failed += 1;
  }
  return { total: plan.length, pending, inProgress, completed, failed };
}
