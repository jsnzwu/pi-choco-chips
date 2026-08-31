import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CustomEditor,
  getMarkdownTheme,
  getSettingsListTheme,
  parseSkillBlock,
  SkillInvocationMessageComponent,
  UserMessageComponent,
  VERSION
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  matchesKey,
  SettingsList,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi
} from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
const META_TYPE = "pi-choco-chips.dashboard.meta";
const TOOL_TIMING_TYPE = "pi-choco-chips.dashboard.tool-timing";
const TITLE_STATE_TYPE = "pi-choco-chips.dashboard.title-state";
const SKILL_BUNDLE_TYPE = "pi-choco-chips.skill-bundle";
const CONFIG_FILE = "pi-choco-setting.json";
const BUNDLED_CONFIG_FILE = fileURLToPath(new URL("../pi-choco-setting.json", import.meta.url));
const DETAIL_FOOTER_WIDTH = 100;
const GROUPED_EXTENSION_STATUS_KEYS = new Set(["weyaw", "mcp"]);
const WEYAW_TASK_STATUS_PATTERN = /^(TSK-\d{8}-\d{4}-[A-Za-z0-9][A-Za-z0-9-]*) · (\d+ AGT)$/;
const EMPTY_USAGE = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0
};
const DEFAULT_CONFIG = {
  version: 1,
  enabled: true,
  title: {
    autoGenerate: true,
    strategy: "model-summary",
    maxChars: 32,
    maxSourceChars: 6e3,
    maxOutputTokens: 128,
    reasoningEffort: "low",
    replaceLegacyGeneratedTitle: true,
    fallbackToProject: true,
    prompt: "Generate a concise semantic title for this coding-agent session. Reflect the primary task and current direction, not the wording of the first message. Use 4-16 Chinese characters for Chinese conversations or 3-8 words otherwise. Output only the title without quotes, markdown, labels, or ending punctuation."
  },
  header: {
    enabled: true,
    mode: "detailed",
    showVersion: true,
    showProject: true,
    showTitle: true,
    showGit: true,
    showModel: true,
    showDisplayHints: true
  },
  footer: {
    enabled: true,
    refreshIntervalMs: 1e3,
    wrapToPreserveFields: true,
    line2Visible: true,
    line3Visible: false,
    showProjectName: true,
    showFullCwd: true,
    showGeneratedTitle: true,
    showGitWorktree: true,
    showTurnNumber: true,
    showProviderAndModel: true,
    showThinkingLevel: true,
    showContextUsage: true,
    showRuntimePhase: false,
    showResponseUsage: false,
    showTurnUsage: false,
    showSessionUsage: true,
    showCacheUsage: true,
    showCost: true,
    showClock: false,
    showExtensionStatuses: true
  },
  transcript: {
    persistMetadata: true,
    compactSameTurnSpacing: true,
    turnSeparator: "line",
    timestamps: {
      absolute: true,
      includeDate: true,
      milliseconds: false,
      relative: true,
      timeZone: "local"
    },
    roles: { user: "YOU", assistant: "PI", tool: "TOOL", system: "SYSTEM", turn: "TURN" },
    thinking: {
      collapsedByDefault: true,
      hiddenLabel: "",
      showDurationInAssistantMetadata: true,
      compactSummary: true,
      summaryLabel: "THINK",
      summarySeparator: " \u203A ",
      showLineDuration: true,
      maxSummaryChars: 1200
    },
    usage: {
      response: true,
      turn: true,
      session: true,
      input: true,
      output: true,
      reasoning: true,
      cacheRead: true,
      cacheWrite: true,
      cost: true
    },
    systemEvents: {
      errorsAndRetries: true,
      compactionAndContext: true,
      modelAndSession: true,
      extensionsAndSecurity: true
    }
  },
  working: {
    enabled: true,
    showPhase: true,
    showElapsed: true,
    refreshIntervalMs: 1e3,
    indicator: "dot"
  },
  git: {
    enabled: true,
    showBranch: true,
    showDirty: true,
    showAheadBehind: true,
    showStagedCount: true,
    showModifiedCount: true,
    showUntrackedCount: true,
    refreshAfterTools: true,
    refreshAfterTurn: true
  },
  tools: {
    persistTimings: true,
    showErrorRecordWhenCollapsed: true,
    maxErrorChars: 4e3
  },
  controls: {
    registerCommands: true,
    registerShortcuts: false,
    watchConfig: false,
    reloadRequiredAfterConfigChange: true
  }
};
function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}
function deepMerge(base, overlay) {
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = result[key];
    if (current && typeof current === "object" && !Array.isArray(current) && value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = deepMerge(current, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
function readDashboardOverlay(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("root setting must be an object");
  }
  const dashboard = parsed.dashboard;
  if (!dashboard || typeof dashboard !== "object" || Array.isArray(dashboard)) {
    throw new Error("dashboard setting must be an object");
  }
  return dashboard;
}
function loadConfig() {
  let config = DEFAULT_CONFIG;
  const errors = [];
  try {
    config = deepMerge(config, readDashboardOverlay(BUNDLED_CONFIG_FILE));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`${BUNDLED_CONFIG_FILE}: ${message}`);
  }
  const path = join(agentDir(), CONFIG_FILE);
  try {
    config = deepMerge(config, readDashboardOverlay(path));
  } catch (error) {
    const code = error.code;
    if (code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${path}: ${message}`);
    }
  }
  return errors.length ? { config, error: errors.join("; ") } : { config };
}
function writeDashboardConfig(config) {
  const path = join(agentDir(), CONFIG_FILE);
  let root = { version: 1 };
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("root setting must be an object");
    }
    root = parsed;
  }
  if (root.version === void 0) root.version = 1;
  root.dashboard = config;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`, "utf8");
}
function cloneUsage() {
  return { ...EMPTY_USAGE };
}
function normalizeUsage(usage) {
  if (!usage) return cloneUsage();
  return {
    input: usage.input || 0,
    output: usage.output || 0,
    reasoning: usage.reasoning || 0,
    cacheRead: usage.cacheRead || 0,
    cacheWrite: usage.cacheWrite || 0,
    cost: usage.cost?.total || 0
  };
}
function addUsage(target, value) {
  target.input += value.input;
  target.output += value.output;
  target.reasoning += value.reasoning;
  target.cacheRead += value.cacheRead;
  target.cacheWrite += value.cacheWrite;
  target.cost += value.cost;
}
function sumSessionUsage(ctx) {
  const total = cloneUsage();
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message") {
      const message = entry.message;
      if (message.role === "assistant") addUsage(total, normalizeUsage(message.usage));
      if (message.role === "toolResult" && message.usage) addUsage(total, normalizeUsage(message.usage));
    } else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
      addUsage(total, normalizeUsage(entry.usage));
    } else if (entry.type === "custom" && entry.customType === TITLE_STATE_TYPE) {
      const state = entry.data;
      if (state?.usage) addUsage(total, state.usage);
    }
  }
  return total;
}
function pad(value, width = 2) {
  return String(value).padStart(width, "0");
}
function formatAbsolute(timestamp, config) {
  const date = new Date(timestamp);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  const millis = config.transcript.timestamps.milliseconds ? `.${pad(date.getMilliseconds(), 3)}` : "";
  if (!config.transcript.timestamps.includeDate) return `${time}${millis}`;
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())} ${time}${millis}`;
}
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0.0s";
  if (ms < 1e4) return `${(ms / 1e3).toFixed(1)}s`;
  const total = Math.round(ms / 1e3);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = total % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds) parts.push(`${seconds}s`);
  return parts.join(" ");
}
function compactThinkingLine(value) {
  return value.replace(/^#{1,6}\s+/, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/^[-*+]\s+/, "").replace(/\s+/g, " ").trim();
}
function thinkingTextLines(message) {
  const lines = [];
  for (const content of message.content) {
    if (content.type !== "thinking" || !content.thinking.trim()) continue;
    for (const value of content.thinking.split(/\n\s*\n|\n+/)) {
      const compact = compactThinkingLine(value);
      if (compact) lines.push(compact);
    }
  }
  return lines;
}
function clipText(value, maxChars) {
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}\u2026`;
}
function formatRelative(ms) {
  return `+${formatDuration(ms)}`;
}
function formatTokens(value) {
  const abs = Math.abs(value);
  if (abs < 1e3) return String(Math.round(value));
  if (abs < 1e6) return `${(value / 1e3).toFixed(abs < 1e4 ? 1 : 0)}K`;
  return `${(value / 1e6).toFixed(abs < 1e7 ? 2 : 1)}M`;
}
function formatCost(value) {
  return `$${value.toFixed(1)}`;
}
function metricText(theme, label, value, valueColor = "text") {
  const zero = /^0(?:\.0+)?(?:[a-z%]*)?$/i.test(value);
  return `${theme.fg("muted", label)}${theme.fg(zero ? "dim" : valueColor, value)}`;
}
function cacheHitRatePart(usage, theme, statusBar = false) {
  const denominator = usage.input + usage.cacheRead;
  if (denominator <= 0) return void 0;
  const hitRate = Math.round(usage.cacheRead / denominator * 100);
  const hitColor = hitRate >= 80 ? "success" : hitRate >= 50 ? "warning" : "error";
  return metricText(theme, "CH", `${hitRate}%`, statusBar ? "muted" : hitColor);
}
function usageParts(usage, config, theme, statusBar = false, showCacheHitRate = true) {
  const fields = config.transcript.usage;
  const result = [];
  const valueColor = (color) => statusBar ? "muted" : color;
  if (fields.input) result.push(metricText(theme, "\u2191", formatTokens(usage.input), valueColor("text")));
  if (fields.output) result.push(metricText(theme, "\u2193", formatTokens(usage.output), valueColor("text")));
  if (fields.reasoning && usage.reasoning > 0) {
    result.push(metricText(theme, "Q", formatTokens(usage.reasoning), valueColor("text")));
  }
  if (fields.cacheRead) result.push(metricText(theme, "R", formatTokens(usage.cacheRead), valueColor("text")));
  if (fields.cacheWrite) result.push(metricText(theme, "W", formatTokens(usage.cacheWrite), valueColor("text")));
  if (fields.cacheRead && showCacheHitRate) {
    const cacheHitRate = cacheHitRatePart(usage, theme, statusBar);
    if (cacheHitRate) result.push(cacheHitRate);
  }
  if (fields.cost) {
    const cost = formatCost(usage.cost);
    result.push(metricText(theme, "$", cost.slice(1), valueColor("accent")));
  }
  return result;
}
function timeParts(timestamp, relativeMs, config) {
  const result = [];
  if (config.transcript.timestamps.absolute) result.push(formatAbsolute(timestamp, config));
  if (config.transcript.timestamps.relative) result.push(formatRelative(relativeMs));
  return result;
}
function userText(message) {
  if (typeof message.content === "string") return message.content;
  return message.content.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join(" ");
}
function generateTitle(text, maxChars) {
  const normalized = text.replace(/```[\s\S]*?```/g, " ").replace(/https?:\/\/\S+/g, " ").replace(/[`*_#>\[\](){}]/g, " ").replace(/\s+/g, " ").trim();
  const firstClause = normalized.split(/[。！？!?\n]/, 1)[0]?.trim() || normalized;
  const chars = Array.from(firstClause);
  return chars.length <= maxChars ? firstClause : `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}\u2026`;
}
function assistantText(message) {
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join(" ").replace(/\s+/g, " ").trim();
}
function buildTitleSource(ctx, maxChars) {
  const sections = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user") {
      const text = userText(message).replace(/\s+/g, " ").trim();
      if (text) sections.push(`User: ${clipText(text, 1600)}`);
    } else if (message.role === "assistant") {
      const text = assistantText(message);
      if (text) sections.push(`Assistant: ${clipText(text, 1600)}`);
    }
  }
  const conversation = sections.join("\n");
  const chars = Array.from(conversation);
  if (chars.length <= maxChars) return conversation;
  const headLength = Math.floor(maxChars / 3);
  const tailLength = Math.max(0, maxChars - headLength - 24);
  return `${chars.slice(0, headLength).join("")}
[earlier turns omitted]
${chars.slice(-tailLength).join("")}`;
}
function sanitizeModelTitle(text, maxChars) {
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  const cleaned = firstLine.replace(/^(?:title|session|标题|会话标题)\s*[:：-]\s*/i, "").replace(/^["'“”‘’`]+|["'“”‘’`。！？!?.,，；;：:]+$/g, "").trim();
  return generateTitle(cleaned, maxChars);
}
function styledGitText(state, config, theme, statusBar = false) {
  if (!state.available) return theme.fg("dim", "not-a-repo");
  const parts = [];
  const dirty = state.staged + state.modified + state.untracked > 0;
  const countColor = statusBar ? "muted" : "warning";
  if (config.git.showBranch) {
    const branch = state.branch || "detached";
    parts.push(theme.fg("accent", dirty ? `${branch}*` : branch));
  }
  if (config.git.showAheadBehind && (state.ahead || state.behind)) {
    parts.push(metricText(theme, "\u2191", String(state.ahead), countColor));
    parts.push(metricText(theme, "\u2193", String(state.behind), countColor));
  }
  if (config.git.showStagedCount) parts.push(metricText(theme, "S", String(state.staged), countColor));
  if (config.git.showModifiedCount) parts.push(metricText(theme, "M", String(state.modified), countColor));
  if (config.git.showUntrackedCount) parts.push(metricText(theme, "?", String(state.untracked), countColor));
  return parts.join(" ");
}
function footerStatusLines(status) {
  if (typeof status !== "string") return [];
  return status.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
}
function extensionStatusGroups(statuses) {
  const groups = [];
  let groupedStatusesAdded = false;
  for (const [key, status] of statuses) {
    if (GROUPED_EXTENSION_STATUS_KEYS.has(key)) {
      if (groupedStatusesAdded) continue;
      groupedStatusesAdded = true;
      const groupedLines = [...GROUPED_EXTENSION_STATUS_KEYS]
        .map((groupedKey) => footerStatusLines(statuses.get(groupedKey)))
        .filter((lines) => lines.length > 0);
      const firstLines = groupedLines.map((lines) => lines[0]);
      if (firstLines.length > 0) groups.push(firstLines);
      for (const lines of groupedLines) {
        groups.push(...lines.slice(1).map((line) => [line]));
      }
      continue;
    }
    groups.push(...footerStatusLines(status).map((line) => [line]));
  }
  return groups;
}
function groupedExtensionStatusIndex(statuses) {
  const hasGroupedStatus = [...GROUPED_EXTENSION_STATUS_KEYS]
    .some((key) => footerStatusLines(statuses.get(key)).length > 0);
  if (!hasGroupedStatus) return -1;

  let index = 0;
  for (const [key, status] of statuses) {
    if (GROUPED_EXTENSION_STATUS_KEYS.has(key)) return index;
    index += footerStatusLines(status).length;
  }
  return -1;
}
function packFooterParts(parts, width, divider) {
  const columns = Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : 1;
  const rows = [];
  let row = "";
  for (const part of parts) {
    if (typeof part !== "string" || visibleWidth(part) === 0) continue;
    const candidate = row ? `${row}${divider}${part}` : part;
    if (row && visibleWidth(candidate) > columns) {
      rows.push(truncateToWidth(row, columns, "…"));
      row = part;
    } else {
      row = candidate;
    }
  }
  if (row) rows.push(truncateToWidth(row, columns, "…"));
  return rows;
}
function packGroupedExtensionStatus(parts, width, divider) {
  const match = parts[0]?.match(WEYAW_TASK_STATUS_PATTERN);
  if (!match) return packFooterParts(parts, width, divider);

  const columns = Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : 1;
  const title = match[1];
  const tailParts = [match[2], ...parts.slice(1)]
    .filter((part) => typeof part === "string" && visibleWidth(part) > 0);
  const tail = tailParts.join(divider);
  const titleBudget = columns - visibleWidth(tail) - visibleWidth(divider);
  if (titleBudget > 0) {
    return [`${truncateToWidth(title, titleBudget, "…")}${divider}${tail}`];
  }
  return [
    truncateToWidth(title, columns, "…"),
    ...packFooterParts(tailParts, columns, divider)
  ];
}
function pathPrefixLength(segments) {
  if (
    segments[0]?.toLowerCase() === "mnt"
    && /^[a-z]$/i.test(segments[1] || "")
    && segments[2]?.toLowerCase() === "users"
    && segments[3]
  ) return 4;
  if (segments[0]?.toLowerCase() === "home" && segments[1]) return 2;
  if (
    /^[a-z]:$/i.test(segments[0] || "")
    && segments[1]?.toLowerCase() === "users"
    && segments[2]
  ) return 3;
  return segments.length > 0 ? 1 : 0;
}
function abbreviatePathSegment(segment) {
  return segment.replace(/[^._-]+/gu, (token) => Array.from(token)[0] || "");
}
function compactPathForWidth(pathText, width, forceCompact = false) {
  const columns = Number.isFinite(width) ? Math.max(1, Math.trunc(width)) : 1;
  if (typeof pathText !== "string" || !forceCompact && visibleWidth(pathText) <= columns) return pathText;
  const separator = pathText.includes("\\") && !pathText.includes("/") ? "\\" : "/";
  const root = pathText.startsWith(separator) ? separator : "";
  const segments = pathText.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return truncateToWidth(pathText, columns, "…");
  const prefixLength = pathPrefixLength(segments);
  const tailStart = Math.max(prefixLength, segments.length - 2);
  const compactSegments = segments.map((segment, index) => (
    index >= prefixLength && index < tailStart ? abbreviatePathSegment(segment) : segment
  ));
  const compactPath = `${root}${compactSegments.join(separator)}`;
  if (visibleWidth(compactPath) <= columns) return compactPath;
  let best = truncateToWidth(segments.at(-1) || compactPath, columns, "…");
  for (let index = compactSegments.length - 1; index >= 0; index--) {
    const candidate = `…${separator}${compactSegments.slice(index).join(separator)}`;
    if (visibleWidth(candidate) > columns) break;
    best = candidate;
  }
  return best;
}
function parseGitStatus(output) {
  const state = {
    available: true,
    branch: "detached",
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    untracked: 0
  };
  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      state.branch = line.slice("# branch.head ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      const match = line.match(/\+(\d+)\s+-(\d+)/);
      if (match) {
        state.ahead = Number(match[1]);
        state.behind = Number(match[2]);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ") || line.startsWith("u ")) {
      const xy = line.split(" ")[1] || "..";
      if (xy[0] && xy[0] !== ".") state.staged++;
      if (xy[1] && xy[1] !== ".") state.modified++;
    } else if (line.startsWith("? ")) {
      state.untracked++;
    }
  }
  return state;
}
function levelColor(theme, level) {
  if (level === "error") return (text) => theme.fg("error", text);
  if (level === "warning") return (text) => theme.fg("warning", text);
  if (level === "success") return (text) => theme.fg("success", text);
  return (text) => theme.fg("dim", text);
}
function separatorLine(label, width, theme) {
  if (width <= 0) return "";
  const decorated = ` ${label} `;
  const labelWidth = visibleWidth(decorated);
  if (labelWidth >= width) return truncateToWidth(theme.fg("dim", decorated), width, "");
  const remaining = width - labelWidth;
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return theme.fg("dim", `${"\u2500".repeat(left)}${decorated}${"\u2500".repeat(right)}`);
}
function renderMeta(meta, width, theme, config, thinkingSummaryVisible) {
  const rail = theme.fg("borderMuted", " \u2502 ");
  const lines = [];
  if (meta.kind === "user") {
    const time2 = timeParts(meta.timestamp, meta.relativeMs, config).join(" \xB7 ");
    lines.push(separatorLine(`${config.transcript.roles.turn} ${meta.turn} \xB7 ${time2}`, width, theme));
    const thinkingColor = theme.getThinkingBorderColor(meta.thinkingLevel || "off");
    const prefix = thinkingColor(`${config.transcript.roles.user} #${meta.turn}`);
    lines.push(...wrapTextWithAnsi(`${prefix}${rail}${theme.fg("dim", time2)}`, Math.max(1, width)));
    return lines;
  }
  if (meta.kind === "assistant") {
    const time2 = timeParts(meta.timestamp, meta.relativeMs, config).join(" ");
    const role2 = `${config.transcript.roles.assistant} #${meta.turn}.${meta.segment || 1}`;
    const model = [meta.provider, meta.model].filter(Boolean).join("/");
    const stats = [];
    if (model) stats.push(theme.fg("text", model));
    if (meta.thinkingLevel) stats.push(theme.fg("muted", meta.thinkingLevel));
    if (meta.totalMs !== void 0) stats.push(theme.fg("text", formatDuration(meta.totalMs)));
    if (config.transcript.thinking.showDurationInAssistantMetadata && !config.transcript.thinking.compactSummary && meta.thinkingMs !== void 0) {
      stats.push(`think ${formatDuration(meta.thinkingMs)}`);
    }
    if (meta.usage && config.transcript.usage.response) stats.push(...usageParts(meta.usage, config, theme));
    if (meta.stopReason && meta.stopReason !== "stop" && meta.stopReason !== "toolUse") {
      stats.push(theme.fg("error", meta.stopReason));
    }
    const text = `${theme.fg("text", role2)}${rail}${theme.fg("dim", time2)}${rail}${stats.join(" ")}`;
    lines.push(...wrapTextWithAnsi(text, Math.max(1, width)));
    if (thinkingSummaryVisible && config.transcript.thinking.compactSummary && meta.thinkingLines?.length) {
      const items = meta.thinkingLines.map(
        (line) => config.transcript.thinking.showLineDuration ? `${line.text} \xB7 ${formatDuration(line.durationMs)}` : line.text
      );
      const summary = clipText(
        items.join(config.transcript.thinking.summarySeparator),
        config.transcript.thinking.maxSummaryChars
      );
      const total = meta.thinkingMs === void 0 ? "" : ` ${formatDuration(meta.thinkingMs)}`;
      const heading2 = theme.fg("thinkingText", `${config.transcript.thinking.summaryLabel}${total}`);
      lines.push(...wrapTextWithAnsi(`${heading2}${rail}${theme.fg("thinkingText", summary)}`, Math.max(1, width)));
    }
    return lines;
  }
  if (meta.kind === "turn") {
    const time2 = timeParts(meta.timestamp, meta.relativeMs, config).join(" \xB7 ");
    const stats = [
      `${theme.fg("muted", "total ")}${theme.fg("text", formatDuration(meta.totalMs))}`,
      ...usageParts(meta.usage, config, theme),
      `${theme.fg("muted", "tools ")}${theme.fg("text", String(meta.toolCount))}`
    ];
    if (meta.toolErrors) stats.push(`${theme.fg("muted", "errors ")}${theme.fg("error", String(meta.toolErrors))}`);
    const prefix = theme.fg(meta.toolErrors ? "warning" : "success", `${config.transcript.roles.turn} #${meta.turn}`);
    return wrapTextWithAnsi(`${prefix}${rail}${theme.fg("dim", time2)}${rail}${stats.join(" \xB7 ")}`, Math.max(1, width));
  }
  const system = meta;
  const color = levelColor(theme, system.level);
  const time = timeParts(system.timestamp, system.relativeMs, config).join(" \xB7 ");
  const role = system.kind === "tool-error" ? config.transcript.roles.tool : config.transcript.roles.system;
  const heading = `${role} \xB7 ${system.label}`;
  const first = `${color(heading)}${rail}${theme.fg("dim", time)}`;
  lines.push(...wrapTextWithAnsi(first, Math.max(1, width)));
  if (system.text) lines.push(...wrapTextWithAnsi(color(system.text), Math.max(1, width)));
  return lines;
}
function outputText(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return "Tool execution failed";
  return content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text || "").join("\n").trim() || "Tool execution failed";
}
const COMPACT_SPACING_STATE = /* @__PURE__ */ Symbol.for("pi-choco-chips.dashboard.compact-spacing");
function visuallyBlank(line) {
  return line.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim().length === 0;
}
function stripAnsiText(value) {
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}
function replacePlainRange(line, start, length, replacement) {
  let plainIndex = 0;
  let rawStart = -1;
  let rawEnd = -1;
  for (let index = 0; index < line.length; ) {
    const ansi = line.slice(index).match(/^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/)?.[0];
    if (ansi) {
      index += ansi.length;
      continue;
    }
    if (plainIndex === start) rawStart = index;
    plainIndex += 1;
    index += 1;
    if (plainIndex === start + length) {
      rawEnd = index;
      break;
    }
  }
  if (rawStart < 0 || rawEnd < 0) return line;
  return `${line.slice(0, rawStart)}${replacement}${line.slice(rawEnd)}`;
}
const SHELL_CONTROL_KEYWORDS = /* @__PURE__ */ new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "in", "do", "done", "case", "esac", "select", "function"]);
function shellCommandRanges(line) {
  const ranges = [];
  const pattern = /(?:^|&&|\|\||[;|&]\s*(?:(?:then|do|else|elif)\b\s*)?|\b(?:then|do|else|elif)\b)\s*(?:[{(]\s*)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*([A-Za-z_./~][A-Za-z0-9_./~-]*)/g;
  for (const match of line.matchAll(pattern)) {
    const command = match[1];
    if (!command || SHELL_CONTROL_KEYWORDS.has(command)) continue;
    const start = (match.index ?? 0) + match[0].lastIndexOf(command);
    ranges.push([start, start + command.length]);
  }
  return ranges;
}
function shellPathRanges(line) {
  const ranges = [];
  const pattern = /'(?:[^']*)'|"(?:\\.|[^"\\])*"|[^\s;&|<>]+/g;
  for (const match of line.matchAll(pattern)) {
    const token = match[0];
    if (token.startsWith("'") || token.startsWith('"')) continue;
    const pathStart = token.lastIndexOf("=") + 1;
    const path = token.slice(pathStart);
    if (!path.includes("/")) continue;
    const start = (match.index ?? 0) + pathStart;
    ranges.push([start, start + path.length]);
  }
  return ranges;
}
function shellStringRanges(line) {
  const ranges = [];
  const pattern = /'(?:[^']*)'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g;
  for (const match of line.matchAll(pattern)) {
    const start = match.index ?? 0;
    ranges.push([start, start + match[0].length]);
  }
  return ranges;
}
function shellOptionRanges(line) {
  const ranges = [];
  const pattern = /'(?:[^']*)'|"(?:\\.|[^"\\])*"|(?:^|\s)(-{1,2}[A-Za-z0-9][A-Za-z0-9_.=-]*)/g;
  for (const match of line.matchAll(pattern)) {
    const option = match[1];
    if (!option) continue;
    const start = (match.index ?? 0) + match[0].lastIndexOf(option);
    ranges.push([start, start + option.length]);
  }
  return ranges;
}
function shellKeywordRanges(line) {
  const ranges = [];
  const pattern = /'(?:[^']*)'|"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z0-9_]*/g;
  for (const match of line.matchAll(pattern)) {
    if (!SHELL_CONTROL_KEYWORDS.has(match[0])) continue;
    const start = match.index ?? 0;
    ranges.push([start, start + match[0].length]);
  }
  return ranges;
}
function shellOperatorRanges(line) {
  const ranges = [];
  let quote;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = void 0;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    const pair = line.slice(index, index + 2);
    if (["&&", "||", ">>", "<<"].includes(pair)) {
      ranges.push([index, index + 2]);
      index += 1;
    } else if ("|;&<>".includes(char)) {
      ranges.push([index, index + 1]);
    }
  }
  return ranges;
}
function colorPlainRanges(line, ranges, openAnsi, closeAnsi = "\x1B[39m") {
  if (!ranges.length) return line;
  let result = "";
  let plainIndex = 0;
  let rangeIndex = 0;
  for (let index = 0; index < line.length; ) {
    const ansi = line.slice(index).match(/^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/)?.[0];
    if (ansi) {
      result += ansi;
      index += ansi.length;
      continue;
    }
    const range = ranges[rangeIndex];
    if (range && plainIndex === range[0]) result += openAnsi;
    result += line[index];
    plainIndex += 1;
    index += 1;
    if (range && plainIndex === range[1]) {
      result += closeAnsi;
      rangeIndex += 1;
    }
  }
  return result;
}
function sliceAnsiByPlainRange(value, start, end) {
  let prefixAnsi = "";
  let result = "";
  let plainIndex = 0;
  let collecting = false;
  for (let index = 0; index < value.length; ) {
    const ansi = value.slice(index).match(/^\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/)?.[0];
    if (ansi) {
      if (collecting) result += ansi;
      else prefixAnsi += ansi;
      index += ansi.length;
      continue;
    }
    if (!collecting && plainIndex === start) {
      result = prefixAnsi;
      collecting = true;
    }
    if (collecting && plainIndex < end) result += value[index];
    plainIndex += 1;
    index += 1;
    if (plainIndex >= end) break;
  }
  return `${result}\x1B[22m\x1B[39m`;
}
function isShellWhitespace(char) {
  return /\s/.test(char);
}
function findWrappedCommandRanges(lines, startLine, marker) {
  const significantMarker = [];
  for (let index = 0; index < marker.length; index += 1) {
    const char = marker[index];
    if (char && !isShellWhitespace(char)) significantMarker.push({ char, index });
  }
  if (!significantMarker.length) return [];
  const firstChar = significantMarker[0].char;
  for (let candidate = startLine; candidate < lines.length; candidate += 1) {
    const plain = stripAnsiText(lines[candidate]).trimEnd();
    for (let start = plain.indexOf(firstChar); start >= 0; start = plain.indexOf(firstChar, start + 1)) {
      const patches = /* @__PURE__ */ new Map();
      let markerIndex = 0;
      let matched = true;
      for (let lineIndex = candidate; lineIndex < lines.length && markerIndex < significantMarker.length; lineIndex += 1) {
        const rendered = stripAnsiText(lines[lineIndex]).trimEnd();
        let renderedIndex = lineIndex === candidate ? start : 0;
        while (renderedIndex < rendered.length && markerIndex < significantMarker.length) {
          const renderedChar = rendered[renderedIndex];
          if (isShellWhitespace(renderedChar)) {
            renderedIndex += 1;
            continue;
          }
          const expected = significantMarker[markerIndex];
          if (renderedChar !== expected.char) {
            matched = false;
            break;
          }
          const patch = patches.get(lineIndex);
          if (patch) {
            patch.length = renderedIndex + 1 - patch.start;
            patch.markerLength = expected.index + 1 - patch.markerStart;
          } else {
            patches.set(lineIndex, {
              line: lineIndex,
              start: renderedIndex,
              length: 1,
              markerStart: expected.index,
              markerLength: 1
            });
          }
          markerIndex += 1;
          renderedIndex += 1;
        }
        if (!matched) break;
      }
      if (matched && markerIndex === significantMarker.length) return [...patches.values()];
    }
  }
  return [];
}
function styleCodexCommandLines(lines, command, theme) {
  const commandLines = command.split(/\r?\n/).map((line) => line.replace(/\t/g, "   "));
  const plainAnsi = theme.getFgAnsi("dim");
  const pathAnsi = theme.getFgAnsi("syntaxFunction");
  const stringAnsi = theme.getFgAnsi("syntaxString");
  const keywordAnsi = theme.getFgAnsi("syntaxKeyword");
  const commandAnsi = theme.getFgAnsi("syntaxVariable");
  const closeAnsi = plainAnsi;
  let heredocDelimiter;
  const highlighted = commandLines.map((rawLine) => {
    const plainCode = `${plainAnsi}${rawLine}\x1B[39m`;
    if (heredocDelimiter) {
      if (rawLine.trim() === heredocDelimiter) heredocDelimiter = void 0;
      return plainCode;
    }
    let styled = colorPlainRanges(plainCode, shellPathRanges(rawLine), pathAnsi, closeAnsi);
    styled = colorPlainRanges(styled, shellStringRanges(rawLine), stringAnsi, closeAnsi);
    styled = colorPlainRanges(styled, shellOptionRanges(rawLine), keywordAnsi, closeAnsi);
    styled = colorPlainRanges(styled, shellKeywordRanges(rawLine), keywordAnsi, closeAnsi);
    styled = colorPlainRanges(styled, shellOperatorRanges(rawLine), keywordAnsi, closeAnsi);
    styled = colorPlainRanges(styled, shellCommandRanges(rawLine), commandAnsi, closeAnsi);
    const heredoc = rawLine.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
    if (heredoc) heredocDelimiter = heredoc[1];
    return styled;
  });
  const result = [...lines];
  let startLine = 0;
  for (let commandLineIndex = 0; commandLineIndex < commandLines.length; commandLineIndex += 1) {
    const rawCommandLine = commandLines[commandLineIndex];
    const marker = commandLineIndex === 0 ? `$ ${rawCommandLine}` : rawCommandLine;
    const code = highlighted[commandLineIndex] ?? `${plainAnsi}${rawCommandLine}\x1B[39m`;
    const styled = "\x1B[22m" + (commandLineIndex === 0 ? theme.fg("dim", "$ ") : "") + theme.fg("text", code);
    const patches = findWrappedCommandRanges(result, startLine, marker);
    if (!patches.length) continue;
    for (const patch of patches) {
      const replacement = sliceAnsiByPlainRange(
        styled,
        patch.markerStart,
        patch.markerStart + patch.markerLength
      );
      result[patch.line] = replacePlainRange(result[patch.line], patch.start, patch.length, replacement);
    }
    startLine = patches[patches.length - 1].line + 1;
  }
  return result;
}
function bashCommandsFromTool(toolName, args) {
  const name = typeof toolName === "string" ? toolName : "";
  const input = args;
  if (/(^|[.:/_-])bash$/.test(name) && typeof input?.command === "string") return [input.command];
  if (!Array.isArray(input?.tool_uses)) return [];
  return input.tool_uses.flatMap((toolUse) => {
    const child = toolUse;
    return typeof child.recipient_name === "string" && /(^|[.:/_-])bash$/.test(child.recipient_name) && typeof child.parameters?.command === "string" ? [child.parameters.command] : [];
  });
}
function assertRenderableComponent(value, componentName) {
  const candidate = value;
  if (!candidate || typeof candidate.prototype?.render !== "function") {
    throw new Error(`${componentName}.prototype.render is unavailable`);
  }
}
function installCompactSpacingPatch(enabled) {
  const registry = globalThis;
  const state = registry[COMPACT_SPACING_STATE] || { enabled, patched: false };
  state.enabled = enabled;
  registry[COMPACT_SPACING_STATE] = state;
  if (!enabled || state.patched) return void 0;
  try {
    const runtimeEntry = resolve(process.argv[1] || "pi-choco-dashboard-runtime.cjs");
    const require2 = createRequire(existsSync(runtimeEntry) ? realpathSync(runtimeEntry) : runtimeEntry);
    const packageRoot = (require2.resolve.paths("@earendil-works/pi-coding-agent") || []).map((searchPath) => join(searchPath, "@earendil-works", "pi-coding-agent")).find((candidate) => existsSync(join(candidate, "package.json")));
    if (!packageRoot) throw new Error("cannot locate @earendil-works/pi-coding-agent package root");
    const componentDir = join(packageRoot, "dist", "modes", "interactive", "components");
    const customEntryModule = require2(join(componentDir, "custom-entry.js"));
    const assistantMessageModule = require2(join(componentDir, "assistant-message.js"));
    const toolExecutionModule = require2(join(componentDir, "tool-execution.js"));
    const bashExecutionModule = require2(join(componentDir, "bash-execution.js"));
    const CustomEntryComponent = customEntryModule.CustomEntryComponent;
    const AssistantMessageComponent = assistantMessageModule.AssistantMessageComponent;
    const ToolExecutionComponent = toolExecutionModule.ToolExecutionComponent;
    const BashExecutionComponent = bashExecutionModule.BashExecutionComponent;
    assertRenderableComponent(CustomEntryComponent, "CustomEntryComponent");
    assertRenderableComponent(AssistantMessageComponent, "AssistantMessageComponent");
    assertRenderableComponent(ToolExecutionComponent, "ToolExecutionComponent");
    assertRenderableComponent(BashExecutionComponent, "BashExecutionComponent");
    const customRender = CustomEntryComponent.prototype.render;
    CustomEntryComponent.prototype.render = function(width) {
      const lines = customRender.call(this, width);
      return state.enabled && this.entry?.customType === META_TYPE && lines.length > 0 && visuallyBlank(lines[0]) ? lines.slice(1) : lines;
    };
    const assistantRender = AssistantMessageComponent.prototype.render;
    AssistantMessageComponent.prototype.render = function(width) {
      const lines = assistantRender.call(this, width);
      return state.enabled && lines.length > 0 && lines.every(visuallyBlank) ? [] : lines;
    };
    const toolRender = ToolExecutionComponent.prototype.render;
    ToolExecutionComponent.prototype.render = function(width) {
      const lines = toolRender.call(this, width);
      const theme = state.theme;
      const styled = theme ? bashCommandsFromTool(this.toolName, this.args).reduce(
        (current, command) => styleCodexCommandLines(current, command, theme),
        lines
      ) : lines;
      return state.enabled && styled.length > 0 && visuallyBlank(styled[0]) ? styled.slice(1) : styled;
    };
    const bashRender = BashExecutionComponent.prototype.render;
    BashExecutionComponent.prototype.render = function(width) {
      const lines = bashRender.call(this, width);
      const command = typeof this.command === "string" ? this.command : void 0;
      return command && state.theme ? styleCodexCommandLines(lines, command, state.theme) : lines;
    };
    state.patched = true;
    return void 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Pi Choco Chips compact transcript spacing disabled for Pi ${VERSION}: ${message}`;
  }
}
function textPartAt(content, index) {
  if (!Array.isArray(content) || typeof index !== "number" || !Number.isInteger(index) || index < 0) return void 0;
  const part = content[index];
  return part?.type === "text" && typeof part.text === "string" ? part.text : void 0;
}
function renderSkillBundle(message, expanded, outputPad, theme) {
  const details = message.details;
  if (!details || details.version !== 1 || !Array.isArray(details.skills)) return void 0;
  const markdownTheme = getMarkdownTheme();
  const container = new Container();
  let hasSection = false;
  const addSection = (component) => {
    if (hasSection) container.addChild(new Spacer(1));
    container.addChild(component);
    hasSection = true;
  };
  for (const skill of details.skills) {
    if (skill.status === "loaded") {
      const blockText = textPartAt(message.content, skill.contentIndex);
      const block = blockText ? parseSkillBlock(blockText) : null;
      if (block) {
        const component = new SkillInvocationMessageComponent(block, markdownTheme);
        component.setExpanded(expanded);
        addSection(component);
        continue;
      }
    }
    const error = skill.error || "invalid skill-bundle content";
    const errorBox = new Box(outputPad, 1, (value) => theme.bg("customMessageBg", value));
    errorBox.addChild(
      new Text(
        `${theme.fg("customMessageLabel", "[skill]")} ${skill.name} ${theme.fg("warning", `(${error})`)}`,
        0,
        0
      )
    );
    addSection(errorBox);
  }
  const userText2 = textPartAt(message.content, details.userContentIndex);
  if (userText2) addSection(new UserMessageComponent(userText2, markdownTheme, outputPad));
  return hasSection ? container : void 0;
}
function piChocoDashboard(pi: ExtensionAPI) {
  const loaded = loadConfig();
  const config = loaded.config;
  if (!config.enabled) return;
  const spacingPatchError = installCompactSpacingPatch(config.transcript.compactSameTurnSpacing);
  let activeCtx;
  let whiteEditorInstalled = false;
  let footerRender = () => {
  };
  let headerRender = () => {
  };
  let interval;
  let unsubscribeThinkingToggle;
  let gitRefreshTimer;
  let gitRefreshInFlight = false;
  let gitRefreshPending = false;
  let title = "";
  let titleGenerationInFlight = false;
  let titleGenerationAttempted = false;
  let titleGenerationComplete = false;
  let settingGeneratedTitle = false;
  let pendingGeneratedTitle;
  let titleGenerationAbort;
  let currentTurn = 0;
  let currentProvider = "";
  let currentModel = "";
  let currentThinking = "off";
  let phase = "Ready";
  let phaseStartedMono = performance.now();
  let thinkingSummaryVisible = !config.transcript.thinking.collapsedByDefault;
  let request;
  let segment;
  let lastResponse;
  let lastTurn;
  let sessionUsage = cloneUsage();
  let foregroundWorkMs = 0;
  let foregroundWorkStartedMono;
  let gitState = {
    available: false,
    branch: "",
    ahead: 0,
    behind: 0,
    staged: 0,
    modified: 0,
    untracked: 0
  };
  const toolStarts = /* @__PURE__ */ new Map();
  const appendMeta = (meta) => {
    if (config.transcript.persistMetadata) pi.appendEntry(META_TYPE, meta);
  };
  const relativeToRequest = (timestamp) => Math.max(0, timestamp - (request?.startWall || timestamp));
  const requestUiRender = () => {
    footerRender();
    headerRender();
  };
  const currentForegroundWorkMs = () => foregroundWorkMs + (foregroundWorkStartedMono === void 0 ? 0 : Math.max(0, performance.now() - foregroundWorkStartedMono));
  const startForegroundWork = () => {
    foregroundWorkStartedMono ??= performance.now();
  };
  const stopForegroundWork = () => {
    if (foregroundWorkStartedMono === void 0) return;
    foregroundWorkMs += Math.max(0, performance.now() - foregroundWorkStartedMono);
    foregroundWorkStartedMono = void 0;
  };
  const setPhase = (next) => {
    if (phase === next) return;
    phase = next;
    phaseStartedMono = performance.now();
    requestUiRender();
  };
  const updateWorkingIndicator = (ctx) => {
    if (!config.working.enabled) return;
    const thinkingColor = ctx.ui.theme.getThinkingBorderColor(currentThinking);
    ctx.ui.setWorkingIndicator({ frames: [thinkingColor("\u25CF")] });
  };
  const appendSystem = (label, text, level = "info", timestamp = Date.now()) => {
    appendMeta({
      kind: "system",
      timestamp,
      relativeMs: relativeToRequest(timestamp),
      level,
      label,
      text
    });
  };
  const maybeGenerateSessionTitle = async (ctx) => {
    if (!config.title.autoGenerate || config.title.strategy !== "model-summary" || titleGenerationComplete || titleGenerationInFlight || titleGenerationAttempted || !ctx.model) {
      return;
    }
    const source = buildTitleSource(ctx, config.title.maxSourceChars);
    if (!source.trim()) return;
    titleGenerationInFlight = true;
    titleGenerationAttempted = true;
    const controller = new AbortController();
    titleGenerationAbort = controller;
    try {
      const model = ctx.model;
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey || controller.signal.aborted) return;
      const titleMessage = {
        role: "user",
        content: [{ type: "text", text: source }],
        timestamp: Date.now()
      };
      const response = await complete(
        model,
        { systemPrompt: config.title.prompt, messages: [titleMessage] },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          env: auth.env,
          signal: controller.signal,
          maxTokens: config.title.maxOutputTokens,
          reasoningEffort: config.title.reasoningEffort,
          cacheRetention: "none"
        }
      );
      if (controller.signal.aborted || response.stopReason === "aborted") return;
      const responseText = response.content.filter((part) => part.type === "text").map((part) => part.text).join(" ");
      const generated = sanitizeModelTitle(responseText, config.title.maxChars);
      if (!generated) return;
      const usage = normalizeUsage(response.usage);
      addUsage(sessionUsage, usage);
      pi.appendEntry(TITLE_STATE_TYPE, {
        name: generated,
        generatedAt: Date.now(),
        usage
      });
      settingGeneratedTitle = true;
      pendingGeneratedTitle = generated;
      title = generated;
      pi.setSessionName(generated);
      settingGeneratedTitle = false;
      titleGenerationComplete = true;
      requestUiRender();
    } catch (error) {
      if (!controller.signal.aborted && config.transcript.systemEvents.errorsAndRetries) {
        const message = error instanceof Error ? error.message : String(error);
        appendSystem("Session title", `automatic summary failed: ${message}`, "warning");
      }
    } finally {
      settingGeneratedTitle = false;
      titleGenerationInFlight = false;
      if (titleGenerationAbort === controller) titleGenerationAbort = void 0;
    }
  };
  const closeActiveThinkingLine = (nowMono = performance.now()) => {
    const active = segment?.thinkingLines.at(-1);
    if (active && active.endedMono === void 0) active.endedMono = nowMono;
  };
  const updateThinkingLines = (message, nowMono = performance.now()) => {
    if (!segment) return;
    const nextLines = thinkingTextLines(message);
    if (!nextLines.length) return;
    const tracked = segment.thinkingLines;
    for (let index = 0; index < Math.min(tracked.length, nextLines.length); index++) {
      tracked[index].text = nextLines[index];
    }
    if (nextLines.length <= tracked.length) return;
    closeActiveThinkingLine(nowMono);
    for (let index = tracked.length; index < nextLines.length; index++) {
      tracked.push({
        text: nextLines[index],
        startedMono: index === 0 ? segment.thinkingStartedMono ?? nowMono : nowMono,
        endedMono: index < nextLines.length - 1 ? nowMono : void 0
      });
    }
  };
  const closeThinking = (nowMono = performance.now()) => {
    if (!segment) return;
    if (segment.thinkingStartedMono !== void 0) {
      segment.thinkingMs += Math.max(0, nowMono - segment.thinkingStartedMono);
      segment.thinkingStartedMono = void 0;
    }
    closeActiveThinkingLine(nowMono);
  };
  const thinkingLineMetadata = (message) => {
    if (!segment) return [];
    const finalLines = thinkingTextLines(message);
    if (!segment.thinkingLines.length) {
      const durationMs = finalLines.length ? segment.thinkingMs / finalLines.length : 0;
      return finalLines.map((text) => ({ text, durationMs }));
    }
    for (let index = 0; index < Math.min(segment.thinkingLines.length, finalLines.length); index++) {
      segment.thinkingLines[index].text = finalLines[index];
    }
    const metadata = segment.thinkingLines.map((line) => ({
      text: line.text,
      durationMs: Math.max(0, (line.endedMono ?? performance.now()) - line.startedMono)
    }));
    if (metadata.some((line) => line.durationMs < 1) && segment.thinkingMs > 0) {
      const known = metadata.reduce((sum, line) => sum + line.durationMs, 0);
      const zeroLines = metadata.filter((line) => line.durationMs < 1);
      const remaining = Math.max(0, segment.thinkingMs - known);
      if (remaining > 0 && zeroLines.length) {
        const share = remaining / zeroLines.length;
        for (const line of zeroLines) line.durationMs = share;
      } else {
        const share = segment.thinkingMs / metadata.length;
        for (const line of metadata) line.durationMs = share;
      }
    }
    return metadata;
  };
  const requestHasActivity = (value) => value.segment > 0 || value.toolCount > 0 || value.usage.input > 0 || value.usage.output > 0 || value.usage.cacheRead > 0 || value.usage.cacheWrite > 0 || value.usage.cost > 0;
  const finalizeRequest = (timestamp = Date.now()) => {
    if (!request || request.summarized) return;
    if (!requestHasActivity(request)) {
      request.summarized = true;
      return;
    }
    closeThinking();
    const summary = {
      kind: "turn",
      timestamp,
      relativeMs: Math.max(0, timestamp - request.startWall),
      turn: request.turn,
      totalMs: Math.max(0, performance.now() - request.startMono),
      usage: { ...request.usage },
      toolCount: request.toolCount,
      toolErrors: request.toolErrors,
      activeMs: foregroundWorkMs
    };
    request.summarized = true;
    lastTurn = summary;
    appendMeta(summary);
    requestUiRender();
  };
  const refreshGit = async (ctx) => {
    if (!config.git.enabled) return;
    if (gitRefreshInFlight) {
      gitRefreshPending = true;
      return;
    }
    gitRefreshInFlight = true;
    try {
      const result = await pi.exec(
        "git",
        ["status", "--porcelain=v2", "--branch", "--untracked-files=normal"],
        { cwd: ctx.cwd, timeout: 4e3 }
      );
      gitState = result.code === 0 ? parseGitStatus(result.stdout) : { ...gitState, available: false };
    } catch {
      gitState = { ...gitState, available: false };
    } finally {
      gitRefreshInFlight = false;
      requestUiRender();
      if (gitRefreshPending) {
        gitRefreshPending = false;
        void refreshGit(ctx);
      }
    }
  };
  const scheduleGitRefresh = (ctx, delay = 150) => {
    if (!config.git.enabled) return;
    if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
    gitRefreshTimer = setTimeout(() => {
      gitRefreshTimer = void 0;
      void refreshGit(ctx);
    }, delay);
  };
  const restoreState = (ctx) => {
    currentTurn = 0;
    lastResponse = void 0;
    lastTurn = void 0;
    foregroundWorkMs = 0;
    foregroundWorkStartedMono = void 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === META_TYPE) {
        const data = entry.data;
        if (data && (data.kind === "user" || data.kind === "assistant" || data.kind === "turn")) {
          currentTurn = Math.max(currentTurn, data.turn);
        }
        if (data?.kind === "assistant" && data.usage) {
          lastResponse = {
            usage: { ...data.usage },
            totalMs: data.totalMs || 0,
            thinkingMs: data.thinkingMs || 0,
            model: [data.provider, data.model].filter(Boolean).join("/")
          };
        }
        if (data?.kind === "turn") {
          lastTurn = data;
          foregroundWorkMs = Math.max(foregroundWorkMs, data.activeMs || 0);
        }
      }
    }
    const branch = ctx.sessionManager.getBranch();
    sessionUsage = sumSessionUsage(ctx);
    title = ctx.sessionManager.getSessionName() || "";
    const firstUser = branch.find((entry) => entry.type === "message" && entry.message.role === "user");
    const legacyGeneratedTitle = firstUser?.type === "message" && firstUser.message.role === "user" ? generateTitle(userText(firstUser.message), config.title.maxChars) : "";
    let generatedState;
    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === TITLE_STATE_TYPE) {
        generatedState = entry.data;
      }
    }
    titleGenerationComplete = Boolean(
      generatedState?.name && generatedState.name === title || title && (!config.title.replaceLegacyGeneratedTitle || title !== legacyGeneratedTitle)
    );
    titleGenerationAttempted = false;
    if (!title && config.title.fallbackToProject) title = basename(ctx.cwd);
    currentProvider = ctx.model?.provider || "";
    currentModel = ctx.model?.id || "";
    currentThinking = ctx.thinkingLevel || pi.getThinkingLevel();
  };
  const installHeader = (ctx) => {
    if (!config.header.enabled || ctx.mode !== "tui") return;
    ctx.ui.setHeader((tui, theme) => {
      headerRender = () => tui.requestRender();
      return {
        invalidate() {
        },
        render(width) {
          const label = (value) => theme.fg("muted", value.padEnd(8));
          const lines = [];
          if (config.header.showVersion) lines.push(`${label("Pi")} ${theme.fg("accent", VERSION)} \xB7 dashboard v${config.version}`);
          if (config.header.showProject) lines.push(`${label("Project")} ${ctx.cwd}`);
          if (config.header.showTitle) lines.push(`${label("Title")} ${title || basename(ctx.cwd)}`);
          if (config.header.showGit) lines.push(`${label("Git")} ${styledGitText(gitState, config, theme)}`);
          if (config.header.showModel) {
            lines.push(`${label("Model")} ${currentProvider}/${currentModel} \xB7 ${currentThinking}`);
          }
          if (config.header.showDisplayHints) {
            lines.push(`${label("Display")} Ctrl+O tools \xB7 Ctrl+T thinking`);
          }
          return lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
        },
        dispose() {
          headerRender = () => {
          };
        }
      };
    });
  };
  const footerUsageText = (label, usage, theme) => {
    const prefix = label ? `${theme.fg("muted", `${label} `)}` : "";
    if (!usage) return `${prefix}${theme.fg("dim", "\u2014")}`;
    return `${prefix}${usageParts(usage, config, theme, true).join(" ")}`;
  };
  const installWhiteEditor = (ctx) => {
    if (ctx.mode !== "tui" || ctx.ui.getEditorComponent() !== void 0) return;
    ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
      const thinkingBorder = () => ctx.ui.theme.getThinkingBorderColor(currentThinking);
      class WhiteBorderEditor extends CustomEditor {
        render(width) {
          this.borderColor = thinkingBorder();
          return super.render(width);
        }
      }
      return new WhiteBorderEditor(tui, { ...editorTheme, borderColor: thinkingBorder() }, keybindings);
    });
    whiteEditorInstalled = true;
  };
  const installFooter = (ctx) => {
    if (!config.footer.enabled || ctx.mode !== "tui") return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => {
        scheduleGitRefresh(ctx, 0);
        tui.requestRender();
      });
      footerRender = () => tui.requestRender();
      return {
        invalidate() {
        },
        render(width) {
          const detail = width >= DETAIL_FOOTER_WIDTH;
          const divider = theme.fg("borderMuted", " \xB7 ");
          const displayedCwd = compactPathForWidth(ctx.cwd, width - (detail ? 4 : 0), !detail);
          const line1 = [];
          const line2 = [];
          const line3 = [];
          const line4 = [];
          const thinkingColor = theme.getThinkingBorderColor(currentThinking);
          const context = ctx.getContextUsage();
          const contextPercent = context ? context.percent === null ? "?" : `${Math.round(context.percent)}%` : void 0;
          if (config.footer.showGeneratedTitle) {
            line1.push(thinkingColor(theme.bold(title || basename(ctx.cwd))));
          }
          if (config.footer.showProviderAndModel) {
            const model = `${currentProvider}/${currentModel}`;
            const thinking = config.footer.showThinkingLevel ? `\xB7${currentThinking}` : "";
            line1.push(thinkingColor(theme.bold(`${model}${thinking}`)));
          }
          if (detail && contextPercent !== void 0) {
            const contextParts = [contextPercent];
            if (context) contextParts.push(formatTokens(context.contextWindow));
            if (config.footer.showCacheUsage) {
              const cacheHitRate = cacheHitRatePart(sessionUsage, theme, true);
              if (cacheHitRate) contextParts.push(cacheHitRate);
            }
            line1.push(theme.fg("muted", contextParts.join("/")));
          }
          if (detail) line1.push(theme.fg("muted", formatDuration(currentForegroundWorkMs())));
          const modelUsageParts = [];
          if (config.footer.showResponseUsage) modelUsageParts.push(footerUsageText("RESP", lastResponse?.usage, theme));
          if (config.footer.showTurnUsage) modelUsageParts.push(footerUsageText("TURN", request?.usage || lastTurn?.usage, theme));
          if (config.footer.showSessionUsage) {
            const sessionParts = usageParts(sessionUsage, config, theme, true, false);
            if (config.footer.showTurnNumber) {
              const turn = `${theme.fg("muted", "turn ")}${theme.fg("muted", String(currentTurn))}`;
              const costIndex = config.transcript.usage.cost ? sessionParts.length - 1 : -1;
              sessionParts.splice(costIndex >= 0 ? costIndex : sessionParts.length, 0, turn);
            }
            modelUsageParts.push(...sessionParts);
          } else if (config.footer.showTurnNumber) {
            modelUsageParts.push(`${theme.fg("muted", "turn ")}${theme.fg("muted", String(currentTurn))}`);
          }
          if (detail) {
            if (config.footer.showProjectName) {
              line2.push(`${theme.fg("dim", "\u{1F4C1}")} ${theme.fg("syntaxString", theme.bold(basename(ctx.cwd)))}`);
            }
            if (config.footer.showFullCwd) {
              line2.push(`${theme.fg("dim", "cwd ")}${theme.fg("dim", displayedCwd)}`);
            }
            if (config.footer.showGitWorktree) {
              line2.push(`${theme.fg("dim", "git ")}${styledGitText(gitState, config, theme, true)}`);
            }
            if (modelUsageParts.length) {
              line3.push(`${theme.fg("dim", "usage ")}${modelUsageParts.join(" ")}`);
            }
          } else if (config.footer.showFullCwd) {
            line2.push(theme.fg("dim", displayedCwd));
          }
          if (detail && config.footer.showRuntimePhase) {
            const elapsed = phase === "Ready" ? "" : ` ${formatDuration(performance.now() - phaseStartedMono)}`;
            line4.push(`${phase}${elapsed}`);
          }
          if (detail && config.footer.showClock) line4.push(formatAbsolute(Date.now(), config));
          const extensionStatuses = footerData.getExtensionStatuses();
          const extensionGroups = config.footer.showExtensionStatuses
            ? extensionStatusGroups(extensionStatuses)
            : [];
          const groupedExtensionIndex = groupedExtensionStatusIndex(extensionStatuses);
          const visibleLines = [line1];
          if (config.footer.line2Visible) visibleLines.push(line2);
          if (config.footer.line3Visible) visibleLines.push(line3);
          visibleLines.push(line4);
          const renderParts = (parts) => config.footer.wrapToPreserveFields
            ? packFooterParts(parts, width, divider)
            : wrapTextWithAnsi(parts.join(divider), Math.max(1, width));
          const dashboardRows = visibleLines
            .filter((parts) => parts.length > 0)
            .flatMap(renderParts);
          const statusRows = extensionGroups.flatMap((parts, index) => (
            index === groupedExtensionIndex
              ? packGroupedExtensionStatus(parts, width, divider)
              : renderParts(parts)
          ));
          return [...dashboardRows, ...statusRows];
        },
        dispose() {
          unsubscribe();
          footerRender = () => {
          };
        }
      };
    });
  };
  pi.registerCommand("dashboard", {
    description: "Configure Pi Choco Chips dashboard visibility",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        const message = "The dashboard settings UI is available only in TUI mode";
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
        else console.warn(`Warning: ${message}`);
        return;
      }
      await ctx.ui.custom((_tui, theme, _keybindings, done) => {
        const container = new Container();
        container.addChild(new Text(theme.fg("accent", theme.bold("Dashboard footer")), 1, 1));
        const settingsList = new SettingsList(
          [
            {
              id: "footer-line-2",
              label: "Footer line 2",
              currentValue: config.footer.line2Visible ? "visible" : "hidden",
              values: ["visible", "hidden"]
            },
            {
              id: "footer-line-3",
              label: "Footer line 3",
              currentValue: config.footer.line3Visible ? "visible" : "hidden",
              values: ["visible", "hidden"]
            }
          ],
          4,
          getSettingsListTheme(),
          (id, newValue) => {
            const key = id === "footer-line-2" ? "line2Visible" : "line3Visible";
            const previous = config.footer[key];
            config.footer[key] = newValue === "visible";
            try {
              writeDashboardConfig(config);
              requestUiRender();
            } catch (error) {
              config.footer[key] = previous;
              const message = error instanceof Error ? error.message : String(error);
              ctx.ui.notify(`Could not save dashboard settings: ${message}`, "error");
            }
          },
          () => done(void 0),
          { enableSearch: false }
        );
        container.addChild(settingsList);
        return {
          render: (width) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data) => settingsList.handleInput?.(data)
        };
      });
    }
  });
  pi.registerMessageRenderer(
    SKILL_BUNDLE_TYPE,
    (message, { expanded, outputPad }, theme) => renderSkillBundle(message, expanded, outputPad, theme)
  );
  pi.registerEntryRenderer(META_TYPE, (entry, _options, theme) => {
    if (!entry.data) return void 0;
    return {
      invalidate() {
      },
      render(width) {
        return renderMeta(entry.data, width, theme, config, thinkingSummaryVisible);
      }
    };
  });
  pi.on("session_start", async (event, ctx) => {
    activeCtx = ctx;
    const compactSpacingRegistry = globalThis;
    const compactSpacingState = compactSpacingRegistry[COMPACT_SPACING_STATE];
    if (compactSpacingState) compactSpacingState.theme = ctx.ui.theme;
    restoreState(ctx);
    await refreshGit(ctx);
    installHeader(ctx);
    installWhiteEditor(ctx);
    installFooter(ctx);
    thinkingSummaryVisible = !config.transcript.thinking.collapsedByDefault;
    unsubscribeThinkingToggle?.();
    unsubscribeThinkingToggle = ctx.mode === "tui" ? ctx.ui.onTerminalInput((data) => {
      if (!matchesKey(data, "ctrl+t")) return void 0;
      thinkingSummaryVisible = !thinkingSummaryVisible;
      requestUiRender();
      return { consume: true };
    }) : void 0;
    ctx.ui.setHiddenThinkingLabel(config.transcript.thinking.hiddenLabel);
    if (config.working.enabled) {
      ctx.ui.setWorkingVisible(true);
      updateWorkingIndicator(ctx);
    }
    if (interval) clearInterval(interval);
    const tickMs = Math.max(250, Math.min(config.footer.refreshIntervalMs, config.working.refreshIntervalMs));
    interval = setInterval(() => {
      if (!activeCtx) return;
      if (config.working.enabled && phase !== "Ready") {
        const phaseText = config.working.showPhase ? phase : "Working";
        const elapsed = config.working.showElapsed ? ` \xB7 ${formatDuration(performance.now() - phaseStartedMono)}` : "";
        activeCtx.ui.setWorkingMessage(`${phaseText}${elapsed}`);
      }
      requestUiRender();
    }, tickMs);
    if (loaded.error) ctx.ui.notify(`Pi Choco Chips dashboard config fallback: ${loaded.error}`, "warning");
    if (spacingPatchError) {
      if (ctx.hasUI) ctx.ui.notify(spacingPatchError, "warning");
      else console.warn(`Warning: ${spacingPatchError}`);
    }
    if (config.transcript.systemEvents.modelAndSession) {
      appendSystem("Session", `${event.reason} \xB7 ${title || basename(ctx.cwd)}`, "info");
    }
    void maybeGenerateSessionTitle(ctx);
  });
  pi.on("session_info_changed", (event) => {
    const generatedChange = Boolean(
      settingGeneratedTitle || pendingGeneratedTitle && event.name === pendingGeneratedTitle
    );
    if (generatedChange) {
      pendingGeneratedTitle = void 0;
      titleGenerationComplete = true;
    } else {
      titleGenerationAbort?.abort();
      titleGenerationComplete = Boolean(event.name);
      titleGenerationAttempted = false;
    }
    title = event.name || (activeCtx ? basename(activeCtx.cwd) : "");
    requestUiRender();
    if (config.transcript.systemEvents.modelAndSession) {
      appendSystem("Session title", title || "cleared", "info");
    }
  });
  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    const nowWall = Date.now();
    if (message.role === "user") {
      if (request && !request.summarized && requestHasActivity(request)) {
        finalizeRequest(message.timestamp || nowWall);
      }
      currentTurn++;
      const timestamp = message.timestamp || nowWall;
      request = {
        turn: currentTurn,
        startWall: timestamp,
        startMono: performance.now(),
        segment: 0,
        usage: cloneUsage(),
        toolCount: 0,
        toolErrors: 0,
        summarized: false
      };
      segment = void 0;
      lastResponse = void 0;
      appendMeta({
        kind: "user",
        timestamp,
        relativeMs: 0,
        turn: currentTurn,
        thinkingLevel: currentThinking
      });
      setPhase("Queued");
      return;
    }
    if (message.role === "assistant") {
      const assistant = message;
      if (!request) {
        request = {
          turn: Math.max(1, currentTurn),
          startWall: assistant.timestamp || nowWall,
          startMono: performance.now(),
          segment: 0,
          usage: cloneUsage(),
          toolCount: 0,
          toolErrors: 0,
          summarized: false
        };
      }
      if (!segment) {
        request.segment++;
        segment = {
          index: request.segment,
          startWall: assistant.timestamp || nowWall,
          startMono: performance.now(),
          thinkingMs: 0,
          thinkingLines: []
        };
      }
      const responseEndedMono = performance.now();
      updateThinkingLines(assistant, responseEndedMono);
      closeThinking(responseEndedMono);
      const thinkingLines = thinkingLineMetadata(assistant);
      const usage = normalizeUsage(assistant.usage);
      const totalMs = Math.max(0, responseEndedMono - segment.startMono);
      addUsage(request.usage, usage);
      addUsage(sessionUsage, usage);
      currentProvider = assistant.provider || currentProvider;
      currentModel = assistant.responseModel || assistant.model || currentModel;
      lastResponse = {
        usage,
        totalMs,
        thinkingMs: segment.thinkingMs,
        model: `${currentProvider}/${currentModel}`
      };
      appendMeta({
        kind: "assistant",
        timestamp: nowWall,
        relativeMs: relativeToRequest(nowWall),
        turn: request.turn,
        segment: segment.index,
        provider: assistant.provider,
        model: assistant.responseModel || assistant.model,
        thinkingLevel: currentThinking,
        totalMs,
        thinkingMs: segment.thinkingMs,
        thinkingLines,
        usage,
        stopReason: assistant.stopReason
      });
      if (config.transcript.systemEvents.errorsAndRetries && (assistant.stopReason === "error" || assistant.stopReason === "aborted" || assistant.stopReason === "length")) {
        appendSystem(
          `Assistant ${assistant.stopReason}`,
          assistant.errorMessage || assistant.rawStopReason || "The response did not finish normally.",
          assistant.stopReason === "aborted" ? "warning" : "error",
          nowWall
        );
      }
      segment = void 0;
      setPhase(assistant.stopReason === "toolUse" ? "Preparing tools" : "Settling");
      requestUiRender();
      return;
    }
    if (message.role === "toolResult") {
      const toolResult = message;
      if (toolResult.usage) {
        const nested = normalizeUsage(toolResult.usage);
        if (request) addUsage(request.usage, nested);
        addUsage(sessionUsage, nested);
      }
      requestUiRender();
    }
  });
  pi.on("before_agent_start", (_event, ctx) => {
    activeCtx = ctx;
    startForegroundWork();
    if (!request) {
      request = {
        turn: Math.max(1, currentTurn),
        startWall: Date.now(),
        startMono: performance.now(),
        segment: 0,
        usage: cloneUsage(),
        toolCount: 0,
        toolErrors: 0,
        summarized: false
      };
    }
    setPhase("Waiting for provider");
  });
  pi.on("agent_start", () => {
    startForegroundWork();
    setPhase("Starting agent");
  });
  pi.on("turn_start", (event) => {
    if (!request) return;
    request.segment++;
    segment = {
      index: request.segment,
      startWall: event.timestamp,
      startMono: performance.now(),
      thinkingMs: 0,
      thinkingLines: []
    };
    setPhase("Waiting for model");
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "assistant" && !segment && request) {
      request.segment++;
      segment = {
        index: request.segment,
        startWall: event.message.timestamp || Date.now(),
        startMono: performance.now(),
        thinkingMs: 0,
        thinkingLines: []
      };
    }
  });
  pi.on("message_update", (event) => {
    const update = event.assistantMessageEvent;
    if (!segment && request) {
      request.segment++;
      segment = {
        index: request.segment,
        startWall: Date.now(),
        startMono: performance.now(),
        thinkingMs: 0,
        thinkingLines: []
      };
    }
    if (!segment) return;
    const nowMono = performance.now();
    const streamedMessage = "partial" in update ? update.partial : update.type === "done" ? update.message : update.error;
    updateThinkingLines(streamedMessage, nowMono);
    if (update.type === "thinking_start" || update.type === "thinking_delta") {
      if (segment.thinkingStartedMono === void 0) segment.thinkingStartedMono = nowMono;
      setPhase("Thinking");
    } else if (update.type === "thinking_end") {
      closeThinking(nowMono);
      setPhase("Processing reasoning");
    } else if (update.type === "text_start" || update.type === "text_delta") {
      closeThinking(nowMono);
      setPhase("Streaming response");
    } else if (update.type === "toolcall_start" || update.type === "toolcall_delta") {
      closeThinking(nowMono);
      setPhase("Preparing tool call");
    } else if (update.type === "done" || update.type === "error") {
      closeThinking(nowMono);
    }
  });
  pi.on("tool_execution_start", (event) => {
    toolStarts.set(event.toolCallId, {
      name: event.toolName,
      startedMono: performance.now(),
      startedWall: Date.now()
    });
    const activeCount = toolStarts.size;
    setPhase(activeCount > 1 ? `Tools \xD7${activeCount}` : `Tool ${event.toolName}`);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    const started = toolStarts.get(event.toolCallId);
    toolStarts.delete(event.toolCallId);
    const endedWall = Date.now();
    const durationMs = started ? Math.max(0, performance.now() - started.startedMono) : 0;
    if (request) {
      request.toolCount++;
      if (event.isError) request.toolErrors++;
    }
    if (config.tools.persistTimings) {
      pi.appendEntry(TOOL_TIMING_TYPE, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        startedAt: started?.startedWall || endedWall,
        endedAt: endedWall,
        durationMs,
        isError: event.isError
      });
    }
    if (event.isError && config.tools.showErrorRecordWhenCollapsed) {
      const full = outputText(event.result);
      const text = Array.from(full).slice(0, config.tools.maxErrorChars).join("");
      appendMeta({
        kind: "tool-error",
        timestamp: endedWall,
        relativeMs: relativeToRequest(endedWall),
        level: "error",
        label: `${event.toolName} failed \xB7 ${formatDuration(durationMs)}`,
        text: full.length > text.length ? `${text}
\u2026 error output truncated by Pi Choco Chips dashboard` : text
      });
    }
    if (config.git.refreshAfterTools && ["bash", "edit", "write"].includes(event.toolName)) {
      scheduleGitRefresh(ctx);
    }
    setPhase(toolStarts.size ? `Tools \xD7${toolStarts.size}` : "Processing tool results");
    requestUiRender();
  });
  pi.on("turn_end", (_event, ctx) => {
    if (config.git.refreshAfterTurn) scheduleGitRefresh(ctx);
    setPhase("Continuing");
  });
  pi.on("agent_end", () => setPhase("Settling"));
  pi.on("agent_settled", (_event, ctx) => {
    stopForegroundWork();
    finalizeRequest();
    setPhase("Ready");
    ctx.ui.setWorkingMessage();
    scheduleGitRefresh(ctx, 0);
    void maybeGenerateSessionTitle(ctx);
  });
  pi.on("model_select", (event) => {
    currentProvider = event.model.provider;
    currentModel = event.model.id;
    requestUiRender();
    if (config.transcript.systemEvents.modelAndSession) {
      const previous = event.previousModel ? `${event.previousModel.provider}/${event.previousModel.id}` : "none";
      appendSystem("Model", `${previous} \u2192 ${currentProvider}/${currentModel} (${event.source})`, "info");
    }
  });
  pi.on("thinking_level_select", (event) => {
    currentThinking = event.level;
    if (activeCtx) updateWorkingIndicator(activeCtx);
    requestUiRender();
    if (config.transcript.systemEvents.modelAndSession) {
      appendSystem("Thinking level", `${event.previousLevel} \u2192 ${event.level}`, "info");
    }
  });
  pi.on("after_provider_response", (event) => {
    if (event.status >= 400 && config.transcript.systemEvents.errorsAndRetries) {
      const retryAfter = event.headers["retry-after"] ? ` \xB7 retry-after ${event.headers["retry-after"]}` : "";
      appendSystem("Provider response", `HTTP ${event.status}${retryAfter}`, event.status === 429 ? "warning" : "error");
      setPhase(event.status === 429 ? "Rate limited" : `Provider HTTP ${event.status}`);
    }
  });
  pi.on("session_before_compact", (event) => {
    setPhase(`Compacting (${event.reason})`);
  });
  pi.on("session_compact", (event, ctx) => {
    sessionUsage = sumSessionUsage(ctx);
    if (config.transcript.systemEvents.compactionAndContext) {
      appendSystem(
        "Compaction complete",
        `${event.reason} \xB7 ${formatTokens(event.compactionEntry.tokensBefore)} tokens summarized${event.fromExtension ? " \xB7 extension" : ""}`,
        "success"
      );
    }
    setPhase(event.willRetry ? "Retrying after compaction" : "Ready");
  });
  pi.on("session_tree", (event, ctx) => {
    sessionUsage = sumSessionUsage(ctx);
    if (config.transcript.systemEvents.modelAndSession) {
      appendSystem(
        "Session tree",
        `${event.oldLeafId || "root"} \u2192 ${event.newLeafId || "root"}${event.summaryEntry ? " \xB7 summarized" : ""}`,
        "info"
      );
    }
  });
  pi.on("tool_result", (event) => {
    if (!event.isError || !config.transcript.systemEvents.extensionsAndSecurity) return;
    const text = event.content.filter((item) => item.type === "text").map((item) => item.type === "text" ? item.text : "").join(" ");
    if (/permission|denied|blocked|protected|not allowed|outside.*cwd/i.test(text)) {
      appendSystem("Security gate", `${event.toolName}: ${text.slice(0, 1e3)}`, "warning");
    }
  });
  pi.on("session_shutdown", (event, ctx) => {
    stopForegroundWork();
    finalizeRequest();
    if (config.transcript.systemEvents.modelAndSession || config.transcript.systemEvents.extensionsAndSecurity) {
      appendSystem("Session shutdown", event.reason, "info");
    }
    if (interval) clearInterval(interval);
    interval = void 0;
    unsubscribeThinkingToggle?.();
    unsubscribeThinkingToggle = void 0;
    titleGenerationAbort?.abort();
    titleGenerationAbort = void 0;
    pendingGeneratedTitle = void 0;
    if (gitRefreshTimer) clearTimeout(gitRefreshTimer);
    gitRefreshTimer = void 0;
    toolStarts.clear();
    ctx.ui.setWorkingMessage();
    ctx.ui.setWorkingIndicator();
    ctx.ui.setHiddenThinkingLabel();
    if (whiteEditorInstalled) {
      ctx.ui.setEditorComponent(void 0);
      whiteEditorInstalled = false;
    }
    ctx.ui.setFooter(void 0);
    ctx.ui.setHeader(void 0);
    activeCtx = void 0;
    footerRender = () => {
    };
    headerRender = () => {
    };
  });
}
export {
  compactPathForWidth,
  extensionStatusGroups,
  packFooterParts,
  packGroupedExtensionStatus,
  piChocoDashboard as default
};
