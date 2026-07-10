import { CHAINS } from "./chains.js";
import { searchToken } from "./risk/dexscreener.js";

const dexscreenerChainToKey = Object.fromEntries(
  Object.entries(CHAINS).map(([key, c]) => [c.dexscreenerChainId, key])
);

// Figures out which of our supported chains a bare contract address is on,
// via DexScreener's chain-agnostic search, so the user doesn't have to say.
export async function detectChains(tokenAddress) {
  const pairs = await searchToken(tokenAddress);
  const addr = tokenAddress.toLowerCase();
  const matchingChainKeys = pairs
    .filter((p) => p.baseToken?.address?.toLowerCase() === addr || p.quoteToken?.address?.toLowerCase() === addr)
    .map((p) => dexscreenerChainToKey[p.chainId])
    .filter(Boolean);
  return [...new Set(matchingChainKeys)];
}
