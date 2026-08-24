// bb-plugin-codex-live — shared live-state model.
//
// Pure reducer from per-(threadId, itemId) bb-plugin-codex-events-bridge
// events into a bounded, snapshot-friendly per-thread "live console" map.
// No I/O, no bb.* calls — server.ts wires this up; the frontend just reads
// the resulting snapshot.
//
// The model is intentionally narrow — only the streaming deltas the user
// expects to see character-by-character in the live console:
//   • reasoning (textDelta + summaryTextDelta coalesced into one block)
//   • commandExecution (outputDelta streamed, plus started payload context)
//   • fileChange (outputDelta streamed as raw diff)
//   • toolCall + mcpToolCall (progress events)
//   • backgroundTask (progress events + completed terminal)
//
// We are NOT trying to mirror the full bb timeline — item/agentMessage/delta
// and item/plan/delta are excluded by design (the chat thread already
// streams those) — and we are NOT parsing `item/completed` payloads beyond
// the small fields we need to render: status, exit code, tool name, etc.
// Anything richer lives in the existing timeline view.

import { z } from "zod";

// ─── Pulled from the bb-plugin-codex-events-bridge chokepoint ────────────
//
// The bridge's `recent` rpc returns rows shaped like its internal CodexEvent:
//   { seq, ts, type, category, threadId, providerThreadId, payload }
// with `category` ∈ {"thread", "turn", "item", "account"}. We only consume
// the `item` rows here.

export const CodexBridgeEventSchema = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  type: z.string(),
  category: z.enum(["thread", "turn", "item", "account"]),
  threadId: z.string(),
  providerThreadId: z.string().nullable(),
  payload: z.unknown(),
});
export type CodexBridgeEvent = z.infer<typeof CodexBridgeEventSchema>;

export const BridgeRecentResultSchema = z.object({
  events: z.array(CodexBridgeEventSchema),
});

export const BridgeSessionsResultSchema = z.object({
  sessions: z.array(z.object({ threadId: z.string() }).passthrough()),
});

// ─── Live item kinds ────────────────────────────────────────────────────

export type LiveItemKind =
  | "reasoning"
  | "commandExecution"
  | "fileChange"
  | "toolCall"
  | "mcpToolCall"
  | "backgroundTask";

export type ItemStatus = "pending" | "completed" | "failed" | "interrupted";
export type BackgroundTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "killed"
  | "paused"
  | "stopped";

interface LiveItemBase {
  itemId: string;
  threadId: string;
  parentToolCallId: string | null;
  startedAt: string;
  lastEventAt: string;
  /** True once an item/completed (or backgroundTask/completed) lands. */
  completed: boolean;
  /** ISO ts of the terminal event. */
  completedAt: string | null;
  /** Auxiliary status from the item body when known. */
  status: ItemStatus | null;
  /** Buffer byte length when truncated (only meaningful on large items). */
  byteLength: number;
  truncated: boolean;
}

export interface ReasoningLiveItem extends LiveItemBase {
  kind: "reasoning";
  /** Streamed raw reasoning text. */
  content: string;
  /** Streamed reasoning summary text (separate delta channel). */
  summary: string;
}

export interface CommandExecutionLiveItem extends LiveItemBase {
  kind: "commandExecution";
  command: string;
  cwd: string;
  /** Streamed `aggregatedOutput` deltas concatenated. */
  aggregatedOutput: string;
  exitCode: number | null;
}

export interface FileChangeLiveItem extends LiveItemBase {
  kind: "fileChange";
  /** Streamed `outputDelta` text (raw `diff` patches). */
  diff: string;
}

export interface ToolCallLiveItem extends LiveItemBase {
  kind: "toolCall";
  tool: string;
  message: string | null;
  progressCurrent: number | null;
  progressTotal: number | null;
}

export interface McpToolCallLiveItem extends LiveItemBase {
  kind: "mcpToolCall";
  server: string | null;
  tool: string;
  message: string | null;
  progressCurrent: number | null;
  progressTotal: number | null;
}

