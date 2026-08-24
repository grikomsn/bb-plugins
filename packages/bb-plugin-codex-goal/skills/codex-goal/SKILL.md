---
name: codex-goal
description: Inspect native Codex goal state in bb, including objective, status, token budget, elapsed time, per-thread history, and all-session snapshots. Use when checking what a Codex-backed thread is working toward or how much of its goal budget it has used.
---

# Codex Goal

Use this plugin to inspect goals emitted by bb's native Codex provider. It is
read-only except for the explicit panel action that clears the current goal
through bb's canonical thread API.

## Data flow

1. Codex emits `thread/goal/updated` and `thread/goal/cleared`.
2. bb persists those normalized events in the thread events database.
3. `bb-plugin-codex-events-bridge` republishes them on
   `codex/thread/goal/updated` and `codex/thread/goal/cleared`, and exposes them
   through its `recent` RPC.
4. This plugin polls `recent` with `typePrefix: "codex/thread/goal/"`, keeps a
   per-provider-thread snapshot and 200-entry history, and publishes
   `codex-goal/snapshot` invalidations for its UI.

This plugin does **not** consume the pi extension's
`pi.ext:codex-goal/*` envelopes. `bb-plugin-pi-codex-goal` owns those, so the
two plugins can coexist.

## Inspect goal state

```sh
bb plugin call rpc codex-goal snapshot \
  '{"parentSessionId":"<providerThreadId>"}'

bb plugin call rpc codex-goal currentThreadSnapshot \
  '{"threadId":"<bbThreadId>"}'

bb plugin call rpc codex-goal history \
  '{"parentSessionId":"<providerThreadId>","limit":50}'

bb plugin call rpc codex-goal allSnapshots null
```

The UI surfaces are:

- Settings: all known Codex sessions and current goals.
- Thread header: a compact pill only while that thread's goal is `active`.
- Thread panel: full objective, tokens/budget progress, elapsed time, history,
  and an explicit clear button.

## Event payloads

`thread/goal/updated` carries:

```ts
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
```

`thread/goal/cleared` carries:

```ts
{
  type: "thread/goal/cleared";
  threadId: string;
  providerThreadId: string;
}
```

If RPC responses report `bridgeAvailable: false`, install or enable
`bb-plugin-codex-events-bridge`; do not treat the empty snapshot as a plugin
crash.
