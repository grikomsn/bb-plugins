// bb-plugin-mcp-mediator — frontend entry.
//
// Two surfaces:
//   1. Nav panel listing MCP server status + pending approval requests.
//   2. A thread-header action that pops an approval card into the right
//      side panel of the current thread.

import { useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
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

type ServerRow = {
  name: string;
  url: string;
  status: string;
  toolCount: number;
  resourceCount: number;
  lastSeenAt: string;
  error: string | null;
};

type PendingApproval = {
  approvalId: string;
  serverName: string;
  toolName: string;
  argsPreview: string;
  receivedAt: string;
  decidedAt: string | null;
  decision: string | null;
};

function statusTone(status: string): string {
  switch (status) {
    case "connected":
      return "bg-green-500/15 text-green-700 dark:text-green-300";
    case "connecting":
      return "bg-blue-500/15 text-blue-700 dark:text-blue-300";
    case "disconnected":
      return "bg-muted text-muted-foreground";
    case "error":
      return "bg-red-500/15 text-red-700 dark:text-red-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function ServersPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<{
    source: string;
    lastSnapshotAt: string | null;
    servers: ServerRow[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useRealtime("pi/mcp-mediator/status", () => {
    void refresh();
  });

  async function refresh(): Promise<void> {
    try {
      const r = await rpc.call("servers");
      setData(r);
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
          <CardTitle>MCP mediator unavailable</CardTitle>
          <CardDescription>{error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>MCP Servers</CardTitle>
          <CardDescription>Loading…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>MCP Servers</CardTitle>
        <CardDescription>
          {data.servers.length} server{data.servers.length === 1 ? "" : "s"}{" "}
          • last snapshot{" "}
          {data.lastSnapshotAt
            ? new Date(data.lastSnapshotAt).toLocaleTimeString()
            : "never"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {data.servers.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No MCP servers connected. Configure them with{" "}
            <code className="font-mono">/mcp</code> in pi.
          </div>
        ) : (
          <ul className="space-y-2">
            {data.servers.map((s) => (
              <li
                key={s.name}
                className="flex items-baseline gap-2 rounded border border-border p-3 hover:bg-muted/30"
              >
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                    statusTone(s.status),
                  )}
                >
                  {s.status}
                </span>
                <span className="font-mono text-sm">{s.name}</span>
                <span className="ml-auto font-mono text-xs text-muted-foreground">
                  {s.toolCount} tools / {s.resourceCount} resources
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ApprovalsPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [error, setError] = useState<string | null>(null);

  useRealtime("pi/mcp-mediator/approval-request", () => {
    void refresh();
  });
  useRealtime("pi/mcp-mediator/approval-decided", () => {
    void refresh();
  });

  async function refresh(): Promise<void> {
    try {
      const r = await rpc.call("pendingApprovals");
      setPending(r.pending);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  async function decide(
    approvalId: string,
    decision: "allow" | "deny" | "always",
  ): Promise<void> {
    await rpc.call("decide", { approvalId, decision });
    void refresh();
  }

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 1500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pending MCP approvals</CardTitle>
        <CardDescription>
          {pending.length === 0
            ? "Nothing waiting on you."
            : `${pending.length} request${pending.length === 1 ? "" : "s"} waiting`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && (
          <div className="rounded border border-destructive/40 p-2 text-sm text-destructive">
            {error}
          </div>
        )}
        {pending.length === 0 ? null : (
          <ul className="space-y-2">
            {pending.map((p) => (
              <li
                key={p.approvalId}
                className="rounded border border-border p-3"
              >
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    {p.serverName}
                  </span>
                  <span className="font-mono">{p.toolName}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {new Date(p.receivedAt).toLocaleTimeString()}
                  </span>
                </div>
                {p.argsPreview && (
                  <pre className="mt-1 max-h-32 overflow-y-auto rounded bg-muted/50 p-2 font-mono text-xs">
                    {p.argsPreview}
                  </pre>
                )}
                {p.decidedAt ? (
                  <div className="mt-2 text-xs text-muted-foreground">
                    Decided: <span className="font-mono">{p.decision}</span> at{" "}
                    {new Date(p.decidedAt).toLocaleTimeString()}
                  </div>
                ) : (
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => void decide(p.approvalId, "allow")}
                    >
                      Allow
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void decide(p.approvalId, "always")}
                    >
                      Always
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void decide(p.approvalId, "deny")}
                    >
                      Deny
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "pi-mcp-mediator",
    title: "MCP Mediator",
    icon: "ShieldCheck",
    path: "mcp",
    component: () => (
      <div className="space-y-4 p-4 md:p-5">
        <div className="mx-auto w-full max-w-3xl space-y-4">
          <ServersPanel />
          <ApprovalsPanel />
        </div>
      </div>
    ),
  });
});
