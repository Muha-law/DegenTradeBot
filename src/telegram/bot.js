import { Telegraf, Markup } from "telegraf";
import { config } from "../config.js";
import { CHAINS } from "../chains.js";
import { getActiveChainDefs, isChainEnabled } from "../chainSettings.js";
import { isPaused, setPaused } from "../botState.js";
import { loadFilters, saveFilters } from "../filters/filter.js";
import { computeRiskScore } from "../risk/riskScore.js";
import { getBestPair, pairSummary } from "../risk/dexscreener.js";
import { detectChains } from "../chainDetect.js";
import {
  addTrack,
  getActiveTracks,
  deactivateTrack,
  getPaperTradingStats,
  getClosedPaperTrades,
  getOpenPaperTrades,
  getPaperTradeById,
  closePaperTrade,
  getRealTradingStats,
  getClosedRealTrades,
  getOpenRealTrades,
  getRealTradeById,
  closeRealTrade,
  reduceRealTrade,
  getOpenRealTradeByToken,
  openRealTrade,
  recordBotUser,
  countBotUsers,
  getRecentCalls,
  deactivateCallByToken,
  toggleCallPinned,
  getWatchedWallets,
  addWatchedWallet,
  removeWatchedWallet,
  getAllWalletTrackRecords,
  getNftPaperTradingStats,
  getNftRealTradingStats,
  getOpenNftPaperTrades,
  getOpenNftRealTrades,
} from "../store/db.js";
import { buildDigestEntries } from "../watchlist.js";
import { loadDigestSettings, saveDigestSettings } from "../digestSettings.js";
import { loadPresets, applyPreset } from "../presets.js";
import { loadPaperTradingSettings, savePaperTradingSettings } from "../paperTradingSettings.js";
import { loadRealTradingSettings, saveRealTradingSettings } from "../realTradingSettings.js";
import { hasWallet, getWalletAddress, getNativeBalance, resolveEnsName } from "../wallet.js";
import { sellToken, buyTokenWithNativeAmount, withSlippageRetry } from "../execution/swapExecutor.js";
import { estimateV2PriceImpact } from "../risk/priceImpact.js";
import { renderOpenCard, renderCloseCard } from "./tradeCard.js";
import { computeNftRiskScore } from "../risk/nftRisk.js";
import { getContract } from "../risk/opensea.js";
import { getNftChainKeys, getNftChainDefs } from "../nftChains.js";
import { loadNftFilters, saveNftFilters } from "../filters/nftFilter.js";
import { loadNftPaperTradingSettings, saveNftPaperTradingSettings } from "../nftPaperTradingSettings.js";
import { loadNftRealTradingSettings, saveNftRealTradingSettings } from "../nftRealTradingSettings.js";
import {
  buildCallMessage,
  buildWatchlistDigest,
  buildPaperTradingSummary,
  buildActiveTradesMessage,
  buildRealTradingSummary,
  buildNftCallMessage,
  buildNftTradingSummary,
  fmtUsd,
  fmtPrice,
  fmtPriceCompact,
  explorerUrlFor,
  escapeMd,
  WATCHLIST_PAGE_SIZE,
} from "./formatMessage.js";

function isSanePrice(n) {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n < 1e12;
}

// Fetches live prices for every open paper trade and derives unrealized
// PnL per trade plus the total — same live-price pattern as
// renderTracklistText below, just against paper_trades instead of tracked_tokens.
async function getOpenTradesWithLivePnl() {
  const open = getOpenPaperTrades();
  let totalUnrealizedUsd = 0;

  const trades = await Promise.all(
    open.map(async (t) => {
      const chainDef = CHAINS[t.chain];
      let currentPriceUsd = null;
      let pnlPct = null;
      let pnlUsd = null;
      let marketCapUsd = null;
      let liquidityUsd = null;
      let nativeUsdPrice = null;
      let priceChange5m = null;
      let priceChange1h = null;
      let priceChange6h = null;
      let priceChange24h = null;
      try {
        const dexPair = await getBestPair(chainDef.dexscreenerChainId, t.token_address);
        const pair = pairSummary(dexPair, t.token_address);
        if (pair && isSanePrice(pair.priceUsd)) {
          currentPriceUsd = pair.priceUsd;
          pnlPct = ((currentPriceUsd - t.entry_price_usd) / t.entry_price_usd) * 100;
          pnlUsd = t.position_size_usd * (pnlPct / 100);
          marketCapUsd = pair.marketCapUsd;
          liquidityUsd = pair.liquidityUsd;
          nativeUsdPrice = pair.nativeUsdPrice;
          priceChange5m = pair.priceChange5m;
          priceChange1h = pair.priceChange1h;
          priceChange6h = pair.priceChange6h;
          priceChange24h = pair.priceChange24h;
        }
      } catch {
        // best-effort — leave nulls if the price lookup fails for this trade
      }
      if (pnlUsd != null) totalUnrealizedUsd += pnlUsd;
      return {
        ...t,
        currentPriceUsd,
        pnlPct,
        pnlUsd,
        marketCapUsd,
        liquidityUsd,
        nativeUsdPrice,
        priceChange5m,
        priceChange1h,
        priceChange6h,
        priceChange24h,
      };
    })
  );

  return { trades, totalUnrealizedUsd };
}

// Closes every open paper trade at its current live price. Trades whose
// price can't be fetched are left open rather than closed at a bogus price.
async function closeAllOpenTrades() {
  const open = getOpenPaperTrades();
  let closedCount = 0;
  let totalPnlUsd = 0;

  for (const t of open) {
    const chainDef = CHAINS[t.chain];
    if (!chainDef) continue;
    try {
      const dexPair = await getBestPair(chainDef.dexscreenerChainId, t.token_address);
      const pair = pairSummary(dexPair, t.token_address);
      if (!pair || !isSanePrice(pair.priceUsd)) continue;
      const pnlPct = ((pair.priceUsd - t.entry_price_usd) / t.entry_price_usd) * 100;
      const pnlUsd = t.position_size_usd * (pnlPct / 100);
      closePaperTrade(t.id, { exitPriceUsd: pair.priceUsd, exitReason: "manual_close_all", pnlUsd, pnlPct });
      closedCount++;
      totalPnlUsd += pnlUsd;
    } catch (err) {
      console.error(`[paperTrading] closeAll failed to close ${t.symbol} (${t.chain}):`, err.message);
    }
  }

  return { closedCount, totalPnlUsd, skippedCount: open.length - closedCount };
}

// Same live-PnL pattern as paper trading's, against real_trades instead.
async function getOpenRealTradesWithLivePnl() {
  const open = getOpenRealTrades();
  let totalUnrealizedUsd = 0;

  const trades = await Promise.all(
    open.map(async (t) => {
      const chainDef = CHAINS[t.chain];
      let currentPriceUsd = null;
      let pnlPct = null;
      let pnlUsd = null;
      let marketCapUsd = null;
      let liquidityUsd = null;
      let nativeUsdPrice = null;
      let priceChange5m = null;
      let priceChange1h = null;
      let priceChange6h = null;
      let priceChange24h = null;
      try {
        const dexPair = await getBestPair(chainDef.dexscreenerChainId, t.token_address);
        const pair = pairSummary(dexPair, t.token_address);
        if (pair && isSanePrice(pair.priceUsd)) {
          currentPriceUsd = pair.priceUsd;
          pnlPct = ((currentPriceUsd - t.entry_price_usd) / t.entry_price_usd) * 100;
          pnlUsd = t.position_size_usd * (pnlPct / 100);
          marketCapUsd = pair.marketCapUsd;
          liquidityUsd = pair.liquidityUsd;
          nativeUsdPrice = pair.nativeUsdPrice;
          priceChange5m = pair.priceChange5m;
          priceChange1h = pair.priceChange1h;
          priceChange6h = pair.priceChange6h;
          priceChange24h = pair.priceChange24h;
        }
      } catch {
        // best-effort — leave nulls if the price lookup fails for this trade
      }
      if (pnlUsd != null) totalUnrealizedUsd += pnlUsd;
      return {
        ...t,
        currentPriceUsd,
        pnlPct,
        pnlUsd,
        marketCapUsd,
        liquidityUsd,
        nativeUsdPrice,
        priceChange5m,
        priceChange1h,
        priceChange6h,
        priceChange24h,
      };
    })
  );

  return { trades, totalUnrealizedUsd };
}

// Wallet balance line(s) for the real-money Active Trades view — one entry
// per chain that has an open position (falls back to every enabled chain
// when nothing's open, so the balance still shows). usdValue is derived
// from nativeUsdPrice already fetched alongside that chain's open trades —
// best-effort, so it's just omitted if no trade on that chain had one.
async function getWalletBalancesForTrades(trades) {
  if (!hasWallet()) return [];
  const chainKeys = [...new Set(trades.map((t) => t.chain))];
  const keysToQuery = chainKeys.length > 0 ? chainKeys : getActiveChainDefs().map((c) => c.key);

  return Promise.all(
    keysToQuery.map(async (key) => {
      const def = CHAINS[key];
      const chain = { key, ...def };
      const bal = await getNativeBalance(chain).catch(() => null);
      const nativeUsdPrice = trades.find((t) => t.chain === key && t.nativeUsdPrice)?.nativeUsdPrice ?? null;
      return {
        label: def.label,
        balance: bal ?? 0,
        symbol: def.nativeSymbol,
        usdValue: bal != null && nativeUsdPrice ? bal * nativeUsdPrice : null,
      };
    })
  );
}

// Unlike paper trading's close-all, this executes REAL sell transactions on
// every open real position. Trades that fail to sell (revert, no liquidity,
// price lookup failure) are left open and reported separately — never
// marked closed without a confirmed on-chain sale.
async function closeAllOpenRealTrades(settings) {
  const open = getOpenRealTrades();
  let closedCount = 0;
  let totalPnlUsd = 0;
  let failedCount = 0;

  for (const t of open) {
    const chainDef = CHAINS[t.chain];
    if (!chainDef) continue;
    const chain = { key: t.chain, ...chainDef };
    const lockKey = `${t.chain}:${t.token_address}`;
    if (!acquireTradeLock(lockKey)) {
      // Another buy/sell (manual, or a double-tap of Close ALL itself) is
      // already in flight for this token — skip it this pass rather than
      // racing a second sellToken() against the same position.
      failedCount++;
      continue;
    }
    try {
      // Still attempt the sell even with no readable DexScreener price — a
      // drained/dead pool is exactly the case where a price lookup fails but
      // sellToken() (on-chain quote first, minOut=0n last resort) may still
      // be able to recover something. Skipping the attempt entirely here was
      // the gap that left dead-pool positions permanently un-sellable via
      // this button; sellToken() itself already degrades gracefully.
      const dexPair = await getBestPair(chainDef.dexscreenerChainId, t.token_address).catch(() => null);
      const pair = pairSummary(dexPair, t.token_address);
      const exitPriceUsd = pair && isSanePrice(pair.priceUsd) ? pair.priceUsd : t.entry_price_usd;

      const sellResult = await withSlippageRetry((bps) => sellToken(chain, t.token_address, t.token_amount_raw, bps), settings.slippageBps);
      const pnlUsd = sellResult.proceedsUsd - t.position_size_usd - t.entry_gas_usd - sellResult.gasUsd;
      const pnlPct = (pnlUsd / t.position_size_usd) * 100;
      closeRealTrade(t.id, {
        exitPriceUsd,
        exitReason: "manual_close_all",
        pnlUsd,
        pnlPct,
        nativeReceived: sellResult.nativeReceived,
        exitTxHash: sellResult.txHash,
        exitGasUsd: sellResult.gasUsd,
      });
      closedCount++;
      totalPnlUsd += pnlUsd;
    } catch (err) {
      console.error(`[realTrading] closeAll failed to sell ${t.symbol} (${t.chain}):`, err.message);
      failedCount++;
    } finally {
      releaseTradeLock(lockKey);
    }
  }

  return { closedCount, totalPnlUsd, failedCount };
}

const ADDRESS_RE = /0x[a-fA-F0-9]{40}/;
const ENS_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i;
const PENDING_TTL_MS = 5 * 60 * 1000;

// Accepts either a raw 0x address or an ENS .eth name — shared by every
// "add a watched wallet" entry point (the Add Wallet button flow and the
// /watchwallet command) so both take the same input formats. Returns null
// if the input is neither a valid address nor a resolvable ENS name. When
// resolved from a name, that name is returned as the suggested label —
// nicer than a truncated hex address in the Watched Wallets list, and the
// caller only overrides it if the user typed an explicit label too.
async function resolveWalletAddressInput(input) {
  if (ADDRESS_RE.test(input)) return { address: input, label: null };
  if (ENS_RE.test(input)) {
    const resolved = await resolveEnsName(input);
    if (!resolved) return null;
    return { address: resolved, label: input };
  }
  return null;
}

// Tracks "what is this chat's next plain-text message for" after a button
// prompt (e.g. "paste an address to track"), so free text can be routed
// without slash commands. Expires so a stale prompt doesn't hijack an
// unrelated later message.
const pendingAction = new Map();
function setPending(chatId, action) {
  pendingAction.set(chatId, { ...action, expiresAt: Date.now() + PENDING_TTL_MS });
}
function takePending(chatId) {
  const p = pendingAction.get(chatId);
  pendingAction.delete(chatId);
  if (!p || Date.now() > p.expiresAt) return null;
  return p;
}

function isAdmin(ctx) {
  if (!config.telegram.adminUserId) return true; // no admin configured — allow anyone (private bot use)
  return String(ctx.from?.id) === config.telegram.adminUserId;
}

// Prevents a double-tap (or retry after Telegram lag) on a buy/sell button
// from firing two overlapping on-chain transactions for the same position —
// without this, both calls pass their "is there an open position?" check
// before either write lands, and both execute real swaps.
const tradeLocks = new Set();
function acquireTradeLock(key) {
  if (tradeLocks.has(key)) return false;
  tradeLocks.add(key);
  return true;
}
function releaseTradeLock(key) {
  tradeLocks.delete(key);
}

