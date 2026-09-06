import assert from "node:assert/strict";
import test from "node:test";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COMPACTION_CONTINUATION_TYPE,
  createCompactionContinuation,
  createEarlyCompactionContinuation,
  DEFAULT_COMPACTION_CONFIG,
  findAssistantBeforeCompaction,
  loadCompactionConfig,
  shouldCompactBeforeProvider,
} from "../extensions/compaction-continuation.ts";

function branchWithAssistant(stopReason = "error") {
  return [
    {
      type: "message",
      id: "assistant-1",
      message: {
        role: "assistant",
        stopReason,
        errorMessage: stopReason === "error" ? "stream failed" : undefined,
        content: [],
      },
    },
    {
      type: "custom",
      id: "metadata-1",
      customType: "dashboard-meta",
      data: {},
    },
    {
      type: "compaction",
      id: "compaction-1",
      summary: "summary",
    },
  ];
}

const thresholdEvent = {
  reason: "threshold",
  willRetry: false,
  compactionEntry: { id: "compaction-1" },
};

const activeState = {
  enabled: true,
  agentActive: true,
  hasPendingMessages: false,
};

test("starts early compaction before the next oversized provider request", () => {
  assert.equal(
    shouldCompactBeforeProvider(
      { tokens: 300_000, contextWindow: 372_000, percent: 80.6 },
      {
        enabled: true,
        agentActive: true,
        compactionInFlight: false,
        hasPendingMessages: false,
      },
    ),
    true,
  );
  assert.equal(DEFAULT_COMPACTION_CONFIG.triggerPercent, 80);
});

test("caps the trigger at an absolute token ceiling on million-token windows", () => {
  const state = {
    enabled: true,
    agentActive: true,
    compactionInFlight: false,
    hasPendingMessages: false,
  };

  assert.equal(DEFAULT_COMPACTION_CONFIG.maxTokens, 300_000);
  assert.equal(
    shouldCompactBeforeProvider(
      { tokens: 300_000, contextWindow: 872_000, percent: 34.4 },
      state,
    ),
    true,
  );
  assert.equal(
    shouldCompactBeforeProvider(
      { tokens: 299_000, contextWindow: 872_000, percent: 34.3 },
      state,
    ),
    false,
  );
  // Windows below ~375K still trigger on the percentage, not the ceiling.
  assert.equal(
    shouldCompactBeforeProvider(
      { tokens: 297_600, contextWindow: 372_000, percent: 80 },
      state,
    ),
    true,
  );
  // An explicit setting overrides both defaults.
  assert.equal(
    shouldCompactBeforeProvider(
      { tokens: 500_000, contextWindow: 872_000, percent: 57.3 },
      { ...state, triggerPercent: 90, maxTokens: 600_000 },
    ),
    false,
  );
});

