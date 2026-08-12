export const COMPACTION_CONTINUATION_TYPE =
  "pi-choco-chips.compaction-continuation";
export const EARLY_COMPACTION_PERCENT = 80;
export const EARLY_COMPACTION_INSTRUCTIONS =
  "Preserve the active task, completed work, pending tool results, exact next step, " +
  "and any files or commands needed to continue immediately after compaction.";

const CONTINUATION_PROMPT =
  "The previous assistant response ended with an error before the agent settled. " +
  "Automatic context compaction has now completed. Continue the same task from the " +
  "compaction summary and retained recent messages. Do not repeat completed work. " +
  "First assess whether the requested work is already complete; if it is, provide only " +
  "the concise final completion response and stop.";
const EARLY_CONTINUATION_PROMPT =
  "Pi compacted the context before the next provider request to avoid an oversized " +
  "prompt. Continue the same active task from the compaction summary and retained " +
  "messages. Do not repeat completed work or wait for another user message.";

export function findAssistantBeforeCompaction(branch, compactionEntryId) {
  const compactionIndex = branch.findIndex(
    (entry) => entry.type === "compaction" && entry.id === compactionEntryId,
  );
  const startIndex = compactionIndex >= 0 ? compactionIndex - 1 : branch.length - 1;

  for (let index = startIndex; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    return entry;
  }

  return undefined;
}

export function shouldCompactBeforeProvider(contextUsage, state = {}) {
  if (
    !state.enabled ||
    !state.agentActive ||
    state.compactionInFlight ||
    state.hasPendingMessages ||
    !contextUsage ||
    contextUsage.tokens === null ||
    contextUsage.contextWindow <= 0
  ) {
    return false;
  }

  const triggerPercent = state.triggerPercent ?? EARLY_COMPACTION_PERCENT;
  return contextUsage.tokens >= contextUsage.contextWindow * (triggerPercent / 100);
}

export function createEarlyCompactionContinuation(contextUsage, compactionResult) {
  return {
    message: {
      customType: COMPACTION_CONTINUATION_TYPE,
      content: [{ type: "text", text: EARLY_CONTINUATION_PROMPT }],
      display: false,
      details: {
        version: 1,
        reason: "pre-provider-threshold",
        contextTokens: contextUsage.tokens,
        contextWindow: contextUsage.contextWindow,
        tokensBefore: compactionResult?.tokensBefore,
      },
    },
    options: {
      triggerTurn: true,
      deliverAs: "followUp",
    },
  };
}

export function createCompactionContinuation(event, branch, state = {}) {
  const resumableReason =
    event.reason === "manual" ||
    (event.reason === "threshold" && state.agentActive);
  if (
    !state.enabled ||
    state.compactionInFlight ||
    state.hasPendingMessages ||
    !resumableReason ||
    event.willRetry
  ) {
    return null;
  }

  const interrupted = findAssistantBeforeCompaction(branch, event.compactionEntry.id);
  if (!interrupted || interrupted.message.stopReason !== "error") return null;

  return {
    message: {
      customType: COMPACTION_CONTINUATION_TYPE,
      content: [{ type: "text", text: CONTINUATION_PROMPT }],
      display: false,
      details: {
        version: 1,
        compactionEntryId: event.compactionEntry.id,
        interruptedAssistantEntryId: interrupted.id,
        previousStopReason: interrupted.message.stopReason,
      },
    },
    options: {
      triggerTurn: true,
      deliverAs: "followUp",
    },
  };
}
