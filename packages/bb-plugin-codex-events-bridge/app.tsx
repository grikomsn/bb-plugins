// bb-plugin-codex-events-bridge — frontend entry.
//
// A settings section (no sidebar, no session panel) that surfaces:
//
//   1. Plugin status — active codex threads, ring capacity, last event ts,
//      poll iteration counter (so a stalled bridge is obvious).
//   2. A live stream of codex events grouped by category, newest first.
//
// The page polls `recent` and `sessions` to populate the table and listens
// on a couple of representative realtime channels (`codex/thread/started`,
// `codex/turn/completed`, `codex/item/agentMessage/delta`) so a fresh row
// shows up the moment it lands.

import { useEffect, useMemo, useState } from "react";
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

type Category = "thread" | "turn" | "item" | "account";

type EventRow = {
  seq: number;
  ts: string;
  type: string;
  category: Category;
  threadId: string;
  providerThreadId: string | null;
  payload: unknown;
};

type Status = {
  connected: boolean;
  pollIntervalMs: number;
  threadDiscoveryIntervalMs: number;
  ringCapacity: number;
  includeHidden: boolean;
  threadCount: number;
  sessionIds: string[];
  lastEventAt: string | null;
  bufferedSeqs: number;
  pollIteration: number;
  trackingCategories: string[];
};

type SessionSummary = {
  threadId: string;
  providerThreadId: string | null;
  title: string;
  status: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastEventType: string | null;
  eventCount: number;
  eventCountByCategory: Record<Category, number>;
};

const DEFAULT_VISIBLE_LIMIT = 200;
const STATUS_POLL_MS = 2_000;
const EVENTS_POLL_MS = 1_500;

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1000) return "now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return new Date(iso).toLocaleTimeString();
}

function shortType(type: string): string {
  return type;
}

function categoryTone(cat: Category): string {
  switch (cat) {
    case "thread":
      return "bg-blue-500/15 text-blue-700 dark:text-blue-300";
    case "turn":
      return "bg-amber-500/15 text-amber-700 dark:text-amber-300";
    case "item":
      return "bg-purple-500/15 text-purple-700 dark:text-purple-300";
    case "account":
      return "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300";
  }
}

function StatusCard() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [watching, setWatching] = useState(true);

  useEffect(() => {
    if (!watching) return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      const s = await rpc.call("status");
      if (!cancelled) setStatus(s);
    };
    void tick();
    const id = setInterval(() => {
      void tick();
    }, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [rpc, watching]);

  if (!status) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Codex Events Bridge</CardTitle>
          <CardDescription>Loading status…</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span
            className={cn(
              "inline-block size-2 rounded-full",
              status.connected ? "bg-green-500" : "bg-red-500",
            )}
          />
          <span>Codex Events Bridge</span>
        </CardTitle>
        <CardDescription>
          Polling every active codex thread's event log, ring-buffering rows,
          and republishing them on <code className="font-mono">codex/&lt;category&gt;/…</code>{" "}
          bb.realtime channels. Downstream consumer plugins (goal, plan,
          context, live, raw) subscribe through this chokepoint.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div>
            <div className="text-muted-foreground">Active codex threads</div>
            <div className="font-mono">{status.threadCount}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Ring capacity</div>
            <div className="font-mono">
              {status.ringCapacity} per (thread × category)
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Poll interval</div>
            <div className="font-mono">{status.pollIntervalMs}ms</div>
          </div>
          <div>
            <div className="text-muted-foreground">Discovery interval</div>
            <div className="font-mono">{status.threadDiscoveryIntervalMs}ms</div>
          </div>
          <div>
            <div className="text-muted-foreground">Buffered events</div>
            <div className="font-mono">{status.bufferedSeqs}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Poll iteration</div>
            <div className="font-mono">#{status.pollIteration}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Last event</div>
            <div>{status.lastEventAt ? relTime(status.lastEventAt) : "—"}</div>
          </div>
          <div>
            <div className="text-muted-foreground">Hidden threads</div>
            <div className="font-mono">
              {status.includeHidden ? "included" : "skipped"}
            </div>
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setWatching((p) => !p)}
          className="ml-auto block"
        >
          {watching ? "Pause status" : "Resume status"}
        </Button>
      </CardContent>
    </Card>
  );
}

function EventsPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [filter, setFilter] = useState<"" | Category>("");

  useEffect(() => {
    let cancelled = false;
    const refresh = async (): Promise<void> => {
      const { events: recent } = await rpc.call("recent", {
        limit: DEFAULT_VISIBLE_LIMIT,
      });
      if (!cancelled) setEvents(recent);
    };
    void refresh();
    const id = setInterval(() => {
      void refresh();
    }, EVENTS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [rpc]);

  // Live push — pick a few representative channels so fresh events scroll in
  // before the next poll tick.
  function bump(payload: unknown): void {
    if (!payload || typeof payload !== "object") return;
    const e = payload as EventRow;
    setEvents((prev) => {
      if (prev.some((p) => p.threadId === e.threadId && p.seq === e.seq && p.type === e.type)) {
        return prev;
      }
      return [e, ...prev].slice(0, DEFAULT_VISIBLE_LIMIT);
    });
  }
  useRealtime("codex/thread/started", (payload) => bump(payload));
  useRealtime("codex/thread/goal/updated", (payload) => bump(payload));
  useRealtime("codex/turn/started", (payload) => bump(payload));
  useRealtime("codex/turn/completed", (payload) => bump(payload));
  useRealtime("codex/item/agentMessage/delta", (payload) => bump(payload));
  useRealtime("codex/item/fileChange/outputDelta", (payload) => bump(payload));
  useRealtime("codex/account/rateLimits/updated", (payload) => bump(payload));

  const filtered = useMemo(
    () => (filter ? events.filter((e) => e.category === filter) : events),
    [events, filter],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent events</CardTitle>
        <CardDescription>
          {filtered.length} of {events.length} events (last {DEFAULT_VISIBLE_LIMIT} polled;
          realtime pushes appended)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex gap-2">
          {(["", "thread", "turn", "item", "account"] as const).map((g) => (
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
            <div className="p-4 text-sm text-muted-foreground">
              Waiting for the first codex event.{" "}
              Spawn or interact with any thread that uses the{" "}
              <code className="font-mono">codex</code> provider.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {filtered.map((e) => (
                <li
                  key={`${e.threadId}-${e.seq}-${e.type}`}
                  className="flex items-baseline gap-3 px-3 py-2 text-xs hover:bg-muted/30"
                >
                  <span className="font-mono text-muted-foreground w-12 shrink-0">
                    #{e.seq}
                  </span>
                  <span className="font-mono shrink-0">{relTime(e.ts)}</span>
                  <span
                    className={cn(
                      "shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                      categoryTone(e.category),
                    )}
                  >
                    {e.category}
                  </span>
                  <span className="font-mono truncate">{shortType(e.type)}</span>
                  <span className="ml-auto truncate text-muted-foreground">
                    {e.providerThreadId ?? e.threadId.slice(-6)}
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

function SessionsPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      const { sessions } = await rpc.call("sessions");
      if (!cancelled) setSessions(sessions);
    };
    void tick();
    const id = setInterval(() => {
      void tick();
    }, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [rpc]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tracked codex threads</CardTitle>
        <CardDescription>
          {sessions.length} thread(s) currently being polled
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sessions.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No codex threads tracked yet. Spawn one with the{" "}
            <code className="font-mono">codex</code> provider and it will show up here within{" "}
            <code className="font-mono">~15s</code> (next discovery tick).
          </div>
        ) : (
          <ul className="space-y-1 text-xs">
            {sessions.map((s) => (
              <li
                key={s.threadId}
                className="flex items-baseline gap-3 rounded border border-border/60 px-2 py-1.5"
              >
                <span className="font-mono">{s.threadId.slice(-12)}</span>
                <span className="truncate">{s.title || "(untitled)"}</span>
                <span className="ml-auto">
                  <span className="font-mono">{s.eventCount}</span>{" "}
                  <span className="text-muted-foreground">events</span>
                </span>
                <span className="text-muted-foreground">•</span>
                <span>
                  th {s.eventCountByCategory.thread} • tn{" "}
                  {s.eventCountByCategory.turn} • it {s.eventCountByCategory.item} • ac{" "}
                  {s.eventCountByCategory.account}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default definePluginApp((app) => {
  // The Codex Events Bridge is a diagnostic / chokepoint surface — it has no
  // day-to-day UI of its own (the consumer plugins render their own panels).
  // Hosts surface it as a plugin settings section, following the docker
  // commit's move of diagnostic surfaces out of the main sidebar.
  app.slots.settingsSection({
    id: "codex-events-bridge",
    title: "Codex Events Bridge",
    description:
      "Live chokepoint for the bb builtin provider-codex event stream. Use this to debug why a downstream codex consumer plugin (goal, plan, context, live, raw) is not seeing the events you expect.",
    component: () => (
      <div className="space-y-4">
        <StatusCard />
        <SessionsPanel />
        <EventsPanel />
      </div>
    ),
  });
});
