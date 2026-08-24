// Focused smoke test for the bb-plugin-codex-live reducer.
// Exercises every event kind the bridge forwards, plus the 60-second
// auto-clear schedule path and the per-item byte cap.
//
// Run: tsx packages/bb-plugin-codex-live/lib/codex-live.test.ts

import { strict as assert } from "node:assert";
import {
  applyBridgeEvents,
  appendCapped,
  COMPLETED_CLEAR_DELAY_MS,
  DEFAULT_MAX_DELTA_BYTES_PER_ITEM,
  emptyThreadState,
  isGhostItem,
  limitsFromSettings,
  MINUTE_INACTIVITY_FOR_GHOST,
  snapshotOf,
  type CodexBridgeEvent,
  type LiveItem,
} from "./codex-live";

function event(
  type: string,
  payload: unknown,
  threadId: string,
  seq: number,
  ts: string,
): CodexBridgeEvent {
  return {
    seq,
    ts,
    type,
    category: "item",
    threadId,
    providerThreadId: "prov-1",
    payload,
  };
}

function baseOpts(nowMs: () => number) {
  return {
    maxItemsPerThread: 12,
    maxDeltaBytesPerItem: DEFAULT_MAX_DELTA_BYTES_PER_ITEM,
    nowMs,
    clearDelayMs: 60_000,
    scheduleAutoClear: () => {},
  };
}

// ─── Test: appendCapped tail behavior on overflow ──────────────────────

(function testAppendCappedTail() {
  const cap = 8;
  const result = appendCapped("hello ", "world", cap);
  assert.equal(result.truncated, true, "should be marked truncated");
  assert.ok(result.bytes <= cap, `bytes ${result.bytes} <= cap ${cap}`);
  // Tail should be a suffix of "hello world"
  assert.ok(
    "hello world".endsWith(result.value),
    `tail ${result.value} should be suffix of "hello world"`,
  );
  console.log("✓ appendCapped keeps a tail within the byte cap");
})();

// ─── Test: appendCapped does not begin the tail on a low surrogate ─────

(function testAppendCappedSurrogateSafe() {
  const cap = 16;
  // 4-byte UTF-8 emoji: "😀" is 2 UTF-16 code units, 4 bytes UTF-8.
  const input = "a".repeat(20) + "😀";
  const result = appendCapped("", input, cap);
  // The implementation bumps `lo` past a low surrogate at the start, so
  // the tail must never begin on a low surrogate (a stranded low
  // surrogate would corrupt the rendered string).
  if (result.value.length > 0) {
    const first = result.value.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) {
      throw new Error("appendCapped left a stranded low surrogate at the start");
    }
  }
  // Also: every high surrogate (0xD800–0xDBFF) in the tail must be
  // immediately followed by its low surrogate.
  for (let i = 0; i < result.value.length; i += 1) {
    const code = result.value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = result.value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error("appendCapped left a stranded high surrogate");
      }
      i += 1; // skip the low half
    }
  }
  console.log("✓ appendCapped keeps UTF-16 surrogate pairs whole");
})();

// ─── Test: reasoning textDelta coalesces character-by-character ───────

