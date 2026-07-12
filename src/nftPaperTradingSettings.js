import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "./dataDir.js";

const settingsPath = path.join(getDataDir(), "nftPaperTradingSettings.json");

const DEFAULTS = {
  enabled: true,
  totalBudgetEth: 2,
  positionSizeEth: 0.05,
  // "Take profit" — auto-list once the collection floor reaches this
  // multiple of the entry price. 2 = list once floor doubles.
  targetMultiple: 2,
  // "Stop loss" — auto-list near floor once floor drops to this % of entry
  // (e.g. -50 = list once floor falls to half of what was paid). Weaker
  // guarantee than the token side's instant swap stop-loss — see nftTrading.js.
  stopFloorPct: -50,
};

export function loadNftPaperTradingSettings() {
  if (!fs.existsSync(settingsPath)) {
    saveNftPaperTradingSettings(DEFAULTS);
    return { ...DEFAULTS };
  }
  return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath, "utf8")) };
}

export function saveNftPaperTradingSettings(settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
