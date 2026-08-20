---
name: pi-subagents-fleet
description: Live fleet view of @tintinweb/pi-subagents sub-agents. Use when running the parent pi session, want to see which sub-agents are active, read or steer any sub-agent's conversation, or correlate sub-agent token spend with the parent's tokens.
---

# Pi sub-agents fleet

Renders every active `@tintinweb/pi-subagents` sub-agent as a card with its
own `ThreadChat`-bound conversation. Subscribes to
`bb-plugin-pi-events-bridge`'s realtime channels:

- `pi/ext/subagents/created`
- `pi/ext/subagents/started`
- `pi/ext/subagents/completed`
- `pi/ext/subagents/failed`
- `pi/ext/subagents/steered`
- `pi/ext/subagents/compacted`

## What it does

- **Fleet view** — one card per active sub-agent, with live status, type
  badge (Explore / Plan / general-purpose / custom), model, tokens, elapsed
  time.
- **Open conversation** — clicking a card opens the sub-agent's thread in a
  side panel using the plugin's `threadPanelAction`.
- **Steer** — inline composer that sends a user message back to the running
  sub-agent via `subagents:rpc:steer` (when the parent extension exposes it).
- **Stop** — sends `subagents:rpc:stop` and marks the card `failed`.
- **Group join notifications** — when multiple sub-agents complete in the
  same parent turn, renders one consolidated notification (per the parent
  extension's `group_join` semantics).

## What it does NOT do

- Spawn new sub-agents from bb — that's the parent's responsibility.
- Modify sub-agent tool allowlists — those are pinned at definition time.
- Persist sub-agent transcripts across bb reloads — they're stored in the
  parent's pi session storage; this plugin is observe-and-mediate only.

## Install

Requires:

1. `bb-plugin-pi-events-bridge` installed and running (for the realtime
   channels).
2. `pi-bb-bridge` pi extension installed (to actually emit events).
3. `@tintinweb/pi-subagents` installed in pi (otherwise the subagent events
   never fire).
