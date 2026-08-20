// bb-plugin-mcp-mediator — backend entry.
//
// Surfaces pi-mcp-adapter's events in bb: a server-status table and a
// mediator for tool-approval requests.
//
// * Subscribes (via bb.sdk.plugins.callRpc) to the chokepoint's `recent` RPC
//   filtered on `pi.ext:pi-mcp-adapter/*`, just like the fleet plugin.
// * Renders MCP server count + per-server tool/resource counts on a nav
//   panel (frontend in app.tsx).
// * Mediates `pi-mcp-adapter:tool-approval-request` events: writes a
//   `bb.bridge:command` envelope back to the chokepoint with the user's
//   decision (allow / deny / once / always).
//
// The reverse path uses the same chokepoint RPC pattern as
// bb-plugin-pi-subagents-fleet.

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ─── State ──────────────────────────────────────────────────────────────

type ServerEntry = {
  name: string;
  url: string;
  status: "connected" | "connecting" | "disconnected" | "error";
  toolCount: number;
  resourceCount: number;
  lastSeenAt: string;
  error?: string;
};

type PendingApproval = {
  approvalId: string;
  serverName: string;
  toolName: string;
  argsPreview: string;
  cwd: string;
  sessionId: string | null;
  receivedAt: string;
  decidedAt: string | null;
  decision: "allow" | "deny" | "always" | null;
};

// ─── RPC contract (own) ─────────────────────────────────────────────────

export const rpcContract = defineRpcContract({
  servers: {
    input: z.null(),
    output: z.object({
      source: z.string(),
      lastSnapshotAt: z.string().nullable(),
      servers: z.array(
        z.object({
          name: z.string(),
          url: z.string(),
          status: z.string(),
          toolCount: z.number().int().nonnegative(),
          resourceCount: z.number().int().nonnegative(),
          lastSeenAt: z.string(),
          error: z.string().nullable(),
        }),
      ),
    }),
  },
  pendingApprovals: {
    input: z.null(),
    output: z.object({
      pending: z.array(
        z.object({
          approvalId: z.string(),
          serverName: z.string(),
          toolName: z.string(),
          argsPreview: z.string(),
          receivedAt: z.string(),
          decidedAt: z.string().nullable(),
          decision: z.string().nullable(),
        }),
      ),
    }),
  },
  decide: {
    input: z
      .object({
        approvalId: z.string(),
        decision: z.union([
          z.literal("allow"),
          z.literal("deny"),
          z.literal("always"),
        ]),
      })
      .strict(),
    output: z.object({ ok: z.boolean(), reason: z.string().nullable() }),
  },
});

// ─── Wire types for the chokepoint ──────────────────────────────────────

const BridgeEventSchema = z.object({
  seq: z.number().int(),
  ts: z.string(),
  type: z.string(),
  sessionId: z.string().nullable(),
  cwd: z.string(),
  payload: z.unknown(),
});
const BridgeRecentResultSchema = z.object({ events: z.array(BridgeEventSchema) });

// ─── Backend factory ────────────────────────────────────────────────────

