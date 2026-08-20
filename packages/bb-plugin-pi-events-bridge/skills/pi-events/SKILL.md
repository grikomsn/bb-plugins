---
name: pi-events
description: Inspect and react to events forwarded from pi extensions (including third-party plugins like pi-subagents, plannotator, pi-mcp-adapter, pi-unified-exec). Use when debugging a pi TUI session, monitoring sub-agent fleets, surfacing MCP approval requests, or correlating bb threads with the pi session that drove them.
---

# Pi events bridge

Companion to the `pi-bb-bridge` pi extension at
`~/Workspace/grikomsn/pi-bb-bridge/`. Together they forward pi lifecycle
events and the most-used third-party plugin custom events over a Unix socket
into bb's realtime plane.

## What flows

**Built-in pi lifecycle** (every event the pi extension API exposes):

- Session: `session_start`, `session_shutdown`, `session_info_changed`,
  `session_before_switch`, `session_before_fork`,
  `session_before_compact`, `session_compact`, `session_tree`
- Agent/turn: `before_agent_start`, `agent_start`, `agent_end`,
  `agent_settled`, `turn_start`, `turn_end`, `message_end`
- Tools: `tool_call`, `tool_result`
- Model: `model_select`, `thinking_level_select`

**Third-party plugin events** (forwarded as `pi/ext/...` realtime channels):

- `@tintinweb/pi-subagents`: `subagents/ready`, `subagents/created`,
  `subagents/started`, `subagents/completed`, `subagents/failed`,
  `subagents/steered`, `subagents/compacted`, `subagents/scheduled`
- `@plannotator/pi-extension`: `plannotator/plan-approved`,
  `plannotator/plan-denied`, `plannotator/plan-changes-requested`
- `pi-mcp-adapter`: `pi-mcp-adapter/status/v1`,
  `pi-mcp-adapter/tool-approval-request`
- `pi-unified-exec`: `unified-exec/session-created`,
  `unified-exec/session-exited`, `unified-exec/session-output`

## How to inspect

The plugin ships a `status` and `recent` RPC. From any bb context:

```
bb plugin call rpc pi-events-bridge status          # connection + session count
bb plugin call rpc pi-events-bridge recent '{"limit": 20}'
bb plugin call rpc pi-events-bridge sessions
```

The frontend ships an Events tab on the plugin's nav panel that shows the
last 200 events grouped by source (`lifecycle`, `ext`, `bridge`).

## How to react from another plugin

```ts
const unsubscribe = bb.realtime.subscribe({
  event: "thread:changed",   // or pi/ext/subagents/created for raw
  callback: ({ payload }) => {
    // ...
  },
});
```

Or via the SDK realtime client:

```ts
await bb.sdk.subscribe({
  event: "thread:changed",
  callback: ({ payload }) => { /* ... */ },
});
```

## When to use this skill

- Debugging "what is pi doing right now" from the bb side.
- Building UI for sub-agent fleets, MCP approvals, or plan review status.
- Correlating a bb thread's events with the originating pi session.
- Auditing tool overrides (e.g. `@ff-labs/pi-fff` replacing `grep`/`find`).

## When NOT to use this skill

- Streaming live pi output as chat messages — use `bb.sdk.threads.send`
  instead, or the `provider-pi` builtin bridge.
- Editing session state directly — use `provider-pi`'s native thread tools.
- For non-pi providers (codex, claude-code, etc.) — those emit the bridge
  vocabulary natively; this plugin only adds visibility for pi extensions.
