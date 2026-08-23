---
name: docker
description: Inspect and clean up a local Docker engine through bb. Use when the user asks about running containers, available images, volumes, networks, Docker connectivity, or reclaiming Docker disk space.
---

# Docker

Use the `bb docker` command to inspect the Docker engine on the connected bb
host without leaving the agent workflow.

## What it does

- `bb docker ps` lists containers as `ID`, `NAME`, `IMAGE`, `STATE`, and
  `PORTS`.
- `bb docker images` lists local images as `REPOSITORY`, `TAG`, `ID`, `SIZE`,
  and `CREATED`.
- `bb docker volumes` lists volumes as `NAME`, `DRIVER`, and `MOUNTPATH`.
- `bb docker networks` lists networks as `NAME`, `DRIVER`, and `SCOPE`.
- `bb docker info` reports `version`, `context`, `os`, and `serverVersion`, one
  field per row.
- `bb docker prune <kind> --yes` removes unused resources for one of
  `system`, `images`, `volumes`, or `networks`, then reports reclaimed bytes
  and a bounded list of removed items. Omitting `--yes` performs no deletion
  and prints the confirmation instruction.

## When to use it

Use this skill when the user asks you to:

- check which containers are running or stopped;
- inspect images already available on the Docker host;
- find leftover volumes or networks;
- confirm the active Docker context, versions, or reachability;
- clean up unused Docker resources or reclaim disk space.

Prefer the read-only commands first. Before pruning, explain the selected
resource kind and use `--yes` only when the user has authorized that cleanup.

## When NOT to use it

- Do not use it for interactive container shells or commands requiring a TTY;
  `exec -it` is not supported.
- Do not use it to manage a remote Docker daemon or choose among multiple
  Docker hosts; v1 targets the plugin's connected bb host.
- Do not use it for Docker Compose projects, image builds, registry pushes,
  Docker Swarm, or Kubernetes.
- Do not use prune as a diagnostic shortcut when the user has not authorized
  removal of unused resources.

## Examples

List containers:

```console
$ bb docker ps
ID            NAME       IMAGE          STATE    PORTS
8d24c6f213ab  api        api:latest     running  0.0.0.0:3000->3000/tcp
65ca91ab204e  redis      redis:7        exited
```

List images:

```console
$ bb docker images
REPOSITORY  TAG      ID            SIZE    CREATED
api         latest   sha256:4e82f  412MB   2 hours ago
redis       7        sha256:0bc31  117MB   3 weeks ago
```

Check Docker information:

```console
$ bb docker info
FIELD          VALUE
version        28.3.2
context        default
os             linux
serverVersion  28.3.2
```

Confirm and prune unused volumes:

```console
$ bb docker prune volumes
Pruning volumes removes unused Docker resources. Re-run with --yes to confirm.

$ bb docker prune volumes --yes
Reclaimed: 52428800 bytes
Removed:
- cache-data
```

