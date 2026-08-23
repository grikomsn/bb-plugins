// React hook for downstream consumers: exposes a tiny, typed wrapper around
// the bridge RPC (`recent`, `sessions`, `threadSession`, `status`) plus a
// helper to subscribe to a category-wide realtime stream.
//
// Consumers in OTHER plugins would call `bb.sdk.plugins.callRpc` from their
// `server.ts` factory (the rpc-typed client `useRpc<typeof rpcContract>()`
// is only available in this plugin's own `app.tsx`).

import { useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { CodexCategory } from "../lib/codex-events";

export type CodexEvent = {
  seq: number;
  ts: string;
  type: string;
  category: CodexCategory;
  threadId: string;
  providerThreadId: string | null;
  payload: unknown;
};

export type CodexStatus = {
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

export type CodexSession = {
  threadId: string;
  providerThreadId: string | null;
  title: string;
  status: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastEventType: string | null;
  eventCount: number;
  eventCountByCategory: Record<CodexCategory, number>;
};

export type CodexRecentInput = {
  limit?: number;
  threadId?: string;
  typePrefix?: string;
};

/**
 * Polls `status` every `intervalMs`. Returns `null` until the first tick.
 */
export function useCodexStatus(intervalMs = 2_000): CodexStatus | null {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<CodexStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const s = await rpc.call("status");
        if (!cancelled) setStatus(s);
      } catch {
        // bridge may not be installed; leave status null so callers fall back
      }
    };
    void tick();
    const id = setInterval(() => {
      void tick();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [rpc, intervalMs]);

  return status;
}

/**
 * Polls `recent` with the given filter every `intervalMs`. Returns the
 * newest-first array (limited to `limit`); the realtime handler for the
 * same `typePrefix` (or the wildcard `*` if you set up your own dispatcher)
 * should be combined with this hook for instant updates.
 */
export function useCodexRecent(
  input: CodexRecentInput = {},
  intervalMs = 1_500,
): CodexEvent[] {
  const rpc = useRpc<typeof rpcContract>();
  const [events, setEvents] = useState<CodexEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const { events } = await rpc.call("recent", input);
        if (!cancelled) setEvents(events);
      } catch {
        // ignore — bridge not installed yet
      }
    };
    void tick();
    const id = setInterval(() => {
      void tick();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, intervalMs, input.limit, input.threadId, input.typePrefix]);

  return events;
}

/**
 * Polls `sessions` every `intervalMs`. Returns per-thread stats so a
 * consumer can show a fleet header / picker.
 */
export function useCodexSessions(intervalMs = 3_000): CodexSession[] {
  const rpc = useRpc<typeof rpcContract>();
  const [sessions, setSessions] = useState<CodexSession[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const { sessions } = await rpc.call("sessions");
        if (!cancelled) setSessions(sessions);
      } catch {
        // ignore
      }
    };
    void tick();
    const id = setInterval(() => {
      void tick();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [rpc, intervalMs]);

  return sessions;
}

/**
 * Resolves a bb threadId to its provider threadId via the bridge's
 * `threadSession` rpc. Returns `{ providerThreadId: null, sessionActive: false }`
 * when the bridge has no record of that thread yet (older threads, or
 * threads active before this plugin loaded).
 */
export function useCodexThreadSession(threadId: string | null): {
  providerThreadId: string | null;
  sessionActive: boolean;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [result, setResult] = useState<{
    providerThreadId: string | null;
    sessionActive: boolean;
  }>({ providerThreadId: null, sessionActive: false });

  useEffect(() => {
    if (!threadId) {
      setResult({ providerThreadId: null, sessionActive: false });
      return;
    }
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const r = await rpc.call("threadSession", { threadId });
        if (!cancelled) setResult(r);
      } catch {
        if (!cancelled) setResult({ providerThreadId: null, sessionActive: false });
      }
    };
    void tick();
    const id = setInterval(() => {
      void tick();
    }, 3_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [rpc, threadId]);

  return result;
}

/**
 * Subscribe to a single category's full event stream, calling `onEvent` for
 * each new payload published by the bridge. Channels are per-event-type
 * (e.g. `codex/thread/started`), so if you want the full category you must
 * either list every type from the taxonomy or — simpler — poll `recent`
 * with `typePrefix: "codex/<category>/"`.
 *
 * Returns an unsubscribe function (also runs on unmount via `useRealtime`).
 */
export function useCodexCategoryChannel(
  category: CodexCategory,
  onEvent: (event: CodexEvent) => void,
): void {
  // Subscribe to a representative pulse from the category so the page
  // wakes up immediately when an event lands. Pair with `useCodexRecent`
  // for the full surface; the rpc call already filters on prefix.
  const head = `codex/${category}/`;
  // Most categories fan out across many types; pick the most common one so
  // useRealtime (single-channel) catches at least one event the moment the
  // rpc poll is stale.
  const representative =
    category === "thread"
      ? "codex/thread/started"
      : category === "turn"
        ? "codex/turn/started"
        : category === "item"
          ? "codex/item/agentMessage/delta"
          : "codex/account/rateLimits/updated";
  useRealtime(representative, (payload) => {
    if (payload && typeof payload === "object") {
      const e = payload as CodexEvent;
      if (e.type?.startsWith(head)) onEvent(e);
    }
  });
}

// `definePluginApp` placeholder — this is a hooks-only file; the actual app
// surface is in `app.tsx`. Re-exporting here so the build can tree-shake
// when nothing else imports this file.
export const __definePluginApp = definePluginApp;
