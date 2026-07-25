import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "./dataDir.js";
import { getActiveChainDefs } from "./chainSettings.js";
import { sanitizeTradingSettings } from "./settingsSanitize.js";

const settingsPath = path.join(getDataDir(), "realTradingSettings.json");

const DEFAULTS = {
  // Real-fund trading is opt-in per chain, and starts with none enabled —
  // must be turned on explicitly (per chain) from the bot menu, never on by
  // default. See enabledChains helpers below.
  enabledChains: [],
  totalBudgetUsd: 20,
  // Fallback used by any chain without its own override in
  // positionSizeUsdByChain below — kept separate rather than folded in, so
  // existing installs that only ever set this one global value keep
  // working unchanged.
  positionSizeUsd: 2,
  // Per-chain overrides — e.g. a chain whose native currency is running low
  // shouldn't force every OTHER chain's position size down too. Confirmed
  // real motivation: BSC's wallet ran short of BNB for a $10 position while
  // other chains were unaffected, and positionSizeUsd being global meant
  // the only fix was shrinking every chain's sizing at once.
  // { [chainKey]: usd } — absent entries fall back to positionSizeUsd above.
  positionSizeUsdByChain: {},
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
  // Per-chain override — a chain whose honeypot/rug rate has burned trust
  // shouldn't need Comando turned off everywhere else too. Falls back to
  // superComandoEnabled above for any chain without one.
  superComandoEnabledByChain: {},
  // Only let a trade enter ride mode if its call-time 24h volume was at or
  // below this — see the matching field in paperTradingSettings.js for the
  // backtest this is based on.
  superComandoMaxCallVolumeUsd: 18000,
  // 0/unset = no cap (the default — take-profit/stop-loss/Comando decide
  // exits on their own timeline). A chain with a high honeypot rate can cap
  // how long real money sits exposed regardless of P&L — this wins over
  // take-profit, stop-loss, and Comando alike once it's hit.
  maxHoldMinutes: 0,
  // { [chainKey]: minutes } — per-chain override, same reasoning as
  // superComandoEnabledByChain above. Confirmed real motivation: BSC's
  // honeypot rate specifically, not a general policy change everywhere.
  maxHoldMinutesByChain: {},
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
  // Backstop against a corrupt/nonsensical persisted value reaching the live
  // trade loop — real money rode on stopLossPct: 0 slipping through here once.
  return sanitizeTradingSettings(merged, DEFAULTS, "realTradingSettings");
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

export function getPositionSizeUsd(settings, chainKey) {
  const override = settings.positionSizeUsdByChain?.[chainKey];
  return typeof override === "number" ? override : settings.positionSizeUsd;
}

export function setPositionSizeUsd(settings, chainKey, usd) {
  settings.positionSizeUsdByChain = { ...(settings.positionSizeUsdByChain || {}), [chainKey]: usd };
  return settings;
}

export function isSuperComandoEnabled(settings, chainKey) {
  const override = settings.superComandoEnabledByChain?.[chainKey];
  return typeof override === "boolean" ? override : settings.superComandoEnabled;
}

export function setSuperComandoEnabled(settings, chainKey, enabled) {
  settings.superComandoEnabledByChain = { ...(settings.superComandoEnabledByChain || {}), [chainKey]: enabled };
  return settings;
}

export function getMaxHoldMinutes(settings, chainKey) {
  const override = settings.maxHoldMinutesByChain?.[chainKey];
  return typeof override === "number" ? override : settings.maxHoldMinutes;
}

export function setMaxHoldMinutes(settings, chainKey, minutes) {
  settings.maxHoldMinutesByChain = { ...(settings.maxHoldMinutesByChain || {}), [chainKey]: minutes };
  return settings;
}
