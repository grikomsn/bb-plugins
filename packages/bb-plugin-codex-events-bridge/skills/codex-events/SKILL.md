---
name: codex-events
description: React to events from bb codex threads (the builtin provider-codex host) without re-polling the bb thread events DB. Use when building a downstream codex consumer plugin (goal, plan, context, live, raw), when correlating a bb thread with its codex session, when surfacing codex token usage / rate-limit / diff progress in a UI, or when auditing what provider-codex is doing right now.
---

# Codex Events Bridge

Chokepoint that watches every active `providerId === "codex"` thread's
normalized event log and republishes each row on
`codex/<category>/<event>` bb.realtime channels. Downstream plugins
subscribe over **one** of:

- `bb.sdk.plugins.callRpc({ pluginId: "codex-events-bridge", method, ... })`
  in their own `server.ts` (the polling path).
- `useRealtime("codex/<category>/<event>", handler)` in their `app.tsx`
  (the realtime path).

The bridge owns the per-thread polling loop and the ring buffer; you
**should not** call `bb.sdk.threads.events.list` yourself for any
category-prefixed filter that costs the same thing across N threads.

## What flows

### `thread/*` — thread lifecycle

| Type | Channels as `codex/...` |
|------|--------------------------|
| `thread/started` | `codex/thread/started` |
| `thread/identity` | `codex/thread/identity` |
| `thread/name/updated` | `codex/thread/name/updated` |
| `thread/compacted` | `codex/thread/compacted` |
| `thread/context/cleared` | `codex/thread/context/cleared` |
| `thread/goal/updated` | `codex/thread/goal/updated` |
| `thread/goal/cleared` | `codex/thread/goal/cleared` |
| `thread/tokenUsage/updated` | `codex/thread/tokenUsage/updated` |
| `thread/contextWindowUsage/updated` | `codex/thread/contextWindowUsage/updated` |

### `turn/*` — turn lifecycle

| Type | Channels as `codex/...` |
|------|--------------------------|
| `turn/started` | `codex/turn/started` |
| `turn/completed` | `codex/turn/completed` |
| `turn/input/accepted` | `codex/turn/input/accepted` |
| `turn/plan/updated` | `codex/turn/plan/updated` |
| `turn/diff/updated` | `codex/turn/diff/updated` |

### `item/*` — item lifecycle (per-message/tool/reasoning/etc.)

| Type | Channels as `codex/...` |
|------|--------------------------|
| `item/started` | `codex/item/started` |
| `item/completed` | `codex/item/completed` |
| `item/agentMessage/delta` | `codex/item/agentMessage/delta` |
| `item/commandExecution/outputDelta` | `codex/item/commandExecution/outputDelta` |
| `item/fileChange/outputDelta` | `codex/item/fileChange/outputDelta` |
| `item/reasoning/summaryTextDelta` | `codex/item/reasoning/summaryTextDelta` |
| `item/reasoning/textDelta` | `codex/item/reasoning/textDelta` |
| `item/plan/delta` | `codex/item/plan/delta` |
| `item/mcpToolCall/progress` | `codex/item/mcpToolCall/progress` |
| `item/toolCall/progress` | `codex/item/toolCall/progress` |
| `item/backgroundTask/progress` | `codex/item/backgroundTask/progress` |
| `item/backgroundTask/completed` | `codex/item/backgroundTask/completed` |

### `account/*` — provider account / process events

The SDK normalizes provider events under `provider/*`; the bridge renames
the channel to `account/*` so downstream filters don't depend on internal
provider namespaces.

| SDK type | Bridge channel |
|----------|----------------|
| `provider/error` | `codex/account/error` |
| `provider/rateLimits/updated` | `codex/account/rateLimits/updated` |
| `provider/warning` | `codex/account/warning` |
| `provider/modelFallback` | `codex/account/modelFallback` |
| `provider/unhandled` | `codex/account/unhandled` |

## How to inspect

The plugin ships a `status`, `recent`, `sessions`, and `threadSession`
RPC. From any bb context:

```
bb plugin call rpc codex-events-bridge status
bb plugin call rpc codex-events-bridge recent '{"limit": 25, "typePrefix": "codex/turn/"}'
bb plugin call rpc codex-events-bridge sessions
bb plugin call rpc codex-events-bridge threadSession '{"threadId": "thr_abc"}'
```

The `status` payload reports the active thread count, ring capacity, poll
interval, and the last event timestamp. The `recent` payload returns up to
500 events newest-first; `typePrefix` accepts either the bridge form
(`codex/<category>/`) or the SDK form (`provider/...`/`thread/...`/...). The
`sessions` payload returns one row per tracked thread with `eventCountByCategory`
so a fleet UI can render per-bucket load without re-polling.

