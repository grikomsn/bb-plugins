# bb-plugin-pi-codex-goal

Renders the active `pi-codex-goal` state in bb: current objective, status,
token usage, history, and a per-session overview. Built on top of
`bb-plugin-pi-events-bridge`.

## Why this plugin exists

`pi-codex-goal` is a third-party pi extension that tracks a long-running
"goal" — a stateful objective the agent is working toward with token-budget
accounting. It stores all state in pi `CustomEntry` rows, NOT in custom
events on the pi events bus, so it's invisible to any plugin that only
listens to the standard `pi.ext:*` channels.

This plugin closes the gap: `pi-bb-bridge` (the pi-side companion in this
workspace) walks the `context` event's message array, replays the goal
entries, and synthesizes `pi.ext:codex-goal/entry` (per CustomEntry) plus
`pi.ext:codex-goal/state` (rolled-up snapshot) envelopes on the bridge
socket. This plugin consumes them.

## What it shows

- **Active goal** — objective text, status pill (active / paused /
  budgetLimited / complete), token usage, budget bar, last-updated
  timestamp.
- **History** — every goal entry in reverse-chronological order with
  kind, source (`command` / `tool` / `runtime`), objective preview,
  and live token count.
- **All sessions** — when multiple pi sessions report goal state, list
  each one with its own status.
- **Settings section** — the full state above lives under this plugin's
  page in bb's main Settings (no sidebar entry on the bb main rail).
- **Thread header badge** — a compact status pill in the 48px thread
  header, shown only when the goal for the current thread is `active`.
  Green/amber/orange based on the live status.

## Install

```sh
# 1. Pi extension (if not already installed)
mkdir -p ~/.pi/agent/extensions
cp ../pi-bb-bridge/index.ts ~/.pi/agent/extensions/pi-bb-bridge.ts

# 2. The chokepoint (if not already installed)
cd ../bb-plugin-pi-events-bridge && bb plugin install .

# 3. This plugin
cd ../bb-plugin-pi-codex-goal && bb plugin install .
```

Requires `pi-codex-goal` to be installed in pi (otherwise no `pi-codex-goal`
CustomEntry rows ever exist, and the plugin shows the empty state).

## Architecture

```
pi + pi-codex-goal writing CustomEntry rows
   ▼
pi-bb-bridge: context event → walk messages → emit
   {pi.ext:codex-goal/entry, pi.ext:codex-goal/state}
   ──socket──▶  pi-events-bridge (chokepoint)
                       │   bb.realtime.publish + ring buffer
                       ▼
                bb-plugin-pi-codex-goal (this plugin)
                  polls "pi.ext:codex-goal/" via RPC
                       │
                  bb.realtime.publish("pi/codex-goal/snapshot")
                       ▼
                frontend settings section + thread header badge
```

## RPC surface

```ts
// Current snapshot (optionally for a specific session)
const r = await rpc.call("snapshot", { parentSessionId?: "..." });
// { source, snapshot: { goal, historyCount, objectivePreview, ts }, sessionId, sessionIds }

// History (newest first)
const h = await rpc.call("history", { limit: 50 });
// { source, entries: [{kind, at, source, goalId, objective, status, tokensUsed, activeSeconds}] }

// All known sessions
const a = await rpc.call("allSnapshots");
// { snapshots: [{sessionId, goal, historyCount, ts}] }
```

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `alwaysShowBanner` | true | (placeholder; banner UI ships when bb adds composer banners stably) |
| `emitOnClear` | true | Emit a realtime snapshot when the goal clears |

## How the synthesized events look

```
{seq, ts, type: "pi.ext:codex-goal/entry", cwd, sessionId,
 payload: {kind: "set" | "usage" | "clear",
           at, source?: "command" | "tool" | "runtime",
           goalId?: string,
           objective?: string,
           status?: "active" | "paused" | "budgetLimited" | "complete",
           tokensUsed?: number,
           activeSeconds?: number}}

{seq, ts, type: "pi.ext:codex-goal/state", cwd, sessionId,
 payload: {goal: ThreadGoal | null,
           historyCount: number,
           objectivePreview: string | null}}
```

The `state` event is the rolled-up current goal (matching pi-codex-goal's
`SessionGoal` shape minus the `version: 1` envelope). The `entry` events
are the raw CustomEntry rows, useful for the history view.
