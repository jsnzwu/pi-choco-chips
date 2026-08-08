import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import piChocoDashboard from "../extensions/dashboard.js";

function createDashboardHarness() {
  const handlers = new Map();
  const commands = new Map();
  const messageRenderers = new Map();
  const entryRenderers = new Map();
  const pi = {
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerMessageRenderer(type, renderer) {
      messageRenderers.set(type, renderer);
    },
    registerEntryRenderer(type, renderer) {
      entryRenderers.set(type, renderer);
    },
  };

  piChocoDashboard(pi);
  return { handlers, commands, messageRenderers, entryRenderers };
}

test("package loads the shortcut and dashboard extensions", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(packageJson.pi.extensions, [
    "./extensions/index.js",
    "./extensions/dashboard.js",
  ]);
});

test("bundled settings contain the dashboard section", () => {
  const settings = JSON.parse(
    readFileSync(new URL("../pi-choco-setting.json", import.meta.url), "utf8"),
  );
  assert.equal(settings.version, 1);
  assert.equal(settings.dashboard.enabled, true);
  assert.equal(settings.dashboard.footer.line2Visible, true);
  assert.equal(settings.dashboard.footer.line3Visible, true);
  assert.equal(settings.dashboard.controls.registerCommands, true);
  assert.equal(settings.dashboard.transcript.compactSameTurnSpacing, true);
});

test("dashboard registers its renderers and lifecycle handlers", () => {
  const harness = createDashboardHarness();

  assert.equal(harness.commands.has("dashboard"), true);
  assert.equal(harness.messageRenderers.has("pi-choco-chips.skill-bundle"), true);
  assert.equal(harness.entryRenderers.has("pi-choco-chips.dashboard.meta"), true);
  for (const event of [
    "session_start",
    "message_end",
    "tool_execution_start",
    "tool_execution_end",
    "agent_settled",
    "session_shutdown",
  ]) {
    assert.equal(harness.handlers.has(event), true, `missing ${event} handler`);
  }
});
