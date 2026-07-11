import cron from "node-cron";
import { CHAINS } from "./chains.js";
import { getBestPair, pairSummary } from "./risk/dexscreener.js";
import { isPaused } from "./botState.js";
import {
  getActiveTracks,
  updateTrackMilestone,
  touchTrack,
  markDown50Alert,
  markDeadAndDeactivate,
} from "./store/db.js";
import { postUpdate } from "./telegram/bot.js";
import { buildMilestoneMessage, buildTrackAlertMessage } from "./telegram/formatMessage.js";

const MILESTONES = [50, 100, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000];
const TRACK_CRON = "*/2 * * * *"; // every 2 minutes

// User-requested milestone tracking (/track), independent of the bot's own
// auto-calls: alerts at +50%, +100%, +200%... and on a 50%/90% drawdown.
export function startTrackUpdater(bot) {
  // node-cron doesn't wait for a previous tick to finish before firing the
  // next one. This loop is sequential and awaits a price fetch + possible
  // Telegram send per tracked token, so if the list grows or the price API
  // is slow enough that one pass exceeds 2 minutes, overlapping ticks would
  // process the same rows concurrently and could double-send a milestone
  // alert. This flag makes a still-running tick skip the next trigger.
  let running = false;
  const task = cron.schedule(TRACK_CRON, async () => {
    if (isPaused() || running) return;
    running = true;
    try {
      await runTrackUpdate(bot);
    } finally {
      running = false;
    }
  });

  console.log(`[trackUpdater] scheduled every 2m`);
  return task;
}

async function runTrackUpdate(bot) {
  const tracks = getActiveTracks();

  for (const t of tracks) {
    const chainDef = CHAINS[t.chain];
    if (!chainDef) continue;
    const chain = { key: t.chain, ...chainDef };

    try {
      const dexPair = await getBestPair(chainDef.dexscreenerChainId, t.token_address);
      const pair = pairSummary(dexPair, t.token_address);
      if (!pair || !pair.priceUsd) {
        touchTrack(t.id);
        continue;
      }

      const pct = ((pair.priceUsd - t.track_price_usd) / t.track_price_usd) * 100;

      if (pct <= -90 && !t.dead_alert_sent) {
        await postUpdate(
          bot,
          buildTrackAlertMessage({
            chain,
            tokenAddress: t.token_address,
            name: t.name,
            symbol: t.symbol,
            trackPriceUsd: t.track_price_usd,
            currentPair: pair,
            kind: "dead",
            sinceMs: t.tracked_at,
          })
        );
        markDeadAndDeactivate(t.id);
        continue;
      }

      if (pct <= -50 && !t.down50_alert_sent) {
        await postUpdate(
          bot,
          buildTrackAlertMessage({
            chain,
            tokenAddress: t.token_address,
            name: t.name,
            symbol: t.symbol,
            trackPriceUsd: t.track_price_usd,
            currentPair: pair,
            kind: "down50",
            sinceMs: t.tracked_at,
          })
        );
        markDown50Alert(t.id);
      }

      const crossed = MILESTONES.filter((m) => pct >= m && m > t.best_milestone_hit);
      if (crossed.length > 0) {
        const milestonePct = crossed[crossed.length - 1]; // only announce the highest one crossed since last check
        await postUpdate(
          bot,
          buildMilestoneMessage({
            chain,
            tokenAddress: t.token_address,
            name: t.name,
            symbol: t.symbol,
            trackPriceUsd: t.track_price_usd,
            trackMarketCapUsd: t.track_market_cap_usd,
            currentPair: pair,
            milestonePct,
            sinceMs: t.tracked_at,
          })
        );
        updateTrackMilestone(t.id, { lastCheckedAt: Date.now(), bestMilestoneHit: milestonePct });
      } else {
        touchTrack(t.id);
      }
    } catch (err) {
      console.error(`[trackUpdater] failed ${t.chain} ${t.token_address}:`, err.message);
    }
  }
}
