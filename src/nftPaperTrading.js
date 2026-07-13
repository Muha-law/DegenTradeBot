import cron from "node-cron";
import { CHAINS } from "./chains.js";
import { isPaused } from "./botState.js";
import { loadNftPaperTradingSettings } from "./nftPaperTradingSettings.js";
import { getCollectionStats } from "./risk/opensea.js";
import {
  openNftPaperTrade,
  getOpenNftPaperTrades,
  touchNftPaperTrade,
  markNftPaperTradeListed,
  closeNftPaperTrade,
  getNftPaperTradingStats,
} from "./store/db.js";
import { postNftUpdate } from "./telegram/bot.js";
import { buildNftPaperTradeOpenMessage, buildNftListedMessage, buildNftPaperTradeCloseMessage } from "./telegram/formatMessage.js";

const CHECK_CRON = "*/5 * * * *"; // NFT floor prices move far slower than a DEX pool — 5m is plenty.

// No real token id exists yet at call time (an NFT paper trade simulates
// "buy the floor" the same way nftExecutor.js's real buy does) — "floor" is
// a stable synthetic id, fine since called_nft_collections' UNIQUE
// constraint upstream already guarantees only one trade is ever opened per
// collection in the first place.
const SYNTHETIC_TOKEN_ID = "floor";

export async function openNftPaperTradeIfRoom(bot, { chain, contractAddress, collectionSlug, name, floorPriceEth }) {
  const settings = loadNftPaperTradingSettings();
  if (!settings.enabled) return;
  if (!(floorPriceEth > 0)) return; // no listing to simulate a buy against yet

  const stats = getNftPaperTradingStats();
  if (stats.deployedEth + settings.positionSizeEth > settings.totalBudgetEth) {
    console.log(`[nftPaperTrading] budget exhausted (${stats.deployedEth}/${settings.totalBudgetEth} ETH) — skipping ${name}`);
    return;
  }

  const res = openNftPaperTrade({
    chain: chain.key,
    contractAddress,
    tokenId: SYNTHETIC_TOKEN_ID,
    collectionSlug,
    name: name || null,
    entryPriceEth: floorPriceEth,
    targetMultiple: settings.targetMultiple,
    stopFloorPct: settings.stopFloorPct,
    entryAt: Date.now(),
  });
  if (res.changes === 0) return;

  await postNftUpdate(
    bot,
    buildNftPaperTradeOpenMessage({
      chain,
      contractAddress,
      name,
      tokenId: SYNTHETIC_TOKEN_ID,
      entryPriceEth: floorPriceEth,
      targetMultiple: settings.targetMultiple,
      stopFloorPct: settings.stopFloorPct,
    })
  );
}

export function startNftPaperTradeChecker(bot) {
  const task = cron.schedule(CHECK_CRON, async () => {
    if (isPaused()) return;
    const settings = loadNftPaperTradingSettings();
    if (!settings.enabled) return;

    const open = getOpenNftPaperTrades();
    for (const t of open) {
      const chain = { key: t.chain, ...CHAINS[t.chain] };
      try {
        const stats = t.collection_slug ? await getCollectionStats(t.collection_slug).catch(() => null) : null;
        const floor = stats?.floorPriceEth;
        if (floor == null) {
          touchNftPaperTrade(t.id);
          continue;
        }

        if (t.status === "open") {
          const targetPrice = t.entry_price_eth * t.target_multiple;
          const stopPrice = t.entry_price_eth * (1 + t.stop_floor_pct / 100);

          if (floor >= targetPrice) {
            markNftPaperTradeListed(t.id, { listedPriceEth: floor, listedAt: Date.now() });
            await postNftUpdate(bot, buildNftListedMessage({ chain, contractAddress: t.contract_address, name: t.name, tokenId: t.token_id, listedPriceEth: floor, reason: "take_profit", mode: "paper" }));
          } else if (floor <= stopPrice) {
            markNftPaperTradeListed(t.id, { listedPriceEth: floor, listedAt: Date.now() });
            await postNftUpdate(bot, buildNftListedMessage({ chain, contractAddress: t.contract_address, name: t.name, tokenId: t.token_id, listedPriceEth: floor, reason: "stop_floor", mode: "paper" }));
          } else {
            touchNftPaperTrade(t.id);
          }
          continue;
        }

        // status === "listed" — simulate a fill once the market floor
        // reaches/exceeds the ask, since that means a real buyer would be
        // willing to pay at least that much. Left "listed" (illiquid,
        // unsold) otherwise — this is the part that actually validates
        // whether the exit side of NFT trading is realistic, not just the
        // entry side.
        if (floor >= t.listed_price_eth) {
          const exitPriceEth = t.listed_price_eth;
          const pnlEth = exitPriceEth - t.entry_price_eth;
          const pnlPct = (pnlEth / t.entry_price_eth) * 100;
          const exitReason = exitPriceEth >= t.entry_price_eth ? "take_profit_sold" : "stop_loss_sold";
          closeNftPaperTrade(t.id, { exitPriceEth, exitReason, pnlEth, pnlPct });
          await postNftUpdate(
            bot,
            buildNftPaperTradeCloseMessage({ chain, contractAddress: t.contract_address, name: t.name, tokenId: t.token_id, entryPriceEth: t.entry_price_eth, exitPriceEth, pnlEth, pnlPct, exitReason })
          );
        } else {
          touchNftPaperTrade(t.id);
        }
      } catch (err) {
        console.error(`[nftPaperTrading] failed to check ${t.name} (${t.chain}):`, err.message);
      }
    }
  });

  console.log(`[nftPaperTrading] position checker scheduled every 5m`);
  return task;
}
