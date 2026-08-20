# pi-bb-bridge

Pi extension that forwards lifecycle events (and the most-used third-party plugin
custom events) over a Unix socket to a bb-side consumer. Companion to
[`bb-plugin-pi-events-bridge`](../bb-plugin-pi-events-bridge/).

## What it forwards

**Built-in pi lifecycle** (all 35+ events exposed by the pi extension API):

- Session: `session_start`, `session_shutdown`, `session_info_changed`,
  `session_before_switch`, `session_before_fork`,
  `session_before_compact`, `session_compact`, `session_tree`
- Agent/turn: `before_agent_start`, `agent_start`, `agent_end`, `agent_settled`,
  `turn_start`, `turn_end`, `message_end`
- Tools: `tool_call`, `tool_result`
- Model: `model_select`, `thinking_level_select`

**Third-party plugin custom events** (forwarded as `pi.ext:<event>`):

| Source plugin | Events forwarded |
|---------------|------------------|
| `@tintinweb/pi-subagents` | `subagents:ready`, `subagents:created`, `subagents:started`, `subagents:completed`, `subagents:failed`, `subagents:steered`, `subagents:compacted`, `subagents:scheduled`, `subagents:scheduler_ready` |
| `@plannotator/pi-extension` | `plannotator:plan-approved`, `plannotator:plan-denied`, `plannotator:plan-changes-requested` |
| `pi-mcp-adapter` | `pi-mcp-adapter/status/v1`, `pi-mcp-adapter:tool-approval-request` |
| `pi-unified-exec` | `unified-exec:session-created`, `unified-exec:session-exited`, `unified-exec:session-output` |

## Wire format

One JSON object per line (newline-delimited JSON):

```json
{
  "seq": 42,
  "ts": "2026-08-19T18:00:00.000Z",
  "type": "pi.lifecycle:agent_start",
  "cwd": "/home/griko/proj",
  "sessionId": "session-2026-08-19-abc123",
  "payload": { "isIdle": false }
}
```

`seq` is a monotonically increasing counter across the lifetime of one pi
session — useful for replay / out-of-order detection on the consumer side.

## Configuration

All env vars; the extension is a no-op unless `BB_BRIDGE_SOCKET_PATH` is set:

| Var | Required | Purpose |
|-----|----------|---------|
| `BB_BRIDGE_SOCKET_PATH` | yes | Absolute path to the Unix socket (or named-pipe basename on Windows) |
| `BB_BRIDGE_TOKEN` | optional | Shared secret; first line carries it for consumer-side auth |
| `BB_BRIDGE_CWD` | optional | Override cwd to correlate with the bb thread |

The bb-side plugin (`bb-plugin-pi-events-bridge`) sets these when it spawns pi.

## Install

Drop the file into one of pi's auto-discovery locations:

```sh
# Global
cp index.ts ~/.pi/agent/extensions/pi-bb-bridge.ts

# Project-local
mkdir -p .pi/extensions && cp index.ts .pi/extensions/pi-bb-bridge.ts
```

Or install as a package and reference it from `settings.json`:

```json
{
  "packages": ["path:/home/griko/Workspace/grikomsn/pi-bb-bridge"]
}
```

## Behaviour

- **No-op by default.** Without `BB_BRIDGE_SOCKET_PATH` set, the extension
  registers no listeners and exits — safe to install globally and forget.
- **Auto-reconnect.** If the socket drops, it reconnects with 1.5–2s backoff.
  Buffered events (up to 500) are flushed on reconnect.
- **Fire-and-forget.** Writes never block pi; failed writes are dropped (we
  never want to slow the agent because the bb side is down).
- **Reduced payloads.** Tool args are forwarded as key lists (no values),
  prompts as 200-char previews, message contents as lengths — keeps the wire
  format small enough to ship over a Unix socket at every turn.
- **First-message auth.** When `BB_BRIDGE_TOKEN` is set, the very first line
  carries `{token, pid, host}` so the consumer can reject unauthorized
  connections before any further events are processed.

## Architecture

```
┌─────────────────┐         Unix socket           ┌──────────────────────────┐
│ pi + extension  │ ─────────────────────────────▶ │ bb-plugin-pi-events-bridge │
│                 │   {seq, type, cwd, payload}   │                          │
│                 │ ◀───────────────────────────── │  • re-emits on           │
│                 │      (optional acks)          │    bb.realtime.publish() │
└─────────────────┘                                └──────────────────────────┘
```

The bridge is intentionally one-way (pi → bb). The MCP mediator plugin
(`bb-plugin-mcp-mediator`) is the separate path for bb → pi communication
needed by `pi-mcp-adapter:tool-approval-request`.
