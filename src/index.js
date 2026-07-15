import { CHAINS } from "./chains.js";
import { getActiveChainDefs, setChainEnabled, loadEnabledChains } from "./chainSettings.js";
import { isPaused } from "./botState.js";
import { startPairWatcher } from "./watchers/pairWatcher.js";
import { startPollingWatcher } from "./watchers/pollingWatcher.js";
import { evaluateToken } from "./pipeline.js";
import { addPending, countPending, countSeen, countCalled, countCalledNft } from "./store/db.js";
import { createBot } from "./telegram/bot.js";
import { startMilestoneChecker, startWatchlistDigest } from "./priceUpdater.js";
import { startRecheckQueue } from "./recheckQueue.js";
import { startTrackUpdater } from "./trackUpdater.js";
import { startStalePriceRugCheck } from "./stalePriceRugCheck.js";
import { startPaperTradeChecker } from "./paperTrading.js";
import { startRealTradeChecker } from "./realTrading.js";
import { config } from "./config.js";
import { startNftCollectionWatcher } from "./watchers/nftCollectionWatcher.js";
import { startNftWalletWatcher } from "./watchers/nftWalletWatcher.js";
import { evaluateNftCollection } from "./nftPipeline.js";
import { startNftBuyRecheckQueue } from "./nftBuyRecheckQueue.js";
import { startNftPaperTradeChecker } from "./nftPaperTrading.js";
import { startNftRealTradeChecker } from "./nftRealTrading.js";
import { startNftOutcomeTracker } from "./nftOutcomeTracker.js";
import { getNftChainDefs } from "./nftChains.js";

// Last line of defense: an async failure anywhere that isn't already
// caught (a cron job's send call, a stray promise) otherwise crashes the
// whole process by default in modern Node. Log it and keep running instead
// — a single failed message send should never take the bot down.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (bot kept running):", err?.message || err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (bot kept running):", err?.message || err);
});

// seen/called are always read fresh from the DB (not in-memory counters) so
// they reflect true cumulative totals across restarts, not just this run.
const stats = {
  get seen() { return countSeen(); },
  get called() { return countCalled(); },
  get pending() { return countPending(); },
  get nftCalled() { return countCalledNft(); },
};

async function handleNewToken({ chain, dexName, pairAddress, tokenAddress, timestamp }) {
  if (isPaused()) return;
  console.log(`[${chain.key}/${dexName}] new pair ${pairAddress} → token ${tokenAddress}`);

  try {
    const result = await evaluateToken(bot, { chain, dexName, pairAddress, tokenAddress, ageMinutes: 0 });

    if (result.pass) {
      console.log(`[${chain.key}] called ${result.symbol || "?"} (${tokenAddress}) — score ${result.riskResult.score}`);
      return;
    }

    if (result.reasons.includes("Already called")) return; // e.g. the same token seen via a second DEX pair

    console.log(`[${chain.key}] ${tokenAddress} not yet passing: ${result.reasons.join("; ")} — queued for recheck`);
    addPending({ chain: chain.key, tokenAddress, pairAddress, dexName, firstSeenAt: timestamp });
  } catch (err) {
    console.error(`[${chain.key}] failed to process ${tokenAddress}:`, err.message);
  }
}

async function handleNewNftCollection({ chain, contractAddress }) {
  if (isPaused()) return;
  console.log(`[${chain.key}] new NFT collection ${contractAddress}`);
  try {
    const result = await evaluateNftCollection(bot, { chain, contractAddress, source: "new_collection" });
    if (result.pass) {
      console.log(`[${chain.key}] called NFT ${result.name || "?"} (${contractAddress}) — score ${result.riskResult.score}`);
    }
  } catch (err) {
    console.error(`[${chain.key}] failed to process NFT collection ${contractAddress}:`, err.message);
  }
}

