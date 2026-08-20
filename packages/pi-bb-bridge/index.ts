// pi-bb-bridge
// Forward every pi lifecycle event (and the most-used 3rd-party plugin custom
// events) over a Unix socket to a bb-side consumer (bb-plugin-pi-events-bridge).
//
// Pattern modelled on herdr-agent-state.ts / otty-integration.ts:
//   * env-gated so it's a no-op unless BB_BRIDGE_SOCKET_PATH is set
//   * fire-and-forget; reconnect with backoff on disconnect
//   * one JSON object per line, terminator '\n'
//
// Config (all optional; set by bb-plugin-pi-events-bridge when it spawns pi):
//   BB_BRIDGE_SOCKET_PATH  absolute path to the Unix socket (or Windows named pipe name)
//   BB_BRIDGE_TOKEN        shared secret; first message carries it for auth
//   BB_BRIDGE_CWD          cwd; used to correlate with the active bb thread
//
// Third-party plugin events captured (when the plugin is installed):
//   subagents:*                 — @tintinweb/pi-subagents
//   plannotator:plan-approved   — @plannotator/pi-extension
//   pi-mcp-adapter/status/v1    — pi-mcp-adapter (server count snapshot)
//   pi-mcp-adapter:tool-approval-request
//   unified-exec:*              — pi-unified-exec (session created/exited/output)

import net from "node:net";
import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Config ─────────────────────────────────────────────────────────────

const SOCKET_PATH = process.env.BB_BRIDGE_SOCKET_PATH;
const TOKEN = process.env.BB_BRIDGE_TOKEN ?? "";
const CWD = process.env.BB_BRIDGE_CWD ?? process.cwd();
const PLATFORM = process.platform;

const socketEndpoint =
  PLATFORM === "win32" && SOCKET_PATH ? `\\\\.\\pipe\\${SOCKET_PATH}` : SOCKET_PATH;

function enabled(): boolean {
  return !!SOCKET_PATH;
}

// ─── Wire format ────────────────────────────────────────────────────────

type BridgeEvent = {
  /** Monotonically increasing sequence number across the lifetime of this pi session. */
  seq: number;
  /** ISO timestamp. */
  ts: string;
  /** Event source. `pi.lifecycle.*` for built-in events, `<plugin>:<event>` for third-party. */
  type: string;
  /** Cwd this pi session is running in; helps the bb side correlate to a thread. */
  cwd: string;
  /** Optional session id (pi session file basename). */
  sessionId?: string;
  /** Event payload — shape depends on `type`. */
  payload: unknown;
};

// ─── Sequence ───────────────────────────────────────────────────────────

let seq = 0;
function nextSeq(): number {
  seq += 1;
  return seq;
}

// ─── Outbound socket (auto-reconnecting) ────────────────────────────────

let socket: net.Socket | undefined;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let shuttingDown = false;
const queue: string[] = [];

function scheduleReconnect(delayMs: number): void {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delayMs);
  reconnectTimer.unref?.();
}

function connect(): void {
  if (!enabled() || shuttingDown) return;
  const sock = net.createConnection(socketEndpoint!);
  socket = sock;
  let incomingBuffer = "";

  sock.on("error", (err) => {
      scheduleReconnect(1500);
  });
  sock.on("connect", () => {
    // Drain anything we buffered while disconnected.
    while (queue.length > 0) {
      const line = queue.shift()!;
      sock.write(line);
    }
  });
  sock.on("data", (chunk: Buffer) => {
    // Inbound envelopes from the bb side: `bb.bridge:command` (steer/stop),
    // future `bb.bridge:*` (cancel, retry, etc.). Parse and dispatch via
    // the cross-extension RPC bus when a pi instance is registered.
    incomingBuffer += chunk.toString("utf8");
    let nl = incomingBuffer.indexOf("\n");
    while (nl !== -1) {
      const line = incomingBuffer.slice(0, nl);
      incomingBuffer = incomingBuffer.slice(nl + 1);
      if (line.length > 0) handleInbound(line, sock);
      nl = incomingBuffer.indexOf("\n");
    }
  });
  sock.on("close", () => {
    socket = undefined;
    scheduleReconnect(2000);
  });
}

// Track the most-recently-registered pi extension API so `handleInbound`
// can dispatch cross-extension RPC requests from the bb side.
let activePi: ExtensionAPI | undefined;

