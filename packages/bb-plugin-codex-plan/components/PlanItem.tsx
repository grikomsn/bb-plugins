// PlanItem — a single step rendered with its status pill. Re-exported from
// PlanList for callers that want to compose their own ordering (the nav
// panel history view uses this directly, for example).

import type { CodexPlanStep } from "@/lib/codex-plan";
import { cn } from "@/lib/utils";

function statusTone(status: CodexPlanStep["status"]): string {
  switch (status) {
    case "pending":
      return "bg-muted text-muted-foreground";
    case "in_progress":
      return "bg-primary/10 text-primary";
    case "completed":
      return "bg-success/10 text-success";
    case "failed":
      return "bg-destructive/10 text-destructive";
    case "unknown":
      return "bg-secondary text-secondary-foreground";
  }
}

function statusLabel(status: CodexPlanStep["status"]): string {
  switch (status) {
    case "in_progress":
      return "in progress";
    default:
      return status;
  }
}

export function PlanItem({ step, index }: { step: CodexPlanStep; index: number }) {
  return (
    <li
      className="flex items-start gap-3 rounded px-2 py-2 hover:bg-muted/30"
    >
      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
        #{index + 1}
      </span>
      <span
        className={cn(
          "shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
          statusTone(step.status),
        )}
        title={step.status}
      >
        {statusLabel(step.status)}
      </span>
      <span className="text-sm leading-relaxed">{step.step}</span>
    </li>
  );
}
