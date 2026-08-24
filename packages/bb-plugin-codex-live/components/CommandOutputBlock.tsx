// CommandOutputBlock — stream one `commandExecution` live item.
//
// The item carries a fixed command + cwd and accumulates streamed
// `aggregatedOutput` text via `item/commandExecution/outputDelta`. The
// server's 256 KiB cap keeps this from blowing up; we render the buffer
// in a small monospace scroll region with auto-scroll.

import { useLayoutEffect, useRef } from "react";
import type { LiveItemRpc } from "@/contract";
import { cn } from "@/lib/utils";

interface Props {
  item: Extract<LiveItemRpc, { kind: "commandExecution" }>;
  autoScroll: boolean;
}

export function CommandOutputBlock({ item, autoScroll }: Props) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const lastRef = useRef<number>(item.aggregatedOutput.length);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const grew = item.aggregatedOutput.length > lastRef.current;
    lastRef.current = item.aggregatedOutput.length;
    if (grew && autoScroll && el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
      el.scrollTop = el.scrollHeight;
    }
  }, [item.aggregatedOutput, autoScroll]);

  const statusBadge = item.completed
    ? item.exitCode === 0
      ? "exit 0"
      : item.exitCode === null
        ? item.status ?? "completed"
        : `exit ${item.exitCode}`
    : "running";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
          {item.command || "(shell pending)"}
        </code>
        {item.cwd ? (
          <span className="font-mono text-[11px] text-muted-foreground">{item.cwd}</span>
        ) : null}
        <span
          className={cn(
            "ml-auto rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide",
            item.completed
              ? item.exitCode === 0
                ? "bg-primary/10 text-primary"
                : "bg-destructive/10 text-destructive"
              : "bg-muted text-muted-foreground",
          )}
        >
          {statusBadge}
        </span>
      </div>
      <div
        ref={bodyRef}
        className="max-h-[40vh] min-h-[3rem] overflow-y-auto whitespace-pre-wrap rounded border border-border/40 bg-muted/40 p-2 font-mono text-xs leading-snug text-foreground"
      >
        {item.aggregatedOutput || (
          <span className="text-muted-foreground italic">waiting for output…</span>
        )}
      </div>
      {item.truncated ? (
        <div className="text-[10px] text-muted-foreground">
          Output truncated to fit live buffer (oldest lines dropped).
        </div>
      ) : null}
    </div>
  );
}
