import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared data shapes (server + app).
// ---------------------------------------------------------------------------

export const workspaceFolderViewSchema = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    projectId: z.string(),
    projectName: z.string(),
    hostId: z.string(),
    path: z.string(),
    position: z.number().int().nonnegative(),
    threadCount: z.number().int().nonnegative(),
    createdAt: z.number(),
  })
  .strict();

export type WorkspaceFolderView = z.infer<typeof workspaceFolderViewSchema>;

export const workspaceViewSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    folders: z.array(workspaceFolderViewSchema),
    threadCount: z.number().int().nonnegative(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .strict();

export type WorkspaceView = z.infer<typeof workspaceViewSchema>;

export const runResultSchema = z
  .object({
    threads: z.array(
      z
        .object({
          threadId: z.string(),
          projectId: z.string(),
          projectName: z.string(),
          title: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

export type RunResult = z.infer<typeof runResultSchema>;

// ---------------------------------------------------------------------------
// RPC contract — the frontend data plane.
// ---------------------------------------------------------------------------

export const rpcContract = defineRpcContract({
  list: {
    input: z.null(),
    output: z.object({ workspaces: z.array(workspaceViewSchema) }).strict(),
  },
  createWorkspace: {
    input: z.object({ name: z.string().trim().min(1).max(120) }).strict(),
    output: z.object({ workspace: workspaceViewSchema }).strict(),
  },
  renameWorkspace: {
    input: z.object({ workspaceId: z.string(), name: z.string().trim().min(1).max(120) }).strict(),
    output: z.object({ workspace: workspaceViewSchema }).strict(),
  },
  deleteWorkspace: {
    input: z.object({ workspaceId: z.string() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  addFolder: {
    input: z.object({ workspaceId: z.string(), path: z.string().min(1) }).strict(),
    output: z.object({ folder: workspaceFolderViewSchema, createdProject: z.boolean() }).strict(),
  },
  removeFolder: {
    input: z.object({ workspaceId: z.string(), folderId: z.string() }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  moveFolder: {
    input: z
      .object({ workspaceId: z.string(), folderId: z.string(), direction: z.enum(["up", "down"]) })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  run: {
    input: z
      .object({
        workspaceId: z.string(),
        prompt: z.string().min(1),
        projectIds: z.array(z.string()).optional(),
        hidden: z.boolean().optional(),
      })
      .strict(),
    output: runResultSchema,
  },
});

export type RpcContract = typeof rpcContract;
