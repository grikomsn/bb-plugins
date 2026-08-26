import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract, type RunResult, type WorkspaceView } from "./contract.js";

export { rpcContract } from "./contract.js";

const DEFAULT_WORKSPACE_NAME = "default";
const CHANGED_CHANNEL = "workspaces:changed";

// ---------------------------------------------------------------------------
// Row shapes (plugin SQLite at <dataDir>/plugins/workspaces/data.db).
// ---------------------------------------------------------------------------

type WorkspaceRow = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

type FolderRow = {
  id: string;
  workspaceId: string;
  projectId: string;
  hostId: string;
  path: string;
  position: number;
  createdAt: number;
};

type SdkProject = Awaited<ReturnType<BbPluginApi["sdk"]["projects"]["list"]>>[number];

function normalizePath(input: string): string {
  let out = input.replace(/\\/g, "/").replace(/\/+$/, "");
  if (out.length === 0) return "/";
  return out;
}

function basename(input: string): string {
  const parts = normalizePath(input).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? input;
}

function newId(): string {
  return crypto.randomUUID();
}

function now(): number {
  return Date.now();
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("workspaces loading");

  // --- storage --------------------------------------------------------------

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS workspace_folders (
      id TEXT PRIMARY KEY,
      workspaceId TEXT NOT NULL,
      projectId TEXT NOT NULL,
      hostId TEXT NOT NULL,
      path TEXT NOT NULL,
      position INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      UNIQUE (workspaceId, path)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_workspace_folders_workspace
      ON workspace_folders (workspaceId, position)`,
  ]);

  // The default workspace exists from load so `bb workspaces add <path>`
  // without --workspace always has a target, and it sorts first on fresh
  // installs (createdAt is the display order).
  getOrCreateDefaultWorkspace();

  function listWorkspaceRows(): WorkspaceRow[] {
    return db
      .prepare("SELECT * FROM workspaces ORDER BY createdAt ASC")
      .all() as WorkspaceRow[];
  }

  function listFolderRows(workspaceId?: string): FolderRow[] {
    if (workspaceId) {
      return db
        .prepare(
          "SELECT * FROM workspace_folders WHERE workspaceId = ? ORDER BY position ASC",
        )
        .all(workspaceId) as FolderRow[];
    }
    return db
      .prepare(
        "SELECT * FROM workspace_folders ORDER BY workspaceId ASC, position ASC",
      )
      .all() as FolderRow[];
  }

  function getWorkspaceRow(id: string): WorkspaceRow {
    const row = db
      .prepare("SELECT * FROM workspaces WHERE id = ?")
      .get(id) as WorkspaceRow | undefined;
    if (!row) throw new Error(`workspace not found: ${id}`);
    return row;
  }

  function getOrCreateDefaultWorkspace(): WorkspaceRow {
    const existing = db
      .prepare("SELECT * FROM workspaces WHERE name = ?")
      .get(DEFAULT_WORKSPACE_NAME) as WorkspaceRow | undefined;
    if (existing) return existing;
    const row: WorkspaceRow = {
      id: newId(),
      name: DEFAULT_WORKSPACE_NAME,
      createdAt: now(),
      updatedAt: now(),
    };
    db.prepare(
      "INSERT INTO workspaces (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
    ).run(row.id, row.name, row.createdAt, row.updatedAt);
    bb.log.info(`created default workspace "${row.name}" (${row.id})`);
    return row;
  }

  function selectWorkspace(spec: string | undefined): WorkspaceRow {
    if (!spec) return getOrCreateDefaultWorkspace();
    const byId = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(spec) as
      | WorkspaceRow
      | undefined;
    if (byId) return byId;
    const byName = db
      .prepare("SELECT * FROM workspaces WHERE name = ?")
      .get(spec) as WorkspaceRow | undefined;
    if (byName) return byName;
    const names = listWorkspaceRows()
      .map((w) => w.name)
      .join(", ");
    throw new Error(`workspace "${spec}" not found (known: ${names || "none"})`);
  }

  function touchWorkspace(id: string): void {
    db.prepare("UPDATE workspaces SET updatedAt = ? WHERE id = ?").run(now(), id);
  }

  function publishChanged(): void {
    bb.realtime.publish(CHANGED_CHANNEL, { ts: now() });
  }

  // --- sdk helpers -----------------------------------------------------------

  async function resolveHost(): Promise<string> {
    const hosts = await bb.sdk.hosts.list();
    const host = hosts.find((h) => h.status === "connected") ?? hosts[0];
    if (!host) {
      throw new Error("no hosts available — connect a machine first");
    }
    return host.id;
  }

  async function resolveProjectForPath(path: string): Promise<{
    project: SdkProject;
    source: SdkProject["sources"][number];
    created: boolean;
  }> {
    const normalized = normalizePath(path);
    const projects = await bb.sdk.projects.list({ includePersonal: false });
    for (const project of projects) {
      const source = project.sources.find(
        (s) => normalizePath(s.path) === normalized,
      );
      if (source) return { project, source, created: false };
    }
    const hostId = await resolveHost();
    const name = basename(normalized) || normalized;
    const created = await bb.sdk.projects.create({
      name,
      source: { type: "local_path", hostId, path: normalized },
    });
    const source = created.sources[0];
    if (!source) throw new Error(`project created without a source: ${created.id}`);
    bb.log.info(`created project "${created.name}" (${created.id}) for ${normalized}`);
    return { project: created, source, created: true };
  }

  async function threadCountsForProjects(
    projectIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const projectId of projectIds) {
      try {
        const threads = await bb.sdk.threads.list({
          projectId,
          includeHidden: true,
          limit: 500,
        });
        counts.set(projectId, threads.length);
      } catch (error) {
        bb.log.debug(`thread count unavailable for ${projectId}: ${String(error)}`);
        counts.set(projectId, 0);
      }
    }
    return counts;
  }

  async function listWorkspaceViews(): Promise<WorkspaceView[]> {
    const rows = listWorkspaceRows();
    const folders = listFolderRows();
    const projects = await bb.sdk.projects.list({ includePersonal: false });
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const counts = await threadCountsForProjects(
      Array.from(new Set(folders.map((f) => f.projectId))),
    );
    const foldersByWorkspace = new Map<string, FolderRow[]>();
    for (const folder of folders) {
      const list = foldersByWorkspace.get(folder.workspaceId) ?? [];
      list.push(folder);
      foldersByWorkspace.set(folder.workspaceId, list);
    }
    return rows.map((row) => {
      const folderViews = (foldersByWorkspace.get(row.id) ?? []).map((folder) => {
        const project = projectById.get(folder.projectId);
        return {
          id: folder.id,
          workspaceId: folder.workspaceId,
          projectId: folder.projectId,
          projectName: project?.name ?? "(missing project)",
          hostId: folder.hostId,
          path: folder.path,
          position: folder.position,
          threadCount: counts.get(folder.projectId) ?? 0,
          createdAt: folder.createdAt,
        };
      });
      return {
        id: row.id,
        name: row.name,
        folders: folderViews,
        threadCount: folderViews.reduce((sum, folder) => sum + folder.threadCount, 0),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
  }

  async function addFolderToWorkspace(workspaceId: string, path: string) {
    const normalized = normalizePath(path);
    if (normalized === "/" || normalized === "") {
      throw new Error("refusing to add the filesystem root as a folder");
    }
    const workspace = getWorkspaceRow(workspaceId);
    const duplicate = db
      .prepare("SELECT id FROM workspace_folders WHERE workspaceId = ? AND path = ?")
      .get(workspace.id, normalized);
    if (duplicate) {
      throw new Error(
        `${normalized} is already a folder of workspace "${workspace.name}"`,
      );
    }
    const { project, source, created } = await resolveProjectForPath(normalized);
    const row: FolderRow = {
      id: newId(),
      workspaceId: workspace.id,
      projectId: project.id,
      hostId: source.hostId,
      path: source.path,
      position: listFolderRows(workspace.id).length,
      createdAt: now(),
    };
    db.prepare(
      `INSERT INTO workspace_folders
        (id, workspaceId, projectId, hostId, path, position, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.workspaceId,
      row.projectId,
      row.hostId,
      row.path,
      row.position,
      row.createdAt,
    );
    touchWorkspace(workspace.id);
    publishChanged();
    bb.log.info(`added ${row.path} to workspace "${workspace.name}"`);
    return { row, createdProject: created };
  }

  async function runOnWorkspace(args: {
    workspaceId: string;
    prompt: string;
    projectIds?: string[];
    hidden?: boolean;
    parentThreadId?: string;
  }): Promise<RunResult> {
    const workspace = getWorkspaceRow(args.workspaceId);
    const folders = listFolderRows(workspace.id);
    const projects = await bb.sdk.projects.list({ includePersonal: false });
    const projectById = new Map(projects.map((p) => [p.id, p]));
    const selected =
      args.projectIds && args.projectIds.length > 0
        ? new Set(args.projectIds)
        : null;
    const targets = folders.filter(
      (folder) => !selected || selected.has(folder.projectId),
    );
    if (targets.length === 0) {
      throw new Error(
        args.projectIds && args.projectIds.length > 0
          ? `none of the requested project ids are folders of workspace "${workspace.name}"`
          : `workspace "${workspace.name}" has no folders`,
      );
    }
    const threads: RunResult["threads"] = [];
    for (const folder of targets) {
      const project = projectById.get(folder.projectId);
      const title = `${workspace.name} › ${project?.name ?? folder.path}`;
      const thread = await bb.sdk.threads.spawn({
        projectId: folder.projectId,
        environment: { type: "project-default" },
        prompt: args.prompt,
        title,
        ...(args.parentThreadId ? { parentThreadId: args.parentThreadId } : {}),
        ...(args.hidden ? { visibility: "hidden" as const } : {}),
      });
      threads.push({
        threadId: thread.id,
        projectId: folder.projectId,
        projectName: project?.name ?? folder.path,
        title,
      });
    }
    return { threads };
  }

  // --- CLI ------------------------------------------------------------------

  function parseArgv(argv: string[]) {
    const flags = new Map<string, string | boolean | string[]>();
    const positional: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "--") {
        positional.push(...argv.slice(i + 1));
        break;
      }
      if (!arg.startsWith("--")) {
        positional.push(arg);
        continue;
      }
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
      const next = argv[i + 1];
      const hasNextValue = next !== undefined && !next.startsWith("--");
      if (inline !== undefined) {
        setFlag(flags, name, inline);
      } else if (hasNextValue) {
        setFlag(flags, name, next);
        i++;
      } else {
        flags.set(name, true);
      }
    }
    return { flags, positional };
  }

  function setFlag(
    flags: Map<string, string | boolean | string[]>,
    name: string,
    value: string,
  ) {
    if (name === "project" || name === "p") {
      const existing = flags.get(name);
      flags.set(name, Array.isArray(existing) ? [...existing, value] : [value]);
    } else {
      flags.set(name, value);
    }
  }

  function flagValue(
    flags: Map<string, string | boolean | string[]>,
    name: string,
  ): string | undefined {
    const value = flags.get(name);
    return typeof value === "string" ? value : undefined;
  }

  function flagValues(
    flags: Map<string, string | boolean | string[]>,
    name: string,
  ): string[] {
    const value = flags.get(name);
    return Array.isArray(value) ? value : [];
  }

  function formatWorkspaceTable(views: WorkspaceView[]): string {
    const lines: string[] = [];
    for (const workspace of views) {
      lines.push(`Workspace "${workspace.name}" (${workspace.id})`);
      if (workspace.folders.length === 0) {
        lines.push("  (no folders)");
        continue;
      }
      for (const folder of workspace.folders) {
        lines.push(
          `  ${folder.position + 1}. ${folder.projectName.padEnd(24)} ${folder.path}  ` +
            `proj ${folder.projectId}  (${folder.threadCount} thread${folder.threadCount === 1 ? "" : "s"})`,
        );
      }
    }
    return lines.join("\n");
  }

  async function runCli(argv: string[], ctx: { threadId?: string }): Promise<{
    exitCode: number;
    stdout?: string;
    stderr?: string;
  }> {
    const sub = argv[0];
    const rest = argv.slice(1);
    const { flags, positional } = parseArgv(rest);

    try {
      switch (sub) {
        case undefined:
        case "help": {
          return {
            exitCode: 0,
            stdout: [
              "Usage: bb workspaces <command>",
              "",
              "Commands:",
              "  list          List workspaces and their folders with live thread counts",
              "  create <name> Create a named workspace",
              "  rename <workspace> <name>  Rename a workspace",
              "  add <path> [--workspace <id|name>] [--host <id>]  Add a folder",
              "  remove <path> [--workspace <id|name>]  Remove a folder",
              "  run <prompt> [--workspace <id|name>] [--project <id|name>...] [--hidden]",
              "                Run one agent thread per folder",
              "  status        Show thread counts per workspace folder",
            ].join("\n"),
          };
        }
        case "list": {
          const views = await listWorkspaceViews();
          const defaultWorkspace = getOrCreateDefaultWorkspace();
          void defaultWorkspace;
          const table = formatWorkspaceTable(views);
          return { exitCode: 0, stdout: table || "No workspaces yet." };
        }
        case "create": {
          const name = positional[0]?.trim();
          if (!name) {
            return { exitCode: 1, stderr: "usage: bb workspaces create <name>" };
          }
          const row: WorkspaceRow = {
            id: newId(),
            name,
            createdAt: now(),
            updatedAt: now(),
          };
          try {
            db.prepare(
              "INSERT INTO workspaces (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
            ).run(row.id, row.name, row.createdAt, row.updatedAt);
          } catch (error) {
            return {
              exitCode: 1,
              stderr: `could not create workspace "${name}": ${String(error)}`,
            };
          }
          publishChanged();
          return {
            exitCode: 0,
            stdout: `Created workspace "${name}" (${row.id})`,
          };
        }
        case "rename": {
          const workspaceSpec = positional[0];
          const name = positional[1]?.trim();
          if (!workspaceSpec || !name) {
            return {
              exitCode: 1,
              stderr: "usage: bb workspaces rename <workspace> <name>",
            };
          }
          const workspace = selectWorkspace(workspaceSpec);
          const other = db
            .prepare("SELECT id FROM workspaces WHERE name = ? AND id != ?")
            .get(name, workspace.id);
          if (other) {
            return { exitCode: 1, stderr: `a workspace named "${name}" already exists` };
          }
          db.prepare("UPDATE workspaces SET name = ?, updatedAt = ? WHERE id = ?").run(
            name,
            now(),
            workspace.id,
          );
          publishChanged();
          return { exitCode: 0, stdout: `Renamed workspace to "${name}" (${workspace.id})` };
        }
        case "add": {
          const path = positional[0];
          if (!path) {
            return {
              exitCode: 1,
              stderr: "usage: bb workspaces add <path> [--workspace <id|name>] [--host <id>]",
            };
          }
          const workspace = selectWorkspace(flagValue(flags, "workspace"));
          const hostOverride = flagValue(flags, "host");
          // Existence sanity check on the target host (informational).
          const hostId =
            hostOverride ??
            (await (async () => {
              try {
                return await resolveHost();
              } catch {
                return undefined;
              }
            })());
          if (hostId) {
            try {
              const { existence } = await bb.sdk.hosts.pathsExist({
                hostId,
                paths: [normalizePath(path)],
              });
              if (!existence[normalizePath(path)]) {
                return {
                  exitCode: 1,
                  stderr: `path not found on host ${hostId}: ${normalizePath(path)}`,
                };
              }
            } catch (error) {
              bb.log.debug(`pathsExist unavailable: ${String(error)}`);
            }
          }
          const { row, createdProject } = await addFolderToWorkspace(
            workspace.id,
            path,
          );
          return {
            exitCode: 0,
            stdout: `Added ${row.path} to workspace "${workspace.name}"` +
              (createdProject ? " (created a new bb project)" : ""),
          };
        }
        case "remove": {
          const path = positional[0];
          if (!path) {
            return {
              exitCode: 1,
              stderr: "usage: bb workspaces remove <path> [--workspace <id|name>]",
            };
          }
          const workspace = selectWorkspace(flagValue(flags, "workspace"));
          const normalized = normalizePath(path);
          const result = db
            .prepare(
              "DELETE FROM workspace_folders WHERE workspaceId = ? AND path = ?",
            )
            .run(workspace.id, normalized);
          if (result.changes === 0) {
            return {
              exitCode: 1,
              stderr: `${normalized} is not a folder of workspace "${workspace.name}"`,
            };
          }
          reindexPositions(workspace.id);
          touchWorkspace(workspace.id);
          publishChanged();
          return {
            exitCode: 0,
            stdout: `Removed ${normalized} from workspace "${workspace.name}"`,
          };
        }
        case "status": {
          const views = await listWorkspaceViews();
          const lines: string[] = [];
          for (const workspace of views) {
            lines.push(`${workspace.name}: ${workspace.threadCount} total threads`);
            for (const folder of workspace.folders) {
              lines.push(
                `  ${folder.position + 1}. ${folder.projectName}: ${folder.threadCount} thread${folder.threadCount === 1 ? "" : "s"} (${folder.projectId})`,
              );
            }
          }
          return { exitCode: 0, stdout: lines.join("\n") || "No workspaces yet." };
        }
        case "run": {
          const prompt = positional.join(" ").trim();
          if (!prompt) {
            return {
              exitCode: 1,
              stderr:
                "usage: bb workspaces run <prompt> [--workspace <id|name>] [--project <id|name>...] [--hidden]",
            };
          }
          const workspace = selectWorkspace(flagValue(flags, "workspace"));
          const projectFilters = flagValues(flags, "project");
          const projectIds = await resolveProjectFilters(
            projectFilters,
            workspace.id,
          );
          const { threads } = await runOnWorkspace({
            workspaceId: workspace.id,
            prompt,
            projectIds: projectIds.length > 0 ? projectIds : undefined,
            hidden: flags.get("hidden") === true,
            parentThreadId: ctx.threadId,
          });
          const lines = threads.map(
            (t) => `${t.projectName}: ${t.threadId} — ${t.title}`,
          );
          return {
            exitCode: 0,
            stdout: `Spawned ${threads.length} thread${threads.length === 1 ? "" : "s"} in workspace "${workspace.name}":\n${lines.join("\n")}`,
          };
        }
        default:
          return { exitCode: 1, stderr: `unknown command: ${sub}` };
      }
    } catch (error) {
      return { exitCode: 1, stderr: String(error) };
    }
  }

  function reindexPositions(workspaceId: string): void {
    const folders = listFolderRows(workspaceId);
    const update = db.prepare(
      "UPDATE workspace_folders SET position = ? WHERE id = ?",
    );
    const tx = db.transaction(() => {
      folders.forEach((folder, index) => {
        update.run(index, folder.id);
      });
    });
    tx();
  }

  async function resolveProjectFilters(
    specs: string[],
    workspaceId: string,
  ): Promise<string[]> {
    if (specs.length === 0) return [];
    const folders = listFolderRows(workspaceId);
    const projects = await bb.sdk.projects.list({ includePersonal: false });
    const byId = new Map(projects.map((p) => [p.id, p]));
    const byName = new Map(projects.map((p) => [p.name, p]));
    const result: string[] = [];
    for (const spec of specs) {
      const match = byId.get(spec) ?? byName.get(spec);
      if (!match) throw new Error(`unknown project filter: ${spec}`);
      const isFolder = folders.some((f) => f.projectId === match.id);
      if (!isFolder) {
        throw new Error(
          `${match.name} (${match.id}) is not a folder of this workspace`,
        );
      }
      result.push(match.id);
    }
    return result;
  }

  bb.cli.register({
    name: "workspaces",
    summary: "Multi-root workspace aggregator: group bb projects into workspaces and run agent threads across folders",
    commands: [
      {
        name: "list",
        summary: "List workspaces and their folders with live thread counts",
        usage: "bb workspaces list",
      },
      {
        name: "create",
        summary: "Create a named workspace",
        usage: "bb workspaces create <name>",
      },
      {
        name: "rename",
        summary: "Rename a workspace",
        usage: "bb workspaces rename <workspace> <name>",
      },
      {
        name: "add",
        summary: "Add a folder (resolved to an existing bb project, or create one) to a workspace",
        usage: "bb workspaces add <path> [--workspace <id|name>] [--host <id>]",
      },
      {
        name: "remove",
        summary: "Remove a folder from a workspace",
        usage: "bb workspaces remove <path> [--workspace <id|name>]",
      },
      {
        name: "run",
        summary: "Run one agent thread per workspace folder",
        usage: "bb workspaces run <prompt> [--workspace <id|name>] [--project <id|name> ...] [--hidden]",
      },
      {
        name: "status",
        summary: "Show live thread counts per workspace folder",
        usage: "bb workspaces status",
      },
    ],
    run: (argv, ctx) => runCli(argv, { threadId: ctx.threadId }),
  });

  // --- RPC ------------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    list: async () => ({ workspaces: await listWorkspaceViews() }),
    createWorkspace: async ({ name }) => {
      const row: WorkspaceRow = {
        id: newId(),
        name,
        createdAt: now(),
        updatedAt: now(),
      };
      try {
        db.prepare(
          "INSERT INTO workspaces (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)",
        ).run(row.id, row.name, row.createdAt, row.updatedAt);
      } catch (error) {
        throw new Error(`a workspace named "${name}" already exists`);
      }
      publishChanged();
      const views = await listWorkspaceViews();
      const workspace = views.find((w) => w.id === row.id);
      if (!workspace) throw new Error("workspace disappeared after creation");
      return { workspace };
    },
    renameWorkspace: async ({ workspaceId, name }) => {
      const workspace = getWorkspaceRow(workspaceId);
      const other = db
        .prepare("SELECT id FROM workspaces WHERE name = ? AND id != ?")
        .get(name, workspace.id);
      if (other) throw new Error(`a workspace named "${name}" already exists`);
      db.prepare("UPDATE workspaces SET name = ?, updatedAt = ? WHERE id = ?").run(
        name,
        now(),
        workspace.id,
      );
      publishChanged();
      const views = await listWorkspaceViews();
      const updated = views.find((w) => w.id === workspaceId);
      if (!updated) throw new Error("workspace disappeared after rename");
      return { workspace: updated };
    },
    deleteWorkspace: async ({ workspaceId }) => {
      const workspace = getWorkspaceRow(workspaceId);
      const removeFolders = db.prepare(
        "DELETE FROM workspace_folders WHERE workspaceId = ?",
      );
      const removeWorkspace = db.prepare("DELETE FROM workspaces WHERE id = ?");
      const tx = db.transaction(() => {
        removeFolders.run(workspace.id);
        removeWorkspace.run(workspace.id);
      });
      tx();
      publishChanged();
      return { ok: true as const };
    },
    addFolder: async ({ workspaceId, path }) => {
      const { row, createdProject } = await addFolderToWorkspace(workspaceId, path);
      const projects = await bb.sdk.projects.list({ includePersonal: false });
      const project = projects.find((p) => p.id === row.projectId);
      const counts = await threadCountsForProjects([row.projectId]);
      return {
        createdProject,
        folder: {
          id: row.id,
          workspaceId: row.workspaceId,
          projectId: row.projectId,
          projectName: project?.name ?? "(missing project)",
          hostId: row.hostId,
          path: row.path,
          position: row.position,
          threadCount: counts.get(row.projectId) ?? 0,
          createdAt: row.createdAt,
        },
      };
    },
    removeFolder: async ({ workspaceId, folderId }) => {
      const result = db
        .prepare("DELETE FROM workspace_folders WHERE id = ? AND workspaceId = ?")
        .run(folderId, workspaceId);
      if (result.changes === 0) {
        throw new Error(`folder not found: ${folderId}`);
      }
      reindexPositions(workspaceId);
      touchWorkspace(workspaceId);
      publishChanged();
      return { ok: true as const };
    },
    moveFolder: async ({ workspaceId, folderId, direction }) => {
      const folders = listFolderRows(workspaceId);
      const index = folders.findIndex((f) => f.id === folderId);
      if (index < 0) throw new Error(`folder not found: ${folderId}`);
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= folders.length) {
        return { ok: true as const };
      }
      const swap = folders[index];
      folders[index] = folders[target];
      folders[target] = swap;
      const update = db.prepare(
        "UPDATE workspace_folders SET position = ? WHERE id = ?",
      );
      const tx = db.transaction(() => {
        folders.forEach((folder, position) => {
          update.run(position, folder.id);
        });
      });
      tx();
      touchWorkspace(workspaceId);
      publishChanged();
      return { ok: true as const };
    },
    run: async ({ workspaceId, prompt, projectIds, hidden }) => {
      return runOnWorkspace({ workspaceId, prompt, projectIds, hidden });
    },
  });

  // --- Agent tools ------------------------------------------------------------

  bb.agents.registerTool({
    name: "workspace_run",
    description:
      "Run a prompt across the folders of a bb workspace, spawning one agent thread per folder (each in its own project/repo). Use for coordinated multi-repo work, e.g. applying the same change across backend and frontend. Returns the spawned thread ids.",
    instructions:
      "When a task spans multiple repositories, prefer workspace_run over sequential single-repo work so each repo's thread runs in parallel.",
    presentation: {
      label: {
        pending: "Running across workspace folders",
        completed: "Ran across workspace folders",
      },
    },
    parameters: z
      .object({
        prompt: z
          .string()
          .min(1)
          .describe("The task to run in every folder."),
        workspaceId: z
          .string()
          .optional()
          .describe("Workspace id; defaults to the default workspace. List with workspaces_list."),
        workspaceName: z
          .string()
          .optional()
          .describe("Workspace name, alternative to workspaceId."),
        projectIds: z
          .array(z.string())
          .optional()
          .describe("Restrict to these project ids within the workspace."),
      })
      .strict(),
    async execute(args, { threadId }) {
      const spec = args.workspaceId ?? args.workspaceName;
      const workspace = selectWorkspace(spec);
      const { threads } = await runOnWorkspace({
        workspaceId: workspace.id,
        prompt: args.prompt,
        projectIds: args.projectIds,
        parentThreadId: threadId,
      });
      return JSON.stringify(
        {
          workspace: workspace.name,
          spawned: threads.length,
          threads: threads.map((t) => ({
            threadId: t.threadId,
            projectId: t.projectId,
            projectName: t.projectName,
            title: t.title,
          })),
        },
        null,
        2,
      );
    },
  });

  bb.agents.registerTool({
    name: "workspaces_list",
    description:
      "List bb workspaces and their folders (project id, name, path, live thread count). Use to discover workspace ids before workspace_run.",
    presentation: {
      label: {
        pending: "Listing workspaces",
        completed: "Listed workspaces",
      },
    },
    parameters: z.object({}).strict(),
    async execute() {
      const views = await listWorkspaceViews();
      return JSON.stringify(views, null, 2);
    },
  });

  bb.onDispose(() => bb.log.info("workspaces disposed"));
  bb.log.info("workspaces loaded");
}