// Real Funds Trading passcode lock — separate from isAdmin(), which only
// checks *who* you are. This additionally requires proving you know the
// passcode, and re-locks after a period of inactivity so an unattended,
// already-authenticated session doesn't stay unlocked forever.
const REAL_UNLOCK_TTL_MS = 30 * 60 * 1000;
const realTradingUnlockedUntil = new Map(); // chatId -> expiry timestamp

function isRealTradingUnlocked(chatId) {
  const exp = realTradingUnlockedUntil.get(chatId);
  return Boolean(exp && Date.now() < exp);
}

function unlockRealTrading(chatId) {
  realTradingUnlockedUntil.set(chatId, Date.now() + REAL_UNLOCK_TTL_MS);
}

// Gate for every real-trading action handler, not just the menu entry point
// — callback data can in principle be replayed/guessed, so each handler
// re-checks rather than trusting that reaching it means the menu was seen.
// Returns true if the caller may proceed.
async function requireRealTradingUnlock(ctx) {
  if (!config.realTradingPasscode) {
    await ctx.answerCbQuery?.("Real trading is not configured.");
    await ctx.reply("⚠️ Real Funds Trading is locked out — no REAL_TRADING_PASSCODE is set in .env.");
    return false;
  }
  if (!isRealTradingUnlocked(ctx.chat.id)) {
    await ctx.answerCbQuery?.("Locked — enter the passcode.");
    setPending(ctx.chat.id, { type: "realPasscode" });
    await ctx.reply("🔒 Real Funds Trading is locked. Send the passcode to continue.");
    return false;
  }
  return true;
}

function mainMenuKeyboard() {
  const paused = isPaused();
  const tokenRealEnabled = loadRealTradingSettings().enabled;
  const nftRealEnabled = config.openseaApiKey ? loadNftRealTradingSettings().enabled : false;
  return Markup.inlineKeyboard([
    [Markup.button.callback(paused ? "▶️ Bot: OFF (tap to turn on)" : "⏸ Bot: ON (tap to turn off)", "menu:toggleBot")],
    [Markup.button.callback("📊 Status", "menu:status"), Markup.button.callback("📋 Tracklist", "menu:tracklist")],
    [Markup.button.callback("📜 Watchlist", "menu:watchlist"), Markup.button.callback("⚙️ Filter", "menu:filter")],
    [Markup.button.callback("🔍 Score Token", "menu:score"), Markup.button.callback("📌 Track Token", "menu:track")],
    [Markup.button.callback("🗑 Untrack Token", "menu:untrack"), Markup.button.callback("⛓ Chains", "menu:chains")],
    [Markup.button.callback("📈 Paper Trading", "menu:papertrading")],
    // Separate, individually-labeled real-trading entry points for tokens
    // vs NFTs — each still opens its own submenu where the actual
    // enable/pause action lives (passcode-locked, confirm-before-enabling),
    // this just makes each asset class's live/off status visible and
    // reachable directly from the home menu instead of NFT's being nested
    // two taps deep under the NFTs menu.
    [Markup.button.callback(`💰 Real Trading — Tokens: ${tokenRealEnabled ? "🔴 LIVE" : "⚪️ off"}`, "menu:realtrading")],
    ...(config.openseaApiKey
      ? [[Markup.button.callback(`🖼 Real Trading — NFTs: ${nftRealEnabled ? "🔴 LIVE" : "⚪️ off"}`, "menu:nftrealtrading")]]
      : []),
    [Markup.button.callback("💳 Wallet Balance", "menu:walletbalance"), Markup.button.callback("📊 Bot Stats", "menu:botstats")],
    ...(config.openseaApiKey ? [[Markup.button.callback("🖼 NFTs", "menu:nft")]] : []),
  ]);
}

function nftMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⚙️ NFT Filter", "menu:nftfilter"), Markup.button.callback("👛 Watched Wallets", "menu:nftwallets")],
    [Markup.button.callback("📈 NFT Paper Trading", "menu:nftpapertrading")],
    [Markup.button.callback("💰 NFT Real Trading", "menu:nftrealtrading")],
    [Markup.button.callback("🔍 Score Collection", "menu:nftscore")],
    [Markup.button.callback("🔙 Menu", "menu:home")],
  ]);
}

function nftFilterKeyboard(filters) {
  const rows = Object.entries(filters).map(([k, v]) => [Markup.button.callback(`${k}: ${v}`, `nftfilteredit:${k}`)]);
  rows.push([Markup.button.callback("🔙 NFTs", "menu:nft")]);
  return Markup.inlineKeyboard(rows);
}

// Fits comfortably under Telegram's message/keyboard limits even with a
// real bulk-imported watchlist (this bot has had 95+ wallets loaded at
// once) — each row needs both a text line and its own remove button, so
// this stays well under WATCHLIST_PAGE_SIZE (20), which only needs page-nav
// buttons, not one button per entry.
const WALLETS_PAGE_SIZE = 12;

// Sorts every watched wallet by its copy-trade track record (best average
// return first — see nftOutcomeTracker.js/getAllWalletTrackRecords) and
// slices to one page. Text and keyboard are built from the same slice so
// a remove button always matches the row next to it, even mid-pagination.
function pageWatchedWallets(wallets, offset) {
  const records = getAllWalletTrackRecords();
  const withRecords = wallets.map((w) => ({ wallet: w, record: records.get(w.address) || { signals: 0, avgPct: null, winRate: null } }));
  withRecords.sort((a, b) => (b.record.avgPct ?? -Infinity) - (a.record.avgPct ?? -Infinity));
  return { shown: withRecords.slice(offset, offset + WALLETS_PAGE_SIZE), total: wallets.length };
}

// "Copy-trading intelligence" — each wallet's track record, not just its
// label. A signal is only resolved 24h after the call (nftOutcomeTracker.js),
// so a freshly-added wallet has no data yet; shown as such rather than a
// misleading "0% win rate."
function renderWatchedWalletsText(shown, total, offset) {
  if (total === 0) {
    return "👛 *Watched Wallets*\n\nNone yet — tap Add Wallet to start copy-trading a wallet's NFT buys.";
  }
  const lines = shown.map(({ wallet: w, record }) => {
    const label = escapeMd(w.label) || `\`${w.address.slice(0, 10)}…\``;
    if (record.signals === 0) return `⚪️ ${label} — no resolved signals yet`;
    const winRatePct = record.winRate * 100;
    const dot = winRatePct >= 50 ? "🟢" : "🔴";
    const avgLabel = record.avgPct >= 0 ? `+${record.avgPct.toFixed(1)}%` : `${record.avgPct.toFixed(1)}%`;
    return `${dot} ${label} — ${record.signals} signal${record.signals === 1 ? "" : "s"} · ${winRatePct.toFixed(0)}% win · avg ${avgLabel}`;
  });
  const rangeLabel = total > WALLETS_PAGE_SIZE ? ` — showing ${offset + 1}-${offset + shown.length}, sorted by track record` : "";

  return [
    `👛 *Watched Wallets* (${total})${rangeLabel}`,
    "",
    "Copy-trade signals fire when one of these buys an NFT. Track record = how the collection's floor moved 24h after each past signal.",
    "",
    lines.join("\n"),
  ].join("\n");
}

function nftWalletsKeyboard(shown, total, offset) {
  const rows = shown.map(({ wallet: w }) => [Markup.button.callback(`🗑 ${w.label || w.address.slice(0, 10) + "…"}`, `nftwalletremove:${w.address}:${offset}`)]);
  const navRow = [];
  if (offset > 0) navRow.push(Markup.button.callback("⬅️ Previous", `nftwalletspage:${Math.max(0, offset - WALLETS_PAGE_SIZE)}`));
  if (offset + WALLETS_PAGE_SIZE < total) navRow.push(Markup.button.callback("➡️ Show More", `nftwalletspage:${offset + WALLETS_PAGE_SIZE}`));
  if (navRow.length) rows.push(navRow);
  rows.push([Markup.button.callback("➕ Add Wallet", "nftwalletadd")]);
  rows.push([Markup.button.callback("🔙 NFTs", "menu:nft")]);
  return Markup.inlineKeyboard(rows);
}

function nftPaperTradingKeyboard(settings) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(settings.enabled ? "⏸ Pause" : "▶️ Resume", "nftpapertoggle")],
    [Markup.button.callback(`Budget: ${settings.totalBudgetEth} ETH`, "nftpaperedit:totalBudgetEth")],
    [Markup.button.callback(`Position size: ${settings.positionSizeEth} ETH`, "nftpaperedit:positionSizeEth")],
    [Markup.button.callback(`Target: ${settings.targetMultiple}x floor`, "nftpaperedit:targetMultiple")],
    [Markup.button.callback(`Stop: ${settings.stopFloorPct}% of entry`, "nftpaperedit:stopFloorPct")],
    [Markup.button.callback("📋 Active Positions", "menu:nftpaperactive")],
    [Markup.button.callback("🔄 Refresh", "menu:nftpapertrading"), Markup.button.callback("🔙 NFTs", "menu:nft")],
  ]);
}

function nftRealTradingKeyboard(settings, walletReady) {
  const toggleAction = settings.enabled ? "nftrealtoggle" : "nftrealconfirm:enable";
  const rows = [
    [Markup.button.callback(settings.enabled ? "⏸ Pause (real money)" : "▶️ Enable REAL NFT trading", toggleAction)],
    [Markup.button.callback(`Budget: ${settings.totalBudgetEth} ETH`, "nftrealedit:totalBudgetEth")],
    [Markup.button.callback(`Position size: ${settings.positionSizeEth} ETH`, "nftrealedit:positionSizeEth")],
    [Markup.button.callback(`Target: ${settings.targetMultiple}x floor`, "nftrealedit:targetMultiple")],
    [Markup.button.callback(`Stop: ${settings.stopFloorPct}% of entry`, "nftrealedit:stopFloorPct")],
    [Markup.button.callback("📋 Active Positions", "menu:nftrealactive")],
    [Markup.button.callback("🔄 Refresh", "menu:nftrealtrading"), Markup.button.callback("🔙 NFTs", "menu:nft")],
  ];
  if (!walletReady) rows.unshift([Markup.button.callback("⚠️ No wallet configured — see .env", "menu:nftrealtrading")]);
  return Markup.inlineKeyboard(rows);
}

function nftRealEnableConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Yes, trade NFTs with REAL money", "nftrealtoggle")],
    [Markup.button.callback("❌ Cancel", "menu:nftrealtrading")],
  ]);
}

function paperTradingKeyboard(settings) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(settings.enabled ? "⏸ Pause" : "▶️ Resume", "papertoggle")],
    [Markup.button.callback(`Budget: $${settings.totalBudgetUsd}`, "paperedit:totalBudgetUsd")],
    [Markup.button.callback(`Position size: $${settings.positionSizeUsd}`, "paperedit:positionSizeUsd")],
    [Markup.button.callback(`Take profit: +${settings.takeProfitPct}%`, "paperedit:takeProfitPct")],
    [Markup.button.callback(`Stop loss: ${settings.stopLossPct}%`, "paperedit:stopLossPct")],
    [Markup.button.callback(`🪖 Super Comando: ${settings.superComandoEnabled ? "ON (tap to turn off)" : "off (tap to turn on)"}`, "comandotoggle")],
    [Markup.button.callback(`🪖 Comando max call volume: $${settings.superComandoMaxCallVolumeUsd}`, "paperedit:superComandoMaxCallVolumeUsd")],
    [Markup.button.callback("📋 Active trades", "menu:paperactive"), Markup.button.callback("📜 Closed trades", "menu:paperclosed")],
    [Markup.button.callback("🛑 Close ALL trades", "paperconfirm:closeall")],
    [Markup.button.callback("🔄 Refresh", "menu:papertrading"), Markup.button.callback("🔙 Menu", "menu:home")],
  ]);
}

function activeTradesKeyboard(trades = []) {
  // Numbered to match buildActiveTradesMessage's "1. SYMBOL" list order —
  // callback_data still carries the real DB id, only the visible label changed.
  const rows = trades.map((t, i) => [Markup.button.callback(`🛑 Close #${i + 1} ${t.symbol || "?"}`, `paperclosetrade:${t.id}`)]);
  rows.push([Markup.button.callback("🔄 Refresh", "menu:paperactive")]);
  rows.push([Markup.button.callback("🔙 Paper Trading", "menu:papertrading")]);
  return Markup.inlineKeyboard(rows);
}

function realTradingKeyboard(settings, walletReady) {
  const toggleAction = settings.enabled ? "realtoggle" : "realconfirm:enable";
  const rows = [
    [Markup.button.callback(settings.enabled ? "⏸ Pause (real money)" : "▶️ Enable REAL trading", toggleAction)],
    [Markup.button.callback(`Budget: $${settings.totalBudgetUsd}`, "realedit:totalBudgetUsd")],
    [Markup.button.callback(`Position size: $${settings.positionSizeUsd}`, "realedit:positionSizeUsd")],
    [Markup.button.callback(`Take profit: +${settings.takeProfitPct}%`, "realedit:takeProfitPct")],
    [Markup.button.callback(`Stop loss: ${settings.stopLossPct}%`, "realedit:stopLossPct")],
    [Markup.button.callback(`Slippage: ${(settings.slippageBps / 100).toFixed(1)}%`, "realedit:slippageBps")],
    [Markup.button.callback(`🪖 Super Comando: ${settings.superComandoEnabled ? "ON (tap to turn off)" : "off (tap to turn on)"}`, "realcomandotoggle")],
    [Markup.button.callback(`🪖 Comando max call volume: $${settings.superComandoMaxCallVolumeUsd}`, "realedit:superComandoMaxCallVolumeUsd")],
    [Markup.button.callback("📋 Active trades", "menu:realactive"), Markup.button.callback("📜 Closed trades", "menu:realclosed")],
    [Markup.button.callback("🛑 Close ALL trades (sells for real)", "realconfirm:closeall")],
    [Markup.button.callback("🔄 Refresh", "menu:realtrading"), Markup.button.callback("🔙 Menu", "menu:home")],
  ];
  // Manual trading terminal only appears once real trading is actually
  // enabled — it's meaningless (and riskier to expose) while it's off.
  if (settings.enabled) {
    rows.splice(6, 0, [Markup.button.callback("🎯 Manual Trade", "menu:realmanual")]);
  }
  if (!walletReady) {
    rows.unshift([Markup.button.callback("⚠️ No wallet configured — see .env", "menu:realtrading")]);
  }
  return Markup.inlineKeyboard(rows);
}

