// React hook surface for downstream consumers (this app.tsx + future
// sibling plugins). Polls the bridge-exposed `snapshot` RPC for the full
// fleet and exposes the per-thread snapshot. Pairs `useRealtime` on the
// per-plugin `codex-plan/snapshot` channel for instant updates.

import { useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contract";
import type { CodexPlanSnapshot } from "@/lib/codex-plan";

export type PlansSnapshot = {
  chokepoint: string;
  sessionIds: string[];
  snapshots: CodexPlanSnapshot[];
};

const REFRESH_INTERVAL_MS = 1_500;

/**
 * Polls the bridge-exposed `snapshot` RPC and re-fetches instantly on each
 * `codex-plan/snapshot` realtime pulse. Useful for the nav panel's fleet
 * picker.
 */
export function usePlansSnapshot(): PlansSnapshot | null {
  const rpc = useRpc<typeof rpcContract>();
  const [value, setValue] = useState<PlansSnapshot | null>(null);

  useRealtime("codex-plan/snapshot", () => {
    void tick();
  });
  useRealtime("codex-plan/decided", () => {
    void tick();
  });

  async function tick(): Promise<void> {
    try {
      const r = await rpc.call("snapshot", null);
      setValue(r);
    } catch {
      // bridge may not be installed; UI will keep showing the placeholder
    }
  }

  useEffect(() => {
    void tick();
    const id = setInterval(() => void tick(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return value;
}

/**
 * One-thread view: resolves a bb threadId through the bridge's
 * `currentThreadPlan` RPC. Returns `null` until the first tick finishes.
 */
export function useThreadPlan(threadId: string | null): {
  providerThreadId: string | null;
  snapshot: CodexPlanSnapshot | null;
} {
  const rpc = useRpc<typeof rpcContract>();
  const [value, setValue] = useState<{
    providerThreadId: string | null;
    snapshot: CodexPlanSnapshot | null;
  }>({ providerThreadId: null, snapshot: null });

  useRealtime("codex-plan/snapshot", () => {
    void tick();
  });
  useRealtime("codex-plan/decided", () => {
    void tick();
  });

  async function tick(): Promise<void> {
    if (!threadId) {
      setValue({ providerThreadId: null, snapshot: null });
      return;
    }
    try {
      const r = await rpc.call("currentThreadPlan", { threadId });
      setValue({
        providerThreadId: r.providerThreadId,
        snapshot: r.snapshot,
      });
    } catch {
      setValue({ providerThreadId: null, snapshot: null });
    }
  }

  useEffect(() => {
    void tick();
    const id = setInterval(() => void tick(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [threadId]);

  return value;
}

/**
 * Implements the decide RPC client-side. Returns a function that takes
 * `{ decision, message? }` and resolves once the rpc call returns; the
 * server already records the decision in memory so we don't pessimistically
 * wait for the agent turn.
 */
export function useDecide(threadId: string) {
  const rpc = useRpc<typeof rpcContract>();
  return async function decide(decision: {
    decision: "approve" | "reject" | "request-changes";
    message?: string;
  }): Promise<void> {
    await rpc.call("decide", { threadId, ...decision });
  };
}
