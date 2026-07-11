import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "./dataDir.js";

const settingsPath = path.join(getDataDir(), "digestSettings.json");

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
