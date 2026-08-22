# bb-plugin-pi-events-bridge

Forwards pi extension events (lifecycle + the most-used third-party plugins)
over a Unix socket into bb realtime, so any bb plugin or the bb frontend can
subscribe per source.

Companion to [`pi-bb-bridge`](../pi-bb-bridge/) — install **both**: the pi
extension ships events from the pi process; this plugin listens and re-emits.

## Install

```sh
# in this directory
bb plugin install .

# install the pi-side companion
mkdir -p ~/.pi/agent/extensions
cp ../pi-bb-bridge/index.ts ~/.pi/agent/extensions/pi-bb-bridge.ts
```

The plugin loads immediately; the pi extension is a no-op until
`BB_BRIDGE_SOCKET_PATH` points at this plugin's socket (the path is shown in
the plugin's settings page after install).

## What it forwards

See [`skills/pi-events/SKILL.md`](./skills/pi-events/SKILL.md) for the full
event taxonomy. In short:

- **Lifecycle** — every event the pi extension API exposes (sessions, agents,
  turns, messages, tools, models)
- **Third-party plugin custom events** — re-emitted on
  `pi/ext/<plugin>/<event>` channels:
  - `@tintinweb/pi-subagents` → `pi/ext/subagents/*`
  - `@plannotator/pi-extension` → `pi/ext/plannotator/plan-*`
  - `pi-mcp-adapter` → `pi/ext/pi-mcp-adapter/status/v1`,
    `pi/ext/pi-mcp-adapter/tool-approval-request`
  - `pi-unified-exec` → `pi/ext/unified-exec/*`

## Wire protocol

Newline-delimited JSON, one event per line:

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

The plugin validates every line with a Zod schema and drops malformed
messages without disconnecting.

## RPC surface

```ts
// status — connection state + auth token (if auto-generated)
const s = await rpc.call("status");
// { connected, socketPath, sessionCount, lastEventAt, bufferedSeqs, authToken }

// recent — last N events, newest first; filterable
const { events } = await rpc.call("recent", { limit: 50, typePrefix: "pi.ext:" });

// sessions — per-session state tracked from incoming events
const { sessions } = await rpc.call("sessions");
```

## Reacting from another plugin

```ts
// In a bb plugin's server.ts factory:
bb.realtime.subscribe?.(); // not all bb versions expose subscribe on realtime;
// the canonical path is the SDK:

const unsubscribe = bb.sdk.subscribe({
  event: "thread:changed",          // thread entity changes
  callback: ({ payload }) => { /* … */ },
});

// Or via app.tsx:
useRealtime("pi/ext/subagents/created", (msg) => {
  // msg.payload contains the forwarded event
});
```

The plugin publishes every event on a hierarchical channel under `pi/` so
the frontend can subscribe to a subset without parsing every line.

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `ringCapacity` | 500 | Max events kept per session for replay |
| `authToken` | (empty) | Shared secret; if empty, an auto-generated one is used (visible in `rpc.status.authToken`) |
| `socketPath` | `tmpdir()/bb-plugin-pi-events-bridge-<id>.sock` | Unix socket path override |

## Architecture

```
pi + pi-bb-bridge extension             bb-plugin-pi-events-bridge
�─────────────────────────┐   Unix     ┌──────────────────────────────┐
│ pi.on("session_start")  │ socket     │ net.createServer             │
│ pi.on("tool_call")      │ ◀──────▶  │ Zod-validate                 │
│ pi.on("…")              │   JSONL    │ session-key by sessionId+cwd │
│                          │            │ ring-buffer (replay)         │
│ pi.events.on("subagents │            │ bb.realtime.publish          │
│   :created", …)         │            │ bb.realtime.publish          │
│ pi.events.on("plann…    │            │ …                            │
│   :plan-approved", …)   │            │ bb.rpc.status/recent/sessions│
└─────────────────────────┘            └──────────────────────────────┘
```

## Why a Unix socket (not WebSocket / WS)?

- **Pi lives in a TUI**, bb lives in the browser/server. A Unix socket is the
  lightest transport that crosses the bb host's process boundary without
  depending on the bb HTTP server being reachable from where pi runs.
- **Token auth on the first message** — the pi side sends
  `BB_BRIDGE_TOKEN=<value>` on connect; the bb side rejects mismatches
  before any event is processed.
- **Same-machine default; cross-machine via `bb connect`** — when the user
  runs pi on a remote enrolled host, the bb plugin can declare a shared
  port (`bb.hosts.declareSharedPorts`) and the host daemon tunnels it back.
