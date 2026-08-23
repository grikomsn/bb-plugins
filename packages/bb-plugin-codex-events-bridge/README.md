# bb-plugin-codex-events-bridge

Chokepoint plugin that polls every active codex thread's normalized event
log and republishes each row on bb.realtime, so other bb plugins can
subscribe to the provider-codex event stream without re-polling the bb
thread events DB.

This is the **chokepoint** for the planned suite of codex consumer
plugins (goal, plan, context, live, raw). They each subscribe to a
category prefix on this bridge instead of opening their own SDK poll
loop over every active codex thread.

## Install

```sh
bb plugin install .
```

The plugin loads immediately. It starts polling every thread where
`providerId === "codex"` on the next discovery tick (~15s by default,
configurable). No external runtime needed — bb's builtin `provider-codex`
host already normalizes every provider event into the thread events DB
and the bridge just reads.

## Architecture

```
bb thread events DB (already populated by builtin provider-codex)
   │  bb.sdk.threads.list({ includeHidden: true })        ── thread discovery
   │                                                        every ~15s
   ▼
bb-plugin-codex-events-bridge
   │  per-thread × per-category ring buffer (settings.ringCapacity = 5000)
   │  per-thread × per-category seq watermark → dedupe across poll cycles
   │  channel mapping: thread/goal/updated → codex/thread/goal/updated,
   │                  provider/rateLimits → codex/account/rateLimits/…
   ▼
bb.realtime.publish(channel, payload)  →  downstream plugins use
                                          useRealtime + cross-plugin RPC
```

A single `bb.background.service("poll-codex-events")` walks every active
thread on one shared tick (`settings.pollIntervalMs`, default 1500ms) and
calls `bb.sdk.threads.events.list` once per thread with the full
codex-types array. Per-category ring buffers then take rows whose
SDK type prefix matches that category — defensive against an
off-taxonomy slip from the host.

## Reactive surface

Per-event bb.realtime channels, one per SDK type:

- `codex/thread/<event>` — `thread/started`, `thread/identity`,
  `thread/name/updated`, `thread/compacted`, `thread/context/cleared`,
  `thread/goal/updated`, `thread/goal/cleared`,
  `thread/tokenUsage/updated`, `thread/contextWindowUsage/updated`
- `codex/turn/<event>` — `turn/started`, `turn/completed`,
  `turn/input/accepted`, `turn/plan/updated`, `turn/diff/updated`
- `codex/item/<event>` — `item/started`, `item/completed`,
  `item/agentMessage/delta`, `item/commandExecution/outputDelta`,
  `item/fileChange/outputDelta`, `item/reasoning/summaryTextDelta`,
  `item/reasoning/textDelta`, `item/plan/delta`,
  `item/mcpToolCall/progress`, `item/toolCall/progress`,
  `item/backgroundTask/progress`, `item/backgroundTask/completed`
- `codex/account/<event>` — `provider/error`, `provider/rateLimits/updated`,
  `provider/warning`, `provider/modelFallback`, `provider/unhandled` (the
  SDK uses `provider/*` for these; the bridge renames the channel to
  `account/*` so downstream filters don't depend on internal provider
  namespaces)

The `useRealtime("<channel>", handler)` hook receives event payloads
with shape:

```ts
{
  seq: number;
  ts: string;           // ISO 8601
  type: string;         // SDK type (e.g. "thread/goal/updated")
  category: "thread" | "turn" | "item" | "account";
  threadId: string;
  providerThreadId: string | null;
  payload: unknown;     // ThreadEventRow.data
}
```

## RPC surface

