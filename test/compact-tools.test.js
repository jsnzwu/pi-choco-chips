import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  createBashToolDefinition, createEditToolDefinition, createReadToolDefinition,
  createWriteToolDefinition, getShellConfig, initTheme, ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import compactTools, { compactTool } from "../extensions/compact-tools.ts";
import { installBashGroups } from "../extensions/bash-groups.ts";

const directory = mkdtempSync(join(tmpdir(), "pcc-compact-"));
after(() => rmSync(directory, { recursive: true, force: true }));
initTheme("dark", false);
const rows = (component, width = 100) => component.render(width)
  .map((line) => stripVTControlCharacters(line).trimEnd()).filter((line) => line.trim());
const result = (component, value, partial = false) => component.updateResult({ ...value, isError: value.isError === true }, partial);
const component = (tool, args) => {
  const value = new ToolExecutionComponent(tool.name, "fixture", args, { showImages: false }, tool, { requestRender() {} }, directory);
  value.setArgsComplete();
  value.markExecutionStarted();
  return value;
};

test("compact tools preserve native schemas, executors, metadata, and optional intent", () => {
  for (const factory of [createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition]) {
    const native = factory(directory);
    const compact = compactTool(native);
    assert.equal(compact.execute, native.execute);
    assert.equal(compact.outputSchema, native.outputSchema);
    assert.equal(compact.promptSnippet, native.promptSnippet);
    assert.deepEqual(compact.parameters.required, native.parameters.required);
    for (const [key, property] of Object.entries(native.parameters.properties)) {
      assert.equal(compact.parameters.properties[key], property);
    }
    assert.equal(compact.parameters.properties.reasoning.type, "string");
  }
});

test("rows use semantic theme colors and sanitize goals without fixed ANSI colors", () => {
  const tool = compactTool(createReadToolDefinition(directory));
  const args = { path: "fixture.txt", reasoning: "Check\n\u001b[35mconfiguration\u001b[0m" };
  const context = { state: {}, args, cwd: directory, expanded: false, argsComplete: false };
  const themed = (prefix) => ({
    fg: (role, text) => `<${prefix}:${role}>${text}</${prefix}:${role}>`,
    bold: (text) => text,
  });
  for (const [partial, error, role, mark] of [[true, false, "muted", "…"], [false, false, "success", "✓"], [false, true, "error", "✗"]]) {
    Object.assign(context, { isPartial: partial, isError: error });
    for (const palette of ["dark", "light"]) {
      const text = tool.renderCall(args, themed(palette), context).render(200).join("");
      assert.ok(text.includes(`<${palette}:${role}>${mark}`));
      assert.ok(text.includes(`<${palette}:toolTitle>📖 read`));
      assert.ok(text.includes(`<${palette}:text>Check configuration`));
      assert.equal(text.includes("\u001b"), false);
    }
  }
});

test("Bash stays on one bounded row and retains native command, output, and failures on expansion", async () => {
  const tool = compactTool(createBashToolDefinition(directory));
  for (const failure of [false, true]) {
    const args = {
      reasoning: "Check the compact display with a long descriptive goal 中文",
      command: failure ? "printf 'fixture-error\\n' >&2; exit 7" : "printf 'fixture-output\\n'\nprintf 'second-output\\n'",
      timeout: 5,
    };
    const view = component(tool, args);
    try {
      assert.match(rows(view).join(""), /^… ⚡ bash Check/);
      for (const width of [1, 8, 24, 80]) {
        const rendered = rows(view, width);
        assert.equal(rendered.length, 1);
        assert.ok(visibleWidth(rendered[0]) <= width);
      }
      result(view, { content: [{ type: "text", text: "streaming output" }] }, true);
      view.setExpanded(true);
      assert.ok(rows(view).some((line) => line.includes("printf")));
      view.setExpanded(false);
      const completed = await tool.execute("fixture", args, AbortSignal.timeout(10000));
      assert.equal(completed.isError === true, failure);
      result(view, completed);
      assert.equal(rows(view).length, 1);
      assert.ok(rows(view)[0].startsWith(failure ? "✗ ⚡ bash" : "✓ ⚡ bash"));
      assert.equal(rows(view)[0].includes("printf"), false);
      for (let index = 0; index < 2; index++) {
        view.setExpanded(true);
        assert.ok(rows(view).some((line) => line.includes(failure ? "fixture-error" : "second-output")));
        view.setExpanded(false);
        assert.equal(rows(view).length, 1);
      }
    } finally {
      result(view, { content: [], isError: true });
    }
  }
});