function handleInbound(line: string, sock: net.Socket): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  const obj = parsed as {
    type?: unknown;
    payload?: { command?: unknown; id?: unknown; message?: unknown };
  };
  if (obj?.type !== "bb.bridge:command") return;
  const p = obj.payload;
  if (!p || typeof p.command !== "string" || typeof p.id !== "string") return;
  const command = p.command;
  const id = p.id;
  const message = typeof p.message === "string" ? p.message : undefined;

  if (!activePi) {
    // No pi instance yet — ack with error.
    try {
      sock.write(
        JSON.stringify({
          seq: nextSeq(),
          ts: new Date().toISOString(),
          type: "bb.bridge:command-ack",
          cwd: CWD,
          sessionId: lastSessionId,
          payload: { command, id, ok: false, error: "no active pi session" },
        }) + "\n",
      );
    } catch {
      // ignore
    }
    return;
  }

  if (command !== "steer" && command !== "stop") {
    return;
  }
  // The cross-extension RPC bus in @tintinweb/pi-subagents uses events.emit
  // on the request channel and events.on on `<channel>:reply:<requestId>`.
  // No built-in `events.request` helper exists, so we synthesize one.
  const requestId = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const replyChannel = `subagents:rpc:${command}:reply:${requestId}`;
  const replyPayload: { ok: boolean; reply?: unknown; error?: string } = { ok: false };
  let settled = false;

  const unsub = activePi.events.on(replyChannel, (raw: unknown) => {
    if (settled) return;
    settled = true;
    unsub();
    const r = raw as { success?: boolean; data?: unknown; error?: string };
    if (r?.success) {
      replyPayload.ok = true;
      replyPayload.reply = r.data;
    } else {
      replyPayload.error = r?.error ?? "unknown";
    }
    try {
      sock.write(
        JSON.stringify({
          seq: nextSeq(),
          ts: new Date().toISOString(),
          type: "bb.bridge:command-ack",
          cwd: CWD,
          sessionId: lastSessionId,
          payload: { command, id, ...replyPayload },
        }) + "\n",
      );
    } catch {
      // ignore
    }
  });

  // 5s timeout: if no reply, give up.
  setTimeout(() => {
    if (settled) return;
    settled = true;
    unsub();
    try {
      sock.write(
        JSON.stringify({
          seq: nextSeq(),
          ts: new Date().toISOString(),
          type: "bb.bridge:command-ack",
          cwd: CWD,
          sessionId: lastSessionId,
          payload: { command, id, ok: false, error: "timeout" },
        }) + "\n",
      );
    } catch {
      // ignore
    }
  }, 5000).unref?.();

  // Emit the request.
  const request = message ? { requestId, id, message } : { requestId, id };
  activePi.events.emit(`subagents:rpc:${command}`, request);
}

function emit(type: string, payload: unknown, sessionId?: string): void {
  if (!enabled()) return;
  const evt: BridgeEvent = {
    seq: nextSeq(),
    ts: new Date().toISOString(),
    type,
    cwd: CWD,
    // sessionId is a top-level wire field; the chokepoint keys sessions by it.
    ...(sessionId ? { sessionId } : {}),
    payload,
  };
  const line = JSON.stringify(evt) + "\n";
  if (socket && !socket.destroyed && socket.writable) {
    socket.write(line);
  } else {
    // Buffer up to a small cap so we don't grow unbounded if the bb side is down.
    if (queue.length < 500) queue.push(line);
  }
}

// ─── Session id helper ──────────────────────────────────────────────────
// NOTE: pi-subagents runs subagent sessions in-process (runInChildSessionContext
// -> createAgentSession), so this extension's factory runs once per session in
// the SAME process. Session id therefore lives in the install closure (one per
// session), and the socket is shared — a new install must NOT create a second
// connection or it orphans the parent's events (and mis-tags them with the
// subagent's session id). `lastSessionId` is only for bb->pi command acks.

let lastSessionId: string | undefined;

function captureSessionId(ctx: {
  sessionManager?: { getSessionFile?: () => unknown };
}): string | undefined {
  try {
    const file = ctx.sessionManager?.getSessionFile?.();
    if (typeof file === "string" && file.length > 0) {
      return file.split("/").pop()?.replace(/\.jsonl$/, "");
    }
  } catch {
    // ignore
  }
  return undefined;
}

function asPayload(p: unknown): Record<string, unknown> {
  return p && typeof p === "object" ? (p as Record<string, unknown>) : { value: p };
}

