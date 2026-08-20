// bb-plugin-pi-events-bridge — backend entry.
//
// Listens on a Unix socket for newline-delimited JSON events from the
// pi-bb-bridge pi extension, re-emits each event on bb.realtime so other bb
// plugins and the bb frontend can subscribe per source, and tracks session
// state in bb.storage.kv for replay on reconnect.
//
// The companion pi extension lives at ~/Workspace/grikomsn/pi-bb-bridge/.

import net from "node:net";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ─── Wire types ─────────────────────────────────────────────────────────

const EventSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  type: z.string(),
  cwd: z.string().optional().default(""),
  sessionId: z.string().optional(),
  payload: z.unknown(),
});
type BridgeEvent = z.infer<typeof EventSchema>;

// ─── RPC contract ───────────────────────────────────────────────────────

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      connected: z.boolean(),
      socketPath: z.string(),
      sessionCount: z.number().int().nonnegative(),
      lastEventAt: z.string().nullable(),
      bufferedSeqs: z.number().int().nonnegative(),
      authToken: z.string().nullable(),
    }),
  },
  recent: {
    input: z
      .object({
        limit: z.number().int().min(1).max(500).optional().default(50),
        sessionId: z.string().optional(),
        typePrefix: z.string().optional(),
      })
      .strict(),
    output: z.object({
      events: z.array(
        z.object({
          seq: z.number().int(),
          ts: z.string(),
          type: z.string(),
          sessionId: z.string().nullable(),
          cwd: z.string(),
          payload: z.unknown(),
        }),
      ),
    }),
  },
  sessions: {
    input: z.null(),
    output: z.object({
      sessions: z.array(
        z.object({
          sessionId: z.string(),
          cwd: z.string(),
          firstSeenAt: z.string(),
          lastSeenAt: z.string(),
          lastEventType: z.string(),
          eventCount: z.number().int().nonnegative(),
        }),
      ),
    }),
  },
  enqueueCommand: {
    input: z
      .object({
        command: z.string().min(1),
        id: z.string().min(1),
        message: z.string().optional(),
        cwd: z.string().optional(),
      })
      .strict(),
    output: z.object({ ok: z.boolean() }),
  },
  threadSession: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({
      threadId: z.string(),
      providerSessionId: z.string().nullable(),
    }),
  },
});

// ─── Per-session state ──────────────────────────────────────────────────

type SessionState = {
  sessionId: string;
  cwd: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastEventType: string;
  eventCount: number;
};

type EventRing = {
  events: BridgeEvent[];
  capacity: number;
};

function emptyRing(capacity: number): EventRing {
  return { events: [], capacity };
}

function ringPush(ring: EventRing, event: BridgeEvent): void {
  ring.events.push(event);
  if (ring.events.length > ring.capacity) {
    ring.events.splice(0, ring.events.length - ring.capacity);
  }
}

