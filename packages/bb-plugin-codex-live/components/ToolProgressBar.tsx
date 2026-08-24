import type { LiveItemRpc } from "@/contract";

interface Props {
  item: Extract<LiveItemRpc, { kind: "toolCall" | "mcpToolCall" }>;
}

export function ToolProgressBar({ item }: Props) {
  const current = item.progressCurrent;
  const total = item.progressTotal;
  const bounded = current !== null && total !== null && total > 0;
  const percent = bounded ? Math.max(0, Math.min(100, (current / total) * 100)) : null;
  const label = item.kind === "mcpToolCall"
    ? [item.server, item.tool].filter(Boolean).join(" · ") || "MCP tool"
    : item.tool || "Tool call";

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="truncate font-mono">{label}</span>
        <span className="ml-auto shrink-0 text-muted-foreground">
          {item.completed
            ? item.status ?? "completed"
            : bounded
              ? `${current}/${total}`
              : "running"}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={`${label} progress`}
        aria-valuemin={0}
        aria-valuemax={bounded ? total : undefined}
        aria-valuenow={bounded ? current : undefined}
      >
        <div
          className={
            percent === null
              ? "h-full w-1/3 animate-pulse rounded-full bg-primary"
              : "h-full rounded-full bg-primary transition-[width]"
          }
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      {item.message ? <p className="text-xs text-muted-foreground">{item.message}</p> : null}
    </div>
  );
}
