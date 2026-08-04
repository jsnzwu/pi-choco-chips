import { readFileSync } from "node:fs";
import { dirname } from "node:path";

const SKILL_REFERENCE_PATTERN =
  /(^|[^\p{L}\p{N}_-])(?:\/skill:|\$)([a-z0-9]+(?:-[a-z0-9]+)*)(?=$|[^\p{L}\p{N}_-])/gu;
const SKILL_TOKEN_PATTERN =
  /(?:^|[^\p{L}\p{N}_-])(\/skill:([a-z0-9-]*)|\$([a-z0-9-]*))$/u;

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

export function expandSkillReferences(text, skills, options = {}) {
  const readSkill = options.readSkill ?? ((filePath) => readFileSync(filePath, "utf8"));
  const onError = options.onError;
  let changed = false;

  const expanded = text.replace(
    SKILL_REFERENCE_PATTERN,
    (match, boundary, name) => {
      const skill = skills.get(name);
      if (!skill) return match;

      try {
        const block = makeSkillBlock(skill, readSkill(skill.filePath));
        changed = true;
        return `${boundary}${block}`;
      } catch (error) {
        onError?.(skill, error);
        return match;
      }
    },
  );

  return changed ? expanded : text;
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
