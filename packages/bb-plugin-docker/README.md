# bb-plugin-docker

`bb-plugin-docker` brings local Docker operations into bb. Its sidebar panel
polls the Docker engine on the connected bb host and displays containers,
images, volumes, networks, connection details, logs, and bounded non-interactive
exec results. The companion `bb docker` command provides agent-friendly
read-only listings and explicitly confirmed cleanup from the terminal.

## Install

From the monorepo root:

```sh
bb plugin install ./packages/bb-plugin-docker
```

## Architecture

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Connected bb host                                                   │
│                                                                     │
│ host.ts                                                             │
│   docker CLI ── ps / images / volumes / networks / info / actions   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ typed host RPC + invalidation signals
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ bb server                                                           │
│                                                                     │
│ server.ts                                                           │
│   snapshot polling + RPC handlers + `bb docker` CLI registration    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ plugin RPC + realtime snapshots
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ bb app                                                              │
│                                                                     │
│ app.tsx + Docker cards/dialogs                                      │
│   containers · images · volumes · networks · logs · prune · exec    │
└─────────────────────────────────────────────────────────────────────┘
```

The app never invokes Docker directly. The server selects a connected bb host,
calls the bundled host entry, keeps a bounded snapshot, and publishes changes
to the app. CLI requests also run through the server and use the same typed
host operations.

## CLI

```sh
bb docker ps
bb docker images
bb docker volumes
bb docker networks
bb docker info
bb docker prune system --yes
```

Prune accepts `system`, `images`, `volumes`, or `networks`. It is destructive
and refuses to run unless `--yes` (or `-y`) is supplied.

## Configuration

There is no plugin configuration in v1. The plugin uses the first connected bb
host and that host's active Docker context. Host selection and other settings
are planned for v2.

## Troubleshooting

### Docker not reachable

The connection bar shows the stderr captured in the snapshot, and `bb docker
info` returns the same Docker failure on stderr. Verify Docker is running on
the connected host and that `docker info` succeeds there. Refresh the panel
after Docker becomes available.

### Permission denied

Permission errors follow the same path: Docker's stderr is stored on the
snapshot, shown in the connection bar, and returned by the CLI. Ensure the user
running the bb host daemon can access the Docker socket, then restart that bb
host process so any group-membership change takes effect.

### Host entry not loading

Inspect the plugin log for artifact, worker, or host-RPC failures:

```sh
bb plugin logs docker -n 100
```

Rebuild the package with `bb plugin build` after changing `host.ts`.

## Roadmap

- Docker Compose
- image build
- registry push
- Docker Swarm
- multi-host selection
- interactive `exec -it`
- plugin settings

