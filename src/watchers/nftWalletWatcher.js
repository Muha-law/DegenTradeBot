import { getAccountEvents, openseaChainSlug } from "../risk/opensea.js";
import { getWatchedWallets, hasNftCopySignal, recordNftCopySignal } from "../store/db.js";

const POLL_INTERVAL_MS = 30000;

// How far back to look on a wallet the very first time it's polled (either
// on process start, or right after being added via Telegram) — without
// this, occurredAfter would be undefined and OpenSea would return a wallet's
// *entire* sale history, which is both slow and would fire a flood of
// long-stale copy signals for a wallet that's just been added.
const INITIAL_BACKFILL_MS = 15 * 60 * 1000;

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
      for (const w of wallets) {
        if (stopped) break;
        try {
          await pollWallet(w.address);
        } catch (err) {
          console.error(`[${chain.key}] NFT wallet-watch poll failed for ${w.address}:`, err.message);
        }
      }
    } finally {
      if (!stopped) timer = setTimeout(poll, POLL_INTERVAL_MS);
    }
  }

  console.log(`[${chain.key}] polling OpenSea for watched-wallet NFT buys every ${POLL_INTERVAL_MS}ms`);
  poll();

  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
