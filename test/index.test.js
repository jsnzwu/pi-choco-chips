import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import piChocoChips from "../extensions/index.js";

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
  const messages = [];
  const entries = [];
  const pi = {
    registerCommand() {},
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
  return { handlers, messages, entries };
}

const context = {
  hasUI: false,
  mode: "tui",
  ui: {
    notify() {},
  },
};

const waitForDeferredDispatch = () => new Promise((resolve) => setTimeout(resolve, 0));

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
