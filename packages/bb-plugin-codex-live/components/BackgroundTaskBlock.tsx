import type { LiveItemRpc } from "@/contract";

interface Props {
  item: Extract<LiveItemRpc, { kind: "backgroundTask" }>;
}

function progressPercent(progress: number | null): number | null {
  if (progress === null) return null;
  const normalized = progress <= 1 ? progress * 100 : progress;
  return Math.max(0, Math.min(100, normalized));
}

export function BackgroundTaskBlock({ item }: Props) {
  const percent = progressPercent(item.progress);
  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-start gap-2">
        <div className="min-w-0">
          <p className="font-medium">{item.description || "Background task"}</p>
          {item.taskType ? (
            <p className="font-mono text-[11px] text-muted-foreground">{item.taskType}</p>
          ) : null}
        </div>
        <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase">
          {item.taskStatus}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Background task progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
        <div
          className={percent === null ? "h-full w-1/3 animate-pulse rounded-full bg-primary" : "h-full rounded-full bg-primary transition-[width]"}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      {item.workflowSummary ? (
        <p className="text-muted-foreground">{item.workflowSummary}</p>
      ) : null}
    </div>
  );
}
