import { readFileSync } from "node:fs";
import { dirname } from "node:path";

const SKILL_REFERENCE_PATTERN =
  /(^|[^\p{L}\p{N}_-])(?:\/skill:|\$)([a-z0-9]+(?:-[a-z0-9]+)*)(?=$|[^\p{L}\p{N}_-])/gu;
const SKILL_TOKEN_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(\/skill:([a-z0-9-]*)|\$([a-z0-9-]*))$/u;
const SKILL_REMOVAL_MARKER = "\u0000";

export function stripFrontmatter(content) {
  return content
    .replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .trim();
}

export function makeSkillBlock(skill, content) {
  const body = stripFrontmatter(content);
  return [
    `<skill name="${skill.name}" location="${skill.filePath}">`,
    `References are relative to ${dirname(skill.filePath)}.`,
    "",
    body,
    "</skill>",
  ].join("\n");
}

function normalizeUserText(text) {
  return text
    .replace(/(\r?\n)([ \t]*)\u0000[ \t]?/g, "$1$2")
    .replace(/[ \t]?\u0000/g, "")
    .trim();
}

export function makeSkillBundle(text, skills, options = {}) {
  const readSkill = options.readSkill ?? ((filePath) => readFileSync(filePath, "utf8"));
  const onError = options.onError;
  const content = [];
  const skillRecords = [];
  let matched = false;

  const userText = text.replace(
    SKILL_REFERENCE_PATTERN,
    (match, boundary, name) => {
      const skill = skills.get(name);
      if (!skill) return match;

      matched = true;
      try {
        const contentIndex = content.length;
        content.push({ type: "text", text: makeSkillBlock(skill, readSkill(skill.filePath)) });
        skillRecords.push({
          name: skill.name,
          location: skill.filePath,
          status: "loaded",
          contentIndex,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        skillRecords.push({
          name: skill.name,
          location: skill.filePath,
          status: "error",
          error: message,
        });
        onError?.(skill, error);
        return match;
      }

      return boundary === " " || boundary === "\t"
        ? SKILL_REMOVAL_MARKER
        : `${boundary}${SKILL_REMOVAL_MARKER}`;
    },
  );

  if (!matched) return null;

  const normalizedUserText = normalizeUserText(userText);
  let userContentIndex;
  if (normalizedUserText) {
    userContentIndex = content.length;
    content.push({ type: "text", text: normalizedUserText });
  }

  return {
    content,
    details: {
      version: 1,
      skills: skillRecords,
      userContentIndex,
    },
  };
}

export function extractSkillToken(textBeforeCursor) {
  const match = textBeforeCursor.match(SKILL_TOKEN_PATTERN);
  if (!match) return null;

  const prefix = match[1];
  const marker = prefix.startsWith("$") ? "$" : "/skill:";
  const query = prefix.slice(marker.length);
  return {
    marker,
    query,
    prefix,
    start: textBeforeCursor.length - prefix.length,
  };
}
