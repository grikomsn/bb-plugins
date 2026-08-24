// RawEventTable — the main render: a newest-first table of recent
// `provider/unhandled` rows with classification + rawType + ts + a
// payload preview. Clicking a row expands the RawEventDetail panel.

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CodexRawEvent } from "../contract";
import { useCodexRawEvents } from "../hooks/useCodexRaw";
import { RawEventDetail } from "./RawEventDetail";

function classificationTone(c: "unhandled" | "noise" | "other"): string {
  switch (c) {
    case "unhandled":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
    case "noise":
      return "bg-slate-500/15 text-slate-700 dark:text-slate-300";
    case "other":
      return "bg-blue-500/15 text-blue-700 dark:text-blue-300";
  }
}

function shortThreadId(threadId: string): string {
  return threadId.length > 12 ? `…${threadId.slice(-12)}` : threadId;
}

type Props = {
  threadId?: string;
  refreshKey?: string | number;
};

export function RawEventTable({ threadId, refreshKey }: Props): React.ReactNode {
  const [classificationFilter, setClassificationFilter] = useState<
    "" | "unhandled" | "noise" | "other"
  >("");
  const [rawTypeFilter, setRawTypeFilter] = useState<string>("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const events = useCodexRawEvents({
    threadId,
    classification: classificationFilter || undefined,
    rawType: rawTypeFilter || undefined,
    limit: 200,
  });

  // Re-bump selected idx when the active thread changes so the detail
  // panel resets instead of holding a stale row.
  useEffect(() => {
    setSelectedKey(null);
  }, [threadId, refreshKey]);

  const filtered = useMemo(() => events, [events]);

  const selected = useMemo(
    () =>
      filtered.find((event) => `${event.threadId}:${event.seq}` === selectedKey) ??
      filtered[0] ??
      null,
    [filtered, selectedKey],
  );

  // Derive the list of raw types we see in the current window so the chip
  // row stays curated (no need to fetch `types` just to render one chip
  // per known type).
  const recentTypes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of events) {
      counts.set(e.rawType, (counts.get(e.rawType) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12);
  }, [events]);

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {(["", "unhandled", "noise", "other"] as const).map((g) => (
            <Button
              key={g || "all"}
              size="sm"
              variant={classificationFilter === g ? "default" : "outline"}
              onClick={() => setClassificationFilter(g)}
            >
              {g || "All"}
            </Button>
          ))}
          <span className="mx-1 self-center text-xs text-muted-foreground">type:</span>
          <Button
            size="sm"
            variant={rawTypeFilter === "" ? "default" : "outline"}
            onClick={() => setRawTypeFilter("")}
          >
            any
          </Button>
          {recentTypes.map(([t, n]) => (
            <Button
              key={t}
              size="sm"
              variant={rawTypeFilter === t ? "default" : "outline"}
              onClick={() => setRawTypeFilter(t)}
              title={`${t} (${n} in window)`}
            >
              {t.length > 24 ? `${t.slice(0, 23)}…` : t}
              <span className="ml-1.5 text-[10px] text-muted-foreground">{n}</span>
            </Button>
          ))}
        </div>
        <div className="max-h-[64vh] overflow-y-auto rounded border border-border">
          {filtered.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              {threadId
                ? `No raw events recorded for ${shortThreadId(threadId)} yet. Trigger a codex protocol traffic (MCP startup, fs scan, etc.) and the ring will fill.`
                : "No raw events recorded yet across any tracked codex thread. Spawn a codex thread to see the 42 noise/unknown notifications surface."}
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {filtered.map((e) => {
                const isSelected = selected?.seq === e.seq && selected?.threadId === e.threadId;
                return (
                  <li
                    key={`${e.threadId}-${e.seq}-${e.rawType}`}
                    onClick={() => setSelectedKey(`${e.threadId}:${e.seq}`)}
                    className={cn(
                      "flex cursor-pointer items-baseline gap-3 px-3 py-2 text-xs hover:bg-muted/30",
                      isSelected && "bg-muted/50",
                    )}
                  >
                    <span className="font-mono text-muted-foreground w-12 shrink-0">
                      #{e.seq}
                    </span>
                    <span className="w-44 shrink-0 truncate font-mono" title={e.ts}>
                      {e.ts}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                        classificationTone(e.classification),
                      )}
                    >
                      {e.classification}
                    </span>
                    <span className="font-mono truncate" title={e.rawType}>
                      {e.rawType}
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-muted-foreground"
                      title={e.paramsPreview}
                    >
                      {e.paramsPreview}
                    </span>
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {shortThreadId(e.threadId)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      <div>
        <RawEventDetail event={selected} />
      </div>
    </div>
  );
}
