import cron from "node-cron";
import { CHAINS } from "./chains.js";
import { isPaused } from "./botState.js";
import { getAllNftPendingListings, touchNftPendingListing, removeNftPendingListing } from "./store/db.js";
import { retryNftPendingBuy } from "./nftPipeline.js";

const RECHECK_CRON = "*/5 * * * *";

// How long to keep retrying a called-but-unlisted collection before giving
// up on the real-buy attempt entirely (the call itself already went out —
// this only governs the automated-buy side). 48h is generous for a
// still-minting collection to reach secondary trading without letting a
// dead entry sit in this queue forever.
const MAX_PENDING_AGE_HOURS = 48;

// Retries the real-money buy for NFT collections whose call had no
// fulfillable secondary-market listing yet — same role as recheckQueue.js
// on the token side, but here it's specifically about buy *availability*
// (a listing appearing), not the collection's risk score changing.
export function startNftBuyRecheckQueue(bot) {
  let running = false;

  const task = cron.schedule(RECHECK_CRON, async () => {
    if (isPaused() || running) return;
    running = true;
    try {
      const pending = getAllNftPendingListings();
      if (pending.length === 0) return;

      for (const p of pending) {
        const chainDef = CHAINS[p.chain];
        if (!chainDef) {
          removeNftPendingListing(p.id);
          continue;
        }

        const ageHours = (Date.now() - p.called_at) / 3600000;
        if (ageHours > MAX_PENDING_AGE_HOURS) {
          removeNftPendingListing(p.id);
          continue;
        }

        try {
          const { bought } = await retryNftPendingBuy(bot, { chain: { key: p.chain, ...chainDef }, contractAddress: p.contract_address });
          if (bought) removeNftPendingListing(p.id);
          else touchNftPendingListing(p.id);
        } catch (err) {
          console.log(`[nftBuyRecheckQueue] ${p.chain} ${p.contract_address} still no fulfillable listing: ${err.message}`);
          touchNftPendingListing(p.id);
        }
      }
    } finally {
      running = false;
    }
  });

  console.log(`[nftBuyRecheckQueue] scheduled every 5m`);
  return task;
}
