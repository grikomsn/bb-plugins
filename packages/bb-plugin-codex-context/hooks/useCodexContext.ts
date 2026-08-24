// Hooks for the codex-context frontend.
//
// `useCodexContextSnapshot` polls the bundled `snapshot` rpc on a short
// cadence and reconciles on realtime `connected -> connected` transitions.
// `useCodexCurrentThreadContext` resolves threadId → per-thread state, used
// by the thread header pill. `useCodexDailyTotals` is the cross-thread
// totals card data source.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contract";
import type {
  CodexContextSnapshot,
  CurrentThreadContext,
  DailyTotalsResult,
  RateLimitsResult,
  ThreadTotalsResult,
} from "../contract";

const SNAPSHOT_POLL_MS = 1500;
const THREAD_POLL_MS = 1500;
const TX_POLL_MS = 3000;

const EMPTY_THREAD_CONTEXT: CurrentThreadContext = {
  threadId: "",
  providerThreadId: null,
  percentUsed: null,
  usedTokens: null,
  windowTokens: null,
  totalTokens: 0,
  lastTokens: null,
  compactionCount: 0,
  contextClearCount: 0,
  lastCompactionAt: null,
  lastUpdatedAt: null,
  estimated: null,
  modelContextWindow: null,
};

type SnapshotState = {
  data: CodexContextSnapshot | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

export function useCodexContextSnapshot(): SnapshotState {
  const rpc = useRpc<typeof rpcContract>();
  const connectionState = useRealtimeConnectionState();
  const [data, setData] = useState<CodexContextSnapshot | null>(null);
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

  useRealtime("codex-context/snapshot", () => {
    void refresh();
  });

  useEffect(() => {
    void refresh();
    const id = setInterval(() => {
      void refresh();
    }, SNAPSHOT_POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

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

  return { data, isLoading, error, refresh };
}

export function useCodexCurrentThreadContext(
  threadId: string | null,
): { data: CurrentThreadContext; isLoading: boolean; error: string | null } {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<CurrentThreadContext>(EMPTY_THREAD_CONTEXT);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useRealtime("codex-context/snapshot", () => {
    if (threadId) void refresh();
  });

  const refresh = useCallback(async () => {
    if (!threadId) return;
    try {
      const r = await rpc.call("currentThreadContext", { threadId });
      setData(r);
      setError(null);
    } catch (refreshError) {
      setError(String(refreshError));
    } finally {
      setIsLoading(false);
    }
  }, [rpc, threadId]);

  useEffect(() => {
    setData(EMPTY_THREAD_CONTEXT);
    setError(null);
    setIsLoading(true);
    if (!threadId) {
      setIsLoading(false);
      return;
    }
    void refresh();
    const id = setInterval(() => {
      void refresh();
    }, THREAD_POLL_MS);
    return () => clearInterval(id);
  }, [refresh, threadId]);

  return { data, isLoading, error };
}

export function useCodexThreadTotals(): ThreadTotalsResult | null {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<ThreadTotalsResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const r = await rpc.call("threadTotals");
        if (!cancelled) setData(r);
      } catch {
        // ignore — likely chokepoint unavailable
      }
    };
    void tick();
    const id = setInterval(tick, TX_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [rpc]);
  return data;
}

export function useCodexDailyTotals(
  opts: { date?: string; projectId?: string } = {},
): DailyTotalsResult | null {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<DailyTotalsResult | null>(null);
  const key = useMemo(
    () => `${opts.date ?? ""}::${opts.projectId ?? ""}`,
    [opts.date, opts.projectId],
  );
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const r = await rpc.call("dailyTotals", {
          ...(opts.date ? { date: opts.date } : {}),
          ...(opts.projectId ? { projectId: opts.projectId } : {}),
        });
        if (!cancelled) setData(r);
      } catch {
        // ignore
      }
    };
    void tick();
    const id = setInterval(tick, TX_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [rpc, key, opts.date, opts.projectId]);
  return data;
}

export function useCodexRateLimits(): RateLimitsResult | null {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<RateLimitsResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const r = await rpc.call("rateLimits");
        if (!cancelled) setData(r);
      } catch {
        // ignore
      }
    };
    void tick();
    const id = setInterval(tick, TX_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [rpc]);
  return data;
}

export function useCodexContextStatus(): {
  pollIntervalMs: number;
  retentionDays: number;
  chokepointConnected: boolean;
  threadCount: number;
  lastEventAt: string | null;
  pollIteration: number;
  isStale: boolean;
} | null {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<ReturnType<
    typeof useCodexContextStatus
  > | null>(null);
  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const r = await rpc.call("status");
        if (!cancelled) setState(r);
      } catch {
        // ignore
      }
    };
    void tick();
    const id = setInterval(tick, TX_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [rpc]);
  return state;
}