// Preset native-currency buy amounts for the manual trading terminal.
const MANUAL_BUY_PRESETS = [0.001, 0.005, 0.01];
const MANUAL_SELL_PERCENTS = [25, 50, 75, 100];
// chatId -> { chainKey, tokenAddress, symbol, name } — set when the
// terminal is rendered, read when a buy/sell button is tapped, so callback
// data doesn't need to encode the (long) token address every time.
const manualTradeContext = new Map();

function manualTradeKeyboard(hasOpenPosition) {
  const rows = [
    MANUAL_BUY_PRESETS.map((amt, i) => Markup.button.callback(`Buy ${amt}`, `realbuyquick:${i}`)),
    [Markup.button.callback("Buy custom amount", "realbuycustom")],
  ];
  if (hasOpenPosition) {
    rows.push(MANUAL_SELL_PERCENTS.map((pct) => Markup.button.callback(`Sell ${pct}%`, `realsellpct:${pct}`)));
  }
  rows.push([Markup.button.callback("🔄 Refresh", "realmanualrefresh")]);
  rows.push([Markup.button.callback("🔙 Real Funds Trading", "menu:realtrading")]);
  return Markup.inlineKeyboard(rows);
}

function realActiveTradesKeyboard(trades = []) {
  const rows = trades.map((t, i) => [Markup.button.callback(`🛑 Sell #${i + 1} ${t.symbol || "?"}`, `realclosetrade:${t.id}`)]);
  rows.push([Markup.button.callback("🔄 Refresh", "menu:realactive")]);
  rows.push([Markup.button.callback("🔙 Real Funds Trading", "menu:realtrading")]);
  return Markup.inlineKeyboard(rows);
}

function realEnableConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Yes, trade with REAL money", "realtoggle")],
    [Markup.button.callback("❌ Cancel", "menu:realtrading")],
  ]);
}

function realCloseAllConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Yes, sell everything for real", "realclosall")],
    [Markup.button.callback("❌ Cancel", "menu:realtrading")],
  ]);
}

function closeAllConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Yes, close everything", "paperclosall")],
    [Markup.button.callback("❌ Cancel", "menu:papertrading")],
  ]);
}

function chainsKeyboard() {
  const rows = Object.entries(CHAINS).map(([key, def]) => [
    Markup.button.callback(`${isChainEnabled(key) ? "✅" : "⬜"} ${def.label}`, `chaintoggle:${key}`),
  ]);
  rows.push([Markup.button.callback("🔙 Menu", "menu:home")]);
  return Markup.inlineKeyboard(rows);
}

function backKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("🔙 Menu", "menu:home")]]);
}

function refreshKeyboard(action) {
  return Markup.inlineKeyboard([[Markup.button.callback("🔄 Refresh", action), Markup.button.callback("🔙 Menu", "menu:home")]]);
}

function filterKeyboard(filters) {
  const rows = Object.entries(filters).map(([k, v]) => [Markup.button.callback(`${k}: ${v}`, `filteredit:${k}`)]);
  rows.push([Markup.button.callback("🎯 Presets", "menu:presets")]);
  rows.push([Markup.button.callback("🔙 Menu", "menu:home")]);
  return Markup.inlineKeyboard(rows);
}

function presetsKeyboard() {
  const presets = loadPresets();
  const rows = Object.entries(presets).map(([key, p]) => [Markup.button.callback(p.label, `presetapply:${key}`)]);
  rows.push([Markup.button.callback("🔙 Filter", "menu:filter")]);
  return Markup.inlineKeyboard(rows);
}

function presetsText() {
  const presets = loadPresets();
  const lines = Object.values(presets).map((p) => `*${p.label}*\n${p.description}`);
  return `🎯 *Presets*\n\nTap one to apply it on top of your current filter settings:\n\n${lines.join("\n\n")}`;
}

function welcomeText() {
  const chainLabels = getActiveChainDefs().map((c) => c.label).join(", ") || "none — enable some in ⛓ Chains";
  return [
    "🤖 *Degen Assistant*",
    `Status: ${isPaused() ? "⏸ PAUSED" : "🟢 running"}`,
    `Watching: ${chainLabels}`,
    "",
    "*How this works:*",
    "• It watches new token launches, filters out low-quality ones, and posts a call here (or in the channel) when one passes.",
    "• Paste any contract address any time to get an instant risk score.",
    "• 📜 Watchlist shows every active call and its live performance.",
    "• 📈 Paper Trading simulates a strategy with fake money so you can see how it performs.",
    "• 💰 Real Funds Trading executes actual on-chain trades — locked behind a passcode, off by default.",
    "",
    "Use the buttons below to navigate.",
  ].join("\n");
}

function renderStatusText(stats) {
  return [
    "📊 *Status*",
    "",
    `Bot: ${isPaused() ? "⏸ PAUSED (not calling/scoring)" : "🟢 running"}`,
    `Chains: ${getActiveChainDefs().map((c) => c.label).join(", ") || "none"}`,
    `Tokens seen: ${stats.seen}`,
    `Tokens called: ${stats.called}`,
    `Pending recheck: ${stats.pending}`,
    `Uptime: ${Math.floor(process.uptime() / 60)}m`,
  ].join("\n");
}

async function renderWatchlistPage(offset = 0) {
  const entries = await buildDigestEntries();
  return { text: buildWatchlistDigest(entries, offset), total: entries.length };
}

function watchlistKeyboard(offset, total) {
  const { intervalMinutes } = loadDigestSettings();
  const navRow = [];
  if (offset > 0) navRow.push(Markup.button.callback("⬅️ Previous", `watchlistpage:${Math.max(0, offset - WATCHLIST_PAGE_SIZE)}`));
  if (offset + WATCHLIST_PAGE_SIZE < total) navRow.push(Markup.button.callback("➡️ Show More", `watchlistpage:${offset + WATCHLIST_PAGE_SIZE}`));

  const rows = [];
  if (navRow.length) rows.push(navRow);
  rows.push([Markup.button.callback("🔄 Update", "watchlistpage:0")]);
  rows.push([Markup.button.callback("📌 Pin/Unpin Call", "menu:pincall"), Markup.button.callback("🗑 Remove Call", "menu:removecall")]);
  rows.push([Markup.button.callback(`⏱ Auto-update every ${intervalMinutes}m (tap to change)`, "menu:digestinterval")]);
  rows.push([Markup.button.callback("🔙 Menu", "menu:home")]);
  return Markup.inlineKeyboard(rows);
}

async function renderTracklistText() {
  const tracks = getActiveTracks();
  if (tracks.length === 0) return "📋 *Tracklist*\n\nNot tracking anything right now.";

  const rows = await Promise.all(
    tracks.map(async (t) => {
      const chainDef = CHAINS[t.chain];
      try {
        const dexPair = await getBestPair(chainDef.dexscreenerChainId, t.token_address);
        const pair = pairSummary(dexPair, t.token_address);
        const pct = pair?.priceUsd ? ((pair.priceUsd - t.track_price_usd) / t.track_price_usd) * 100 : null;
        return { t, pct };
      } catch {
        return { t, pct: null };
      }
    })
  );

  rows.sort((a, b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity));

  const lines = rows.map(({ t, pct }, i) => {
    const pctLabel = pct === null ? "price unavailable" : `${pct >= 0 ? "🟢+" : "🔴"}${pct.toFixed(1)}%`;
    const tags = [t.best_milestone_hit > 0 ? `best +${t.best_milestone_hit}%` : null, t.down50_alert_sent ? "⚠️ -50% hit" : null]
      .filter(Boolean)
      .join(", ");
    return `${i + 1}. *${escapeMd(t.symbol) || "?"}* (${t.chain}) — ${pctLabel}${tags ? ` [${tags}]` : ""}\n   \`${t.token_address}\``;
  });

  return `📋 *Tracklist* (${tracks.length})\n\n${lines.join("\n\n")}`;
}

async function safeEdit(ctx, text, keyboard) {
  try {
    await ctx.editMessageText(text, { parse_mode: "Markdown", ...keyboard });
  } catch (err) {
    if (!/message is not modified/i.test(err.description || err.message || "")) {
      console.error("editMessageText failed:", err.message);
    }
  }
}

async function scoreAndReply(ctx, chainKey, tokenAddress) {
  const chainDef = CHAINS[chainKey];
  const chain = { key: chainKey, ...chainDef };
  const riskResult = await computeRiskScore(chain, tokenAddress);
  const { name, symbol } = riskResult;
  const message = buildCallMessage({ chain, tokenAddress, riskResult, name, symbol });
  await ctx.reply(message, { parse_mode: "Markdown", ...backKeyboard() });
}

// Resolves which active NFT chain a pasted contract address belongs to —
// same "try each configured chain" idea as the token side's detectChains,
// just via OpenSea's own contract lookup instead of DexScreener search
// (there's no NFT-equivalent multi-chain search endpoint to call once).
async function detectNftChain(contractAddress) {
  const chains = getNftChainDefs();
  for (const chain of chains) {
    const info = await getContract(chain.key, contractAddress).catch(() => null);
    if (info?.slug) return chain;
  }
  return null;
}

async function scoreAndReplyNft(ctx, contractAddress, chainKeyHint) {
  let chain;
  if (chainKeyHint) {
    if (!CHAINS[chainKeyHint]) throw new Error(`Unknown chain. Options: ${getNftChainKeys().join(", ")}`);
    chain = { key: chainKeyHint, ...CHAINS[chainKeyHint] };
  } else {
    chain = await detectNftChain(contractAddress);
    if (!chain) throw new Error(`Couldn't find this collection on any watched NFT chain (${getNftChainKeys().join(", ")}).`);
  }
  const riskResult = await computeNftRiskScore(chain, contractAddress);
  const message = buildNftCallMessage({ chain, contractAddress, riskResult, source: "new_collection" });
  await ctx.reply(message, { parse_mode: "Markdown", ...backKeyboard() });
}

// Resolves a bare <address> (auto-detected chain) or explicit <chain>
// <address> from a plain args array (no leading command word).
async function resolveChainAndAddress(ctx, args, usage) {
  let chainKey, tokenAddress;
  if (args.length === 1) {
    tokenAddress = args[0];
  } else if (args.length === 2) {
    chainKey = args[0].toLowerCase();
    tokenAddress = args[1];
  } else {
    await ctx.reply(usage);
    return null;
  }

  if (!ADDRESS_RE.test(tokenAddress)) {
    await ctx.reply("That doesn't look like a valid contract address.");
    return null;
  }

  if (chainKey) {
    if (!CHAINS[chainKey]) {
      await ctx.reply(`Unknown chain. Options: ${Object.keys(CHAINS).join(", ")}`);
      return null;
    }
    return { chainKey, tokenAddress };
  }

  const chainKeys = await detectChains(tokenAddress);
  if (chainKeys.length === 0) {
    await ctx.reply(`Couldn't find this token on any supported chain (${Object.keys(CHAINS).join(", ")}).`);
    return null;
  }
  if (chainKeys.length > 1) {
    await ctx.reply(`Found on multiple chains (${chainKeys.join(", ")}) — send: <chain> <address>`);
    return null;
  }
  return { chainKey: chainKeys[0], tokenAddress };
}

async function handleTrack(ctx, chainKey, tokenAddress) {
  const chainDef = CHAINS[chainKey];
  const dexPair = await getBestPair(chainDef.dexscreenerChainId, tokenAddress);
  const pair = pairSummary(dexPair, tokenAddress);
  if (!pair || !pair.priceUsd) return ctx.reply("Couldn't find price data for this token yet.");

  addTrack({
    chain: chainKey,
    tokenAddress,
    symbol: pair.symbol,
    name: pair.name,
    trackPriceUsd: pair.priceUsd,
    trackMarketCapUsd: pair.marketCapUsd || null,
    trackedAt: Date.now(),
  });

  await ctx.reply(
    `📌 Tracking ${escapeMd(pair.name) || "Unknown"} (${escapeMd(pair.symbol) || "?"}) on ${chainDef.label} from $${pair.priceUsd}.\n` +
      `I'll alert you at +50%, +100%, +200%... and if it drops 50% or 90% (dead).`,
    { ...backKeyboard() }
  );
}

