import { Contract, Interface, zeroPadValue } from "ethers";
import { getProvider } from "../wallet.js";

// Simulates real holders selling, to catch honeypots BEFORE we call/buy a
// token — not after, like execution/swapExecutor.js's verifySellable (which
// needs an already-bought balance and so can only run post-purchase).
//
// The key trick: eth_call lets us simulate a transfer FROM any address
// without their private key. So we pull addresses that actually bought this
// token (Transfer events out of the pair contract), then simulate each one
// selling their real balance back into the pair. No tokens needed, no gas,
// no transaction.
//
// This specifically catches SELECTIVE honeypots, which defeat every other
// check in this bot. Confirmed live on SYDNEY
// (0x0da1DE7f85F8f2dab381CaE401BCBCEbA6Cf01ae): $53K real liquidity, LP 100%
// burned, 1,428 real buys, innocuous name — passed every numeric filter, the
// LP-lock gate, and both AI screens. But 8 of 10 real holders were blocked
// from selling (crafted "ETH transfer failed" revert) while 2 whitelisted
// insiders could sell freely. A blanket honeypot check that only tests one
// address would have been fooled; testing a sample of real holders is what
// exposes it.

const TRANSFER_ABI = ["event Transfer(address indexed from, address indexed to, uint256 value)"];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];

const BUYER_LOOKBACK_BLOCKS = 50_000;
const MAX_HOLDERS_TO_TEST = 8;
const MAX_BUYERS_TO_SCAN = 60; // cap balanceOf calls — most recent buyers have already sold
// Fail the token if more than this share of tested holders can't sell. Not
// 100%: a couple of genuine reverts can happen for benign reasons (a holder
// whose balance moved between our read and the simulation, an odd
// fee-on-transfer edge case), and the whole point is that a selective
// honeypot leaves a *few* addresses able to sell.
const MAX_BLOCKED_FRACTION = 0.5;
const MIN_HOLDERS_FOR_VERDICT = 3; // below this, too little signal to judge either way

// Returns:
//   { tested, blocked, blockedFraction, honeypot: true|false }  — a real verdict
//   { tested, honeypot: null, reason }                          — not enough data / lookup failed
// honeypot: null must be treated as "unknown", never as "safe".
export async function probeSellability(chain, tokenAddress, pairAddress) {
  if (!pairAddress) return { tested: 0, honeypot: null, reason: "No pair address to probe against" };

  try {
    const provider = getProvider(chain);
    const iface = new Interface(TRANSFER_ABI);
    const currentBlock = await provider.getBlockNumber();

    // Transfers FROM the pair = tokens leaving the pool into a buyer's wallet.
    const logs = await provider.getLogs({
      address: tokenAddress,
      topics: [iface.getEvent("Transfer").topicHash, zeroPadValue(pairAddress, 32)],
      fromBlock: Math.max(0, currentBlock - BUYER_LOOKBACK_BLOCKS),
      toBlock: currentBlock,
    });
    if (logs.length === 0) return { tested: 0, honeypot: null, reason: "No buyers found to probe" };

    // Most recent buyers first — they're likeliest to still hold a balance.
    const buyers = [...new Set(logs.reverse().map((log) => "0x" + log.topics[2].slice(26)))];

    const token = new Contract(tokenAddress, ERC20_ABI, provider);
    let tested = 0;
    let blocked = 0;

    for (const buyer of buyers.slice(0, MAX_BUYERS_TO_SCAN)) {
      if (tested >= MAX_HOLDERS_TO_TEST) break;

      const balance = await token.balanceOf(buyer).catch(() => 0n);
      if (balance === 0n) continue; // already sold out / never held — nothing to test

      tested++;
      try {
        // The first leg of any sell: move tokens into the pair contract.
        // A honeypot's transfer hook reverts here for non-whitelisted senders.
        await token.transfer.staticCall(pairAddress, balance / 2n, { from: buyer });
      } catch {
        blocked++;
      }
    }

    if (tested < MIN_HOLDERS_FOR_VERDICT) {
      return { tested, honeypot: null, reason: `Only ${tested} holders with a balance found — too few to judge` };
    }

    const blockedFraction = blocked / tested;
    return {
      tested,
      blocked,
      blockedFraction,
      honeypot: blockedFraction > MAX_BLOCKED_FRACTION,
    };
  } catch (err) {
    console.error(`[sellability] probe failed for ${tokenAddress}:`, err.message);
    return { tested: 0, honeypot: null, reason: `Probe failed: ${err.message}` };
  }
}
