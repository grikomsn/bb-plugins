# bb-plugin-codex-goal

Shows the native goal state of Codex-backed bb threads: objective, status,
tokens used, token budget, elapsed time, and a capped per-thread history.

## Install

This plugin depends on `bb-plugin-codex-events-bridge`.

```sh
bb plugin install ./packages/bb-plugin-codex-events-bridge
bb plugin install ./packages/bb-plugin-codex-goal
```

If the bridge is missing or disabled, Codex Goal remains loaded and displays a
bridge-not-installed empty state instead of crashing.

## Architecture

```text
Codex app-server
  thread/goal/updated | thread/goal/cleared
        │
        ▼
bb thread events database
        │
        ▼
bb-plugin-codex-events-bridge
  recent({ typePrefix: "codex/thread/goal/" })
        │
        ▼
bb-plugin-codex-goal
  per-providerThreadId snapshot + 200-entry history
  realtime: codex-goal/snapshot
        │
        ├─ Settings section: all known sessions
        ├─ thread-header pill: active goals only
        └─ thread panel: objective, budget, history, clear action
```

This plugin only consumes `codex/thread/goal/*`. It is independent from
`bb-plugin-pi-codex-goal`, which consumes `pi.ext:codex-goal/*`; both can be
enabled at the same time.

## Native event payloads

```ts
// thread/goal/updated
{
  type: "thread/goal/updated";
  threadId: string;
  providerThreadId: string;
  objective: string;
  status: "active" | "paused" | "budgetLimited" | "complete";
  timeUsedSeconds: number;
  tokenBudget: number | null;
  tokensUsed: number;
}

// thread/goal/cleared
{
  type: "thread/goal/cleared";
  threadId: string;
  providerThreadId: string;
}
```

## RPC reference

```sh
bb plugin call rpc codex-goal snapshot \
  '{"parentSessionId":"<providerThreadId>"}'

bb plugin call rpc codex-goal currentThreadSnapshot \
  '{"threadId":"<bbThreadId>"}'

bb plugin call rpc codex-goal history \
  '{"parentSessionId":"<providerThreadId>","limit":50}'

bb plugin call rpc codex-goal allSnapshots null
```

- `snapshot` returns `{ source, bridgeAvailable, snapshot, sessionId, sessionIds }`.
- `history` returns newest-first `{ kind, at, source?, goalId?, objective?,
  status?, tokensUsed?, activeSeconds? }` entries.
- `allSnapshots` lists all known Codex provider sessions.
- `currentThreadSnapshot` resolves a bb thread id to its provider session.
- `clearGoal` is used by the thread panel and delegates to the canonical
  `bb.sdk.threads.clearGoal({ threadId })` API.

State is in memory and is rebuilt from the bridge replay ring after reload.
History is capped at 200 entries per provider thread.