// Renders the manual trading terminal for whatever token is currently in
// manualTradeContext for this chat — current price/MC/liquidity, plus an
// open-position summary if one exists. Used both on first load and every
// subsequent refresh (after a buy/sell, or the Refresh button).
function fmtPct(n) {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

async function renderManualTradeTerminal(ctx) {
  const context = manualTradeContext.get(ctx.chat.id);
  if (!context) {
    return ctx.reply("No token selected. Tap Manual Trade again and paste a contract address.");
  }
  const { chainKey, tokenAddress } = context;
  const chainDef = CHAINS[chainKey];
  const chain = { key: chainKey, ...chainDef };
  const dexPair = await getBestPair(chainDef.dexscreenerChainId, tokenAddress);
  const pair = pairSummary(dexPair, tokenAddress);
  if (!pair || !isSanePrice(pair.priceUsd)) {
    return ctx.reply("Couldn't fetch a live price for that token right now.");
  }
  manualTradeContext.set(ctx.chat.id, { ...context, symbol: pair.symbol, name: pair.name });

  const defaultBuyAmount = MANUAL_BUY_PRESETS[0];
  // Tries the V2 reserve-based estimate regardless of what DexScreener calls
  // the dex ("uniswap" for both v2 and v3 pools here, not a reliable
  // discriminator) — it fails closed (returns null) if the pair contract
  // isn't actually a V2-shaped pair, so this is safe to attempt unconditionally.
  const [walletBalance, priceImpactPct] = await Promise.all([
    hasWallet() ? getNativeBalance(chain).catch(() => null) : null,
    estimateV2PriceImpact(chain, pair.pairAddress, chainDef.wrappedNative, defaultBuyAmount),
  ]);

  const explorerUrl = explorerUrlFor(chainKey, tokenAddress);
  const chartUrl = pair.pairUrl;
  const linkParts = [explorerUrl ? `[Explorer](${explorerUrl})` : null, chartUrl ? `[Chart](${chartUrl})` : null].filter(Boolean);

  const lines = [
    `🎯 ${escapeMd(pair.name) || "Unknown"} (${escapeMd(pair.symbol) || "?"}) on ${chain.label}`,
    `\`${tokenAddress}\``,
  ];
  if (linkParts.length) lines.push(linkParts.join(" | "));
  lines.push(
    "",
    `Price: ${fmtPriceCompact(pair.priceUsd)}`,
    `5m: ${fmtPct(pair.priceChange5m)}  1h: ${fmtPct(pair.priceChange1h)}  6h: ${fmtPct(pair.priceChange6h)}  24h: ${fmtPct(pair.priceChange24h)}`,
    `Market Cap: ${fmtUsd(pair.marketCapUsd)}`,
    `Liquidity: ${fmtUsd(pair.liquidityUsd)}`
  );
  if (priceImpactPct != null) {
    lines.push("", `Price Impact (${defaultBuyAmount} ${chainDef.nativeSymbol}): ${priceImpactPct.toFixed(2)}%`);
  }
  lines.push("", `Wallet Balance: ${walletBalance != null ? `${walletBalance.toFixed(4)} ${chainDef.nativeSymbol}` : "n/a"}`);

  const openPosition = getOpenRealTradeByToken(chainKey, tokenAddress);
  if (openPosition) {
    const pnlPct = ((pair.priceUsd - openPosition.entry_price_usd) / openPosition.entry_price_usd) * 100;
    lines.push(
      "",
      `Open position: ${fmtUsd(openPosition.position_size_usd)} | ${pnlPct >= 0 ? "🟢+" : "🔴"}${pnlPct.toFixed(1)}%`,
      `Entry: ${fmtPriceCompact(openPosition.entry_price_usd)}`
    );
  }
  lines.push("", "To buy press one of the buttons below:");

  const text = lines.join("\n");
  const keyboard = manualTradeKeyboard(Boolean(openPosition));
  if (ctx.callbackQuery) await safeEdit(ctx, text, keyboard);
  else await ctx.reply(text, { parse_mode: "Markdown", ...keyboard });
}

async function executeManualBuy(ctx, context, nativeAmount) {
  const { chainKey, tokenAddress } = context;
  const chainDef = CHAINS[chainKey];
  const chain = { key: chainKey, ...chainDef };
  const lockKey = `${chainKey}:${tokenAddress}`;
  if (!acquireTradeLock(lockKey)) {
    return ctx.reply("A trade for this token is already in progress — please wait.");
  }
  const settings = loadRealTradingSettings();
  try {
    const result = await withSlippageRetry((bps) => buyTokenWithNativeAmount(chain, tokenAddress, nativeAmount, bps), settings.slippageBps);
    // Best-effort — buyTokenWithNativeAmount doesn't return market cap, and
    // this is only for the card/DB snapshot, not the trade decision itself.
    const marketCapUsd = await getBestPair(chainDef.dexscreenerChainId, tokenAddress)
      .then((dexPair) => pairSummary(dexPair, tokenAddress)?.marketCapUsd ?? null)
      .catch(() => null);
    const existing = getOpenRealTradeByToken(chainKey, tokenAddress);
    if (existing) {
      // Adding to an existing position — blend entry price by USD-weighted
      // average of cost, not raw token amounts (avoids needing decimals).
      const newTotalUsd = existing.position_size_usd + result.usdSpent;
      const newTotalRaw = (BigInt(existing.token_amount_raw) + BigInt(result.tokenAmountRaw)).toString();
      const blendedEntryPriceUsd =
        (existing.entry_price_usd * existing.position_size_usd + result.entryPriceUsd * result.usdSpent) / newTotalUsd;
      reduceRealTrade(existing.id, { tokenAmountRaw: newTotalRaw, positionSizeUsd: newTotalUsd, entryPriceUsd: blendedEntryPriceUsd });
    } else {
      openRealTrade({
        chain: chainKey,
        tokenAddress,
        symbol: context.symbol || null,
        name: context.name || null,
        entryPriceUsd: result.entryPriceUsd,
        positionSizeUsd: result.usdSpent,
        takeProfitPct: settings.takeProfitPct,
        stopLossPct: settings.stopLossPct,
        entryAt: Date.now(),
        tokenAmountRaw: result.tokenAmountRaw,
        nativeSpent: result.nativeSpent,
        entryTxHash: result.txHash,
        entryGasUsd: result.gasUsd,
        entryMarketCapUsd: marketCapUsd,
      });
    }
    const caption = `✅ Bought ${nativeAmount} ${chainDef.nativeSymbol} (~${fmtUsd(result.usdSpent)}) — gas ${fmtUsd(result.gasUsd)}\nTx: \`${result.txHash}\``;
    const imageBuffer = await renderOpenCard({
      chainLabel: chainDef.label,
      symbol: context.symbol,
      name: context.name,
      tradeMode: "real",
      entryPriceUsd: result.entryPriceUsd,
      entryMarketCapUsd: marketCapUsd,
      positionSizeUsd: result.usdSpent,
      takeProfitPct: settings.takeProfitPct,
      stopLossPct: settings.stopLossPct,
      tokenAddress,
    });
    await ctx.replyWithPhoto({ source: imageBuffer }, { caption, parse_mode: "Markdown" });
  } catch (err) {
    await ctx.reply(`⚠️ Buy failed: ${err.message}`);
  } finally {
    releaseTradeLock(lockKey);
  }
  await renderManualTradeTerminal(ctx);
}

async function executeManualSell(ctx, context, pct) {
  const { chainKey, tokenAddress } = context;
  const chainDef = CHAINS[chainKey];
  const chain = { key: chainKey, ...chainDef };
  const lockKey = `${chainKey}:${tokenAddress}`;
  if (!acquireTradeLock(lockKey)) {
    return ctx.reply("A trade for this token is already in progress — please wait.");
  }
  try {
    const position = getOpenRealTradeByToken(chainKey, tokenAddress);
    if (!position) return ctx.reply("No open position to sell.");
    const settings = loadRealTradingSettings();
    const sellRaw = (BigInt(position.token_amount_raw) * BigInt(pct)) / 100n;
    if (sellRaw <= 0n) return ctx.reply("Nothing to sell.");
    // Live price for the DB record — proceeds/rawAmount would need the
    // token's decimals to back out correctly, and we already have this
    // from a real quote instead of assuming 18 decimals.
    const dexPair = await getBestPair(chainDef.dexscreenerChainId, tokenAddress);
    const pair = pairSummary(dexPair, tokenAddress);
    const exitPriceUsd = pair?.priceUsd || position.entry_price_usd;

    const sellResult = await withSlippageRetry((bps) => sellToken(chain, tokenAddress, sellRaw.toString(), bps), settings.slippageBps);
    const soldFractionUsd = position.position_size_usd * (pct / 100);
    const gasShare = pct === 100 ? position.entry_gas_usd : position.entry_gas_usd * (pct / 100);
    const pnlUsd = sellResult.proceedsUsd - soldFractionUsd - gasShare - sellResult.gasUsd;
    const pnlPct = (pnlUsd / soldFractionUsd) * 100;

    if (pct >= 100) {
      closeRealTrade(position.id, {
        exitPriceUsd,
        exitReason: "manual_sell",
        pnlUsd,
        pnlPct,
        nativeReceived: sellResult.nativeReceived,
        exitTxHash: sellResult.txHash,
        exitGasUsd: sellResult.gasUsd,
      });
    } else {
      const remainingRaw = (BigInt(position.token_amount_raw) - sellRaw).toString();
      const remainingUsd = position.position_size_usd - soldFractionUsd;
      reduceRealTrade(position.id, { tokenAmountRaw: remainingRaw, positionSizeUsd: remainingUsd });
    }
    const caption = `✅ Sold ${pct}% — proceeds ${fmtUsd(sellResult.proceedsUsd)} (${pnlUsd >= 0 ? "+" : ""}${fmtUsd(Math.abs(pnlUsd))}, ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%), gas ${fmtUsd(sellResult.gasUsd)}\nTx: \`${sellResult.txHash}\``;
    const imageBuffer = await renderCloseCard({
      chainLabel: chainDef.label,
      symbol: context.symbol,
      name: context.name,
      tradeMode: "real",
      entryPriceUsd: position.entry_price_usd,
      entryMarketCapUsd: position.entry_market_cap_usd,
      exitPriceUsd,
      currentMarketCapUsd: pair?.marketCapUsd,
      pnlUsd,
      pnlPct,
      exitReason: pct >= 100 ? "manual_close" : "manual_sell",
      tokenAddress,
      holdDurationMs: Date.now() - position.entry_at,
    });
    await ctx.replyWithPhoto({ source: imageBuffer }, { caption, parse_mode: "Markdown" });
  } catch (err) {
    await ctx.reply(`⚠️ Sell failed: ${err.message}`);
  } finally {
    releaseTradeLock(lockKey);
  }
  await renderManualTradeTerminal(ctx);
}

async function handlePendingAction(ctx, pending, text, digestControls) {
  // pendingAction is keyed by chat, not by user — in a group chat, anyone
  // could otherwise win the race to answer a prompt the admin armed (e.g. a
  // filter edit or a manual buy amount) before the admin replies themselves.
  // Every button that sets a pending action already checks isAdmin(ctx), so
  // re-checking here just makes the free-text continuation match that.
  if (!isAdmin(ctx)) {
    return ctx.reply("Not authorized.");
  }
  if (pending.type === "filter") {
    const filters = loadFilters();
    const prev = filters[pending.key];
    const nextValue = typeof prev === "boolean" ? text.trim().toLowerCase() === "true" : Number(text.trim());
    if (typeof prev === "number" && Number.isNaN(nextValue)) {
      return ctx.reply("That doesn't look like a valid number — tap the setting again to retry.");
    }
    filters[pending.key] = nextValue;
    saveFilters(filters);
    return ctx.reply(`Updated *${pending.key}*: ${prev} → ${nextValue}`, { parse_mode: "Markdown", ...backKeyboard() });
  }

  if (pending.type === "digestInterval") {
    const minutes = Number(text.trim());
    if (!Number.isFinite(minutes) || minutes < 1) {
      return ctx.reply("That doesn't look like a valid number of minutes — tap the setting again to retry.");
    }
    saveDigestSettings({ intervalMinutes: Math.round(minutes) });
    digestControls.reschedule();
    return ctx.reply(`Auto-update interval set to ${Math.round(minutes)}m.`, { ...backKeyboard() });
  }

  if (pending.type === "paperTrading") {
    const value = Number(text.trim());
    if (!Number.isFinite(value)) {
      return ctx.reply("That doesn't look like a valid number — tap the setting again to retry.");
    }
    const settings = loadPaperTradingSettings();
    const prev = settings[pending.key];
    settings[pending.key] = value;
    savePaperTradingSettings(settings);
    return ctx.reply(`Updated *${pending.key}*: ${prev} → ${value}`, { parse_mode: "Markdown", ...backKeyboard() });
  }

  if (pending.type === "realPasscode") {
    if (!config.realTradingPasscode) {
      return ctx.reply("⚠️ Real Funds Trading is locked out — no REAL_TRADING_PASSCODE is set in .env.");
    }
    if (text.trim() !== config.realTradingPasscode) {
      return ctx.reply("❌ Wrong passcode.");
    }
    unlockRealTrading(ctx.chat.id);
    const settings = loadRealTradingSettings();
    const stats = getRealTradingStats();
    const { totalUnrealizedUsd } = await getOpenRealTradesWithLivePnl();
    const walletAddress = getWalletAddress();
    return ctx.reply(
      buildRealTradingSummary({ settings, stats, unrealizedPnlUsd: totalUnrealizedUsd, walletAddress, walletBalances: [] }),
      { parse_mode: "Markdown", ...realTradingKeyboard(settings, hasWallet()) }
    );
  }

  if (pending.type === "realTrading") {
    if (!(await requireRealTradingUnlock(ctx))) return;
    const value = Number(text.trim());
    if (!Number.isFinite(value)) {
      return ctx.reply("That doesn't look like a valid number — tap the setting again to retry.");
    }
    const settings = loadRealTradingSettings();
    const prev = settings[pending.key];
    settings[pending.key] = value;
    saveRealTradingSettings(settings);
    let note = "";
    if (pending.key === "positionSizeUsd" && value > 50) {
      note = "\n⚠️ Trades execute a hard-coded $50/trade safety ceiling regardless of this setting — this value won't actually be used above that.";
    }
    return ctx.reply(`Updated *${pending.key}*: ${prev} → ${value}${note}`, { parse_mode: "Markdown", ...backKeyboard() });
  }

  if (pending.type === "nftFilter") {
    const filters = loadNftFilters();
    const prev = filters[pending.key];
    const nextValue = typeof prev === "boolean" ? text.trim().toLowerCase() === "true" : Number(text.trim());
    if (typeof prev === "number" && Number.isNaN(nextValue)) {
      return ctx.reply("That doesn't look like a valid number — tap the setting again to retry.");
    }
    filters[pending.key] = nextValue;
    saveNftFilters(filters);
    return ctx.reply(`Updated *${pending.key}*: ${prev} → ${nextValue}`, { parse_mode: "Markdown", ...backKeyboard() });
  }

  if (pending.type === "nftWalletAdd") {
    const [rawInput, ...labelParts] = text.trim().split(/\s+/);
    const resolved = await resolveWalletAddressInput(rawInput);
    if (!resolved) {
      return ctx.reply("That doesn't look like a valid wallet address or resolvable ENS name — tap Add Wallet again to retry.");
    }
    const label = labelParts.join(" ") || resolved.label;
    addWatchedWallet(resolved.address, label);
    const { shown, total } = pageWatchedWallets(getWatchedWallets(), 0);
    return ctx.reply(`👛 Now watching \`${resolved.address}\`${label ? ` (${escapeMd(label)})` : ""}`, {
      parse_mode: "Markdown",
      ...nftWalletsKeyboard(shown, total, 0),
    });
  }

  if (pending.type === "nftPaperTrading") {
    const value = Number(text.trim());
    if (!Number.isFinite(value)) {
      return ctx.reply("That doesn't look like a valid number — tap the setting again to retry.");
    }
    const settings = loadNftPaperTradingSettings();
    const prev = settings[pending.key];
    settings[pending.key] = value;
    saveNftPaperTradingSettings(settings);
    return ctx.reply(`Updated *${pending.key}*: ${prev} → ${value}`, { parse_mode: "Markdown", ...backKeyboard() });
  }

  if (pending.type === "nftRealTrading") {
    if (!(await requireRealTradingUnlock(ctx))) return;
    const value = Number(text.trim());
    if (!Number.isFinite(value)) {
      return ctx.reply("That doesn't look like a valid number — tap the setting again to retry.");
    }
    const settings = loadNftRealTradingSettings();
    const prev = settings[pending.key];
    settings[pending.key] = value;
    saveNftRealTradingSettings(settings);
    let note = "";
    if (pending.key === "positionSizeEth" && value > 0.15) {
      note = "\n⚠️ Buys execute a hard-coded 0.15 ETH/item safety ceiling regardless of this setting — this value won't actually be used above that.";
    }
    return ctx.reply(`Updated *${pending.key}*: ${prev} → ${value}${note}`, { parse_mode: "Markdown", ...backKeyboard() });
  }

  if (pending.type === "removeCall" || pending.type === "pinCall") {
    const match = text.match(ADDRESS_RE);
    if (!match) return ctx.reply("That doesn't look like a valid contract address — tap the button again to retry.");
    const tokenAddress = match[0];
    if (pending.type === "removeCall") {
      const removed = deactivateCallByToken(tokenAddress);
      return ctx.reply(removed > 0 ? `🗑 Removed ${removed} call(s) for \`${tokenAddress}\` from the Watchlist.` : "No active call found for that address.", {
        parse_mode: "Markdown",
        ...backKeyboard(),
      });
    }
    const nowPinned = toggleCallPinned(tokenAddress);
    if (nowPinned === null) return ctx.reply("No active call found for that address.", { ...backKeyboard() });
    return ctx.reply(
      nowPinned
        ? `📌 Pinned \`${tokenAddress}\` — it stays on the Watchlist until you unpin or remove it.`
        : `📌 Unpinned \`${tokenAddress}\` — normal tracking-window expiry applies again.`,
      { parse_mode: "Markdown", ...backKeyboard() }
    );
  }

  if (pending.type === "nftScore") {
    const contractAddress = text.trim();
    if (!ADDRESS_RE.test(contractAddress)) {
      return ctx.reply("That doesn't look like a valid contract address.");
    }
    await ctx.reply("Analyzing…");
    try {
      await scoreAndReplyNft(ctx, contractAddress);
    } catch (err) {
      return ctx.reply(`Failed to score collection: ${err.message}`);
    }
    return;
  }

  if (pending.type === "realManualBuyAmount") {
    if (!(await requireRealTradingUnlock(ctx))) return;
    const amount = Number(text.trim());
    if (!Number.isFinite(amount) || amount <= 0) {
      return ctx.reply("That doesn't look like a valid amount — tap Buy custom amount again to retry.");
    }
    const context = manualTradeContext.get(ctx.chat.id);
    if (!context) return ctx.reply("Session expired — reopen Manual Trade.");
    await ctx.reply(`Buying ${amount}…`);
    return executeManualBuy(ctx, context, amount);
  }

  const args = text.trim().split(/\s+/).filter(Boolean);
  const usage = "Send a contract address, or `<chain> <address>` if it's listed on more than one.";
  const resolved = await resolveChainAndAddress(ctx, args, usage);
  if (!resolved) return;
  const { chainKey, tokenAddress } = resolved;

  try {
    if (pending.type === "score") {
      await ctx.reply("Analyzing…");
      await scoreAndReply(ctx, chainKey, tokenAddress);
    } else if (pending.type === "track") {
      await handleTrack(ctx, chainKey, tokenAddress);
    } else if (pending.type === "untrack") {
      const removed = deactivateTrack(chainKey, tokenAddress);
      await ctx.reply(removed ? "Stopped tracking." : "Wasn't tracking that token.", { ...backKeyboard() });
    } else if (pending.type === "realManualToken") {
      if (!(await requireRealTradingUnlock(ctx))) return;
      manualTradeContext.set(ctx.chat.id, { chainKey, tokenAddress });
      await renderManualTradeTerminal(ctx);
    }
  } catch (err) {
    ctx.reply(`Failed: ${err.message}`);
  }
}

export function createBot(stats, chainControls, digestControls) {
  const bot = new Telegraf(config.telegram.botToken);

  // Without this, an error thrown by any single handler (e.g. answering an
  // expired callback query) is unhandled and takes the whole bot process
  // down. One bad button tap should never kill the bot.
  bot.catch((err, ctx) => {
    console.error(`Bot handler error (update ${ctx.updateType}):`, err.message);
  });

  // Keep Telegram's "/" autocomplete minimal — buttons are the primary nav now.
  bot.telegram.setMyCommands([{ command: "start", description: "Open the menu" }]).catch(() => {});

  // Records every distinct user who's interacted with the bot at all — not
  // just /start — so the Bot Stats count reflects actual usage.
  bot.use((ctx, next) => {
    if (ctx.from?.id) recordBotUser(ctx.from.id);
    return next();
  });

  bot.command("start", (ctx) => ctx.reply(welcomeText(), { parse_mode: "Markdown", ...mainMenuKeyboard() }));

  bot.action("menu:botstats", async (ctx) => {
    await ctx.answerCbQuery();
    const count = countBotUsers();
    await safeEdit(ctx, `📊 *Bot Stats*\n\nUsers who've interacted with this bot: *${count}*`, backKeyboard());
  });

  // Mainnet WETH/USD via DexScreener — one of the most liquid pairs in
  // crypto, always live regardless of this bot's own activity. A chain's
  // bridged "ETH" gas token tracks real ETH closely, so this is a far more
  // reliable USD reference than anything specific to a low-volume chain.
  const MAINNET_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

  // No dedicated price oracle. Tries the always-live mainnet ETH reference
  // first (works regardless of this bot's own call volume); falls back to
  // deriving from a recently-called token's live pair only for non-ETH
  // native currencies (e.g. BNB) or if the primary lookup fails for some
  // reason. The recent-calls path originally being the *only* source meant
  // this silently stopped working during any quiet stretch with few/no
  // recent calls — confirmed live on Railway after call volume dropped.
  async function getChainNativeUsdPrice(chain) {
    if (chain.nativeSymbol === "ETH") {
      const dexPair = await getBestPair("ethereum", MAINNET_WETH).catch(() => null);
      const pair = pairSummary(dexPair, MAINNET_WETH);
      if (pair?.priceUsd) return pair.priceUsd;
    }

    const candidates = getRecentCalls(chain.key, 10);
    for (const call of candidates) {
      const dexPair = await getBestPair(chain.dexscreenerChainId, call.token_address).catch(() => null);
      const pair = pairSummary(dexPair, call.token_address);
      if (pair?.nativeUsdPrice) return pair.nativeUsdPrice;
    }
    return null;
  }

  async function renderWalletBalance(ctx) {
    const walletAddress = getWalletAddress();
    if (!walletAddress) {
      return safeEdit(ctx, "💳 *Wallet Balance*\n\nNo wallet configured — set WALLET_PRIVATE_KEY in .env to enable real-fund trading.", backKeyboard());
    }
    const balances = await Promise.all(
      Object.entries(CHAINS).map(async ([key, def]) => {
        const chain = { key, ...def };
        const [bal, nativeUsdPrice] = await Promise.all([
          getNativeBalance(chain).catch(() => null),
          getChainNativeUsdPrice(chain).catch(() => null),
        ]);
        return {
          label: def.label,
          balance: bal,
          symbol: def.nativeSymbol,
          usdValue: bal != null && nativeUsdPrice ? bal * nativeUsdPrice : null,
        };
      })
    );
    const lines = [`💳 *Wallet Balance*`, "", `\`${walletAddress}\``, ""];
    let totalUsd = 0;
    let hasAnyUsd = false;
    for (const b of balances) {
      const nativePart = b.balance != null ? `${b.balance.toFixed(6)} ${b.symbol}` : "n/a";
      const usdPart = b.usdValue != null ? ` (${fmtUsd(b.usdValue)})` : "";
      if (b.usdValue != null) {
        totalUsd += b.usdValue;
        hasAnyUsd = true;
      }
      lines.push(`${b.label}: ${nativePart}${usdPart}`);
    }
    if (hasAnyUsd) lines.push("", `Total: ${fmtUsd(totalUsd)}`);
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("🔄 Refresh", "menu:walletbalance")],
      [Markup.button.callback("🔙 Menu", "menu:home")],
    ]);
    await safeEdit(ctx, lines.join("\n"), keyboard);
  }

  bot.action("menu:walletbalance", async (ctx) => {
    await ctx.answerCbQuery();
    await renderWalletBalance(ctx);
  });

  bot.action("menu:home", async (ctx) => {
    await ctx.answerCbQuery();
    await safeEdit(ctx, welcomeText(), mainMenuKeyboard());
  });

  bot.action("menu:toggleBot", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    const nowPaused = !isPaused();
    setPaused(nowPaused);
    await ctx.answerCbQuery(nowPaused ? "Bot paused" : "Bot resumed");
    await safeEdit(ctx, welcomeText(), mainMenuKeyboard());
  });

  bot.action("menu:status", async (ctx) => {
    await ctx.answerCbQuery();
    await safeEdit(ctx, renderStatusText(stats), refreshKeyboard("menu:status"));
  });

  bot.action("menu:watchlist", async (ctx) => {
    await ctx.answerCbQuery();
    const { text, total } = await renderWatchlistPage(0);
    await safeEdit(ctx, text, watchlistKeyboard(0, total));
  });

  bot.action(/^watchlistpage:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const offset = Number(ctx.match[1]);
    const { text, total } = await renderWatchlistPage(offset);
    await safeEdit(ctx, text, watchlistKeyboard(offset, total));
  });

  bot.action("menu:removecall", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    setPending(ctx.chat.id, { type: "removeCall" });
    await ctx.reply("Paste the contract address of the call to remove from the Watchlist.");
  });

  bot.action("menu:pincall", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    setPending(ctx.chat.id, { type: "pinCall" });
    await ctx.reply("Paste the contract address of the call to pin (or unpin) — pinned calls stay on the Watchlist past the normal tracking window.");
  });

  bot.action("menu:digestinterval", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    const { intervalMinutes } = loadDigestSettings();
    setPending(ctx.chat.id, { type: "digestInterval" });
    await ctx.reply(`Send the new auto-update interval in minutes (current: ${intervalMinutes}):`);
  });

  bot.action("menu:tracklist", async (ctx) => {
    await ctx.answerCbQuery();
    const text = await renderTracklistText();
    await safeEdit(ctx, text, refreshKeyboard("menu:tracklist"));
  });

  bot.action("menu:filter", async (ctx) => {
    await ctx.answerCbQuery();
    const filters = loadFilters();
    await safeEdit(ctx, "⚙️ *Filter Settings*\n\nTap a setting to change it:", filterKeyboard(filters));
  });

  bot.action("menu:presets", async (ctx) => {
    await ctx.answerCbQuery();
    await safeEdit(ctx, presetsText(), presetsKeyboard());
  });

  bot.action(/^presetapply:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    const key = ctx.match[1];
    const presets = loadPresets();
    if (!presets[key]) {
      await ctx.answerCbQuery("Unknown preset.");
      return;
    }
    applyPreset(key);
    await ctx.answerCbQuery(`${presets[key].label} applied`);
    const filters = loadFilters();
    await safeEdit(ctx, "⚙️ *Filter Settings*\n\nTap a setting to change it:", filterKeyboard(filters));
  });

  bot.action(/^filteredit:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized to change filters.");
    const key = ctx.match[1];
    const filters = loadFilters();
    if (!(key in filters)) return ctx.reply("Unknown filter key.");
    setPending(ctx.chat.id, { type: "filter", key });
    await ctx.reply(`Send the new value for *${key}* (current: ${filters[key]}):`, { parse_mode: "Markdown" });
  });

  bot.action("menu:score", async (ctx) => {
    await ctx.answerCbQuery();
    setPending(ctx.chat.id, { type: "score" });
    await ctx.reply("Paste the contract address you want to score.");
  });

  bot.action("menu:track", async (ctx) => {
    await ctx.answerCbQuery();
    setPending(ctx.chat.id, { type: "track" });
    await ctx.reply("Paste the contract address you want to track.");
  });

  bot.action("menu:untrack", async (ctx) => {
    await ctx.answerCbQuery();
    setPending(ctx.chat.id, { type: "untrack" });
    await ctx.reply("Paste the contract address you want to stop tracking.");
  });

  bot.action("menu:chains", async (ctx) => {
    await ctx.answerCbQuery();
    await safeEdit(ctx, "⛓ *Chains*\n\nTap a chain to turn its watcher on or off:", chainsKeyboard());
  });

  bot.action("menu:papertrading", async (ctx) => {
    await ctx.answerCbQuery();
    const settings = loadPaperTradingSettings();
    const stats = getPaperTradingStats();
    const { totalUnrealizedUsd } = await getOpenTradesWithLivePnl();
    await safeEdit(ctx, buildPaperTradingSummary({ settings, stats, unrealizedPnlUsd: totalUnrealizedUsd }), paperTradingKeyboard(settings));
  });

  bot.action("papertoggle", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    const settings = loadPaperTradingSettings();
    settings.enabled = !settings.enabled;
    savePaperTradingSettings(settings);
    await ctx.answerCbQuery(settings.enabled ? "Paper trading resumed" : "Paper trading paused");
    const stats = getPaperTradingStats();
    const { totalUnrealizedUsd } = await getOpenTradesWithLivePnl();
    await safeEdit(ctx, buildPaperTradingSummary({ settings, stats, unrealizedPnlUsd: totalUnrealizedUsd }), paperTradingKeyboard(settings));
  });

  bot.action("comandotoggle", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    const settings = loadPaperTradingSettings();
    settings.superComandoEnabled = !settings.superComandoEnabled;
    savePaperTradingSettings(settings);
    await ctx.answerCbQuery(settings.superComandoEnabled ? "Super Comando ON" : "Super Comando off");
    const stats = getPaperTradingStats();
    const { totalUnrealizedUsd } = await getOpenTradesWithLivePnl();
    await safeEdit(ctx, buildPaperTradingSummary({ settings, stats, unrealizedPnlUsd: totalUnrealizedUsd }), paperTradingKeyboard(settings));
  });

  bot.action("menu:paperactive", async (ctx) => {
    await ctx.answerCbQuery();
    const { trades, totalUnrealizedUsd } = await getOpenTradesWithLivePnl();
    trades.sort((a, b) => (b.pnlPct ?? -Infinity) - (a.pnlPct ?? -Infinity));
    await safeEdit(ctx, buildActiveTradesMessage({ trades, totalUnrealizedUsd, mode: "paper" }), activeTradesKeyboard(trades));
  });

  bot.action("paperconfirm:closeall", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    const openCount = getOpenPaperTrades().length;
    if (openCount === 0) return safeEdit(ctx, "No open trades to close.", paperTradingKeyboard(loadPaperTradingSettings()));
    await safeEdit(ctx, `⚠️ Close all ${openCount} open paper trade(s) at current market price? This can't be undone.`, closeAllConfirmKeyboard());
  });

  bot.action("paperclosall", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    await ctx.answerCbQuery("Closing all trades…");
    const { closedCount, totalPnlUsd, skippedCount } = await closeAllOpenTrades();
    const lines = [
      `🛑 *Closed ${closedCount} paper trade(s)*`,
      `PnL from this batch: ${totalPnlUsd >= 0 ? "+" : "-"}$${Math.abs(totalPnlUsd).toFixed(2)}`,
    ];
    if (skippedCount > 0) lines.push(`⚠️ ${skippedCount} trade(s) skipped — couldn't fetch a current price, left open.`);
    const settings = loadPaperTradingSettings();
    const stats = getPaperTradingStats();
    const { totalUnrealizedUsd } = await getOpenTradesWithLivePnl();
    await safeEdit(
      ctx,
      `${lines.join("\n")}\n\n${buildPaperTradingSummary({ settings, stats, unrealizedPnlUsd: totalUnrealizedUsd })}`,
      paperTradingKeyboard(settings)
    );
  });

  bot.action(/^paperclosetrade:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    const id = Number(ctx.match[1]);
    const t = getPaperTradeById(id);
    if (!t || t.status !== "open") {
      await ctx.answerCbQuery("Already closed or not found.");
      return;
    }
    const lockKey = `${t.chain}:${t.token_address}`;
    if (!acquireTradeLock(lockKey)) {
      await ctx.answerCbQuery("A trade for this token is already in progress — please wait.");
      return;
    }
    await ctx.answerCbQuery(`Closing #${id}…`);
    const chainDef = CHAINS[t.chain];
    try {
      const dexPair = await getBestPair(chainDef.dexscreenerChainId, t.token_address);
      const pair = pairSummary(dexPair, t.token_address);
      if (!pair || !isSanePrice(pair.priceUsd)) {
        return safeEdit(ctx, `⚠️ Couldn't fetch a current price for ${escapeMd(t.symbol) || t.token_address} — left open.`, activeTradesKeyboard(getOpenPaperTrades()));
      }
      const pnlPct = ((pair.priceUsd - t.entry_price_usd) / t.entry_price_usd) * 100;
      const pnlUsd = t.position_size_usd * (pnlPct / 100);
      closePaperTrade(id, { exitPriceUsd: pair.priceUsd, exitReason: "manual_close", pnlUsd, pnlPct });
    } catch (err) {
      return safeEdit(ctx, `⚠️ Failed to close #${id}: ${err.message}`, activeTradesKeyboard(getOpenPaperTrades()));
    } finally {
      releaseTradeLock(lockKey);
    }
    const { trades, totalUnrealizedUsd } = await getOpenTradesWithLivePnl();
    trades.sort((a, b) => (b.pnlPct ?? -Infinity) - (a.pnlPct ?? -Infinity));
    await safeEdit(ctx, buildActiveTradesMessage({ trades, totalUnrealizedUsd, mode: "paper" }), activeTradesKeyboard(trades));
  });

  bot.action(/^paperedit:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    const key = ctx.match[1];
    const settings = loadPaperTradingSettings();
    if (!(key in settings)) return ctx.reply("Unknown setting.");
    setPending(ctx.chat.id, { type: "paperTrading", key });
    await ctx.reply(`Send the new value for *${key}* (current: ${settings[key]}):`, { parse_mode: "Markdown" });
  });

  bot.action("menu:paperclosed", async (ctx) => {
    await ctx.answerCbQuery();
    const closed = getClosedPaperTrades(15);
    if (closed.length === 0) {
      return safeEdit(ctx, "📜 *Closed Paper Trades*\n\nNone yet.", backKeyboard());
    }
    const lines = closed.map((t) => {
      const won = t.pnl_pct >= 0;
      return `${won ? "🟢" : "🔴"} *${escapeMd(t.symbol) || "?"}* — ${t.pnl_pct >= 0 ? "+" : ""}${t.pnl_pct.toFixed(1)}% (${t.exit_reason})`;
    });
    await safeEdit(ctx, `📜 *Closed Paper Trades* (last ${closed.length})\n\n${lines.join("\n")}`, backKeyboard());
  });

  async function renderRealTradingView(ctx) {
    const settings = loadRealTradingSettings();
    const stats = getRealTradingStats();
    const { totalUnrealizedUsd } = await getOpenRealTradesWithLivePnl();
    const walletAddress = getWalletAddress();
    let walletBalances = [];
    if (walletAddress) {
      walletBalances = await Promise.all(
        Object.entries(CHAINS).map(async ([key, def]) => {
          const chain = { key, ...def };
          const bal = await getNativeBalance(chain).catch(() => null);
          return { label: def.label, balance: bal ?? 0, symbol: def.nativeSymbol };
        })
      );
    }
    await safeEdit(
      ctx,
      buildRealTradingSummary({ settings, stats, unrealizedPnlUsd: totalUnrealizedUsd, walletAddress, walletBalances }),
      realTradingKeyboard(settings, hasWallet())
    );
  }

  bot.action("menu:realtrading", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireRealTradingUnlock(ctx))) return;
    await renderRealTradingView(ctx);
  });

  bot.action("menu:realmanual", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    if (!(await requireRealTradingUnlock(ctx))) return;
    const settings = loadRealTradingSettings();
    if (!settings.enabled) return ctx.reply("Manual Trade is only available once real trading is enabled.");
    setPending(ctx.chat.id, { type: "realManualToken" });
    await ctx.reply("Paste the contract address you want to trade.");
  });

  bot.action("realmanualrefresh", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireRealTradingUnlock(ctx))) return;
    await renderManualTradeTerminal(ctx);
  });

  bot.action(/^realbuyquick:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
    if (!(await requireRealTradingUnlock(ctx))) return;
    const idx = Number(ctx.match[1]);
    const amount = MANUAL_BUY_PRESETS[idx];
    const context = manualTradeContext.get(ctx.chat.id);
    if (!context || amount == null) return ctx.answerCbQuery("Session expired — reopen Manual Trade.");
    await ctx.answerCbQuery(`Buying ${amount}…`);
    await executeManualBuy(ctx, context, amount);
  });

  bot.action("realbuycustom", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    if (!(await requireRealTradingUnlock(ctx))) return;
    const context = manualTradeContext.get(ctx.chat.id);
    if (!context) return ctx.reply("Session expired — reopen Manual Trade.");
    setPending(ctx.chat.id, { type: "realManualBuyAmount" });
    await ctx.reply(`Send the amount of ${CHAINS[context.chainKey].nativeSymbol} to buy (e.g. 0.02):`);
  });

  bot.action(/^realsellpct:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
    if (!(await requireRealTradingUnlock(ctx))) return;
    const pct = Number(ctx.match[1]);
    const context = manualTradeContext.get(ctx.chat.id);
    if (!context) return ctx.answerCbQuery("Session expired — reopen Manual Trade.");
    await ctx.answerCbQuery(`Selling ${pct}%…`);
    await executeManualSell(ctx, context, pct);
  });

  bot.action("realconfirm:enable", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    if (!(await requireRealTradingUnlock(ctx))) return;
    if (!hasWallet()) return safeEdit(ctx, "⚠️ No wallet configured. Add WALLET_PRIVATE_KEY to .env first.", realTradingKeyboard(loadRealTradingSettings(), false));
    const settings = loadRealTradingSettings();
    await safeEdit(
      ctx,
      `⚠️ *This trades with real money.*\n\nPosition size: $${settings.positionSizeUsd} | Budget: $${settings.totalBudgetUsd}\n\nEvery call that passes your filters will attempt a real on-chain buy. Continue?`,
      realEnableConfirmKeyboard()
    );
  });

  bot.action("realtoggle", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    if (!(await requireRealTradingUnlock(ctx))) return;
    const settings = loadRealTradingSettings();
    if (!settings.enabled && !hasWallet()) {
      await ctx.answerCbQuery("No wallet configured.");
      return safeEdit(ctx, "⚠️ No wallet configured. Add WALLET_PRIVATE_KEY to .env first.", realTradingKeyboard(settings, false));
    }
    settings.enabled = !settings.enabled;
    saveRealTradingSettings(settings);
    await ctx.answerCbQuery(settings.enabled ? "🔴 REAL trading enabled" : "Real trading paused");
    await renderRealTradingView(ctx);
  });

  bot.action("realcomandotoggle", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    if (!(await requireRealTradingUnlock(ctx))) return;
    const settings = loadRealTradingSettings();
    settings.superComandoEnabled = !settings.superComandoEnabled;
    saveRealTradingSettings(settings);
    await ctx.answerCbQuery(settings.superComandoEnabled ? "Super Comando ON" : "Super Comando off");
    await renderRealTradingView(ctx);
  });

  bot.action("menu:realactive", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireRealTradingUnlock(ctx))) return;
    const { trades, totalUnrealizedUsd } = await getOpenRealTradesWithLivePnl();
    trades.sort((a, b) => (b.pnlPct ?? -Infinity) - (a.pnlPct ?? -Infinity));
    const walletBalances = await getWalletBalancesForTrades(trades);
    await safeEdit(ctx, buildActiveTradesMessage({ trades, totalUnrealizedUsd, walletBalances, mode: "real" }), realActiveTradesKeyboard(trades));
  });

  bot.action("realconfirm:closeall", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    if (!(await requireRealTradingUnlock(ctx))) return;
    const openCount = getOpenRealTrades().length;
    if (openCount === 0) return safeEdit(ctx, "No open real trades to close.", realTradingKeyboard(loadRealTradingSettings(), hasWallet()));
    await safeEdit(
      ctx,
      `⚠️ Sell all ${openCount} open REAL position(s) at current market price? This executes real transactions and can't be undone.`,
      realCloseAllConfirmKeyboard()
    );
  });

  bot.action("realclosall", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    if (!(await requireRealTradingUnlock(ctx))) return;
    await ctx.answerCbQuery("Selling all positions…");
    const settings = loadRealTradingSettings();
    const { closedCount, totalPnlUsd, failedCount } = await closeAllOpenRealTrades(settings);
    const lines = [
      `🛑 *Sold ${closedCount} real position(s)*`,
      `PnL from this batch: ${totalPnlUsd >= 0 ? "+" : "-"}$${Math.abs(totalPnlUsd).toFixed(2)}`,
    ];
    if (failedCount > 0) lines.push(`⚠️ ${failedCount} position(s) failed to sell — left open, will retry automatically.`);
    const stats = getRealTradingStats();
    const { totalUnrealizedUsd } = await getOpenRealTradesWithLivePnl();
    await safeEdit(
      ctx,
      `${lines.join("\n")}\n\n${buildRealTradingSummary({ settings, stats, unrealizedPnlUsd: totalUnrealizedUsd, walletAddress: getWalletAddress(), walletBalances: [] })}`,
      realTradingKeyboard(settings, hasWallet())
    );
  });

  // Sells a single open real position — unlike realclosall, this leaves
  // every other open position untouched. Same never-mark-closed-without-a-
  // confirmed-sale discipline as the bulk close.
  bot.action(/^realclosetrade:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    if (!(await requireRealTradingUnlock(ctx))) return;
    const id = Number(ctx.match[1]);
    const t = getRealTradeById(id);
    if (!t || t.status !== "open") {
      await ctx.answerCbQuery("Already closed or not found.");
      return;
    }
    const lockKey = `${t.chain}:${t.token_address}`;
    if (!acquireTradeLock(lockKey)) {
      await ctx.answerCbQuery("A trade for this token is already in progress — please wait.");
      return;
    }
    await ctx.answerCbQuery(`Selling #${id}…`);
    const settings = loadRealTradingSettings();
    const chainDef = CHAINS[t.chain];
    try {
      const dexPair = await getBestPair(chainDef.dexscreenerChainId, t.token_address);
      const pair = pairSummary(dexPair, t.token_address);
      if (!pair || !isSanePrice(pair.priceUsd)) {
        return safeEdit(ctx, `⚠️ Couldn't fetch a current price for ${escapeMd(t.symbol) || t.token_address} — left open.`, realActiveTradesKeyboard(getOpenRealTrades()));
      }
      const chain = { key: t.chain, ...chainDef };
      const sellResult = await withSlippageRetry((bps) => sellToken(chain, t.token_address, t.token_amount_raw, bps), settings.slippageBps);
      const pnlUsd = sellResult.proceedsUsd - t.position_size_usd - t.entry_gas_usd - sellResult.gasUsd;
      const pnlPct = (pnlUsd / t.position_size_usd) * 100;
      closeRealTrade(id, {
        exitPriceUsd: pair.priceUsd,
        exitReason: "manual_close",
        pnlUsd,
        pnlPct,
        nativeReceived: sellResult.nativeReceived,
        exitTxHash: sellResult.txHash,
        exitGasUsd: sellResult.gasUsd,
      });
    } catch (err) {
      return safeEdit(ctx, `⚠️ Failed to sell #${id}: ${err.message}`, realActiveTradesKeyboard(getOpenRealTrades()));
    } finally {
      releaseTradeLock(lockKey);
    }
    const { trades, totalUnrealizedUsd } = await getOpenRealTradesWithLivePnl();
    trades.sort((a, b) => (b.pnlPct ?? -Infinity) - (a.pnlPct ?? -Infinity));
    const walletBalances = await getWalletBalancesForTrades(trades);
    await safeEdit(ctx, buildActiveTradesMessage({ trades, totalUnrealizedUsd, walletBalances, mode: "real" }), realActiveTradesKeyboard(trades));
  });

  bot.action(/^realedit:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    if (!(await requireRealTradingUnlock(ctx))) return;
    const key = ctx.match[1];
    const settings = loadRealTradingSettings();
    if (!(key in settings)) return ctx.reply("Unknown setting.");
    setPending(ctx.chat.id, { type: "realTrading", key });
    await ctx.reply(`Send the new value for *${key}* (current: ${settings[key]}):`, { parse_mode: "Markdown" });
  });

  bot.action("menu:realclosed", async (ctx) => {
    await ctx.answerCbQuery();
    if (!(await requireRealTradingUnlock(ctx))) return;
    const closed = getClosedRealTrades(15);
    if (closed.length === 0) {
      return safeEdit(ctx, "📜 *Closed Real Trades*\n\nNone yet.", backKeyboard());
    }
    const lines = closed.map((t) => {
      const won = t.pnl_pct >= 0;
      return `${won ? "🟢" : "🔴"} *${escapeMd(t.symbol) || "?"}* — ${t.pnl_pct >= 0 ? "+" : ""}${t.pnl_pct.toFixed(1)}% (${t.exit_reason})`;
    });
    await safeEdit(ctx, `📜 *Closed Real Trades* (last ${closed.length})\n\n${lines.join("\n")}`, backKeyboard());
  });

  bot.action(/^chaintoggle:(.+)$/, async (ctx) => {
    const key = ctx.match[1];
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    if (!CHAINS[key]) {
      await ctx.answerCbQuery("Unknown chain.");
      return;
    }
    const nowEnabled = !isChainEnabled(key);
    chainControls.toggleChain(key, nowEnabled);
    await ctx.answerCbQuery(`${CHAINS[key].label} ${nowEnabled ? "enabled" : "disabled"}`);
    await safeEdit(ctx, "⛓ *Chains*\n\nTap a chain to turn its watcher on or off:", chainsKeyboard());
  });

  // --- NFT menu — all gated behind OPENSEA_API_KEY being configured (the
  // main-menu button itself is already hidden without it, but every entry
  // point re-checks since callback data could in principle be replayed).
  function requireOpensea(ctx) {
    if (!config.openseaApiKey) {
      ctx.answerCbQuery?.("NFT features need OPENSEA_API_KEY set in .env.");
      return false;
    }
    return true;
  }

  bot.action("menu:nft", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireOpensea(ctx)) return;
    const chainLabels = getNftChainDefs().map((c) => c.label).join(", ") || "none configured";
    await safeEdit(
      ctx,
      `🖼 *NFTs*\n\nNew-collection sniping + wallet copy-trading on ${chainLabels}, via OpenSea. NFT exits list on the marketplace and wait for a buyer — not an instant swap like token trading.`,
      nftMenuKeyboard()
    );
  });

  bot.action("menu:nftfilter", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireOpensea(ctx)) return;
    const filters = loadNftFilters();
    await safeEdit(ctx, "⚙️ *NFT Filter Settings*\n\nTap a setting to change it:", nftFilterKeyboard(filters));
  });

  bot.action(/^nftfilteredit:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized to change filters.");
    const key = ctx.match[1];
    const filters = loadNftFilters();
    if (!(key in filters)) return ctx.reply("Unknown filter key.");
    setPending(ctx.chat.id, { type: "nftFilter", key });
    await ctx.reply(`Send the new value for *${key}* (current: ${filters[key]}):`, { parse_mode: "Markdown" });
  });

  bot.action("menu:nftwallets", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireOpensea(ctx)) return;
    const { shown, total } = pageWatchedWallets(getWatchedWallets(), 0);
    await safeEdit(ctx, renderWatchedWalletsText(shown, total, 0), nftWalletsKeyboard(shown, total, 0));
  });

  bot.action(/^nftwalletspage:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireOpensea(ctx)) return;
    const offset = Number(ctx.match[1]);
    const { shown, total } = pageWatchedWallets(getWatchedWallets(), offset);
    await safeEdit(ctx, renderWatchedWalletsText(shown, total, offset), nftWalletsKeyboard(shown, total, offset));
  });

  bot.action("nftwalletadd", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    setPending(ctx.chat.id, { type: "nftWalletAdd" });
    await ctx.reply(
      "Send the wallet address or ENS name (`name.eth`) to watch, optionally followed by a label — e.g. `0xabc... whale1` or `vitalik.eth`",
      { parse_mode: "Markdown" }
    );
  });

  // Legacy remove buttons (pre-pagination messages still live in chat
  // history) carry callback data without the :offset suffix — treat them as
  // page 0 rather than silently ignoring the tap.
  bot.action(/^nftwalletremove:(0x[a-fA-F0-9]{40})$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    const removed = removeWatchedWallet(ctx.match[1]);
    await ctx.answerCbQuery(removed ? "Removed." : "Not found.");
    const { shown, total } = pageWatchedWallets(getWatchedWallets(), 0);
    await safeEdit(ctx, renderWatchedWalletsText(shown, total, 0), nftWalletsKeyboard(shown, total, 0));
  });

  bot.action(/^nftwalletremove:(0x[a-fA-F0-9]{40}):(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    const [, address, offsetStr] = ctx.match;
    const removed = removeWatchedWallet(address);
    await ctx.answerCbQuery(removed ? "Removed." : "Not found.");
    // Stay on the same page after removing — re-clamped in case removing
    // the last wallet on the last page would otherwise show an empty page.
    const wallets = getWatchedWallets();
    const offset = Math.min(Number(offsetStr), Math.max(0, wallets.length - 1));
    const { shown, total } = pageWatchedWallets(wallets, offset);
    await safeEdit(ctx, renderWatchedWalletsText(shown, total, offset), nftWalletsKeyboard(shown, total, offset));
  });

  bot.action("menu:nftpapertrading", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireOpensea(ctx)) return;
    const settings = loadNftPaperTradingSettings();
    const stats = getNftPaperTradingStats();
    await safeEdit(ctx, buildNftTradingSummary({ settings, stats, mode: "paper" }), nftPaperTradingKeyboard(settings));
  });

  bot.action("nftpapertoggle", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    const settings = loadNftPaperTradingSettings();
    settings.enabled = !settings.enabled;
    saveNftPaperTradingSettings(settings);
    await ctx.answerCbQuery(settings.enabled ? "NFT paper trading resumed" : "NFT paper trading paused");
    const stats = getNftPaperTradingStats();
    await safeEdit(ctx, buildNftTradingSummary({ settings, stats, mode: "paper" }), nftPaperTradingKeyboard(settings));
  });

  bot.action(/^nftpaperedit:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    const key = ctx.match[1];
    const settings = loadNftPaperTradingSettings();
    if (!(key in settings)) return ctx.reply("Unknown setting.");
    setPending(ctx.chat.id, { type: "nftPaperTrading", key });
    await ctx.reply(`Send the new value for *${key}* (current: ${settings[key]}):`, { parse_mode: "Markdown" });
  });

  function renderNftPositionsText(positions, mode) {
    const label = mode === "real" ? "REAL NFT Positions" : "NFT Paper Positions";
    if (positions.length === 0) return `📋 *${label}* (0)\n\nNothing open right now.`;
    const lines = positions.map((p) => {
      const statusTag = p.status === "listed" ? `🏷️ listed at ${p.listed_price_eth} ETH` : "🟢 held";
      return `*${escapeMd(p.name) || "?"}* #${p.token_id} (${p.chain})\n   Entry: ${p.entry_price_eth} ETH | Target: ${p.target_multiple}x | Stop: ${p.stop_floor_pct}% — ${statusTag}`;
    });
    return `📋 *${label}* (${positions.length})\n\n${lines.join("\n\n")}`;
  }

  bot.action("menu:nftpaperactive", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireOpensea(ctx)) return;
    const positions = getOpenNftPaperTrades();
    await safeEdit(ctx, renderNftPositionsText(positions, "paper"), refreshKeyboard("menu:nftpaperactive"));
  });

  bot.action("menu:nftrealactive", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireOpensea(ctx)) return;
    if (!(await requireRealTradingUnlock(ctx))) return;
    const positions = getOpenNftRealTrades();
    await safeEdit(ctx, renderNftPositionsText(positions, "real"), refreshKeyboard("menu:nftrealactive"));
  });

  bot.action("menu:nftrealtrading", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireOpensea(ctx)) return;
    if (!(await requireRealTradingUnlock(ctx))) return;
    const settings = loadNftRealTradingSettings();
    const stats = getNftRealTradingStats();
    await safeEdit(ctx, buildNftTradingSummary({ settings, stats, mode: "real" }), nftRealTradingKeyboard(settings, hasWallet()));
  });

  bot.action("nftrealconfirm:enable", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    if (!(await requireRealTradingUnlock(ctx))) return;
    if (!hasWallet()) return safeEdit(ctx, "⚠️ No wallet configured. Add WALLET_PRIVATE_KEY to .env first.", nftRealTradingKeyboard(loadNftRealTradingSettings(), false));
    const settings = loadNftRealTradingSettings();
    await safeEdit(
      ctx,
      `⚠️ *This trades NFTs with real money.*\n\nPosition size: ${settings.positionSizeEth} ETH | Budget: ${settings.totalBudgetEth} ETH\n\n` +
        `NFT exits list on OpenSea and wait for a buyer — not a guaranteed or instant sale like token trading. Continue?`,
      nftRealEnableConfirmKeyboard()
    );
  });

  bot.action("nftrealtoggle", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    if (!(await requireRealTradingUnlock(ctx))) return;
    const settings = loadNftRealTradingSettings();
    if (!settings.enabled && !hasWallet()) {
      await ctx.answerCbQuery("No wallet configured.");
      return safeEdit(ctx, "⚠️ No wallet configured. Add WALLET_PRIVATE_KEY to .env first.", nftRealTradingKeyboard(settings, false));
    }
    settings.enabled = !settings.enabled;
    saveNftRealTradingSettings(settings);
    await ctx.answerCbQuery(settings.enabled ? "🔴 REAL NFT trading enabled" : "Real NFT trading paused");
    const stats = getNftRealTradingStats();
    await safeEdit(ctx, buildNftTradingSummary({ settings, stats, mode: "real" }), nftRealTradingKeyboard(settings, hasWallet()));
  });

  bot.action(/^nftrealedit:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    if (!(await requireRealTradingUnlock(ctx))) return;
    const key = ctx.match[1];
    const settings = loadNftRealTradingSettings();
    if (!(key in settings)) return ctx.reply("Unknown setting.");
    setPending(ctx.chat.id, { type: "nftRealTrading", key });
    await ctx.reply(`Send the new value for *${key}* (current: ${settings[key]}):`, { parse_mode: "Markdown" });
  });

  bot.action("menu:nftscore", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireOpensea(ctx)) return;
    setPending(ctx.chat.id, { type: "nftScore" });
    await ctx.reply("Paste the NFT collection's contract address.");
  });

  // Slash commands still work underneath the buttons, for muscle memory.
  bot.command("status", (ctx) => ctx.reply(renderStatusText(stats), { parse_mode: "Markdown", ...backKeyboard() }));
  bot.command("watchlist", async (ctx) => {
    const { text, total } = await renderWatchlistPage(0);
    ctx.reply(text, { parse_mode: "Markdown", ...watchlistKeyboard(0, total) });
  });
  bot.command(["tracklist", "tracked"], async (ctx) => {
    const text = await renderTracklistText();
    ctx.reply(text, { parse_mode: "Markdown", ...backKeyboard() });
  });
  bot.command("filter", (ctx) => {
    const filters = loadFilters();
    ctx.reply("```\n" + JSON.stringify(filters, null, 2) + "\n```", { parse_mode: "Markdown", ...backKeyboard() });
  });
  bot.command("presets", (ctx) => ctx.reply(presetsText(), { parse_mode: "Markdown", ...presetsKeyboard() }));
  bot.command("setfilter", (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    const [, key, rawValue] = ctx.message.text.split(/\s+/);
    if (!key || rawValue === undefined) return ctx.reply("Usage: /setfilter <key> <value>");
    const filters = loadFilters();
    if (!(key in filters)) return ctx.reply(`Unknown filter key. Valid keys: ${Object.keys(filters).join(", ")}`);
    const prev = filters[key];
    filters[key] = typeof prev === "boolean" ? rawValue === "true" : Number(rawValue);
    saveFilters(filters);
    ctx.reply(`Updated ${key}: ${prev} → ${filters[key]}`);
  });
  bot.command("score", async (ctx) => {
    const args = ctx.message.text.split(/\s+/).filter(Boolean).slice(1);
    const resolved = await resolveChainAndAddress(ctx, args, `Usage: /score <tokenAddress> or /score <chain> <tokenAddress>`);
    if (!resolved) return;
    await ctx.reply("Analyzing…");
    try {
      await scoreAndReply(ctx, resolved.chainKey, resolved.tokenAddress);
    } catch (err) {
      ctx.reply(`Failed to score token: ${err.message}`);
    }
  });
  bot.command("track", async (ctx) => {
    const args = ctx.message.text.split(/\s+/).filter(Boolean).slice(1);
    const resolved = await resolveChainAndAddress(ctx, args, `Usage: /track <tokenAddress> or /track <chain> <tokenAddress>`);
    if (!resolved) return;
    try {
      await handleTrack(ctx, resolved.chainKey, resolved.tokenAddress);
    } catch (err) {
      ctx.reply(`Failed to track token: ${err.message}`);
    }
  });
  bot.command("untrack", async (ctx) => {
    const args = ctx.message.text.split(/\s+/).filter(Boolean).slice(1);
    const resolved = await resolveChainAndAddress(ctx, args, `Usage: /untrack <tokenAddress> or /untrack <chain> <tokenAddress>`);
    if (!resolved) return;
    const removed = deactivateTrack(resolved.chainKey, resolved.tokenAddress);
    ctx.reply(removed ? "Stopped tracking." : "Wasn't tracking that token.");
  });
  bot.command("removecall", (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    const [, address] = ctx.message.text.split(/\s+/);
    if (!address || !ADDRESS_RE.test(address)) return ctx.reply("Usage: /removecall <tokenAddress>");
    const removed = deactivateCallByToken(address);
    ctx.reply(removed > 0 ? `🗑 Removed ${removed} call(s) from the Watchlist.` : "No active call found for that address.");
  });
  bot.command("pincall", (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    const [, address] = ctx.message.text.split(/\s+/);
    if (!address || !ADDRESS_RE.test(address)) return ctx.reply("Usage: /pincall <tokenAddress>");
    const nowPinned = toggleCallPinned(address);
    if (nowPinned === null) return ctx.reply("No active call found for that address.");
    ctx.reply(nowPinned ? "📌 Pinned — stays on the Watchlist until unpinned/removed." : "📌 Unpinned — normal expiry applies again.");
  });
  bot.command("nftfilter", (ctx) => {
    if (!requireOpensea(ctx)) return ctx.reply("NFT features need OPENSEA_API_KEY set in .env.");
    const filters = loadNftFilters();
    ctx.reply("```\n" + JSON.stringify(filters, null, 2) + "\n```", { parse_mode: "Markdown", ...backKeyboard() });
  });
  bot.command("setnftfilter", (ctx) => {
    if (!requireOpensea(ctx)) return ctx.reply("NFT features need OPENSEA_API_KEY set in .env.");
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    const [, key, rawValue] = ctx.message.text.split(/\s+/);
    if (!key || rawValue === undefined) return ctx.reply("Usage: /setnftfilter <key> <value>");
    const filters = loadNftFilters();
    if (!(key in filters)) return ctx.reply(`Unknown filter key. Valid keys: ${Object.keys(filters).join(", ")}`);
    const prev = filters[key];
    filters[key] = typeof prev === "boolean" ? rawValue === "true" : Number(rawValue);
    saveNftFilters(filters);
    ctx.reply(`Updated ${key}: ${prev} → ${filters[key]}`);
  });
  bot.command("nftscore", async (ctx) => {
    if (!requireOpensea(ctx)) return ctx.reply("NFT features need OPENSEA_API_KEY set in .env.");
    const args = ctx.message.text.split(/\s+/).filter(Boolean).slice(1);
    const usage = `Usage: /nftscore <contractAddress> or /nftscore <chain> <contractAddress> (chains: ${getNftChainKeys().join(", ")})`;
    let chainKeyHint, contractAddress;
    if (args.length === 1) {
      contractAddress = args[0];
    } else if (args.length === 2) {
      [chainKeyHint, contractAddress] = args;
      chainKeyHint = chainKeyHint.toLowerCase();
    } else {
      return ctx.reply(usage);
    }
    if (!contractAddress || !ADDRESS_RE.test(contractAddress)) return ctx.reply(usage);
    await ctx.reply("Analyzing…");
    try {
      await scoreAndReplyNft(ctx, contractAddress, chainKeyHint);
    } catch (err) {
      ctx.reply(`Failed to score collection: ${err.message}`);
    }
  });
  bot.command("watchwallet", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    const [, rawInput, ...labelParts] = ctx.message.text.split(/\s+/);
    if (!rawInput) return ctx.reply("Usage: /watchwallet <address or name.eth> [label]");
    const resolved = await resolveWalletAddressInput(rawInput);
    if (!resolved) return ctx.reply("That doesn't look like a valid wallet address or resolvable ENS name.");
    const label = labelParts.join(" ") || resolved.label;
    addWatchedWallet(resolved.address, label);
    ctx.reply(`👛 Now watching \`${resolved.address}\`${label ? ` (${escapeMd(label)})` : ""}`, { parse_mode: "Markdown" });
  });
  // Bulk-import version of /watchwallet — one entry per line (address or
  // ENS name, optionally followed by a label), for loading a real
  // watchlist in a handful of messages instead of one command per wallet.
  // Telegram itself caps an incoming text message at 4096 chars, so a
  // large list (dozens+) still needs sending in a few chunks — that's fine,
  // addWatchedWallet is idempotent (INSERT ... ON CONFLICT DO UPDATE), so
  // re-sending an overlapping chunk is harmless.
  bot.command("watchwallets", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    const body = ctx.message.text.replace(/^\/watchwallets(@\w+)?\s*/i, "");
    const entries = body
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (entries.length === 0) {
      return ctx.reply(
        "Usage: /watchwallets followed by one address or ENS name per line (optional label after it), e.g.\n" +
          "/watchwallets\n0xabc... whale1\nvitalik.eth"
      );
    }
    await ctx.reply(`Processing ${entries.length} entries…`);

    let added = 0;
    const failed = [];
    for (const entry of entries) {
      const [rawInput, ...labelParts] = entry.split(/\s+/);
      const resolved = await resolveWalletAddressInput(rawInput);
      if (!resolved) {
        failed.push(entry);
        continue;
      }
      addWatchedWallet(resolved.address, labelParts.join(" ") || resolved.label);
      added++;
    }

    const lines = [`👛 Added/updated ${added} watched wallet(s).`];
    if (failed.length) {
      lines.push(`⚠️ ${failed.length} couldn't be resolved:`, ...failed.slice(0, 15).map((f) => `  ${f}`));
      if (failed.length > 15) lines.push(`  … and ${failed.length - 15} more`);
    }
    ctx.reply(lines.join("\n"));
  });
  bot.command("unwatchwallet", (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    const [, address] = ctx.message.text.split(/\s+/);
    if (!address) return ctx.reply("Usage: /unwatchwallet <address>");
    const removed = removeWatchedWallet(address);
    ctx.reply(removed ? "Removed." : "Wasn't watching that address.");
  });

  // Free text: either the answer to a button prompt, or a bare pasted
  // address (auto-scored by default with no prompt needed).
  bot.on("text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    const pending = takePending(ctx.chat.id);
    if (pending) return handlePendingAction(ctx, pending, text, digestControls);

    const match = text.match(ADDRESS_RE);
    if (!match) return;
    const tokenAddress = match[0];

    await ctx.reply(`Looking up \`${tokenAddress}\`…`, { parse_mode: "Markdown" });
    try {
      const chainKeys = await detectChains(tokenAddress);
      if (chainKeys.length === 0) {
        return ctx.reply(
          `Couldn't find this token on any supported chain (${Object.keys(CHAINS).join(", ")}). ` +
            `It may be too new to be indexed yet, or on a chain this bot doesn't watch.`
        );
      }
      for (const chainKey of chainKeys) {
        await scoreAndReply(ctx, chainKey, tokenAddress);
      }
    } catch (err) {
      ctx.reply(`Failed to analyze token: ${err.message}`);
    }
  });

  return bot;
}

