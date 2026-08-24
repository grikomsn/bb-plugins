// ReasoningBlock — stream one `reasoning` live item.
//
// The reasoning item has TWO independent text channels (textDelta +
// summaryTextDelta). V1 intentionally renders only raw reasoning text;
// summary presentation/toggling is deferred. The raw block auto-scrolls
// to the bottom as new deltas arrive.

import { useLayoutEffect, useRef } from "react";
import type { LiveItemRpc } from "@/contract";
import { cn } from "@/lib/utils";

interface Props {
  item: Extract<LiveItemRpc, { kind: "reasoning" }>;
  autoScroll: boolean;
}

export function ReasoningBlock({ item, autoScroll }: Props) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const lastContentRef = useRef<string>(item.content);

  // Track content length instead of identity so deltas that append an
  // empty string (rare but possible) still trigger auto-scroll on the
  // next non-empty delta.
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const grew = item.content.length > lastContentRef.current.length;
    lastContentRef.current = item.content;
    if (grew && autoScroll && el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
      el.scrollTop = el.scrollHeight;
    }
  }, [item.content, autoScroll]);

  return (
    <div className="space-y-1">
      <div
        ref={contentRef}
        className={cn(
          "max-h-[40vh] min-h-[3rem] overflow-y-auto whitespace-pre-wrap rounded border border-border/40 bg-muted/30 p-2 font-mono text-xs leading-snug",
        )}
      >
        {item.content || (
          <span className="text-muted-foreground/70 italic">stream starting…</span>
        )}
      </div>
    </div>
  );
}