// ─── Backend factory ────────────────────────────────────────────────────

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("pi-events-bridge loading");

  // ─── Settings ─────────────────────────────────────────────────────────
  // The settings API only supports string | boolean values; we encode the
  // ring capacity as a string and parse it.
  const settings = bb.settings.define({
    /** Maximum events kept in the per-session replay ring. Encoded as a string
     * because the bb settings API is limited to string | boolean values. */
    ringCapacity: {
      type: "select",
      label: "Ring buffer capacity (events per session)",
      options: ["100", "500", "1000", "5000"],
      default: "500",
    },
    /** Optional shared secret; if set, the pi side must send `BB_BRIDGE_TOKEN=<value>`.
     * Empty (the default) means an auto-generated token is used. */
    authToken: {
      type: "string",
      label: "Auth token (empty = auto-generated, check rpc.status.authToken)",
      secret: true,
    },
    /** Override the socket path; empty means a per-install path under tmpdir. */
    socketPath: {
      type: "string",
      label: "Unix socket path (empty = auto)",
    },
  });
  const { ringCapacity, authToken, socketPath: socketPathOverride } = await settings.get();
  const ringCapacityNum = Number.parseInt(ringCapacity, 10) || 500;
  const authTokenValue = authToken ?? "";
  const socketPathOverrideValue = socketPathOverride ?? "";

  // ─── Choose socket path ───────────────────────────────────────────────
  // Prefer the override; otherwise a stable per-install path so the same pi
  // session can reconnect across bb reloads.
  const socketPath =
    socketPathOverrideValue.length > 0
      ? socketPathOverrideValue
      : join(tmpdir(), `bb-plugin-pi-events-bridge-${bb.pluginId}.sock`);

  // Ensure the parent dir exists; we DON'T pre-unlink because reload reuses
  // the socket file path and the old listener closes its FD on dispose.
  try {
    mkdirSync(join(socketPath, ".."), { recursive: true });
  } catch {
    // tmpdir exists already
  }

  // ─── In-memory state ──────────────────────────────────────────────────
  type SessionKey = string; // `${sessionId ?? "_"}::${cwd}`
  const sessions = new Map<SessionKey, SessionState>();
  const rings = new Map<SessionKey, EventRing>();
  const connectedSocks = new Set<net.Socket>();
  let lastEventAt: string | null = null;
  let bufferedSeqs = 0;

  function keyOf(event: BridgeEvent): SessionKey {
    return `${event.sessionId ?? "_"}::${event.cwd}`;
  }

  function trackSession(event: BridgeEvent): SessionState {
    const key = keyOf(event);
    let s = sessions.get(key);
    if (!s) {
      s = {
        sessionId: event.sessionId ?? "(unknown)",
        cwd: event.cwd,
        firstSeenAt: event.ts,
        lastSeenAt: event.ts,
        lastEventType: event.type,
        eventCount: 0,
      };
      sessions.set(key, s);
      const ring = rings.get(key) ?? emptyRing(ringCapacityNum);
      rings.set(key, ring);
    }
    s.lastSeenAt = event.ts;
    s.lastEventType = event.type;
    s.eventCount += 1;
    return s;
  }

  // ─── Socket server ────────────────────────────────────────────────────
  // Single shared secret per install; rotate by editing the setting. We
  // generate a per-process token if the user left authToken blank so the
  // default install is still authenticated.
  const effectiveToken =
    authTokenValue.length > 0 ? authTokenValue : randomBytes(16).toString("hex");
  const requiresAuth = authTokenValue.length > 0;
  bb.log.info(
    `listening on ${socketPath}${requiresAuth ? "" : " (auto-generated token; check rpc.status.authToken)"}`,
  );

  // Publish the connection info to a well-known file so the pi bridge worker
  // (bb-pi-bridge.mjs, patched by scripts/patch-pi-bridge.mjs) can set
  // BB_BRIDGE_SOCKET_PATH / BB_BRIDGE_TOKEN in the pi process environment.
  // The path is deterministic so both sides agree without any RPC.
  const bridgeInfoPath = join(tmpdir(), "bb-plugin-pi-events-bridge.json");
  function writeBridgeInfo(): void {
    try {
      writeFileSync(
        bridgeInfoPath,
        JSON.stringify({
          socketPath,
          token: effectiveToken,
          requiresAuth,
          pid: process.pid,
          updatedAt: new Date().toISOString(),
        }),
        "utf8",
      );
    } catch (err) {
      bb.log.warn(`failed to write bridge info: ${String(err)}`);
    }
  }

  const server = net.createServer((sock) => {
    let authenticated = !requiresAuth; // empty token = no auth required
    let buffer = "";
    let linesReceived = 0;
    connectedSocks.add(sock);

    sock.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) {
          linesReceived += 1;
          if (linesReceived === 1 || linesReceived % 50 === 0) {
            bb.log.info(`socket line #${linesReceived} (authed=${authenticated})`);
          }
          handleLine(
            sock,
            line,
            () => (authenticated = true),
            (ok) => {
              authenticated = ok;
            },
            () => authenticated,
          );
        }
        nl = buffer.indexOf("\n");
      }
    });

    sock.on("error", (err) => {
      bb.log.warn(`socket connection error: ${err.message}`);
    });

    sock.on("close", () => {
      connectedSocks.delete(sock);
      bb.log.info(`socket connection closed after ${linesReceived} line(s)`);
    });
  });

  function handleLine(
    sock: net.Socket,
    line: string,
    markAuthed: () => void,
    setAuth: (ok: boolean) => void,
    isAuthed: () => boolean,
  ): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      bb.log.warn(`dropping malformed line: ${String(err)}`);
      return;
    }

    const result = EventSchema.safeParse(parsed);
    if (!result.success) {
      // First message after connect is the auth handshake; bypass schema
      // validation since it doesn't carry the event shape.
      const obj = parsed as { type?: unknown; payload?: { token?: unknown } };
      if (
        !isAuthed() &&
        obj?.type === "bb.bridge:hello" &&
        typeof obj.payload?.token === "string" &&
        obj.payload.token === effectiveToken
      ) {
        setAuth(true);
        markAuthed();
        return;
      }
      if (!isAuthed()) {
        bb.log.warn("rejecting connection: bad or missing auth token");
        sock.end();
        return;
      }
      bb.log.warn(`dropping invalid event: ${result.error.message}`);
      return;
    }
    const event = result.data;

    // Track & ring-buffer
    trackSession(event);
    const ring = rings.get(keyOf(event))!;
    ringPush(ring, event);
    lastEventAt = event.ts;
    bufferedSeqs += 1;

    // Re-emit on bb.realtime so the frontend and other plugins can subscribe.
    // Channel naming: `pi/<source>/<event>` where source is `lifecycle`,
    // `ext` (3rd-party), or `bridge` (control messages like hello).
    const channel = eventToChannel(event.type);
    bb.realtime.publish(channel, {
      seq: event.seq,
      ts: event.ts,
      type: event.type,
      sessionId: event.sessionId ?? null,
      cwd: event.cwd,
      payload: event.payload,
    });
  }

  function eventToChannel(type: string): string {
    if (type.startsWith("pi.lifecycle:")) {
      const tail = type.slice("pi.lifecycle:".length);
      return `pi/lifecycle/${tail}`;
    }
    if (type.startsWith("pi.ext:")) {
      const tail = type.slice("pi.ext:".length);
      // Convert colons to slashes for a hierarchical channel name.
      // e.g. "subagents:created" → "pi/ext/subagents/created"
      return `pi/ext/${tail.replace(/:/g, "/")}`;
    }
    if (type.startsWith("bb.bridge:")) {
      return `pi/bridge/${type.slice("bb.bridge:".length)}`;
    }
    return `pi/raw/${type}`;
  }

  // Register cleanup BEFORE listen so a reload can't race the new bind.
  // We intentionally do NOT unlink the socket file on dispose: the old
  // listener's close() is async (it waits for lingering connections), so a
  // late unlink could delete the NEW factory's socket file after it binds.
  // The kernel releases the inode when the last FD closes; stale files are
  // cleaned up by the EADDRINUSE retry path below.
  bb.onDispose(() => {
    bb.log.info("pi-events-bridge disposing");
    server.close();
  });

  // Bind last so the previous server has fully torn down; a reload that
  // races listen() will hit EADDRINUSE. The stale socket FILE (not the
  // listener) is what keeps the path bound — the old listener's FD is
  // released on dispose, but the inode lingers while any connection is
  // still open, so `listen()` on the same path fails. Unlink the file
  // before retrying; the old listener keeps its (now-unlinked) inode and
  // new connections go to the fresh one.
  const tryListen = (attempt: number): void => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && attempt < 5) {
        bb.log.warn(`socket busy on reload, retry ${attempt + 1}/5`);
        try {
          unlinkSync(socketPath);
        } catch {
          // nothing to unlink
        }
        setTimeout(() => tryListen(attempt + 1), 150);
      } else {
        bb.log.error(`socket server error: ${String(err)}`);
      }
    });
    server.listen(socketPath, () => {
      // Node fires the success callback once per listen() call, so a
      // retried bind logs twice; dedupe with a flag.
      if (!bound) {
        bound = true;
        bb.log.info(`socket server listening at ${socketPath}`);
        writeBridgeInfo();
      }
    });
  };
  let bound = false;
  tryListen(1);

  server.on("error", (err: NodeJS.ErrnoException) => {
    // EADDRINUSE is handled by the retry path above; only surface others.
    if (err.code !== "EADDRINUSE") {
      bb.log.error(`socket server error (late): ${String(err)}`);
    }
  });

  // HTTP route: /api/v1/plugins/pi-events-bridge/http/threads -> the
  // current bbThreadId -> providerThreadId map (debug only).
  bb.http.route("GET", "/threads", () => {
    const entries: Array<{ threadId: string; providerThreadId: string }> = [];
    for (const [threadId, providerThreadId] of threadToProvider.entries()) {
      entries.push({ threadId, providerThreadId });
    }
    return Response.json({ ok: true, count: entries.length, entries });
  });

  // HTTP route: /events -> recent ring-buffer events (debug only).
  bb.http.route("GET", "/events", () => {
    const out: Array<{ seq: number; ts: string; type: string; sessionId: string | null; cwd: string }> = [];
    for (const [, ring] of rings) {
      for (const ev of ring.events) {
        out.push({
          seq: ev.seq,
          ts: ev.ts,
          type: ev.type,
          sessionId: ev.sessionId ?? null,
          cwd: ev.cwd,
        });
      }
    }
    out.sort((a, b) => a.seq - b.seq);
    return Response.json({ ok: true, count: out.length, events: out.slice(-500) });
  });

  // HTTP route: /status -> live chokepoint state (debug only).
  bb.http.route("GET", "/status", () => {
    return Response.json({
      ok: true,
      socketPath,
      requiresAuth,
      listening: server.listening,
      sessions: Array.from(sessions.values()).map((s) => ({
        sessionId: s.sessionId,
        cwd: s.cwd,
        firstSeenAt: s.firstSeenAt,
        lastSeenAt: s.lastSeenAt,
        lastEventType: s.lastEventType,
        eventCount: s.eventCount,
      })),
      connectedSockets: connectedSocks.size,
      threadMappings: Array.from(threadToProvider.entries()).map(
        ([threadId, providerThreadId]) => ({ threadId, providerThreadId }),
      ),
    });
  });

  // Thread-mapping: bb.events.on("thread.*") fires with the full
  // ThreadResponse (which has providerThreadId). We record bbThreadId ->
  // providerThreadId so the downstream plugins (codex-goal, subagents-fleet)
  // can resolve a bb threadId to its pi sessionId (which equals the
  // providerThreadId on the bridge).
  const threadToProvider = new Map<string, string>();

  function recordThreadMapping(thread: unknown): void {
    const t = thread as
      | { id?: unknown; providerThreadId?: unknown }
      | undefined;
    if (!t) return;
    if (typeof t.id === "string") {
      // For pi, `providerThreadId` is null and the session id equals the bb
      // thread id (the session file is <threadId>.jsonl), so fall back to the
      // thread id itself as the provider session id.
      threadToProvider.set(
        t.id,
        typeof t.providerThreadId === "string" ? t.providerThreadId : t.id,
      );
    }
  }

  bb.events.on("thread.created", async (event) => {
    const t = (event as { thread?: unknown }).thread;
    recordThreadMapping(t);
  });
  bb.events.on("thread.active", async (event) => {
    const t = (event as { thread?: unknown }).thread;
    recordThreadMapping(t);
  });
  bb.events.on("thread.idle", async (event) => {
    const t = (event as { thread?: unknown }).thread;
    recordThreadMapping(t);
  });

  // ─── RPC methods ──────────────────────────────────────────────────────
  bb.rpc.register(rpcContract, {
    status: () => ({
      connected: server.listening,
      socketPath,
      sessionCount: sessions.size,
      lastEventAt,
      bufferedSeqs,
      authToken: requiresAuth ? null : effectiveToken,
    }),

    recent: (input) => {
      const { limit, sessionId, typePrefix } = input;
      for (const [key, ring] of rings) {
        }
      const out: Array<{
        seq: number;
        ts: string;
        type: string;
        sessionId: string | null;
        cwd: string;
        payload: unknown;
      }> = [];
      // Walk ALL rings first (filter as we go) so we never starve a ring
      // with newer events. Sort + slice after.
      for (const [key, ring] of rings) {
          if (sessionId && !key.startsWith(`${sessionId}::`)) continue;
        for (let i = ring.events.length - 1; i >= 0; i--) {
          const e = ring.events[i];
          const matches = !typePrefix || e.type.startsWith(typePrefix);
          if (!matches) continue;
          out.push({
            seq: e.seq,
            ts: e.ts,
            type: e.type,
            sessionId: e.sessionId ?? null,
            cwd: e.cwd,
            payload: e.payload,
          });
        }
      }
      out.sort((a, b) => b.seq - a.seq);
      const result = { events: out.slice(0, limit) };

      return result;
    },

    sessions: () => ({
      sessions: Array.from(sessions.values())
        .sort((a, b) => (a.lastSeenAt < b.lastSeenAt ? 1 : -1))
        .map((s) => ({
          sessionId: s.sessionId,
          cwd: s.cwd,
          firstSeenAt: s.firstSeenAt,
          lastSeenAt: s.lastSeenAt,
          lastEventType: s.lastEventType,
          eventCount: s.eventCount,
        })),
    }),

    enqueueCommand: ({ command, id, message, cwd }) => {
      // Persist into bb.storage.kv; the drain service will pick it up and
      // forward over every connected socket.
      const cmd = { command, id, message, cwd, ts: new Date().toISOString() };
      void bb.storage.kv.set(`cmd:${Date.now()}:${Math.random().toString(36).slice(2)}`, cmd);
      return { ok: true };
    },

    threadSession: ({ threadId }) => ({
      threadId,
      providerSessionId: threadToProvider.get(threadId) ?? null,
    }),
  });

  // ─── Drain command queue ─────────────────────────────────────────
  // Every 250ms, pull pending `cmd:*` keys from bb.storage.kv and forward
  // each as a `bb.bridge:command` envelope to every connected pi socket.
  // After forwarding, delete the key so we don't double-send.
  bb.background.service("drain-commands", {
    async start(signal) {
      bb.log.info("command drain service started");
      while (!signal.aborted) {
        try {
          const keys = await bb.storage.kv.list("cmd:");
          for (const key of keys) {
            const cmd = await bb.storage.kv.get<Record<string, unknown>>(key);
            if (!cmd || typeof cmd !== "object") {
              await bb.storage.kv.delete(key);
              continue;
            }
            const envelope = JSON.stringify({
              seq: Date.now(),
              ts: new Date().toISOString(),
              type: "bb.bridge:command",
              cwd: typeof cmd.cwd === "string" ? cmd.cwd : "",
              payload: cmd,
            }) + "\n";
            let delivered = 0;
            for (const sock of connectedSocks) {
              if (!sock.destroyed && sock.writable) {
                sock.write(envelope);
                delivered += 1;
              }
            }
            bb.log.info(`drained command ${cmd.command} for ${cmd.id} to ${delivered} socket(s)`);
            await bb.storage.kv.delete(key);
          }
        } catch (err) {
          bb.log.warn(`command drain failed: ${String(err)}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 250);
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
      bb.log.info("command drain service exiting");
    },
  });

  bb.log.info(`pi-events-bridge loaded; socket=${socketPath}`);
}
