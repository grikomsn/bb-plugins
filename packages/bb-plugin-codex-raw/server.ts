import {
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  type BbPluginApi,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  CLI_HELP,
  classifyRawType,
  rpcContract,
  type CodexRawEvent,
  type CodexRawSessionSummary,
  type CodexRawStatus,
} from "./contract.js";
import { ALL_RAW_TYPES, NOISE_TYPES, UNHANDLED_TYPES } from "./lib/codex-raw-types.js";

const BRIDGE_PLUGIN_ID = "codex-events-bridge";
const RAW_PREFIX = "codex/raw/";

const SETTINGS_SCHEMA = {
  maxRawEventsPerThread: {
    type: "select" as const,
    label: "Ring capacity (raw events per thread)",
    options: ["100", "500", "1000", "5000"],
    default: "1000",
  },
  pollIntervalMs: {
    type: "select" as const,
    label: "Poll interval",
    options: ["750", "1500", "3000", "6000"],
    default: "750",
  },
  threadDiscoveryIntervalMs: {
    type: "select" as const,
    label: "Bridge session refresh interval",
    options: ["1500", "3000", "5000", "15000"],
    default: "1500",
  },
  includeHidden: {
    type: "boolean" as const,
    label: "Include hidden codex worker threads",
    default: true,
  },
};

const BridgeEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  type: z.string(),
  category: z.string(),
  threadId: z.string(),
  providerThreadId: z.string().nullable(),
  payload: z.unknown(),
});

const BridgeRecentSchema = z.object({ events: z.array(BridgeEventSchema) });
const BridgeStatusSchema = z.object({
  threadCount: z.number().int().nonnegative(),
});
const BridgeSessionsSchema = z.object({
  sessions: z.array(
    z.object({
      threadId: z.string(),
      providerThreadId: z.string().nullable(),
      title: z.string(),
      status: z.string().nullable(),
    }),
  ),
});

type RawEventRing = {
  events: CodexRawEvent[];
  capacity: number;
  lastSeq: number;
};

type ThreadState = {
  threadId: string;
  providerThreadId: string | null;
  title: string;
  status: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastEventAt: string | null;
  ring: RawEventRing;
  rawEventCountByType: Map<string, number>;
};

function abortAwareSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function safePreview(value: unknown, maxLength = 240): string {
  try {
    const text = JSON.stringify(value ?? null);
    return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
  } catch {
    return "<unserializable>";
  }
}

function normaliseBridgeEvent(event: z.infer<typeof BridgeEventSchema>): CodexRawEvent | null {
  if (event.type !== "provider/unhandled") return null;
  if (event.payload === null || typeof event.payload !== "object") return null;
  const payload = event.payload as Record<string, unknown>;
  const rawType = typeof payload.rawType === "string" ? payload.rawType : "unknown";
  const rawEvent =
    payload.rawEvent !== null && typeof payload.rawEvent === "object"
      ? (payload.rawEvent as Record<string, unknown>)
      : null;
  const method = rawEvent && typeof rawEvent.method === "string" ? rawEvent.method : rawType;
  const params = rawEvent && "params" in rawEvent ? rawEvent.params ?? null : null;
  return {
    seq: event.seq,
    ts: event.ts,
    type: "provider/unhandled",
    rawType,
    classification: classifyRawType(method),
    threadId: event.threadId,
    providerThreadId:
      typeof payload.providerThreadId === "string"
        ? payload.providerThreadId
        : event.providerThreadId,
    params,
    ...(typeof payload.parentToolCallId === "string"
      ? { parentToolCallId: payload.parentToolCallId }
      : {}),
    paramsPreview: safePreview(params),
  };
}

