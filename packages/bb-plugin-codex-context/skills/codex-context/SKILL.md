---
name: codex-context
description: Inspect Codex token usage, context-window pressure, compaction history, daily totals, and rate-limit state from the bb Codex Context plugin.
---

# Codex context

Use this skill when the user asks how full a Codex thread's context is, how many tokens Codex threads have used, whether compaction occurred, or what account rate-limit state bb has observed.

## Commands

For one thread:

```sh
bb plugin call rpc codex-context currentThreadContext '{"threadId":"thr_..."}'
```

For the complete live snapshot:

```sh
bb plugin call rpc codex-context snapshot null
```

For persisted daily totals (optionally add `date` or `projectId`):

```sh
bb plugin call rpc codex-context dailyTotals '{}'
```

For recent read-only rate-limit snapshots:

```sh
bb plugin call rpc codex-context rateLimits null
```

Treat `null` context values as “not reported yet,” not zero. `totalTokens` is cumulative provider usage for the current thread/session; daily totals add only positive cumulative deltas to avoid double-counting repeated bridge events. The plugin depends on `codex-events-bridge`; check both plugin statuses when data is stale or absent.