const CHOKEPOINT_PLUGIN_ID = "pi-events-bridge";
const POLL_INTERVAL_MS = 1000;

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("pi-mcp-mediator loading");

  const settings = bb.settings.define({
    /** If true, automatically approve well-known safe tools (e.g. read-only). */
    autoApproveSafe: {
      type: "boolean",
      label: "Auto-approve read-only MCP tools",
      default: false,
    },
  });
  const { autoApproveSafe } = await settings.get();

  const servers = new Map<string, ServerEntry>();
  const pending = new Map<string, PendingApproval>();
  let lastSnapshotAt: string | null = null;
  // Per-session seq watermarks (each pi process numbers events from 1).
  const lastPolledSeqBySession = new Map<string, number>();

  // ─── Poll the chokepoint for MCP events ──────────────────────────────
  async function fetchNewEvents(): Promise<z.infer<typeof BridgeEventSchema>[]> {
    if (!bb.sdk) return [];
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: CHOKEPOINT_PLUGIN_ID,
        method: "recent",
        input: { limit: 200, typePrefix: "pi.ext:pi-mcp-adapter/" },
        outputSchema: BridgeRecentResultSchema,
      });
      const out: z.infer<typeof BridgeEventSchema>[] = [];
      for (const e of result.events) {
        const key = e.sessionId ?? "_";
        const last = lastPolledSeqBySession.get(key);
        if (last === undefined || e.seq > last) out.push(e);
      }
      out.reverse();
      for (const e of out) {
        const key = e.sessionId ?? "_";
        lastPolledSeqBySession.set(key, Math.max(lastPolledSeqBySession.get(key) ?? -1, e.seq));
      }
      bb.log.debug(
        `recent returned ${result.events.length} events, ${out.length} new`,
      );
      return out;
    } catch (err) {
      bb.log.warn(`chokepoint poll failed: ${String(err)}`);
      return [];
    }
  }

  // one-shot probe used during first poll
  async function probeChokepoint(): Promise<void> {
    if (!bb.sdk) {
      bb.log.warn("bb.sdk not bound");
      return;
    }
    try {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: CHOKEPOINT_PLUGIN_ID,
        method: "recent",
        input: { limit: 5 },
        outputSchema: BridgeRecentResultSchema,
      });
      bb.log.info(`probe: chokepoint returned ${result.events.length} recent events`);
      for (const e of result.events) {
        bb.log.info(`  - ${e.type}`);
      }
    } catch (err) {
      bb.log.warn(`probe failed: ${String(err)}`);
    }
  }

  function applyEvent(event: z.infer<typeof BridgeEventSchema>): void {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    const type = event.type;
    if (type === "pi.ext:pi-mcp-adapter/status/v1") {
      lastSnapshotAt = event.ts;
      const list = Array.isArray(p.servers) ? p.servers : [];
      for (const raw of list) {
        const r = raw as Record<string, unknown>;
        const name = typeof r.name === "string" ? r.name : "?";
        servers.set(name, {
          name,
          url: typeof r.url === "string" ? r.url : "",
          status:
            r.status === "connected" ||
            r.status === "connecting" ||
            r.status === "disconnected" ||
            r.status === "error"
              ? r.status
              : "disconnected",
          toolCount: typeof r.toolCount === "number" ? r.toolCount : 0,
          resourceCount: typeof r.resourceCount === "number" ? r.resourceCount : 0,
          lastSeenAt: event.ts,
          error: typeof r.error === "string" ? r.error : undefined,
        });
      }
      bb.realtime.publish("pi/mcp-mediator/status", {
        servers: Array.from(servers.values()),
        lastSnapshotAt,
      });
      return;
    }
    if (type === "pi.ext:pi-mcp-adapter/tool-approval-request") {
      const approvalId =
        typeof p.approvalId === "string"
          ? p.approvalId
          : `${Date.now()}:${Math.random().toString(36).slice(2)}`;
      const serverName = typeof p.serverName === "string" ? p.serverName : "?";
      const toolName = typeof p.toolName === "string" ? p.toolName : "?";
      const argsPreview = typeof p.argsPreview === "string" ? p.argsPreview : "";
      const request: PendingApproval = {
        approvalId,
        serverName,
        toolName,
        argsPreview,
        cwd: event.cwd,
        sessionId: event.sessionId,
        receivedAt: event.ts,
        decidedAt: null,
        decision: null,
      };
      pending.set(approvalId, request);

      // Auto-approve read-only tools if the user enabled that.
      if (autoApproveSafe && toolName.startsWith("read_")) {
        void decide(approvalId, "allow");
      }

      bb.realtime.publish("pi/mcp-mediator/approval-request", request);
    }
  }

  async function decide(
    approvalId: string,
    decision: "allow" | "deny" | "always",
  ): Promise<{ ok: boolean; reason: string | null }> {
    const req = pending.get(approvalId);
    if (!req) return { ok: false, reason: "unknown approvalId" };
    if (req.decidedAt) return { ok: false, reason: "already decided" };
    req.decidedAt = new Date().toISOString();
    req.decision = decision;
    // Push the decision back to the chokepoint via its enqueueCommand RPC.
    if (!bb.sdk) return { ok: false, reason: "sdk not bound" };
    try {
      await bb.sdk.plugins.callRpc({
        pluginId: CHOKEPOINT_PLUGIN_ID,
        method: "enqueueCommand",
        input: {
          command: "mcp-approval-decision",
          id: approvalId,
          cwd: req.cwd,
          decision,
          serverName: req.serverName,
          toolName: req.toolName,
        },
        outputSchema: z.object({ ok: z.boolean() }),
      });
    } catch (err) {
      bb.log.warn(`enqueueCommand failed: ${String(err)}`);
      return { ok: false, reason: `chokepoint RPC failed: ${String(err)}` };
    }
    bb.realtime.publish("pi/mcp-mediator/approval-decided", {
      approvalId,
      decision,
      decidedAt: req.decidedAt,
    });
    // Drop after a short delay so the UI has time to render the badge.
    setTimeout(() => pending.delete(approvalId), 30_000).unref?.();
    return { ok: true, reason: null };
  }

  // ─── RPC ─────────────────────────────────────────────────────────────
  bb.rpc.register(rpcContract, {
    servers: () => ({
      source: CHOKEPOINT_PLUGIN_ID,
      lastSnapshotAt,
      servers: Array.from(servers.values()).map((s) => ({
        name: s.name,
        url: s.url,
        status: s.status,
        toolCount: s.toolCount,
        resourceCount: s.resourceCount,
        lastSeenAt: s.lastSeenAt,
        error: s.error ?? null,
      })),
    }),

    pendingApprovals: () => ({
      pending: Array.from(pending.values()).map((p) => ({
        approvalId: p.approvalId,
        serverName: p.serverName,
        toolName: p.toolName,
        argsPreview: p.argsPreview,
        receivedAt: p.receivedAt,
        decidedAt: p.decidedAt,
        decision: p.decision,
      })),
    }),

    decide: ({ approvalId, decision }) => decide(approvalId, decision),
  });

  // ─── Poll loop ───────────────────────────────────────────────────────
  bb.background.service("poll-chokepoint", {
    async start(signal) {
      bb.log.info(`polling ${CHOKEPOINT_PLUGIN_ID} every ${POLL_INTERVAL_MS}ms`);
      void probeChokepoint();
      let pollTickCount = 0;
      while (!signal.aborted) {
        const events = await fetchNewEvents();
        bb.log.debug(`poll #${pollTickCount}: fetchNewEvents returned ${events.length}`);
        pollTickCount += 1;
        if (events.length > 0) {
          bb.log.info(`poll #${pollTickCount}: ${events.length} new event(s)`);
        }
        for (const e of events) {
          try {
            applyEvent(e);
          } catch (err) {
            bb.log.warn(`applyEvent failed for ${e.type}: ${String(err)}`);
          }
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, POLL_INTERVAL_MS);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });

  bb.onDispose(() => bb.log.info("pi-mcp-mediator disposed"));

  bb.log.info("pi-mcp-mediator loaded");
}
