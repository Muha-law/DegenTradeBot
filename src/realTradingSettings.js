import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "./dataDir.js";
import { getActiveChainDefs } from "./chainSettings.js";

const settingsPath = path.join(getDataDir(), "realTradingSettings.json");

const DEFAULTS = {
  // Real-fund trading is opt-in per chain, and starts with none enabled —
  // must be turned on explicitly (per chain) from the bot menu, never on by
  // default. See enabledChains helpers below.
  enabledChains: [],
  totalBudgetUsd: 20,
  positionSizeUsd: 2,
  takeProfitPct: 100,
  stopLossPct: -50,
  // Max acceptable price movement between quoting a swap and it confirming
  // on-chain, in basis points (500 = 5%). Too tight on a fast-moving token
  // and the tx reverts; too loose and a sandwich/MEV bot can eat the spread.
  slippageBps: 500,
  // Same "let a winner ride past take-profit" mechanic as paper trading's
  // Super Comando, but with real capital and real gas cost on every
  // AI-triggered exit check — see realTrading.js.
  superComandoEnabled: false,
  // Only let a trade enter ride mode if its call-time 24h volume was at or
  // below this — see the matching field in paperTradingSettings.js for the
  // backtest this is based on.
  superComandoMaxCallVolumeUsd: 18000,
};

export function loadRealTradingSettings() {
  if (!fs.existsSync(settingsPath)) {
    const fresh = { ...DEFAULTS };
    saveRealTradingSettings(fresh);
    return fresh;
  }
  const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const merged = { ...DEFAULTS, ...raw };
  if (!Array.isArray(raw.enabledChains)) {
    // Migrating from the old single global `enabled` boolean — preserve
    // whichever chains were actively watched at the time, so this upgrade
    // doesn't silently turn off real trading that was already live.
    merged.enabledChains = raw.enabled ? getActiveChainDefs().map((c) => c.key) : [];
  }
  delete merged.enabled;
  return merged;
}

export function saveRealTradingSettings(settings) {
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
