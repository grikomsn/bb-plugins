import {
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import {
  hostContract,
  hostSignals,
  rpcContract,
  type DockerSnapshot,
} from "./contract.js";

export { rpcContract } from "./contract.js";

const POLL_INTERVAL_MS = 2_000;
const CLI_OUTPUT_RESERVE_BYTES = 1_024;
const CLI_MAX_REMOVED_ITEMS = 50;

const CLI_HELP = `Usage: bb docker <command>

Commands:
  ps                         List containers
  images                     List images
  volumes                    List volumes
  networks                   List networks
  info                       Show Docker connection information
  prune <kind> --yes         Prune system, images, volumes, or networks
`;

function capCliOutput(value: string): string {
  const maxBytes = PLUGIN_CLI_OUTPUT_MAX_BYTES - CLI_OUTPUT_RESERVE_BYTES;
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  const suffix = "\n... output truncated\n";
  const bodyBytes = maxBytes - Buffer.byteLength(suffix, "utf8");
  const body = Buffer.from(value, "utf8")
    .subarray(0, bodyBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return `${body}${suffix}`;
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(
      header.length,
      ...rows.map((row) => (row[column] ?? "").length),
    ),
  );
  const formatRow = (row: string[]) =>
    row.map((value, column) => value.padEnd(widths[column] ?? 0)).join("  ").trimEnd();
  return capCliOutput([formatRow(headers), ...rows.map(formatRow)].join("\n") + "\n");
}

function cliError(message: string, exitCode = 1): PluginCliResult {
  return { exitCode, stderr: capCliOutput(`${message.trim()}\n`) };
}

function cliCancelled(ctx: PluginCliContext): PluginCliResult | null {
  return ctx.signal?.aborted ? cliError("Docker command cancelled.", 130) : null;
}

function emptySnapshot(error = "Waiting for the Docker host probe."): DockerSnapshot {
  return {
    docker: {
      version: "",
      context: "",
      os: "",
      serverVersion: "",
      reachable: false,
      error,
    },
    containers: [],
    images: [],
    volumes: [],
    networks: [],
  };
}

function abortAwareSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("docker plugin loading");

  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });

  let latestSnapshot = emptySnapshot();
  let latestHostId: string | null = null;
  let invalidated = true;

  async function resolveHostId(signal?: AbortSignal): Promise<string> {
    const hosts = await bb.sdk.hosts.list({ signal });
    const selected = hosts.find((candidate) => candidate.status === "connected") ?? hosts[0];
    if (!selected) throw new Error("No enrolled bb host is available.");
    latestHostId = selected.id;
    return selected.id;
  }

  async function collectSnapshot(signal?: AbortSignal): Promise<DockerSnapshot> {
    try {
      const hostId = latestHostId ?? (await resolveHostId(signal));
      const [info, containers, images, volumes, networks] = await Promise.all([
        host.call("info", null, { hostId, signal }),
        host.call("ps", null, { hostId, signal }),
        host.call("images", null, { hostId, signal }),
        host.call("volumes", null, { hostId, signal }),
        host.call("networks", null, { hostId, signal }),
      ]);

      const docker = info.ok
        ? info.value
        : {
            version: "",
            context: "",
            os: "",
            serverVersion: "",
            reachable: false,
            error: info.error.stderr,
          };

      latestSnapshot = {
        docker,
        containers: containers.ok ? containers.value : [],
        images: images.ok ? images.value : [],
        volumes: volumes.ok ? volumes.value : [],
        networks: networks.ok ? networks.value : [],
      };
    } catch (error) {
      if (!signal?.aborted) {
        latestHostId = null;
        latestSnapshot = emptySnapshot(String(error));
      }
    }
    invalidated = false;
    return latestSnapshot;
  }

  async function publishSnapshot(signal?: AbortSignal): Promise<void> {
    const snapshot = await collectSnapshot(signal);
    if (!signal?.aborted) {
      bb.realtime.publish("docker/snapshot", snapshot);
    }
  }

  const unsubscribeChanged = host.experimental_onSignal(
    "snapshotChanged",
    ({ hostId }) => {
      if (!latestHostId || hostId === latestHostId) invalidated = true;
    },
  );
  const unsubscribeWorkerExit = host.experimental_onWorkerExit(({ hostId }) => {
    if (hostId === latestHostId) {
      latestHostId = null;
      invalidated = true;
    }
  });

  bb.rpc.register(rpcContract, {
    snapshot: () => latestSnapshot,

    async containerAction(input) {
      try {
        const hostId = latestHostId ?? (await resolveHostId());
        const result = await host.call("containerAction", input, { hostId });
        if (!result.ok) return { ok: false, error: result.error.stderr };
        await publishSnapshot();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },

    async imageAction(input) {
      try {
        const hostId = latestHostId ?? (await resolveHostId());
        const result = await host.call("imageAction", input, { hostId });
        if (!result.ok) return { ok: false, error: result.error.stderr };
        await publishSnapshot();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },

    async imagePull(input) {
      try {
        const hostId = latestHostId ?? (await resolveHostId());
        const result = await host.call("imagePull", input, { hostId });
        if (!result.ok) return { ok: false, error: result.error.stderr };
        await publishSnapshot();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },

    async volumeAction(input) {
      try {
        const hostId = latestHostId ?? (await resolveHostId());
        const result = await host.call("volumeAction", input, { hostId });
        if (!result.ok) return { ok: false, error: result.error.stderr };
        await publishSnapshot();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },

    async networkAction(input) {
      try {
        const hostId = latestHostId ?? (await resolveHostId());
        const result = await host.call("networkAction", input, { hostId });
        if (!result.ok) return { ok: false, error: result.error.stderr };
        await publishSnapshot();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },

    async logs(input) {
      const hostId = latestHostId ?? (await resolveHostId());
      const result = await host.call("logs", input, { hostId });
      if (!result.ok) throw new Error(result.error.stderr);
      return result.value;
    },

    async prune(input) {
      try {
        const hostId = latestHostId ?? (await resolveHostId());
        const result = await host.call("prune", input, { hostId });
        if (!result.ok) {
          return {
            ok: false,
            reclaimedBytes: 0,
            removedItems: [],
            stderr: result.error.stderr,
          };
        }
        await publishSnapshot();
        return result.value;
      } catch (error) {
        return {
          ok: false,
          reclaimedBytes: 0,
          removedItems: [],
          stderr: String(error),
        };
      }
    },

    async exec(input) {
      const hostId = latestHostId ?? (await resolveHostId());
      const result = await host.call("exec", input, { hostId });
      if (!result.ok) throw new Error(result.error.stderr);
      return result.value;
    },
  });

  bb.cli.register({
    name: "docker",
    summary: "Inspect and clean up Docker resources",
    commands: [
      { name: "ps", summary: "List containers", usage: "bb docker ps" },
      { name: "images", summary: "List images", usage: "bb docker images" },
      { name: "volumes", summary: "List volumes", usage: "bb docker volumes" },
      { name: "networks", summary: "List networks", usage: "bb docker networks" },
      { name: "info", summary: "Show Docker information", usage: "bb docker info" },
      {
        name: "prune",
        summary: "Remove unused Docker resources",
        usage: "bb docker prune <system|images|volumes|networks> --yes",
      },
    ],
    async run(argv, ctx) {
      const cancelled = cliCancelled(ctx);
      if (cancelled) return cancelled;

      const [command, ...args] = argv;
      if (!command || command === "help" || command === "-h" || command === "--help") {
        return { exitCode: 0, stdout: CLI_HELP };
      }

      try {
        const hostId = latestHostId ?? (await resolveHostId(ctx.signal));
        const cancelledAfterResolve = cliCancelled(ctx);
        if (cancelledAfterResolve) return cancelledAfterResolve;

        switch (command) {
          case "ps": {
            if (args.length > 0) return cliError("Usage: bb docker ps", 2);
            const result = await host.call("ps", null, { hostId, signal: ctx.signal });
            if (!result.ok) return cliError(result.error.stderr);
            return {
              exitCode: 0,
              stdout: formatTable(
                ["ID", "NAME", "IMAGE", "STATE", "PORTS"],
                result.value.map((container) => [
                  container.id,
                  container.name,
                  container.image,
                  container.state,
                  container.ports,
                ]),
              ),
            };
          }
          case "images": {
            if (args.length > 0) return cliError("Usage: bb docker images", 2);
            const result = await host.call("images", null, { hostId, signal: ctx.signal });
            if (!result.ok) return cliError(result.error.stderr);
            return {
              exitCode: 0,
              stdout: formatTable(
                ["REPOSITORY", "TAG", "ID", "SIZE", "CREATED"],
                result.value.map((image) => [
                  image.repository,
                  image.tag,
                  image.id,
                  image.size,
                  image.created,
                ]),
              ),
            };
          }
          case "volumes": {
            if (args.length > 0) return cliError("Usage: bb docker volumes", 2);
            const result = await host.call("volumes", null, { hostId, signal: ctx.signal });
            if (!result.ok) return cliError(result.error.stderr);
            return {
              exitCode: 0,
              stdout: formatTable(
                ["NAME", "DRIVER", "MOUNTPATH"],
                result.value.map((volume) => [
                  volume.name,
                  volume.driver,
                  volume.mountpoint,
                ]),
              ),
            };
          }
          case "networks": {
            if (args.length > 0) return cliError("Usage: bb docker networks", 2);
            const result = await host.call("networks", null, { hostId, signal: ctx.signal });
            if (!result.ok) return cliError(result.error.stderr);
            return {
              exitCode: 0,
              stdout: formatTable(
                ["NAME", "DRIVER", "SCOPE"],
                result.value.map((network) => [
                  network.name,
                  network.driver,
                  network.scope,
                ]),
              ),
            };
          }
          case "info": {
            if (args.length > 0) return cliError("Usage: bb docker info", 2);
            const result = await host.call("info", null, { hostId, signal: ctx.signal });
            if (!result.ok) return cliError(result.error.stderr);
            return {
              exitCode: 0,
              stdout: formatTable(
                ["FIELD", "VALUE"],
                [
                  ["version", result.value.version],
                  ["context", result.value.context],
                  ["os", result.value.os],
                  ["serverVersion", result.value.serverVersion],
                ],
              ),
            };
          }
          case "prune": {
            const kind = args.find((arg) => !arg.startsWith("-"));
            const confirmed = args.includes("--yes") || args.includes("-y");
            const validKinds = ["system", "images", "volumes", "networks"] as const;
            if (!kind || !validKinds.includes(kind as (typeof validKinds)[number])) {
              return cliError(
                "Usage: bb docker prune <system|images|volumes|networks> --yes",
                2,
              );
            }
            if (args.some((arg) => arg !== kind && arg !== "--yes" && arg !== "-y")) {
              return cliError(
                "Usage: bb docker prune <system|images|volumes|networks> --yes",
                2,
              );
            }
            if (!confirmed) {
              return cliError(
                `Pruning ${kind} removes unused Docker resources. Re-run with --yes to confirm.`,
                2,
              );
            }

            const result = await host.call(
              "prune",
              { kind: kind as (typeof validKinds)[number] },
              { hostId, signal: ctx.signal },
            );
            if (!result.ok) return cliError(result.error.stderr);
            if (!result.value.ok) return cliError(result.value.stderr ?? "Docker prune failed.");

            invalidated = true;
            const removed = result.value.removedItems.slice(0, CLI_MAX_REMOVED_ITEMS);
            const remaining = result.value.removedItems.length - removed.length;
            const lines = [
              `Reclaimed: ${result.value.reclaimedBytes} bytes`,
              ...(removed.length > 0
                ? ["Removed:", ...removed.map((item) => `- ${item}`)]
                : ["Removed: none"]),
              ...(remaining > 0 ? [`... and ${remaining} more item${remaining === 1 ? "" : "s"}`] : []),
            ];
            return { exitCode: 0, stdout: capCliOutput(`${lines.join("\n")}\n`) };
          }
          default:
            return cliError(`Unknown docker command: ${command}\n\n${CLI_HELP}`, 2);
        }
      } catch (error) {
        const cancelledAfterError = cliCancelled(ctx);
        if (cancelledAfterError) return cancelledAfterError;
        return cliError(error instanceof Error ? error.message : String(error));
      }
    },
  });

  bb.background.service("poll-docker", {
    async start(signal) {
      bb.log.info(`polling Docker every ${POLL_INTERVAL_MS}ms`);
      while (!signal.aborted) {
        await publishSnapshot(signal);
        await abortAwareSleep(invalidated ? 0 : POLL_INTERVAL_MS, signal);
      }
    },
  });

  bb.onDispose(() => {
    unsubscribeWorkerExit();
    unsubscribeChanged();
    bb.log.info("docker plugin disposed");
  });

  bb.log.info("docker plugin loaded");
}
