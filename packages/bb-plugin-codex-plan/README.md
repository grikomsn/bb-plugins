# bb-plugin-codex-plan

Plan-review UI for the builtin codex provider. Consumes
`codex/turn/plan/updated` and `codex/item/plan/delta` from
`bb-plugin-codex-events-bridge`, renders the active plan as a checklist
with status pills + explanation, and provides an
`Approve` / `Reject` / `Request changes` action that sends a steer
message back to the thread. Equivalent to `@plannotator/pi-extension`'s
plan-review UI but on the codex side.

## Why this exists

Codex emits a plan to the user for review before executing long tasks.
Historically the only way to review it was to read the raw event stream
— there's no built-in UI for it in bb. `@plannotator/pi-extension` fills
that gap for pi; this plugin is the codex analog.

## What it shows

- **Active plan** — step list with status pills
  (`pending` / `in_progress` / `completed` / `failed`),
  totals (done / in progress / pending / failed), and the explanation
  markdown panel rendered by bb's host Markdown component.
- **Decide action** — `Approve` / `Reject` / `Request changes` buttons
  that synthesise a `<plan_decision>...</plan_decision>`-enveloped steer
  message and send it via `bb.sdk.threads.send`. The approve-without-note
  shortcut skips the confirmation dialog.
- **Settings section** — cross-thread summary; per-thread plans are
  capped at 50 history entries each to bound memory.

## Install

```sh
# 1. The chokepoint (DOCK-4): polls codex's events DB, ring-buffers rows,
#    and republishes them on bb realtime.
cd ../bb-plugin-codex-events-bridge && bb plugin install .

# 2. This plugin
cd ../bb-plugin-codex-plan && bb plugin install .
```

## Architecture

```
codex app-server
   │  turn/plan/updated, item/plan/delta
   ▼
bb-plugin-codex-events-bridge (DOCK-4)
   │  bb.realtime.publish("codex/turn/plan/updated", payload)
   │  bb.realtime.publish("codex/item/plan/delta", payload)
   ▼
bb-plugin-codex-plan (this plugin)
   │  per-thread latest plan + explanation
   │  poll "codex/*" via bb.sdk.plugins.callRpc
   │  bb.realtime.publish("codex-plan/snapshot")
   ▼
frontend: navPanel + threadHeaderAction + threadPanelAction + settingsSection
```

## RPC surface

```ts
// Fleet snapshot (newest first), optionally filtered by bb thread id
const r = await rpc.call("snapshot", { threadId: "thr_…" });
// { chokepoint, sessionIds[], snapshots: CodexPlanSnapshot[] }

// Full-snapshot history for one thread (capped at 50)
const r = await rpc.call("plansBySession", { threadId: "thr_…" });

// Resolve a bb threadId → CodeXPlanSnapshot
const r = await rpc.call("currentThreadPlan", { threadId: "thr_…" });

// Decide (approve / reject / request-changes)
await rpc.call("decide", {
  threadId: "thr_…",
  decision: "request-changes",
  message: "Skip the schema rewrite; do it in-step.",
});
// server synthesises "<plan_decision>request-changes</plan_decision>\n\n…"
```

## Decision envelope

A `decide` call synthesises text of the form:

```
<plan_decision>approve</plan_decision>
<plan_decision>reject</plan_decision>
<plan_decision>request-changes</plan_decision>
```

…followed by an optional user note separated by a blank line. The envelope
is the wire format codex itself understands; agents reading the steer
message will react accordingly.

## Constraints

- **Hard dependency on `bb-plugin-codex-events-bridge` (DOCK-4).**
- **MAY take a main-sidebar `navPanel` entry** (unlike diagnostic
  plugins such as goal/context) — plans are day-to-day UI.
- **Approve/Reject/Request-changes go through `bb.sdk.threads.send`.**
- **Plan history is capped at 50 entries per thread** to bound memory.
- **Per-thread seq watermark** dedupes arrivals so out-of-order events
  never roll back state. Normalized `item/plan/delta` events are bounded
  textual stream fragments; they never become checklist snapshots. The
  latest `turn/plan/updated` remains authoritative.

## Settings

| Setting          | Default | Purpose                                                         |
|------------------|---------|-----------------------------------------------------------------|
| `pollIntervalMs` | `1500`  | cadence of the chokepoint poll                                  |
