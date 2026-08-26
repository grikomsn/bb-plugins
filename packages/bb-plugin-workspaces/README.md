# `bb-plugin-workspaces`

Multi-root workspace aggregator for bb. bb's core model gives every project one
folder per host; this plugin adds the multi-folder layer on top by grouping
ordinary bb projects into named workspaces and running one agent thread per
folder — without modifying bb itself (design Path A from
`docs/threads/` exploration of bb's project/source model).

## What it does

- **`bb workspaces add <path>`** — resolves an absolute folder to an existing
  bb project (matched by source path) or creates one, then appends it to a
  workspace. Dedupes by path within the workspace.
- **`bb workspaces run <prompt>`** — spawns one agent thread per folder, each
  in its own project/repo, in parallel.
- **Agent tools** — `workspace_run` spawns child threads (parented to the
  calling thread) across folders; `workspaces_list` discovers workspaces.
- **UI** — a Workspaces nav panel and a Settings section: create/rename/delete
  workspaces, add/remove/reorder folders, run across folders, live thread
  counts (realtime refresh + 5s poll).
- **Orchestration** — threads spawned by `workspace_run` are cross-project
  children that report results back to the parent thread, so one coordinator
  thread can fan out and collect multi-repo work.

## Model

Each folder is one ordinary bb project (full git machinery — worktrees, diffs,
PRs). Workspaces and folder membership live in the plugin SQLite database at
`<dataDir>/plugins/workspaces/data.db`:

```
workspaces        id, name (unique), createdAt, updatedAt
workspace_folders id, workspaceId, projectId, hostId, path, position, createdAt
                 (unique workspaceId+path)
```

Removing a folder from a workspace never touches the underlying project.

## Install (from this monorepo)

```sh
cd packages/bb-plugin-workspaces && bb plugin install .
```

Then `bb plugin reload workspaces` after config changes.

## CLI reference

| Command | Description |
| --- | --- |
| `bb workspaces list` | Workspaces, folders, project ids, thread counts |
| `bb workspaces create <name>` | Create a named workspace |
| `bb workspaces rename <ws> <name>` | Rename a workspace |
| `bb workspaces add <path> [--workspace <id\|name>] [--host <id>]` | Add a folder |
| `bb workspaces remove <path> [--workspace <id\|name>]` | Remove a folder |
| `bb workspaces run <prompt> [--workspace <id\|name>] [--project <id\|name> …] [--hidden]` | One thread per folder |
| `bb workspaces status` | Thread counts per folder |

## Development

```sh
npm run typecheck   # from the package dir
npm run build       # bb plugin build .
npm run dev         # bb plugin dev .
```

Requires `@get-bb/plugin-sdk` (see the root `package.json`), bb >= 0.39.