(function testReasoningDeltas() {
  const threads = new Map();
  const threadId = "thr_1";
  const itemId = "it_1";
  const startedAt = "2026-01-01T00:00:00.000Z";

  // item/started
  applyBridgeEvents(
    threads,
    [
      event(
        "item/started",
        { item: { id: itemId, type: "reasoning" } },
        threadId,
        1,
        startedAt,
      ),
    ],
    baseOpts(() => 0),
  );
  const before = threads.get(threadId)!.items[itemId]!;
  assert.equal(before.kind, "reasoning");
  assert.equal(before.content, "");

  // 5 single-character deltas — verify character-by-character coalescing.
  for (let i = 0; i < 5; i += 1) {
    const before = threads.get(threadId)!.items[itemId];
    const previous = before && before.kind === "reasoning" ? before.content : "";
    applyBridgeEvents(
      threads,
      [
        event(
          "item/reasoning/textDelta",
          { itemId, delta: String.fromCharCode(97 + i) },
          threadId,
          2 + i,
          "2026-01-01T00:00:00.010Z",
        ),
      ],
      baseOpts(() => 0),
    );
    const item = threads.get(threadId)!.items[itemId]!;
    assert.equal(item.kind, "reasoning");
    if (item.kind === "reasoning") {
      const expected = previous + String.fromCharCode(97 + i);
      assert.equal(item.content, expected, `delta ${i} → expected ${expected}`);
    }
  }

  // item/completed — should NOT clear the content; deltas must remain.
  applyBridgeEvents(
    threads,
    [
      event(
        "item/completed",
        { item: { id: itemId, type: "reasoning" } },
        threadId,
        7,
        "2026-01-01T00:00:00.100Z",
      ),
    ],
    baseOpts(() => 0),
  );
  const completed = threads.get(threadId)!.items[itemId]!;
  assert.equal(completed.completed, true);
  if (completed.kind === "reasoning") {
    assert.equal(completed.content, "abcde", "completed preserves deltas");
  }
  console.log("✓ reasoning textDelta coalesces character-by-character");
})();

// ─── Test: command outputDelta streaming ───────────────────────────────

(function testCommandExecutionStreaming() {
  const threads = new Map();
  const threadId = "thr_2";
  const itemId = "it_2";
  const startedAt = "2026-01-01T00:00:00.000Z";

  applyBridgeEvents(
    threads,
    [
      event(
        "item/started",
        {
          item: {
            id: itemId,
            type: "commandExecution",
            command: "echo hello",
            cwd: "/tmp",
            status: "pending",
          },
        },
        threadId,
        1,
        startedAt,
      ),
    ],
    baseOpts(() => 0),
  );

  const lines = ["line1\n", "line2\n", "line3\n"];
  for (let i = 0; i < lines.length; i += 1) {
    applyBridgeEvents(
      threads,
      [
        event(
          "item/commandExecution/outputDelta",
          { itemId, delta: lines[i] },
          threadId,
          2 + i,
          "2026-01-01T00:00:00.010Z",
        ),
      ],
      baseOpts(() => 0),
    );
  }

  const item = threads.get(threadId)!.items[itemId]!;
  assert.equal(item.kind, "commandExecution");
  if (item.kind === "commandExecution") {
    assert.equal(item.command, "echo hello");
    assert.equal(item.cwd, "/tmp");
    assert.equal(item.aggregatedOutput, "line1\nline2\nline3\n");
  }

  applyBridgeEvents(
    threads,
    [
      event(
        "item/completed",
        {
          item: {
            id: itemId,
            type: "commandExecution",
            status: "completed",
            exitCode: 0,
          },
        },
        threadId,
        10,
        "2026-01-01T00:00:00.500Z",
      ),
    ],
    baseOpts(() => 0),
  );

  const completed = threads.get(threadId)!.items[itemId]!;
  assert.equal(completed.completed, true);
  if (completed.kind === "commandExecution") {
    assert.equal(completed.exitCode, 0);
    assert.equal(completed.aggregatedOutput, "line1\nline2\nline3\n");
  }
  console.log("✓ commandExecution outputDelta streams + preserves on completion");
})();

// ─── Test: fileChange outputDelta streaming ───────────────────────────

(function testFileChangeStreaming() {
  const threads = new Map();
  const threadId = "thr_3";
  const itemId = "it_3";
  const startedAt = "2026-01-01T00:00:00.000Z";

  applyBridgeEvents(
    threads,
    [
      event(
        "item/started",
        { item: { id: itemId, type: "fileChange" } },
        threadId,
        1,
        startedAt,
      ),
    ],
    baseOpts(() => 0),
  );

  const hunks = ["@@ -1 +1 @@\n", "-old\n", "+new\n", "@@ -10 +10 @@\n"];
  for (let i = 0; i < hunks.length; i += 1) {
    applyBridgeEvents(
      threads,
      [
        event(
          "item/fileChange/outputDelta",
          { itemId, delta: hunks[i] },
          threadId,
          2 + i,
          "2026-01-01T00:00:00.010Z",
        ),
      ],
      baseOpts(() => 0),
    );
  }

  const item = threads.get(threadId)!.items[itemId]!;
  assert.equal(item.kind, "fileChange");
  if (item.kind === "fileChange") {
    assert.equal(item.diff, hunks.join(""));
  }
  console.log("✓ fileChange outputDelta coalesces raw diff hunks");
})();

