import { definePluginApp, useBbNavigate, useSettings } from "@get-bb/plugin-sdk/app";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CompactionHistoryCard } from "@/components/CompactionHistoryCard";
import { ContextBar } from "@/components/ContextBar";
import { RateLimitBadge } from "@/components/RateLimitBadge";
import { TokenTotalsCard } from "@/components/TokenTotalsCard";
import {
  useCodexContextSnapshot,
  useCodexCurrentThreadContext,
  useCodexDailyTotals,
} from "@/hooks/useCodexContext";
import { formatPercent, formatRelative } from "@/lib/utils";

function ContextPanel() {
  const { data, isLoading, error } = useCodexContextSnapshot();
  const daily = useCodexDailyTotals();

  if (isLoading && !data) {
    return <div className="p-5 text-sm text-muted-foreground">Loading Codex context…</div>;
  }
  if (!data) {
    return <div className="p-5 text-sm text-destructive">{error ?? "Context data unavailable."}</div>;
  }

  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {data.status.chokepointConnected
              ? `${data.status.threadCount} Codex thread${data.status.threadCount === 1 ? "" : "s"} tracked`
              : "Codex events bridge unavailable"}
          </p>
          <RateLimitBadge record={data.rateLimits[0] ?? null} />
        </div>

        <TokenTotalsCard totals={data.crossThread} daily={daily?.entries ?? []} />

        <Card>
          <CardHeader>
            <CardTitle>Thread context pressure</CardTitle>
            <CardDescription>Newest context-window updates first.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {data.threads.length === 0 ? (
              <p className="text-sm text-muted-foreground">No Codex usage events recorded yet.</p>
            ) : (
              data.threads.map((thread) => (
                <div key={thread.threadId} className="space-y-2 border-b border-border pb-4 last:border-0 last:pb-0">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate font-mono">{thread.threadId}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {thread.lastUpdatedAt ? formatRelative(thread.lastUpdatedAt) : "waiting"}
                    </span>
                  </div>
                  <ContextBar
                    percent={thread.percentUsed}
                    usedTokens={thread.usedTokens}
                    windowTokens={thread.modelContextWindow}
                    totalTokens={thread.totalTokens}
                  />
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <CompactionHistoryCard records={data.compactions} />
      </div>
    </div>
  );
}

function HeaderContextPill({ threadId }: { threadId: string }) {
  const { data, isLoading } = useCodexCurrentThreadContext(threadId);
  const navigate = useBbNavigate();
  if (isLoading || data.lastUpdatedAt === null || data.percentUsed === null) return null;
  return (
    <button
      type="button"
      className="flex h-7 items-center gap-2 rounded-md border border-border bg-background px-2 text-xs transition-colors hover:bg-muted"
      aria-label={`Codex context ${formatPercent(data.percentUsed)}`}
      title={`${data.usedTokens?.toLocaleString() ?? "Unknown"} of ${data.windowTokens?.toLocaleString() ?? "unknown"} context tokens used`}
      onClick={() => {
        navigate.openThreadPanel({ actionId: "thread-context", title: "Codex context" });
      }}
    >
      <span>Context {formatPercent(data.percentUsed)}</span>
      <ContextBar percent={data.percentUsed} compact className="w-12" />
    </button>
  );
}

function ThreadContextPanel({ threadId }: { threadId: string }) {
  const { data, isLoading, error } = useCodexCurrentThreadContext(threadId);
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading context…</p>;
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  return (
    <div className="space-y-4">
      <ContextBar
        percent={data.percentUsed}
        usedTokens={data.usedTokens}
        windowTokens={data.windowTokens}
        totalTokens={data.totalTokens}
      />
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <Stat label="Compactions" value={data.compactionCount.toLocaleString()} />
        <Stat label="Context clears" value={data.contextClearCount.toLocaleString()} />
        <Stat label="Last turn" value={data.lastTokens?.toLocaleString() ?? "—"} />
        <Stat label="Updated" value={data.lastUpdatedAt ? formatRelative(data.lastUpdatedAt) : "—"} />
      </dl>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  );
}

function SettingsSummary() {
  const { values, isLoading } = useSettings();
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  const current = values ?? {};
  return (
    <div className="rounded-lg border border-border p-4 text-sm">
      <p>Poll cadence: {String(current.pollIntervalMs ?? "1500")} ms</p>
      <p>Daily retention: {String(current.retentionDays ?? "30")} days</p>
      <p>Hidden workers: {current.includeHidden === false ? "excluded" : "included"}</p>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "codex-context",
    title: "Codex context",
    icon: "Gauge",
    path: "context",
    component: ContextPanel,
  });

  app.slots.experimental_threadHeaderAction({
    id: "context-pressure",
    title: "Codex context pressure",
    component: ({ threadId }) => <HeaderContextPill threadId={threadId} />,
  });

  app.slots.threadPanelAction({
    id: "thread-context",
    title: "Codex context",
    icon: "Gauge",
    component: ({ threadId }) => <ThreadContextPanel threadId={threadId} />,
  });

  app.slots.settingsSection({
    id: "codex-context-settings",
    title: "Codex context",
    description: "Read-only context pressure and token aggregation settings.",
    component: SettingsSummary,
  });
});
