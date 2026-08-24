import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRelative } from "@/lib/utils";
import type { CompactionRecord } from "../contract";

export function CompactionHistoryCard({ records }: { records: CompactionRecord[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Compaction history</CardTitle>
        <CardDescription>Recent compactions and explicit context clears.</CardDescription>
      </CardHeader>
      <CardContent>
        {records.length === 0 ? (
          <p className="text-sm text-muted-foreground">No compactions recorded.</p>
        ) : (
          <ul className="space-y-2">
            {records.slice(0, 12).map((record, index) => (
              <li key={`${record.threadId}-${record.ts}-${index}`} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate">
                  {record.kind === "compacted" ? "Compacted" : "Context cleared"}
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{record.threadId}</span>
                </span>
                <time className="shrink-0 text-xs text-muted-foreground" dateTime={record.ts}>
                  {formatRelative(record.ts)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
