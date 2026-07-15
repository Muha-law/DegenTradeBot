import cron from "node-cron";
import { db } from "./store/db.js";
import { isPaused, hasStalePriceReportBeenSent, markStalePriceReportSent } from "./botState.js";
import { postAdminUpdate } from "./telegram/bot.js";
import { CHAINS } from "./chains.js";

const CHECK_CRON = "23 */6 * * *"; // every 6 hours

// The exact moment the honeypot-filter overhaul went live (owner_change_balance
// hard reject, round-trip sell-tax probe, minLiquidityUsd $20k, minMarketCapUsd
// $40k, maxLiquidityToMarketCapRatio 0.6). Before this, exit_reason='stale_price'
// (paperTrading.js's dead-pool/rug detector — liquidity drops to dust or the
// price feed dies for 30+ sustained minutes) hit 55% of closed paper trades
// (61/110): BSC 72% (13/18), Robinhood Chain 52% (48/92). The whole point of
// this check is to see whether that rate actually moved.
const FILTER_CHANGE_CUTOFF_MS = 1784134162000; // 2026-07-15T16:49:22Z
const MIN_SAMPLE_SIZE = 20;

const PRE_FIX_BASELINE = {
  overall: 0.55,
  bsc: 0.72,
  robinhood: 0.52,
};

function runCheck() {
  const rows = db
    .prepare(
      `SELECT p.chain AS chain, p.exit_reason AS exit_reason
       FROM paper_trades p
       JOIN called_tokens c ON c.chain = p.chain AND c.token_address = p.token_address
       WHERE p.status = 'closed' AND p.pnl_pct IS NOT NULL AND p.entry_at >= ?`
    )
    .all(FILTER_CHANGE_CUTOFF_MS);

  if (rows.length < MIN_SAMPLE_SIZE) {
    console.log(`[stalePriceRugCheck] ${rows.length}/${MIN_SAMPLE_SIZE} closed trades since the filter change — waiting`);
    return;
  }

  const rate = (subset) => (subset.length ? subset.filter((r) => r.exit_reason === "stale_price").length / subset.length : null);

  const overallRate = rate(rows);
  const byChain = {};
  for (const chainKey of Object.keys(CHAINS)) {
    const chainRows = rows.filter((r) => r.chain === chainKey);
    if (chainRows.length > 0) byChain[chainKey] = { rate: rate(chainRows), n: chainRows.length };
  }

  const fmtPct = (r) => `${(r * 100).toFixed(0)}%`;
  const lines = [
    `📊 *Stale-price rug rate — post-filter-change check* (n=${rows.length})`,
    "",
    `Overall: ${fmtPct(overallRate)} (was ${fmtPct(PRE_FIX_BASELINE.overall)} before the filter change)`,
  ];
  for (const [chainKey, { rate: chainRate, n }] of Object.entries(byChain)) {
    const baseline = PRE_FIX_BASELINE[chainKey];
    const baselineNote = baseline != null ? ` (was ${fmtPct(baseline)})` : "";
    lines.push(`${CHAINS[chainKey]?.label || chainKey}: ${fmtPct(chainRate)}${baselineNote} — n=${n}`);
  }
  lines.push(
    "",
    overallRate < PRE_FIX_BASELINE.overall
      ? "✅ Improved since the filter change."
      : "⚠️ Not improved (or worse) since the filter change — may need another look at the filters."
  );

  return { text: lines.join("\n") };
}

export function startStalePriceRugCheck(bot) {
  if (hasStalePriceReportBeenSent()) {
    console.log("[stalePriceRugCheck] already reported — not scheduling again");
    return null;
  }

  let running = false;
  const task = cron.schedule(CHECK_CRON, async () => {
    if (isPaused() || running) return;
    running = true;
    try {
      const result = runCheck();
      if (result) {
        await postAdminUpdate(bot, result.text);
        markStalePriceReportSent();
      }
    } catch (err) {
      console.error("[stalePriceRugCheck] check failed:", err.message);
    } finally {
      running = false;
    }
  });

  console.log("[stalePriceRugCheck] scheduled every 6h");
  return task;
}
