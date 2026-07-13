import cron from "node-cron";
import { CHAINS } from "./chains.js";
import { isPaused } from "./botState.js";
import { checkFreshFloorPrice } from "./filters/nftFilter.js";
import { loadNftRealTradingSettings } from "./nftRealTradingSettings.js";
import { getCollectionStats, getAccountEvents, openseaChainSlug } from "./risk/opensea.js";
import { buyNftCollectionFloor, listNftForSale } from "./execution/nftExecutor.js";
import { hasWallet, getWalletAddress } from "./wallet.js";
import {
  openNftRealTrade,
  getOpenNftRealTrades,
  touchNftRealTrade,
  markNftRealTradeListed,
  closeNftRealTrade,
  getNftRealTradingStats,
} from "./store/db.js";
import { postNftUpdate } from "./telegram/bot.js";
import { buildNftRealTradeOpenMessage, buildNftListedMessage, buildNftRealTradeCloseMessage } from "./telegram/formatMessage.js";

const CHECK_CRON = "*/5 * * * *";

// Called whenever an NFT call passes the filter — same gating shape as
// realTrading.js's openRealTradeIfRoom: explicitly enabled, wallet
// configured, budget check, and the hard per-buy ceiling enforced inside
// buyNftCollectionFloor itself (defense in depth, independent of this
// settings file — same rationale as the token side's ABSOLUTE_MAX_USD_PER_TRADE).
//
// Returns true only when a position was actually opened. The distinction
// matters to nftBuyRecheckQueue: an early return here (budget exhausted, no
// wallet) used to be indistinguishable from a successful buy, so the queue
// removed pending entries it never actually bought.
export async function openNftRealTradeIfRoom(bot, { chain, contractAddress, collectionSlug, name }) {
  const settings = loadNftRealTradingSettings();
  if (!settings.enabled) return false;
  if (!hasWallet()) return false;

  const stats = getNftRealTradingStats();
  if (stats.deployedEth + settings.positionSizeEth > settings.totalBudgetEth) {
    console.log(`[nftRealTrading] budget exhausted (${stats.deployedEth}/${settings.totalBudgetEth} ETH) — skipping ${name}`);
    return false;
  }

  // Fresh floor re-check right before spending real money — same role as
  // realTrading.js's checkFreshLiquidity call: the filter pass that got us
  // here can be minutes (or, via the recheck queue, hours) stale.
  if (collectionSlug) {
    const floorCheck = await checkFreshFloorPrice(collectionSlug);
    if (!floorCheck.pass) {
      console.log(`[nftRealTrading] ${name}: ${floorCheck.reason} — skipping buy`);
      return false;
    }
  }

  let result;
  try {
    result = await buyNftCollectionFloor(chain, { contractAddress, maxPriceEth: settings.positionSizeEth });
  } catch (err) {
    // Expected/routine when a collection has no listing yet (brand-new
    // collection, nothing for sale) — the pending-listing recheck queue in
    // nftPipeline.js retries this later, so this isn't logged as an error.
    console.log(`[nftRealTrading] buy attempt for ${name} (${contractAddress}) didn't complete: ${err.message}`);
    throw err; // let the caller (pipeline / recheck queue) decide whether to requeue
  }

  const res = openNftRealTrade({
    chain: chain.key,
    contractAddress,
    tokenId: result.tokenId,
    collectionSlug,
    name: name || null,
    entryPriceEth: result.priceEth,
    targetMultiple: settings.targetMultiple,
    stopFloorPct: settings.stopFloorPct,
    entryAt: Date.now(),
    entryTxHash: result.txHash,
    entryGasEth: result.gasEth,
  });
  if (res.changes === 0) {
    console.error(`[nftRealTrading] bought ${name} #${result.tokenId} but a DB row already existed — tx ${result.txHash} needs manual reconciliation`);
    // The on-chain buy DID happen — report true so the recheck queue never
    // re-buys the same collection while the row conflict gets sorted out.
    return true;
  }

  await postNftUpdate(
    bot,
    buildNftRealTradeOpenMessage({
      chain,
      contractAddress,
      name,
      tokenId: result.tokenId,
      entryPriceEth: result.priceEth,
      targetMultiple: settings.targetMultiple,
      stopFloorPct: settings.stopFloorPct,
      txHash: result.txHash,
      gasEth: result.gasEth,
    })
  );
  return true;
}

