import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "@/contract";
import type { DockerSnapshot } from "@/contract";

export function useDockerSnapshot(): {
  data: DockerSnapshot | null;
  error: string | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
} {
  const rpc = useRpc<typeof rpcContract>();
  const connectionState = useRealtimeConnectionState();
  const [data, setData] = useState<DockerSnapshot | null>(null);
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

  useRealtime("docker/snapshot", () => {
    void refresh();
  });

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 2_000);
    return () => clearInterval(timer);
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

  return { data, error, isLoading, refresh };
}
