---
name: codex-live
description: Inspect and troubleshoot the transient Codex Live streaming console, including bridge connectivity, live reasoning and command output, item buffering, truncation, and 60-second completion cleanup.
---

# Codex Live

Use this skill when the user asks about the Codex Live panel or why live Codex reasoning, command output, file changes, tool progress, or background tasks are not appearing.

## Checks

1. Confirm both plugins are loaded:

   ```sh
   bb plugin list
   ```

   `codex-events-bridge` must be enabled and healthy before `codex-live` can receive events.

2. Inspect Codex Live logs and status:

   ```sh
   bb plugin logs codex-live -n 100
   ```

3. Confirm the source thread uses the `codex` provider. The bridge intentionally ignores other providers.

4. Open **Codex Live** in the main sidebar, or use the thread's **Codex Live** panel action for a thread-scoped console.

## Behavior

- State is in memory only. Reloading or disabling the plugin clears it.
- Reasoning, command, and file-change text is capped by the configured per-item byte limit; when exceeded, the oldest text is removed.
- Completed items stay visible for 60 seconds and then auto-clear. They can also be dismissed manually.
- Realtime signals are invalidations, not persisted data. The frontend reconciles with RPC polling and after websocket reconnects.