export interface BackgroundTaskLiveItem extends LiveItemBase {
  kind: "backgroundTask";
  description: string;
  taskType: string;
  taskStatus: BackgroundTaskStatus;
  progress: number | null;
  /** Optional workflow sub-agent summary, only set when the payload had one. */
  workflowSummary: string | null;
  /** Accumulated stream of backgroundTask/progress values (last wins, but
   *  history lets a renderer show a sparkline if it wants one). */
  progressHistory: number[];
}

export type LiveItem =
  | ReasoningLiveItem
  | CommandExecutionLiveItem
  | FileChangeLiveItem
  | ToolCallLiveItem
  | McpToolCallLiveItem
  | BackgroundTaskLiveItem;

// ─── Thread state ───────────────────────────────────────────────────────

export interface ThreadLiveState {
  /** Per-(itemId) live items. */
  items: Record<string, LiveItem>;
  /** Item ids sorted by ascending `startedAt` — the render order. */
  order: string[];
}

export function emptyThreadState(): ThreadLiveState {
  return { items: {}, order: [] };
}

// ─── Reducer helpers ────────────────────────────────────────────────────

/** Default byte cap for accumulated text buffers (UTF-8). */
export const DEFAULT_MAX_DELTA_BYTES_PER_ITEM = 256 * 1024;

/**
 * Append `chunk` to `target`. If the result exceeds `cap` bytes, keep the
 * tail (the most recent text — the live console cares about what the agent
 * is producing right now, not the beginning of a long trace). Mutates
 * `target` and returns the new byte length.
 */
export function appendCapped(
  target: string,
  chunk: string,
  cap: number,
): { value: string; bytes: number; truncated: boolean } {
  if (!chunk) return { value: target, bytes: byteLength(target), truncated: false };
  const combined = target + chunk;
  let bytes = byteLength(combined);
  if (bytes <= cap) {
    return { value: combined, bytes, truncated: false };
  }
  // Binary-search the earliest UTF-16 slice whose UTF-8 representation fits.
  let lo = 0;
  let hi = combined.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (byteLength(combined.slice(mid)) <= cap) hi = mid;
    else lo = mid + 1;
  }
  // Do not begin on the low half of a surrogate pair.
  if (lo < combined.length) {
    const code = combined.charCodeAt(lo);
    if (code >= 0xdc00 && code <= 0xdfff) lo += 1;
  }
  const tail = combined.slice(lo);
  bytes = byteLength(tail);
  return { value: tail, bytes, truncated: true };
}

/** Approximate UTF-8 byte length of a JS string (cheap and good enough). */
export function byteLength(s: string): number {
  // Could use TextEncoder for exactness, but the cost matters on every
  // delta — a UTF-16 length approximation over-estimates by ~50% in the
  // worst case (all BMP chars with high bits set) which is fine for
  // capping. Use the slightly more accurate Buffer form when available.
  if (typeof Buffer !== "undefined") {
    return Buffer.byteLength(s, "utf8");
  }
  // Fallback: rough overestimate (every code unit ≤ 3 UTF-8 bytes).
  return s.length * 3;
}

/**
 * Compute text bytes without allocating a Buffer when length is small.
 * Best-effort exact in ASCII (length === bytes); conservative elsewhere.
 */
export function quickByteLength(s: string): number {
  if (s.length === 0) return 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) > 0x7f) return Buffer.byteLength(s, "utf8");
  }
  return s.length;
}

// ─── Apply bridge events ────────────────────────────────────────────────

interface ReduceOptions {
  maxItemsPerThread: number;
  maxDeltaBytesPerItem: number;
  nowMs: () => number;
  /** Auto-clear delay applied to item completions. Defaults to 60s. */
  clearDelayMs?: number;
  /** Callback so the server can schedule a per-item auto-clear timer. */
  scheduleAutoClear: (threadId: string, itemId: string, delayMs: number) => void;
}

export interface ReduceResult {
  changed: boolean;
  /** Item ids that became completed during this batch (after which the
   *  server should publish a snapshot once the auto-clear timer is armed). */
  completedItemIds: string[];
}

interface ApplyOneResult {
  changed: boolean;
  completed: boolean;
  itemId: string;
}

/**
 * Reduce one batch of events (`oldest → newest` order, ascending seq) into
 * the given per-thread state map. Returns metadata the caller can use to
 * decide whether to republish the realtime snapshot.
 *
 * The reducer is deliberately defensive: out-of-order or duplicate events
 * are absorbed silently; unknown event types are ignored; item-shape
 * `payload`s are picked apart shallowly without trusting their exact field
 * names beyond what the SDK schemas document.
 */
