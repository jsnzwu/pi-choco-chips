import { stripVTControlCharacters } from "node:util";
import { parseStreamingJson } from "@earendil-works/pi-ai";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { toolMark } from "./tool-status.ts";

const FRAMES = [".  ", ".. ", "...", ".. "];
const FIELDS = ["reasoning", "path", "command", "pattern"];
const clean = (value) => stripVTControlCharacters(String(value ?? "")).replace(/\s+/g, " ").trim();
const money = (value) => `$${value >= 0.01 ? value.toFixed(2) : value.toPrecision(2)}`;

function callArgs(call, captured, pending) {
  const exact = captured.get(call.id);
  if (exact) return exact.args;
  const preview = parseStreamingJson(call.args) ?? {};
  const keys = FIELDS.filter((key) => typeof preview[key] === "string" && preview[key]);
  // Native running records use /? until completion. Only use an unambiguous argument match.
  const matches = keys.length ? pending.filter((entry) => entry.name === call.name
    && keys.every((key) => typeof entry.args[key] === "string"
      && (call.args.endsWith("...") && preview[key].endsWith("...")
        ? entry.args[key].startsWith(preview[key].slice(0, -3)) : entry.args[key] === preview[key]))) : [];
  return matches.length === 1 ? matches[0].args : preview;
}

function callRow(call, args, mark, theme, runningColor, width) {
  if (width < 1) return [];
  const role = { running: "muted", ok: "success", error: "error", cancelled: "muted" }[call.status] ?? "muted";
  const symbol = { running: mark, ok: "✓", error: "✗", cancelled: "⊘" }[call.status] ?? "·";
  const marker = call.status === "running" ? runningColor(symbol) : theme.fg(role, symbol);
  const title = `${marker}${" ".repeat(Math.max(0, 3 - visibleWidth(symbol)))} ${theme.fg("toolTitle", theme.bold(clean(call.name)))}`;
  const goal = clean(args.reasoning || args.pattern);
  const detail = clean(args.path || args.command || (!goal ? call.args : ""));
  const duration = Number.isFinite(call.durationMs)
    ? call.durationMs < 1000 ? `${Math.round(call.durationMs)}ms` : `${(call.durationMs / 1000).toFixed(1)}s` : "";
  const stats = [duration, call.cost ? money(call.cost) : ""].filter(Boolean).join(" ");
  const tail = stats ? theme.fg("muted", ` → ${stats}`) : "";
  if (visibleWidth(tail) >= width) return [theme.fg("muted", truncateToWidth(stats, width))];
  const budget = width - visibleWidth(tail);
  const available = Math.max(0, budget - visibleWidth(title) - 1);
  const primary = goal || detail;
  const secondary = goal ? detail : "";
  const secondaryWidth = secondary ? Math.min(visibleWidth(secondary), Math.max(0,
    available - visibleWidth(primary) - 3, Math.floor((available - 3) / 2))) : 0;
  const primaryWidth = available - (secondaryWidth ? secondaryWidth + 3 : 0);
  let label = title;
  if (primary && primaryWidth > 0) label += ` ${theme.fg(goal ? "text" : "muted", truncateToWidth(primary, primaryWidth))}`;
  if (secondaryWidth) label += theme.fg("muted", ` · ${truncateToWidth(secondary, secondaryWidth)}`);
  return [truncateToWidth(label, budget) + tail];
}

export function codemodeRenderers(native, getThinkingLevel, live = new Map()) {
  return {
    ...native,
    renderResult(result, options, theme, context) {
      const calls = result.details?.calls ?? [];
      const captured = context.state["pcc:codemodeArgs"] ??= live.get(context.toolCallId) ?? new Map();
      const running = options.isPartial && context.executionStarted && !context.isError
        && calls.some((call) => call.status === "running");
      const mark = toolMark({ ...context, isPartial: running }, FRAMES);
      const runningColor = (text) => running && getThinkingLevel
        ? theme.getThinkingBorderColor(getThinkingLevel(context.toolCallId))(text) : theme.fg("muted", text);
      // Delegate script output, truncation, images, timing, and lifecycle cleanup unchanged.
      const output = native.renderResult(calls.length ? { ...result, details: { ...result.details, calls: [] } } : result,
        options, theme, { ...context, lastComponent: context.state["pcc:codemodeOutput"] });
      context.state["pcc:codemodeOutput"] = output;
      if (!calls.length) return output;
      const trace = new Container();
      trace.addChild(new Spacer(1));
      trace.addChild({
        render(width) {
          if (width < 1) return [];
          // Match Pi 1.3's native collapsed call count; output previews remain native.
          const shown = options.expanded ? calls : calls.slice(-8);
          const lines = [];
          const known = new Set(calls.map((call) => call.id));
          const pending = [...captured].filter(([id]) => !known.has(id)).map(([, entry]) => entry);
          if (shown.length < calls.length) lines.push(...new Text(
            `${theme.fg("muted", `... (${calls.length - shown.length} earlier calls,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`, 0, 0).render(width));
          for (const call of shown) {
            const args = callArgs(call, captured, pending);
            lines.push(...callRow(call, args, running ? mark : "...", theme, runningColor, width));
            if (options.expanded) {
              const details = [call.args, args.path, args.command].filter(Boolean);
              for (const detail of details) lines.push(...new Text(theme.fg("muted",
                `    ${stripVTControlCharacters(String(detail)).replace(/\n/g, "\n    ")}`), 0, 0).render(width));
              if (call.error) lines.push(...new Text(theme.fg("error", `    ${call.error.replace(/\n/g, "\n    ")}`), 0, 0).render(width));
            }
          }
          const priced = calls.filter((call) => call.cost);
          if (priced.length > 1) lines.push(...new Text(theme.fg("muted",
            `Model calls: ${money(priced.reduce((sum, call) => sum + call.cost, 0))}`), 0, 0).render(width));
          return lines;
        },
        invalidate() {},
      });
      trace.addChild(output);
      return trace;
    },
  };
}

export function installCodemodeRendering(pi) {
  if (typeof pi.registerToolRenderer !== "function") return;
  const live = new Map();
  pi.on("tool_execution_start", (event) => {
    if (event.toolName === "codemode") live.set(event.toolCallId, new Map());
    const captured = live.get(event.parentToolCallId);
    if (captured) captured.set(event.toolCallId, {
      name: event.toolName,
      args: Object.fromEntries(FIELDS.filter((key) => typeof event.args?.[key] === "string")
        .map((key) => [key, event.args[key]])),
    });
  });
  pi.on("tool_execution_end", (event) => { live.delete(event.toolCallId); });
  pi.on("session_shutdown", () => { live.clear(); });
  pi.registerToolRenderer((name, next) => {
    const native = next();
    return name === "codemode" && native?.renderResult
      ? codemodeRenderers(native, (id) => live.has(id) ? pi.getThinkingLevel() : "off", live) : native;
  });
}
