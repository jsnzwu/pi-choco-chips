import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_FILE = "pi-choco-setting.json";
export const BUNDLED_CONFIG_FILE = fileURLToPath(
  new URL("../pi-choco-setting.json", import.meta.url),
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
  const parsed = JSON.parse(readFileSync(path, "utf8"));
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
