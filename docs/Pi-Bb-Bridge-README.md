# Pi → bb event-bridging plugins

This workspace contains the components that make every pi extension event
(lifecycle + third-party plugin custom events) visible inside bb.

## Layout

```
~/Workspace/grikomsn/
├── pi-bb-bridge/                     # Pi-side extension (lives in ~/.pi/agent/extensions/)
│   └── index.ts                      # Forwards every pi event + 3rd-party event over a Unix socket
│
├── bb-plugin-pi-events-bridge/       # bb plugin (lives in bb plugins)
│   ├── server.ts                     # Listens on Unix socket, re-emits on bb.realtime
│   ├── app.tsx                       # Nav panel: status + live event inspector
│   └── skills/pi-events/SKILL.md
│
├── bb-plugin-pi-subagents-fleet/     # bb plugin (scaffolded)
│   └── skills/pi-subagents-fleet/SKILL.md
│
└── bb-plugin-mcp-mediator/           # bb plugin (scaffolded)
    └── skills/mcp-mediator/SKILL.md
```

## Install

```sh
# 1. Pi-side extension
mkdir -p ~/.pi/agent/extensions
cp ~/Workspace/grikomsn/pi-bb-bridge/index.ts \
   ~/.pi/agent/extensions/pi-bb-bridge.ts

# 2. bb-side consumer (the chokepoint — required by 3 and 4)
cd ~/Workspace/grikomsn/bb-plugin-pi-events-bridge
bb plugin install .

# 3. Optional: fleet view for @tintinweb/pi-subagents
cd ~/Workspace/grikomsn/bb-plugin-pi-subagents-fleet
bb plugin install .

# 4. Optional: MCP approval mediator for pi-mcp-adapter
cd ~/Workspace/grikomsn/bb-plugin-mcp-mediator
bb plugin install .
```

## How it works

```
┌─────────────────────┐
│ pi                  │
│  + pi-bb-bridge ext │
│  + any pi ext that  │
│    emits events     │
└─────────┬───────────┘
          │ JSONL over Unix socket
          │ (~/.tmp/bb-plugin-pi-events-bridge-…sock)
          ▼
┌──────────────────────────┐         ┌─────────────────────────────┐
│ bb-plugin-pi-events-     │ ──────▶ │ bb.realtime.publish(        │
│ bridge (server.ts)       │         │   "pi/lifecycle/...",       │
│                          │         │   "pi/ext/subagents/...",   │
│                          │         │   "pi/ext/pi-mcp-adapter/…" │
└──────────────────────────┘         │ )                           │
                                      └──────────────┬──────────────┘
                                                     │
                                  useRealtime(...)   │
                                                     ▼
                                      ┌─────────────────────────────┐
                                      │ bb frontend + other plugins │
                                      │ (fleet view, MCP mediator, …)│
                                      └─────────────────────────────┘
```

## Right-sidebar enrichment

The chokepoint tracks a `bbThreadId -> providerThreadId` mapping by listening
to `bb.events.on("thread.created" | "thread.active" | "thread.idle", ...)`.
Both consumer plugins resolve the current bb thread to its pi session via the
chokepoint's `threadSession({threadId})` RPC, then return the per-session
snapshot/fleet.

UI surface (per current thread):

- **`experimental_threadHeaderAction`** — a compact pill in the 48px chrome
  row. For goals: status + budget %; for subagents: active count. Clicking
  opens the corresponding right-panel tab.
- **`threadPanelAction`** — a closable right-panel tab. For goals: full
  objective, status pill, budget bar, token/time stats, recent history (last
  5). For subagents: one card per active sub-agent with type/model/elapsed/
  prompt preview, plus Steer/Stop buttons.

If a thread has no `providerThreadId` mapping (e.g. a non-pi thread), the
panels show a friendly empty state pointing the user at the nav-panel
"Goals" or "Subagents" page.

## Status

