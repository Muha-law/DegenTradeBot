import { Contract } from "ethers";
import { getProvider } from "../wallet.js";

// A Uniswap V2 pair contract IS the LP token (standard ERC20) — no GoPlus
// coverage needed. Validated against 257 real historical Robinhood Chain
// pairs (see scripts/backtestLpLock.js): locked-at-launch tokens rugged
// 70.4% of the time vs 88.2% unlocked — real signal, not a safety guarantee.
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const LOCKED_FRACTION_THRESHOLD = 0.5;

const LP_TOKEN_ABI = [
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

// Checks current LP-token lock status for a pair. Returns null (not "false")
// on any failure — callers should treat null as "unknown," not "unlocked,"
// since a transient RPC error shouldn't masquerade as a real risk signal.
export async function checkLpLock(chain, pairAddress) {
  if (!pairAddress) return null;
  try {
    const provider = getProvider(chain);
    const pair = new Contract(pairAddress, LP_TOKEN_ABI, provider);
    const [total, dead, zero] = await Promise.all([
      pair.totalSupply(),
      pair.balanceOf(DEAD_ADDRESS),
      pair.balanceOf(ZERO_ADDRESS),
    ]);
    if (total === 0n) return null;
    const lockedFraction = Number(((dead + zero) * 10000n) / total) / 10000;
    return { lockedFraction, isLocked: lockedFraction >= LOCKED_FRACTION_THRESHOLD };
  } catch (err) {
    console.error(`[lpLock] check failed for ${pairAddress}:`, err.message);
    return null;
  }
}