// ─── Test: toolCall + mcpToolCall progress (message-only) ──────────────

(function testProgressMessageOnly() {
  const threads = new Map();
  const threadId = "thr_4";
  const toolId = "it_tool";
  const mcpId = "it_mcp";
  const startedAt = "2026-01-01T00:00:00.000Z";

  applyBridgeEvents(
    threads,
    [
      event(
        "item/started",
        { item: { id: toolId, type: "toolCall", tool: "list_files" } },
        threadId,
        1,
        startedAt,
      ),
      event(
        "item/started",
        {
          item: { id: mcpId, type: "mcpToolCall", tool: "graph_search", server: "graph" },
        },
        threadId,
        2,
        startedAt,
      ),
    ],
    baseOpts(() => 0),
  );

  // toolCall progress: { current, total, message }
  applyBridgeEvents(
    threads,
    [
      event(
        "item/toolCall/progress",
        { itemId: toolId, progress: { current: 3, total: 10, message: "scanning" } },
        threadId,
        3,
        "2026-01-01T00:00:00.010Z",
      ),
    ],
    baseOpts(() => 0),
  );

  // mcpToolCall progress: message-only (no current/total)
  applyBridgeEvents(
    threads,
    [
      event(
        "item/mcpToolCall/progress",
        { itemId: mcpId, progress: { message: "querying graph" } },
        threadId,
        4,
        "2026-01-01T00:00:00.020Z",
      ),
    ],
    baseOpts(() => 0),
  );

  const toolItem = threads.get(threadId)!.items[toolId]!;
  assert.equal(toolItem.kind, "toolCall");
  if (toolItem.kind === "toolCall") {
    assert.equal(toolItem.tool, "list_files");
    assert.equal(toolItem.progressCurrent, 3);
    assert.equal(toolItem.progressTotal, 10);
    assert.equal(toolItem.message, "scanning");
  }

  const mcpItem = threads.get(threadId)!.items[mcpId]!;
  assert.equal(mcpItem.kind, "mcpToolCall");
  if (mcpItem.kind === "mcpToolCall") {
    assert.equal(mcpItem.server, "graph");
    assert.equal(mcpItem.tool, "graph_search");
    assert.equal(mcpItem.message, "querying graph");
    // current/total remain null because the message was message-only.
    assert.equal(mcpItem.progressCurrent, null);
    assert.equal(mcpItem.progressTotal, null);
  }
  console.log("✓ toolCall + mcpToolCall progress respects message-only shape");
})();

// ─── Test: backgroundTask progress + completed terminal ────────────────

(function testBackgroundTaskTerminal() {
  const threads = new Map();
  const threadId = "thr_5";
  const itemId = "it_5";
  const startedAt = "2026-01-01T00:00:00.000Z";

  applyBridgeEvents(
    threads,
    [
      event(
        "item/started",
        {
          item: {
            id: itemId,
            type: "backgroundTask",
            description: "index files",
            taskType: "indexer",
            taskStatus: "running",
          },
        },
        threadId,
        1,
        startedAt,
      ),
      event(
        "item/backgroundTask/progress",
        { item: { id: itemId, taskType: "indexer" }, progress: 0.5 },
        threadId,
        2,
        "2026-01-01T00:00:00.010Z",
      ),
      event(
        "item/backgroundTask/completed",
        {
          item: {
            id: itemId,
            taskType: "indexer",
            taskStatus: "completed",
            workflowName: "indexed 1234 files",
          },
          status: "completed",
        },
        threadId,
        3,
        "2026-01-01T00:00:00.500Z",
      ),
    ],
    baseOpts(() => 0),
  );

  const item = threads.get(threadId)!.items[itemId]!;
  assert.equal(item.kind, "backgroundTask");
  assert.equal(item.completed, true);
  if (item.kind === "backgroundTask") {
    assert.equal(item.description, "index files");
    assert.equal(item.taskType, "indexer");
    assert.equal(item.taskStatus, "completed");
    assert.equal(item.workflowSummary, "indexed 1234 files");
    assert.equal(item.progress, 0.5);
    assert.deepEqual(item.progressHistory, [0.5]);
    assert.equal(item.status, "completed");
  }
  console.log("✓ backgroundTask progress + completed captures workflow summary");
})();

