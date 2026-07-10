import { config } from "./config.js";
import { CHAINS } from "./chains.js";
import { getBestPair, pairSummary } from "./risk/dexscreener.js";
import { getActiveCalls } from "./store/db.js";

function isSanePrice(n) {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n < 1e12;
}

export async function fetchCallPct(call) {
  const chainDef = CHAINS[call.chain];
  if (!chainDef || !isSanePrice(call.call_price_usd)) return null;
  const dexPair = await getBestPair(chainDef.dexscreenerChainId, call.token_address);
  const pair = pairSummary(dexPair, call.token_address);
  if (!pair || !isSanePrice(pair.priceUsd)) return null;
  return { pair, pct: ((pair.priceUsd - call.call_price_usd) / call.call_price_usd) * 100 };
}

// Live-priced, sorted-by-performance view of every active auto-call.
// Shared by the bot's Watchlist view/button and the scheduled digest, so
// they never drift out of sync with each other.
export async function buildDigestEntries() {
  const windowMs = config.priceUpdateWindowHours * 60 * 60 * 1000;
  const active = getActiveCalls(windowMs);

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
      };
    })
  );

  return entries.sort((a, b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity));
}
