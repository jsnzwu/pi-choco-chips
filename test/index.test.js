import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { stripVTControlCharacters } from "node:util";

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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
      entries.push({ type: "custom", customType: type, data });
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

const FAST_ENTRY = "pi-choco-chips:fast";

function createFastHarness(branch = []) {
  const harness = createExtensionHarness();
  const statuses = new Map();
  const notices = [];
  const ctx = {
    hasUI: true,
    mode: "rpc",
    model: { provider: "proxy", id: "gpt-5.4", api: "openai-responses" },
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: (message, type) => notices.push({ message, type }),
      setStatus: (key, text) => text === undefined ? statuses.delete(key) : statuses.set(key, text),
    },
  };
  return { ...harness, ctx, statuses, notices };
}

test("fast toggles priority requests and status without changing the original payload", async () => {
  const harness = createFastHarness();
  const { ctx, commands, handlers, statuses, entries, notices } = harness;
  await handlers.get("session_start")({}, ctx);
  const fast = commands.get("fast").handler;
  const request = handlers.get("before_provider_request");
  const payload = { model: ctx.model.id, input: "Hello", reasoning: { effort: "high" } };

  assert.equal(statuses.get(FAST_ENTRY), "fast:off");
  assert.equal(request({ payload }, ctx), undefined);
  await fast("status", ctx);
  assert.equal(entries.length, 0);

  await fast("", ctx);
  assert.equal(statuses.get(FAST_ENTRY), "fast:on");
  assert.deepEqual(request({ payload }, ctx), { ...payload, service_tier: "priority" });
  assert.equal(Object.hasOwn(payload, "service_tier"), false);
  assert.match(notices.at(-1).message, /charges/i);

  await fast("on", ctx);
  assert.equal(statuses.get(FAST_ENTRY), "fast:on");
  const savedCount = entries.length;
  await fast("status", ctx);
  await fast("on off", ctx);
  assert.equal(entries.length, savedCount);
  assert.equal(statuses.get(FAST_ENTRY), "fast:on");
  assert.match(notices.at(-1).message, /Usage: \/fast/);

  await fast("OFF", ctx);
  assert.equal(statuses.get(FAST_ENTRY), "fast:off");
  assert.equal(request({ payload: { ...payload, service_tier: "flex" } }, ctx), undefined);
  await fast("", ctx);
  await fast("", ctx);
  assert.equal(statuses.get(FAST_ENTRY), "fast:off");
  assert.deepEqual(entries.at(-1), {
    type: "custom", customType: FAST_ENTRY, data: { enabled: false },
  });
});

test("fast supports GPT across OpenAI APIs but never follows a non-GPT model", async () => {
  const { ctx, commands, handlers, statuses, entries, notices } = createFastHarness();
  const fast = commands.get("fast").handler;
  const request = handlers.get("before_provider_request");

  for (const [api, id] of [
    ["openai-responses", "gpt-5.4"],
    ["openai-completions", "openai/gpt-4.1"],
    ["openai-codex-responses", "gpt-5.3-codex"],
    ["azure-openai-responses", "gpt-5.4"],
  ]) {
    ctx.model = { provider: "proxy", api, id };
    await fast("on", ctx);
    assert.equal(request({ payload: { model: id } }, ctx).service_tier, "priority", api);
  }

  const savedCount = entries.length;
  for (const model of [
    { id: "claude-sonnet-4-6", api: "openai-responses" },
    { id: "gemini-2.5-pro", api: "google-generative-ai" },
    { id: "not-gpt-5.4", api: "openai-responses" },
    { id: "gpt-5.4", api: "anthropic-messages" },
    undefined,
  ]) {
    ctx.model = model;
    handlers.get("model_select")({ model }, ctx);
    assert.equal(statuses.has(FAST_ENTRY), false);
    assert.equal(request({ payload: { model: "gpt-5.4" } }, ctx), undefined);
    await fast("", ctx);
    assert.match(notices.at(-1).message, /only.*GPT/);
    assert.equal(entries.length, savedCount);
  }

  ctx.model = { id: "gpt-5.4", api: "openai-responses" };
  handlers.get("model_select")({ model: ctx.model }, ctx);
  assert.equal(statuses.get(FAST_ENTRY), "fast:on");
  for (const payload of [null, [], "payload", {}, { model: "claude-sonnet-4-6" }]) {
    assert.equal(request({ payload }, ctx), undefined);
  }
});

test("fast restores the active branch and clears state for a new session", async () => {
  const original = createFastHarness();
  await original.commands.get("fast").handler("on", original.ctx);
  const restored = createFastHarness(original.entries);
  const { ctx, commands, handlers, statuses } = restored;
  await handlers.get("session_start")({ reason: "reload" }, ctx);
  assert.equal(statuses.get(FAST_ENTRY), "fast:on");

  ctx.sessionManager.getBranch = () => [
    ...original.entries,
    { type: "custom", customType: FAST_ENTRY, data: { enabled: false } },
  ];
  handlers.get("session_tree")({}, ctx);
  assert.equal(statuses.get(FAST_ENTRY), "fast:off");

  ctx.sessionManager.getBranch = () => original.entries;
  handlers.get("session_tree")({}, ctx);
  assert.equal(statuses.get(FAST_ENTRY), "fast:on");
  handlers.get("session_shutdown")({}, ctx);
  assert.equal(statuses.has(FAST_ENTRY), false);

  ctx.sessionManager.getBranch = () => [];
  await handlers.get("session_start")({ reason: "new" }, ctx);
  assert.equal(statuses.get(FAST_ENTRY), "fast:off");
  await commands.get("choco").handler("on", ctx);
  assert.equal(handlers.get("before_provider_request")({ payload: { model: "gpt-5.4" } }, ctx), undefined);
  assert.equal(restored.entries.some((entry) => entry.customType === FAST_ENTRY), false);
});

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

test("skill composer embeds native working status and restores its border when idle", async () => {
  const harness = createExtensionHarness();
  let editorFactory;
  const sessionContext = {
    ...context,
    sessionManager: { getBranch: () => [] },
    ui: {
      addAutocompleteProvider() {},
      setEditorComponent: (factory) => { editorFactory = factory; },
      getEditorComponent: () => editorFactory,
    },
  };
  await harness.handlers.get("session_start")({}, sessionContext);
  const keybindings = { getUserBindings: () => ({}), setUserBindings() {} };
  const editor = editorFactory({ terminal: { rows: 24 }, requestRender() {} }, { borderColor: (text) => text }, keybindings);
  assert.equal(editor.embedWorkingStatus, true);
  editor.setWorkingStatusIndicator({
    renderInBorder: (width) => truncateToWidth("⠋ Waiting for model · 12s", width, ""),
    renderSpinnerInBorder: () => "⠋",
  });
  for (const width of [1, 8, 30, 80]) {
    const border = stripVTControlCharacters(editor.render(width)[0]);
    assert.ok(border.includes("⠋"), `width ${width}`);
    assert.equal(visibleWidth(border), width);
  }
  assert.match(editor.render(80)[0], /^── ⠋ Waiting for model · 12s ─/);
  editor.setWorkingStatusIndicator(undefined);
  assert.equal(editor.render(80)[0], "─".repeat(80));
  harness.handlers.get("session_shutdown")({}, sessionContext);
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
