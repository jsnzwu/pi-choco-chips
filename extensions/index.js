import { randomUUID } from "node:crypto";

import { complete } from "@earendil-works/pi-ai/compat";
import { CustomEditor, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  matchesKey,
  SettingsList,
  Text,
} from "@earendil-works/pi-tui";

import {
  createCompactionContinuation,
  createEarlyCompactionContinuation,
  EARLY_COMPACTION_INSTRUCTIONS,
  shouldCompactBeforeProvider,
} from "./compaction-continuation.js";
import { extractSkillToken, makeSkillBundle } from "./skill-references.js";

const SETTINGS_ENTRY = "pi-choco-chips:settings";
const SKILL_BUNDLE_TYPE = "pi-choco-chips.skill-bundle";
const MAX_SKILL_SUGGESTIONS = 20;
const MAX_TITLE_SOURCE_CHARS = 24_000;
const DEFAULT_FEATURES = {
  retitle: true,
  multiSkill: true,
  autocomplete: true,
  compactionContinuation: true,
};
const FEATURE_SETTINGS = [
  { id: "retitle", key: "retitle", label: "Session retitle" },
  { id: "multi-skill", key: "multiSkill", label: "Multiple skill references" },
  { id: "autocomplete", key: "autocomplete", label: "Skill autocomplete" },
  {
    id: "compact-resume",
    key: "compactionContinuation",
    label: "Resume after compaction",
  },
];

function getSkillMap(pi) {
  const skills = new Map();

  for (const command of pi.getCommands()) {
    if (command.source !== "skill" || !command.name.startsWith("skill:")) continue;

    const name = command.name.slice("skill:".length);
    const filePath = command.sourceInfo?.path;
    if (!name || !filePath) continue;

    skills.set(name, {
      name,
      filePath,
      description: command.description || "",
    });
  }

  return skills;
}

function featureStatus(features, pi, ctx) {
  const editor = ctx?.ui.getEditorComponent?.() ? "custom" : "default";
  return [
    `retitle=${features.retitle ? "on" : "off"}`,
    `multi-skill=${features.multiSkill ? "on" : "off"}`,
    `autocomplete=${features.autocomplete ? "on" : "off"}`,
    `compact-resume=${features.compactionContinuation ? "on" : "off"}`,
    `skills=${pi ? getSkillMap(pi).size : 0}`,
    `editor=${editor}`,
  ].join(" ");
}

function notify(ctx, message, type = "info") {
  if (ctx.hasUI) {
    ctx.ui.notify(message, type);
  } else {
    console.log(message);
  }
}

function restoreFeatures(ctx, features) {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== SETTINGS_ENTRY) continue;
    Object.assign(features, entry.data || {});
  }
}

function saveFeatures(pi, features) {
  pi.appendEntry(SETTINGS_ENTRY, { ...features });
}

async function showFeatureSettings(pi, features, ctx) {
  if (ctx.mode !== "tui") {
    const message = "The Pi Choco Chips settings UI is available only in TUI mode";
    notify(ctx, message, "warning");
    return;
  }

  await ctx.ui.custom((tui, theme, _keybindings, done) => {
    const items = FEATURE_SETTINGS.map((setting) => ({
      id: setting.id,
      label: setting.label,
      currentValue: features[setting.key] ? "enabled" : "disabled",
      values: ["enabled", "disabled"],
    }));
    const container = new Container();
    container.addChild(
      new Text(theme.fg("accent", theme.bold("Pi Choco Chips")), 1, 1),
    );

    const settingsList = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, newValue) => {
        const setting = FEATURE_SETTINGS.find((candidate) => candidate.id === id);
        if (!setting) return;
        features[setting.key] = newValue === "enabled";
        saveFeatures(pi, features);
      },
      () => done(undefined),
      { enableSearch: false },
    );
    container.addChild(settingsList);

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        settingsList.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function buildConversationText(ctx) {
  const sections = [];

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message") {
      const role = entry.message?.role;
      if (role !== "user" && role !== "assistant") continue;

      const text = textFromContent(entry.message.content).trim();
      if (text) sections.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
    } else if (entry.type === "compaction" || entry.type === "branch_summary") {
      if (entry.summary) sections.push(`Summary: ${entry.summary}`);
    }
  }

  const text = sections.join("\n\n");
  if (text.length <= MAX_TITLE_SOURCE_CHARS) return text;

  const head = Math.floor(MAX_TITLE_SOURCE_CHARS / 3);
  const tail = MAX_TITLE_SOURCE_CHARS - head - 64;
  return `${text.slice(0, head)}\n\n[earlier context omitted]\n\n${text.slice(-tail)}`;
}

