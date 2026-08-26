---
name: workspaces
description: Multi-root workspace aggregation — group bb projects into named workspaces and run one agent thread per folder. Use when a task spans several repositories (e.g. backend + frontend) and you need to coordinate work across them.
---

# Workspaces

The Workspaces plugin groups ordinary bb projects into named multi-root
workspaces. Every folder is a normal bb project (full git support — worktrees,
diffs, PRs); the workspace adds the coordination layer on top.

## CLI

- `bb workspaces list` — workspaces, folders, project ids, live thread counts.
- `bb workspaces create <name>` / `bb workspaces rename <ws> <name>` — manage workspaces.
- `bb workspaces add <path> [--workspace <id|name>]` — add a folder. The path is
  resolved to an existing bb project (matched by source path) or a project is
  created for it. The folder is deduped by path within the workspace.
- `bb workspaces remove <path> [--workspace <id|name>]` — remove a folder
  (the underlying bb project is untouched).
- `bb workspaces run <prompt> [--workspace <id|name>] [--project <id|name> …]` —
  spawns one agent thread per folder in parallel, each in its own project.
  `--hidden` spawns hidden background threads.
- `bb workspaces status` — thread counts per folder.

## Agent tool

`workspace_run` spawns child threads (parented to the calling thread) across a
workspace's folders. Prefer it over sequential single-repo work when a task
spans repositories. `workspaces_list` returns the current workspaces/folders —
call it first when you need a workspace id or project ids.

## Model

- Workspaces are stored in the plugin database (not in bb core). Deleting a
  workspace only removes the grouping; projects and threads stay.
- Each folder maps to exactly one bb project via its `projectId`. The stored
  `path` is the project's local source path on the folder's host.
- Thread counts are live (non-archived threads per project, including hidden).
