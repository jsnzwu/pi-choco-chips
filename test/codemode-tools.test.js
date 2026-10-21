import assert from "node:assert/strict";
import test, { after } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { createCodemodeExtension, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import compactTools from "../extensions/compact-tools.ts";
import { stopToolPulses } from "../extensions/tool-status.ts";

initTheme("dark", false);
after(stopToolPulses);
const rows = (view, width = 160) => view.render(width).map((line) => stripVTControlCharacters(line).trim()).filter(Boolean);
const preview = (args) => {
  const text = JSON.stringify(args);
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
};

function fixture() {
  const handlers = new Map();
  const tools = new Map();
  let resolver;
  let level = "low";
  let active = true;
  let theme;
  let redraws = 0;
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerToolRenderer: (value) => { resolver = value; },
    getThinkingLevel() { assert.ok(active, "runtime was invalidated"); return level; },
    on(name, handler) { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
  };
  compactTools(pi);
  let native;
  createCodemodeExtension({ models: false })({ registerTool: (tool) => { native = tool; } });
  const observed = { ...native, renderResult(...args) { theme = args[2]; return native.renderResult(...args); } };
  const tool = resolver("codemode", () => observed);
  const emit = (type, event = {}) => { for (const handler of handlers.get(type) ?? []) handler({ type, ...event }); };
  const make = (id, live = true) => {
    const view = new ToolExecutionComponent("codemode", id, { code: Array.from({ length: 12 }, (_, index) => `text("SCRIPT_LINE_${index}");`).join("\n") },
      { showImages: false }, tool, { requestRender() { redraws++; } }, process.cwd());
    view.setArgsComplete();
    if (live) {
      emit("tool_execution_start", { toolName: "codemode", toolCallId: id });
      view.markExecutionStarted();
      view.updateResult({ content: [], details: { calls: [] }, isError: false }, true);
    }
    return view;
  };
  const capture = (parent, id, name, args) => emit("tool_execution_start", { parentToolCallId: parent, toolCallId: id, toolName: name, args });
  const update = (view, calls, partial = false, extra = {}) => view.updateResult({ content: [], details: { calls }, isError: false, ...extra }, partial);
  return { tools, native, resolver, tool, emit, make, capture, update, get theme() { return theme; }, get redraws() { return redraws; }, setLevel(value) { level = value; }, invalidateRuntime() { active = false; } };
}

test("codemode uses a renderer resolver without registering, activating, or changing its native executor", () => {
  const f = fixture();
  assert.deepEqual([...f.tools.keys()].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
  assert.equal(f.tool.execute, f.native.execute);
  assert.equal(f.tool.parameters, f.native.parameters);
  assert.equal(f.tool.prepareLoadout, f.native.prepareLoadout);
  assert.equal(f.tool.defaultActive, false);
  assert.equal(f.tool.renderCall, f.native.renderCall);
  const other = { renderResult() {} };
  assert.equal(f.resolver("mcp__server__tool", () => other), other);
  assert.equal(f.resolver("codemode", () => undefined), undefined);
});

test("codemode pulses in three fixed columns, recovers live arguments, follows thinking color, and stops", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 100000 });
  const f = fixture();
  const view = f.make("pulse");
  const args = { command: `python ${"long-argument ".repeat(30)}COMMAND_END`, reasoning: "核对归档参数" };
  const before = JSON.stringify(args);
  const call = { id: "pulse/?", name: "bash", args: preview(args), status: "running" };
  f.capture("pulse", "pulse/1", "bash", args);
  try {
    f.update(view, [call], true);
    for (const [index, prefix] of [".   ", "..  ", "... ", "..  ", ".   "].entries()) {
      if (index) t.mock.timers.tick(500);
      const row = rows(view).find((line) => /^\.+ +bash /.test(line));
      assert.ok(row, rows(view).join("\n"));
      assert.equal(row.indexOf("bash"), 4);
      assert.ok(row.startsWith(prefix));
      assert.ok(row.includes(args.reasoning));
      assert.ok(row.includes(" · python "));
      assert.equal(row.includes('"reasoning"'), false);
      for (const level of ["low", "max"]) {
        f.setLevel(level);
        assert.ok(view.render(160).some((line) => line.includes(f.theme.getThinkingBorderColor(level)(prefix.slice(0, 3)))));
      }
    }
    f.emit("tool_execution_end", { toolName: "codemode", toolCallId: "pulse" });
    const final = { ...call, id: "pulse/1", status: "ok", durationMs: 32500 };
    f.update(view, [final], false, { durationMs: 32500 });
    assert.ok(rows(view).some((line) => line.startsWith("✓   bash") && line.includes(args.reasoning) && line.endsWith(" → 32.5s")));
    assert.ok(rows(view).includes("Took 32.5s"));
    const stopped = f.redraws;
    t.mock.timers.tick(3000);
    assert.equal(f.redraws, stopped);
    view.setExpanded(true);
    assert.ok(rows(view).join("\n").includes("COMMAND_END"));
    assert.equal(JSON.stringify(args), before);
    assert.equal(call.id, "pulse/?");
    assert.equal(call.status, "running");
  } finally {
    f.update(view, []);
  }
});