// Telegram hard-rejects anything over 4096 chars (e.g. a token with an
// absurdly long name/symbol can push a normally-short message over that) —
// truncate defensively rather than let sendMessage throw.
const TELEGRAM_MAX_LENGTH = 4096;
function truncateForTelegram(text) {
  if (text.length <= TELEGRAM_MAX_LENGTH) return text;
  return `${text.slice(0, TELEGRAM_MAX_LENGTH - 20)}\n\n… (truncated)`;
}

// Sends to every configured destination (primary chat + any signal
// channels), independently — one destination failing (e.g. bot removed as
// channel admin) must not block delivery to the others. Returns the primary
// chat's message_id, since that's the only one anything else references.
async function broadcast(bot, message) {
  let primaryMessageId = null;
  for (const destination of config.telegram.destinations) {
    try {
      const sent = await bot.telegram.sendMessage(destination, message, { parse_mode: "Markdown" });
      if (destination === config.telegram.chatId) primaryMessageId = sent.message_id;
    } catch (err) {
      console.error(`Failed to send to ${destination}:`, err.message);
    }
  }
  return primaryMessageId;
}

export async function postCall(bot, { chain, tokenAddress, riskResult, name, symbol }) {
  const message = truncateForTelegram(buildCallMessage({ chain, tokenAddress, riskResult, name, symbol }));
  return broadcast(bot, message);
}