function withAgentDir(files, run) {
  const dir = mkdtempSync(join(tmpdir(), "pi-choco-chips-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content, "utf8");
    }
    return run();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("reads the compaction trigger from pi-choco-setting.json", () => {
  const loaded = withAgentDir(
    {
      "pi-choco-setting.json": JSON.stringify({
        version: 1,
        compaction: { maxTokens: 450_000 },
      }),
    },
    loadCompactionConfig,
  );

  assert.equal(loaded.error, undefined);
  // The user file overrides only maxTokens; triggerPercent keeps the default.
  assert.deepEqual(loaded.config, { triggerPercent: 80, maxTokens: 450_000 });
});

test("falls back to the bundled defaults with no user setting file", () => {
  const loaded = withAgentDir({}, loadCompactionConfig);

  assert.equal(loaded.error, undefined);
  assert.deepEqual(loaded.config, DEFAULT_COMPACTION_CONFIG);
});

test("reports an invalid compaction value and keeps the other field", () => {
  const loaded = withAgentDir(
    {
      "pi-choco-setting.json": JSON.stringify({
        version: 1,
        compaction: { triggerPercent: 150, maxTokens: 250_000 },
      }),
    },
    loadCompactionConfig,
  );

  assert.match(loaded.error, /triggerPercent/);
  assert.deepEqual(loaded.config, { triggerPercent: 80, maxTokens: 250_000 });
});

test("does not overlap early compaction or race queued messages", () => {
  const usage = { tokens: 340_000, contextWindow: 372_000, percent: 91.4 };
  assert.equal(
    shouldCompactBeforeProvider(usage, {
      enabled: true,
      agentActive: true,
      compactionInFlight: true,
      hasPendingMessages: false,
    }),
    false,
  );
  assert.equal(
    shouldCompactBeforeProvider(usage, {
      enabled: true,
      agentActive: true,
      compactionInFlight: false,
      hasPendingMessages: true,
    }),
    false,
  );
});

test("builds a hidden continuation after early compaction", () => {
  const continuation = createEarlyCompactionContinuation(
    { tokens: 337_534, contextWindow: 372_000 },
    { tokensBefore: 363_355 },
  );

  assert.equal(continuation.message.customType, COMPACTION_CONTINUATION_TYPE);
  assert.equal(continuation.message.display, false);
  assert.match(continuation.message.content[0].text, /Continue the same active task/);
  assert.equal(continuation.message.details.reason, "pre-provider-threshold");
  assert.deepEqual(continuation.options, {
    triggerTurn: true,
    deliverAs: "followUp",
  });
});

test("finds the assistant immediately before a compaction across metadata", () => {
  const assistant = findAssistantBeforeCompaction(branchWithAssistant(), "compaction-1");

  assert.equal(assistant.id, "assistant-1");
});

test("queues one hidden follow-up after threshold compaction of an errored turn", () => {
  const continuation = createCompactionContinuation(
    thresholdEvent,
    branchWithAssistant(),
    activeState,
  );

  assert.ok(continuation);
  assert.equal(continuation.message.customType, COMPACTION_CONTINUATION_TYPE);
  assert.equal(continuation.message.display, false);
  assert.match(continuation.message.content[0].text, /Continue the same task/);
  assert.deepEqual(continuation.options, {
    triggerTurn: true,
    deliverAs: "followUp",
  });
  assert.equal(continuation.message.details.compactionEntryId, "compaction-1");
  assert.equal(
    continuation.message.details.interruptedAssistantEntryId,
    "assistant-1",
  );
});

test("does not continue a completed assistant response", () => {
  assert.equal(
    createCompactionContinuation(
      thresholdEvent,
      branchWithAssistant("stop"),
      activeState,
    ),
    null,
  );
});

test("does not duplicate Pi overflow recovery", () => {
  assert.equal(
    createCompactionContinuation(
      { ...thresholdEvent, reason: "overflow", willRetry: true },
      branchWithAssistant(),
      activeState,
    ),
    null,
  );
});

test("resumes a manually requested compaction after an assistant error", () => {
  assert.ok(
    createCompactionContinuation(
      { ...thresholdEvent, reason: "manual" },
      branchWithAssistant(),
      { ...activeState, agentActive: false },
    ),
  );
});

test("does not race an idle threshold compaction", () => {
  assert.equal(
    createCompactionContinuation(thresholdEvent, branchWithAssistant(), {
      ...activeState,
      agentActive: false,
    }),
    null,
  );
});

test("does not duplicate its own early-compaction continuation", () => {
  assert.equal(
    createCompactionContinuation(
      { ...thresholdEvent, reason: "manual" },
      branchWithAssistant(),
      { ...activeState, compactionInFlight: true },
    ),
    null,
  );
});

test("lets queued user messages resume the agent without an extra prompt", () => {
  assert.equal(
    createCompactionContinuation(thresholdEvent, branchWithAssistant(), {
      ...activeState,
      hasPendingMessages: true,
    }),
    null,
  );
});
