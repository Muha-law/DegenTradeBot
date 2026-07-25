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

// Some RPCs cap eth_getLogs to a much smaller range than BUYER_LOOKBACK_BLOCKS
// in one request. Two distinct flavors of this seen live:
//   - Stable chain enforces a hard 500-block max ("maximum [from, to] blocks
//     distance: 500"). Its ~0.5s blocks make 500 blocks a meaningful few
//     minutes of real activity.
//   - BSC's free public node (bsc-rpc.publicnode.com) rejects anything beyond
//     roughly its last ~50 blocks of logs as an "Archive requests require a
//     personal token" error — confirmed empirically (a 50-block address-
//     filtered query returns logs; 200+ fails). Without adapting to that, the
//     single-shot AND a fixed 500-block chunk both fail, and probeSellability
//     silently returned "unknown" for every BSC token — i.e. the selective-
//     honeypot gate was effectively disabled on the busiest, most honeypot-
//     prone chain. The durable fix is a fuller RPC, but the probe should
//     still use whatever recent window the node will serve rather than give
//     up entirely.
// Tries the full range in one shot first (fast path for a normal RPC), then
// falls back to adaptive newest-first chunking that shrinks the window on a
// range/archive error down to a floor, keeping whatever it can fetch. Never
// throws from the fallback: returns whatever was gathered (possibly empty),
// which the caller treats as "unknown", never "safe".
const CHUNKED_FALLBACK_RANGE = 500;
const MIN_CHUNK_RANGE = 25; // floor for the shrink — some free nodes only serve ~50 recent blocks of logs
const MAX_CHUNK_REQUESTS = 40; // bound total getLogs calls so a tiny window can't fan out unbounded (rate limits)
// Wall-clock ceiling on the whole chunked scan. probeSellability runs inline
// in the call pipeline (evaluateToken), so its latency directly delays a
// call/buy — and on a chain where every window has to be fetched in small
// chunks, a quiet token with sparse recent buys could otherwise spend 20s+
// walking empty windows. An active token (the case that matters) hits the
// buyer cap in a chunk or two well under this; the bound just stops a slow
// token from stalling the pipeline, degrading to "unknown" (safe) instead.
const MAX_SCAN_MS = 8000;

function isRangeLimitError(err) {
  return /blocks? distance|block range|archive|personal token|response size|result set too large|limit exceeded/i.test(err?.message || "");
}

async function getBuyerTransferLogs(provider, tokenAddress, pairAddress, transferTopic, fromBlock, currentBlock) {
  const topics = [transferTopic, zeroPadValue(pairAddress, 32)];
  try {
    return await provider.getLogs({ address: tokenAddress, topics, fromBlock, toBlock: currentBlock });
  } catch {
    // ANY single-shot failure falls through to the bounded, newest-first
    // chunked scan below — it's strictly a better recovery than giving up
    // (never throws; returns whatever it can). RPCs signal an over-wide range
    // inconsistently: a hard cap message (Stable), an archive restriction
    // (BSC's free node), or just a generic -32000 "internal server error"
    // (Robinhood Chain returns exactly this for the 50k range) — matching on
    // the message text alone missed Robinhood entirely and left the probe
    // disabled there. isRangeLimitError is still used *inside* the loop to
    // decide shrink-vs-give-up per chunk, where the distinction does matter.
  }

  // Caller expects ascending chronological order (same as a single getLogs
  // call would return) and reverses it itself to prioritize recent buyers —
  // scanning newest-chunk-first here just bounds how much has to be fetched
  // before there's enough to work with, not the final order, so everything
  // gets sorted back into place before returning.
  const logs = [];
  let chunkEnd = currentBlock;
  let chunkSize = CHUNKED_FALLBACK_RANGE;
  let requests = 0;
  const deadline = Date.now() + MAX_SCAN_MS;
  while (chunkEnd >= fromBlock && logs.length < MAX_BUYERS_TO_SCAN && requests < MAX_CHUNK_REQUESTS && Date.now() < deadline) {
    const chunkStart = Math.max(fromBlock, chunkEnd - chunkSize + 1);
    requests++;
    try {
      const chunkLogs = await provider.getLogs({ address: tokenAddress, topics, fromBlock: chunkStart, toBlock: chunkEnd });
      logs.push(...chunkLogs);
      chunkEnd = chunkStart - 1; // advance to the next-older window only on success
    } catch (err) {
      // Window still too wide for this node — halve it and retry the SAME
      // (newest) window, down to the floor. Once shrunk, the smaller size
      // carries forward to subsequent windows too.
      if (isRangeLimitError(err) && chunkSize > MIN_CHUNK_RANGE) {
        chunkSize = Math.max(MIN_CHUNK_RANGE, Math.floor(chunkSize / 2));
        continue;
      }
      break; // even the floor window failed, or a non-range error — stop with whatever we have
    }
  }
  logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  return logs;
}

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
    const logs = await getBuyerTransferLogs(
      provider,
      tokenAddress,
      pairAddress,
      iface.getEvent("Transfer").topicHash,
      Math.max(0, currentBlock - BUYER_LOOKBACK_BLOCKS),
      currentBlock
    );
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
        // A honeypot's transfer hook usually reverts here for non-whitelisted
        // senders — but ERC20's spec also allows a non-reverting failure
        // (transfer() returning false instead of throwing), a pattern some
        // honeypots use specifically because it's easy for a caller to check
        // only for a revert and miss it. staticCall resolves normally with
        // the decoded return value in that case, so it has to be checked
        // explicitly rather than relying on the catch block alone.
        const success = await token.transfer.staticCall(pairAddress, balance / 2n, { from: buyer });
        if (success === false) blocked++;
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