export async function postUpdate(bot, text) {
  return broadcast(bot, truncateForTelegram(text));
}

// Telegram caption limit is 1024 chars (much shorter than a text message's
// 4096) — the open/close messages this feeds are already only a few short
// lines, but truncate defensively rather than let sendPhoto throw on an
// unexpectedly long one (e.g. a token with a very long name/symbol).
const TELEGRAM_CAPTION_MAX_LENGTH = 1024;
function truncateCaption(text) {
  if (text.length <= TELEGRAM_CAPTION_MAX_LENGTH) return text;
  return `${text.slice(0, TELEGRAM_CAPTION_MAX_LENGTH - 20)}\n\n… (truncated)`;
}

// Sends a rendered trade card (open/close PNG from telegram/tradeCard.js) as
// a photo with the existing text message as its caption — same
// per-destination independent-delivery discipline as broadcast(), with a
// text-only fallback if the image itself fails to send for some reason
// (channel permissions, oversized buffer, etc.) so a rendering hiccup never
// costs the update entirely.
export async function postTradeCard(bot, { caption, imageBuffer }) {
  const text = truncateCaption(caption);
  for (const destination of config.telegram.destinations) {
    try {
      await bot.telegram.sendPhoto(destination, { source: imageBuffer }, { caption: text, parse_mode: "Markdown" });
    } catch (err) {
      console.error(`Failed to send trade card to ${destination}:`, err.message);
      try {
        await bot.telegram.sendMessage(destination, truncateForTelegram(caption), { parse_mode: "Markdown" });
      } catch (err2) {
        console.error(`Text fallback also failed for ${destination}:`, err2.message);
      }
    }
  }
}

