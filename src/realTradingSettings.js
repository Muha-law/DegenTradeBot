import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const settingsPath = path.join(__dirname, "..", "data", "realTradingSettings.json");

const DEFAULTS = {
  // Starts OFF regardless of what's in an existing settings file at first
  // creation — real-fund trading must be turned on explicitly from the bot
  // menu, never on by default.
  enabled: false,
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
    saveRealTradingSettings(DEFAULTS);
    return { ...DEFAULTS };
  }
  return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath, "utf8")) };
}

export function saveRealTradingSettings(settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}
