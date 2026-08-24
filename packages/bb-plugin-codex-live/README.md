# bb-plugin-codex-live

A transient live console for BB's Codex provider. It consumes the in-memory `codex/item/*` replay exposed by `bb-plugin-codex-events-bridge`, coalesces streaming item deltas by BB thread and item id, and renders them in:

- a **Codex Live** main-sidebar panel; and
- a **Codex Live** thread-panel action scoped to the open thread.

The console covers raw reasoning, command output, raw file-change output, MCP/tool progress, and background-task updates. Completed items remain visible for 60 seconds and are then removed automatically. Live deltas are never persisted by this plugin; BB's normal timeline remains the durable completed-item view.

## Dependency

Install and enable `bb-plugin-codex-events-bridge` first. Codex Live polls its `recent` RPC for `codex/item/` events and publishes `codex-live/snapshot` invalidations to its own frontend.

## Install

```sh
cd packages/bb-plugin-codex-live
npm run typecheck
npm run build
bb plugin install .
```

For a monorepo checkout, dependencies can be installed from the repository root with `npm install`.

## Settings

- **Poll interval** — defaults to 500 ms for visibly incremental updates.
- **Max in-flight items per thread** — defaults to 12.
- **Streaming byte cap per item** — defaults to 256 KiB; oldest text is dropped when the cap is exceeded.

## Runtime checks

```sh
bb plugin list
bb plugin logs codex-live -n 100
```

Start or continue a thread using the `codex` provider, then open **Codex Live** from the sidebar or from that thread's panel actions. Reasoning and command text should grow over successive refreshes. A completed card should remain for 60 seconds unless dismissed manually.
