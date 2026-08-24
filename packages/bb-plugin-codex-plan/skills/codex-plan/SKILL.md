---
name: codex-plan
description: Plan-review UI for codex threads. Use to surface a codex thread's current plan as a checklist with status pills + explanation, and to send approve/reject/request-changes decisions back to the running codex turn as a steer message.
---

# Codex Plan

Renders the active codex plan in a checklist with status pills
(`pending` / `in_progress` / `completed` / `failed`), then provides a
decide action that synthesises a
`<plan_decision>approve|reject|request-changes</plan_decision>`-enveloped
steer message back to the running turn via `bb.sdk.threads.send`. Equivalent
to plannotator-for-pi's plan-review UI, but for the builtin codex provider.

## How the data flows

1. Codex's app-server emits `turn/plan/updated` (full snapshot, with
   `plan: PlanStep[]` and `explanation?: string`) and `item/plan/delta`
   (streaming partial updates).
2. `bb-plugin-codex-events-bridge` (DOCK-4 / DOCK-5) polls every codex
   thread's normalized event log, ring-buffers the rows, and republishes
   them on `codex/turn/plan/updated` and `codex/item/plan/delta` bb realtime
   channels.
3. This plugin polls the chokepoint's `recent` RPC for both plan types,
   keeps the latest full snapshot per thread in memory (capped at 50 full
   plans per thread for history), and exposes it through a small RPC surface
   plus a `codex-plan/snapshot` realtime signal. Normalized plan deltas are
   bounded textual stream fragments and never become checklist snapshots.
4. `decide` synthesises a
   `<plan_decision>...</plan_decision>`-envelope steer message and sends it
   via `bb.sdk.threads.send(threadId, { input: [{type: "text", text}],
   mode: "auto" })`. Codex's plan agent understands the envelope and bails
   out / revises accordingly.

## What it does NOT do

- Persist plans across bb reloads — in-memory only; the source of truth is
  the codex events DB already mirrored by `bb-plugin-codex-events-bridge`.
- Suggest plan templates or plan diffs.
- Replan UI — out of scope; the cycle is: decide → codex revises → new
  snapshot → repeat.

## Install

```sh
cd packages/bb-plugin-codex-plan
bb plugin install .
```

Requires `bb-plugin-codex-events-bridge` to be installed first (the
chokepoint publishes the per-event realtime channels and exposes the
`recent` RPC). On startup, poll logs will show
`polling codex-events-bridge every 1500ms for turn/plan/updated + item/plan/delta`.

## RPC surface

```
snapshot({ threadId? } | null): all or one tracked thread plan (newest first)
plansBySession({ threadId? }): full-snapshot history for one thread, else latest
currentThreadPlan({ threadId }): single thread lookup w/ providerThreadId
decide({ threadId, decision: "approve"|"reject"|"request-changes", message? }):
                               synthesise + send a steer message
```

The `decide` RPC's synthesised text starts with
`<plan_decision>{decision}</plan_decision>` (followed by an optional
double-newline + user note).

## UI surfaces

- **Nav panel "Codex Plan"** — full fleet picker with per-thread detail.
- **Thread header pill** — "Plan ready" while an undecided plan exists;
  hidden after the user decides.
- **Right-panel "Codex Plan" tab** — full plan + explanation + decide
  actions.
- **Settings section "Codex Plan"** — same fleet list, for users who
  prefer settings-page access.

## Settings

| Setting          | Default | Purpose                                                    |
|------------------|---------|------------------------------------------------------------|
| `pollIntervalMs` | `1500`  | cadence of the chokepoint poll (ring-buffed events only)   |
