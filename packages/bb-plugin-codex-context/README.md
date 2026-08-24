# bb-plugin-codex-context

Codex context-pressure and token-usage dashboard for bb. It consumes normalized events from `bb-plugin-codex-events-bridge` and provides:

- a live per-thread context percentage in the thread header;
- a main-sidebar panel with context bars, daily/cross-thread totals, and compaction history;
- read-only account rate-limit status;
- RPC methods for automation and diagnostics.

## Dependency

Install and enable `bb-plugin-codex-events-bridge` first. This plugin polls its `recent` RPC for token usage, context window usage, compaction, context-clear, and rate-limit events.

## Install

```sh
cd packages/bb-plugin-codex-context
npm run typecheck
npm run build
bb plugin install .
```

## RPC

```sh
bb plugin call rpc codex-context currentThreadContext '{"threadId":"thr_..."}'
bb plugin call rpc codex-context snapshot null
bb plugin call rpc codex-context dailyTotals '{}'
bb plugin call rpc codex-context rateLimits null
```

`currentThreadContext` returns `percentUsed`, `usedTokens`, `windowTokens`, `totalTokens`, and compaction counts. Daily rows are stored in plugin KV under `daily:<YYYY-MM-DD>:<projectId>` and pruned on reads/polling according to the configured retention period (30 days by default).

Rate limits are display-only; the plugin never edits provider limits.
