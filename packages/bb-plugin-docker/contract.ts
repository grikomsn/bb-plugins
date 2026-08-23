import {
  defineRpcContract,
  type ExperimentalHostSignals,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

export const dockerInfoSchema = z
  .object({
    version: z.string(),
    context: z.string(),
    os: z.string(),
    serverVersion: z.string(),
    reachable: z.boolean(),
    error: z.string().optional(),
  })
  .strict();

export const containerSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    image: z.string(),
    state: z.string(),
    status: z.string(),
    ports: z.string(),
    uptime: z.string(),
  })
  .strict();

export const imageSchema = z
  .object({
    id: z.string(),
    repository: z.string(),
    tag: z.string(),
    size: z.string(),
    created: z.string(),
  })
  .strict();

export const volumeSchema = z
  .object({
    name: z.string(),
    driver: z.string(),
    mountpoint: z.string(),
  })
  .strict();

export const networkSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    driver: z.string(),
    scope: z.string(),
  })
  .strict();

export const snapshotSchema = z
  .object({
    docker: dockerInfoSchema,
    containers: z.array(containerSchema),
    images: z.array(imageSchema),
    volumes: z.array(volumeSchema),
    networks: z.array(networkSchema),
  })
  .strict();

const actionResultSchema = z
  .object({
    ok: z.boolean(),
    error: z.string().optional(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  snapshot: {
    input: z.null(),
    output: snapshotSchema,
  },
  containerAction: {
    input: z
      .object({
        id: z.string().min(1),
        action: z.enum(["start", "stop", "restart", "remove"]),
        force: z.boolean().optional(),
      })
      .strict(),
    output: actionResultSchema,
  },
  imageAction: {
    input: z
      .object({
        ref: z.string().min(1),
        action: z.literal("remove"),
      })
      .strict(),
    output: actionResultSchema,
  },
  imagePull: {
    input: z.object({ ref: z.string().min(1) }).strict(),
    output: actionResultSchema,
  },
  volumeAction: {
    input: z
      .object({
        name: z.string().min(1),
        action: z.enum(["create", "remove"]),
      })
      .strict(),
    output: actionResultSchema,
  },
  networkAction: {
    input: z
      .object({
        name: z.string().min(1),
        action: z.enum(["create", "remove"]),
      })
      .strict(),
    output: actionResultSchema,
  },
  logs: {
    input: z
      .object({
        id: z.string().min(1),
        tail: z.number().int().min(1).max(2_000),
      })
      .strict(),
    output: z.object({ lines: z.array(z.string()) }).strict(),
  },
  prune: {
    input: z
      .object({
        kind: z.enum(["system", "images", "volumes", "networks"]),
      })
      .strict(),
    output: z
      .object({
        ok: z.boolean(),
        reclaimedBytes: z.number().int().nonnegative(),
        removedItems: z.array(z.string()),
        stderr: z.string().optional(),
      })
      .strict(),
  },
  exec: {
    input: z
      .object({
        id: z.string().min(1),
        cmd: z.array(z.string()).min(1),
      })
      .strict(),
    output: z
      .object({
        stdout: z.string(),
        stderr: z.string(),
        exitCode: z.number().int(),
      })
      .strict(),
  },
});

const hostErrorSchema = z
  .object({
    code: z.union([z.string(), z.number()]),
    stderr: z.string(),
  })
  .strict();

function hostResultSchema<Value extends z.ZodType>(value: Value) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value }).strict(),
    z.object({ ok: z.literal(false), error: hostErrorSchema }).strict(),
  ]);
}

const hostActionValueSchema = z
  .object({ stdout: z.string(), stderr: z.string(), exitCode: z.number().int() })
  .strict();

export const hostContract = defineRpcContract({
  info: {
    input: z.null(),
    output: hostResultSchema(dockerInfoSchema),
  },
  ps: {
    input: z.null(),
    output: hostResultSchema(z.array(containerSchema)),
  },
  images: {
    input: z.null(),
    output: hostResultSchema(z.array(imageSchema)),
  },
  volumes: {
    input: z.null(),
    output: hostResultSchema(z.array(volumeSchema)),
  },
  networks: {
    input: z.null(),
    output: hostResultSchema(z.array(networkSchema)),
  },
  containerAction: {
    input: rpcContract.containerAction.input,
    output: hostResultSchema(hostActionValueSchema),
  },
  imageAction: {
    input: rpcContract.imageAction.input,
    output: hostResultSchema(hostActionValueSchema),
  },
  imagePull: {
    input: rpcContract.imagePull.input,
    output: hostResultSchema(hostActionValueSchema),
  },
  volumeAction: {
    input: rpcContract.volumeAction.input,
    output: hostResultSchema(hostActionValueSchema),
  },
  networkAction: {
    input: rpcContract.networkAction.input,
    output: hostResultSchema(hostActionValueSchema),
  },
  logs: {
    input: rpcContract.logs.input,
    output: hostResultSchema(z.object({ lines: z.array(z.string()) }).strict()),
  },
  prune: {
    input: rpcContract.prune.input,
    output: hostResultSchema(rpcContract.prune.output),
  },
  exec: {
    input: rpcContract.exec.input,
    output: hostResultSchema(rpcContract.exec.output),
  },
});

export const hostSignals = {
  snapshotChanged: {
    payload: z
      .object({
        reason: z.string(),
      })
      .strict(),
  },
} satisfies ExperimentalHostSignals;

export type DockerSnapshot = z.infer<typeof snapshotSchema>;
export type DockerContainer = z.infer<typeof containerSchema>;
