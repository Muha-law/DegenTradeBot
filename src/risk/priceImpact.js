import { Contract } from "ethers";
import { getProvider } from "../wallet.js";

const PAIR_ABI = [
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
];
const V2_FEE_MULTIPLIER = 0.997; // standard Uniswap V2 0.3% fee

// Estimates price impact for a native-in trade against a V2 pair's current
// reserves — the standard constant-product formula, not a real on-chain
// simulation. Only supports V2 pairs (the large majority of pairs on this
// chain); returns null for V3-only pools or on any failure, letting callers
// simply omit the price-impact line rather than showing a wrong number.
export async function estimateV2PriceImpact(chain, pairAddress, wrappedNative, nativeAmountIn) {
  if (!pairAddress || nativeAmountIn <= 0) return null;
  try {
    const provider = getProvider(chain);
    const pair = new Contract(pairAddress, PAIR_ABI, provider);
    const [reserves, token0] = await Promise.all([pair.getReserves(), pair.token0()]);
    const nativeIsToken0 = token0.toLowerCase() === wrappedNative.toLowerCase();
    const reserveNative = Number(nativeIsToken0 ? reserves[0] : reserves[1]) / 1e18;
    const reserveToken = Number(nativeIsToken0 ? reserves[1] : reserves[0]);
    if (reserveNative <= 0 || reserveToken <= 0) return null;

    const amountInWithFee = nativeAmountIn * V2_FEE_MULTIPLIER;
    const amountOut = (reserveToken * amountInWithFee) / (reserveNative + amountInWithFee);
    const effectivePrice = nativeAmountIn / amountOut;
    const spotPrice = reserveNative / reserveToken;
    return ((effectivePrice - spotPrice) / spotPrice) * 100;
  } catch (err) {
    console.error(`[priceImpact] estimate failed for ${pairAddress}:`, err.message);
    return null;
  }
}
