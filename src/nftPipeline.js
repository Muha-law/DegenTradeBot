import { computeNftRiskScore } from "./risk/nftRisk.js";
import { applyNftFilter } from "./filters/nftFilter.js";
import { getContract, getCollection } from "./risk/opensea.js";
import { recordNftCall, recordDeployerOutcome, hasBeenCalledNft, addNftPendingListing } from "./store/db.js";
import { postNftCall } from "./telegram/bot.js";
import { openNftPaperTradeIfRoom } from "./nftPaperTrading.js";
import { openNftRealTradeIfRoom } from "./nftRealTrading.js";
import { loadNftRealTradingSettings } from "./nftRealTradingSettings.js";

// Scores an NFT collection, runs it through the filter, and posts+records a
// call if it passes. Shared by the new-collection watcher and the
// wallet-copy watcher — same role as pipeline.js's evaluateToken, but there
// is no "AI screen" stage here yet (the token side's rug-pattern/quantitative
// AI gates are token-specific — see pipeline.js — and weren't part of this
// feature's scope).
export async function evaluateNftCollection(bot, { chain, contractAddress, source, triggerWallet }) {
  if (hasBeenCalledNft(chain.key, contractAddress)) {
    return { pass: false, reasons: ["Already called"], riskResult: null };
  }

  const riskResult = await computeNftRiskScore(chain, contractAddress);
  const { pass, reasons } = applyNftFilter(riskResult, {
    source,
    triggerBuyPriceEth: triggerWallet?.buyPriceEth,
    triggerWalletAddress: triggerWallet?.address,
  });

  if (riskResult.deployerAddress) {
    recordDeployerOutcome(riskResult.deployerAddress, { lowScore: riskResult.score < 40 });
  }

  if (!pass) {
    return { pass: false, reasons, riskResult };
  }

  const { name, slug, stats, totalSupply, imageUrl } = riskResult;

  const messageId = await postNftCall(bot, { chain, contractAddress, riskResult, source, triggerWalletLabel: triggerWallet?.label || triggerWallet?.address });

  recordNftCall({
    chain: chain.key,
    contractAddress,
    collectionSlug: slug || null,
    name: name || null,
    imageUrl: imageUrl || null,
    callFloorPriceEth: stats?.floorPriceEth ?? null,
    callVolume24hEth: stats?.volume24hEth ?? null,
    callNumOwners: stats?.numOwners ?? null,
    callTotalSupply: totalSupply ?? null,
    riskScore: riskResult.score,
    riskGrade: riskResult.grade,
    source,
    triggerWalletAddress: triggerWallet?.address || null,
    telegramMessageId: messageId,
    calledAt: Date.now(),
  });

  // Paper trading always runs alongside real trading, same as the token
  // side — the ongoing validation signal regardless of whether real funds
  // are in play.
  await openNftPaperTradeIfRoom(bot, { chain, contractAddress, collectionSlug: slug, name, floorPriceEth: stats?.floorPriceEth });

  await maybeOpenRealTrade(bot, { chain, contractAddress, collectionSlug: slug, name, floorPriceEth: stats?.floorPriceEth });

  return { pass: true, riskResult, name };
}

// Real buying only ever targets a currently-fulfillable secondary-market
// listing (see the plan doc's "Important asymmetry vs. token trading") — a
// brand-new collection usually has no listing at call time, since it's
// still minting. When that's the case, queue it for the recheck loop below
// instead of failing the buy outright.
async function maybeOpenRealTrade(bot, { chain, contractAddress, collectionSlug, name, floorPriceEth }) {
  const settings = loadNftRealTradingSettings();
  if (!settings.enabled) return;

  if (floorPriceEth > 0) {
    try {
      const opened = await openNftRealTradeIfRoom(bot, { chain, contractAddress, collectionSlug, name });
      if (opened) return;
      // Skipped for a retryable reason (budget/wallet/floor moved) — fall
      // through and queue so the recheck loop can try again as conditions change.
    } catch {
      // Fall through to the pending queue — e.g. the listing that made
      // floorPriceEth > 0 got fulfilled by someone else in the gap between
      // the stats snapshot and the buy attempt.
    }
  }

  addNftPendingListing({ chain: chain.key, contractAddress, calledAt: Date.now() });
}

// Called by nftBuyRecheckQueue.js — re-resolves collection slug/name fresh
// (not persisted on the pending row) and retries the real buy.
export async function retryNftPendingBuy(bot, { chain, contractAddress }) {
  const settings = loadNftRealTradingSettings();
  if (!settings.enabled) return { bought: false };

  const contractInfo = await getContract(chain.key, contractAddress).catch(() => null);
  const slug = contractInfo?.slug || null;
  const collection = slug ? await getCollection(slug).catch(() => null) : null;
  const name = collection?.name || contractInfo?.name || null;

  // openNftRealTradeIfRoom returns false (no throw) when it skipped for a
  // retryable reason — budget exhausted, no wallet, floor moved. Reporting
  // those as bought:true made the recheck queue permanently dequeue entries
  // it never actually bought.
  const opened = await openNftRealTradeIfRoom(bot, { chain, contractAddress, collectionSlug: slug, name });
  return { bought: opened === true };
}
