---
name: pi-codex-goal
description: Inspect the active pi-codex-goal state from inside bb — current objective, status, token usage, history, all-session view. Use when reviewing what the agent is currently working toward, checking progress against a token budget, or correlating goal changes with thread activity.
---

# Pi codex goal

Renders the active `pi-codex-goal` state in three places:

- **Nav panel "Codex Goal"** — full snapshot, per-session history (newest
  first), all-sessions overview.
- **Thread header badge** — compact status pill (active / paused /
  budgetLimited / complete / no goal).
- **Future** — composer banner; can be added via
  `app.composer.customize({banners: [...]})` once the host stabilises.

## How the data flows

1. `pi-codex-goal` writes its state as pi `CustomEntry` rows (customType:
   `"pi-codex-goal"`, data.kind: `set` / `usage` / `clear` / `host_overflow_cap_reset`).
2. `pi-bb-bridge` (the pi-side extension at `~/Workspace/grikomsn/pi-bb-bridge/`)
   subscribes to the `context` event, walks `event.messages`, replays the
   goal entries, and emits one `pi.ext:codex-goal/entry` envelope per
   CustomEntry plus a final `pi.ext:codex-goal/state` envelope with the
   rolled-up current goal.
3. `bb-plugin-pi-events-bridge` (the chokepoint) listens on the Unix
   socket, validates each envelope, and re-emits on bb.realtime.publish.
4. This plugin polls the chokepoint's `recent` RPC for the
   `pi.ext:codex-goal/*` prefix, keeps the per-session snapshot + history
   in memory, exposes them via `snapshot` / `history` / `allSnapshots` RPCs,
   and publishes a `pi/codex-goal/snapshot` realtime signal for the
   frontend.

## What it does NOT do

- Spawn new goals — use `/goal` in pi.
- Reset or modify goal state — read-only.
- Persist across bb reloads — state is in-memory; the source of truth is
  the pi session storage.
- Surface the goal to the LLM — that's `pi-codex-goal`'s job, which uses
  `appendMessage` (not `appendEntry`) for LLM-visible context.

## Install

```sh
cd ~/Workspace/grikomsn/bb-plugin-pi-codex-goal
bb plugin install .
```

Requires:
- `bb-plugin-pi-events-bridge` running
- `pi-bb-bridge` pi extension installed at `~/.pi/agent/extensions/pi-bb-bridge.ts`
- `pi-codex-goal` installed in pi
