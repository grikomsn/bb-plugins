import { cn, clampPercent, formatPercent, formatTokens } from "@/lib/utils";

export type ContextBarProps = {
  percent: number | null | undefined;
  usedTokens?: number | null;
  windowTokens?: number | null;
  totalTokens?: number | null;
  className?: string;
  compact?: boolean;
};

export function ContextBar({
  percent,
  usedTokens,
  windowTokens,
  totalTokens,
  className,
  compact = false,
}: ContextBarProps) {
  const pct = clampPercent(percent);
  const tone =
    pct !== null && pct >= 90
      ? "bg-destructive"
      : pct !== null && pct >= 70
        ? "bg-accent-foreground"
        : "bg-primary";

  return (
    <div className={cn(compact ? "space-y-1" : "space-y-2", className)}>
      {!compact ? (
        <div className="flex items-baseline justify-between gap-3 text-xs">
          <span className="font-medium">Context {formatPercent(pct)}</span>
          <span className="truncate text-muted-foreground">
            {usedTokens == null ? "Usage unavailable" : `${formatTokens(usedTokens)} used`}
            {windowTokens == null ? "" : ` of ${formatTokens(windowTokens)}`}
          </span>
        </div>
      ) : null}
      <div
        className={cn("w-full overflow-hidden rounded-full bg-muted", compact ? "h-1" : "h-2")}
        role="progressbar"
        aria-label="Codex context window usage"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct == null ? undefined : Math.round(pct)}
      >
        <div
          className={cn("h-full rounded-full transition-[width] duration-300", tone)}
          style={{ width: `${pct ?? 0}%` }}
        />
      </div>
      {!compact && totalTokens != null ? (
        <p className="text-xs text-muted-foreground">
          {formatTokens(totalTokens)} cumulative tokens
        </p>
      ) : null}
    </div>
  );
}