function pushEvent(ring: RawEventRing, event: CodexRawEvent): boolean {
  if (ring.events.some((existing) => existing.seq === event.seq)) return false;
  let index = ring.events.length;
  while (index > 0 && ring.events[index - 1]!.seq > event.seq) index -= 1;
  ring.events.splice(index, 0, event);
  if (ring.events.length > ring.capacity) {
    ring.events.splice(0, ring.events.length - ring.capacity);
  }
  ring.lastSeq = Math.max(ring.lastSeq, event.seq);
  return true;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define(SETTINGS_SCHEMA);
  const initial = await settings.get();
  let maxRawEventsPerThread = Number.parseInt(initial.maxRawEventsPerThread, 10) || 1000;
  let pollIntervalMs = Number.parseInt(initial.pollIntervalMs, 10) || 750;
  let threadDiscoveryIntervalMs =
    Number.parseInt(initial.threadDiscoveryIntervalMs, 10) || 1500;
  let includeHidden = initial.includeHidden !== false;

  const threadStates = new Map<string, ThreadState>();
  let lastEventAt: string | null = null;
  let pollIteration = 0;
  let chokepointReachable = false;
  let chokepointThreadCount: number | null = null;
  let showUnhandledProviderEvents: boolean | null = null;

  settings.onChange((next) => {
    maxRawEventsPerThread =
      Number.parseInt(String(next.maxRawEventsPerThread ?? maxRawEventsPerThread), 10) ||
      maxRawEventsPerThread;
    pollIntervalMs =
      Number.parseInt(String(next.pollIntervalMs ?? pollIntervalMs), 10) || pollIntervalMs;
    threadDiscoveryIntervalMs =
      Number.parseInt(
        String(next.threadDiscoveryIntervalMs ?? threadDiscoveryIntervalMs),
        10,
      ) || threadDiscoveryIntervalMs;
    includeHidden = next.includeHidden !== false;
    for (const state of threadStates.values()) {
      state.ring.capacity = maxRawEventsPerThread;
      if (state.ring.events.length > maxRawEventsPerThread) {
        state.ring.events.splice(0, state.ring.events.length - maxRawEventsPerThread);
      }
    }
  });

  function ensureState(input: {
    threadId: string;
    providerThreadId?: string | null;
    title?: string;
    status?: string | null;
    seenAt?: string;
  }): ThreadState {
    const existing = threadStates.get(input.threadId);
    if (existing) {
      if (input.providerThreadId) existing.providerThreadId = input.providerThreadId;
      if (input.title) existing.title = input.title;
      if (input.status !== undefined) existing.status = input.status;
      return existing;
    }
    const seenAt = input.seenAt ?? new Date().toISOString();
    const state: ThreadState = {
      threadId: input.threadId,
      providerThreadId: input.providerThreadId ?? null,
      title: input.title ?? "",
      status: input.status ?? null,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      lastEventAt: null,
      ring: { events: [], capacity: maxRawEventsPerThread, lastSeq: 0 },
      rawEventCountByType: new Map(),
    };
    threadStates.set(input.threadId, state);
    return state;
  }

  function recordEvent(event: CodexRawEvent): void {
    const state = ensureState({
      threadId: event.threadId,
      providerThreadId: event.providerThreadId,
      seenAt: event.ts,
    });
    if (!pushEvent(state.ring, event)) return;
    state.lastSeenAt = event.ts;
    state.lastEventAt = event.ts;
    state.rawEventCountByType.set(
      event.rawType,
      (state.rawEventCountByType.get(event.rawType) ?? 0) + 1,
    );
    lastEventAt = event.ts;
    bb.realtime.publish("codex-raw/snapshot", {
      threadId: event.threadId,
      event,
    });
  }

  async function pollBridge(): Promise<void> {
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: BRIDGE_PLUGIN_ID,
        method: "recent",
        input: { limit: 500, typePrefix: RAW_PREFIX },
        outputSchema: BridgeRecentSchema,
      });
      chokepointReachable = true;
      const events = result.events
        .map(normaliseBridgeEvent)
        .filter((event): event is CodexRawEvent => event !== null)
        .sort((a, b) => a.seq - b.seq);
      for (const event of events) recordEvent(event);
    } catch (error) {
      chokepointReachable = false;
      bb.log.debug(`codex raw bridge poll failed: ${String(error)}`);
    }
  }

  async function refreshBridgeState(): Promise<void> {
    try {
      const [status, sessions] = await Promise.all([
        bb.sdk.plugins.callRpc({
          pluginId: BRIDGE_PLUGIN_ID,
          method: "status",
          input: null,
          outputSchema: BridgeStatusSchema,
        }),
        bb.sdk.plugins.callRpc({
          pluginId: BRIDGE_PLUGIN_ID,
          method: "sessions",
          input: null,
          outputSchema: BridgeSessionsSchema,
        }),
      ]);
      chokepointReachable = true;
      chokepointThreadCount = status.threadCount;
      for (const session of sessions.sessions) {
        ensureState(session);
      }
    } catch (error) {
      chokepointReachable = false;
      chokepointThreadCount = null;
      bb.log.debug(`codex raw bridge status failed: ${String(error)}`);
    }

    try {
      const config = await bb.sdk.system.config();
      showUnhandledProviderEvents = config.generalSettings.showUnhandledProviderEvents;
    } catch (error) {
      showUnhandledProviderEvents = null;
      bb.log.debug(`codex raw preference probe failed: ${String(error)}`);
    }
  }

  bb.background.service("poll-codex-raw", {
    async start(signal) {
      await refreshBridgeState();
      let lastRefreshAt = Date.now();
      while (!signal.aborted) {
        pollIteration += 1;
        const startedAt = Date.now();
        await pollBridge();
        if (Date.now() - lastRefreshAt >= threadDiscoveryIntervalMs) {
          await refreshBridgeState();
          lastRefreshAt = Date.now();
        }
        await abortAwareSleep(Math.max(0, pollIntervalMs - (Date.now() - startedAt)), signal);
      }
    },
  });

  function allFilteredEvents(filter: {
    threadId?: string;
    classification?: "unhandled" | "noise" | "other";
    rawType?: string;
    sinceSeq?: number;
  }): CodexRawEvent[] {
    const events: CodexRawEvent[] = [];
    for (const state of threadStates.values()) {
      if (filter.threadId && state.threadId !== filter.threadId) continue;
      for (const event of state.ring.events) {
        if (filter.classification && event.classification !== filter.classification) continue;
        if (filter.rawType && event.rawType !== filter.rawType) continue;
        if (filter.sinceSeq !== undefined && event.seq <= filter.sinceSeq) continue;
        events.push(event);
      }
    }
    return events;
  }

  function tailEvents(threadId: string, sinceSeq: number | undefined, limit: number) {
    const events = allFilteredEvents({ threadId, sinceSeq })
      .sort((a, b) => a.seq - b.seq)
      .slice(-limit);
    return {
      events,
      nextSeq: events.length > 0 ? events[events.length - 1]!.seq : sinceSeq ?? 0,
    };
  }

  function summarise(state: ThreadState): CodexRawSessionSummary {
    return {
      threadId: state.threadId,
      providerThreadId: state.providerThreadId,
      title: state.title,
      status: state.status,
      firstSeenAt: state.firstSeenAt,
      lastSeenAt: state.lastSeenAt,
      lastEventAt: state.lastEventAt,
      rawEventCount: state.ring.events.length,
      rawEventCountByType: Object.fromEntries(state.rawEventCountByType),
    };
  }

  bb.rpc.register(rpcContract, {
    status: (): CodexRawStatus => ({
      connected: chokepointReachable,
      pollIntervalMs,
      threadDiscoveryIntervalMs,
      maxRawEventsPerThread,
      includeHidden,
      threadCount: threadStates.size,
      sessionIds: [...threadStates.keys()],
      lastEventAt,
      bufferedSeqs: [...threadStates.values()].reduce(
        (total, state) => total + state.ring.events.length,
        0,
      ),
      pollIteration,
      chokepoint: {
        reachable: chokepointReachable,
        pluginId: BRIDGE_PLUGIN_ID,
        threadCount: chokepointThreadCount,
      },
      showUnhandledProviderEventsRequired: true,
      showUnhandledProviderEvents,
    }),
    rawEvents: (input) => {
      const filtered = allFilteredEvents(input).sort((a, b) => b.seq - a.seq);
      const oldestSeq = filtered.length > 0 ? Math.min(...filtered.map((e) => e.seq)) : 0;
      const newestSeq = filtered.length > 0 ? Math.max(...filtered.map((e) => e.seq)) : 0;
      return { events: filtered.slice(0, input.limit), oldestSeq, newestSeq };
    },
    sessions: () => ({
      sessions: [...threadStates.values()]
        .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
        .map(summarise),
    }),
    types: () => ({
      unhandled: [...UNHANDLED_TYPES],
      noise: [...NOISE_TYPES],
      all: [...ALL_RAW_TYPES],
    }),
    tail: ({ threadId, sinceSeq, limit }) => tailEvents(threadId, sinceSeq, limit),
  });

  function cliError(message: string, exitCode = 1): PluginCliResult {
    return { exitCode, stderr: `${message.trim()}\n` };
  }

  function parseIntegerFlag(args: string[], name: string, fallback: number): number {
    const inline = args.find((arg) => arg.startsWith(`${name}=`));
    const index = args.indexOf(name);
    const raw = inline?.slice(name.length + 1) ?? (index >= 0 ? args[index + 1] : undefined);
    const parsed = Number.parseInt(raw ?? "", 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function boundedJsonLines(events: CodexRawEvent[]): string {
    const maxBytes = PLUGIN_CLI_OUTPUT_MAX_BYTES - 1024;
    const lines: string[] = [];
    let bytes = 0;
    for (const event of events) {
      const line = `${JSON.stringify(event)}\n`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (bytes + lineBytes > maxBytes) break;
      lines.push(line);
      bytes += lineBytes;
    }
    return lines.join("");
  }

  bb.cli.register({
    name: "codex-raw",
    summary: "Inspect raw codex-app-server notifications",
    commands: [
      { name: "status", summary: "Show raw bridge status", usage: "bb codex-raw status" },
      { name: "types", summary: "List the 42 raw notification types", usage: "bb codex-raw types" },
      { name: "sessions", summary: "List tracked codex threads", usage: "bb codex-raw sessions" },
      {
        name: "tail",
        summary: "Write recent raw events for one thread as JSONL",
        usage: "bb codex-raw tail <threadId> [--since-seq <n>] [--limit <n>]",
      },
    ],
    async run(argv, ctx) {
      if (ctx.signal?.aborted) return cliError("Cancelled", 130);
      const [command, ...args] = argv;
      if (!command || command === "help" || command === "--help" || command === "-h") {
        return { exitCode: 0, stdout: CLI_HELP };
      }
      if (command === "status") {
        return {
          exitCode: 0,
          stdout:
            JSON.stringify({
              bridge: BRIDGE_PLUGIN_ID,
              reachable: chokepointReachable,
              threadCount: threadStates.size,
              bufferedEvents: [...threadStates.values()].reduce(
                (total, state) => total + state.ring.events.length,
                0,
              ),
              showUnhandledProviderEvents,
            }) + "\n",
        };
      }
      if (command === "types") {
        return {
          exitCode: 0,
          stdout: [
            ...UNHANDLED_TYPES.map((type) => `unhandled\t${type}`),
            ...NOISE_TYPES.map((type) => `noise\t${type}`),
          ].join("\n") + "\n",
        };
      }
      if (command === "sessions") {
        const lines = [...threadStates.values()].map(
          (state) =>
            `${state.threadId}\t${state.ring.events.length}\t${state.lastEventAt ?? "-"}\t${state.title}`,
        );
        return { exitCode: 0, stdout: lines.length > 0 ? `${lines.join("\n")}\n` : "(no threads)\n" };
      }
      if (command === "tail") {
        const threadId = args[0];
        if (!threadId || threadId.startsWith("-")) {
          return cliError("Usage: bb codex-raw tail <threadId> [--since-seq <n>] [--limit <n>]", 2);
        }
        const sinceSeq = Math.max(0, parseIntegerFlag(args.slice(1), "--since-seq", 0));
        const limit = Math.min(500, Math.max(1, parseIntegerFlag(args.slice(1), "--limit", 100)));
        const result = tailEvents(threadId, sinceSeq, limit);
        return {
          exitCode: 0,
          stdout: result.events.length > 0 ? boundedJsonLines(result.events) : "(no events)\n",
        };
      }
      return cliError(`Unknown codex-raw command: ${command}\n\n${CLI_HELP}`, 2);
    },
  });

  bb.log.info(`codex-raw loaded; polling ${BRIDGE_PLUGIN_ID} at ${RAW_PREFIX}`);
}