export function startNftRealTradeChecker(bot) {
  const task = cron.schedule(CHECK_CRON, async () => {
    if (isPaused()) return;
    const settings = loadNftRealTradingSettings();
    if (!settings.enabled) return;
    const walletAddress = getWalletAddress();
    if (!walletAddress) return;

    const open = getOpenNftRealTrades();
    for (const t of open) {
      const chain = { key: t.chain, ...CHAINS[t.chain] };
      try {
        const stats = t.collection_slug ? await getCollectionStats(t.collection_slug).catch(() => null) : null;
        const floor = stats?.floorPriceEth;

        if (t.status === "open") {
          if (floor == null) {
            touchNftRealTrade(t.id);
            continue;
          }
          const targetPrice = t.entry_price_eth * t.target_multiple;
          const stopPrice = t.entry_price_eth * (1 + t.stop_floor_pct / 100);
          let listPriceEth = null;
          let reason = null;
          if (floor >= targetPrice) {
            listPriceEth = floor;
            reason = "take_profit";
          } else if (floor <= stopPrice) {
            listPriceEth = floor; // list at current floor to maximize odds of an actual fill
            reason = "stop_floor";
          } else {
            touchNftRealTrade(t.id);
            continue;
          }

          try {
            const listing = await listNftForSale(chain, {
              contractAddress: t.contract_address,
              tokenId: t.token_id,
              priceEth: listPriceEth,
              collectionSlug: t.collection_slug,
            });
            markNftRealTradeListed(t.id, { listedPriceEth: listPriceEth, listedAt: Date.now(), listingOrderHash: listing.orderHash });
            await postNftUpdate(
              bot,
              buildNftListedMessage({ chain, contractAddress: t.contract_address, name: t.name, tokenId: t.token_id, listedPriceEth: listPriceEth, reason, mode: "real" })
            );
          } catch (err) {
            // Listing failed (Seaport order construction is the least-
            // verified part of this integration — see nftExecutor.js) —
            // leave the position open and retry next cycle rather than lose
            // track of it.
            console.error(`[nftRealTrading] failed to list ${t.name} #${t.token_id} for sale:`, err.message);
            touchNftRealTrade(t.id);
          }
          continue;
        }

        // status === "listed" — poll our own wallet's sale events to detect
        // a real fill. No gas cost to record here: fulfilling a listing is
        // paid by the *buyer*, not the seller — the only gas this position
        // ever cost the bot's wallet was the one-time setApprovalForAll
        // inside nftExecutor.js's listNftForSale, already folded into
        // entry_gas_eth's role... actually tracked separately as it happens
        // per-collection, not per-trade; left at 0 here rather than guessed.
        const events = await getAccountEvents(walletAddress, {
          eventType: "sale",
          chain: openseaChainSlug(chain.key),
          occurredAfter: Math.floor((t.listed_at || t.entry_at) / 1000) - 60,
        }).catch(() => []);
        const sale = events.find(
          (e) => e.seller?.toLowerCase() === walletAddress.toLowerCase() && e.contractAddress?.toLowerCase() === t.contract_address.toLowerCase() && String(e.tokenId) === String(t.token_id)
        );

        if (sale) {
          const exitPriceEth = sale.priceEth ?? t.listed_price_eth;
          const pnlEth = exitPriceEth - t.entry_price_eth - (t.entry_gas_eth || 0);
          const pnlPct = (pnlEth / t.entry_price_eth) * 100;
          const exitReason = exitPriceEth >= t.entry_price_eth ? "take_profit_sold" : "stop_loss_sold";
          closeNftRealTrade(t.id, { exitPriceEth, exitReason, pnlEth, pnlPct, exitTxHash: sale.txHash, exitGasEth: 0 });
          await postNftUpdate(
            bot,
            buildNftRealTradeCloseMessage({ chain, contractAddress: t.contract_address, name: t.name, tokenId: t.token_id, entryPriceEth: t.entry_price_eth, exitPriceEth, pnlEth, pnlPct, exitReason, txHash: sale.txHash, gasEth: 0 })
          );
        } else {
          touchNftRealTrade(t.id);
        }
      } catch (err) {
        console.error(`[nftRealTrading] failed to check ${t.name} (${t.chain}):`, err.message);
      }
    }
  });

  console.log(`[nftRealTrading] position checker scheduled every 5m`);
  return task;
}
