import { cn, formatRelative } from "@/lib/utils";
import type { RateLimitRecord } from "../contract";

export function RateLimitBadge({ record }: { record: RateLimitRecord | null }) {
  if (!record) {
    return <span className="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">Limits unavailable</span>;
  }
  const blocked = record.status === "blocked" || record.overageStatus === "rejected";
  const warning = record.status === "warning" || record.overageStatus === "warning";
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-1 text-xs",
        blocked
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : warning
            ? "border-border bg-muted text-foreground"
            : "border-border bg-background text-muted-foreground",
      )}
      title={record.reachedReason ?? record.overageReason ?? `Updated ${formatRelative(record.ts)}`}
    >
      Rate limits: {blocked ? "blocked" : warning ? "warning" : record.status}
    </span>
  );
}
