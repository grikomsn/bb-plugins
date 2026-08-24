// FileChangeBlock — stream one `fileChange` live item.
//
// The bridge forwards the diff via `item/fileChange/outputDelta`. We show
// the raw diff text in a monospace container, also auto-scrolling as new
// hunks arrive.

import { useLayoutEffect, useRef } from "react";
import type { LiveItemRpc } from "@/contract";
import { cn } from "@/lib/utils";

interface Props {
  item: Extract<LiveItemRpc, { kind: "fileChange" }>;
  autoScroll: boolean;
}

export function FileChangeBlock({ item, autoScroll }: Props) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const lastRef = useRef<number>(item.diff.length);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const grew = item.diff.length > lastRef.current;
    lastRef.current = item.diff.length;
    if (grew && autoScroll && el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
      el.scrollTop = el.scrollHeight;
    }
  }, [item.diff, autoScroll]);

  return (
    <div className="space-y-2">
      <div
        ref={bodyRef}
        className={cn(
          "max-h-[40vh] min-h-[3rem] overflow-y-auto whitespace-pre-wrap rounded border border-border/40 bg-muted/20 p-2 font-mono text-xs leading-snug",
        )}
      >
        {item.diff || (
          <span className="text-muted-foreground italic">waiting for diff…</span>
        )}
      </div>
      {item.truncated ? (
        <div className="text-[10px] text-muted-foreground">
          Diff stream truncated to fit live buffer (earliest hunk dropped).
        </div>
      ) : null}
    </div>
  );
}
