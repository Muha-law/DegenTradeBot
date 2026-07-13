import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "./dataDir.js";

const statePath = path.join(getDataDir(), "botState.json");

// Master on/off switch. When paused, detection/rechecks/price updates/track
// alerts all skip their work — the Telegram interface itself stays up so
// you can still flip it back on.
function readState() {
  if (!fs.existsSync(statePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

export function isPaused() {
  return Boolean(readState().paused);
}

export function setPaused(paused) {
  const state = readState();
  fs.writeFileSync(statePath, JSON.stringify({ ...state, paused }, null, 2));
}

// Separate from the master pause above — NFT scanning/scoring/paper trading
// keeps running either way (so stats stay meaningful and real trading, if
// enabled, keeps working), this only mutes the Telegram messages. Enabled
// by default; on the overnight run this was built for, ~30 NFT calls came
// through in a single 30-minute window, which is a lot of channel noise if
// you just want the token side.
export function isNftNotificationsEnabled() {
  const v = readState().nftNotificationsEnabled;
  return v === undefined ? true : Boolean(v);
}

export function setNftNotificationsEnabled(enabled) {
  const state = readState();
  fs.writeFileSync(statePath, JSON.stringify({ ...state, nftNotificationsEnabled: enabled }, null, 2));
}
