import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "./dataDir.js";

const settingsPath = path.join(getDataDir(), "nftRealTradingSettings.json");

const DEFAULTS = {
  // Starts OFF regardless of what's in an existing settings file at first
  // creation — same discipline as realTradingSettings.js. NFT real trading
  // carries more illiquidity risk than token real trading (see the plan doc
  // / README) — this must be turned on explicitly, never on by default.
  enabled: false,
  totalBudgetEth: 0.3,
  positionSizeEth: 0.05,
  targetMultiple: 2,
  stopFloorPct: -50,
};

export function loadNftRealTradingSettings() {
  if (!fs.existsSync(settingsPath)) {
    saveNftRealTradingSettings(DEFAULTS);
    return { ...DEFAULTS };
  }
  return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath, "utf8")) };
}

export function saveNftRealTradingSettings(settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
