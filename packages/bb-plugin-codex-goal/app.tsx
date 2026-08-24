import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { Goal, HistoryEntry, rpcContract } from "./contract";
import { useCodexGoal } from "./hooks/useCodexGoal";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

function statusTone(status: Goal["status"]): string {
  switch (status) {
    case "active":
      return "bg-green-500/15 text-green-700 dark:text-green-300";
    case "paused":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
    case "budgetLimited":
      return "bg-orange-500/15 text-orange-700 dark:text-orange-300";
    case "complete":
      return "bg-muted text-muted-foreground";
  }
}

function relativeTime(value: string | number): string {
  const at = typeof value === "number" ? value : new Date(value).getTime();
  const elapsed = Math.max(0, Date.now() - at);
  if (elapsed < 1_000) return "now";
  if (elapsed < 60_000) return `${Math.round(elapsed / 1_000)}s ago`;
  if (elapsed < 3_600_000) return `${Math.round(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.round(elapsed / 3_600_000)}h ago`;
  return new Date(at).toLocaleDateString();
}

function StatusPill({ status }: { status: Goal["status"] }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
        statusTone(status),
      )}
    >
      {status}
    </span>
  );
}

function BudgetProgress({ goal }: { goal: Goal }) {
  const percent =
    goal.tokenBudget && goal.tokenBudget > 0
      ? Math.min(100, Math.round((goal.usage.tokensUsed / goal.tokenBudget) * 100))
      : null;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{goal.usage.tokensUsed.toLocaleString()} tokens used</span>
        <span>
          {goal.tokenBudget === null
            ? "No budget"
            : `${goal.tokenBudget.toLocaleString()} token budget`}
        </span>
      </div>
      <div
        className="h-1.5 w-full overflow-hidden rounded bg-muted"
        role={percent === null ? undefined : "progressbar"}
        aria-valuemin={percent === null ? undefined : 0}
        aria-valuemax={percent === null ? undefined : 100}
        aria-valuenow={percent ?? undefined}
      >
        {percent !== null ? (
          <div
            className={cn(
              "h-full",
              percent > 90
                ? "bg-orange-500"
                : percent > 70
                  ? "bg-amber-500"
                  : "bg-green-500",
            )}
            style={{ width: `${percent}%` }}
          />
        ) : null}
      </div>
    </div>
  );
}

