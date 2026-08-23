// React hooks for the codex-raw settings page.
//
// Typed wrappers around `useRpc<typeof rpcContract>()` + one realtime
// signal from the plugin's own bb.realtime publish so the table renders
// fresh rows the moment they land (without waiting for the next poll).
//
// Note: this file is also imported by external consumers via the package
// surface. Server contract types are imported `import type`-only so the
// frontend bundle never pulls in backend code.

import { useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  CodexRawEvent,
  CodexRawSessionSummary,
  CodexRawStatus,
  rpcContract,
} from "../contract";

/**
 * Polls `status` every `intervalMs`. Returns `null` until the first tick
 * resolves so the page can render a skeleton.
 */
export function useCodexRawStatus(intervalMs = 2_500): CodexRawStatus | null {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<CodexRawStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const s = await rpc.call("status");
        if (!cancelled) setStatus(s);
      } catch {
        // ignore — the plugin may not be installed yet
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
 * Polls `sessions` every `intervalMs`. Returns the per-thread session
 * summaries so the fleet picker can render one row per tracked codex
 * thread.
 */
export function useCodexRawSessions(intervalMs = 3_000): CodexRawSessionSummary[] {
  const rpc = useRpc<typeof rpcContract>();
  const [sessions, setSessions] = useState<CodexRawSessionSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const { sessions: list } = await rpc.call("sessions");
        if (!cancelled) setSessions(list);
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
 * Polls `rawEvents({ threadId, limit, ... })` every `intervalMs`. The
 * realtime handler for `codex-raw/snapshot` (published by the backend on
 * every fresh row) still streams new rows in between polls.
 */
export function useCodexRawEvents(
  args: {
    threadId?: string;
    classification?: "unhandled" | "noise" | "other";
    rawType?: string;
    limit?: number;
    sinceSeq?: number;
  } = {},
  intervalMs = 1_500,
): CodexRawEvent[] {
  const rpc = useRpc<typeof rpcContract>();
  const [events, setEvents] = useState<CodexRawEvent[]>([]);
  const argsKey = JSON.stringify(args);

  useEffect(() => {
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const input = {
          limit: args.limit ?? 200,
          ...(args.threadId ? { threadId: args.threadId } : {}),
          ...(args.classification ? { classification: args.classification } : {}),
          ...(args.rawType ? { rawType: args.rawType } : {}),
          ...(Number.isFinite(args.sinceSeq) ? { sinceSeq: args.sinceSeq } : {}),
        };
        const { events: list } = await rpc.call("rawEvents", input);
        if (!cancelled) setEvents(list);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, intervalMs, argsKey]);

  // Realtime push: every fresh row emits a small DTO on `codex-raw/snapshot`.
  // We splice into the front of the existing list; the next `rawEvents`
  // poll reconciles gaps.
  useRealtime("codex-raw/snapshot", (payload) => {
    if (!payload || typeof payload !== "object") return;
    const p = payload as {
      threadId?: string;
      event?: CodexRawEvent;
    };
    const snap = p.event;
    if (!snap) return;
    if (args.threadId && p.threadId !== args.threadId) return;
    if (args.classification && snap.classification !== args.classification) return;
    if (args.rawType && snap.rawType !== args.rawType) return;
    const targetThreadId = p.threadId ?? "";
    setEvents((prev) => {
      if (
        prev.some(
          (e) =>
            e.threadId === targetThreadId &&
            e.seq === snap.seq &&
            e.rawType === snap.rawType,
        )
      ) {
        return prev;
      }
      return [snap, ...prev].slice(0, args.limit ?? 200);
    });
  });

  return events;
}
