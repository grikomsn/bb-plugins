// PlanList — given a snapshot, render the steps as a checklist with status
// pills, then surface totals (pending / in_progress / completed / failed)
// next to the heading. Used by both the nav panel and the thread-panel tab.

import type { CodexPlanSnapshot } from "@/lib/codex-plan";
import { cn } from "@/lib/utils";

function statusTone(status: CodexPlanSnapshot["plan"][number]["status"]): string {
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

function statusLabel(status: CodexPlanSnapshot["plan"][number]["status"]): string {
  switch (status) {
    case "in_progress":
      return "in progress";
    default:
      return status;
  }
}

export function PlanList({ snapshot }: { snapshot: CodexPlanSnapshot }) {
  const totals = snapshot.plan.reduce(
    (acc, s) => {
      if (s.status === "pending") acc.pending += 1;
      else if (s.status === "in_progress") acc.inProgress += 1;
      else if (s.status === "completed") acc.completed += 1;
      else if (s.status === "failed") acc.failed += 1;
      return acc;
    },
    { pending: 0, inProgress: 0, completed: 0, failed: 0 },
  );

  if (snapshot.plan.length === 0) {
    return (
      <div className="rounded border border-border p-3 text-sm text-muted-foreground">
        Empty plan — codex published no steps with this snapshot.
      </div>
    );
  }

  return (
    <ul className="space-y-1.5">
      {snapshot.plan.map((step, i) => (
        <li
          key={`${i}-${step.step.slice(0, 24)}`}
          className="flex items-start gap-3 rounded px-2 py-2 hover:bg-muted/30"
        >
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
      ))}
      <li className="px-2 pt-2 text-[11px] text-muted-foreground">
        {snapshot.plan.length} step{snapshot.plan.length === 1 ? "" : "s"} •{" "}
        <span className="font-mono">{totals.completed}</span> done •{" "}
        <span className="font-mono">{totals.inProgress}</span> in progress •{" "}
        <span className="font-mono">{totals.pending}</span> pending
        {totals.failed > 0 ? (
          <>
            {" • "}
            <span className="font-mono text-destructive">
              {totals.failed} failed
            </span>
          </>
        ) : null}
      </li>
    </ul>
  );
}
