import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPACTION_CONTINUATION_TYPE,
  createCompactionContinuation,
  createEarlyCompactionContinuation,
  EARLY_COMPACTION_PERCENT,
  findAssistantBeforeCompaction,
  shouldCompactBeforeProvider,
} from "../extensions/compaction-continuation.js";

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
  assert.equal(EARLY_COMPACTION_PERCENT, 80);
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
