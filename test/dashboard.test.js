import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { parse } from "smol-toml";

import { createEventBus } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";

import piChocoDashboard, {
  alignFooterTitle,
  compactPathForWidth,
  extensionStatusGroups,
  packFooterParts,
} from "../extensions/dashboard.ts";

function createDashboardHarness() {
  const handlers = new Map();
  const commands = new Map();
  const messageRenderers = new Map();
  const entryRenderers = new Map();
  const pi = {
    events: createEventBus(),
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
  assert.equal(packageJson.files.includes("pi-choco-setting.toml"), true);
  assert.equal(packageJson.files.includes("pi-choco-setting.json"), false);
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
  const settings = parse(
    readFileSync(new URL("../pi-choco-setting.toml", import.meta.url), "utf8"),
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
  assert.match(source, /contextParts\.push\(cacheHitRate\)/);
  assert.match(source, /usageParts\(sessionUsage, config, theme, true, false\)/);
  assert.doesNotMatch(source, /sessionStartedMono|currentSessionMs/);
  assert.match(source, /\)}K`/);
  assert.doesNotMatch(source, /"work "/);
  assert.match(source, /status\.split\(\/\\r\?\\n\//);
  assert.match(source, /const extensionStatuses = footerData\.getExtensionStatuses\(\)/);
  assert.match(source, /extensionStatusGroups\(extensionStatuses\)/);
  assert.match(source, /metadata\.push\(\.\.\.line4\)/);
  assert.match(source, /if \(extensionGroups\.length\) rows\.push\(extensionGroups\.flat\(\)\)/);
  assert.match(source, /packFooterParts\(parts, width, divider\)/);
  assert.match(source, /const DETAIL_FOOTER_WIDTH = 60/);
  assert.match(source, /const detail = width >= DETAIL_FOOTER_WIDTH/);
  assert.match(source, /compactPathForWidth\(ctx\.cwd, width - \(detail \? 4 : 0\), !detail\)/);
  assert.match(source, /if \(contextPercent !== void 0\)/);
  assert.match(source, /if \(detail && context\) contextParts\.push\(formatTokens\(context\.contextWindow\)\)/);
  assert.match(source, /if \(detail && config\.footer\.showCacheUsage\)/);
  assert.match(source, /if \(detail && config\.footer\.showRuntimePhase\)/);
  assert.match(source, /else if \(config\.footer\.showFullCwd\)/);
  assert.doesNotMatch(source, /MINIMAL_FOOTER_WIDTH|const minimal =|const relaxed =/);
  assert.match(source, /const rows = \[metadata\]/);
  assert.match(source, /alignFooterTitle\(titleText, line1, width, divider\)/);
});

test("footer shrinks long fields without adding rows or overflowing terminal columns", () => {
  const rows = [
    ["\x1b[36m本地委派审计与运行版本对齐\x1b[0m", "litellm/gpt-6-astra·medium", "13%/872K/CH97%", "22h 58m 56s"],
    ["📁 miaw", "cwd /mnt/d/Nextcloud/sync-git/workflow/miaw", "git main ↑101 ↓0 S0 M0 ?0"],
    ["🔌 MCP: 1 server enabled", "TSK-20261001-2009-host-orchestration-improve-eligible · 0 AGT"],
  ];
  for (let width = 0; width <= 240; width++) {
    const rendered = rows.flatMap((parts) => packFooterParts(parts, width, " · "));
    assert.equal(rendered.length, 3, `width ${width}`);
    for (const row of rendered) assert.ok(visibleWidth(row) <= width, `width ${width}: ${row}`);
  }
  assert.deepEqual(packFooterParts(["first", "second"], 14, " · "), ["first · second"]);
  assert.deepEqual(packFooterParts(["first", "second"], 13, " · ").map(stripVTControlCharacters), ["first · seco…"]);
  assert.deepEqual(packFooterParts([], 80, " · "), [""]);
  assert.match(packFooterParts(rows[0], 90, " · ")[0], /13%\/872K\/CH97% · 22h 58m 56s$/);
  assert.deepEqual(packFooterParts(rows[0], 240, " · "), [rows[0].join(" · ")]);
});

test("footer keeps the title left and metrics right, truncating the title first", () => {
  const title = "\x1b[36mPCC输入栏状态样式预览\x1b[0m";
  const parts = ["litellm/gpt-6.1-sol·low", "3%/872K/CH35%", "51s"];
  const metrics = parts.join(" · ");
  for (let width = 0; width <= 240; width++) {
    const row = alignFooterTitle(title, parts, width, " · ");
    assert.ok(visibleWidth(row) <= width, `width ${width}: ${row}`);
    if (width >= visibleWidth(metrics) + 3) {
      assert.ok(stripVTControlCharacters(row).endsWith(metrics), `width ${width}`);
      assert.equal(visibleWidth(row), width);
    }
  }
  const wide = stripVTControlCharacters(alignFooterTitle(title, parts, 100, " · "));
  assert.ok(wide.startsWith("PCC输入栏状态样式预览  "));
  assert.ok(wide.endsWith(metrics));
  const narrow = stripVTControlCharacters(alignFooterTitle(title, parts, visibleWidth(metrics) + 8, " · "));
  assert.ok(narrow.startsWith("PCC输…  "));
  assert.equal(alignFooterTitle("title", [], 80, " · "), "title");
  assert.equal(alignFooterTitle("", ["stats"], 8, " · "), "   stats");
});

test("footer uses stable segment abbreviations for narrow paths", () => {
  const cwd = "/mnt/c/Users/demo/Documents/work-src/projects/demo-app";

  assert.equal(compactPathForWidth(cwd, 80), cwd);
  assert.equal(
    compactPathForWidth(cwd, 80, true),
    "/mnt/c/Users/demo/D/w-s/projects/demo-app",
  );
  assert.equal(
    compactPathForWidth(cwd, 44),
    "/mnt/c/Users/demo/D/w-s/projects/demo-app",
  );
  assert.equal(
    compactPathForWidth(cwd, 29),
    "…/D/w-s/projects/demo-app",
  );
});

test("footer renders extension statuses without interpreting their keys", () => {
  const statuses = new Map([
    ["first-extension", "ready\nidle"],
    ["second-extension", "working"],
  ]);

  assert.deepEqual(extensionStatusGroups(statuses), [
    ["ready"],
    ["idle"],
    ["working"],
  ]);
});

test("dashboard uses Pi semantic colors for git and thinking-level activity", () => {
  const source = readFileSync(new URL("../extensions/dashboard.ts", import.meta.url), "utf8");

  assert.match(source, /theme\.fg\("accent", dirty \? `\$\{branch\}\*` : branch\)/);
  assert.match(source, /theme\.getThinkingBorderColor\(meta\.thinkingLevel \|\| "off"\)/);
  assert.match(source, /theme\.getThinkingBorderColor\(currentThinking\)/);
  assert.equal(source.includes('const thinking = config.footer.showThinkingLevel ? `\\xB7${currentThinking}` : "";'), true);
  assert.equal(source.includes('line1.push(theme.fg("muted", `${model}${thinking}`));'), true);
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
