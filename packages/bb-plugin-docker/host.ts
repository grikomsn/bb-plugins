import { execFile, type ChildProcess } from "node:child_process";
import {
  experimental_defineHostEntry,
  type ExperimentalHostRpcContext,
} from "@get-bb/plugin-sdk/host";
import { hostContract, hostSignals } from "./contract.js";

const DOCKER_TIMEOUT_MS = 30_000;
const DOCKER_MAX_BUFFER = 1024 * 1024;
const inFlight = new Set<ChildProcess>();

type HostContext = ExperimentalHostRpcContext<typeof hostSignals>;

type DockerCommandResult =
  | { ok: true; stdout: string; stderr: string; exitCode: 0 }
  | {
      ok: false;
      stdout: string;
      stderr: string;
      exitCode: string | number;
    };

function runDocker(
  argv: string[],
  context: { signal: AbortSignal; lifecycle: { signal: AbortSignal } },
): Promise<DockerCommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const child = execFile(
      "docker",
      argv,
      {
        timeout: DOCKER_TIMEOUT_MS,
        maxBuffer: DOCKER_MAX_BUFFER,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        cleanup();
        const normalizedStdout = String(stdout ?? "");
        const normalizedStderr = String(stderr ?? "");
        if (!error) {
          resolve({
            ok: true,
            stdout: normalizedStdout,
            stderr: normalizedStderr,
            exitCode: 0,
          });
          return;
        }
        resolve({
          ok: false,
          stdout: normalizedStdout,
          stderr: normalizedStderr || error.message,
          exitCode: error.code ?? -1,
        });
      },
    );

    const abort = () => {
      if (!child.killed) child.kill("SIGTERM");
    };
    const cleanup = () => {
      inFlight.delete(child);
      context.signal.removeEventListener("abort", abort);
      context.lifecycle.signal.removeEventListener("abort", abort);
    };

    inFlight.add(child);
    context.signal.addEventListener("abort", abort, { once: true });
    context.lifecycle.signal.addEventListener("abort", abort, { once: true });
    if (context.signal.aborted || context.lifecycle.signal.aborted) abort();
  });
}

function failure(result: Extract<DockerCommandResult, { ok: false }>) {
  return {
    ok: false as const,
    error: { code: result.exitCode, stderr: result.stderr },
  };
}

function parseJsonLines(stdout: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        rows.push(value as Record<string, unknown>);
      }
    } catch {
      // Ignore a malformed formatter row and keep the bounded snapshot usable.
    }
  }
  return rows;
}