```ts
// status — chokepoint connectivity + bookkeeping
const s = await rpc.call("status");
// { connected, pollIntervalMs, ringCapacity, threadCount,
//   sessionIds, lastEventAt, bufferedSeqs, pollIteration, ... }

// recent — newest-first replay, filterable by thread + typePrefix
const { events } = await rpc.call("recent", {
  limit: 50,
  typePrefix: "codex/turn/",         // or "turn/", "provider/", "account/"
  // threadId: optional, restricts to one thread
});

// sessions — per-thread bookkeeping
const { sessions } = await rpc.call("sessions");
// [{ threadId, providerThreadId, title, status, eventCount,
//    eventCountByCategory: { thread, turn, item, account }, ... }]

// threadSession — resolve a bb threadId to its provider sessionId
const { providerThreadId, sessionActive } =
  await rpc.call("threadSession", { threadId: "thr_abc" });
```

## Reacting from another plugin

In your `server.ts` factory (the recommended polling path):

```ts
import { z } from "zod";
import { type BbPluginApi } from "@get-bb/plugin-sdk";

const CHOKEPOINT = "codex-events-bridge";

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

export default async function plugin(bb: BbPluginApi) {
  bb.background.service("my-consumer-poll", {
    async start(signal) {
      const since = new Map<string, number>();
      while (!signal.aborted) {
        try {
          const r = await bb.sdk.plugins.callRpc({
            pluginId: CHOKEPOINT,
            method: "recent",
            input: { limit: 200, typePrefix: "codex/turn/" },
            outputSchema: BridgeRecent,
          });
          for (const e of r.events) {
            const w = since.get(e.threadId) ?? -1;
            if (e.seq <= w) continue;
            since.set(e.threadId, e.seq);
            // apply per-event logic
          }
        } catch (err) {
          bb.log.debug(`chokepoint poll failed: ${String(err)}`);
        }
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1500);
          signal?.addEventListener("abort", () => {
            clearTimeout(t);
            resolve();
          }, { once: true });
        });
      }
    },
  });
}
```

In your `app.tsx` for a one-shot renderer:

```tsx
import { useRealtime } from "@get-bb/plugin-sdk/app";

useRealtime("codex/thread/goal/updated", (msg) => {
  // msg.payload: { seq, ts, type, category, threadId, providerThreadId, payload }
});
```

## Settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `ringCapacity` | 5000 | Max events per (thread × category) replay ring |
| `pollIntervalMs` | 1500 | Shared poll tick cadence |
| `threadDiscoveryIntervalMs` | 15000 | How often to rediscover active codex threads |
| `includeHidden` | true | Include hidden worker threads in the tracked set |

The settings backend only stores `string | boolean`; the two numeric
select settings are encoded as strings and parsed back at load.

## Why a chokepoint (not direct SDK polling)?

bb's `bb.sdk.threads.events.list` is a per-thread call. Every consumer
plugin that wants turn progress, plan deltas, or rate-limit warnings
would otherwise open its own poll loop, walking the same set of codex
threads on overlapping cadences. The bridge:

- pays the SDK list cost **once per tick** (shared across all consumers).
- keeps a bounded per-(thread × category) ring buffer so races
  (consumer refresh just after a fresh event) don't lose it.
- exposes `{ threadId, typePrefix }`-filtered reads so a `recent` caller
  can slice just the rows it cares about without re-fetching.
- normalizes the `provider/*` ↔ `account/*` rename once.

## Out of scope (deferred)

- Multi-provider generalization — channel names start with `codex/...`
  for v1; refactor to `provider/<providerId>/...` when a second
  consumer needs it.
- The 42 noise/unknown codex events — deferred to a `bb-plugin-codex-raw`.
- Backpressure / dedup beyond the seq watermark.
- Cross-thread aggregation — per-thread is enough for v1.

## Related plugins

- `bb-plugin-pi-events-bridge` — the same shape, but reading from a
  Unix socket attached to the `pi-bb-bridge` pi extension. Two
  chokepoints by design: pi events are not normalized into the SDK
  thread events DB the way codex events are.
- `bb-plugin-pi-codex-goal`, `bb-plugin-pi-subagents-fleet`,
  `bb-plugin-mcp-mediator` — downstream consumers of the **pi**
  bridge. Their codex-side equivalents (goal/plan/context/live/raw)
  will be consumers of **this** bridge.
