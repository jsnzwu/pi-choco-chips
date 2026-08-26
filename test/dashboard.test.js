import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import piChocoDashboard, {
  extensionStatusGroups,
  packFooterParts,
} from "../extensions/dashboard.ts";

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

test("package loads the shortcut, dashboard, and theme resources", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(packageJson.pi.extensions, [
    "./extensions/index.ts",
    "./extensions/dashboard.ts",
  ]);
  assert.deepEqual(packageJson.pi.themes, ["./themes/adam-dark.json"]);
  assert.equal(packageJson.files.includes("themes"), true);
});

test("bundled adam-dark theme resolves its semantic palette", () => {
  const theme = JSON.parse(
    readFileSync(new URL("../themes/adam-dark.json", import.meta.url), "utf8"),
  );
  const resolve = (value, seen = new Set()) => {
    if (typeof value !== "string" || value === "" || value.startsWith("#")) return value;
    assert.equal(seen.has(value), false, `cyclic theme variable: ${value}`);
    assert.equal(Object.hasOwn(theme.vars, value), true, `missing theme variable: ${value}`);
    return resolve(theme.vars[value], new Set([...seen, value]));
  };

  for (const value of Object.values(theme.colors)) resolve(value);
  assert.equal(theme.name, "adam-dark");
  assert.equal(resolve(theme.colors.accent), "#61afef");
  assert.equal(resolve(theme.colors.userMessageBg), "#30343b");
  assert.equal(resolve(theme.colors.syntaxType), "#56b6c2");
  assert.equal(resolve(theme.colors.syntaxOperator), "#56b6c2");
});

test("bundled settings contain the dashboard section", () => {
  const settings = JSON.parse(
    readFileSync(new URL("../pi-choco-setting.json", import.meta.url), "utf8"),
  );
  assert.equal(settings.version, 1);
  assert.equal(settings.dashboard.enabled, true);
  assert.equal(settings.dashboard.footer.line2Visible, true);
  assert.equal(settings.dashboard.footer.line3Visible, false);
  assert.equal(settings.dashboard.controls.registerCommands, true);
  assert.equal(settings.dashboard.transcript.compactSameTurnSpacing, true);
});

test("dashboard source keeps compact footer hierarchy and field-aware statuses", () => {
  const source = readFileSync(new URL("../extensions/dashboard.ts", import.meta.url), "utf8");
  assert.match(source, /line3Visible: false/);
  assert.match(source, /contextParts\.push\(formatTokens\(context\.contextWindow\)\)/);
  assert.match(source, /line1\.push\(theme\.fg\("muted", contextParts\.join\("\/"\)\)\)/);
  assert.match(source, /line1\.push\(theme\.fg\("muted", formatDuration\(currentForegroundWorkMs\(\)\)\)\)/);
  assert.match(source, /if \(config\.footer\.showCacheUsage\) \{/);
  assert.match(source, /contextParts\.push\(cacheHitRate\)/);
  assert.match(source, /usageParts\(sessionUsage, config, theme, true, false\)/);
  assert.doesNotMatch(source, /sessionStartedMono|currentSessionMs/);
  assert.match(source, /\)}K`/);
  assert.doesNotMatch(source, /"work "/);
  assert.match(source, /status\.split\(\/\\r\?\\n\//);
  assert.match(source, /extensionStatusGroups\(footerData\.getExtensionStatuses\(\)\)/);
  assert.match(source, /packFooterParts\(parts, width, divider\)/);
  assert.match(source, /return \[\.\.\.dashboardRows, \.\.\.statusRows\]/);
});

test("footer packing moves whole fields instead of splitting them", () => {
  assert.deepEqual(
    packFooterParts(["title", "model", "context"], 13, " · "),
    ["title · model", "context"],
  );
  assert.deepEqual(
    packFooterParts(["Weyaw Rust", "MCP 1/1"], 20, " · "),
    ["Weyaw Rust · MCP 1/1"],
  );
  assert.deepEqual(
    packFooterParts(["Weyaw Rust", "MCP 1/1"], 19, " · "),
    ["Weyaw Rust", "MCP 1/1"],
  );
});

test("footer groups Weyaw and MCP while preserving other status lines", () => {
  const statuses = new Map([
    ["weyaw", "Weyaw Rust"],
    ["mcp", "MCP 1/1"],
    ["other", "ready\nidle"],
  ]);

  assert.deepEqual(extensionStatusGroups(statuses), [
    ["Weyaw Rust", "MCP 1/1"],
    ["ready"],
    ["idle"],
  ]);
});

test("dashboard uses Pi semantic colors for git and thinking-level activity", () => {
  const source = readFileSync(new URL("../extensions/dashboard.ts", import.meta.url), "utf8");

  assert.match(source, /theme\.fg\("accent", dirty \? `\$\{branch\}\*` : branch\)/);
  assert.match(source, /theme\.getThinkingBorderColor\(meta\.thinkingLevel \|\| "off"\)/);
  assert.match(source, /theme\.getThinkingBorderColor\(currentThinking\)/);
  assert.equal(source.includes('const thinking = config.footer.showThinkingLevel ? `\\xB7${currentThinking}` : "";'), true);
  assert.equal(source.includes('line1.push(thinkingColor(theme.bold(`${model}${thinking}`)));'), true);
  assert.doesNotMatch(source, /theme\.bold\(`\(\$\{currentThinking\}\)`\)/);
  assert.match(source, /thinkingLevel: currentThinking/);
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