## How to react from another plugin

In your `server.ts` factory:

```ts
import { z } from "zod";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";

// Mirror the bridge's RecentResult so a zod parse failure surfaces a clean error.
const BridgeRecent = z.object({
  events: z.array(
    z.object({
      seq: z.number().int().nonnegative(),
      ts: z.string(),
      type: z.string(),
      category: z.enum(["thread", "turn", "item", "account"]),
      threadId: z.string(),
      providerThreadId: z.string().nullable(),
      payload: z.unknown(),
    }),
  ),
});

const CHOKEPOINT = "codex-events-bridge";

export default async function plugin(bb: BbPluginApi) {
  bb.background.service("my-consumer-poll", {
    async start(signal) {
      let since = new Map<string, number>(); // threadId -> last seen seq
      while (!signal.aborted) {
        try {
          const result = await bb.sdk.plugins.callRpc({
            pluginId: CHOKEPOINT,
            method: "recent",
            input: { limit: 200, typePrefix: "codex/turn/" },
            outputSchema: BridgeRecent,
          });
          for (const e of result.events) {
            const watermark = since.get(e.threadId) ?? -1;
            if (e.seq <= watermark) continue;
            since.set(e.threadId, e.seq);
            // apply per-event logic
          }
        } catch (err) {
          bb.log.debug(`chokepoint poll failed: ${String(err)}`);
        }
        await new Promise<void>((r) => setTimeout(r, 1500));
      }
    },
  });

  // Resolve bb threadId → provider threadId for per-session state.
  bb.rpc.register(defineRpcContract({
    currentThreadSnapshot: {
      input: z.object({ threadId: z.string() }).strict(),
      output: z.object({
        threadId: z.string(),
        providerThreadId: z.string().nullable(),
        sessionActive: z.boolean(),
      }),
    },
  }), {
    async currentThreadSnapshot({ threadId }) {
      try {
        const r = await bb.sdk.plugins.callRpc({
          pluginId: CHOKEPOINT,
          method: "threadSession",
          input: { threadId },
          outputSchema: z.object({
            threadId: z.string(),
            providerThreadId: z.string().nullable(),
            sessionActive: z.boolean(),
          }),
        });
        return r;
      } catch {
        return { threadId, providerThreadId: null, sessionActive: false };
      }
    },
  });
}
```

In your `app.tsx` useRealtime handlers:

```tsx
import { useRealtime } from "@get-bb/plugin-sdk/app";

useRealtime("codex/thread/goal/updated", (msg) => {
  // msg.payload: { seq, ts, type, category, threadId, providerThreadId, payload }
});
```

## Free hooks (this plugin's frontend)

`import { useCodexStatus, useCodexRecent, useCodexSessions, useCodexThreadSession } from "bb-plugin-codex-events-bridge/hooks/useCodexEvents"`

These wrap `useRpc<typeof rpcContract>()` plus a setInterval poll — fine
for a settings panel, but **not** the path a consumer plugin should take
(consumer plugins poll from `server.ts` so they survive across reloads
of the bb frontend). Consumer plugins will usually inline the rpc calls
they need and manage their own per-session watermarks.

## Editing the type taxonomy

The canonical list lives in
`packages/bb-plugin-codex-events-bridge/lib/codex-events.ts`. Both
`server.ts` and `app.tsx` import from there. To add a new codex event
type, append the literal to the matching category tuple and re-run
`npm run typecheck`; the schema is exhaustive so a forgotten update
fails the build with a clean Zod error.

## When to use this skill

- Building any UI that wants live codex goings-on (token bars, plan diff
  review, rate-limit warnings, agent-message streaming).
- Computing a derived view over codex history (goal state, plan state,
  tool-call summary) without maintaining your own SDK poll loop.
- Auditing "what is provider-codex doing right now" from a thread view.
- Resolving a bb thread to its codex session id (for storing per-session
  state in your own plugin's database).

## When NOT to use this skill

- Streaming the agent message directly to the chat UI — `ThreadChat`
  already does this through its own subscription. The bridge is for
  **derived** views, not for rendering assistant content.
- Non-codex providers (pi, claude-code, acp-cursor). Each has its own
  provider host; for codex-only features, this bridge is exactly right.
- Reading raw event payloads through `bb.sdk.threads.events.list` —
  use the bridge's `recent` rpc instead unless you need data older than
  the ring buffer holds.

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `ringCapacity` | 5000 | Max events per (thread × category) replay ring |
| `pollIntervalMs` | 1500 | How often the shared poll tick walks every thread × category |
| `threadDiscoveryIntervalMs` | 15000 | How often to rediscover active codex threads (cheap) |
| `includeHidden` | true | Include hidden worker threads in the tracked set |
