import { getAccountEvents, openseaChainSlug } from "../risk/opensea.js";
import { getWatchedWallets, hasNftCopySignal, recordNftCopySignal } from "../store/db.js";

// Rest between full cycles once every watched wallet has been checked —
// meaningful mainly for small wallet lists (a handful of wallets would
// otherwise get re-polled near-instantly in a tight loop). For large lists
// this is dwarfed by MIN_INTER_WALLET_DELAY_MS below.
const POLL_INTERVAL_MS = 30000;

// Minimum spacing between each wallet's OpenSea call within one cycle.
// Firing all of them back-to-back was fine at a handful of wallets, but
// silently breaks at real scale (96+ wallets, one full cycle in a tight
// loop = 96+ reads inside a few seconds) — OpenSea's own documented free-
// tier ceiling is 60 reads/min. ~1.1s spacing keeps this comfortably under
// that regardless of exact key tier, at the cost of each individual wallet
// getting checked less often as the list grows (a 96-wallet list checks
// each wallet roughly every 100-130s, not every 30s) — a live-freshness
// tradeoff, not a correctness one; nothing is dropped, just delayed.
const MIN_INTER_WALLET_DELAY_MS = 1100;

// How far back to look on a wallet the very first time it's polled (either
// on process start, or right after being added via Telegram) — without
// this, occurredAfter would be undefined and OpenSea would return a wallet's
// *entire* sale history, which is both slow and would fire a flood of
// long-stale copy signals for a wallet that's just been added.
const INITIAL_BACKFILL_MS = 15 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Reloads the watched-wallet list from the DB every poll (cheap local
// query) so wallets added/removed via Telegram take effect without a
// restart — the same live-reload philosophy as chainSettings.js.
export function startNftWalletWatcher(chain, onWalletBuy) {
  let stopped = false;
  let timer = null;
  const cursors = new Map(); // address -> unix-seconds "occurred_after" for the next poll

  async function pollWallet(address) {
    const nowSec = Math.floor(Date.now() / 1000);
    const occurredAfter = cursors.get(address) ?? Math.floor((Date.now() - INITIAL_BACKFILL_MS) / 1000);

    const events = await getAccountEvents(address, {
      eventType: "sale",
      chain: openseaChainSlug(chain.key),
      occurredAfter,
    });

    let maxOccurredAtSec = occurredAfter;
    for (const e of events) {
      const eventOccurredAtSec = Math.floor(e.occurredAt / 1000);
      maxOccurredAtSec = Math.max(maxOccurredAtSec, eventOccurredAtSec);
      // Only the buy side is a copy signal — the same account also shows up
      // as `seller` in this feed if it sold something, which isn't a trade
      // to copy.
      if (!e.buyer || e.buyer.toLowerCase() !== address.toLowerCase()) continue;
      if (!e.contractAddress || !e.txHash) continue;
      if (hasNftCopySignal(e.txHash, address, e.contractAddress)) continue;

      recordNftCopySignal({ walletAddress: address, contractAddress: e.contractAddress, tokenId: e.tokenId, txHash: e.txHash });
      onWalletBuy({
        chain,
        walletAddress: address,
        contractAddress: e.contractAddress,
        tokenId: e.tokenId,
        priceEth: e.priceEth,
        txHash: e.txHash,
        timestamp: e.occurredAt,
      });
    }

    cursors.set(address, Math.max(maxOccurredAtSec, nowSec - 1) + 1);
  }

  async function poll() {
    if (stopped) return;
    try {
      const wallets = getWatchedWallets();
      for (let i = 0; i < wallets.length; i++) {
        if (stopped) break;
        try {
          await pollWallet(wallets[i].address);
        } catch (err) {
          console.error(`[${chain.key}] NFT wallet-watch poll failed for ${wallets[i].address}:`, err.message);
        }
        if (!stopped && i < wallets.length - 1) await sleep(MIN_INTER_WALLET_DELAY_MS);
      }
    } finally {
      if (!stopped) timer = setTimeout(poll, POLL_INTERVAL_MS);
    }
  }

  console.log(`[${chain.key}] polling OpenSea for watched-wallet NFT buys (~${MIN_INTER_WALLET_DELAY_MS}ms apart per wallet, ${POLL_INTERVAL_MS}ms rest between full cycles)`);
  poll();

  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