| Component | State | Notes |
|-----------|-------|-------|
| `pi-bb-bridge/` | ✅ Type-checks clean | Tested manually with `node` simulation; events flow into bb; reverse path added for steer/stop; `context` event handler synthesizes `pi.ext:codex-goal/{state,entry}` envelopes |
| `bb-plugin-pi-events-bridge/` | ✅ Installed and running | End-to-end test: events received, parsed, re-emitted on bb.realtime. Drain service pushes commands back over the same socket. `recent` RPC filtered by typePrefix and sessionId. Tracks `bbThreadId -> providerThreadId` map; `threadSession` RPC exposed. |
| `bb-plugin-pi-subagents-fleet/` | ✅ Installed and running | Polls chokepoint's `recent` RPC for `pi.ext:subagents/*`; renders nav panel + thread header pill + right-panel thread tab with per-thread sub-agent list; steer/stop round-trips via chokepoint's `enqueueCommand` RPC |
| `bb-plugin-mcp-mediator/` | ✅ Installed and running | Polls `pi.ext:pi-mcp-adapter/*`; renders server-status table + approval queue; Allow/Deny/Always decisions flow back via chokepoint's `enqueueCommand` |
| `bb-plugin-pi-codex-goal/` | ✅ Installed and running | Walks `pi.lifecycle:context` events from the bridge, replays pi-codex-goal `CustomEntry` rows, emits synthesized `pi.ext:codex-goal/state` + `pi.ext:codex-goal/entry` envelopes; renders nav panel + thread header pill + right-panel thread tab with per-thread goal (status, budget bar, history) |

## Reverse path (commands: bb → pi)

Both `pi-subagents-fleet` and `mcp-mediator` push commands back to the pi
side via:

1. Plugin calls `bb.sdk.plugins.callRpc({pluginId: "pi-events-bridge", method: "enqueueCommand", input: {...}})`.
2. Chokepoint persists into `bb.storage.kv` (key prefix `cmd:`) and acks.
3. Chokepoint's `drain-commands` background service runs every 250ms, reads
   each `cmd:` key, writes a `bb.bridge:command` envelope over every
   connected socket, and deletes the key.
4. `pi-bb-bridge` reads the envelope from the same socket, dispatches the
   command via `pi.events.emit("subagents:rpc:<command>", {requestId, ...})`,
   listens on `subagents:rpc:<command>:reply:<requestId>` for the ack (with a
   5s timeout), and writes a `bb.bridge:command-ack` back to bb with the reply.
5. Chokepoint logs the delivery.

## End-to-end test results

Verified live with `node` simulators sending events over the bridge socket:

- **pi-events-bridge**: 6 events received, parsed via Zod, re-emitted on
  `bb.realtime.publish`, tracked in per-session ring buffers.
- **pi-subagents-fleet**: poll #1 fetched 4 subagent events, fleet state
  populated, steer/stop RPCs enqueue commands back through the chokepoint.
- **mcp-mediator**: poll #5 fetched 2 mcp events (status snapshot + approval
  request), server list and pending-approval queue populated, decision RPC
  enqueues back through the chokepoint.

## Type-prefix gotcha

Pi event names use **slash** for nested namespaces (`pi-mcp-adapter/status/v1`)
but **colon** for flat names (`subagents:created`). The chokepoint's `recent`
RPC uses literal `String.startsWith`, so the typePrefix filter must match the
actual separator:

- `pi.ext:subagents:` (colon — flat namespace)
- `pi.ext:pi-mcp-adapter/` (slash — nested namespace)
- `pi.ext:plannotator:plan-approved` (colon — flat namespace)

Using the wrong separator causes the filter to silently reject all events.
This was the root cause of an early debugging session where the mcp mediator
saw 0 events despite the chokepoint receiving them.

## What flows through the chokepoint

Every one of these is captured automatically once both the pi extension and
the bb plugin are installed:

**Pi lifecycle** (all built-in events):
`session_start`, `session_shutdown`, `session_info_changed`,
`session_before_switch`, `session_before_fork`, `session_before_compact`,
`session_compact`, `session_tree`, `before_agent_start`, `agent_start`,
`agent_end`, `agent_settled`, `turn_start`, `turn_end`, `message_end`,
`tool_call`, `tool_result`, `model_select`, `thinking_level_select`

**Third-party plugin custom events**:
- `@tintinweb/pi-subagents` → `pi/ext/subagents/{ready,created,started,completed,failed,steered,compacted,scheduled,scheduler_ready}`
- `@plannotator/pi-extension` → `pi/ext/plannotator/{plan-approved,plan-denied,plan-changes-requested}`
- `pi-mcp-adapter` → `pi/ext/pi-mcp-adapter/{status/v1,tool-approval-request}`
- `pi-unified-exec` → `pi/ext/unified-exec/{session-created,session-exited,session-output}`

## Verifying the bridge is alive

```sh
# Is the socket listening?
ss -l | grep bb-plugin-pi-events

# Plugin health
bb plugin logs pi-events-bridge -f

# Plugin list confirms it's running
bb plugin list | grep pi-events-bridge
```
