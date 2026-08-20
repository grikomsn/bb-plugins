# `@grikomsn/bb-plugins`

Monorepo of bb plugins that surface the [Pi coding agent](https://github.com/badlogic/pi-mono)'s extension event stream inside the [bb](https://getbb.app) desktop app. Plus the companion pi extension that publishes the events.

## Layout

```
bb-plugins/
├── package.json                    workspace root (npm workspaces)
├── .gitignore
├── README.md                       this file
├── docs/                           shared documentation
│   ├── Pi-Bb-Bridge-README.md      architecture + reverse-path overview
│   ├── pi-bridge-wiring.md         how to wire the bridge (patch + extension)
│   ├── threads/                     archived thread transcripts + research results
│   └── (per-plugin docs in each package)
└── scripts/
    └── patch-pi-bridge.mjs         idempotent patch for the bundled pi bridge worker
└── packages/
    ├── bb-plugin-pi-events-bridge/ the chokepoint (Unix socket server)
    ├── bb-plugin-pi-subagents-fleet/
    ├── bb-plugin-pi-codex-goal/
    ├── bb-plugin-mcp-mediator/
    └── pi-bb-bridge/               pi-side companion extension
```

## Architecture

```
pi + pi-bb-bridge (extension)
   │   pi lifecycle + 3rd-party plugin events
   ▼   over a Unix socket (newline-delimited JSON)
┌──────────────────────────────────────────────────────────────┐
│ bb-plugin-pi-events-bridge (the chokepoint)                  │
│   • listens on the socket                                    │
│   • validates each line with Zod                            │
│   • ring-buffers per pi session                              │
│   • publishes to bb realtime                                 │
│   • drains a bb.storage.kv command queue → writes back       │
│     `bb.bridge:command` envelopes for bb→pi RPCs             │
│   • tracks bbThreadId → providerThreadId map                 │
└──────────────┬───────────────────────────────────────────────┘
               │ bb.sdk.plugins.callRpc("recent", ...) — polling
   ┌──────────┴────────────────────────────────────────────┐
   │ each consumer plugin                                  │
   ├─ bb-plugin-pi-subagents-fleet  (fleet + right panel)  │
   ├─ bb-plugin-pi-codex-goal       (snapshot + right panel)│
   └─ bb-plugin-mcp-mediator        (status + approvals)    │
```

See [`docs/Pi-Bb-Bridge-README.md`](./docs/Pi-Bb-Bridge-README.md) for full details on every event forwarded, the reverse-path flow, end-to-end test results, and the type-prefix separator gotcha (`pi.ext:subagents:` vs `pi.ext:pi-mcp-adapter/`).

The [`docs/threads/`](./docs/threads/README.md) archive preserves the original bb thread transcripts (exploration, bridge debugging, subagent-status confirmation) plus the distilled research results and open questions.

## Install

All plugins are installed by source path (no npm registry publish yet). From this repo root:

```sh
cd packages/bb-plugin-pi-events-bridge && bb plugin install .
cd ../bb-plugin-pi-subagents-fleet   && bb plugin install .
cd ../bb-plugin-pi-codex-goal        && bb plugin install .
cd ../bb-plugin-mcp-mediator         && bb plugin install .
```

The pi-side companion is a pi extension; install it into the user's pi extensions directory:

```sh
npm run install:extension
# = cp packages/pi-bb-bridge/index.ts ~/.pi/agent/extensions/pi-bb-bridge.ts
```

It activates when `BB_BRIDGE_SOCKET_PATH` is set in the environment. **bb 0.39.0's
`provider-pi` never sets that variable**, so the bridge is wired up with a small
patch to the bundled pi bridge worker plus the chokepoint publishing its
connection info to a well-known file:

```sh
npm run patch:bridge        # idempotent; re-run after every bb update
# then restart bb so long-lived bridge workers reload the patched module
```

See [`docs/pi-bridge-wiring.md`](./docs/pi-bridge-wiring.md) for the full
architecture, the patch script usage (`--revert` to undo), the restart
requirement, and end-to-end verification steps.

## Development

This is an npm workspaces monorepo. One `npm install` at the root installs everything; deps are hoisted.

```sh
# install once at root
npm install

# type-check everything (bb plugins + pi extension)
npm run typecheck

# build a single plugin's dist/ (used by bb plugin install)
cd packages/bb-plugin-pi-events-bridge && npm run build

# watch + reload a single plugin while editing
cd packages/bb-plugin-pi-subagents-fleet && npm run dev
```

## Per-package documentation

Each plugin ships its own README in its package directory:

- [`packages/bb-plugin-pi-events-bridge/README.md`](./packages/bb-plugin-pi-events-bridge/README.md)
- [`packages/bb-plugin-pi-subagents-fleet/README.md`](./packages/bb-plugin-pi-subagents-fleet/README.md)
- [`packages/bb-plugin-pi-codex-goal/README.md`](./packages/bb-plugin-pi-codex-goal/README.md)
- [`packages/bb-plugin-mcp-mediator/README.md`](./packages/bb-plugin-mcp-mediator/README.md)
- [`packages/pi-bb-bridge/README.md`](./packages/pi-bb-bridge/README.md)

## Notes

- Each bb plugin declares its own RPC contract (`rpcContract`) which `app.tsx` imports type-only via `useRpc<typeof rpcContract>()`.
- Per-package `bb.*` manifest fields (`name`, `description`, `branding.icon`, `skills`, `server`, `app`) live in `package.json` so the bb manifest is colocated with the source.
- Each plugin's per-package `skills/<name>/SKILL.md` is registered via `bb.skills: ["./skills"]` in the manifest and auto-imported into agent threads.