// Same per-destination independent-delivery discipline as broadcast() above,
// but sends the collection image via sendPhoto (caption = the call text)
// when one is available, falling back to a plain text message otherwise —
// unlike token calls, an NFT call has a real, usually-distinctive image
// worth showing inline rather than just linking out.
export async function postNftCall(bot, { chain, contractAddress, riskResult, source, triggerWalletLabel }) {
  const message = truncateForTelegram(buildNftCallMessage({ chain, contractAddress, riskResult, source, triggerWalletLabel }));
  // sendPhoto captions cap at 1024 chars — a quarter of a text message's
  // 4096. Truncating both to 4096 meant any flag-heavy call (i.e. exactly
  // the risky ones) failed the photo send on every destination and fell
  // back to text, so images never appeared where they mattered most.
  const caption = truncateCaption(message);
  const imageUrl = riskResult.imageUrl;

  let primaryMessageId = null;
  for (const destination of config.telegram.destinations) {
    try {
      const sent = imageUrl
        ? await bot.telegram.sendPhoto(destination, imageUrl, { caption, parse_mode: "Markdown" })
        : await bot.telegram.sendMessage(destination, message, { parse_mode: "Markdown" });
      if (destination === config.telegram.chatId) primaryMessageId = sent.message_id;
    } catch (err) {
      console.error(`Failed to send NFT call to ${destination}:`, err.message);
      // A bad/unreachable image URL shouldn't lose the call entirely — retry
      // that one destination as a plain text message.
      if (imageUrl) {
        try {
          const sent = await bot.telegram.sendMessage(destination, message, { parse_mode: "Markdown" });
          if (destination === config.telegram.chatId) primaryMessageId = sent.message_id;
        } catch (err2) {
          console.error(`Text fallback also failed for ${destination}:`, err2.message);
        }
      }
    }
  }
  return primaryMessageId;
}
