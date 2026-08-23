// bb-plugin-codex-raw — frontend entry.
//
// Diagnostic settings section (NO sidebar nav panel by design — pair with
// the docker commit's move of diagnostic surfaces out of the main
// sidebar). Surfaces the 31 `unhandled` codex-app-server notifications
// (plus a static list of the 13 `noise` ones) as a per-thread ring
// buffer with a click-to-expand payload panel.
//
// BB's general preference `showUnhandledProviderEvents` must be true for
// the host to actually persist `provider/unhandled` rows in the first
// place, so we surface a banner if it's false (or can read the
// preference). A chokepoint reachability card tells the user whether
// `bb-plugin-codex-events-bridge` is loaded and reachable, plus how
// many codex threads each side is tracking.

import { useMemo, useState } from "react";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RawEventTable } from "./components/RawEventTable";
import {
  useCodexRawSessions,
  useCodexRawStatus,
} from "./hooks/useCodexRaw";

function StatusCard() {
  const status = useCodexRawStatus();
  if (!status) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Codex Raw</CardTitle>
          <CardDescription>Loading status…</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const showPref = status.showUnhandledProviderEventsRequired
    ? status.showUnhandledProviderEvents === true
      ? "enabled"
      : status.showUnhandledProviderEvents === false
        ? "DISABLED — raw events will not surface"
        : "unknown"
    : "not required";
  const chokepointReachable = status.chokepoint.reachable;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span
            className={
              status.connected
                ? "inline-block size-2 rounded-full bg-green-500"
                : "inline-block size-2 rounded-full bg-red-500"
            }
          />
          <span>Codex Raw</span>
        </CardTitle>
        <CardDescription>
          Polls <code className="font-mono">codex/raw/&lt;rawType&gt;</code> from the
          Codex Events Bridge, ring-buffers each thread's original{" "}
          <code className="font-mono">rawType</code> and JSON-RPC params, and surfaces
          them as a diagnostic table.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {status.showUnhandledProviderEventsRequired && showPref !== "enabled" && (
          <Callout tone="warning">
            <strong>Heads-up:</strong> Settings → General →{" "}
            <code className="font-mono">showUnhandledProviderEvents</code> is currently{" "}
            <em>{showPref}</em>. Without it the host drops{" "}
            <code className="font-mono">provider/unhandled</code> rows before they ever
            reach the events DB, so this table will stay empty even on noisy threads.
          </Callout>
        )}
        <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
          <Stat label="Active codex threads" value={String(status.threadCount)} />
          <Stat
            label="Ring capacity"
            value={`${status.maxRawEventsPerThread}/thread`}
          />
          <Stat label="Poll interval" value={`${status.pollIntervalMs}ms`} />
          <Stat
            label="Discovery interval"
            value={`${status.threadDiscoveryIntervalMs}ms`}
          />
          <Stat label="Buffered raw events" value={String(status.bufferedSeqs)} />
          <Stat label="Poll iteration" value={`#${status.pollIteration}`} />
          <Stat label="Last raw event" value={status.lastEventAt ?? "—"} />
          <Stat label="Hidden threads" value={status.includeHidden ? "included" : "skipped"} />
        </div>
        <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs">
          <strong>Chokepoint:</strong>{" "}
          {chokepointReachable
            ? `bb-plugin-codex-events-bridge is loaded and reports ${status.chokepoint.threadCount ?? "—"} thread(s).`
            : "bb-plugin-codex-events-bridge is not installed or reachable. It is a required dependency, so no new raw events can be ingested."}
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div className="font-mono">{value}</div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "codex-raw",
    title: "Codex Raw",
    description:
      "Diagnostic surface for the 42 noise/unknown codex-app-server notifications the builtin provider-codex host does not normalize. Surfaces the original rawType and JSON-RPC params per thread.",
    component: () => <CodexRawSection />,
  });
});

type ThreadPickerSession = {
  threadId: string;
  providerThreadId: string | null;
  title: string;
  status: string | null;
  rawEventCount: number;
  lastEventAt: string | null;
};

function CodexRawSection(): React.ReactNode {
  const sessions = useCodexRawSessions();
  const [active, setActive] = useState<string | null>(null);
  const orderedSessions = useMemo<ThreadPickerSession[]>(
    () =>
      sessions.map((s) => ({
        threadId: s.threadId,
        providerThreadId: s.providerThreadId,
        title: s.title,
        status: s.status,
        rawEventCount: s.rawEventCount,
        lastEventAt: s.lastEventAt,
      })),
    [sessions],
  );

  const totalRaw = orderedSessions.reduce((acc, s) => acc + s.rawEventCount, 0);

  return (
    <div className="space-y-4">
      <StatusCard />
      <Card>
        <CardHeader>
          <CardTitle>Per-thread raw events</CardTitle>
          <CardDescription>
            {orderedSessions.length === 0
              ? "No codex threads tracked yet."
              : `${orderedSessions.length} thread(s) · ${totalRaw} raw event(s) in the per-thread rings.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {orderedSessions.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant={active === null ? "default" : "outline"}
                onClick={() => setActive(null)}
              >
                All threads
              </Button>
              {orderedSessions.map((s) => (
                <Button
                  key={s.threadId}
                  size="sm"
                  variant={active === s.threadId ? "default" : "outline"}
                  onClick={() => setActive(s.threadId)}
                  title={`${s.threadId} · ${s.title}`}
                >
                  <span className="font-mono">
                    {s.threadId.length > 16 ? `…${s.threadId.slice(-12)}` : s.threadId}
                  </span>
                  <span className="ml-2 text-[10px] text-muted-foreground">
                    {s.rawEventCount}
                  </span>
                </Button>
              ))}
            </div>
          )}
          <RawEventTable threadId={active ?? undefined} refreshKey={active ?? "all"} />
        </CardContent>
      </Card>
    </div>
  );
}

function Callout({
  tone,
  children,
}: {
  tone: "warning" | "info";
  children: React.ReactNode;
}) {
  const cls =
    tone === "warning"
      ? "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-100"
      : "border-blue-500/40 bg-blue-500/10 text-blue-900 dark:text-blue-100";
  return <div className={`rounded-md border px-3 py-2 text-xs ${cls}`}>{children}</div>;
}
