import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "./dataDir.js";

const settingsPath = path.join(getDataDir(), "paperTradingSettings.json");

const DEFAULTS = {
  enabled: true,
  totalBudgetUsd: 10000,
  positionSizeUsd: 500,
  takeProfitPct: 100,
  stopLossPct: -50,
  // Super Comando: once a trade crosses takeProfitPct, don't auto-sell —
  // protect that level as a floor and let it ride for a bigger gain,
  // letting the AI decide when to actually cash out. See paperTrading.js.
  superComandoEnabled: false,
  // Only let a trade enter ride mode if its call-time 24h volume was at or
  // below this — backtested across 380 historical calls as the strongest
  // available signal for "genuine mover, not a wash-traded pump-and-dump."
  // A crossing on a token whose call-time volume was higher gets the plain
  // take-profit exit instead, even with Super Comando on.
  superComandoMaxCallVolumeUsd: 18000,
};

export function loadPaperTradingSettings() {
  if (!fs.existsSync(settingsPath)) {
    savePaperTradingSettings(DEFAULTS);
    return { ...DEFAULTS };
  }
  return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath, "utf8")) };
}

export function savePaperTradingSettings(settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