// ─── Default export ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (!enabled()) {
    // No socket configured — no-op so the extension is safe to install globally.
    return;
  }

  activePi = pi;

  // Per-session state: this install closure belongs to one pi session (the
  // parent thread, or a subagent session created in-process by pi-subagents).
  let sessionId: string | undefined;
  function emitWithSession(type: string, payload: unknown): void {
    emit(type, asPayload(payload), sessionId);
  }
  function captureMySessionId(ctx: unknown): void {
    const id = captureSessionId(ctx as Parameters<typeof captureSessionId>[0]);
    if (id) sessionId = id;
    if (id) lastSessionId = id;
  }

  // The socket is SHARED across sessions in this process. Only the first
  // install performs the auth handshake + connect; later installs (subagent
  // sessions) just re-point activePi and reuse the live connection.
  if (!socket && !shuttingDown) {
    if (TOKEN) {
      emit("bb.bridge:hello", { token: TOKEN, pid: process.pid, host: os.hostname() });
    } else {
      emit("bb.bridge:hello", { pid: process.pid, host: os.hostname() });
    }
    connect();
  }

  // ─── Session lifecycle ────────────────────────────────────────────────
  pi.on("session_start", async (event, ctx) => {
    captureMySessionId(ctx);
    emitWithSession("pi.lifecycle:session_start", {
      reason: event?.reason,
      cwd: ctx.cwd,
    });
    // Embedded runtimes don't emit `context`; read goal entries directly.
    synthesizeGoalFromSessionContext(ctx);
  });

  // Refresh the goal snapshot on every turn so mid-session `/goal` sets and
  // `usage` updates reach the bb side (the consumer dedupes by seq).
  // `agent_settled` / `turn_end` catch entries written during the turn
  // (e.g. the `/goal` command) that `turn_start` misses.
  const refreshGoal = (_event: unknown, ctx: unknown): void => {
    synthesizeGoalFromSessionContext(ctx);
  };
  pi.on("turn_start", refreshGoal);
  pi.on("turn_end", refreshGoal);
  pi.on("agent_settled", refreshGoal);

  pi.on("session_shutdown", async (event) => {
    emitWithSession("pi.lifecycle:session_shutdown", { reason: event?.reason });
    // Do NOT end the shared socket here: subagent sessions shut down while
    // the parent session is still live. The process exit closes the socket.
  });

  pi.on("session_info_changed", (event) => {
    emitWithSession("pi.lifecycle:session_info_changed", { name: event?.name });
  });

  pi.on("session_before_switch", (event) => {
    emitWithSession("pi.lifecycle:session_before_switch", {
      reason: event?.reason,
      cancelled: false,
    });
  });

  pi.on("session_before_fork", (event) => {
    emitWithSession("pi.lifecycle:session_before_fork", {
      entryId: event?.entryId,
      position: event?.position,
      cancelled: false,
    });
  });

  pi.on("session_before_compact", (event) => {
    emitWithSession("pi.lifecycle:session_before_compact", {
      reason: event?.reason,
      willRetry: event?.willRetry,
    });
  });

  pi.on("session_compact", (event) => {
    emitWithSession("pi.lifecycle:session_compact", {
      reason: event?.reason,
      willRetry: event?.willRetry,
      fromExtension: event?.fromExtension,
    });
  });

  pi.on("session_tree", (event) => {
    emitWithSession("pi.lifecycle:session_tree", {
      newLeafId: event?.newLeafId,
      oldLeafId: event?.oldLeafId,
      fromExtension: event?.fromExtension,
    });
  });

  // ─── Agent / turn / message ───────────────────────────────────────────
  pi.on("before_agent_start", (event) => {
    // Keep payload small — systemPromptOptions may be large; emit only counts.
    const opts = event?.systemPromptOptions;
    emitWithSession("pi.lifecycle:before_agent_start", {
      promptPreview: typeof event?.prompt === "string" ? event.prompt.slice(0, 200) : "",
      imageCount: Array.isArray(event?.images) ? event.images.length : 0,
      systemPromptChars: typeof event?.systemPrompt === "string" ? event.systemPrompt.length : 0,
      activeToolCount: Array.isArray(opts?.selectedTools) ? opts.selectedTools.length : 0,
      loadedSkillCount: Array.isArray(opts?.skills) ? opts.skills.length : 0,
      contextFileCount: Array.isArray(opts?.contextFiles) ? opts.contextFiles.length : 0,
    });
  });

  pi.on("agent_start", (_event, ctx) => {
    emitWithSession("pi.lifecycle:agent_start", { isIdle: ctx?.isIdle?.() ?? null });
  });

  pi.on("agent_end", (event) => {
    emitWithSession("pi.lifecycle:agent_end", {
      messageCount: Array.isArray(event?.messages) ? event.messages.length : 0,
    });
  });

  pi.on("agent_settled", (_event, ctx) => {
    emitWithSession("pi.lifecycle:agent_settled", { isIdle: ctx?.isIdle?.() ?? null });
  });

  pi.on("turn_start", (event) => {
    emitWithSession("pi.lifecycle:turn_start", { turnIndex: event?.turnIndex });
  });

  pi.on("turn_end", (event) => {
    emitWithSession("pi.lifecycle:turn_end", {
      turnIndex: event?.turnIndex,
      toolResultCount: Array.isArray(event?.toolResults) ? event.toolResults.length : 0,
    });
  });

  pi.on("message_end", (event) => {
    const m = event?.message;
    if (!m) return;
    // Only surface assistant message metadata; user/tool messages are implied.
    if (m.role !== "assistant") return;
    emitWithSession("pi.lifecycle:message_end", {
      role: m.role,
      stopReason: (m as { stopReason?: string }).stopReason,
      usage: (m as { usage?: unknown }).usage,
    });
  });

  // Messages that bb provider-pi does not translate (leaked as
  // `provider/unhandled` in bb.db) — surface them so nothing is lost.
  pi.on("message_start", (event) => {
    const m = (event?.message ?? {}) as unknown as Record<string, unknown>;
    emitWithSession("pi.lifecycle:message_start", {
      role: typeof m.role === "string" ? m.role : undefined,
      id: typeof m.id === "string" ? m.id : undefined,
      model: typeof m.model === "string" ? m.model : undefined,
    });
  });

  pi.on("message_update", (event) => {
    const m = (event?.message ?? {}) as unknown as Record<string, unknown>;
    emitWithSession("pi.lifecycle:message_update", {
      id: typeof m.id === "string" ? m.id : undefined,
      role: typeof m.role === "string" ? m.role : undefined,
    });
  });

  // Tool execution lifecycle (distinct from tool_call/tool_result).
  pi.on("tool_execution_start", (event) => {
    const args = event?.args;
    emitWithSession("pi.lifecycle:tool_execution_start", {
      toolName: event?.toolName,
      toolCallId: event?.toolCallId,
      argKeys: args && typeof args === "object" ? Object.keys(args as object) : [],
    });
  });

  pi.on("tool_execution_update", (event) => {
    emitWithSession("pi.lifecycle:tool_execution_update", {
      toolName: event?.toolName,
      toolCallId: event?.toolCallId,
    });
  });

  pi.on("tool_execution_end", (event) => {
    const result = event?.result;
    emitWithSession("pi.lifecycle:tool_execution_end", {
      toolName: event?.toolName,
      toolCallId: event?.toolCallId,
      isError: event?.isError,
      resultIsError: Boolean(
        result && typeof result === "object" && (result as { isError?: unknown }).isError,
      ),
      contentLen:
        Array.isArray(result && typeof result === "object" && (result as { content?: unknown }).content)
          ? (result as { content: Array<{ text?: string }> }).content.reduce(
              (n: number, c: { text?: string }) => n + (typeof c?.text === "string" ? c.text.length : 0),
              0,
            )
          : undefined,
    });
  });

  // Provider request/response lifecycle + user input surfaces.
  pi.on("before_provider_request", (event) => {
    const p = (event?.payload ?? {}) as Record<string, unknown>;
    emitWithSession("pi.lifecycle:before_provider_request", {
      model: typeof p.model === "string" ? p.model : undefined,
      provider: p.model && typeof p.model === "object" ? (p.model as { provider?: unknown }).provider : undefined,
    });
  });

  pi.on("after_provider_response", (event) => {
    emitWithSession("pi.lifecycle:after_provider_response", {
      status: event?.status,
    });
  });

  pi.on("user_bash", (event) => {
    emitWithSession("pi.lifecycle:user_bash", {
      command: event?.command,
      excludeFromContext: event?.excludeFromContext,
    });
  });

  pi.on("input", (event) => {
    emitWithSession("pi.lifecycle:input", {
      textLen: typeof event?.text === "string" ? event.text.length : undefined,
      hasImages: Array.isArray(event?.images) ? event.images.length > 0 : undefined,
    });
  });

  // ─── Tool calls (most useful for 3rd-party overrides detection) ───────
  // ─── pi-codex-goal state synthesis ────────────────────────────────────
  // pi-codex-goal stores goals as CustomEntry rows with customType
  // "pi-codex-goal" and data.kind in {set, usage, clear, host_overflow_cap_reset}.
  // They appear in event.messages on the `context` event (and in any
  // sessionManager.getEntries() call). We replay them in order to compute
  // the current ThreadGoal, then emit a synthesized event so bb-side plugins
  // can render the active goal without reading pi session storage.
  let lastGoalFingerprint = "";

  function extractGoalState(messages: unknown): {
    goal: null | {
      goalId: string;
      objective: string;
      status: string;
      tokenBudget: number | null;
      usage: { tokensUsed: number; activeSeconds: number };
      createdAt: number;
      updatedAt: number;
    };
    historyCount: number;
  } {
    let goal: null | {
      goalId: string;
      objective: string;
      status: string;
      tokenBudget: number | null;
      usage: { tokensUsed: number; activeSeconds: number };
      createdAt: number;
      updatedAt: number;
    } = null;
    let historyCount = 0;
    if (!Array.isArray(messages)) return { goal, historyCount };
    for (const m of messages) {
      const entry = m as { type?: unknown; customType?: unknown; data?: unknown };
      if (entry?.type !== "custom" || entry?.customType !== "pi-codex-goal") continue;
      const data = entry.data as
        | {
            kind?: unknown;
            goal?: unknown;
            goalId?: unknown;
            status?: unknown;
            usage?: unknown;
            updatedAt?: unknown;
          }
        | undefined;
      if (!data || typeof data !== "object") continue;
      historyCount += 1;
      if (data.kind === "set") {
        const g = data.goal as
          | {
              goalId?: unknown;
              objective?: unknown;
              status?: unknown;
              tokenBudget?: unknown;
              usage?: unknown;
              createdAt?: unknown;
              updatedAt?: unknown;
            }
          | undefined;
        if (g && typeof g.goalId === "string" && typeof g.objective === "string") {
          goal = {
            goalId: g.goalId,
            objective: g.objective,
            status: typeof g.status === "string" ? g.status : "active",
            tokenBudget: typeof g.tokenBudget === "number" ? g.tokenBudget : null,
            usage: {
              tokensUsed:
                g.usage && typeof (g.usage as { tokensUsed?: unknown }).tokensUsed === "number"
                  ? (g.usage as { tokensUsed: number }).tokensUsed
                  : 0,
              activeSeconds:
                g.usage &&
                typeof (g.usage as { activeSeconds?: unknown }).activeSeconds === "number"
                  ? (g.usage as { activeSeconds: number }).activeSeconds
                  : 0,
            },
            createdAt: typeof g.createdAt === "number" ? g.createdAt : Date.now(),
            updatedAt: typeof g.updatedAt === "number" ? g.updatedAt : Date.now(),
          };
        }
      } else if (data.kind === "usage") {
        if (goal && data.goalId === goal.goalId) {
          if (typeof data.status === "string") goal.status = data.status;
          if (data.usage && typeof data.usage === "object") {
            const u = data.usage as { tokensUsed?: unknown; activeSeconds?: unknown };
            if (typeof u.tokensUsed === "number") goal.usage.tokensUsed = u.tokensUsed;
            if (typeof u.activeSeconds === "number") goal.usage.activeSeconds = u.activeSeconds;
          }
          if (typeof data.updatedAt === "number") goal.updatedAt = data.updatedAt;
        }
      } else if (data.kind === "clear") {
        goal = null;
      }
      // host_overflow_cap_reset is an internal cap signal; not surfaced.
    }
    return { goal, historyCount };
  }

  // Embedded (RPC/bridge) runtimes never emit `context` events, so on session
  // start and every turn start we read goal entries straight from the session
  // manager and synthesize the same `pi.ext:codex-goal/*` envelopes. Dedupe by
  // entry fingerprint so history isn't duplicated across turns.
  const goalEntryFingerprints = new Set<string>();
  let goalStateFingerprint: string | null = null;

  function synthesizeGoalFromEntries(entries: unknown[]): void {
    let lastGoal = null as ReturnType<typeof extractGoalState>["goal"];
    let historyCount = 0;
    for (const m of entries) {
      const entry = m as { type?: unknown; customType?: unknown; data?: unknown };
      if (entry?.type !== "custom" || entry?.customType !== "pi-codex-goal") continue;
      const data = entry.data as
        | {
            kind?: unknown;
            goal?: unknown;
            goalId?: unknown;
            status?: unknown;
            usage?: unknown;
            source?: unknown;
            updatedAt?: unknown;
            at?: unknown;
            clearedGoalId?: unknown;
          }
        | undefined;
      if (!data || typeof data !== "object") continue;
      historyCount += 1;

      if (data.kind === "set") {
        const g = data.goal as
          | {
              goalId?: unknown;
              objective?: unknown;
              status?: unknown;
              tokenBudget?: unknown;
              usage?: unknown;
              createdAt?: unknown;
              updatedAt?: unknown;
            }
          | undefined;
        if (g && typeof g.goalId === "string" && typeof g.objective === "string") {
          lastGoal = {
            goalId: g.goalId,
            objective: g.objective,
            status: typeof g.status === "string" ? g.status : "active",
            tokenBudget: typeof g.tokenBudget === "number" ? g.tokenBudget : null,
            usage: {
              tokensUsed:
                g.usage &&
                typeof (g.usage as { tokensUsed?: unknown }).tokensUsed === "number"
                  ? (g.usage as { tokensUsed: number }).tokensUsed
                  : 0,
              activeSeconds:
                g.usage &&
                typeof (g.usage as { activeSeconds?: unknown }).activeSeconds === "number"
                  ? (g.usage as { activeSeconds: number }).activeSeconds
                  : 0,
            },
            createdAt: typeof g.createdAt === "number" ? g.createdAt : Date.now(),
            updatedAt: typeof g.updatedAt === "number" ? g.updatedAt : Date.now(),
          };
        }
      } else if (data.kind === "usage") {
        if (lastGoal && data.goalId === lastGoal.goalId) {
          if (typeof data.status === "string") lastGoal.status = data.status;
          if (data.usage && typeof data.usage === "object") {
            const u = data.usage as { tokensUsed?: unknown; activeSeconds?: unknown };
            if (typeof u.tokensUsed === "number") lastGoal.usage.tokensUsed = u.tokensUsed;
            if (typeof u.activeSeconds === "number") lastGoal.usage.activeSeconds = u.activeSeconds;
          }
          if (typeof data.updatedAt === "number") lastGoal.updatedAt = data.updatedAt;
        }
      } else if (data.kind === "clear") {
        lastGoal = null;
      }

      const fp = `${data.kind ?? "?"}|${typeof data.at === "number" ? data.at : 0}|${typeof data.goalId === "string" ? data.goalId : (typeof data.clearedGoalId === "string" ? data.clearedGoalId : "")}|${typeof data.status === "string" ? data.status : ""}|${data.usage && typeof (data.usage as { tokensUsed?: unknown }).tokensUsed === "number" ? (data.usage as { tokensUsed: number }).tokensUsed : -1}`;
      if (goalEntryFingerprints.has(fp)) continue;
      goalEntryFingerprints.add(fp);
      if (goalEntryFingerprints.size > 2000) goalEntryFingerprints.clear();
      emitWithSession("pi.ext:codex-goal/entry", {
        kind: data.kind,
        at: typeof data.at === "number" ? data.at : Date.now(),
        source: typeof data.source === "string" ? data.source : undefined,
        goalId:
          typeof data.goalId === "string"
            ? data.goalId
            : (typeof data.clearedGoalId === "string" ? data.clearedGoalId : null),
        clearedGoalId: typeof data.clearedGoalId === "string" ? data.clearedGoalId : null,
        objective:
          data.kind === "set" && data.goal && typeof (data.goal as { objective?: unknown }).objective === "string"
            ? (data.goal as { objective: string }).objective
            : undefined,
        status:
          data.kind === "set" && data.goal && typeof (data.goal as { status?: unknown }).status === "string"
            ? (data.goal as { status: string }).status
            : typeof data.status === "string"
              ? data.status
              : undefined,
        tokensUsed:
          data.usage && typeof (data.usage as { tokensUsed?: unknown }).tokensUsed === "number"
            ? (data.usage as { tokensUsed: number }).tokensUsed
            : undefined,
        activeSeconds:
          data.usage && typeof (data.usage as { activeSeconds?: unknown }).activeSeconds === "number"
            ? (data.usage as { activeSeconds: number }).activeSeconds
            : undefined,
      });
    }

    const snapFp = lastGoal
      ? `${lastGoal.goalId}|${lastGoal.status}|${lastGoal.usage.tokensUsed}|${lastGoal.usage.activeSeconds}|${historyCount}`
      : `none|${historyCount}`;
    if (snapFp === goalStateFingerprint) return;
    goalStateFingerprint = snapFp;
    emitWithSession("pi.ext:codex-goal/state", {
      goal: lastGoal,
      historyCount,
      objectivePreview: lastGoal ? lastGoal.objective.slice(0, 400) : null,
    });
  }

  function synthesizeGoalFromSessionContext(ctx: unknown): void {
    try {
      const sm = (ctx as { sessionManager?: { getEntries?: () => unknown } }).sessionManager;
      const entries = sm?.getEntries?.();
      if (Array.isArray(entries)) synthesizeGoalFromEntries(entries);
    } catch {
      // ignore
    }
  }

  pi.on("context", (event) => {
    const messages = (event as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) return;

    // Walk pi-codex-goal CustomEntry rows in order; emit one
    // `pi.ext:codex-goal/entry` envelope per row, then a final
    // `pi.ext:codex-goal/state` with the rolled-up snapshot. The bb
    // consumer keeps the per-entry history; the snapshot is what the UI
    // renders in the composer banner.
    let lastGoal = null as ReturnType<typeof extractGoalState>["goal"];
    let lastGoalId: string | null = null;
    let lastSeenFingerprint = "";
    let historyCount = 0;
    let changedThisContext = false;

    for (const m of messages) {
      const entry = m as { type?: unknown; customType?: unknown; data?: unknown };
      if (entry?.type !== "custom" || entry?.customType !== "pi-codex-goal") continue;
      const data = entry.data as
        | {
            kind?: unknown;
            goal?: unknown;
            goalId?: unknown;
            status?: unknown;
            usage?: unknown;
            source?: unknown;
            updatedAt?: unknown;
            at?: unknown;
            clearedGoalId?: unknown;
          }
        | undefined;
      if (!data || typeof data !== "object") continue;
      historyCount += 1;

      // Replay locally to keep `lastGoal` in sync, so we emit a snapshot
      // that matches the current state of pi-codex-goal.
      if (data.kind === "set") {
        const g = data.goal as
          | {
              goalId?: unknown;
              objective?: unknown;
              status?: unknown;
              tokenBudget?: unknown;
              usage?: unknown;
              createdAt?: unknown;
              updatedAt?: unknown;
            }
          | undefined;
        if (g && typeof g.goalId === "string" && typeof g.objective === "string") {
          lastGoal = {
            goalId: g.goalId,
            objective: g.objective,
            status: typeof g.status === "string" ? g.status : "active",
            tokenBudget: typeof g.tokenBudget === "number" ? g.tokenBudget : null,
            usage: {
              tokensUsed:
                g.usage &&
                typeof (g.usage as { tokensUsed?: unknown }).tokensUsed === "number"
                  ? (g.usage as { tokensUsed: number }).tokensUsed
                  : 0,
              activeSeconds:
                g.usage &&
                typeof (g.usage as { activeSeconds?: unknown }).activeSeconds === "number"
                  ? (g.usage as { activeSeconds: number }).activeSeconds
                  : 0,
            },
            createdAt: typeof g.createdAt === "number" ? g.createdAt : Date.now(),
            updatedAt: typeof g.updatedAt === "number" ? g.updatedAt : Date.now(),
          };
          lastGoalId = g.goalId;
        }
      } else if (data.kind === "usage") {
        if (lastGoal && data.goalId === lastGoal.goalId) {
          if (typeof data.status === "string") lastGoal.status = data.status;
          if (data.usage && typeof data.usage === "object") {
            const u = data.usage as { tokensUsed?: unknown; activeSeconds?: unknown };
            if (typeof u.tokensUsed === "number") lastGoal.usage.tokensUsed = u.tokensUsed;
            if (typeof u.activeSeconds === "number") lastGoal.usage.activeSeconds = u.activeSeconds;
          }
          if (typeof data.updatedAt === "number") lastGoal.updatedAt = data.updatedAt;
        }
      } else if (data.kind === "clear") {
        lastGoal = null;
        lastGoalId = null;
      }

      // Emit one envelope per entry, deduped on a stable fingerprint
      // (goalId + kind + at + status + tokensUsed).
      const fp = `${data.kind ?? "?"}|${typeof data.at === "number" ? data.at : 0}|${typeof data.goalId === "string" ? data.goalId : (typeof data.clearedGoalId === "string" ? data.clearedGoalId : "")}|${typeof data.status === "string" ? data.status : ""}|${data.usage && typeof (data.usage as { tokensUsed?: unknown }).tokensUsed === "number" ? (data.usage as { tokensUsed: number }).tokensUsed : -1}`;
      if (fp !== lastSeenFingerprint) {
        lastSeenFingerprint = fp;
        changedThisContext = true;
        emitWithSession("pi.ext:codex-goal/entry", {
          kind: data.kind,
          at: typeof data.at === "number" ? data.at : Date.now(),
          source: typeof data.source === "string" ? data.source : undefined,
          goalId: typeof data.goalId === "string" ? data.goalId : (typeof data.clearedGoalId === "string" ? data.clearedGoalId : null),
          clearedGoalId: typeof data.clearedGoalId === "string" ? data.clearedGoalId : null,
          // Snapshot the goal at this entry for the history view to render
          // an accurate at-the-time objective.
          objective:
            data.kind === "set" && data.goal && typeof (data.goal as { objective?: unknown }).objective === "string"
              ? (data.goal as { objective: string }).objective
              : undefined,
          status:
            data.kind === "set" && data.goal && typeof (data.goal as { status?: unknown }).status === "string"
              ? (data.goal as { status: string }).status
              : typeof data.status === "string"
                ? data.status
                : undefined,
          tokensUsed:
            data.usage && typeof (data.usage as { tokensUsed?: unknown }).tokensUsed === "number"
              ? (data.usage as { tokensUsed: number }).tokensUsed
              : undefined,
          activeSeconds:
            data.usage && typeof (data.usage as { activeSeconds?: unknown }).activeSeconds === "number"
              ? (data.usage as { activeSeconds: number }).activeSeconds
              : undefined,
        });
      }
    }

    // Snapshot envelope: only emit when something changed.
    const snapFp = lastGoal
      ? `${lastGoal.goalId}|${lastGoal.status}|${lastGoal.usage.tokensUsed}|${lastGoal.usage.activeSeconds}|${historyCount}`
      : `none|${historyCount}`;
    if (snapFp === lastGoalFingerprint && !changedThisContext) return;
    lastGoalFingerprint = snapFp;
    emitWithSession("pi.ext:codex-goal/state", {
      goal: lastGoal,
      historyCount,
      objectivePreview: lastGoal ? lastGoal.objective.slice(0, 400) : null,
    });
  });

  pi.on("tool_call", (event) => {
    emitWithSession("pi.lifecycle:tool_call", {
      toolName: event?.toolName,
      toolCallId: event?.toolCallId,
      // Don't ship full args (may contain secrets); just keys.
      argKeys: event?.input && typeof event.input === "object"
        ? Object.keys(event.input)
        : [],
    });
  });

  pi.on("tool_result", (event) => {
    emitWithSession("pi.lifecycle:tool_result", {
      toolName: event?.toolName,
      toolCallId: event?.toolCallId,
      isError: event?.isError,
      contentLen: Array.isArray(event?.content)
        ? event.content.reduce(
            (n: number, c: unknown) => n + (typeof (c as { text?: unknown })?.text === "string" ? ((c as { text: string }).text).length : 0),
            0,
          )
        : 0,
    });
  });

  // ─── Model / thinking level ───────────────────────────────────────────
  pi.on("model_select", (event) => {
    emitWithSession("pi.lifecycle:model_select", {
      model: event?.model ? `${event.model.provider}/${event.model.id}` : null,
      previousModel: event?.previousModel ? `${event.previousModel.provider}/${event.previousModel.id}` : null,
      source: event?.source,
    });
  });

  pi.on("thinking_level_select", (event) => {
    emitWithSession("pi.lifecycle:thinking_level_select", {
      level: event?.level,
      previousLevel: event?.previousLevel,
    });
  });

  // ─── Third-party plugin events ────────────────────────────────────────
  // The pi events bus fires custom events with arbitrary names. We re-emit them
  // with a `pi.ext:<event>` prefix so the bb side can subscribe per source.

  const forwardExtEvent = (eventName: string) =>
    pi.events.on(eventName, (data: unknown) => {
      emitWithSession(`pi.ext:${eventName}`, asPayload(data));
    });

  // @tintinweb/pi-subagents — sub-agent lifecycle
  forwardExtEvent("subagents:ready");
  forwardExtEvent("subagents:created");
  forwardExtEvent("subagents:started");
  forwardExtEvent("subagents:completed");
  forwardExtEvent("subagents:failed");
  forwardExtEvent("subagents:steered");
  forwardExtEvent("subagents:compacted");
  forwardExtEvent("subagents:scheduled");
  forwardExtEvent("subagents:scheduler_ready");

  // @plannotator/pi-extension — plan approval flow
  forwardExtEvent("plannotator:plan-approved");
  forwardExtEvent("plannotator:plan-denied");
  forwardExtEvent("plannotator:plan-changes-requested");

  // pi-mcp-adapter — server status + approval requests
  forwardExtEvent("pi-mcp-adapter/status/v1");
  forwardExtEvent("pi-mcp-adapter:tool-approval-request");

  // pi-unified-exec — long-lived exec sessions
  forwardExtEvent("unified-exec:session-created");
  forwardExtEvent("unified-exec:session-exited");
  forwardExtEvent("unified-exec:session-output");

  // ─── Shutdown ─────────────────────────────────────────────────────────
  // NOTE: there is deliberately no cleanup in a second `session_shutdown`
  // handler here — subagent sessions shut down while the parent session is
  // still live, and ending the shared socket would drop the parent's events.
  // The process exit closes the socket; reconnect-on-close keeps it alive
  // for as long as the process runs.
}