// ─── Test: 60s auto-clear delay constant matches spec ─────────────────

(function testClearDelayConstant() {
  assert.equal(COMPLETED_CLEAR_DELAY_MS, 60_000);
  console.log("✓ COMPLETED_CLEAR_DELAY_MS is 60,000ms (60 seconds)");
})();

// ─── Test: limitsFromSettings clamps to safe bounds ───────────────────

(function testLimitsFromSettings() {
  const limits = limitsFromSettings({
    maxItemsPerThread: "500",
    maxDeltaBytesPerItem: "100",
  });
  assert.equal(limits.maxItemsPerThread, 50, "maxItemsPerThread clamped to 50");
  assert.equal(limits.maxDeltaBytesPerItem, 4096, "maxDeltaBytesPerItem floored to 4096");
  console.log("✓ limitsFromSettings clamps over/under values");
})();

// ─── Test: snapshotOf renders in-flight + completed counts ────────────

(function testSnapshot() {
  const threads = new Map();
  const threadId = "thr_6";

  applyBridgeEvents(
    threads,
    [
      event("item/started", { item: { id: "a", type: "reasoning" } }, threadId, 1, "2026-01-01T00:00:00.000Z"),
      event("item/started", { item: { id: "b", type: "commandExecution" } }, threadId, 2, "2026-01-01T00:00:00.001Z"),
      event("item/completed", { item: { id: "a", type: "reasoning" } }, threadId, 3, "2026-01-01T00:00:00.010Z"),
    ],
    baseOpts(() => 0),
  );

  const snap = snapshotOf(threads);
  assert.equal(snap.threads.length, 1);
  const t = snap.threads[0]!;
  assert.equal(t.itemCount, 2);
  assert.equal(t.inFlightCount, 1, "one in-flight, one completed");
  console.log("✓ snapshotOf reports in-flight vs completed counts");
})();

// ─── Test: isGhostItem flags stuck non-completed items ─────────────────

(function testGhostItem() {
  const state = emptyThreadState();
  const item = state.items["g"] = {
    itemId: "g",
    threadId: "thr_7",
    parentToolCallId: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    lastEventAt: "2026-01-01T00:00:00.000Z",
    completed: false,
    completedAt: null,
    status: null,
    byteLength: 0,
    truncated: false,
    kind: "reasoning",
    content: "x",
    summary: "",
  } as LiveItem;
  const stale = new Date(item.lastEventAt).getTime() + 6 * 60_000;
  assert.equal(isGhostItem(item, stale), true, "stuck item flagged ghost");
  item.completed = true;
  assert.equal(isGhostItem(item, stale), false, "completed item is never ghost");
  console.log("✓ isGhostItem detects stuck non-completed items");
})();

// ─── Test: appendCapped defaults ──────────────────────────────────────

(function testDefaultCap() {
  assert.equal(DEFAULT_MAX_DELTA_BYTES_PER_ITEM, 256 * 1024);
  console.log("✓ default 256 KiB per-item cap matches spec");
})();

// ─── Test: ghost cutoff constant is 5 minutes ─────────────────────────

(function testGhostCutoff() {
  assert.equal(MINUTE_INACTIVITY_FOR_GHOST, 5 * 60_000);
  console.log("✓ ghost cutoff is 5 minutes (300,000ms)");
})();

console.log("\nAll codex-live reducer smoke tests passed.");
