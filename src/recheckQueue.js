import cron from "node-cron";
import { CHAINS } from "./chains.js";
import { loadFilters } from "./filters/filter.js";
import { isPaused } from "./botState.js";
import { getAllPending, touchPending, removePending } from "./store/db.js";
import { evaluateToken } from "./pipeline.js";

const RECHECK_CRON = "*/2 * * * *"; // every 2 minutes

// Tokens that failed the filter at birth (near-zero liquidity/holders) get
// re-evaluated here as they mature, up to filters.maxTokenAgeMinutes old.
export function startRecheckQueue(bot) {
  // A large backlog can take longer than the 2-min schedule to process
  // (each evaluateToken call does several API round-trips) — without this
  // guard, node-cron fires the next cycle anyway, and two overlapping
  // cycles can both reach the same still-pending token before either has
  // recorded it, each independently deciding it passes and sending its own
  // message. Skipping a tick if the last one is still running is simpler
  // and cheaper than making evaluateToken itself concurrency-safe.
  let running = false;

  const task = cron.schedule(RECHECK_CRON, async () => {
    if (isPaused() || running) return;
    running = true;
    try {
      const pending = getAllPending();
      if (pending.length === 0) return;

      const { maxTokenAgeMinutes } = loadFilters();

      for (const p of pending) {
        const chainDef = CHAINS[p.chain];
        if (!chainDef) {
          removePending(p.id);
          continue;
        }

        const ageMinutes = (Date.now() - p.first_seen_at) / 60000;
        // Still give an about-to-expire token one last evaluateToken pass
        // (cheap — applyFilter's age check fails it and returns before any
        // AI/sellability calls) instead of dropping it silently, so the drop
        // log below can show WHY it never passed rather than just that it
        // aged out — e.g. distinguishing "still below minimums" from "shot
        // past the market cap/volume ceiling before ever qualifying."
        const isLastChance = ageMinutes > maxTokenAgeMinutes;

        try {
          const result = await evaluateToken(bot, {
            chain: { key: p.chain, ...chainDef },
            dexName: p.dex_name,
            pairAddress: p.pair_address,
            tokenAddress: p.token_address,
            ageMinutes,
          });

          if (result.pass) {
            removePending(p.id);
            console.log(`[recheck] ${p.chain} ${result.symbol} (${p.token_address}) now passes — called`);
          } else if (result.reasons.includes("Already called")) {
            removePending(p.id);
          } else if (isLastChance) {
            removePending(p.id);
            console.log(`[recheck] ${p.chain} ${p.token_address} dropped — aged out at ${ageMinutes.toFixed(0)}m without passing. Last reasons: ${result.reasons.join("; ")}`);
          } else {
            touchPending(p.id);
          }
        } catch (err) {
          console.error(`[recheck] failed ${p.chain} ${p.token_address}:`, err.message);
          if (isLastChance) {
            removePending(p.id);
            console.log(`[recheck] ${p.chain} ${p.token_address} dropped — aged out at ${ageMinutes.toFixed(0)}m after an evaluation error: ${err.message}`);
          } else {
            touchPending(p.id);
          }
        }
      }
    } finally {
      running = false;
    }
  });

  console.log(`[recheckQueue] scheduled every 2m`);
  return task;
}
