// The exact 42 codex-app-server notification methods classified as
// "unknown" or "noise" by the provider-codex host when DOCK-9 was defined.
// Unknown notifications can be persisted as provider/unhandled rows when
// showUnhandledProviderEvents is enabled. Noise notifications are catalogued
// here but may be consumed or dropped by the host before reaching the event DB.

export const UNHANDLED_TYPES = [
  "account/login/completed",
  "account/updated",
  "app/list/updated",
  "command/exec/outputDelta",
  "externalAgentConfig/import/completed",
  "fs/changed",
  "fuzzyFileSearch/sessionCompleted",
  "fuzzyFileSearch/sessionUpdated",
  "hook/completed",
  "hook/started",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/patchUpdated",
  "item/reasoning/summaryPartAdded",
  "mcpServer/oauthLogin/completed",
  "model/verification",
  "model/rerouted",
  "process/exited",
  "process/outputDelta",
  "thread/closed",
  "thread/realtime/closed",
  "thread/realtime/error",
  "thread/realtime/itemAdded",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/sdp",
  "thread/realtime/started",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted",
] as const;

export const NOISE_TYPES = [
  "item/autoApprovalReview/completed",
  "item/autoApprovalReview/started",
  "mcpServer/startupStatus/updated",
  "rawResponse/completed",
  "rawResponseItem/completed",
  "remoteControl/status/changed",
  "serverRequest/resolved",
  "skills/changed",
  "thread/archived",
  "thread/settings/updated",
  "thread/status/changed",
  "thread/unarchived",
  "turn/moderationMetadata",
] as const;

export const ALL_RAW_TYPES = [...UNHANDLED_TYPES, ...NOISE_TYPES] as const;

export type UnhandledType = (typeof UNHANDLED_TYPES)[number];
export type NoiseType = (typeof NOISE_TYPES)[number];
export type RawType = (typeof ALL_RAW_TYPES)[number];
export type RawClassification = "unhandled" | "noise";

export function isUnhandledType(value: string): value is UnhandledType {
  return (UNHANDLED_TYPES as readonly string[]).includes(value);
}

export function isNoiseType(value: string): value is NoiseType {
  return (NOISE_TYPES as readonly string[]).includes(value);
}

export function isKnownRawType(value: string): value is RawType {
  return isUnhandledType(value) || isNoiseType(value);
}

export function classifyRawType(value: string): RawClassification | "other" {
  if (isUnhandledType(value)) return "unhandled";
  if (isNoiseType(value)) return "noise";
  return "other";
}
