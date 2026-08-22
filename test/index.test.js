import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import piChocoChips, { applyComposerKeybindings } from "../extensions/index.ts";

const skillDir = mkdtempSync(join(tmpdir(), "pi-choco-chips-"));
const skillPath = join(skillDir, "SKILL.md");
writeFileSync(skillPath, "---\nname: alpha\n---\nAlpha instructions\n");
after(() => rmSync(skillDir, { recursive: true, force: true }));

const skills = [
  {
    name: "skill:alpha",
    description: "Alpha skill",
    source: "skill",
    sourceInfo: { path: skillPath },
  },
];

function createExtensionHarness() {
  const handlers = new Map();
  const commands = new Map();
  const messages = [];
  const entries = [];
  const pi = {
    registerCommand(name, command) {
      commands.set(name, command);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
    getCommands() {
      return skills;
    },
    appendEntry(type, data) {
      entries.push({ type, data });
    },
    sendMessage(message, options) {
      messages.push({ message, options });
    },
    getThinkingLevel() {
      return "off";
    },
  };

  piChocoChips(pi);
  return { handlers, commands, messages, entries };
}

const context = {
  hasUI: false,
  mode: "tui",
  ui: {
    notify() {},
  },
};

const waitForDeferredDispatch = () => new Promise((resolve) => setTimeout(resolve, 0));

test("applies and restores the shared composer keybindings", () => {
  let userBindings = {
    "tui.editor.cursorUp": "ctrl+p",
    "tui.input.submit": "ctrl+enter",
    "tui.input.newLine": "alt+enter",
    "app.message.followUp": [],
  };
  const keybindings = {
    getUserBindings: () => ({ ...userBindings }),
    setUserBindings: (next) => {
      userBindings = { ...next };
    },
  };

  const restore = applyComposerKeybindings(keybindings);

  assert.deepEqual(userBindings, {
    "tui.editor.cursorUp": "ctrl+p",
    "tui.input.submit": "enter",
    "tui.input.newLine": ["shift+enter", "ctrl+j"],
    "app.message.followUp": "alt+enter",
  });

  restore();
  assert.deepEqual(userBindings, {
    "tui.editor.cursorUp": "ctrl+p",
    "tui.input.submit": "ctrl+enter",
    "tui.input.newLine": "alt+enter",
    "app.message.followUp": [],
  });
});

test("opens the interactive Choco settings page with no arguments", async () => {
  const harness = createExtensionHarness();
  let customCalls = 0;
  const commandContext = {
    ...context,
    hasUI: true,
    ui: {
      notify() {},
      async custom(factory) {
        customCalls++;
        assert.equal(typeof factory, "function");
      },
    },
  };

  await harness.commands.get("choco").handler("", commandContext);

  assert.equal(customCalls, 1);
  assert.equal(harness.entries.length, 0);
});

test("intercepts a recognized skill once and defers one custom turn", async () => {
  const harness = createExtensionHarness();
  const images = [{ type: "image", data: "abc", mimeType: "image/png" }];
  const result = await harness.handlers.get("input")(
    {
      type: "input",
      text: "Use /skill:alpha now",
      images,
      source: "interactive",
    },
    context,
  );

  assert.deepEqual(result, { action: "handled" });
  assert.equal(harness.messages.length, 0);

  await waitForDeferredDispatch();

  assert.equal(harness.messages.length, 1);
  assert.deepEqual(harness.messages[0].options, { triggerTurn: true });
  assert.equal(harness.messages[0].message.customType, "pi-choco-chips.skill-bundle");
  assert.equal(harness.messages[0].message.display, true);
  assert.equal(harness.messages[0].message.content.at(-1), images[0]);
  assert.equal(harness.messages[0].message.details.skills[0].status, "loaded");
});

test("routes streaming skill input as one follow-up without a new nested turn", async () => {
  const harness = createExtensionHarness();
  const result = await harness.handlers.get("input")(
    {
      type: "input",
      text: "$alpha",
      source: "interactive",
      streamingBehavior: "followUp",
    },
    context,
  );

  assert.deepEqual(result, { action: "handled" });
  await waitForDeferredDispatch();

  assert.equal(harness.messages.length, 1);
  assert.deepEqual(harness.messages[0].options, { triggerTurn: true, deliverAs: "followUp" });
});

test("passes unknown-only input through to Pi", async () => {
  const harness = createExtensionHarness();
  const result = await harness.handlers.get("input")(
    {
      type: "input",
      text: "/skill:missing and $HOME",
      source: "interactive",
    },
    context,
  );

  assert.deepEqual(result, { action: "continue" });
  await waitForDeferredDispatch();
  assert.equal(harness.messages.length, 0);
});

test("queues one hidden follow-up when threshold compaction follows an assistant error", () => {
  const harness = createExtensionHarness();
  const branch = [
    {
      type: "message",
      id: "assistant-1",
      message: { role: "assistant", stopReason: "error", content: [] },
    },
    {
      type: "compaction",
      id: "compaction-1",
      summary: "summary",
    },
  ];
  const compactContext = {
    ...context,
    hasUI: true,
    ui: { notify() {} },
    isIdle: () => false,
    hasPendingMessages: () => false,
    sessionManager: { getBranch: () => branch },
  };

  harness.handlers.get("session_compact")(
    {
      type: "session_compact",
      reason: "threshold",
      willRetry: false,
      compactionEntry: branch[1],
    },
    compactContext,
  );

  assert.equal(harness.messages.length, 1);
  assert.equal(
    harness.messages[0].message.customType,
    "pi-choco-chips.compaction-continuation",
  );
  assert.equal(harness.messages[0].message.display, false);
  assert.deepEqual(harness.messages[0].options, {
    triggerTurn: true,
    deliverAs: "followUp",
  });
});