export function applyBridgeEvents(
  threads: Map<string, ThreadLiveState>,
  events: CodexBridgeEvent[],
  opts: ReduceOptions,
): ReduceResult {
  let changed = false;
  const completedItemIds: string[] = [];

  for (const event of events) {
    if (event.category !== "item") continue;
    const before = threads.get(event.threadId) ?? emptyThreadState();
    if (!threads.has(event.threadId)) threads.set(event.threadId, before);

    const result = applyOne(before, event, opts);
    if (!result.changed) continue;
    changed = true;

    if (result.completed) {
      // applyOne records the (threadId, itemId) of the just-completed
      // item on the result envelope — itemId is payload-derived, never an
      // event-shape assumption.
      completedItemIds.push(result.itemId);
      opts.scheduleAutoClear(event.threadId, result.itemId, opts.clearDelayMs ?? 60_000);
    }
  }

  // After all updates, evict the oldest in-flight items once a thread
  // overflows the per-thread cap. Keeps memory bounded even if many
  // items race to start in the same tick.
  for (const [, state] of threads) {
    while (state.order.length > opts.maxItemsPerThread) {
      const dropped = state.order.shift();
      if (dropped) delete state.items[dropped];
    }
  }

  return { changed, completedItemIds };
}

interface ItemPayloadBody {
  type?: string;
  id?: string;
  parentToolCallId?: string | null;
  command?: string;
  cwd?: string;
  aggregatedOutput?: string;
  exitCode?: number;
  diff?: string;
  tool?: string;
  server?: string;
  description?: string;
  taskType?: string;
  taskStatus?: string;
  status?: string;
  content?: string[];
  summary?: string | string[];
  workflowName?: string;
  error?: string;
  changes?: Array<{ path?: string; kind?: string; diff?: string }>;
}

interface DeltaPayloadBody {
  itemId?: string;
  delta?: string;
  summaryIndex?: number;
  progress?:
    | number
    | {
        current?: number;
        total?: number | null;
        message?: string | null;
      };
  message?: string;
  reset?: boolean;
}

interface BackgroundTaskProgressBody {
  item?: {
    description?: string;
    error?: string;
    id?: string;
    taskType?: string;
    taskStatus?: string;
    workflowName?: string;
  };
  itemId?: string;
  progress?: number;
}

