import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const settingsPath = path.join(__dirname, "..", "data", "digestSettings.json");

const DEFAULTS = { intervalMinutes: 30 };

export function loadDigestSettings() {
  if (!fs.existsSync(settingsPath)) {
    saveDigestSettings(DEFAULTS);
    return { ...DEFAULTS };
  }
  return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath, "utf8")) };
}

export function saveDigestSettings(settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