test("bounded codemode rows retain goal and path, native script/output expansion, errors, cancellation, and all model costs", () => {
  const f = fixture();
  const view = f.make("details");
  const calls = [];
  for (let index = 1; index <= 9; index++) {
    const args = { reasoning: `检查路径 ${"中文说明 ".repeat(12)}`, path: `/home/fixture/${"long-directory/".repeat(12)}target-${index}.py` };
    const id = `details/${index}`;
    f.capture("details", id, "read", args);
    calls.push({ id, name: "read", args: preview(args), status: index === 8 ? "error" : index === 9 ? "cancelled" : "ok", durationMs: 4, error: index === 8 ? "FIRST_ERROR\nSECOND_ERROR" : undefined });
  }
  calls.push({ id: "details/classify/1", name: "models.classify", args: "provider/classifier", status: "ok", durationMs: 1200, cost: 0.002 });
  calls.push({ id: "details/classify/2", name: "models.classify", args: "provider/classifier", status: "ok", durationMs: 1700, cost: 0.004 });
  const snapshot = JSON.stringify(calls);
  const content = [{ type: "text", text: "Script completed\nWall time 32.5 seconds\nOutput:\n" },
    { type: "text", text: Array.from({ length: 12 }, (_, index) => `NATIVE_OUTPUT_${index}`).join("\n") }];
  const value = { content, details: { calls, fullOutputPath: "/tmp/native-full-output.txt" }, durationMs: 32500 };
  try {
    f.emit("tool_execution_end", { toolName: "codemode", toolCallId: "details" });
    f.update(view, calls, false, value);
    const collapsed = rows(view).join("\n");
    assert.match(collapsed, /3 earlier calls/);
    assert.match(collapsed, /Full output: \/tmp\/native-full-output.txt/);
    assert.match(collapsed, /Model calls: \$0\.0060/);
    assert.equal(collapsed.includes("NATIVE_OUTPUT_11"), false);
    for (const width of [24, 40, 80, 160]) {
      const headers = rows(view, width).filter((line) => /^[✓✗⊘] +read /.test(line));
      assert.equal(headers.length, 6);
      assert.ok(headers.every((line) => visibleWidth(line) <= width && line.endsWith(" → 4ms")));
      if (width >= 80) assert.ok(headers.every((line) => line.includes("检查路径") && line.includes(" · /home/fixture/")));
    }
    for (let index = 0; index < 2; index++) {
      view.setExpanded(true);
      const expanded = rows(view).join("\n");
      assert.ok(expanded.includes("SCRIPT_LINE_11"));
      assert.ok(expanded.includes("NATIVE_OUTPUT_11"));
      assert.ok(expanded.includes("target-1.py"));
      assert.ok(expanded.includes("FIRST_ERROR"));
      assert.ok(expanded.includes("SECOND_ERROR"));
      assert.ok(expanded.includes("⊘   read"));
      assert.equal(expanded.includes("Script completed"), false);
      view.setExpanded(false);
      assert.match(rows(view).join("\n"), /3 earlier calls/);
    }
    assert.equal(JSON.stringify(calls), snapshot);
    assert.equal(value.details.calls, calls);
  } finally {
    f.update(view, []);
  }
});

test("ambiguous parallel previews never borrow another call's goal; completed IDs and historical previews remain usable", () => {
  const f = fixture();
  const view = f.make("parallel");
  const command = `python ${"shared-prefix ".repeat(30)}`;
  const inputs = ["UNIQUE_GOAL_A", "UNIQUE_GOAL_B"].map((reasoning, index) => ({ command: `${command}END_${index}`, reasoning }));
  const calls = inputs.map((args) => ({ id: "parallel/?", name: "bash", args: preview(args), status: "running" }));
  inputs.forEach((args, index) => f.capture("parallel", `parallel/${index + 1}`, "bash", args));
  try {
    f.update(view, calls, true);
    const ambiguous = rows(view).join("\n");
    assert.equal(ambiguous.includes("UNIQUE_GOAL_"), false);
    const finished = calls.map((call, index) => ({ ...call, id: `parallel/${index + 1}`, status: "ok", durationMs: 1 }));
    f.update(view, finished);
    for (const goal of inputs.map((input) => input.reasoning)) assert.ok(rows(view).some((line) => line.includes(goal)));
    const historical = f.make("history", false);
    f.update(historical, [{ id: "old/1", name: "read", args: preview({ reasoning: "历史读取说明", path: `/home/${"directory/".repeat(40)}` }), status: "ok", durationMs: 4 }]);
    assert.ok(rows(historical).some((line) => line.includes("历史读取说明") && line.includes(" · /home/") && line.endsWith(" → 4ms")));
  } finally {
    f.update(view, []);
  }
});

test("shutdown stops codemode's shared Loader pulse and the native error result clears its timer", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 100000 });
  const f = fixture();
  const view = f.make("shutdown");
  try {
    f.update(view, [{ id: "shutdown/?", name: "bash", args: '{"reasoning":"Wait","command":"sleep 30"}', status: "running" }], true);
    t.mock.timers.tick(500);
    const before = f.redraws;
    f.emit("session_shutdown", { reason: "reload" });
    f.emit("session_shutdown", { reason: "reload" });
    f.invalidateRuntime();
    assert.ok(rows(view).some((line) => /^\.+ +bash Wait/.test(line)));
    t.mock.timers.tick(100);
    assert.equal(f.redraws, before);
    f.update(view, [{ id: "shutdown/1", name: "bash", args: "{}", status: "error", durationMs: 600, error: "aborted" }], false, { isError: true });
    assert.ok(rows(view).some((line) => line.startsWith("✗   bash") && line.endsWith(" → 600ms")));
    const stopped = f.redraws;
    t.mock.timers.tick(3000);
    assert.equal(f.redraws, stopped);
  } finally {
    f.update(view, []);
  }
});