function cleanTitle(text) {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  if (!line) return "";

  const cleaned = line
    .replace(/^(?:title|session title|标题|会话标题)\s*[:：-]\s*/i, "")
    .replace(/^[`"“”'‘’]+|[`"“”'‘’]+$/g, "")
    .replace(/[。！？!?；;，,：:]+$/u, "")
    .trim();

  return Array.from(cleaned).slice(0, 48).join("");
}

async function generateTitle(pi, ctx, extraInstruction) {
  await ctx.waitForIdle();

  const conversation = buildConversationText(ctx);
  if (!conversation.trim()) {
    notify(ctx, "No conversation text found", "warning");
    return;
  }

  const model = ctx.model;
  if (!model) {
    notify(ctx, "No model selected", "warning");
    return;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    notify(ctx, auth.ok ? `No API key for ${model.provider}` : auth.error, "warning");
    return;
  }

  const focus = extraInstruction?.trim()
    ? `\nAdditional focus: ${extraInstruction.trim()}`
    : "";
  const response = await complete(
    model,
    {
      systemPrompt:
        "Name this coding-agent session from its actual current work. Return one concise title only: 4-16 Chinese characters for Chinese conversations, or 3-8 English words otherwise. Do not use quotes, markdown, labels, or ending punctuation.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `${conversation}${focus}`,
            },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      maxTokens: 64,
      cacheRetention: "none",
      sessionId: randomUUID(),
    },
  );

  const title = cleanTitle(
    response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  );
  if (!title) {
    notify(ctx, "Model returned an empty title", "warning");
    return;
  }

  pi.setSessionName(title);
  notify(ctx, `Session renamed: ${title}`, "info");
}

function createSkillAutocompleteProvider(current, getSkills, isEnabled) {
  return {
    triggerCharacters: [...new Set([...(current.triggerCharacters || []), "$"])],

    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const line = lines[cursorLine] || "";
      const beforeCursor = line.slice(0, cursorCol);
      const token = extractSkillToken(beforeCursor);

      if (!token || !isEnabled()) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const skills = [...getSkills().values()];
      const matches = token.query
        ? fuzzyFilter(skills, token.query, (skill) => `${skill.name} ${skill.description}`)
        : skills;
      const items = matches.slice(0, MAX_SKILL_SUGGESTIONS).map((skill) => {
        const value = token.marker === "$" ? `$${skill.name}` : `/skill:${skill.name}`;
        return {
          value,
          label: value,
          description: skill.description || undefined,
        };
      });

      return items.length > 0 ? { items, prefix: token.prefix } : null;
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (!prefix.startsWith("/skill:") && !prefix.startsWith("$")) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      }

      const line = lines[cursorLine] || "";
      const beforePrefix = line.slice(0, cursorCol - prefix.length);
      const afterCursor = line.slice(cursorCol);
      const nextLines = [...lines];
      nextLines[cursorLine] = `${beforePrefix}${item.value}${afterCursor}`;

      return {
        lines: nextLines,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length,
      };
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
    },
  };
}

function shouldRequerySkillAutocomplete(data) {
  if (data === "/" || data === ":" || data === "$") return true;
  if (data.length === 1 && /[a-z0-9-]/i.test(data)) return true;

  return ["backspace", "left", "right", "home", "end"].some((key) => matchesKey(data, key));
}

class SkillEditor extends CustomEditor {
  triggerSkillAutocomplete() {
    const cursor = this.getCursor();
    const line = this.getLines()[cursor.line] || "";
    const token = extractSkillToken(line.slice(0, cursor.col));
    if (!token || this.isShowingAutocomplete()) return;

    this.tryTriggerAutocomplete?.();
  }

  handleInput(data) {
    super.handleInput(data);

    if (!shouldRequerySkillAutocomplete(data)) return;
    this.triggerSkillAutocomplete();
  }

  handlePaste(text) {
    super.handlePaste(text);
    this.triggerSkillAutocomplete();
  }
}

