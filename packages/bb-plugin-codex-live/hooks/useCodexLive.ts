// bb-plugin-codex-live — frontend hooks.
//
// Surface this plugin's snapshot rpc + the realtime wake-up signal. The
// renderer subscribes to both, fetches the snapshot on demand, and falls
// back to a polling tick so deltas are still picked up if the realtime
// channel is disconnected for any reason.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "@/contract";
import type {
  CodexLiveSnapshot,
  CodexLiveStatus,
  ThreadSnapshot,
} from "@/contract";

const REALTIME_CHANNEL = "codex-live/snapshot";
const DEFAULT_POLL_MS = 500;

/**
 * Live snapshot for ALL codex threads known to the bridge. Pair with
 * `useRealtime("codex-live/snapshot", ...)` for instant updates; the
 * polling tick is a defence-in-depth fallback.
 */
export function useCodexLiveSnapshot(pollMs = DEFAULT_POLL_MS): {
  data: CodexLiveSnapshot | null;
  error: string | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
} {
  const rpc = useRpc<typeof rpcContract>();
  const connectionState = useRealtimeConnectionState();
  const [data, setData] = useState<CodexLiveSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const hasConnected = useRef(false);
  const previousConnectionState = useRef(connectionState);

  const refresh = useCallback(async () => {
    try {
      const snapshot = await rpc.call("snapshot");
      setData(snapshot);
      setError(null);
    } catch (refreshError) {
      setError(String(refreshError));
    } finally {
      setIsLoading(false);
    }
  }, [rpc]);

  useRealtime(REALTIME_CHANNEL, () => {
    void refresh();
  });

  useEffect(() => {
    void refresh();
    const id = setInterval(() => {
      void refresh();
    }, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  useEffect(() => {
    const previous = previousConnectionState.current;
    if (connectionState === "connected") {
      if (hasConnected.current && previous !== "connected") {
        void refresh();
      }
      hasConnected.current = true;
    }
    previousConnectionState.current = connectionState;
  }, [connectionState, refresh]);

  return { data, error, isLoading, refresh };
}

/**
 * Live snapshot for a single thread (the active thread in the side panel).
 * Calls `activeThreadStream` on the backend, falls back to scanning the
 * site-wide snapshot when the active stream is empty so an old thread
 * (loaded after brief server downtime) still renders its stream.
 */
export function useCodexLiveThread(threadId: string | null, pollMs = DEFAULT_POLL_MS): {
  thread: ThreadSnapshot | null;
  clearAfterSeconds: number | null;
  error: string | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
  dismiss: (itemId: string) => Promise<void>;
} {
  const rpc = useRpc<typeof rpcContract>();
  const connectionState = useRealtimeConnectionState();
  const [thread, setThread] = useState<ThreadSnapshot | null>(null);
  const [clearAfterSeconds, setClearAfterSeconds] = useState<number | null>(null);
  const hasConnected = useRef(false);
  const previousConnectionState = useRef(connectionState);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!threadId) {
      setThread(null);
      setClearAfterSeconds(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    try {
      const stream = await rpc.call("activeThreadStream", { threadId });
      setThread(stream.thread);
      setClearAfterSeconds(stream.clearAfterSeconds);
      setError(null);
    } catch (refreshError) {
      setError(String(refreshError));
    } finally {
      setIsLoading(false);
    }
  }, [rpc, threadId]);

  useRealtime(REALTIME_CHANNEL, () => {
    void refresh();
  });

  useEffect(() => {
    void refresh();
    const id = setInterval(() => {
      void refresh();
    }, pollMs);
    return () => clearInterval(id);
  }, [refresh, pollMs]);

  useEffect(() => {
    const previous = previousConnectionState.current;
    if (connectionState === "connected") {
      if (hasConnected.current && previous !== "connected") {
        void refresh();
      }
      hasConnected.current = true;
    }
    previousConnectionState.current = connectionState;
  }, [connectionState, refresh]);

  const dismiss = useCallback(
    async (itemId: string) => {
      if (!threadId) return;
      try {
        await rpc.call("dismiss", { threadId, itemId });
      } catch (e) {
        setError(String(e));
      }
      void refresh();
    },
    [rpc, threadId, refresh],
  );

  return { thread, clearAfterSeconds, error, isLoading, refresh, dismiss };
}

/**
 * One-shot status probe (polled frequently; the nav panel header uses
 * this). When the bridge plugin is not installed, `bridgeAvailable: false`
 * surfaces an empty-state message in the page.
 */
export function useCodexLiveStatus(pollMs = 3000): CodexLiveStatus & {
  isLoading: boolean;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<CodexLiveStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await rpc.call("status");
        if (!cancelled) setStatus(s);
      } catch {
        // chokepoint not installed / disabled — leave last status alone
      }
    };
    void tick();
    const id = setInterval(() => {
      void tick();
    }, pollMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [rpc, pollMs]);

  return {
    bridgeAvailable: status?.bridgeAvailable ?? false,
    bridgeId: status?.bridgeId ?? "codex-events-bridge",
    pollIntervalMs: status?.pollIntervalMs ?? 0,
    maxItemsPerThread: status?.maxItemsPerThread ?? 0,
    maxDeltaBytesPerItem: status?.maxDeltaBytesPerItem ?? 0,
    threadCount: status?.threadCount ?? 0,
    itemCount: status?.itemCount ?? 0,
    inFlightCount: status?.inFlightCount ?? 0,
    lastEventAt: status?.lastEventAt ?? null,
    pollIteration: status?.pollIteration ?? 0,
    isLoading: status === null,
  };
}
