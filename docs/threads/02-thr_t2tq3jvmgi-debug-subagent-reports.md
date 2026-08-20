# Thread `thr_t2tq3jvmgi` — Debug missing subagent reports

> **Status:** idle · **Project:** proj_personal · **Environment:** env_y58qtxjruz
> **Created:** 2026-08-20 ~05:30 UTC · **Last updated:** 2026-08-20 06:23 UTC
> **Forked from:** none (spawned while waiting on `thr_xwdzm5raqz`)

## Summary

Spawned while `thr_xwdzm5raqz` sat idle to debug why subagents weren't reporting
and why unhandled pi events were leaking. Produced a definitive root-cause analysis
of the broken bridge chain. Ended with an unanswered decision request (write the
`host.js` workaround?).

## User prompt

> while waiting for @thread:thr_xwdzm5raqz, debug why subagents aren't reporting properly and various unhandled pi events are leaking, cause thread is technically still in progress waiting for subagents but not reported properly

## Research results (the full diagnosis)

### Why subagents aren't reporting

**The chain `pi → pi-bb-bridge → pi-events-bridge → pi-subagents-fleet / pi-codex-goal` is broken at the very first hop.**

- `bb-plugin-pi-events-bridge` (the chokepoint) is healthy — socket listening at
  `/tmp/bb-plugin-pi-events-bridge-pi-events-bridge.sock`, `connected: true`. But its
  sessions list shows only the `/tmp` "monorepo-test" smoke-test traffic (3 events).
  **Zero events from `thr_xwdzm5raqz` ever reached it.**
- `pi-bb-bridge` (the pi-side extension) is a **no-op** unless the env var
  `BB_BRIDGE_SOCKET_PATH` is set:

  ```ts
  // pi-bb-bridge/index.ts:41
  function enabled(): boolean {
    return !!SOCKET_PATH;   // ← never true, so the extension registers no listeners
  }
  ```

- **Nothing in bb 0.39.0 sets `BB_BRIDGE_SOCKET_PATH` when launching pi.** Grepped
  the entire bundled bb code (`bb-app/host-daemon/dist/daemon-bundle.mjs`,
  `bb-app/server/dist/index.js`, `provider-pi/dist/server.js`) — **zero hits** on
  `BB_BRIDGE_SOCKET_PATH` or `BB_BRIDGE_TOKEN`.
- The env vars are supposed to be set by a per-provider **host bridge worker**
  (`host.js`). Comparison:

  | provider | `package.json` has `"host"`? | devDeps include `@bb/provider-bridge-protocol`? | `dist/host.js` ships? |
  |---|---|---|---|
  | `provider-codex` | ✅ `./dist/host.js` | ✅ | ✅ |
  | `provider-acp` | ✅ `./dist/host.js` | ✅ | ✅ |
  | `provider-claude-code` | ✅ `./dist/host.js` | ✅ | ✅ |
  | **`provider-pi`** | **❌ missing** | **❌ missing** | **❌ missing** |

- `bb-app/server/dist/builtin-plugins/provider-pi/package.json` only declares
  `server` and `app` — no `host`. The bundled `dist/` has no `host.js`. The
  fallback bridge file at `bb-app/host-daemon/dist/bb-pi-bridge.mjs` is a 55-line
  stub that looks like minified Zod, not a real worker. So no provider-pi bridge
  worker exists in the bb install, and pi runs without the env vars.
- The `pi-bb-bridge/README.md` is wrong — it says *"The bb-side plugin
  (`bb-plugin-pi-events-bridge`) sets these when it spawns pi."* That plugin only
  runs a Unix-socket listener; it doesn't spawn anything.

### Why unhandled events leak

bb provider-pi successfully translates the SDK messages it knows into bb-native
events (3,882 `item/agentMessage/delta`, 788 `item/started`, 516 `item/completed`,
2,063 `item/toolCall/progress`, 12 turns, etc.). But it doesn't translate:

| unhandled `rawEvent.message.type` | count | what it should become |
|---|---|---|
| `entry_appended` (all `customType: "pi-codex-goal"`) | 358 | `item/started` + `item/completed` of a new `item_kind: "custom"` with `customType` and `data` |
| `tool_execution_start` / `_update` / `_end` | 222 | the existing `item/toolCall/*` lifecycle (or a parallel one) |
| `queue_update` (incl. "stop all subtask", "is subtask still in progress?") | 4 | a bb-native queue event so the bb UI can show pending follow-ups/steering |
| `message_start`, `message_end`, `session_info_changed` | 5 | misc |

