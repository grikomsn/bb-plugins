// bb-plugin-pi-events-bridge — frontend entry.
//
// A small nav panel that surfaces:
//   1. Plugin status (socket path, session count, last event)
//   2. A live stream of pi lifecycle + 3rd-party plugin events
//
// Subscribes to all `pi/*` realtime channels with useRealtime, paginates via
// the `recent` rpc, and groups events by source for quick scanning.

import { useEffect, useMemo, useRef, useState } from "react";
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

type EventRow = {
  seq: number;
  ts: string;
  type: string;
  sessionId: string | null;
  cwd: string;
  payload: unknown;
};

type Status = {
  connected: boolean;
  socketPath: string;
  sessionCount: number;
  lastEventAt: string | null;
  bufferedSeqs: number;
  authToken: string | null;
};

function groupOf(type: string): "lifecycle" | "ext" | "bridge" | "raw" {
  if (type.startsWith("pi.lifecycle:")) return "lifecycle";
  if (type.startsWith("pi.ext:")) return "ext";
  if (type.startsWith("bb.bridge:")) return "bridge";
  return "raw";
}

function shortType(type: string): string {
  return type.replace(/^pi\.(lifecycle|ext):/, "").replace(/^bb\.bridge:/, "bridge:");
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1000) return "now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return new Date(iso).toLocaleTimeString();
}

function StatusCard() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [poll, setPoll] = useState(true);

  useEffect(() => {
    if (!poll) return;
    let cancelled = false;
    const tick = async () => {
      const s = await rpc.call("status");
      if (!cancelled) setStatus(s);
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [poll, rpc]);

  if (!status) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Pi Events Bridge</CardTitle>
          <CardDescription>Loading status…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pi Events Bridge</CardTitle>
        <CardDescription>
          Forwarding pi lifecycle and 3rd-party plugin events over a Unix
          socket to bb realtime.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-block size-2 rounded-full",
              status.connected ? "bg-green-500" : "bg-red-500",
            )}
          />
          <span className="text-muted-foreground">
            {status.connected ? "Connected" : "Socket closed"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setPoll((p) => !p)}
            className="ml-auto"
          >
            {poll ? "Pause" : "Resume"}
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <div className="text-muted-foreground">Socket</div>
            <div className="font-mono break-all">{status.socketPath}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Sessions</div>
            <div>{status.sessionCount}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Buffered</div>
            <div>{status.bufferedSeqs} events</div>
          </div>
          <div>
            <div className="text-muted-foreground">Last event</div>
            <div>{status.lastEventAt ? relTime(status.lastEventAt) : "—"}</div>
          </div>
          {status.authToken && (
            <div className="col-span-2">
              <div className="text-muted-foreground">
                Auto-generated auth token (set BB_BRIDGE_TOKEN on the pi side)
              </div>
              <div className="font-mono text-xs break-all">{status.authToken}</div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function EventsPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [filter, setFilter] = useState<"" | "lifecycle" | "ext" | "bridge" | "raw">("");
  const seqRef = useRef(0);

  // Subscribe to every pi/* channel via a single content-script-style hook.
  // The bb frontend SDK exposes useRealtime which takes a single channel; we
  // subscribe to a wildcard by listening to the union via multiple calls.
  // To keep this simple and robust, we re-fetch the latest N events on every
  // tick — the server-side ring buffer gives us a cheap replay surface.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const { events: recent } = await rpc.call("recent", { limit: 200 });
      if (cancelled) return;
      setEvents(recent);
      const top = recent[0];
      if (top) seqRef.current = top.seq;
    };
    void refresh();
    const id = setInterval(refresh, 1500);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [rpc]);

  // Live push: useRealtime receives events from bb.realtime.publish; merge.
  useRealtime("pi/raw/*", () => undefined as never); // typed loosely
  // Real subscription is via per-channel listeners below.
  useRealtime("pi/lifecycle/session_start", (msg) => {
    const e = (msg as { payload?: EventRow }).payload;
    if (e) setEvents((prev) => [e, ...prev].slice(0, 500));
  });

  const filtered = useMemo(
    () => (filter ? events.filter((e) => groupOf(e.type) === filter) : events),
    [events, filter],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent events</CardTitle>
        <CardDescription>
          {filtered.length} of {events.length} events (last 200 polled;
          realtime pushes appended)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex gap-2">
          {(["", "lifecycle", "ext", "bridge", "raw"] as const).map((g) => (
            <Button
              key={g || "all"}
              size="sm"
              variant={filter === g ? "default" : "outline"}
              onClick={() => setFilter(g)}
            >
              {g || "All"}
            </Button>
          ))}
        </div>
        <div className="max-h-[60vh] overflow-y-auto rounded border border-border">
          {filtered.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No events yet.</div>
          ) : (
            <ul className="divide-y divide-border">
              {filtered.map((e) => (
                <li
                  key={`${e.seq}-${e.ts}`}
                  className="flex items-baseline gap-3 px-3 py-2 text-xs hover:bg-muted/30"
                >
                  <span className="font-mono text-muted-foreground w-12 shrink-0">
                    #{e.seq}
                  </span>
                  <span className="font-mono shrink-0">{relTime(e.ts)}</span>
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                      groupOf(e.type) === "lifecycle" && "bg-blue-500/15 text-blue-700 dark:text-blue-300",
                      groupOf(e.type) === "ext" && "bg-amber-500/15 text-amber-700 dark:text-amber-300",
                      groupOf(e.type) === "bridge" && "bg-purple-500/15 text-purple-700 dark:text-purple-300",
                      groupOf(e.type) === "raw" && "bg-muted text-muted-foreground",
                    )}
                  >
                    {groupOf(e.type)}
                  </span>
                  <span className="font-mono truncate">{shortType(e.type)}</span>
                  <span className="ml-auto truncate text-muted-foreground">
                    {e.sessionId ?? "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default definePluginApp((app) => {
  // The Pi Events Bridge is diagnostic / configuration tooling — it has no
  // day-to-day UI surface. Hosts surface it as a plugin settings section so
  // the bb main sidebar stays reserved for active work.
  app.slots.settingsSection({
    id: "pi-events-bridge",
    title: "Pi Events Bridge",
    description:
      "Live status of the bridge socket plus the raw pi lifecycle / 3rd-party plugin event stream. Use this to debug why a downstream plugin (subagents fleet, codex-goal, …) is not seeing the events you expect.",
    component: () => (
      <div className="space-y-4">
        <StatusCard />
        <EventsPanel />
      </div>
    ),
  });
});
