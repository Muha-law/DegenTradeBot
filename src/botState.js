import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "./dataDir.js";

const statePath = path.join(getDataDir(), "botState.json");

// Master on/off switch. When paused, detection/rechecks/price updates/track
// alerts all skip their work — the Telegram interface itself stays up so
// you can still flip it back on.
export function isPaused() {
  if (!fs.existsSync(statePath)) return false;
  try {
    return !!JSON.parse(fs.readFileSync(statePath, "utf8")).paused;
  } catch {
    return false;
  }
}

export function setPaused(paused) {
  fs.writeFileSync(statePath, JSON.stringify({ paused }, null, 2));
}