export default function piChocoChips(pi) {
  const features = { ...DEFAULT_FEATURES };
  const pendingBundleTimers = new Set();
  let editorFactory;
  let earlyCompactionInFlight = false;

  pi.registerCommand("retitle", {
    description: "Generate a new title from the current session",
    handler: async (args, ctx) => {
      if (!features.retitle) {
        notify(ctx, "Retitle is disabled; run /choco retitle on first", "warning");
        return;
      }

      try {
        await generateTitle(pi, ctx, args);
      } catch (error) {
        notify(ctx, `Retitle failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("choco", {
    description: "Configure Pi Choco Chips enhancements",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const first = parts[0]?.toLowerCase();

      if (!first) {
        await showFeatureSettings(pi, features, ctx);
        return;
      }

      if (first === "status") {
        notify(ctx, `Pi Choco Chips: ${featureStatus(features, pi, ctx)}`);
        return;
      }

      const featureNames = {
        retitle: "retitle",
        skills: "multiSkill",
        "multi-skill": "multiSkill",
        autocomplete: "autocomplete",
        compaction: "compactionContinuation",
        "compact-resume": "compactionContinuation",
      };

      if (first === "on" || first === "off") {
        const enabled = first === "on";
        Object.keys(features).forEach((key) => {
          features[key] = enabled;
        });
      } else {
        const feature = featureNames[first];
        const value = parts[1]?.toLowerCase();
        if (!feature || (value !== "on" && value !== "off")) {
          notify(
            ctx,
            "Usage: /choco [status|on|off|retitle on|skills on|autocomplete on|compact-resume on]",
            "warning",
          );
          return;
        }
        features[feature] = value === "on";
      }

      saveFeatures(pi, features);
      notify(ctx, `Pi Choco Chips: ${featureStatus(features, pi, ctx)}`);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreFeatures(ctx, features);

    if (ctx.mode === "tui") {
      ctx.ui.addAutocompleteProvider((current) =>
        createSkillAutocompleteProvider(
          current,
          () => getSkillMap(pi),
          () => features.autocomplete,
        ),
      );
      editorFactory = (tui, theme, keybindings) => new SkillEditor(tui, theme, keybindings);
      ctx.ui.setEditorComponent(editorFactory);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    for (const timer of pendingBundleTimers) clearTimeout(timer);
    pendingBundleTimers.clear();
    earlyCompactionInFlight = false;

    if (ctx.mode === "tui" && editorFactory && ctx.ui.getEditorComponent?.() === editorFactory) {
      ctx.ui.setEditorComponent(undefined);
    }
    editorFactory = undefined;
  });

  pi.on("context", (_event, ctx) => {
    if (earlyCompactionInFlight) return;

    const contextUsage = ctx.getContextUsage();
    if (
      !shouldCompactBeforeProvider(contextUsage, {
        enabled: features.compactionContinuation,
        agentActive: !ctx.isIdle(),
        compactionInFlight: earlyCompactionInFlight,
        hasPendingMessages: ctx.hasPendingMessages(),
      })
    ) {
      return;
    }

    earlyCompactionInFlight = true;
    ctx.abort();
    ctx.compact({
      customInstructions: EARLY_COMPACTION_INSTRUCTIONS,
      onComplete: (result) => {
        earlyCompactionInFlight = false;
        const continuation = createEarlyCompactionContinuation(contextUsage, result);
        pi.sendMessage(continuation.message, continuation.options);
        notify(ctx, "Compacted early and resumed the interrupted turn", "info");
      },
      onError: (error) => {
        earlyCompactionInFlight = false;
        notify(
          ctx,
          `Early compaction failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      },
    });
  });

  pi.on("session_compact", (event, ctx) => {
    const wasEarlyCompaction = earlyCompactionInFlight;
    const continuation = createCompactionContinuation(
      event,
      ctx.sessionManager.getBranch(),
      {
        enabled: features.compactionContinuation,
        agentActive: !ctx.isIdle(),
        compactionInFlight: wasEarlyCompaction,
        hasPendingMessages: ctx.hasPendingMessages(),
      },
    );
    if (!continuation) return;

    pi.sendMessage(continuation.message, continuation.options);
    notify(ctx, "Resuming the interrupted turn after compaction", "info");
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension" || !features.multiSkill) {
      return { action: "continue" };
    }

    const bundle = makeSkillBundle(event.text, getSkillMap(pi), {
      onError: (skill, error) => {
        notify(
          ctx,
          `Could not load /skill:${skill.name}: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      },
    });

    if (!bundle) return { action: "continue" };

    const timer = setTimeout(() => {
      pendingBundleTimers.delete(timer);
      pi.sendMessage(
        {
          customType: SKILL_BUNDLE_TYPE,
          content: [...bundle.content, ...(event.images || [])],
          display: true,
          details: bundle.details,
        },
        event.streamingBehavior
          ? { triggerTurn: true, deliverAs: event.streamingBehavior }
          : { triggerTurn: true },
      );
    }, 0);
    pendingBundleTimers.add(timer);

    return { action: "handled" };
  });
}
