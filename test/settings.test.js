import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "smol-toml";

import { CONFIG_FILE, loadSection, writeSection } from "../extensions/settings.ts";

function withAgentDir(files, run) {
  const dir = mkdtempSync(join(tmpdir(), "pi-choco-settings-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return run(join(dir, CONFIG_FILE));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

const readConfig = (path) => JSON.parse(JSON.stringify(parse(readFileSync(path, "utf8"))));

test("legacy JSON is ignored, including when TOML is also present", () => {
  const legacy = '{"compaction":{"triggerPercent":99}}';
  withAgentDir({ "pi-choco-setting.json": legacy }, () => {
    assert.equal(loadSection("compaction", {}).config.triggerPercent, 80);
  });
  withAgentDir({
    "pi-choco-setting.json": legacy,
    [CONFIG_FILE]: "[compaction]\ntriggerPercent = 90\n",
  }, () => {
    assert.equal(loadSection("compaction", {}).config.triggerPercent, 90);
  });
});

test("malformed TOML and non-table sections report errors without losing defaults", () => {
  for (const text of ["[compaction", "compaction = 90\n"]) {
    withAgentDir({ [CONFIG_FILE]: text }, (path) => {
      const loaded = loadSection("compaction", {});
      assert.ok(loaded.error.includes(path));
      assert.equal(loaded.config.triggerPercent, 80);
    });
  }
});

test("dashboard saves only overrides, preserves other settings, and removes restored defaults", () => {
  withAgentDir({ [CONFIG_FILE]: '[compaction]\ntriggerPercent = 90\n\n[dashboard.custom]\nlabel = "custom"\n' }, (path) => {
    const config = loadSection("dashboard", {}).config;
    config.footer.line3Visible = true;
    writeSection("dashboard", config, {});
    assert.deepEqual(readConfig(path), {
      compaction: { triggerPercent: 90 },
      dashboard: { custom: { label: "custom" }, footer: { line3Visible: true } },
    });
    assert.equal(loadSection("dashboard", {}).config.footer.line3Visible, true);
    config.footer.line3Visible = false;
    writeSection("dashboard", config, {});
    assert.deepEqual(readConfig(path), {
      compaction: { triggerPercent: 90 },
      dashboard: { custom: { label: "custom" } },
    });
  });
});

test("saving defaults creates no dashboard overrides", () => {
  withAgentDir({}, (path) => {
    writeSection("dashboard", loadSection("dashboard", {}).config, {});
    assert.deepEqual(readConfig(path), {});
  });
});

test("saving refuses malformed or invalid existing settings without overwriting them", () => {
  for (const text of ["[dashboard", "dashboard = false\n"]) {
    withAgentDir({ [CONFIG_FILE]: text }, (path) => {
      assert.throws(() => writeSection("dashboard", { enabled: false }, {}));
      assert.equal(readFileSync(path, "utf8"), text);
    });
  }
});
