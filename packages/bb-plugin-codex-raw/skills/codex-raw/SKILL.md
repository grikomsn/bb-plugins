---
name: codex-raw
description: Inspect provider-codex notifications BB did not normalize, including fs/changed, process/outputDelta, MCP startup, skills, and thread/realtime events. Use to debug protocol additions or correlate low-level Codex activity with a thread.
---

# Codex Raw

Use this plugin for low-level provider-codex diagnostics.

## Commands

```sh
bb codex-raw status
bb codex-raw types
bb codex-raw sessions
bb codex-raw tail <threadId> [--since-seq <n>] [--limit <1-500>]
```

`tail` emits chronological JSON Lines. Repeat it with the highest returned
`seq` as `--since-seq` to continue from a cursor.

## Data path

`bb-plugin-codex-events-bridge` polls BB thread events and maps each persisted
`provider/unhandled` row to `codex/raw/<rawType>`. Codex Raw polls the bridge's
`recent` RPC, keeps at most 1000 rows per thread by default, and exposes its own
`rawEvents` and `tail` RPCs plus a settings table.

The General preference `showUnhandledProviderEvents` must be enabled. The
settings section warns when it is false or cannot be read. The bridge is a hard
dependency; if `bb codex-raw status` reports `reachable:false`, inspect
`bb plugin list` and `bb plugin logs codex-events-bridge`.

## Interpretation

The `types` command lists the exact 42 methods in the DOCK-9 protocol snapshot:
29 host-classified `unknown` methods and 13 `noise` methods. Unknown methods can
become `provider/unhandled` rows. Noise methods may be handled or dropped by the
provider host before the event DB, so absence does not prove Codex never emitted
them.

Use the normalized Codex Events Bridge channels or `ThreadChat` for ordinary
turn/message rendering; Codex Raw is intentionally diagnostic and in-memory.
