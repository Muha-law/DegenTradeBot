import cron from "node-cron";
import { config } from "./config.js";
import { CHAINS } from "./chains.js";
import { isPaused } from "./botState.js";
import { loadDigestSettings } from "./digestSettings.js";
import { fetchCallPct, buildDigestEntries } from "./watchlist.js";
import { getActiveCalls, updateCallProgress, updateCallMilestone, deactivateCall } from "./store/db.js";
import { postUpdate, watchlistKeyboard } from "./telegram/bot.js";
import { buildMilestoneMessage, buildFollowUpMessage, buildWatchlistDigest, WATCHLIST_PAGE_SIZE } from "./telegram/formatMessage.js";

const MILESTONES = [50, 100, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000];
const CHECK_CRON = "*/2 * * * *"; // how often we check for milestone/follow-up triggers
const FOLLOWUP_MIN_GAP_MS = 30 * 60 * 1000; // don't send a follow-up more than once per 30 min
const FOLLOWUP_MIN_MOVE_PCT = 30; // ...and only then if it moved at least this many points

// Sends one individual message per call, but only when it's actually
// newsworthy: crossing a milestone (+50%, +100%, +200%...), or — once it's
// already crossed the first one — moving another 30+ points since the last
// message, checked no more than once every 30 min. Everything quieter than
// that only shows up in the periodic digest, not as its own message.
export function startMilestoneChecker(bot) {
  // See the matching guard in trackUpdater.js — this loop is sequential and
  // awaits per-call work, so an overlapping tick (list grows, price API
  // slows down) could otherwise double-send a milestone/follow-up alert.
  let running = false;
  const task = cron.schedule(CHECK_CRON, async () => {
    if (isPaused() || running) return;
    running = true;
    try {
      await runMilestoneCheck(bot);
    } finally {
      running = false;
    }
  });

  console.log(`[milestoneChecker] scheduled every 2m`);
  return task;
}

async function runMilestoneCheck(bot) {
  const windowMs = config.priceUpdateWindowHours * 60 * 60 * 1000;
  const active = getActiveCalls();

  for (const call of active) {
    const chainDef = CHAINS[call.chain];
    if (!chainDef) continue;
    const chain = { key: call.chain, ...chainDef };

    try {
      // Pinned calls are exempt from the expiry window — the user explicitly
      // asked to retain them on the Watchlist (see toggleCallPinned in db.js).
      if (!call.pinned && Date.now() - call.called_at >= windowMs) {
        deactivateCall(call.id);
        continue;
      }

      const result = await fetchCallPct(call);
      if (!result) {
        updateCallProgress(call.id, { lastUpdatedAt: Date.now() });
        continue;
      }
      const { pair, pct } = result;

      const crossed = MILESTONES.filter((m) => pct >= m && m > call.best_milestone_hit);
      if (crossed.length > 0) {
        const milestonePct = crossed[crossed.length - 1];
        await postUpdate(
          bot,
          buildMilestoneMessage({
            chain,
            tokenAddress: call.token_address,
            name: call.name,
            symbol: call.symbol,
            trackPriceUsd: call.call_price_usd,
            trackMarketCapUsd: call.call_market_cap_usd,
            currentPair: pair,
            milestonePct,
            sinceMs: call.called_at,
          })
        );
        updateCallMilestone(call.id, { bestMilestoneHit: milestonePct, lastUpdateSentAt: Date.now(), lastUpdatePct: pct });
        continue;
      }

      if (call.best_milestone_hit > 0) {
        const lastPct = call.last_update_pct ?? call.best_milestone_hit;
        const sinceLastMs = call.last_update_sent_at ? Date.now() - call.last_update_sent_at : Infinity;
        if (sinceLastMs >= FOLLOWUP_MIN_GAP_MS && Math.abs(pct - lastPct) >= FOLLOWUP_MIN_MOVE_PCT) {
          await postUpdate(
            bot,
            buildFollowUpMessage({
              chain,
              tokenAddress: call.token_address,
              name: call.name,
              symbol: call.symbol,
              callPriceUsd: call.call_price_usd,
              currentPair: pair,
              lastPct,
              currentPct: pct,
              sinceMs: call.called_at,
            })
          );
          updateCallMilestone(call.id, { bestMilestoneHit: call.best_milestone_hit, lastUpdateSentAt: Date.now(), lastUpdatePct: pct });
          continue;
        }
      }

      updateCallProgress(call.id, { lastUpdatedAt: Date.now() });
    } catch (err) {
      console.error(`[milestoneChecker] failed ${call.symbol} (${call.chain}):`, err.message);
    }
  }
}

// The scheduled bulk summary — one message covering every active call,
// sorted by performance. Interval is user-configurable (default 30 min) and
// can be re-scheduled live without a restart via reschedule().
export function startWatchlistDigest(bot) {
  let task = null;

  async function sendDigest() {
    if (isPaused()) return;
    try {
      const entries = await buildDigestEntries();
      if (entries.length === 0) return;
      // Same numbered remove-buttons as the interactive /watchlist view —
      // matches page 0 of that view exactly, since this digest has no
      // offset/pagination of its own.
      const shown = entries.slice(0, WATCHLIST_PAGE_SIZE);
      await postUpdate(bot, buildWatchlistDigest(entries), watchlistKeyboard(0, entries.length, shown));
    } catch (err) {
      console.error("[watchlistDigest] failed to send:", err.message);
    }
  }

  function schedule() {
    if (task) task.stop();
    const { intervalMinutes } = loadDigestSettings();
    task = cron.schedule(`*/${intervalMinutes} * * * *`, sendDigest);
    console.log(`[watchlistDigest] scheduled every ${intervalMinutes}m`);
  }

  schedule();
  return { sendNow: sendDigest, reschedule: schedule };
}
