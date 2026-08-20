# bb-plugin-pi-subagents-fleet

Live fleet view of `@tintinweb/pi-subagents` sub-agents running inside the
connected pi session. Built on top of [`bb-plugin-pi-events-bridge`](../bb-plugin-pi-events-bridge/).

## What it does

- **Renders** every active sub-agent (started/running/steered) as a card with
  live status, type badge, model, prompt preview, elapsed time, steer count.
- **Steers** a running sub-agent by sending a follow-up message (uses the
  chokepoint's command queue, which the pi extension forwards over the bridge
  socket).
- **Stops** a sub-agent by enqueueing a stop command.
- **Re-publishes** fleet snapshots on `pi/subagents-fleet/snapshot` for any
  other plugin to subscribe via `useRealtime`.
- **Persists** sub-agent state in-memory with bounded retention (default 500,
  configurable). Completed/failed/compacted sub-agents drop off when retention
  is exceeded; live ones never drop.

## Install

```sh
cd ~/Workspace/grikomsn/bb-plugin-pi-subagents-fleet
bb plugin install .
```

Requires `bb-plugin-pi-events-bridge` to be installed and running so the
plugin can poll sub-agent events from it. If you haven't yet:

```sh
cd ~/Workspace/grikomsn/bb-plugin-pi-events-bridge
bb plugin install .
```

The pi-side `pi-bb-bridge` extension and `@tintinweb/pi-subagents` are also
required for the events to exist in the first place.

## Architecture

```
pi (@tintinweb/pi-subagents running)
   │   emits subagents:* events
   ▼
pi-bb-bridge (pi extension)  ──socket──▶  pi-events-bridge (bb plugin)
                                                          │
                                       bb.sdk.plugins     │ stores in
                                       .callRpc("recent") │ ring buffer
                                                          ▼
                                            THIS plugin (polls every 1s)
                                                          │
                                            bb.realtime.publish(          │
                                              "pi/subagents-fleet/        │
                                               snapshot",                 │
                                              { activeCount, active: [] }│
                                                          ▼
                                              frontend fleet view + cards
                                                          │
                                            click "Steer" / "Stop"       │
                                                          │
                                            bb.sdk.plugins                │
                                            .callRpc("steer" | "stop")    │
                                                          │
                                            enqueue to bb.storage.kv     │
                                            ("command-queue")             │
                                                          │
                                            pi-events-bridge reads       │
                                            queue, writes back over       │
                                            the same socket as            │
                                            "bb.bridge:command" envelope  │
                                                          │
                                            pi-bb-bridge extension       │
                                            forwards to subagents RPC     │
```

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `maxRetained` | 500 | Drop oldest completed sub-agents when count exceeds this |
| `typeFilter` | empty | Comma-separated list of sub-agent types to show; empty = all |

## Why polling and not realtime subscribe?

`bb.realtime.publish` in the backend is **publish-only** in V1 (no per-channel
subscription API). `useRealtime` is frontend-only. Backend plugins can only
subscribe to the six thread lifecycle events (`bb.events.on`) or the seven
entity-changed events (`bb.sdk.subscribe`). The cleanest cross-plugin channel
is therefore **`bb.sdk.plugins.callRpc`** — the chokepoint plugin exposes a
`recent` RPC method that returns buffered events, and this plugin polls it
every second.

The polling interval is configurable in `server.ts` (`POLL_INTERVAL_MS`).
One second is fine for sub-agent lifecycle (low frequency); tighten to 250ms
if you find it laggy.

## Steer / Stop reverse path

Because backend plugins cannot push to the pi side over `bb.realtime`, this
plugin writes steer/stop requests to `bb.storage.kv["command-queue"]`. The
**chokepoint plugin reads that queue** and writes each command back over the
same Unix socket as a `bb.bridge:command` envelope. The pi-side
`pi-bb-bridge` extension picks it up and dispatches via the cross-extension
RPC bus (`subagents:rpc:steer` / `subagents:rpc:stop`).

This is a **two-plugin contract**: the chokepoint must agree to drain the
command queue. If you're running an older version of the chokepoint without
this support, steer/stop will silently no-op.

## Manual test

```sh
bb plugin install .
bb plugin logs pi-subagents-fleet -f

# In another terminal, simulate a sub-agent by sending events over the
# bridge socket (the chokepoint will log them):
node -e '
  const net = require("net");
  const sock = net.createConnection("/tmp/bb-plugin-pi-events-bridge-pi-events-bridge.sock");
  sock.on("connect", () => {
    sock.write(JSON.stringify({seq:0,ts:new Date().toISOString(),type:"bb.bridge:hello",cwd:"/tmp",payload:{}})+"\n");
    sock.write(JSON.stringify({seq:1,ts:new Date().toISOString(),type:"pi.ext:subagents:created",cwd:"/tmp",sessionId:"s1",payload:{id:"sa-1",type:"Explore",prompt:"find auth files"}}) + "\n");
    sock.write(JSON.stringify({seq:2,ts:new Date().toISOString(),type:"pi.ext:subagents:started",cwd:"/tmp",sessionId:"s1",payload:{id:"sa-1"}}) + "\n");
    setTimeout(() => sock.end(), 200);
  });
'
```

The fleet plugin's log should show `polling pi-events-bridge every 1000ms`
and the frontend fleet view should show one card within ~1s.