function field(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

async function emitChanged(context: HostContext, reason: string): Promise<void> {
  try {
    await context.experimental_emitSignal("snapshotChanged", { reason });
  } catch {
    // Signals are lossy invalidations; polling remains the durable fallback.
  }
}

function parseReclaimedBytes(output: string): number {
  const match = output.match(
    /Total reclaimed space:\s*([0-9.]+)\s*(B|kB|KB|MB|GB|TB)/i,
  );
  if (!match) return 0;
  const amount = Number.parseFloat(match[1] ?? "0");
  const unit = (match[2] ?? "B").toUpperCase();
  const multiplier: Record<string, number> = {
    B: 1,
    KB: 1_000,
    MB: 1_000_000,
    GB: 1_000_000_000,
    TB: 1_000_000_000_000,
  };
  return Math.max(0, Math.round(amount * (multiplier[unit] ?? 1)));
}

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    async info(_input, context) {
      const version = await runDocker(
        ["version", "--format", "{{json .}}"],
        context,
      );
      if (!version.ok) return failure(version);

      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(version.stdout) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      const client =
        parsed.Client && typeof parsed.Client === "object"
          ? (parsed.Client as Record<string, unknown>)
          : {};
      const server =
        parsed.Server && typeof parsed.Server === "object"
          ? (parsed.Server as Record<string, unknown>)
          : {};
      const platform =
        server.Platform && typeof server.Platform === "object"
          ? (server.Platform as Record<string, unknown>)
          : {};
      const contextResult = await runDocker(["context", "show"], context);

      return {
        ok: true as const,
        value: {
          version: field(client, "Version"),
          context: contextResult.ok ? contextResult.stdout.trim() : "",
          os: field(server, "Os") || field(platform, "Name"),
          serverVersion: field(server, "Version"),
          reachable: true,
        },
      };
    },

    async ps(_input, context) {
      const result = await runDocker(
        ["ps", "-a", "--no-trunc", "--format", "{{json .}}"],
        context,
      );
      if (!result.ok) return failure(result);
      return {
        ok: true as const,
        value: parseJsonLines(result.stdout).map((row) => ({
          id: field(row, "ID"),
          name: field(row, "Names"),
          image: field(row, "Image"),
          state: field(row, "State"),
          status: field(row, "Status"),
          ports: field(row, "Ports"),
          uptime: field(row, "Status"),
        })),
      };
    },

    async images(_input, context) {
      const result = await runDocker(
        ["images", "--no-trunc", "--format", "{{json .}}"],
        context,
      );
      if (!result.ok) return failure(result);
      return {
        ok: true as const,
        value: parseJsonLines(result.stdout).map((row) => ({
          id: field(row, "ID"),
          repository: field(row, "Repository"),
          tag: field(row, "Tag"),
          size: field(row, "Size"),
          created: field(row, "CreatedSince") || field(row, "CreatedAt"),
        })),
      };
    },

    async volumes(_input, context) {
      const result = await runDocker(
        ["volume", "ls", "--format", "{{json .}}"],
        context,
      );
      if (!result.ok) return failure(result);
      return {
        ok: true as const,
        value: parseJsonLines(result.stdout).map((row) => ({
          name: field(row, "Name"),
          driver: field(row, "Driver"),
          mountpoint: field(row, "Mountpoint"),
        })),
      };
    },

    async networks(_input, context) {
      const result = await runDocker(
        ["network", "ls", "--format", "{{json .}}"],
        context,
      );
      if (!result.ok) return failure(result);
      return {
        ok: true as const,
        value: parseJsonLines(result.stdout).map((row) => ({
          id: field(row, "ID"),
          name: field(row, "Name"),
          driver: field(row, "Driver"),
          scope: field(row, "Scope"),
        })),
      };
    },

    async containerAction({ id, action, force }, context) {
      const argv =
        action === "remove"
          ? ["rm", ...(force ? ["-f"] : []), id]
          : [action, id];
      const result = await runDocker(argv, context);
      if (!result.ok) return failure(result);
      await emitChanged(context, `container:${action}`);
      return {
        ok: true as const,
        value: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        },
      };
    },

    async imageAction({ ref }, context) {
      const result = await runDocker(["rmi", ref], context);
      if (!result.ok) return failure(result);
      await emitChanged(context, "image:remove");
      return {
        ok: true as const,
        value: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        },
      };
    },

    async imagePull({ ref }, context) {
      const result = await runDocker(["pull", ref], context);
      if (!result.ok) return failure(result);
      await emitChanged(context, "image:pull");
      return {
        ok: true as const,
        value: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        },
      };
    },

    async volumeAction({ name, action }, context) {
      const argv =
        action === "create"
          ? ["volume", "create", name]
          : ["volume", "rm", name];
      const result = await runDocker(argv, context);
      if (!result.ok) return failure(result);
      await emitChanged(context, `volume:${action}`);
      return {
        ok: true as const,
        value: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        },
      };
    },

    async networkAction({ name, action }, context) {
      const argv =
        action === "create"
          ? ["network", "create", name]
          : ["network", "rm", name];
      const result = await runDocker(argv, context);
      if (!result.ok) return failure(result);
      await emitChanged(context, `network:${action}`);
      return {
        ok: true as const,
        value: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        },
      };
    },

    async logs({ id, tail }, context) {
      const result = await runDocker(
        ["logs", "--tail", String(tail), id],
        context,
      );
      if (!result.ok) return failure(result);
      const combined = [result.stdout, result.stderr]
        .filter(Boolean)
        .join(result.stdout && result.stderr ? "\n" : "");
      return {
        ok: true as const,
        value: {
          lines: combined ? combined.replace(/\r\n/g, "\n").split("\n") : [],
        },
      };
    },

    async prune({ kind }, context) {
      const noun =
        kind === "images"
          ? "image"
          : kind === "volumes"
            ? "volume"
            : kind === "networks"
              ? "network"
              : "system";
      const result = await runDocker([noun, "prune", "-f"], context);
      if (!result.ok) return failure(result);
      await emitChanged(context, `prune:${kind}`);
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      return {
        ok: true as const,
        value: {
          ok: true,
          reclaimedBytes: parseReclaimedBytes(output),
          removedItems: output
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(
              (line) =>
                line.length > 0 &&
                !line.toLowerCase().startsWith("total reclaimed space"),
            ),
          ...(result.stderr ? { stderr: result.stderr } : {}),
        },
      };
    },

    async exec({ id, cmd }, context) {
      const result = await runDocker(["exec", id, ...cmd], context);
      if (!result.ok && typeof result.exitCode === "string") {
        return failure(result);
      }
      return {
        ok: true as const,
        value: {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode:
            typeof result.exitCode === "number" ? result.exitCode : -1,
        },
      };
    },
  },

  dispose() {
    for (const child of inFlight) {
      if (!child.killed) child.kill("SIGTERM");
    }
    inFlight.clear();
  },
});
