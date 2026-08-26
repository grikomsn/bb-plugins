import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, WorkspaceView } from "./contract";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 5_000;

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-6)}` : id;
}

function IconButton({
  title,
  ...props
}: React.ComponentProps<typeof Button> & { title: string }) {
  return (
    <span title={title} className="inline-flex">
      <Button {...props} />
    </span>
  );
}

function formatPath(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return `…/${parts.slice(-3).join("/")}`;
}

// ---------------------------------------------------------------------------

function WorkspaceCard({
  workspace,
  rpc,
  onChanged,
}: {
  workspace: WorkspaceView;
  rpc: Rpc;
  onChanged: () => void;
}) {
  const [runPrompt, setRunPrompt] = useState("");
  const [addPath, setAddPath] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameName, setRenameName] = useState(workspace.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const run = useCallback(async () => {
    const prompt = runPrompt.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await rpc.call("run", {
        workspaceId: workspace.id,
        prompt,
      });
      setMessage(
        `Spawned ${result.threads.length} thread${result.threads.length === 1 ? "" : "s"} across ${result.threads.map((t) => t.projectName).join(", ")}.`,
      );
      setRunPrompt("");
    } catch (error) {
      setMessage(`Run failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [rpc, workspace.id, runPrompt, busy]);

  const addFolder = useCallback(async () => {
    const path = addPath.trim();
    if (!path || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await rpc.call("addFolder", {
        workspaceId: workspace.id,
        path,
      });
      setMessage(
        result.createdProject
          ? `Added ${path} — created a new bb project.`
          : `Added ${path} to ${workspace.name}.`,
      );
      setAddPath("");
      onChanged();
    } catch (error) {
      setMessage(`Add failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [rpc, workspace.id, workspace.name, addPath, busy, onChanged]);

  const rename = useCallback(async () => {
    const name = renameName.trim();
    if (!name || name === workspace.name) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await rpc.call("renameWorkspace", { workspaceId: workspace.id, name });
      setRenaming(false);
      onChanged();
    } catch (error) {
      setMessage(`Rename failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [rpc, workspace.id, workspace.name, renameName, onChanged]);

  const removeFolder = useCallback(
    async (folderId: string) => {
      setBusy(true);
      setMessage(null);
      try {
        await rpc.call("removeFolder", {
          workspaceId: workspace.id,
          folderId,
        });
        onChanged();
      } catch (error) {
        setMessage(`Remove failed: ${String(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [rpc, workspace.id, onChanged],
  );

  const moveFolder = useCallback(
    async (folderId: string, direction: "up" | "down") => {
      setBusy(true);
      try {
        await rpc.call("moveFolder", {
          workspaceId: workspace.id,
          folderId,
          direction,
        });
        onChanged();
      } catch (error) {
        setMessage(`Move failed: ${String(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [rpc, workspace.id, onChanged],
  );

  const deleteWorkspace = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      await rpc.call("deleteWorkspace", { workspaceId: workspace.id });
      onChanged();
    } catch (error) {
      setMessage(`Delete failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [rpc, workspace.id, onChanged]);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center justify-between gap-2 p-4">
        <div className="min-w-0">
          {renaming ? (
            <div className="flex items-center gap-2">
              <Input
                value={renameName}
                onChange={(event) => setRenameName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void rename();
                  if (event.key === "Escape") setRenaming(false);
                }}
                className="h-7 w-52"
                autoFocus
              />
              <Button size="sm" onClick={() => void rename()}>
                Save
              </Button>
            </div>
          ) : (
            <CardTitle className="flex items-center gap-2 text-base">
              <Icon name="Layers" className="size-4 text-muted-foreground" aria-hidden />
              {workspace.name}
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-normal uppercase tracking-wide text-muted-foreground">
                {workspace.threadCount} thread{workspace.threadCount === 1 ? "" : "s"}
              </span>
            </CardTitle>
          )}
          <p className="mt-0.5 text-xs text-muted-foreground">
            {workspace.folders.length} folder{workspace.folders.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!renaming && (
            <IconButton
              size="icon"
              variant="ghost"
              className="size-8"
              title="Rename workspace"
              onClick={() => {
                setRenameName(workspace.name);
                setRenaming(true);
              }}
            >
              <Icon name="Edit" aria-hidden />
            </IconButton>
          )}
          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="destructive"
                onClick={() => void deleteWorkspace()}
              >
                Delete
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmDelete(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <IconButton
              size="icon"
              variant="ghost"
              className="size-8 hover:bg-destructive/10 hover:text-destructive"
              title="Delete workspace"
              onClick={() => setConfirmDelete(true)}
            >
              <Icon name="Trash2" aria-hidden />
            </IconButton>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3 p-4 pt-0">
        <div className="space-y-1.5">
          <div className="flex gap-2">
            <Input
              value={runPrompt}
              onChange={(event) => setRunPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void run();
              }}
              placeholder="Prompt to run in every folder…"
              className="h-8"
            />
            <IconButton
              size="sm"
              onClick={() => void run()}
              disabled={busy || !runPrompt.trim()}
              title="Spawn one agent thread per folder"
            >
              <Icon name="Play" aria-hidden />
              Run
            </IconButton>
          </div>
        </div>

        {workspace.folders.length === 0 ? (
          <p className="py-2 text-center text-xs text-muted-foreground">
            No folders yet — add an absolute path below.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {workspace.folders.map((folder) => (
              <li
                key={folder.id}
                className="group flex items-center gap-2 px-2.5 py-2"
              >
                <Icon
                  name="Folder"
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">
                      {folder.projectName}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded px-1 text-[10px] tabular-nums",
                        folder.threadCount > 0
                          ? "bg-blue-500/10 text-blue-600 dark:text-blue-300"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {folder.threadCount}
                    </span>
                  </div>
                  <p
                    className="truncate font-mono text-[11px] text-muted-foreground"
                    title={folder.path}
                  >
                    {formatPath(folder.path)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <IconButton
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    title="Move up"
                    disabled={folder.position === 0 || busy}
                    onClick={() => void moveFolder(folder.id, "up")}
                  >
                    <Icon name="ArrowUp" aria-hidden />
                  </IconButton>
                  <IconButton
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    title="Move down"
                    disabled={folder.position === workspace.folders.length - 1 || busy}
                    onClick={() => void moveFolder(folder.id, "down")}
                  >
                    <Icon name="ArrowDown" aria-hidden />
                  </IconButton>
                  <IconButton
                    size="icon"
                    variant="ghost"
                    className="size-7 hover:bg-destructive/10 hover:text-destructive"
                    title={`Remove ${folder.projectName} (project stays in bb)`}
                    disabled={busy}
                    onClick={() => void removeFolder(folder.id)}
                  >
                    <Icon name="X" aria-hidden />
                  </IconButton>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="flex gap-2">
          <Input
            value={addPath}
            onChange={(event) => setAddPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void addFolder();
            }}
            placeholder="/absolute/path/to/folder"
            className="h-8 font-mono text-xs"
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void addFolder()}
            disabled={busy || !addPath.trim()}
          >
            <Icon name="FolderPlus" aria-hidden />
            Add folder
          </Button>
        </div>

        {message ? (
          <p
            className={cn(
              "text-xs",
              message.startsWith("Spawned") || message.startsWith("Added")
                ? "text-muted-foreground"
                : "text-destructive",
            )}
          >
            {message}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function WorkspacesManager() {
  const rpc = useRpc<typeof rpcContract>();
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const mountedRef = useRef(true);

  const reload = useCallback(async () => {
    try {
      const result = await rpc.call("list", null);
      if (mountedRef.current) {
        setWorkspaces(result.workspaces);
        setError(null);
      }
    } catch (caught) {
      if (mountedRef.current) {
        setError(String(caught));
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [rpc]);

  useRealtime("workspaces:changed", () => {
    void reload();
  });

  useEffect(() => {
    mountedRef.current = true;
    void reload();
    const timer = window.setInterval(() => {
      void reload();
    }, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [reload]);

  const createWorkspace = useCallback(async () => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      await rpc.call("createWorkspace", { name });
      setNewName("");
      void reload();
    } catch (caught) {
      setError(String(caught));
    } finally {
      setCreating(false);
    }
  }, [rpc, newName, creating, reload]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 md:p-5">
      <div>
        <h2 className="text-lg font-semibold">Workspaces</h2>
        <p className="text-sm text-muted-foreground">
          Group bb projects into multi-root workspaces. Each folder is an
          ordinary project with full git support; “Run” spawns one agent thread
          per folder.
        </p>
      </div>

      <div className="flex gap-2">
        <Input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void createWorkspace();
          }}
          placeholder="New workspace name"
          className="max-w-xs"
        />
        <Button
          variant="outline"
          onClick={() => void createWorkspace()}
          disabled={creating || !newName.trim()}
        >
          <Icon name="Plus" aria-hidden />
          Create
        </Button>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : workspaces.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No workspaces yet. Create one, then add folders like{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
            /path/to/backend
          </code>
          .
        </p>
      ) : (
        workspaces.map((workspace) => (
          <WorkspaceCard
            key={workspace.id}
            workspace={workspace}
            rpc={rpc}
            onChanged={() => void reload()}
          />
        ))
      )}

      <p className="text-xs text-muted-foreground">
        CLI: <code className="rounded bg-muted px-1 py-0.5 font-mono">bb workspaces --help</code>{" "}
        · Agents: <code className="rounded bg-muted px-1 py-0.5 font-mono">workspace_run</code>{" "}
        tool spawns child threads across folders.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "workspaces",
    title: "Workspaces",
    icon: "Layers",
    path: "workspaces",
    component: WorkspacesManager,
  });
  app.slots.settingsSection({
    id: "workspaces",
    title: "Workspaces",
    description: "Group projects into multi-root workspaces and run across folders.",
    component: WorkspacesManager,
  });
});
