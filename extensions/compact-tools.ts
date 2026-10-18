import { stripVTControlCharacters } from "node:util";
import {
  createBashToolDefinition, createEditToolDefinition, createFindToolDefinition,
  createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition,
  createWriteToolDefinition, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BASH_ROW, installBashGroups } from "./bash-groups.ts";

const EMPTY = new Text("", 0, 0);

function summary(name, context) {
  const state = context.state;
  if (name === "bash") {
    const ms = context.durationMs ?? ((state.endedAt ?? Date.now()) - state.startedAt);
    return Number.isFinite(ms) ? ms < 1000 ? "<1s" : `${Math.floor(ms / 1000)}s` : "";
  }
  const result = state["pcc:result"];
  if (name !== "read" || context.isPartial || !result) return "";
  if (context.isError) return "error";
  if (result.content.some((part) => part.type === "image")) return "image";
  const text = result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
  const count = result.details?.truncation?.outputLines ?? (text ? text.split("\n").length : 0);
  return `${count} line${count === 1 ? "" : "s"}`;
}

export function compactTool(tool) {
  // Keep each native renderer's component and state across expand/collapse.
  const nativeRender = (slot, args, context) => {
    const key = `pcc:${slot}`;
    const component = tool[slot](...args, { ...context, lastComponent: context.state[key] });
    context.state[key] = component;
    return component;
  };
  return {
    ...tool,
    parameters: {
      ...tool.parameters,
      properties: {
        reasoning: {
          type: "string",
          description: "Always provide a brief user-facing goal in the user's language, not a command or path. No detailed reasoning.",
        },
        ...tool.parameters.properties,
      },
    },
    renderShell: "self",
    renderCall(args, theme, context) {
      const native = nativeRender("renderCall", [args, theme], context);
      if (tool.name === "bash") {
        context.state[BASH_ROW] = { context, theme };
        // Start Pi's existing refresh clock even before the command produces output.
        if (context.executionStarted && context.isPartial && !context.state.interval)
          nativeRender("renderResult", [{ content: [] }, { expanded: context.expanded, isPartial: true }, theme], context);
      }
      const color = context.isPartial ? "muted" : context.isError ? "error" : "success";
      const mark = context.isPartial ? "…" : context.isError ? "✗" : "✓";
      const icon = tool.name === "bash" ? "⚡" : ["read", "grep", "find", "ls"].includes(tool.name) ? "📖" : "✏️";
      const goal = stripVTControlCharacters(String(args.reasoning || args.path || args.pattern || "")).replace(/\s+/g, " ").trim();
      const label = `${theme.fg(color, mark)} ${theme.fg("toolTitle", theme.bold(`${icon} ${tool.name}`))}${goal ? ` ${theme.fg("text", goal)}` : ""}`;
      const header = {
        render(width) {
          if (width < 1) return [];
          const stats = summary(tool.name, context);
          const tail = stats ? theme.fg("muted", ` → ${stats}`) : "";
          if (visibleWidth(tail) >= width) return [theme.fg("muted", truncateToWidth(stats, width))];
          return [truncateToWidth(label, width - visibleWidth(tail)) + tail];
        },
        invalidate() {},
      };
      if (!context.expanded) return header;
      const expanded = new Container();
      expanded.addChild(header);
      expanded.addChild(native);
      return expanded;
    },
    renderResult(result, options, theme, context) {
      // Run native lifecycle updates even while hidden, including timer cleanup.
      context.state["pcc:result"] = result;
      const native = nativeRender("renderResult", [result, options, theme], context);
      return options.expanded ? native : EMPTY;
    },
  };
}

export default function compactTools(pi) {
  installBashGroups();
  const cwd = process.cwd();
  // Never read execution settings from an untrusted project during extension loading.
  const settings = SettingsManager.create(cwd, undefined, { projectTrusted: false });
  const tools = [
    createReadToolDefinition(cwd, { autoResizeImages: settings.getImageAutoResize() }),
    createBashToolDefinition(cwd, { shellPath: settings.getShellPath(), commandPrefix: settings.getShellCommandPrefix() }),
    createEditToolDefinition(cwd), createWriteToolDefinition(cwd),
    createGrepToolDefinition(cwd), createFindToolDefinition(cwd), createLsToolDefinition(cwd),
  ];
  for (const tool of tools) pi.registerTool(compactTool(tool));
}
