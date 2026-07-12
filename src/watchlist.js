import { config } from "./config.js";
import { CHAINS } from "./chains.js";
import { getBestPair, pairSummary } from "./risk/dexscreener.js";
import { getActiveCalls } from "./store/db.js";

function isSanePrice(n) {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n < 1e12;
}

// A near-empty pool's spot price (reserve ratio) can blow up to something
// that looks perfectly "sane" in magnitude (e.g. $8,395) while backed by
// literally a few cents of real liquidity — the price is mathematically
// real but not realizable by anyone trying to actually sell into it.
// Without this, a fully-rugged pool reads as a "10000%+" milestone instead
// of the dead pool it actually is. $25 is a low bar — only catches pools
// that are genuinely down to dust, not just below the calling threshold.
const MIN_REALIZABLE_LIQUIDITY_USD = 25;

export async function fetchCallPct(call) {
  const chainDef = CHAINS[call.chain];
  if (!chainDef || !isSanePrice(call.call_price_usd)) return null;
  const dexPair = await getBestPair(chainDef.dexscreenerChainId, call.token_address);
  const pair = pairSummary(dexPair, call.token_address);
  if (!pair || !isSanePrice(pair.priceUsd)) return null;
  if (!pair.liquidityUsd || pair.liquidityUsd < MIN_REALIZABLE_LIQUIDITY_USD) return null;
  return { pair, pct: ((pair.priceUsd - call.call_price_usd) / call.call_price_usd) * 100 };
}

// Live-priced, sorted-by-performance view of every active auto-call.
// Shared by the bot's Watchlist view/button and the scheduled digest, so
// they never drift out of sync with each other.
export async function buildDigestEntries() {
  const windowMs = config.priceUpdateWindowHours * 60 * 60 * 1000;
  // getActiveCalls() has no age filter of its own by design (see its comment
  // in store/db.js) — normally the milestone-checker cron deactivates expired
  // rows as a side effect every 2 minutes, but that cron skips its run while
  // the bot is paused, so this view needs its own independent expiry check
  // rather than trusting `active` to already be current.
  const now = Date.now();
  // Pinned calls are shown regardless of age — same exemption the milestone
  // checker's deactivation applies (see priceUpdater.js).
  const active = getActiveCalls().filter((call) => call.pinned || now - call.called_at < windowMs);

  const entries = await Promise.all(
    active.map(async (call) => {
      const result = await fetchCallPct(call).catch(() => null);
      return {
        symbol: call.symbol || result?.pair?.symbol || null,
        name: call.name || result?.pair?.name || null,
        chain: call.chain,
        tokenAddress: call.token_address,
        pct: result?.pct ?? null,
        currentPrice: result?.pair?.priceUsd ?? null,
        pinned: Boolean(call.pinned),
      };
    })
  );

  return entries.sort((a, b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity));
}
