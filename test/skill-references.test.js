import assert from "node:assert/strict";
import test from "node:test";

import {
  extractSkillToken,
  makeSkillBlock,
  makeSkillBundle,
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

test("builds one ordered bundle with complete blocks and ordinary text", () => {
  const result = makeSkillBundle("Use /skill:alpha and $beta-tools now", skills, { readSkill });

  assert.ok(result);
  assert.equal(result.content.length, 3);
  assert.match(result.content[0].text, /<skill name="alpha"/);
  assert.match(result.content[1].text, /<skill name="beta-tools"/);
  assert.equal(result.content[2].text, "Use and now");
  assert.deepEqual(result.details.skills, [
    { name: "alpha", location: "/tmp/alpha/SKILL.md", status: "loaded", contentIndex: 0 },
    { name: "beta-tools", location: "/tmp/beta-tools/SKILL.md", status: "loaded", contentIndex: 1 },
  ]);
  assert.equal(result.details.userContentIndex, 2);
});

test("preserves ordinary words after skill removal", () => {
  const result = makeSkillBundle("Use /skill:alpha tools", skills, { readSkill });

  assert.ok(result);
  assert.equal(result.content[result.details.userContentIndex].text, "Use tools");
});

test("preserves tabs outside the skill-removal seam", () => {
  const result = makeSkillBundle("Use /skill:alpha\ttools\n\t\tcode", skills, { readSkill });

  assert.ok(result);
  assert.equal(result.content[result.details.userContentIndex].text, "Use\ttools\n\t\tcode");
});

test("removes the separator after a line-start skill reference", () => {
  const result = makeSkillBundle("Before\n/skill:alpha next", skills, { readSkill });

  assert.ok(result);
  assert.equal(result.content[result.details.userContentIndex].text, "Before\nnext");
});

test("preserves duplicate and unknown references in a bundle", () => {
  const result = makeSkillBundle("/skill:alpha /skill:missing $alpha $HOME", skills, { readSkill });

  assert.ok(result);
  assert.equal(result.details.skills.length, 2);
  assert.equal(result.details.skills[0].name, "alpha");
  assert.equal(result.details.skills[1].name, "alpha");
  assert.equal(result.content.filter((part) => part.text?.includes('<skill name="alpha"')).length, 2);
  assert.match(result.content[result.details.userContentIndex].text, /\/skill:missing/);
  assert.match(result.content[result.details.userContentIndex].text, /\$HOME/);
});

test("records read failures and keeps the failed reference in ordinary text", () => {
  const errors = [];
  const result = makeSkillBundle("Use /skill:alpha now", skills, {
    readSkill: () => {
      throw new Error("EACCES");
    },
    onError: (_skill, error) => errors.push(error.message),
  });

  assert.ok(result);
  assert.deepEqual(errors, ["EACCES"]);
  assert.deepEqual(result.details.skills, [
    { name: "alpha", location: "/tmp/alpha/SKILL.md", status: "error", error: "EACCES" },
  ]);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].text, "Use /skill:alpha now");
});

test("does not build a bundle when no known skill is referenced", () => {
  assert.equal(makeSkillBundle("Use /skill:missing and $HOME", skills, { readSkill }), null);
});

test("extracts the skill token at the cursor", () => {
  assert.deepEqual(extractSkillToken("请使用 /skill:alp"), {
    marker: "/skill:",
    query: "alp",
    prefix: "/skill:alp",
    start: 4,
  });
  assert.deepEqual(extractSkillToken("$"), {
    marker: "$",
    query: "",
    prefix: "$",
    start: 0,
  });
  assert.deepEqual(extractSkillToken("$beta"), {
    marker: "$",
    query: "beta",
    prefix: "$beta",
    start: 0,
  });
  assert.deepEqual(extractSkillToken("/skill:"), {
    marker: "/skill:",
    query: "",
    prefix: "/skill:",
    start: 0,
  });
  assert.equal(extractSkillToken("普通文本"), null);
});
