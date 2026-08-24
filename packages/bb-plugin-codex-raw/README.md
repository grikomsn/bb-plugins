# bb-plugin-codex-raw

Diagnostic companion to `bb-plugin-codex-events-bridge`. It keeps an in-memory,
per-thread ring of provider-codex notifications that BB did not normalize,
shows them in a plugin settings section, and exposes RPC and CLI reads.

## Prerequisites

1. Install and enable `bb-plugin-codex-events-bridge`.
2. Enable **Settings → General → Show unhandled provider events**.

The bridge publishes persisted `provider/unhandled` rows as
`codex/raw/<rawType>` and exposes them through its `recent` RPC. Codex Raw polls
that chokepoint every 750ms by default; together with the bridge's 1.5s poll,
a newly persisted raw row is normally visible within three seconds. The provider host may consume or drop
its `noise`-classified notifications before persistence; the plugin catalogs
all 42 task-defined unknown/noise methods but can only display payloads that
reach `provider/unhandled`.

## Install and validate

```sh
cd packages/bb-plugin-codex-events-bridge
bb plugin install . --yes
cd ../bb-plugin-codex-raw
bb plugin install . --yes
bb plugin list
```

## RPC

- `rawEvents({ threadId?, sinceSeq?, limit?, classification?, rawType? })` —
  newest first, including full params and `paramsPreview`.
- `tail({ threadId, sinceSeq?, limit? })` — chronological cursor read with
  `nextSeq`.
- `types(null)` — the exact 42 task-defined methods and host classification.
- `sessions(null)` / `status(null)` — diagnostic state.

## CLI

```sh
bb codex-raw tail <threadId> [--since-seq <n>] [--limit <1-500>]
```

`tail` writes bounded JSON Lines to stdout. Returned output stays below
`PLUGIN_CLI_OUTPUT_MAX_BYTES` (1 MiB). Plugin CLI handlers are request/response,
so repeat with the returned/highest sequence cursor to continue tailing.

## UI

The plugin registers one `settingsSection` and deliberately no `navPanel`.
Rows show timestamp, classification, `rawType`, payload preview, and thread id;
selecting a row opens formatted payload details.

## Settings

- `maxRawEventsPerThread` (default `1000`)
- `pollIntervalMs` (default `750`)
- `threadDiscoveryIntervalMs` (default `1500`, keeping new threads visible within 3s)
- `includeHidden` (retained for session reporting compatibility)

State is in memory and is intentionally not persisted across BB restarts.