test("multi-edit diffs and historical calls without intent survive collapse and expansion", async () => {
  const path = join(directory, "edit-fixture.txt");
  await compactTool(createWriteToolDefinition(directory)).execute("write", { path, content: "before\nstable\n" });
  const tool = compactTool(createEditToolDefinition(directory));
  const args = { path, edits: [{ oldText: "before", newText: "after" }, { oldText: "stable", newText: "retained" }] };
  const view = component(tool, args);
  const completed = await tool.execute("edit", args);
  result(view, completed);
  assert.equal(readFileSync(path, "utf8"), "after\nretained\n");
  assert.equal(rows(view).length, 1);
  for (let index = 0; index < 2; index++) {
    view.setExpanded(true);
    assert.ok(rows(view).some((line) => line.includes("after")));
    assert.ok(rows(view).some((line) => line.includes("retained")));
    view.setExpanded(false);
    assert.equal(rows(view).length, 1);
  }
});

test("registration keeps user shell preferences and ignores untrusted project execution settings", async () => {
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(directory, "agent");
  const project = join(directory, "project");
  mkdirSync(agentDir);
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellCommandPrefix: "export PCC_COMPACT_TEST=trusted", shellPath: getShellConfig().shell }));
  writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ shellCommandPrefix: "export PCC_COMPACT_TEST=untrusted" }));
  const tools = new Map();
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.chdir(project);
    compactTools({ registerTool: (tool) => tools.set(tool.name, tool) });
  } finally {
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  assert.deepEqual([...tools.keys()].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
  const completed = await tools.get("bash").execute("preferences", { command: "printenv PCC_COMPACT_TEST", timeout: 5 }, AbortSignal.timeout(10000));
  assert.ok(completed.content.some((part) => part.text?.trim() === "trusted"));
});

test("read counts reserve space beside long goals and distinguish images and errors", () => {
  const tool = compactTool(createReadToolDefinition(directory));
  const view = component(tool, { path: "fixture.txt", reasoning: "检查读取结果与统计".repeat(50) });
  for (const [value, expected] of [
    [{ content: [{ type: "text", text: "first\nsecond" }] }, "2 lines"],
    [{ content: [{ type: "text", text: "" }] }, "0 lines"],
    [{ content: [{ type: "text", text: "preview\n[truncated]" }], details: { truncation: { outputLines: 118 } } }, "118 lines"],
    [{ content: [{ type: "image", data: "", mimeType: "image/png" }] }, "image"],
    [{ content: [{ type: "text", text: "permission denied" }], isError: true }, "error"],
  ]) {
    result(view, value);
    for (const width of [24, 50, 80]) {
      const rendered = rows(view, width);
      assert.equal(rendered.length, 1);
      assert.ok(visibleWidth(rendered[0]) <= width);
      assert.ok(rendered[0].endsWith(` → ${expected}`));
    }
  }
});

test("Bash reuses Pi's live clock before stdout, stops it on completion, and honors recorded durations", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 100000 });
  const tool = compactTool(createBashToolDefinition(directory));
  let redraws = 0;
  const view = new ToolExecutionComponent("bash", "clock", { command: "sleep 30", reasoning: "等待诊断完成" }, {}, tool, { requestRender() { redraws++; } }, directory);
  view.setArgsComplete();
  view.markExecutionStarted();
  try {
    t.mock.timers.tick(26000);
    assert.ok(rows(view)[0].endsWith(" → 26s"));
    assert.ok(redraws > 2);
    result(view, { content: [], durationMs: 1250 });
    assert.ok(rows(view)[0].endsWith(" → 1s"));
    const stopped = redraws;
    t.mock.timers.tick(60000);
    assert.equal(redraws, stopped);
    assert.ok(rows(view)[0].endsWith(" → 1s"));
    const historical = new ToolExecutionComponent("bash", "old", { command: "true", reasoning: "旧记录" }, {}, tool, { requestRender() {} }, directory);
    result(historical, { content: [] });
    assert.equal(rows(historical)[0].includes(" → "), false);
  } finally {
    result(view, { content: [], isError: true });
  }
});

