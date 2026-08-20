// bb-plugin-pi-subagents-fleet — frontend entry.
//
// A nav panel listing every active @tintinweb/pi-subagents sub-agent with
// live status, model, elapsed time, and prompt preview. Clicking a card opens
// the sub-agent's conversation in a side panel via threadPanelAction.
//
// Subscribes to:
//   * pi/subagents-fleet/snapshot — published by server.ts after every state change
//   * pi/lifecycle/* and pi/ext/subagents/* via useRealtime (raw events for debugging)
//
// Reads fleet state via useRpc<typeof rpcContract>().fleet({statusFilter: "active"}).

import { useEffect, useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRpc,
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

type SubagentSummary = {
  id: string;
  parentSessionId: string | null;
  type: string;
  promptPreview: string;
  model: string | null;
  runInBackground: boolean;
  status: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failureReason: string | null;
  steerCount: number;
  elapsedMs: number | null;
};

type FleetResult = {
  source: string;
  active: boolean;
  lastPollAt: string | null;
  subagents: SubagentSummary[];
};

function statusTone(status: string): string {
  switch (status) {
    case "running":
      return "bg-green-500/15 text-green-700 dark:text-green-300";
    case "starting":
      return "bg-blue-500/15 text-blue-700 dark:text-blue-300";
    case "steered":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
    case "completed":
      return "bg-muted text-muted-foreground";
    case "failed":
      return "bg-red-500/15 text-red-700 dark:text-red-300";
    case "compacted":
      return "bg-purple-500/15 text-purple-700 dark:text-purple-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function fmtElapsed(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.round(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60_000)}m`;
}

function FleetHeader({
  result,
  onSteer,
  onStop,
}: {
  result: FleetResult;
  onSteer: (id: string) => void;
  onStop: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Subagents</CardTitle>
        <CardDescription>
          {result.subagents.length} active sub-agent
          {result.subagents.length === 1 ? "" : "s"} • last poll{" "}
          {result.lastPollAt ? new Date(result.lastPollAt).toLocaleTimeString() : "never"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {result.subagents.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No active sub-agents. The{" "}
            <span className="font-mono">@tintinweb/pi-subagents</span> extension emits
            <code className="ml-1 font-mono">subagents:*</code> events to{" "}
            <span className="font-mono">pi-bb-bridge</span> which forward over the bridge
            socket to bb.
          </div>
        ) : (
          <ul className="space-y-2">
            {result.subagents.map((s) => (
              <li
                key={s.id}
                className="flex flex-col gap-2 rounded border border-border p-3 hover:bg-muted/30"
              >
                <div className="flex items-baseline gap-2">
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                      statusTone(s.status),
                    )}
                  >
                    {s.status}
                  </span>
                  <span className="font-mono text-xs">{s.type}</span>
                  {s.runInBackground && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      bg
                    </span>
                  )}
                  {s.model && (
                    <span className="font-mono text-xs text-muted-foreground">
                      {s.model}
                    </span>
                  )}
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    {fmtElapsed(s.elapsedMs)}
                  </span>
                </div>
                <div className="text-sm">{s.promptPreview || <em>(no prompt)</em>}</div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{s.id}</span>
                  <span>•</span>
                  <span>steers: {s.steerCount}</span>
                  {s.failureReason && (
                    <>
                      <span>•</span>
                      <span className="text-red-600 dark:text-red-400">
                        {s.failureReason}
                      </span>
                    </>
                  )}
                  <div className="ml-auto flex gap-1">
                    {s.status === "running" || s.status === "steered" ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onSteer(s.id)}
                        >
                          Steer
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onStop(s.id)}
                        >
                          Stop
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Fleet() {
  const rpc = useRpc<typeof rpcContract>();
  const [result, setResult] = useState<FleetResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Subscribe to the snapshot channel so we update without polling.
  useRealtime("pi/subagents-fleet/snapshot", () => {
    void refresh();
  });

  async function refresh(): Promise<void> {
    try {
      const r = await rpc.call("fleet", { statusFilter: "active" });
      setResult(r);
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

  async function onSteer(id: string): Promise<void> {
    const message = window.prompt(`Steer sub-agent ${id} with message:`);
    if (!message) return;
    await rpc.call("steer", { id, message });
  }

  async function onStop(id: string): Promise<void> {
    if (!window.confirm(`Stop sub-agent ${id}?`)) return;
    await rpc.call("stop", { id });
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Fleet unavailable</CardTitle>
          <CardDescription>{error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Subagents</CardTitle>
          <CardDescription>Loading…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <FleetHeader
      result={result}
      onSteer={(id) => void onSteer(id)}
      onStop={(id) => void onStop(id)}
    />
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "pi-subagents-fleet",
    title: "Subagents",
    icon: "Users",
    path: "subagents",
    component: () => (
      <div className="space-y-4 p-4 md:p-5">
        <div className="mx-auto w-full max-w-3xl space-y-4">
          <Fleet />
        </div>
      </div>
    ),
  });

  // ThreadHeader: compact pill showing the number of active sub-agents for
  // the CURRENT thread. Clicking opens the right-panel "Subagents" tab.
  app.slots.experimental_threadHeaderAction({
    id: "subagents-header",
    title: "Subagents",
    component: () => {
      const { threadId } = useBbContext();
      const navigate = useBbNavigate();
      const rpc = useRpc<typeof rpcContract>();
      const [result, setResult] = useState<{
        providerSessionId: string | null;
        subagents: SubagentSummary[];
      } | null>(null);
      useRealtime("pi/subagents-fleet/snapshot", () => {
        void refresh();
      });
      async function refresh(): Promise<void> {
        if (!threadId) return;
        try {
          const r = await rpc.call("currentThreadFleet", { threadId });
          setResult({
            providerSessionId: r.providerSessionId,
            subagents: r.subagents,
          });
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
      const active = result?.subagents ?? [];
      const tone = active.length > 0 ? "bg-blue-500/15 text-blue-700 dark:text-blue-300" : "bg-muted text-muted-foreground";
      return (
        <button
          type="button"
          onClick={() => {
            const ok = navigate.openThreadPanel({
              actionId: "subagents-overview",
              title: "Subagents",
            });
            if (!ok) navigate.toPluginPanel("subagents");
          }}
          className={cn(
            "flex items-center gap-1.5 rounded border border-border/60 bg-background/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wide transition-colors hover:bg-muted/60",
            tone,
          )}
          title={`${active.length} active sub-agent${active.length === 1 ? "" : "s"} for this thread`}
        >
          <span aria-hidden="true">⚡</span>
          <span>{active.length} active</span>
        </button>
      );
    },
  });

  // ThreadPanelAction: full sub-agent breakdown for the current thread.
  app.slots.threadPanelAction({
    id: "subagents-overview",
    title: "Subagents",
    icon: "Users",
    component: ({ threadId }: { threadId: string }) => {
      const rpc = useRpc<typeof rpcContract>();
      const [result, setResult] = useState<{
        providerSessionId: string | null;
        subagents: SubagentSummary[];
      } | null>(null);
      const [error, setError] = useState<string | null>(null);

      useRealtime("pi/subagents-fleet/snapshot", () => {
        void refresh();
      });

      async function refresh(): Promise<void> {
        try {
          const r = await rpc.call("currentThreadFleet", { threadId });
          setResult({
            providerSessionId: r.providerSessionId,
            subagents: r.subagents,
          });
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

      async function onSteer(id: string): Promise<void> {
        const message = window.prompt(`Steer sub-agent ${id} with message:`);
        if (!message) return;
        await rpc.call("steer", { id, message });
      }

      async function onStop(id: string): Promise<void> {
        if (!window.confirm(`Stop sub-agent ${id}?`)) return;
        await rpc.call("stop", { id });
      }

      if (error) {
        return (
          <div className="space-y-3 p-3">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        );
      }

      const subs = result?.subagents ?? [];

      return (
        <div className="space-y-3 p-3">
          {!result?.providerSessionId ? (
            <p className="text-sm text-muted-foreground">
              No pi session is currently bound to this thread. Spawn a
              sub-agent with the Agent tool to populate this panel.
            </p>
          ) : subs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No active sub-agents for this thread.
            </p>
          ) : (
            <ul className="space-y-2">
              {subs.map((s) => (
                <li
                  key={s.id}
                  className="rounded border border-border p-2"
                >
                  <div className="flex items-baseline gap-2">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                        statusTone(s.status),
                      )}
                    >
                      {s.status}
                    </span>
                    <span className="font-mono text-xs">{s.type}</span>
                    <span className="ml-auto font-mono text-xs text-muted-foreground">
                      {fmtElapsed(s.elapsedMs)}
                    </span>
                  </div>
                  <div className="mt-1 text-xs">
                    {s.promptPreview || <em>(no prompt)</em>}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="font-mono">{s.id}</span>
                    <span>•</span>
                    <span>steers: {s.steerCount}</span>
                    <div className="ml-auto flex gap-1">
                      {s.status === "running" || s.status === "steered" ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void onSteer(s.id)}
                          >
                            Steer
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void onStop(s.id)}
                          >
                            Stop
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
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
