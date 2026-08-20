# Thread Archives

Extracted transcripts and research results from the bb threads that produced this
monorepo. Each file preserves the full conversation (user prompts, assistant
reasoning, tool-call trail) plus a distilled summary of the important context and
findings.

| Thread | Title | Status | Doc |
|--------|-------|--------|-----|
| `thr_xwdzm5raqz` | Explore plugins for custom BB | idle | [01-thr_xwdzm5raqz-explore-plugins.md](./01-thr_xwdzm5raqz-explore-plugins.md) |
| `thr_t2tq3jvmgi` | Debug missing subagent reports | idle | [02-thr_t2tq3jvmgi-debug-subagent-reports.md](./02-thr_t2tq3jvmgi-debug-subagent-reports.md) |
| `thr_8qmbkz48sx` | Check other thread subagent status | idle | [03-thr_8qmbkz48sx-check-subagent-status.md](./03-thr_8qmbkz48sx-check-subagent-status.md) |

## Timeline

1. **`thr_xwdzm5raqz`** (2026-08-20 ~01:07 → 06:18 UTC) — the main work thread.
   Explored the installed pi third-party plugin event surface, then built the whole
   bridge stack: `pi-bb-bridge` (pi extension) → `bb-plugin-pi-events-bridge`
   (Unix-socket chokepoint) → consumer plugins (`pi-subagents-fleet`,
   `pi-codex-goal`, `mcp-mediator`). Ended with the npm-workspaces monorepo port
   into this repo. **The "push upstream" step was never completed** (repo has zero
   commits; GitHub remote is empty).
2. **`thr_t2tq3jvmgi`** (2026-08-20 ~05:30 → 06:23 UTC) — spawned while waiting on
   thread 1. Root-caused why subagent/goal events never reach bb: bb 0.39.0's
   `provider-pi` ships **no `host.js` bridge worker**, so `BB_BRIDGE_SOCKET_PATH`
   is never set and `pi-bb-bridge` stays a no-op. Also catalogued the unhandled
   event leak. Ended with an unanswered question: write the `host.js` workaround?
3. **`thr_8qmbkz48sx`** (2026-08-20 ~06:23 → 06:29 UTC, fork of thread 2) —
   confirmed `thr_xwdzm5raqz` was running pi itself (not a subagent), that pi
   exited cleanly, and that the thread is properly idle. Ended with the same
   unanswered question.

## Key findings (condensed)

- **The bridge chain is broken at the first hop in stock bb 0.39.0.** `pi-bb-bridge`
  only activates when `BB_BRIDGE_SOCKET_PATH` is set, and nothing in bb sets it for
  pi. `provider-codex`, `provider-acp`, and `provider-claude-code` all ship a
  `host.js` bridge worker that sets these env vars; `provider-pi` does not.
- **Unhandled pi events leak into bb.db as `provider/unhandled`** — 358
  `pi-codex-goal` entries, 222 `tool_execution_*`, 4 `queue_update` (including the
  user's "stop all subtask" follow-ups that were never delivered to pi).
- **Type-prefix separator gotcha**: pi event types use `/` after the plugin scope
  (`pi.ext:pi-mcp-adapter/status/v1`) but subagents use `:` throughout
  (`pi.ext:subagents:created`). The chokepoint's `recent` filter is a plain
  `startsWith`, so the mcp-mediator's prefix had to be `pi.ext:pi-mcp-adapter/`
  (slash), not `pi.ext:pi-mcp-adapter:` (colon).
- **pi-codex-goal does not emit custom events.** It stores goal state as
  `{type: "custom", customType: "pi-codex-goal"}` session entries (kinds `set` /
  `usage` / `clear` / `host_overflow_cap_reset`) that only appear in the `context`
  event's `messages` array — never in LLM context. The bridge synthesizes
  `pi.ext:codex-goal/state` + `pi.ext:codex-goal/entry` envelopes from them.
- **bb plugin slots have no always-on right-side panel.** The closest per-thread
  enrichment is `experimental_threadHeaderAction` (compact badge) + clicking it
  calls `useBbNavigate().openThreadPanel({actionId})` to open a
  `threadPanelAction` tab. Thread→pi-session correlation uses
  `bb.events.on("thread.created")` → `ThreadResponse.providerThreadId`.

## Open questions / unfinished work

1. **Push the monorepo upstream** — the original goal's final step; zero commits
   exist and the GitHub remote `grikomsn/bb-plugins` is empty.
2. **Upstream bb fix** — translate/filter the unhandled events in `provider-pi`
   (needs a bb release; the bridge now sidesteps most of the leak by forwarding
   all events over the socket).

## Resolved during this work

- **`pi-bb-bridge` extension not installed** — copied to
  `~/.pi/agent/extensions/pi-bb-bridge.ts` (auto-discovered by the embedded pi).
- **`BB_BRIDGE_SOCKET_PATH` never set** — chokepoint now publishes its socket
  path + token to `<tmpdir>/bb-plugin-pi-events-bridge.json`; the patched
  `bb-pi-bridge.mjs` exports them into the pi environment. **Verified live after
  a bb relaunch**: a real thread's session forwards lifecycle + third-party
  events keyed by its thread id, and a `/goal` thread's objective renders in
  `bb-plugin-pi-codex-goal` (status `active`, history 2).
- **`pi-events-bridge` socket-reload race** — stale socket file is unlinked on
  `EADDRINUSE` retry; `onDispose` no longer unlinks (was deleting the new
  server's socket file); double `listening` log deduped.
- **Session id capture** — the extension now emits `sessionId` top-level (was
  nested in the payload), so the chokepoint and consumer plugins key sessions
  by `thr_<id>`; the thread→session map falls back to the thread id because
  `providerThreadId` is null for pi.
- **Goal state in embedded sessions** — `context` events never fire in the
  RPC runtime, so the extension reads `sessionManager.getEntries()` on
  session start / turn start / turn end / agent settled and synthesizes
  `pi.ext:codex-goal/*` envelopes.
