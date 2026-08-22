// bb-plugin-pi-codex-goal — frontend entry.
//
// Renders the active pi-codex-goal state in three places:
//
//   1. Nav panel — current goal, history (newest first), all-session list.
//   2. Thread header action — a compact "goal" badge showing the active
//      objective (or "no goal" when cleared).
//   3. Composer banner — same content, shown above the new-thread composer.
//
// Subscribes to:
//   * `pi/codex-goal/snapshot` — published by server.ts after every change
//   * `pi/ext/codex-goal/state` — raw bridge envelopes for debugging
//   * `pi/ext/codex-goal/entry` — raw bridge envelopes for debugging

import { useEffect, useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

type Goal = {
  goalId: string;
  objective: string;
  status: string;
  tokenBudget: number | null;
  usage: { tokensUsed: number; activeSeconds: number };
  createdAt: number;
  updatedAt: number;
};

type Snapshot = {
  goal: Goal | null;
  historyCount: number;
  objectivePreview: string | null;
  ts: string;
  source: string;
};

type SnapshotResult = {
  source: string;
  snapshot: Snapshot | null;
  sessionId: string | null;
  sessionIds: string[];
};

type HistoryEntry = {
  kind: string;
  at: number;
  source?: string;
  goalId?: string | null;
  objective?: string;
  status?: string;
  tokensUsed?: number;
  activeSeconds?: number;
};

type HistoryResult = {
  source: string;
  entries: HistoryEntry[];
};

type AllSnapshots = {
  snapshots: Array<{
    sessionId: string;
    goal: Goal | null;
    historyCount: number;
    ts: string;
  }>;
};

function statusTone(status: string): string {
  switch (status) {
    case "active":
      return "bg-green-500/15 text-green-700 dark:text-green-300";
    case "paused":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
    case "budgetLimited":
      return "bg-orange-500/15 text-orange-700 dark:text-orange-300";
    case "complete":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function fmtRelative(iso: string | number): string {
  const ms = Date.now() - (typeof iso === "number" ? iso : new Date(iso).getTime());
  if (ms < 1000) return "now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function GoalHeader({ snapshot }: { snapshot: Snapshot | null }) {
  if (!snapshot) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No goal yet</CardTitle>
          <CardDescription>
            pi-codex-goal has not emitted any state. Set a goal with
            <code className="ml-1 font-mono">/goal</code> in pi.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (!snapshot.goal) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>No active goal</CardTitle>
          <CardDescription>
            {snapshot.historyCount === 0
              ? "pi-codex-goal hasn't recorded any entries yet."
              : `${snapshot.historyCount} prior goal(s) — current state is cleared.`}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const g = snapshot.goal;
  const tokenBudgetPct =
    g.tokenBudget && g.tokenBudget > 0
      ? Math.min(100, Math.round((g.usage.tokensUsed / g.tokenBudget) * 100))
      : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
              statusTone(g.status),
            )}
          >
            {g.status}
          </span>
          <span>Active goal</span>
        </CardTitle>
        <CardDescription>
          <span className="font-mono">{g.goalId}</span>{" "}
          • updated {fmtRelative(snapshot.ts)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">{g.objective}</p>
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div>
            <div className="text-muted-foreground">Tokens used</div>
            <div className="font-mono">{g.usage.tokensUsed.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Active time</div>
            <div className="font-mono">{Math.round(g.usage.activeSeconds)}s</div>
          </div>
          <div>
            <div className="text-muted-foreground">Budget</div>
            <div className="font-mono">
              {g.tokenBudget ? `${tokenBudgetPct}% of ${g.tokenBudget.toLocaleString()}` : "—"}
            </div>
          </div>
        </div>
        {tokenBudgetPct !== null && (
          <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
            <div
              className={cn(
                "h-full",
                tokenBudgetPct > 90
                  ? "bg-red-500"
                  : tokenBudgetPct > 70
                    ? "bg-amber-500"
                    : "bg-green-500",
              )}
              style={{ width: `${tokenBudgetPct}%` }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HistoryList({
  history,
  limit = 25,
}: {
  history: HistoryEntry[];
  limit?: number;
}) {
  if (history.length === 0) {
    return (
      <div className="rounded border border-border p-3 text-sm text-muted-foreground">
        No history yet.
      </div>
    );
  }
  return (
    <ul className="space-y-1">
      {history.slice(0, limit).map((e, i) => (
        <li
          key={`${e.at}-${i}`}
          className="flex items-baseline gap-3 rounded px-2 py-1.5 text-xs hover:bg-muted/30"
        >
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
              e.kind === "set" &&
                "bg-green-500/15 text-green-700 dark:text-green-300",
              e.kind === "usage" &&
                "bg-blue-500/15 text-blue-700 dark:text-blue-300",
              e.kind === "clear" &&
                "bg-red-500/15 text-red-700 dark:text-red-300",
            )}
          >
            {e.kind}
          </span>
          <span className="font-mono text-muted-foreground">
            {fmtRelative(e.at)}
          </span>
          {e.objective && (
            <span className="truncate">{e.objective.slice(0, 120)}</span>
          )}
          {e.tokensUsed !== undefined && (
            <span className="ml-auto font-mono text-muted-foreground">
              {e.tokensUsed.toLocaleString()} tok
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function GoalPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [result, setResult] = useState<SnapshotResult | null>(null);
  const [history, setHistory] = useState<HistoryResult | null>(null);
  const [allSess, setAllSess] = useState<AllSnapshots | null>(null);
  const [error, setError] = useState<string | null>(null);

  useRealtime("pi/codex-goal/snapshot", () => {
    void refresh();
  });

  async function refresh(): Promise<void> {
    try {
      const [snap, hist, all] = await Promise.all([
        rpc.call("snapshot", {}),
        rpc.call("history", { limit: 100 }),
        rpc.call("allSnapshots"),
      ]);
      setResult(snap);
      setHistory(hist);
      setAllSess(all);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Goal unavailable</CardTitle>
          <CardDescription>{error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>pi-codex-goal</CardTitle>
          <CardDescription>Loading…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <GoalHeader snapshot={result.snapshot} />
      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
          <CardDescription>
            Newest first • {history?.entries.length ?? 0} entries tracked
          </CardDescription>
        </CardHeader>
        <CardContent>
          <HistoryList history={history?.entries ?? []} />
        </CardContent>
      </Card>
      {allSess && allSess.snapshots.length > 1 && (
        <Card>
          <CardHeader>
            <CardTitle>All sessions</CardTitle>
            <CardDescription>
              {allSess.snapshots.length} pi session(s) reporting goal state
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-1 text-xs">
              {allSess.snapshots.map((s) => (
                <li
                  key={s.sessionId}
                  className="flex items-center gap-2 font-mono"
                >
                  <span>{s.sessionId}</span>
                  <span className="text-muted-foreground">•</span>
                  <span>
                    {s.goal ? (
                      <>
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                            statusTone(s.goal.status),
                          )}
                        >
                          {s.goal.status}
                        </span>{" "}
                        {s.goal.objective.slice(0, 80)}
                      </>
                    ) : (
                      <span className="text-muted-foreground">cleared</span>
                    )}
                  </span>
                  <span className="ml-auto text-muted-foreground">
                    {s.historyCount} entries
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <div className="text-center">
        <Button size="sm" variant="ghost" onClick={() => void refresh()}>
          Refresh
        </Button>
      </div>
      <GoalDiagnostics />
    </div>
  );
}

/**
 * Small read-only summary of the effective plugin settings. The host renders
 * the edit form for these descriptors in the bb Settings page; this panel
 * exists so you can verify what's actually in effect without leaving the
 * goal view.
 */
function GoalDiagnostics() {
  const settings = useSettings();
  const alwaysShowBanner = settings.values?.alwaysShowBanner;
  const emitOnClear = settings.values?.emitOnClear;
  function fmt(v: unknown): string {
    if (typeof v === "boolean") return v ? "on" : "off";
    if (typeof v === "string" && v.length > 0) return v;
    return "default";
  }
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded border border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
      <span>
        Polling every <span className="font-mono">2000ms</span>
      </span>
      <span>
        alwaysShowBanner:{" "}
        <span className="font-mono">{fmt(alwaysShowBanner)}</span>
      </span>
      <span>
        emitOnClear: <span className="font-mono">{fmt(emitOnClear)}</span>
      </span>
      {settings.isLoading ? <span>• loading settings…</span> : null}
    </div>
  );
}

function BudgetBar({ goal }: { goal: Goal }) {
  if (!goal.tokenBudget || goal.tokenBudget <= 0) {
    return (
      <div className="h-1.5 w-full overflow-hidden rounded bg-muted" />
    );
  }
  const pct = Math.min(100, Math.round((goal.usage.tokensUsed / goal.tokenBudget) * 100));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-muted">
      <div
        className={cn(
          "h-full",
          pct > 90
            ? "bg-red-500"
          : pct > 70
            ? "bg-amber-500"
            : "bg-green-500",
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export default definePluginApp((app) => {
  // The goal panel is moved out of the main sidebar (it's a diagnostic /
  // inspection surface, not day-to-day UI) and into the plugin's settings
  // page. The per-thread header pill + right-side thread panel action still
  // give one-click access when a goal is actively running.
  app.slots.settingsSection({
    id: "pi-codex-goal",
    title: "Pi Codex Goal",
    description:
      "Active goal state, history, and all-session overview for the pi-codex-goal extension. Use this to inspect token usage, review the history of goal entries, and verify which pi sessions are reporting goal state.",
    component: () => (
      <div className="space-y-4">
        <GoalPanel />
      </div>
    ),
  });

  // Thread header action: a compact pill in the 48px chrome row that
  // summarises the active goal for the CURRENT thread (resolved via the
  // chokepoint's bb threadId -> providerThreadId map). Clicking opens
  // the right-panel "Goals" tab.
  app.slots.experimental_threadHeaderAction({
    id: "codex-goal-header",
    title: "Active goal",
    component: () => {
      const { threadId } = useBbContext();
      const navigate = useBbNavigate();
      const rpc = useRpc<typeof rpcContract>();
      const [snap, setSnap] = useState<Snapshot | null>(null);
      useRealtime("pi/codex-goal/snapshot", () => {
        void refresh();
      });
      async function refresh(): Promise<void> {
        if (!threadId) return;
        try {
          const r = await rpc.call("currentThreadSnapshot", { threadId });
          setSnap(r.snapshot);
        } catch {
          // ignore
        }
      }
      useEffect(() => {
        void refresh();
        const id = setInterval(refresh, 2000);
        return () => clearInterval(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [threadId]);
      const goal = snap?.goal;
      // Omit the navbar indicator entirely unless a goal is actively running.
      // A paused / complete / budgetLimited goal is still represented by its
      // own panel; we don't need a pill cluttering the header for it.
      if (!goal || goal.status !== "active") return null;
      const tone = statusTone(goal.status);
      return (
        <button
          type="button"
          onClick={() => {
            navigate.openThreadPanel({
              actionId: "codex-goal-overview",
              title: "Goals",
            });
          }}
          className={cn(
            "flex items-center gap-1.5 rounded border border-border/60 bg-background/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide transition-colors hover:bg-muted/60",
            tone,
          )}
          title={goal.objective}
        >
          <span aria-hidden="true">🎯</span>
          <span>{goal.status}</span>
          {goal.tokenBudget ? (
            <span className="text-muted-foreground">
              {Math.round((goal.usage.tokensUsed / goal.tokenBudget) * 100)}%
            </span>
          ) : null}
        </button>
      );
    },
  });

  // Thread right-panel tab: full goal breakdown for the current thread.
  app.slots.threadPanelAction({
    id: "codex-goal-overview",
    title: "Goals",
    icon: "Target",
    component: ({ threadId }: { threadId: string }) => {
      const rpc = useRpc<typeof rpcContract>();
      const [data, setData] = useState<{
        snapshot: Snapshot | null;
        providerSessionId: string | null;
      } | null>(null);
      const [history, setHistory] = useState<HistoryEntry[]>([]);
      const [error, setError] = useState<string | null>(null);

      useRealtime("pi/codex-goal/snapshot", () => {
        void refresh();
      });

      async function refresh(): Promise<void> {
        try {
          const [s, h] = await Promise.all([
            rpc.call("currentThreadSnapshot", { threadId }),
            // History for the bound sessionId, not the thread directly.
            data?.providerSessionId
              ? rpc.call("history", {
                  parentSessionId: data.providerSessionId,
                  limit: 10,
                })
              : Promise.resolve({ source: "pi-events-bridge", entries: [] }),
          ]);
          setData({
            snapshot: s.snapshot,
            providerSessionId: s.providerSessionId,
          });
          setHistory(h.entries);
          setError(null);
        } catch (err) {
          setError(String(err));
        }
      }

      useEffect(() => {
        void refresh();
        const id = setInterval(refresh, 2500);
        return () => clearInterval(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [threadId]);

      if (error) {
        return (
          <div className="space-y-3 p-3">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        );
      }

      const goal = data?.snapshot?.goal ?? null;

      return (
        <div className="space-y-3 p-3">
          {!data?.providerSessionId ? (
            <p className="text-sm text-muted-foreground">
              No pi session is currently bound to this thread. Set a goal with
              <code className="ml-1 font-mono">/goal</code> in pi, then this
              panel will update automatically.
            </p>
          ) : goal ? (
            <>
              <div className="flex items-baseline gap-2">
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                    statusTone(goal.status),
                  )}
                >
                  {goal.status}
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {goal.goalId}
                </span>
              </div>
              <p className="text-sm">{goal.objective}</p>
              <BudgetBar goal={goal} />
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <div className="text-muted-foreground">Tokens used</div>
                  <div className="font-mono">
                    {goal.usage.tokensUsed.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-muted-foreground">Active time</div>
                  <div className="font-mono">
                    {Math.round(goal.usage.activeSeconds)}s
                  </div>
                </div>
              </div>
              <HistoryList history={history} limit={5} />
            </>
          ) : (
            <div>
              <p className="text-sm text-muted-foreground">
                No active goal. Previous history ({history.length} entries):
              </p>
              <HistoryList history={history} limit={5} />
            </div>
          )}
          <div className="text-center">
            <Button size="sm" variant="ghost" onClick={() => void refresh()}>
              Refresh
            </Button>
          </div>
        </div>
      );
    },
  });
});
