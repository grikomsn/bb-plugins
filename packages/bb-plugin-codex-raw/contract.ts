// bb-plugin-codex-raw — shared RPC + CLI contracts.
//
// Single shared surface for the plugin's frontend (typed via
// `useRpc<typeof rpcContract>` and `useRealtime`) and any cross-plugin
// consumer that wants the chokepoint shape.
//
// `rawEvents` / `types` / `tail` are the public RPC; `status` is for
// the settings page; the `chokepoint` block is informational and reports
// whether bb-plugin-codex-events-bridge is loaded + reachable so the
// settings UI can recommend the easier polling path.

import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  UNHANDLED_TYPES,
  NOISE_TYPES,
  ALL_RAW_TYPES,
} from "./lib/codex-raw-types.js";

// ─── Wire types ─────────────────────────────────────────────────────────

const RawEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  /** "provider/unhandled" (the SDK-form type we polled). */
  type: z.literal("provider/unhandled"),
  /** The original codex-app-server JSON-RPC method (e.g. "fs/changed"). */
  rawType: z.string(),
  classification: z.enum(["unhandled", "noise", "other"]),
  threadId: z.string(),
  providerThreadId: z.string().nullable(),
  /** The original JSON-RPC params payload from the host's rawEvent envelope. */
  params: z.unknown(),
  /** parentToolCallId forwarded by the host for any tool-scoped context. */
  parentToolCallId: z.string().optional(),
  /** host-provided splash of the params object so the table can render a
   *  payload preview without rendering the full JSON. */
  paramsPreview: z.string(),
});

const SessionSummarySchema = z.object({
  threadId: z.string(),
  providerThreadId: z.string().nullable(),
  title: z.string(),
  status: z.string().nullable(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  lastEventAt: z.string().nullable(),
  rawEventCount: z.number().int().nonnegative(),
  rawEventCountByType: z.record(z.string(), z.number().int().nonnegative()),
});

const StatusSchema = z.object({
  connected: z.boolean(),
  pollIntervalMs: z.number().int().positive(),
  threadDiscoveryIntervalMs: z.number().int().positive(),
  maxRawEventsPerThread: z.number().int().positive(),
  includeHidden: z.boolean(),
  threadCount: z.number().int().nonnegative(),
  sessionIds: z.array(z.string()),
  lastEventAt: z.string().nullable(),
  bufferedSeqs: z.number().int().nonnegative(),
  pollIteration: z.number().int().nonnegative(),
  chokepoint: z.object({
    reachable: z.boolean(),
    pluginId: z.string(),
    threadCount: z.number().int().nonnegative().nullable(),
  }),
  showUnhandledProviderEventsRequired: z.boolean(),
  showUnhandledProviderEvents: z.boolean().nullable(),
});

const TypesSchema = z.object({
  unhandled: z.array(z.enum(UNHANDLED_TYPES)),
  noise: z.array(z.enum(NOISE_TYPES)),
  all: z.array(z.enum(ALL_RAW_TYPES)),
});

const TailInputSchema = z
  .object({
    threadId: z.string().min(1),
    sinceSeq: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(500).optional().default(100),
  })
  .strict();

const TailOutputSchema = z.object({
  events: z.array(RawEventSchema),
  nextSeq: z.number().int().nonnegative(),
});

// ─── RPC contract ───────────────────────────────────────────────────────

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: StatusSchema,
  },
  rawEvents: {
    input: z
      .object({
        threadId: z.string().min(1).optional(),
        /** Restrict to one classification bucket. If unset returns everything. */
        classification: z.enum(["unhandled", "noise", "other"]).optional(),
        /** Restrict to a single rawType (full SDK-form, e.g. "fs/changed"). */
        rawType: z.string().optional(),
        limit: z.number().int().min(1).max(500).optional().default(100),
        sinceSeq: z.number().int().nonnegative().optional(),
      })
      .strict(),
    output: z.object({
      events: z.array(RawEventSchema),
      oldestSeq: z.number().int().nonnegative(),
      newestSeq: z.number().int().nonnegative(),
    }),
  },
  sessions: {
    input: z.null(),
    output: z.object({
      sessions: z.array(SessionSummarySchema),
    }),
  },
  types: {
    input: z.null(),
    output: TypesSchema,
  },
  tail: {
    input: TailInputSchema,
    output: TailOutputSchema,
  },
});

// Re-export so consumers don't need to import from lib/.
export {
  UNHANDLED_TYPES,
  NOISE_TYPES,
  ALL_RAW_TYPES,
  isUnhandledType,
  isNoiseType,
  isKnownRawType,
  classifyRawType,
} from "./lib/codex-raw-types.js";

// ─── CLI help text (server.ts reads from here so the agent-facing surface
//     stays in sync with the help banner emitted to stdout). ───────────

export const CLI_HELP = `Usage: bb codex-raw <command>

Commands:
  status                    Show bridge status (poll interval, ring capacity,
                            chokepoint reachability, tracked threads).
  types                     List the 42 known unhandled / noise raw types.
  sessions                  One row per tracked codex thread.
  tail <threadId>           Stream raw events for one thread to stdout.
                            Accepts --since-seq <n> and --limit <n>.

Run \`bb codex-raw tail --help\` for tail-specific flags.
`;

export type CodexRawEvent = z.infer<typeof RawEventSchema>;
export type CodexRawSessionSummary = z.infer<typeof SessionSummarySchema>;
export type CodexRawStatus = z.infer<typeof StatusSchema>;