interface BackgroundTaskCompletedBody {
  item?: ItemPayloadBody;
  itemId?: string;
  status?: string;
  result?: unknown;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function backgroundTaskStatusOr(s: string | null | undefined): BackgroundTaskStatus {
  switch (s) {
    case "running":
    case "completed":
    case "failed":
    case "killed":
    case "paused":
    case "stopped":
      return s;
    default:
      return "pending";
  }
}

function itemStatusOr(s: string | null | undefined): ItemStatus | null {
  if (s === "completed" || s === "failed" || s === "interrupted" || s === "pending") {
    return s;
  }
  return null;
}

function pushNewest<T>(arr: T[], value: T, cap: number): void {
  arr.push(value);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

function itemByteLength(item: LiveItem): number {
  switch (item.kind) {
    case "reasoning":
      return quickByteLength(item.content) + quickByteLength(item.summary);
    case "commandExecution":
      return quickByteLength(item.aggregatedOutput);
    case "fileChange":
      return quickByteLength(item.diff);
    case "toolCall":
    case "mcpToolCall":
      // Progress fields are tiny; no streaming text buffer.
      return 0;
    case "backgroundTask":
      return 0;
  }
}

function refreshByteLength(item: LiveItem): void {
  item.byteLength = itemByteLength(item);
}

function enforceTextCap(item: LiveItem, cap: number): void {
  if (item.kind === "reasoning") {
    const raw = appendCapped("", item.content, cap);
    item.content = raw.value;
    const remaining = Math.max(0, cap - raw.bytes);
    const summary = appendCapped("", item.summary, remaining);
    item.summary = summary.value;
    item.truncated ||= raw.truncated || summary.truncated;
  } else if (item.kind === "commandExecution") {
    const output = appendCapped("", item.aggregatedOutput, cap);
    item.aggregatedOutput = output.value;
    item.truncated ||= output.truncated;
  } else if (item.kind === "fileChange") {
    const diff = appendCapped("", item.diff, cap);
    item.diff = diff.value;
    item.truncated ||= diff.truncated;
  }
  refreshByteLength(item);
}

function ensureItem(
  state: ThreadLiveState,
  threadId: string,
  itemId: string,
  kind: LiveItemKind,
  ts: string,
): LiveItem {
  let item = state.items[itemId];
  if (item) {
    // Reclassify when applyOrder is wrong (e.g. delta arrives before
    // item/started — the events-bridge ring may have evicted the start).
    if (item.kind !== kind) {
      // Discard and rebuild — kind unification matters for the renderer.
      state.order = state.order.filter((id) => id !== itemId);
      delete state.items[itemId];
      item = createItem(threadId, itemId, kind, ts);
      state.items[itemId] = item;
      state.order.push(itemId);
    } else {
      return item;
    }
  } else {
    item = createItem(threadId, itemId, kind, ts);
    state.items[itemId] = item;
    state.order.push(itemId);
  }
  state.order.sort((a, b) => {
    const ai = state.items[a]!;
    const bi = state.items[b]!;
    return ai.startedAt < bi.startedAt ? -1 : ai.startedAt > bi.startedAt ? 1 : 0;
  });
  return item;
}

function createItem(
  threadId: string,
  itemId: string,
  kind: LiveItemKind,
  ts: string,
): LiveItem {
  const base = {
    itemId,
    threadId,
    parentToolCallId: null,
    startedAt: ts,
    lastEventAt: ts,
    completed: false,
    completedAt: null,
    status: null,
    byteLength: 0,
    truncated: false,
  } as const;
  switch (kind) {
    case "reasoning":
      return {
        ...base,
        kind: "reasoning",
        content: "",
        summary: "",
      };
    case "commandExecution":
      return {
        ...base,
        kind: "commandExecution",
        command: "",
        cwd: "",
        aggregatedOutput: "",
        exitCode: null,
      };
    case "fileChange":
      return {
        ...base,
        kind: "fileChange",
        diff: "",
      };
    case "toolCall":
      return {
        ...base,
        kind: "toolCall",
        tool: "",
        message: null,
        progressCurrent: null,
        progressTotal: null,
      };
    case "mcpToolCall":
      return {
        ...base,
        kind: "mcpToolCall",
        server: null,
        tool: "",
        message: null,
        progressCurrent: null,
        progressTotal: null,
      };
    case "backgroundTask":
      return {
        ...base,
        kind: "backgroundTask",
        description: "",
        taskType: "",
        taskStatus: "pending",
        progress: null,
        workflowSummary: null,
        progressHistory: [],
      };
  }
}

function applyOne(
  state: ThreadLiveState,
  event: CodexBridgeEvent,
  opts: ReduceOptions,
): ApplyOneResult {
  const { type } = event;
  const payload = event.payload;
  const ts = event.ts;

  // ─── item/started ────────────────────────────────────────────────
  if (type === "item/started") {
    const envelope = asObject(payload) as { item?: ItemPayloadBody; itemId?: string };
    const body = envelope.item ?? (envelope as ItemPayloadBody);
    const itemType = body.type;
    const itemId = stringOrNull(body.id) ?? stringOrNull(envelope.itemId) ?? null;
    if (!itemId || !itemType) return { changed: false, completed: false, itemId: "" };
    const mappedKind = mapItemTypeToKind(itemType);
    const kind = mappedKind === "toolCall" && typeof body.server === "string"
      ? "mcpToolCall"
      : mappedKind;
    if (kind === null) return { changed: false, completed: false, itemId: "" };
    const item = ensureItem(state, event.threadId, itemId, kind, ts);
    item.parentToolCallId = body.parentToolCallId ?? null;
    applyStartedBody(item, body);
    item.lastEventAt = ts;
    enforceTextCap(item, opts.maxDeltaBytesPerItem);
    return { changed: true, completed: false, itemId };
  }

  // ─── item/completed ──────────────────────────────────────────────
  if (type === "item/completed") {
    const body = asObject(payload) as { item?: ItemPayloadBody; itemId?: string };
    const raw = (body.item ?? null) as ItemPayloadBody | null;
    const fallback = body as ItemPayloadBody;
    const id = stringOrNull(raw?.id) ?? stringOrNull(fallback.id) ?? stringOrNull(body.itemId) ?? null;
    if (!id) return { changed: false, completed: false, itemId: "" };
    const completedBody = raw ?? fallback;
    const itemType = stringOrNull(completedBody.type) ?? null;
    const mappedKind = itemType ? mapItemTypeToKind(itemType) : null;
    const kindFromType = mappedKind === "toolCall" && typeof completedBody.server === "string"
      ? "mcpToolCall"
      : mappedKind;
    // If we already track this item, use its existing kind. Otherwise
    // pick the kind from the completed payload if we recognise it.
    const existing = state.items[id];
    const item =
      existing ??
      (kindFromType
        ? ensureItem(state, event.threadId, id, kindFromType, ts)
        : state.items[id]);
    if (!item) return { changed: false, completed: false, itemId: "" };
    const becameCompleted = !item.completed;
    applyCompletedBody(item, raw ?? fallback);
    item.lastEventAt = ts;
    if (!item.completedAt) item.completedAt = ts;
    enforceTextCap(item, opts.maxDeltaBytesPerItem);
    return { changed: true, completed: becameCompleted, itemId: id };
  }

  // ─── Reasoning deltas ───────────────────────────────────────────
  if (type === "item/reasoning/textDelta" || type === "item/reasoning/summaryTextDelta") {
    const body = asObject(payload) as DeltaPayloadBody;
    const itemId = stringOrNull(body.itemId);
    if (!itemId) return { changed: false, completed: false, itemId: "" };
    const item = ensureItem(state, event.threadId, itemId, "reasoning", ts);
    if (item.kind !== "reasoning") return { changed: false, completed: false, itemId: "" };
    const chunk = body.delta ?? "";
    if (type === "item/reasoning/textDelta") {
      const available = Math.max(0, opts.maxDeltaBytesPerItem - byteLength(item.summary));
      const result = appendCapped(item.content, chunk, available);
      item.content = result.value;
      if (result.truncated) item.truncated = true;
    } else {
      const available = Math.max(0, opts.maxDeltaBytesPerItem - byteLength(item.content));
      const result = appendCapped(item.summary, chunk, available);
      item.summary = result.value;
      if (result.truncated) item.truncated = true;
    }
    item.lastEventAt = ts;
    refreshByteLength(item);
    return { changed: true, completed: false, itemId };
  }

  // ─── Command execution deltas ───────────────────────────────────
  if (type === "item/commandExecution/outputDelta") {
    const body = asObject(payload) as DeltaPayloadBody;
    const itemId = stringOrNull(body.itemId);
    if (!itemId) return { changed: false, completed: false, itemId: "" };
    const item = ensureItem(state, event.threadId, itemId, "commandExecution", ts);
    if (item.kind !== "commandExecution") return { changed: false, completed: false, itemId: "" };
    const chunk = body.delta ?? "";
    if (body.reset === true) {
      item.aggregatedOutput = "";
    }
    const result = appendCapped(item.aggregatedOutput, chunk, opts.maxDeltaBytesPerItem);
    item.aggregatedOutput = result.value;
    if (result.truncated) item.truncated = true;
    item.lastEventAt = ts;
    refreshByteLength(item);
    return { changed: true, completed: false, itemId };
  }

  // ─── File change deltas ─────────────────────────────────────────
  if (type === "item/fileChange/outputDelta") {
    const body = asObject(payload) as DeltaPayloadBody;
    const itemId = stringOrNull(body.itemId);
    if (!itemId) return { changed: false, completed: false, itemId: "" };
    const item = ensureItem(state, event.threadId, itemId, "fileChange", ts);
    if (item.kind !== "fileChange") return { changed: false, completed: false, itemId: "" };
    const chunk = body.delta ?? "";
    const result = appendCapped(item.diff, chunk, opts.maxDeltaBytesPerItem);
    item.diff = result.value;
    if (result.truncated) item.truncated = true;
    item.lastEventAt = ts;
    refreshByteLength(item);
    return { changed: true, completed: false, itemId };
  }

  // ─── MCP tool call progress ─────────────────────────────────────
  if (type === "item/mcpToolCall/progress") {
    const body = asObject(payload) as DeltaPayloadBody;
    const itemId = stringOrNull(body.itemId);
    if (!itemId) return { changed: false, completed: false, itemId: "" };
    const item = ensureItem(state, event.threadId, itemId, "mcpToolCall", ts);
    if (item.kind !== "mcpToolCall") return { changed: false, completed: false, itemId: "" };
    const progress = body.progress;
    if (progress && typeof progress === "object") {
      if (typeof progress.current === "number") item.progressCurrent = progress.current;
      if (typeof progress.total === "number") item.progressTotal = progress.total;
      if (typeof progress.message === "string") item.message = progress.message;
    }
    if (typeof body.message === "string") item.message = body.message;
    item.lastEventAt = ts;
    refreshByteLength(item);
    return { changed: true, completed: false, itemId };
  }

  // ─── Tool call progress ─────────────────────────────────────────
  if (type === "item/toolCall/progress") {
    const body = asObject(payload) as DeltaPayloadBody;
    const itemId = stringOrNull(body.itemId);
    if (!itemId) return { changed: false, completed: false, itemId: "" };
    const item = ensureItem(state, event.threadId, itemId, "toolCall", ts);
    if (item.kind !== "toolCall") return { changed: false, completed: false, itemId: "" };
    const progress = body.progress;
    if (progress && typeof progress === "object") {
      if (typeof progress.current === "number") item.progressCurrent = progress.current;
      if (typeof progress.total === "number") item.progressTotal = progress.total;
      if (typeof progress.message === "string") item.message = progress.message;
    }
    if (typeof body.message === "string") item.message = body.message;
    item.lastEventAt = ts;
    refreshByteLength(item);
    return { changed: true, completed: false, itemId };
  }

  // ─── Background task progress ───────────────────────────────────
  if (type === "item/backgroundTask/progress") {
    const body = asObject(payload) as BackgroundTaskProgressBody;
    const item = (body.item ?? null) as ItemPayloadBody | null;
    const itemId = stringOrNull(item?.id) ?? stringOrNull(body.itemId);
    if (!itemId) return { changed: false, completed: false, itemId: "" };
    const live = ensureItem(state, event.threadId, itemId, "backgroundTask", ts);
    if (live.kind !== "backgroundTask") return { changed: false, completed: false, itemId: "" };
    if (typeof item?.description === "string" && !live.description) {
      live.description = item.description;
    }
    if (typeof item?.taskType === "string" && !live.taskType) {
      live.taskType = item.taskType;
    }
    if (typeof item?.taskStatus === "string") {
      live.taskStatus = backgroundTaskStatusOr(item.taskStatus);
    }
    if (typeof item?.workflowName === "string" && !live.workflowSummary) {
      live.workflowSummary = item.workflowName;
    }
    const progress = body.progress;
    if (typeof progress === "number") {
      live.progress = progress;
      pushNewest(live.progressHistory, progress, 32);
    }
    live.lastEventAt = ts;
    refreshByteLength(live);
    return { changed: true, completed: false, itemId };
  }

  // ─── Background task completed (terminal, separate channel) ─────
  if (type === "item/backgroundTask/completed") {
    const body = asObject(payload) as BackgroundTaskCompletedBody;
    const item = (body.item ?? null) as ItemPayloadBody | null;
    const itemId = stringOrNull(item?.id) ?? stringOrNull(body.itemId);
    if (!itemId) return { changed: false, completed: false, itemId: "" };
    const live = ensureItem(state, event.threadId, itemId, "backgroundTask", ts);
    if (live.kind !== "backgroundTask") return { changed: false, completed: false, itemId: "" };
    if (typeof item?.description === "string" && !live.description) {
      live.description = item.description;
    }
    if (typeof item?.taskType === "string" && !live.taskType) {
      live.taskType = item.taskType;
    }
    if (typeof item?.taskStatus === "string") {
      live.taskStatus = backgroundTaskStatusOr(item.taskStatus);
    }
    if (typeof item?.error === "string") {
      live.taskStatus = "failed";
    }
    if (typeof item?.workflowName === "string" && !live.workflowSummary) {
      live.workflowSummary = item.workflowName;
    }
    const becameCompleted = !live.completed;
    live.completed = true;
    live.status = itemStatusOr(item?.status ?? body.status ?? "completed") ?? "completed";
    live.lastEventAt = ts;
    if (!live.completedAt) live.completedAt = ts;
    refreshByteLength(live);
    return { changed: true, completed: becameCompleted, itemId };
  }

  return { changed: false, completed: false, itemId: "" };
}

function mapItemTypeToKind(itemType: string): LiveItemKind | null {
  switch (itemType) {
    case "reasoning":
      return "reasoning";
    case "commandExecution":
      return "commandExecution";
    case "fileChange":
      return "fileChange";
    case "toolCall":
      return "toolCall";
    case "mcpToolCall":
      return "mcpToolCall";
    case "backgroundTask":
      return "backgroundTask";
    default:
      return null;
  }
}

function applyStartedBody(item: LiveItem, body: ItemPayloadBody): void {
  switch (item.kind) {
    case "reasoning": {
      const content = Array.isArray(body.content) ? body.content.join("") : "";
      const summary = Array.isArray(body.summary) ? body.summary.join("") : "";
      if (content) item.content = content;
      if (summary) item.summary = summary;
      return;
    }
    case "commandExecution": {
      if (typeof body.command === "string") item.command = body.command;
      if (typeof body.cwd === "string") item.cwd = body.cwd;
      const status = itemStatusOr(body.status ?? null);
      if (status) item.status = status;
      if (typeof body.aggregatedOutput === "string") {
        item.aggregatedOutput = body.aggregatedOutput;
      }
      return;
    }
    case "fileChange": {
      // File-change started payloads don't typically carry diffs; the
      // stream comes via outputDelta. Nothing to copy here.
      const status = itemStatusOr(body.status ?? null);
      if (status) item.status = status;
      return;
    }
    case "toolCall": {
      if (typeof body.tool === "string") item.tool = body.tool;
      return;
    }
    case "mcpToolCall": {
      if (typeof body.tool === "string") item.tool = body.tool;
      if (typeof body.server === "string") item.server = body.server;
      return;
    }
    case "backgroundTask": {
      if (typeof body.description === "string") item.description = body.description;
      if (typeof body.taskType === "string") item.taskType = body.taskType;
      if (typeof body.taskStatus === "string") {
        item.taskStatus = backgroundTaskStatusOr(body.taskStatus);
      }
      if (typeof body.status === "string") {
        item.status = itemStatusOr(body.status);
      }
      if (typeof body.workflowName === "string") item.workflowSummary = body.workflowName;
      if (typeof body.summary === "string") item.workflowSummary = body.summary;
      return;
    }
  }
}

function applyCompletedBody(item: LiveItem, body: ItemPayloadBody): void {
  item.completed = true;
  const status = itemStatusOr(body.status ?? null);
  if (status) item.status = status;
  switch (item.kind) {
    case "reasoning": {
      const content = Array.isArray(body.content) ? body.content.join("") : "";
      const summary = Array.isArray(body.summary) ? body.summary.join("") : "";
      // Some providers intentionally complete reasoning with empty arrays.
      // Never erase deltas already captured by the live surface.
      if (content || !item.content) item.content = content;
      if (summary || !item.summary) item.summary = summary;
      return;
    }
    case "commandExecution": {
      if (typeof body.command === "string") item.command = body.command;
      if (typeof body.cwd === "string") item.cwd = body.cwd;
      if (typeof body.aggregatedOutput === "string") item.aggregatedOutput = body.aggregatedOutput;
      if (typeof body.exitCode === "number") item.exitCode = body.exitCode;
      return;
    }
    case "fileChange": {
      if (!item.diff && Array.isArray(body.changes)) {
        item.diff = body.changes
          .map((change) => change.diff ?? `${change.kind ?? "change"} ${change.path ?? ""}`)
          .join("\n");
      }
      return;
    }
    case "toolCall": {
      if (typeof body.tool === "string") item.tool = body.tool;
      return;
    }
    case "mcpToolCall": {
      if (typeof body.tool === "string") item.tool = body.tool;
      if (typeof body.server === "string") item.server = body.server;
      return;
    }
    case "backgroundTask": {
      if (typeof body.description === "string") item.description = body.description;
      if (typeof body.taskType === "string") item.taskType = body.taskType;
      if (typeof body.taskStatus === "string") {
        item.taskStatus = backgroundTaskStatusOr(body.taskStatus);
      }
      if (typeof body.summary === "string") item.workflowSummary = body.summary;
      if (typeof body.error === "string") item.taskStatus = "failed";
      return;
    }
  }
}

// ─── Snapshot serialization ────────────────────────────────────────────

export interface ThreadSnapshot {
  threadId: string;
  itemCount: number;
  inFlightCount: number;
  items: LiveItem[];
  updatedAt: string;
}

export interface CodexLiveSnapshot {
  threads: ThreadSnapshot[];
  updatedAt: string;
}

export function snapshotOf(
  threads: Map<string, ThreadLiveState>,
  nowIso: () => string = () => new Date().toISOString(),
): CodexLiveSnapshot {
  const out: ThreadSnapshot[] = [];
  for (const [threadId, state] of threads) {
    const items: LiveItem[] = [];
    let inFlight = 0;
    for (const itemId of state.order) {
      const item = state.items[itemId];
      if (!item) continue;
      items.push(item);
      if (!item.completed) inFlight += 1;
    }
    out.push({
      threadId,
      itemCount: items.length,
      inFlightCount: inFlight,
      items,
      updatedAt: nowIso(),
    });
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return { threads: out, updatedAt: nowIso() };
}

/**
 * Detect "ghost" items — ones that have been streaming for an unusably long
 * time without any kind of completion. The bridge ring buffer may have
 * evicted earlier events, so a renderer should treat these as stale and
 * retire them rather than wait forever for `item/completed`. The cutoff is
 * MINUTE_INACTIVITY_FOR_GHOST after the last delta arrived.
 */
export function isGhostItem(item: LiveItem, nowMs: number): boolean {
  if (item.completed) return false;
  const lastMs = new Date(item.lastEventAt).getTime();
  if (!Number.isFinite(lastMs)) return false;
  return nowMs - lastMs > MINUTE_INACTIVITY_FOR_GHOST;
}

// ─── Default settings wrappers ─────────────────────────────────────────

export interface CodexLiveLimits {
  maxItemsPerThread: number;
  maxDeltaBytesPerItem: number;
}

/** The plugin id we forward RPC/poll to. Owned by DOCK-4. */
export const BRIDGE_PLUGIN_ID = "codex-events-bridge";

/** Display labels used by the frontend rendering each item kind. */
export const KIND_LABEL = {
  reasoning: "Reasoning",
  commandExecution: "Command",
  fileChange: "File change",
  toolCall: "Tool call",
  mcpToolCall: "MCP tool",
  backgroundTask: "Background task",
} as const satisfies Record<LiveItemKind, string>;

/** Time after which an in-flight (non-completed) item is considered "ghost"
 *  by the renderer (e.g. ring buffer eviction dropped item/started), so
 *  the front-end can retire it without explicit completion. */
export const MINUTE_INACTIVITY_FOR_GHOST = 5 * 60_000;

/** Auto-clear TTL for completed items. Per the spec. */
export const COMPLETED_CLEAR_DELAY_MS = 60_000;

/** Default poll cadence against the bridge. */
export const DEFAULT_POLL_INTERVAL_MS = 500;

export function limitsFromSettings(values: {
  maxItemsPerThread?: string | number;
  maxDeltaBytesPerItem?: string | number;
}): CodexLiveLimits {
  const capItems = Number.parseInt(String(values.maxItemsPerThread ?? "12"), 10) || 12;
  const capBytes =
    Number.parseInt(String(values.maxDeltaBytesPerItem ?? `${DEFAULT_MAX_DELTA_BYTES_PER_ITEM}`), 10) ||
    DEFAULT_MAX_DELTA_BYTES_PER_ITEM;
  return {
    maxItemsPerThread: Math.max(1, Math.min(50, capItems)),
    maxDeltaBytesPerItem: Math.max(4096, capBytes),
  };
}
