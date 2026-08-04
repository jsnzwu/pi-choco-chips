import assert from "node:assert/strict";
import test from "node:test";

import {
  expandSkillReferences,
  extractSkillToken,
  makeSkillBlock,
  stripFrontmatter,
} from "../extensions/skill-references.js";

const skills = new Map([
  [
    "alpha",
    {
      name: "alpha",
      filePath: "/tmp/alpha/SKILL.md",
      description: "Alpha skill",
    },
  ],
  [
    "beta-tools",
    {
      name: "beta-tools",
      filePath: "/tmp/beta-tools/SKILL.md",
      description: "Beta tools skill",
    },
  ],
]);

const contents = new Map([
  ["/tmp/alpha/SKILL.md", "---\nname: alpha\n---\nAlpha instructions"],
  ["/tmp/beta-tools/SKILL.md", "Beta tool instructions"],
]);

const readSkill = (filePath) => contents.get(filePath);

test("strips skill frontmatter", () => {
  assert.equal(stripFrontmatter("---\nname: demo\n---\n\nbody"), "body");
  assert.equal(stripFrontmatter("body"), "body");
});

test("builds the same skill block shape pi understands", () => {
  assert.equal(
    makeSkillBlock(skills.get("alpha"), contents.get("/tmp/alpha/SKILL.md")),
    '<skill name="alpha" location="/tmp/alpha/SKILL.md">\n' +
      "References are relative to /tmp/alpha.\n\n" +
      "Alpha instructions\n" +
      "</skill>",
  );
});

test("expands multiple skill references anywhere in a prompt", () => {
  const result = expandSkillReferences(
    "结合 /skill:alpha 和（/skill:beta-tools）完成任务。",
    skills,
    { readSkill },
  );

  assert.match(result, /<skill name="alpha"/);
  assert.match(result, /<skill name="beta-tools"/);
  assert.match(result, /完成任务/);
});

test("leaves unknown references untouched", () => {
  const input = "Use /skill:missing and /skill:alpha.";
  const result = expandSkillReferences(input, skills, { readSkill });

  assert.match(result, /\/skill:missing/);
  assert.match(result, /<skill name="alpha"/);
});

test("extracts the skill token at the cursor", () => {
  assert.deepEqual(extractSkillToken("请使用 /skill:alp"), {
    query: "alp",
    prefix: "/skill:alp",
    start: 4,
  });
  assert.deepEqual(extractSkillToken("/skill:"), {
    query: "",
    prefix: "/skill:",
    start: 0,
  });
  assert.equal(extractSkillToken("普通文本"), null);
});
