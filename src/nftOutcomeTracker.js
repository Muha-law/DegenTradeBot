import cron from "node-cron";
import { isPaused } from "./botState.js";
import { getCollectionStats } from "./risk/opensea.js";
import { getNftCallsPendingOutcome, recordNftCallOutcome } from "./store/db.js";

const CHECK_CRON = "*/30 * * * *";

// How long to wait after a call before snapshotting the outcome — long
// enough for a copy-trade signal to actually play out (NFT floors move
// slower than a DEX pool), short enough that this doesn't lag the wallet
// track record by days. Matches the general timeframe Bonkbot-style token
// PnL cards care about, just longer since NFTs are less liquid.
const OUTCOME_HORIZON_MS = 24 * 60 * 60 * 1000;

// Snapshots each eligible call's floor price 24h after it fired and records
// the % change from call-time floor — the ground truth
// getWalletTrackRecord() in store/db.js aggregates per wallet. Runs
// independently of whether the bot ever actually bought anything for that
// call (paper/real trading could be off, or budget-exhausted) — this
// measures "was the signal any good," not "did we profit from it."
export function startNftOutcomeTracker() {
  let running = false;

  const task = cron.schedule(CHECK_CRON, async () => {
    if (isPaused() || running) return;
    running = true;
    try {
      const pending = getNftCallsPendingOutcome(Date.now() - OUTCOME_HORIZON_MS);
      for (const call of pending) {
        try {
          const stats = await getCollectionStats(call.collection_slug);
          const outcomeFloorEth = stats?.floorPriceEth ?? null;
          const outcomePct =
            outcomeFloorEth != null && call.call_floor_price_eth > 0
              ? ((outcomeFloorEth - call.call_floor_price_eth) / call.call_floor_price_eth) * 100
              : null;
          recordNftCallOutcome(call.id, { outcomeFloorEth, outcomePct });
        } catch (err) {
          // Leave outcome_checked_at unset — retried next cycle. A
          // transient OpenSea failure shouldn't permanently lose this
          // call's outcome data.
          console.error(`[nftOutcomeTracker] failed to check outcome for ${call.name || call.contract_address}:`, err.message);
        }
      }
    } finally {
      running = false;
    }
  });

  console.log(`[nftOutcomeTracker] scheduled every 30m, ${OUTCOME_HORIZON_MS / 3600000}h horizon`);
  return task;
}