These are stored in bb.db as `provider/unhandled` events with the raw JSON-RPC
envelope preserved (the 358 pi-codex-goal entries are fully readable, but
`bb-plugin-pi-codex-goal` never sees them because it only polls the chokepoint, not
bb.events).

### Why the thread looks idle but isn't

- bb side: thread status `idle` (the turn is over, the model stopped calling tools).
- pi side: long-since shut down (last turn ended ~12h earlier at
  `1787206131` = `2026-08-20T06:08:51Z`).
- The user's "stop all subtask" follow-ups did get persisted in `queue_update`
  unhandled events, but bb never delivered them to pi (no bridge, no socket, no
  delivery).

## Proposed fixes (never actioned — awaiting user decision)

1. **Layer 2 (workaround): write a `host.js` for provider-pi** — ~100 lines. Reads
   `bb.sdk.plugins.callRpc("pi-events-bridge", "status")` for the socket path and
   token, then `child_process.spawn("pi", args, { env: { ...process.env,
   BB_BRIDGE_SOCKET_PATH, BB_BRIDGE_TOKEN, BB_BRIDGE_CWD } })`. Ship as a one-off
   patch in the bb-plugins repo or a hot-patch over the bundled
   `bb-app/server/dist/builtin-plugins/provider-pi/`. *Re-lights the bridge on the
   next pi spawn.*
2. **Layer 3 (local small fix): tighten `pi-events-bridge`'s socket-reload race** —
   logs two "listening at" lines per reload and hits `EADDRINUSE` every time.
   Trivial patch.
3. **Layer 1 (upstream bb): filter or translate the unhandled events** — needs a bb
   release. Out of scope, worth filing.

---

## Full transcript

