// Load-time guard for the money-critical numeric fields in trading settings.
//
// Each loader merges persisted values over defaults (`{ ...DEFAULTS, ...raw }`)
// — correct for real tuning, but it also means a corrupt or nonsensical
// persisted value passes straight through untouched. That is exactly how
// `stopLossPct: 0` went live once and hair-triggered every real trade into an
// instant loss: a 0% (or positive) stop fires the moment a position is even
// fractionally down, because realTrading.js exits on `pnlPct <= stop_loss_pct`.
//
// These checks reject only values that can never be sensible — wrong sign,
// non-finite (NaN/Infinity), or absurd — falling back to the module's own
// documented default and logging loudly so the correction is discoverable. A
// correctly-tuned config is never touched. Runs on every load, so it also
// self-corrects a bad value written by any path (manual file edit included) on
// the next read, not only at the moment of a save.
export function sanitizeTradingSettings(settings, defaults, label) {
  const warn = (msg) => console.error(`[${label}] ⚠️ invalid setting corrected — ${msg}`);
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

  // stopLossPct must be a negative percentage. At 0 or positive, every
  // position exits at (or below) break-even the instant it ticks down — the
  // exact incident that drained the wallet.
  if (defaults.stopLossPct !== undefined && !(isNum(settings.stopLossPct) && settings.stopLossPct < 0)) {
    warn(`stopLossPct=${settings.stopLossPct} (must be a negative number) → ${defaults.stopLossPct}`);
    settings.stopLossPct = defaults.stopLossPct;
  }

  // takeProfitPct must be positive. At 0 or negative, the take-profit check
  // (`pnlPct >= take_profit_pct`) fires immediately and every position closes
  // before it can move.
  if (defaults.takeProfitPct !== undefined && !(isNum(settings.takeProfitPct) && settings.takeProfitPct > 0)) {
    warn(`takeProfitPct=${settings.takeProfitPct} (must be a positive number) → ${defaults.takeProfitPct}`);
    settings.takeProfitPct = defaults.takeProfitPct;
  }

  // Global position-size fallback must be positive — a 0/NaN size can't buy
  // anything sane.
  if (defaults.positionSizeUsd !== undefined && !(isNum(settings.positionSizeUsd) && settings.positionSizeUsd > 0)) {
    warn(`positionSizeUsd=${settings.positionSizeUsd} (must be > 0) → ${defaults.positionSizeUsd}`);
    settings.positionSizeUsd = defaults.positionSizeUsd;
  }

  // Per-chain position overrides — drop any invalid entry so it falls back
  // cleanly to positionSizeUsd instead of sizing a trade at 0/NaN for that
  // one chain.
  if (settings.positionSizeUsdByChain && typeof settings.positionSizeUsdByChain === "object") {
    for (const [k, v] of Object.entries(settings.positionSizeUsdByChain)) {
      if (!(isNum(v) && v > 0)) {
        warn(`positionSizeUsdByChain.${k}=${v} (must be > 0) → removed (falls back to positionSizeUsd)`);
        delete settings.positionSizeUsdByChain[k];
      }
    }
  }

  // Budget must be positive or no trade can ever be sized within it.
  if (defaults.totalBudgetUsd !== undefined && !(isNum(settings.totalBudgetUsd) && settings.totalBudgetUsd > 0)) {
    warn(`totalBudgetUsd=${settings.totalBudgetUsd} (must be > 0) → ${defaults.totalBudgetUsd}`);
    settings.totalBudgetUsd = defaults.totalBudgetUsd;
  }

  // slippageBps: swapExecutor derives minOut as (10000 - slippageBps)/10000,
  // so a value >= 10000 underflows the floor to zero/negative (accept ANY
  // output — no slippage protection at all), and <= 0 reverts every swap.
  // 5000 (50%) is already far past anything sane for an automated trade; the
  // band only rejects true garbage, not ordinary tuning. Only real-trading
  // settings carry this field.
  if (defaults.slippageBps !== undefined && !(isNum(settings.slippageBps) && settings.slippageBps > 0 && settings.slippageBps <= 5000)) {
    warn(`slippageBps=${settings.slippageBps} (must be 1..5000) → ${defaults.slippageBps}`);
    settings.slippageBps = defaults.slippageBps;
  }

  // maxHoldMinutes: 0 legitimately means "no cap", so only reject negatives
  // and non-finite values here.
  if (defaults.maxHoldMinutes !== undefined && !(isNum(settings.maxHoldMinutes) && settings.maxHoldMinutes >= 0)) {
    warn(`maxHoldMinutes=${settings.maxHoldMinutes} (must be >= 0) → ${defaults.maxHoldMinutes}`);
    settings.maxHoldMinutes = defaults.maxHoldMinutes;
  }

  // superComandoMaxCallVolumeUsd gates ride-mode eligibility; a negative/NaN
  // value would silently disable (or corrupt) that gate.
  if (
    defaults.superComandoMaxCallVolumeUsd !== undefined &&
    !(isNum(settings.superComandoMaxCallVolumeUsd) && settings.superComandoMaxCallVolumeUsd >= 0)
  ) {
    warn(`superComandoMaxCallVolumeUsd=${settings.superComandoMaxCallVolumeUsd} (must be >= 0) → ${defaults.superComandoMaxCallVolumeUsd}`);
    settings.superComandoMaxCallVolumeUsd = defaults.superComandoMaxCallVolumeUsd;
  }

  return settings;
}
