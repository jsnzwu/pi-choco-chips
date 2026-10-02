import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "smol-toml";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_FILE = "pi-choco-setting.toml";
export const BUNDLED_CONFIG_FILE = fileURLToPath(
  new URL("../pi-choco-setting.toml", import.meta.url),
);

export function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function deepMerge(base, overlay) {
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = result[key];
    if (
      current &&
      typeof current === "object" &&
      !Array.isArray(current) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      result[key] = deepMerge(current, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function readSection(path, section) {
  const parsed = parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("root setting must be an object");
  }
  const value = parsed[section];
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${section} setting must be an object`);
  }
  return value;
}

function overrides(config, defaults) {
  const result = Object.create(null);
  for (const [key, value] of Object.entries(config)) {
    const baseline = defaults?.[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = overrides(value, baseline);
      if (Object.keys(nested).length) result[key] = nested;
    } else if (JSON.stringify(value) !== JSON.stringify(baseline)) {
      result[key] = value;
    }
  }
  return result;
}

// Persist only overrides, preserving other sections and unknown user settings.
// Serialization normalizes formatting; TOML comments are not retained.
export function writeSection(section, config, defaults) {
  const path = join(agentDir(), CONFIG_FILE);
  const root = existsSync(path) ? parse(readFileSync(path, "utf8")) : {};
  const current = root[section];
  if (current !== undefined && (!current || typeof current !== "object" || Array.isArray(current))) {
    throw new Error(`${section} setting must be an object`);
  }
  const baseline = deepMerge(defaults, readSection(BUNDLED_CONFIG_FILE, section));
  const delta = overrides(deepMerge(current ?? {}, config), baseline);
  if (Object.keys(delta).length) root[section] = delta;
  else delete root[section];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringify(root), "utf8");
}

// Bundled defaults first, then the user file in the agent directory. A missing
// user file is normal; anything else is reported so a typo does not silently
// fall back to defaults.
export function loadSection(section, defaults) {
  let config = defaults;
  const errors = [];
  try {
    config = deepMerge(config, readSection(BUNDLED_CONFIG_FILE, section));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`${BUNDLED_CONFIG_FILE}: ${message}`);
  }
  const path = join(agentDir(), CONFIG_FILE);
  try {
    config = deepMerge(config, readSection(path, section));
  } catch (error) {
    if (error.code !== "ENOENT") {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${path}: ${message}`);
    }
  }
  return errors.length ? { config, error: errors.join("; ") } : { config };
}