```
── User ────────────────────────────────────────────────────
while waiting for @thread:thr_xwdzm5raqz, debug why subagents aren't reporting properly and various unhandled pi events are leaking, cause thread is technically still in progress waiting for subagents but not reported properly

── Provisioned thread ──────────────────────────────────────
  Preparing personal workspace
  Using workspace: /home/griko/.bb/personal-workspaces/env_y58qtxjruz

── Worked for (12m 57s) ────────────────────────────────────

── Assistant ───────────────────────────────────────────────
Here's what I found while the thread sits idle:

## Why subagents aren't reporting

**The chain `pi → pi-bb-bridge → pi-events-bridge → pi-subagents-fleet / pi-codex-goal` is broken at the very first hop.**

`bb-plugin-pi-events-bridge` (the chokepoint) is healthy — its socket is listening at `/tmp/bb-plugin-pi-events-bridge-pi-events-bridge.sock`, status `connected: true`. But its sessions list shows only your `/tmp` "monorepo-test" smoke-test traffic (3 events). Zero events from `thr_xwdzm5raqz` ever reached it.

`pi-bb-bridge` (the pi-side extension) is a **no-op** unless the env var `BB_BRIDGE_SOCKET_PATH` is set:

```ts
// pi-bb-bridge/index.ts:41
function enabled(): boolean {
  return !!SOCKET_PATH;   // ← never true, so the extension registers no listeners
}
```

**Nothing in bb 0.39.0 sets `BB_BRIDGE_SOCKET_PATH` when launching pi.** I grepped the entire bundled bb code (`bb-app/host-daemon/dist/daemon-bundle.mjs`, `bb-app/server/dist/index.js`, `provider-pi/dist/server.js`) — **zero hits** on `BB_BRIDGE_SOCKET_PATH` or `BB_BRIDGE_TOKEN`.

The env vars are supposed to be set by a per-provider **host bridge worker** (`host.js`). Compare:

| provider | `package.json` has `"host"`? | devDeps include `@bb/provider-bridge-protocol`? | `dist/host.js` ships? |
|---|---|---|---|
| `provider-codex` | ✅ `./dist/host.js` | ✅ | ✅ |
| `provider-acp` | ✅ `./dist/host.js` | ✅ | ✅ |
| `provider-claude-code` | ✅ `./dist/host.js` | ✅ | ✅ |
| **`provider-pi`** | **❌ missing** | **❌ missing** | **❌ missing** |

`bb-app/server/dist/builtin-plugins/provider-pi/package.json` only declares `server` and `app` — no `host`. The bundled `dist/` has no `host.js`. The fallback bridge file at `bb-app/host-daemon/dist/bb-pi-bridge.mjs` is a 55-line stub that looks like minified Zod, not a real worker. So no provider-pi bridge worker exists in the bb install, and pi therefore runs without the env vars.

The `pi-bb-bridge/README.md` is wrong — it says *"The bb-side plugin (`bb-plugin-pi-events-bridge`) sets these when it spawns pi."* That plugin only runs a Unix-socket listener; it doesn't spawn anything.

## Why unhandled events leak

bb provider-pi successfully translates the SDK messages it knows into bb-native events (3,882 `item/agentMessage/delta`, 788 `item/started`, 516 `item/completed`, 2,063 `item/toolCall/progress`, 12 turns, etc.). But it doesn't translate:

| unhandled `rawEvent.message.type` | count | what it should become |
|---|---|---|
| `entry_appended` (all `customType: "pi-codex-goal"`) | 358 | `item/started` + `item/completed` of a new `item_kind: "custom"` with `customType` and `data` |
| `tool_execution_start` / `_update` / `_end` | 222 | the existing `item/toolCall/*` lifecycle (or a parallel one) |
| `queue_update` (incl. "stop all subtask", "is subtask still in progress?") | 4 | a bb-native queue event so the bb UI can show pending follow-ups/steering |
| `message_start`, `message_end`, `session_info_changed` | 5 | misc |

I confirmed these are stored in bb.db as `provider/unhandled` events with the raw JSON-RPC envelope preserved (the 358 pi-codex-goal entries are sitting there, fully readable, but the bb-plugin-pi-codex-goal plugin never sees them because it only polls the chokepoint, not bb.events).

## Why the thread looks idle but isn't

- bb side: thread status `idle` (the turn is over, the model stopped calling tools).
- pi side: probably long-since shut down (the last turn ended ~12h ago at `1787206131` = `2026-08-20T06:08:51Z`, which matches `lastEventAt` on the chokepoint — that's the test session though; the real pi session never sent anything to the chokepoint).
- The user's "stop all subtask" follow-ups did get persisted in `queue_update` unhandled events, but bb never delivered them to pi (no bridge, no socket, no delivery).

## What I haven't done yet (waiting on your call)

Two of the three layers are upstream (bb itself) and one is a small local fix. Pick what you want me to do:

1. **Layer 2 (workaround): write a `host.js` for provider-pi** — about 100 lines. Reads `bb.sdk.plugins.callRpc("pi-events-bridge", "status")` for the socket path and token, then `child_process.spawn("pi", args, { env: { ...process.env, BB_BRIDGE_SOCKET_PATH, BB_BRIDGE_TOKEN, BB_BRIDGE_CWD } })`. Ship as a one-off patch in `/home/griko/Workspace/grikomsn/bb-plugins/` or a hot-patch over the bundled `bb-app/server/dist/builtin-plugins/provider-pi/`. *This will re-light the bridge immediately on the next pi spawn.*

2. **Layer 3 (local small fix): tighten `pi-events-bridge`'s socket-reload race** — it logs two "listening at" lines per reload and hits `EADDRINUSE` every time. Trivial patch.

3. **Layer 1 (upstream bb): filter or translate the unhandled events** — needs a bb release. Out of scope here, but worth filing.

Want me to do (1) and (2)? If so, do you want the provider-pi host.js as a bb plugin hot-patch (so it survives bb reloads), or as a manual replacement of the bundled `provider-pi/dist/`? I'd lean hot-patch since modifying `bb-app/server/dist/builtin-plugins/` directly will get clobbered the next time bb updates.

── Unhandled Pi event ──────────────────────────────────────
  SDK Unknown
  Raw event: sdk/unknown
  Payload:
  {
    "jsonrpc": "2.0",
    "method": "sdk/message",
    "params": {
      "message": {
        "type": "session_info_changed",
        "name": "while waiting for @thread:thr_xwdzm5raqz, debug why subagent"
      },
      "threadId": "thr_t2tq3jvmgi"
    }
  }
```
