import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTokensCompact } from "@/lib/utils";
import type { CrossThreadTotals, DailyTotalEntry } from "../contract";

export function TokenTotalsCard({
  totals,
  daily,
}: {
  totals: CrossThreadTotals;
  daily: DailyTotalEntry[];
}) {
  const today = new Date().toLocaleDateString("en-CA");
  const todayTokens = daily
    .filter((entry) => entry.date === today)
    .reduce((sum, entry) => sum + entry.totalTokens, 0);
  const weekTokens = daily
    .filter((entry) => Date.now() - new Date(`${entry.date}T00:00:00`).getTime() < 7 * 86_400_000)
    .reduce((sum, entry) => sum + entry.totalTokens, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Token totals</CardTitle>
        <CardDescription>Aggregate Codex spend across tracked threads.</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-3 gap-3">
        <Metric label="Today" value={formatTokensCompact(todayTokens)} />
        <Metric label="7 days" value={formatTokensCompact(weekTokens)} />
        <Metric label="Live threads" value={String(totals.threadCount)} />
        <div className="col-span-3 border-t border-border pt-3 text-xs text-muted-foreground">
          {formatTokensCompact(totals.totalTokens)} cumulative tokens in the current in-memory snapshot
        </div>
      </CardContent>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="truncate font-mono text-lg font-semibold">{value}</div>
    </div>
  );
}