async function handleWalletNftBuy({ chain, walletAddress, contractAddress, priceEth }) {
  if (isPaused()) return;
  console.log(`[${chain.key}] watched wallet ${walletAddress} bought NFT ${contractAddress} for ${priceEth ?? "?"} ETH`);
  try {
    const result = await evaluateNftCollection(bot, {
      chain,
      contractAddress,
      source: "copy_trade",
      triggerWallet: { address: walletAddress, buyPriceEth: priceEth },
    });
    if (result.pass) {
      console.log(`[${chain.key}] called NFT ${result.name || "?"} (${contractAddress}) via copy signal — score ${result.riskResult.score}`);
    }
  } catch (err) {
    console.error(`[${chain.key}] failed to process copy-trade NFT ${contractAddress}:`, err.message);
  }
}

// Chains can be toggled live from the bot's Chains menu, so watchers start
// and stop dynamically instead of being fixed at boot.
const activeWatchers = new Map(); // chainKey -> stop function

function startChainWatcher(chainKey) {
  if (activeWatchers.has(chainKey)) return;
  const chainDef = CHAINS[chainKey];
  if (!chainDef) return;
  const chain = { key: chainKey, ...chainDef };
  const stop = chainDef.pollingOnly ? startPollingWatcher(chain, handleNewToken) : startPairWatcher(chain, handleNewToken);
  activeWatchers.set(chainKey, stop);
}

function stopChainWatcher(chainKey) {
  const stop = activeWatchers.get(chainKey);
  if (!stop) return;
  stop();
  activeWatchers.delete(chainKey);
}

const chainControls = {
  toggleChain(chainKey, enabled) {
    setChainEnabled(chainKey, enabled);
    if (enabled) startChainWatcher(chainKey);
    else stopChainWatcher(chainKey);
  },
  getEnabledKeys: () => loadEnabledChains(),
};

// digestControls is needed by both createBot (for the Watchlist menu) and
// startWatchlistDigest (which needs `bot` to exist first) — break the cycle
// with a stable object that gets patched with the real functions below.
const digestControls = { sendNow: async () => {}, reschedule: () => {} };

const bot = createBot(stats, chainControls, digestControls);
for (const chainDef of getActiveChainDefs()) startChainWatcher(chainDef.key);
startMilestoneChecker(bot);
Object.assign(digestControls, startWatchlistDigest(bot));
startRecheckQueue(bot);
startTrackUpdater(bot);
startPaperTradeChecker(bot);
startRealTradeChecker(bot);
startStalePriceRugCheck(bot);

// NFT support lives entirely behind OPENSEA_API_KEY being configured —
// with no key, none of this starts and the rest of the bot behaves exactly
// as it did before this feature existed. Which chains it watches (default
// Base + Robinhood Chain, not Ethereum) comes from nftChains.js — one
// collection watcher + one wallet watcher per chain; the pending-listing/
// paper/real-trade checkers already key off each stored row's own `chain`
// field via CHAINS[...], so they don't need per-chain wiring here.
const nftWatcherStops = [];
if (config.openseaApiKey) {
  for (const nftChain of getNftChainDefs()) {
    nftWatcherStops.push(startNftCollectionWatcher(nftChain, handleNewNftCollection));
    nftWatcherStops.push(startNftWalletWatcher(nftChain, handleWalletNftBuy));
  }
  startNftBuyRecheckQueue(bot);
  startNftPaperTradeChecker(bot);
  startNftRealTradeChecker(bot);
  startNftOutcomeTracker();
} else {
  console.log("[nft] OPENSEA_API_KEY not set — NFT features disabled");
}

// bot.launch() only resolves after bot.stop() is called (it awaits the
// polling loop itself), so confirm startup via the onLaunch callback instead.
bot.launch({}, () => console.log(`Telegram bot launched as @${bot.botInfo?.username}.`)).catch((err) => {
  console.error("Telegram bot crashed:", err.message);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.log(`Received ${signal}, shutting down…`);
    activeWatchers.forEach((stop) => stop());
    nftWatcherStops.forEach((stop) => stop());
    bot.stop(signal);
    process.exit(0);
  });
}
