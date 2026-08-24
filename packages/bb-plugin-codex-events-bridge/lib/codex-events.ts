// Shared codex event taxonomy + channel mapping.
//
// Used by both server.ts (poll loop + RPC) and app.tsx (live event stream)
// so the bb.realtime channel naming stays in one place. Channel convention:
//   codex/<category>/<event>
// where <category> ∈ {thread, turn, item, account}. The SDK's "provider/" prefix
// is renamed to "account/" on the wire so downstream plugins filter on a stable
// vocabulary decoupled from internal provider namespaces.

export type CodexCategory = "thread" | "turn" | "item" | "account";

export type CodexEventType =
  | `thread/${string}`
  | `turn/${string}`
  | `item/${string}`
  | `provider/${string}`;

export const CODEX_THREAD_TYPES = [
  "thread/started",
  "thread/identity",
  "thread/name/updated",
  "thread/compacted",
  "thread/context/cleared",
  "thread/goal/updated",
  "thread/goal/cleared",
  "thread/tokenUsage/updated",
  "thread/contextWindowUsage/updated",
] as const;

export const CODEX_TURN_TYPES = [
  "turn/started",
  "turn/completed",
  "turn/input/accepted",
  "turn/plan/updated",
  "turn/diff/updated",
] as const;

export const CODEX_ITEM_TYPES = [
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/plan/delta",
  "item/mcpToolCall/progress",
  "item/toolCall/progress",
  "item/backgroundTask/progress",
  "item/backgroundTask/completed",
] as const;

export const CODEX_PROVIDER_TYPES = [
  "provider/error",
  "provider/rateLimits/updated",
  "provider/warning",
  "provider/modelFallback",
  "provider/unhandled",
] as const;

export const ALL_CODEX_TYPES = [
  ...CODEX_THREAD_TYPES,
  ...CODEX_TURN_TYPES,
  ...CODEX_ITEM_TYPES,
  ...CODEX_PROVIDER_TYPES,
] as const;

export type CodexType = (typeof ALL_CODEX_TYPES)[number];

export const CODEX_CATEGORIES: readonly CodexCategory[] = [
  "thread",
  "turn",
  "item",
  "account",
] as const;

export function categoryOf(type: string): CodexCategory | null {
  if (type.startsWith("thread/")) return "thread";
  if (type.startsWith("turn/")) return "turn";
  if (type.startsWith("item/")) return "item";
  if (type.startsWith("provider/")) return "account";
  return null;
}

export function typesForCategory(category: CodexCategory): readonly CodexType[] {
  switch (category) {
    case "thread":
      return CODEX_THREAD_TYPES;
    case "turn":
      return CODEX_TURN_TYPES;
    case "item":
      return CODEX_ITEM_TYPES;
    case "account":
      return CODEX_PROVIDER_TYPES;
  }
}

/**
 * Map a codex provider event type to the bb.realtime channel it should
 * publish on. Both vectors live under `codex/<category>/<tail>` so
 * useRealtime and the rpc `typePrefix` filter both walk the same names.
 */
export function rawTypeFromPayload(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const rawType = (payload as Record<string, unknown>).rawType;
  return typeof rawType === "string" && rawType.length > 0 ? rawType : null;
}

export function eventToChannel(type: string, payload?: unknown): string | null {
  if (type === "provider/unhandled") {
    const rawType = rawTypeFromPayload(payload);
    return rawType === null ? "codex/raw/unknown" : `codex/raw/${rawType}`;
  }
  const cat = categoryOf(type);
  if (cat === null) return null;
  if (cat === "account") {
    // Rename "provider/" to "account/" on the channel; backend taxonomy
    // stays SDK-shaped (bb.sdk.threads.events.list) and downstream consumers
    // filter on a stable, user-friendly name.
    const tail = type.slice("provider/".length);
    return `codex/account/${tail}`;
  }
  const tail = type.slice(`${cat}/`.length);
  return `codex/${cat}/${tail}`;
}

export function channelPrefixForCategory(category: CodexCategory): string {
  return `codex/${category}/`;
}

export function isCodexType(type: string): boolean {
  return categoryOf(type) !== null;
}

/**
 * Map `bb.sdk.threads.list` typePrefix values onto filterable channel prefixes.
 * Accepts either the SDK-style `provider/` or the chokepoint-style `account/`
 * prefix so downstream callers don't have to remember the rename.
 */
export function normaliseTypePrefix(typePrefix: string | undefined): string | undefined {
  if (!typePrefix) return undefined;
  if (typePrefix.startsWith("account/")) return `codex/${typePrefix}`;
  if (typePrefix.startsWith("provider/")) return `codex/account/${typePrefix.slice("provider/".length)}`;
  if (typePrefix.startsWith("codex/")) return typePrefix;
  if (typePrefix.startsWith("thread/") || typePrefix.startsWith("turn/") || typePrefix.startsWith("item/")) {
    return `codex/${typePrefix}`;
  }
  return typePrefix;
}
