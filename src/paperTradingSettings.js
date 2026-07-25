import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "./dataDir.js";
import { getActiveChainDefs } from "./chainSettings.js";
import { sanitizeTradingSettings } from "./settingsSanitize.js";

const settingsPath = path.join(getDataDir(), "paperTradingSettings.json");

const STATIC_DEFAULTS = {
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
    // Paper trading previously defaulted to globally ON — preserve that by
    // starting every currently-watched chain enabled, rather than none.
    const fresh = { ...STATIC_DEFAULTS, enabledChains: getActiveChainDefs().map((c) => c.key) };
    savePaperTradingSettings(fresh);
    return fresh;
  }
  const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const merged = { ...STATIC_DEFAULTS, enabledChains: [], ...raw };
  if (!Array.isArray(raw.enabledChains)) {
    // Migrating from the old single global `enabled` boolean — preserve
    // current behavior for whichever chains were actively watched.
    merged.enabledChains = raw.enabled !== false ? getActiveChainDefs().map((c) => c.key) : [];
  }
  delete merged.enabled;
  // Paper money, but the same corrupt-value class would quietly poison the
  // strategy-validation signal the real config is judged against.
  return sanitizeTradingSettings(merged, STATIC_DEFAULTS, "paperTradingSettings");
}

export function savePaperTradingSettings(settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

export function isChainTradingEnabled(settings, chainKey) {
  return (settings.enabledChains || []).includes(chainKey);
}

export function isAnyChainTradingEnabled(settings) {
  return (settings.enabledChains || []).length > 0;
}

export function setChainTradingEnabled(settings, chainKey, enabled) {
  const set = new Set(settings.enabledChains || []);
  if (enabled) set.add(chainKey);
  else set.delete(chainKey);
  settings.enabledChains = [...set];
  return settings;
}
