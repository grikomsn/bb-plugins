import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { GoalSnapshot, rpcContract } from "@/contract";

export type CurrentCodexGoal = {
  threadId: string;
  providerSessionId: string | null;
  bridgeAvailable: boolean;
  snapshot: GoalSnapshot | null;
};

export function useCodexGoal(threadId: string | null): {
  data: CurrentCodexGoal | null;
  error: string | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
} {
  const rpc = useRpc<typeof rpcContract>();
  const connectionState = useRealtimeConnectionState();
  const [data, setData] = useState<CurrentCodexGoal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(threadId !== null);
  const hasConnected = useRef(false);
  const previousConnectionState = useRef(connectionState);
  const requestVersion = useRef(0);

  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    if (!threadId) {
      setData(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    try {
      const next = await rpc.call("currentThreadSnapshot", { threadId });
      if (requestVersion.current !== version) return;
      setData(next);
      setError(null);
    } catch (refreshError) {
      if (requestVersion.current !== version) return;
      setData(null);
      setError(String(refreshError));
    } finally {
      if (requestVersion.current === version) setIsLoading(false);
    }
  }, [rpc, threadId]);

  useRealtime("codex-goal/snapshot", () => {
    void refresh();
  });

  useEffect(() => {
    // Clear the previous thread immediately; late responses are invalidated by
    // the monotonically increasing request version.
    requestVersion.current += 1;
    setData(null);
    setError(null);
    setIsLoading(threadId !== null);
    void refresh();
    const timer = setInterval(() => void refresh(), 2_000);
    return () => {
      requestVersion.current += 1;
      clearInterval(timer);
    };
  }, [refresh, threadId]);

  useEffect(() => {
    const previous = previousConnectionState.current;
    if (connectionState === "connected") {
      if (hasConnected.current && previous !== "connected") void refresh();
      hasConnected.current = true;
    }
    previousConnectionState.current = connectionState;
  }, [connectionState, refresh]);

  return { data, error, isLoading, refresh };
}
