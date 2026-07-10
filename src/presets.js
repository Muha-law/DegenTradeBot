import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadFilters, saveFilters } from "./filters/filter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const presetsPath = path.join(__dirname, "..", "data", "presets.json");

export function loadPresets() {
  return JSON.parse(fs.readFileSync(presetsPath, "utf8"));
}

// Presets only ever set the specific thresholds in their `overrides` — they
// layer on top of whatever the user has manually configured for everything
// else, rather than replacing the whole filter set.
export function applyPreset(key) {
  const presets = loadPresets();
  const preset = presets[key];
  if (!preset) throw new Error(`Unknown preset "${key}"`);
  const filters = loadFilters();
  Object.assign(filters, preset.overrides);
  saveFilters(filters);
  return filters;
}
