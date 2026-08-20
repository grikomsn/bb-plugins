---
name: mcp-mediator
description: Mediate pi-mcp-adapter approval requests through bb.ui and surface MCP server status. Use when an MCP tool call needs user approval, when you want a live view of which MCP servers are connected, or when triaging why an MCP tool call failed.
---

# Pi MCP mediator

Bridges `pi-mcp-adapter` events into bb's UI:

- `pi-mcp-adapter/status/v1` → renders a connected-servers table in the
  plugin's nav panel
- `pi-mcp-adapter/tool-approval-request` → opens a `bb.ui.requestInput`
  dialog and resolves back to the pi side over the bridge socket

## Approval flow

```
pi + pi-mcp-adapter          bb-plugin-mcp-mediator        bb frontend
      │                              │                          │
      │ emit approval-request        │                          │
      ├─────────────────────────────▶│                          │
      │                              │ bb.ui.requestInput       │
      │                              ├─────────────────────────▶│
      │                              │ user clicks Allow/Deny   │
      │                              │◀─────────────────────────┤
      │ write {action: allow} line   │                          │
      │◀─────────────────────────────┤                          │
      │ resume tool call             │                          │
```

The reverse channel is a *write* on the same Unix socket used by
`bb-plugin-pi-events-bridge`; this plugin writes an envelope of the form:

```json
{"seq": 99, "ts": "...", "type": "bb.bridge:approval-response",
 "cwd": "...", "sessionId": "...",
 "payload": {"approvalId": "apr-1234", "action": "allow"}}
```

The `pi-bb-bridge` extension picks that line up off the same socket and
forwards the approval decision back to `pi-mcp-adapter` via a pending
reply envelope.

## What it does NOT do

- Configure MCP servers — that's done via `pi-mcp-adapter`'s own
  `--mcp-config` flag or `/mcp` command.
- Persist approval decisions across bb reloads — they're session-scoped.
- Mediate tool *results* — only approval requests.
