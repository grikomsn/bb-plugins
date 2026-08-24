import { useEffect, useMemo, useState } from "react";
import { definePluginApp, useBbContext } from "@get-bb/plugin-sdk/app";
import { LiveConsole } from "@/components/LiveConsole";
import {
  useCodexLiveSnapshot,
  useCodexLiveStatus,
  useCodexLiveThread,
} from "@/hooks/useCodexLive";

function shortThreadId(threadId: string): string {
  return threadId.length > 18 ? `…${threadId.slice(-16)}` : threadId;
}

function CodexLivePage() {
  const { data, error, isLoading, refresh } = useCodexLiveSnapshot(500);
  const status = useCodexLiveStatus();
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  const orderedThreads = useMemo(
    () =>
      [...(data?.threads ?? [])].sort((a, b) => {
        if (a.inFlightCount !== b.inFlightCount) return b.inFlightCount - a.inFlightCount;
        return a.updatedAt < b.updatedAt ? 1 : -1;
      }),
    [data],
  );
  const selected =
    orderedThreads.find((thread) => thread.threadId === selectedThreadId) ??
    orderedThreads[0] ??
    null;

  useEffect(() => {
    if (!selectedThreadId && orderedThreads[0]) {
      setSelectedThreadId(orderedThreads[0].threadId);
    }
  }, [orderedThreads, selectedThreadId]);

  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-4xl space-y-4">
        <section className="rounded-lg border border-border bg-card p-3 text-card-foreground">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={
                status.bridgeAvailable
                  ? "size-2 rounded-full bg-primary"
                  : "size-2 rounded-full bg-destructive"
              }
              aria-hidden="true"
            />
            <span className="text-sm font-medium">
              {status.bridgeAvailable ? "Codex events bridge connected" : "Waiting for Codex events bridge"}
            </span>
            <span className="text-xs text-muted-foreground">
              {status.inFlightCount} live · {status.itemCount} buffered
            </span>
            <button
              type="button"
              className="ml-auto rounded border border-border px-2 py-1 text-xs hover:bg-muted"
              onClick={() => void refresh()}
            >
              Refresh
            </button>
          </div>
          {!status.bridgeAvailable && !status.isLoading ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Install and enable <code className="font-mono">bb-plugin-codex-events-bridge</code>. This plugin keeps no persisted event history of its own.
            </p>
          ) : null}
        </section>

        {orderedThreads.length > 0 ? (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Thread
            <select
              className="min-w-0 flex-1 rounded border border-input bg-background px-2 py-1.5 text-foreground"
              value={selected?.threadId ?? ""}
              onChange={(event) => setSelectedThreadId(event.target.value)}
            >
              {orderedThreads.map((thread) => (
                <option key={thread.threadId} value={thread.threadId}>
                  {shortThreadId(thread.threadId)} · {thread.inFlightCount} live · {thread.itemCount} buffered
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div className="overflow-hidden rounded-lg border border-border bg-background">
          <LiveConsole thread={selected} isLoading={isLoading} error={error} />
        </div>
      </div>
    </div>
  );
}

function ThreadLivePanel({ threadId }: { threadId: string }) {
  const { thread, clearAfterSeconds, error, isLoading, dismiss } =
    useCodexLiveThread(threadId, 500);
  return (
    <div className="h-full overflow-y-auto">
      <LiveConsole
        thread={thread}
        clearAfterSeconds={clearAfterSeconds}
        error={error}
        isLoading={isLoading}
        onDismiss={(itemId) => void dismiss(itemId)}
      />
    </div>
  );
}

function ActiveThreadAccessory() {
  const { threadId } = useBbContext();
  const { thread } = useCodexLiveThread(threadId, 1000);
  if (!thread || thread.inFlightCount === 0) return null;
  return <span className="text-xs font-medium text-primary">{thread.inFlightCount} live</span>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "codex-live",
    title: "Codex Live",
    icon: "Activity",
    path: "live",
    component: CodexLivePage,
    experimental_sidebarAccessory: ActiveThreadAccessory,
  });

  app.slots.threadPanelAction({
    id: "codex-live-console",
    title: "Codex Live",
    icon: "Activity",
    layout: "flush",
    component: ThreadLivePanel,
  });
});
