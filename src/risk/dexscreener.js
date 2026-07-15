import fetch from "node-fetch";

const BASE_URL = "https://api.dexscreener.com";

// Returns the highest-liquidity pair for a token on a given chain, or null.
export async function getBestPair(dexscreenerChainId, tokenAddress) {
  const url = `${BASE_URL}/token-pairs/v1/${dexscreenerChainId}/${tokenAddress}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`DexScreener API error ${res.status}: ${await res.text()}`);
  }
  const pairs = await res.json();
  if (!Array.isArray(pairs) || pairs.length === 0) return null;

  return pairs.reduce((best, pair) => {
    const liq = pair.liquidity?.usd || 0;
    const bestLiq = best?.liquidity?.usd || 0;
    return liq > bestLiq ? pair : best;
  }, null);
}

// Chain-agnostic lookup by contract address, used to figure out which
// chain a pasted address belongs to before we know it ourselves.
export async function searchToken(query) {
  const url = `${BASE_URL}/latest/dex/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`DexScreener search error ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.pairs || [];
}

// priceUsd/marketCap/fdv on a DexScreener pair describe the pair's *base*
// token specifically — not necessarily the token we asked about, since our
// token can land on either side of the pair. tokenAddress lets us detect
// that and derive the correct price for our side via priceNative.
export function pairSummary(pair, tokenAddress) {
  if (!pair) return null;

  const isBaseToken = pair.baseToken?.address?.toLowerCase() === tokenAddress?.toLowerCase();
  const basePriceUsd = Number(pair.priceUsd) || 0;
  const priceNative = Number(pair.priceNative) || 0;
  const priceUsd = isBaseToken ? basePriceUsd : priceNative > 0 ? basePriceUsd / priceNative : 0;
  const tokenMeta = isBaseToken ? pair.baseToken : pair.quoteToken;
  // USD price of the chain's native/wrapped-native currency, derived from
  // this same pair — when our token is the base side, priceNative is native
  // units per token, so USD-per-native = basePriceUsd / priceNative; when
  // our token is the quote side, the base token *is* the native currency,
  // so basePriceUsd already *is* its USD price. Lets the execution layer
  // size a USD trade in native currency without a separate price oracle.
  const nativeUsdPrice = isBaseToken ? (priceNative > 0 ? basePriceUsd / priceNative : 0) : basePriceUsd;

  return {
    priceUsd,
    nativeUsdPrice,
    symbol: tokenMeta?.symbol || null,
    name: tokenMeta?.name || null,
    liquidityUsd: pair.liquidity?.usd || 0,
    // marketCap/fdv only apply to the base token; when our token is the
    // quote side, leave it 0 and let the caller derive it from total supply.
    marketCapUsd: isBaseToken ? pair.marketCap || pair.fdv || 0 : 0,
    volume24h: pair.volume?.h24 || 0,
    priceChange5m: pair.priceChange?.m5 ?? null,
    priceChange1h: pair.priceChange?.h1 ?? null,
    priceChange6h: pair.priceChange?.h6 ?? null,
    priceChange24h: pair.priceChange?.h24 ?? null,
    pairUrl: pair.url,
    pairAddress: pair.pairAddress,
    dexId: pair.dexId,
    createdAt: pair.pairCreatedAt || null,
    isBaseToken,
    hasSocials: (pair.info?.socials?.length || 0) + (pair.info?.websites?.length || 0) > 0,
    buys24h: pair.txns?.h24?.buys ?? null,
    sells24h: pair.txns?.h24?.sells ?? null,
  };
}