test("expanded native read, write, edit, and Bash views retain the task description", async () => {
  const path = join(directory, "expanded-fixture.txt");
  writeFileSync(path, "first\nsecond\n");
  const cases = [
    [createReadToolDefinition, { path }, "second"],
    [createWriteToolDefinition, { path: join(directory, "expanded-write.txt"), content: "expanded written content\n" }, "expanded written content"],
    [createEditToolDefinition, { path, edits: [{ oldText: "second", newText: "updated line" }] }, "updated line"],
    [createBashToolDefinition, { command: "printf 'expanded shell output\\n'", timeout: 5 }, "expanded shell output"],
  ];
  for (const [factory, input, detail] of cases) {
    const tool = compactTool(factory(directory));
    const args = { ...input, reasoning: `保留 ${tool.name} 的任务说明` };
    const view = component(tool, args);
    try {
      result(view, await tool.execute("expanded", args, AbortSignal.timeout(10000)));
      view.setExpanded(true);
      const expanded = rows(view).join("\n");
      assert.ok(expanded.includes(args.reasoning));
      assert.ok(expanded.includes(detail));
      view.setExpanded(false);
      assert.equal(rows(view).length, 1);
      assert.ok(rows(view)[0].includes(args.reasoning));
    } finally {
      result(view, { content: [], isError: true });
    }
  }
});

test("Bash groups preserve original rows, narrow widths, expansion, and mouse clicks", () => {
  installBashGroups();
  installBashGroups();
  const tool = compactTool(createBashToolDefinition(directory));
  const first = component(tool, { command: "printf first", reasoning: "检查第一项" });
  const second = component(tool, { command: "printf second", reasoning: "检查第二项" });
  const chat = new Container();
  const hidden = new Text("", 0, 0);
  chat.addChild(first);
  chat.addChild(hidden);
  chat.addChild(second);
  const original = [...chat.children];
  try {
    assert.match(rows(chat)[0], /Running 2 shell commands/);
    result(first, { content: [{ type: "text", text: "first output" }], isError: true, durationMs: 2000 });
    result(second, { content: [{ type: "text", text: "second output" }], durationMs: 1000 });
    assert.match(rows(chat)[0], /^✗ Ran 2 shell commands/);
    assert.equal(rows(chat).length, 3);
    assert.deepEqual(chat.children, original);
    for (const width of [1, 8, 24, 80]) {
      for (const line of rows(chat, width)) assert.ok(visibleWidth(line) <= width);
    }
    const rendered = chat.render(80);
    const hit = chat.handleMouse({ type: "click", button: "left", x: 3, y: 1, width: 80, height: rendered.length });
    assert.equal(hit?.handled, true);
    assert.ok(rows(chat).some((line) => line.includes("first output")));
    assert.ok(rows(chat).some((line) => line.includes("检查第一项")));
    for (const child of chat.children) if (child instanceof ToolExecutionComponent) child.setExpanded(true);
    assert.ok(rows(chat).some((line) => line.includes("second output")));
    for (const child of chat.children) if (child instanceof ToolExecutionComponent) child.setExpanded(false);
    assert.equal(rows(chat).length, 3);
    assert.deepEqual(chat.children, original);
  } finally {
    result(first, { content: [] });
    result(second, { content: [] });
  }
});

test("visible text and non-Bash tools end a Bash group, while a single command stays unchanged", () => {
  const tool = compactTool(createBashToolDefinition(directory));
  const commands = ["one", "two", "three", "four"].map((goal) => {
    const view = component(tool, { command: "true", reasoning: goal });
    result(view, { content: [], durationMs: 1 });
    return view;
  });
  const read = component(compactTool(createReadToolDefinition(directory)), { path: "fixture.txt", reasoning: "读取配置" });
  result(read, { content: [{ type: "text", text: "config" }] });
  const chat = new Container();
  chat.children = [commands[0], read, commands[1], new Text("next task", 0, 0), commands[2]];
  assert.equal(rows(chat).some((line) => line.includes("shell commands")), false);
  chat.children = [commands[0], commands[1], read, commands[2], commands[3]];
  assert.equal(rows(chat).filter((line) => line.includes("Ran 2 shell commands")).length, 2);
});