function HistoryList({ entries }: { entries: HistoryEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No goal history yet.</p>;
  }
  return (
    <ul className="space-y-1">
      {entries.map((entry, index) => (
        <li
          key={`${entry.at}-${entry.kind}-${index}`}
          className="rounded border border-border/60 px-2 py-1.5 text-xs"
        >
          <div className="flex items-center gap-2">
            <span className="font-medium uppercase">{entry.kind}</span>
            {entry.status ? <StatusPill status={entry.status} /> : null}
            <span className="ml-auto text-muted-foreground">
              {relativeTime(entry.at)}
            </span>
          </div>
          {entry.objective ? (
            <p className="mt-1 line-clamp-2">{entry.objective}</p>
          ) : null}
          {entry.tokensUsed !== undefined ? (
            <p className="mt-1 font-mono text-muted-foreground">
              {entry.tokensUsed.toLocaleString()} tokens · {entry.activeSeconds ?? 0}s
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function SettingsGoals() {
  const rpc = useRpc<typeof rpcContract>();
  const connectionState = useRealtimeConnectionState();
  const [data, setData] = useState<{
    bridgeAvailable: boolean;
    snapshots: Array<{
      sessionId: string;
      threadId: string;
      goal: Goal | null;
      historyCount: number;
      ts: string;
    }>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connectedOnce = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setData(await rpc.call("allSnapshots"));
      setError(null);
    } catch (refreshError) {
      setError(String(refreshError));
    }
  }, [rpc]);

  useRealtime("codex-goal/snapshot", () => void refresh());
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2_000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (connectionState === "connected") {
      if (connectedOnce.current) void refresh();
      connectedOnce.current = true;
    }
  }, [connectionState, refresh]);

  if (error) {
    return <p className="text-sm text-destructive">{error}</p>;
  }
  if (!data) return <p className="text-sm text-muted-foreground">Loading goals…</p>;
  if (!data.bridgeAvailable) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Codex events bridge not installed</CardTitle>
          <CardDescription>
            Install and enable bb-plugin-codex-events-bridge. Codex Goal will
            resume automatically when its chokepoint RPC becomes available.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (data.snapshots.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No Codex goals yet</CardTitle>
          <CardDescription>
            Start a Codex goal with <code className="font-mono">/goal</code> in a
            Codex-backed thread.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {data.snapshots.map((snapshot) => (
        <Card key={snapshot.sessionId}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {snapshot.goal ? <StatusPill status={snapshot.goal.status} /> : null}
              <span>{snapshot.goal?.objective ?? "Goal cleared"}</span>
            </CardTitle>
            <CardDescription>
              <span className="font-mono">{snapshot.sessionId}</span> · thread{" "}
              <span className="font-mono">{snapshot.threadId}</span> · updated{" "}
              {relativeTime(snapshot.ts)}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {snapshot.goal ? <BudgetProgress goal={snapshot.goal} /> : null}
            <p className="text-xs text-muted-foreground">
              {snapshot.historyCount} history entries
            </p>
          </CardContent>
        </Card>
      ))}
      <div className="text-center">
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>
    </div>
  );
}

function GoalHeaderAction({
  threadId,
  isCompactViewport,
}: {
  threadId: string;
  isCompactViewport: boolean;
}) {
  const navigate = useBbNavigate();
  const { data } = useCodexGoal(threadId);
  const goal = data?.snapshot?.goal;
  if (!goal || goal.status !== "active") return null;
  const percent =
    goal.tokenBudget && goal.tokenBudget > 0
      ? Math.round((goal.usage.tokensUsed / goal.tokenBudget) * 100)
      : null;
  return (
    <button
      type="button"
      aria-label={`Active goal: ${goal.objective}`}
      title={goal.objective}
      onClick={() => {
        navigate.openThreadPanel({
          actionId: "codex-goal-overview",
          title: "Codex Goal",
        });
      }}
      className={cn(
        "flex items-center justify-center rounded border border-border/60 text-[10px] uppercase tracking-wide transition-colors hover:bg-muted/60",
        isCompactViewport ? "size-7" : "gap-1.5 px-1.5 py-0.5",
        statusTone(goal.status),
      )}
    >
      <span aria-hidden="true">◎</span>
      {!isCompactViewport ? <span>{goal.status}</span> : null}
      {!isCompactViewport && percent !== null ? <span>{percent}%</span> : null}
    </button>
  );
}

function GoalThreadPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const { data, error, isLoading, refresh } = useCodexGoal(threadId);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [clearing, setClearing] = useState(false);
  const providerSessionId = data?.providerSessionId ?? null;

  const refreshHistory = useCallback(async () => {
    if (!providerSessionId) {
      setHistory([]);
      return;
    }
    const result = await rpc.call("history", {
      parentSessionId: providerSessionId,
      limit: 25,
    });
    setHistory(result.entries);
  }, [providerSessionId, rpc]);

  useRealtime("codex-goal/snapshot", () => void refreshHistory());
  useEffect(() => {
    void refreshHistory();
    const timer = setInterval(() => void refreshHistory(), 2_500);
    return () => clearInterval(timer);
  }, [refreshHistory]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (isLoading && !data) {
    return <p className="text-sm text-muted-foreground">Loading goal…</p>;
  }
  if (!data?.bridgeAvailable) {
    return (
      <p className="text-sm text-muted-foreground">
        Codex events bridge not installed or unavailable.
      </p>
    );
  }

  const goal = data.snapshot?.goal ?? null;
  return (
    <div className="space-y-4">
      {goal ? (
        <>
          <div className="flex items-center gap-2">
            <StatusPill status={goal.status} />
            <span className="font-mono text-xs text-muted-foreground">
              {goal.goalId}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-sm">{goal.objective}</p>
          <BudgetProgress goal={goal} />
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <p className="text-muted-foreground">Tokens used</p>
              <p className="font-mono">{goal.usage.tokensUsed.toLocaleString()}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Time used</p>
              <p className="font-mono">{goal.usage.activeSeconds}s</p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={clearing}
            onClick={async () => {
              setClearing(true);
              try {
                await rpc.call("clearGoal", { threadId });
                await refresh();
              } finally {
                setClearing(false);
              }
            }}
          >
            {clearing ? "Clearing…" : "Clear goal"}
          </Button>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          No active goal for this Codex thread. Use{" "}
          <code className="font-mono">/goal</code> in the composer to start one.
        </p>
      )}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">History</h3>
        <HistoryList entries={history} />
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "codex-goal",
    title: "Codex Goals",
    description:
      "All native Codex goals observed across bb threads, with status and token usage.",
    component: SettingsGoals,
  });

  app.slots.experimental_threadHeaderAction({
    id: "codex-goal-header",
    title: "Active Codex goal",
    component: GoalHeaderAction,
  });

  app.slots.threadPanelAction({
    id: "codex-goal-overview",
    title: "Codex Goal",
    icon: "Target",
    component: GoalThreadPanel,
  });
});
