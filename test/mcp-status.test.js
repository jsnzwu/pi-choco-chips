import assert from "node:assert/strict";
import test from "node:test";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { MCP_STATUS_EVENT, subscribeMcpServerNames } from "../extensions/mcp-status.ts";
import { extensionStatusGroups, packGroupedExtensionStatus } from "../extensions/dashboard.ts";

test("MCP names follow snapshots without connecting and stop updating after disposal", () => {
  const events = createEventBus();
  const updates = [];
  const stop = subscribeMcpServerNames(events, (names) => updates.push(names));
  assert.deepEqual(updates, []);
  const snapshot = { version: 1, servers: [{ name: "weyaw-agents", disabled: false }] };
  events.emit(MCP_STATUS_EVENT, snapshot);
  events.emit(MCP_STATUS_EVENT, snapshot);
  assert.deepEqual(updates, [["weyaw-agents"]]);
  events.emit(MCP_STATUS_EVENT, { version: 1, servers: [
    { name: "weyaw-agents" }, { name: "docs", disabled: true },
  ] });
  assert.deepEqual(updates.at(-1), ["weyaw-agents", "docs (disabled)"]);
  events.emit(MCP_STATUS_EVENT, { version: 2, servers: [] });
  assert.equal(updates.length, 2);
  events.emit(MCP_STATUS_EVENT, { version: 1, servers: [] });
  assert.deepEqual(updates.at(-1), []);
  stop();
  events.emit(MCP_STATUS_EVENT, snapshot);
  assert.equal(updates.length, 3);
});

test("MCP names are separate bounded footer fields and never resurrect a hidden MCP status", () => {
  const statuses = new Map([
    ["weyaw", "TSK-20000101-0000-example-mcp-status · 0 AGT"],
    ["mcp", "MCP 1/2"],
  ]);
  const [parts] = extensionStatusGroups(statuses, ["weyaw-agents", "文档服务"]);
  assert.deepEqual(parts.slice(1), ["MCP 1/2", "weyaw-agents", "文档服务"]);
  for (const width of [16, 40, 99, 100, 160]) {
    const rows = packGroupedExtensionStatus(parts, width, " · ");
    assert.ok(rows.every((row) => visibleWidth(row) <= width));
    assert.match(rows.join("\n"), /MCP 1\/2/);
    assert.match(rows.join("\n"), /weyaw-agents/);
    assert.match(rows.join("\n"), /文档服务/);
  }
  assert.deepEqual(extensionStatusGroups(new Map([["mcp", "MCP 1/1"]]), ["weyaw-agents"]), [["MCP 1/1", "weyaw-agents"]]);
  assert.deepEqual(extensionStatusGroups(new Map(), ["weyaw-agents"]), []);
  assert.deepEqual(extensionStatusGroups(statuses), [[...statuses.values()]]);
});
