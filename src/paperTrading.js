import cron from "node-cron";
import { CHAINS } from "./chains.js";
import { isPaused } from "./botState.js";
import { loadPaperTradingSettings } from "./paperTradingSettings.js";
import { getBestPair, pairSummary } from "./risk/dexscreener.js";
import { shouldExitMooner } from "./ai/superComando.js";
import { checkFreshLiquidity } from "./filters/filter.js";
import {
  openPaperTrade,
  getOpenPaperTrades,
  touchPaperTrade,
  touchPaperTradeStalePrice,
  closePaperTrade,
  getPaperTradingStats,
  activateComandoMode,
  touchComando,
  getCalledTokenSnapshot,
} from "./store/db.js";
import { postUpdate, postTradeCard } from "./telegram/bot.js";
import { buildPaperTradeOpenMessage, buildPaperTradeCloseMessage, buildComandoActivatedMessage } from "./telegram/formatMessage.js";
import { renderOpenCard, renderCloseCard } from "./telegram/tradeCard.js";

const CHECK_CRON = "*/2 * * * *";
// How often, per trade, Super Comando is allowed to spend an AI call asking
// "sell now or keep holding" — the floor-breach rule below runs every 2m
// regardless and is what actually protects the position; this throttle just
// keeps Groq free-tier usage sane when several trades are riding at once.
// 5m (not the original 15m) because real trade data shows most positions on
// this bot resolve within 0-30 minutes — a 15m throttle meant the AI rarely
// got a chance to weigh in before the trade was already over.
const COMANDO_AI_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// How long a position's price can stay unreadable/insane (isSanePrice
// fails — e.g. a pool drained to near-zero liquidity) before the checker
// stops silently skipping it and forces a close instead. 30 minutes (15
// checks at the 2m cron interval) is well past any transient RPC/DexScreener
// blip we've observed self-heal within a minute or two — long enough to
// rule those out, short enough to not leave real risk unmanaged for long.
const STALE_PRICE_EXIT_MINUTES = 30;

function isSanePrice(n) {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n < 1e12;
}

// A near-empty pool's reserve-ratio price can blow up to something that
// looks "sane" by magnitude alone (e.g. $4M) while backed by a few cents of
// real liquidity — confirmed live: CatKing and cryptotime both exited via
// Super Comando's AI at a corrupted multi-million-dollar price, recording a
// nonsense multi-quadrillion-dollar pnl_usd that poisoned the aggregate
// stats. isSanePrice alone doesn't catch this since it only checks
// magnitude, not whether the price is backed by anything real.
const MIN_REALIZABLE_LIQUIDITY_USD = 25;

// Gates Super Comando activation to tokens whose call-time volume matched
// the backtested "genuine mover" signature (see superComandoMaxCallVolumeUsd
// in paperTradingSettings.js) — "sniffing out the surest mooners" rather
// than letting every take-profit crossing ride. Tokens called before the
// call-time snapshot columns existed have no volume data to check; those
// fall back to the plain take-profit exit rather than riding on unverified
// grounds.
function qualifiesForComando(trade, settings) {
  const snapshot = getCalledTokenSnapshot(trade.chain, trade.token_address);
  if (!snapshot || snapshot.call_volume24h_usd == null) return false;
  return snapshot.call_volume24h_usd <= settings.superComandoMaxCallVolumeUsd;
}

// Called whenever a real call passes the filter — opens a simulated
// position sized and budget-capped by paperTradingSettings, independent of
// whether real-money trading is ever turned on. No-ops quietly if paper
// trading is disabled or the token's already-priced-in state won't work
// (e.g. no usable entry price).
export async function openPaperTradeIfRoom(bot, { chain, tokenAddress, symbol, name, priceUsd }) {
  const settings = loadPaperTradingSettings();
  if (!settings.enabled) return;
  if (!isSanePrice(priceUsd)) return;

  const stats = getPaperTradingStats();
  if (stats.deployedUsd + settings.positionSizeUsd > settings.totalBudgetUsd) {
    console.log(`[paperTrading] budget exhausted (${stats.deployedUsd}/${settings.totalBudgetUsd}) — skipping ${symbol}`);
    return;
  }

  // Mirrors the real-trading guard so paper trading's win rate stays a
  // meaningful signal for how the real strategy would actually perform.
  const liq = await checkFreshLiquidity(chain, tokenAddress);
  if (!liq.pass) {
    console.log(`[paperTrading] ${symbol}: ${liq.reason} — skipping`);
    return;
  }

  const res = openPaperTrade({
    chain: chain.key,
    tokenAddress,
    symbol: symbol || null,
    name: name || null,
    entryPriceUsd: priceUsd,
    positionSizeUsd: settings.positionSizeUsd,
    takeProfitPct: settings.takeProfitPct,
    stopLossPct: settings.stopLossPct,
    entryAt: Date.now(),
  });
  if (res.changes === 0) return; // already have an open/closed position for this token

  const caption = buildPaperTradeOpenMessage({
    chain,
    tokenAddress,
    name,
    symbol,
    entryPriceUsd: priceUsd,
    positionSizeUsd: settings.positionSizeUsd,
    takeProfitPct: settings.takeProfitPct,
    stopLossPct: settings.stopLossPct,
  });
  const imageBuffer = renderOpenCard({
    chainLabel: chain.label,
    symbol,
    name,
    tradeMode: "paper",
    entryPriceUsd: priceUsd,
    positionSizeUsd: settings.positionSizeUsd,
    takeProfitPct: settings.takeProfitPct,
    stopLossPct: settings.stopLossPct,
    tokenAddress,
  });
  await postTradeCard(bot, { caption, imageBuffer });
}

export function startPaperTradeChecker(bot) {
  const task = cron.schedule(CHECK_CRON, async () => {
    if (isPaused()) return;
    const settings = loadPaperTradingSettings();
    if (!settings.enabled) return;

    const open = getOpenPaperTrades();
    for (const t of open) {
      const chainDef = CHAINS[t.chain];
      if (!chainDef) continue;
      const chain = { key: t.chain, ...chainDef };

      try {
        const dexPair = await getBestPair(chainDef.dexscreenerChainId, t.token_address);
        const pair = pairSummary(dexPair, t.token_address);
        const liquidityDust = pair && (!pair.liquidityUsd || pair.liquidityUsd < MIN_REALIZABLE_LIQUIDITY_USD);
        if (!pair || !isSanePrice(pair.priceUsd) || liquidityDust) {
          const staleMinutes = t.price_unavailable_since ? (Date.now() - t.price_unavailable_since) / 60000 : 0;
          if (t.price_unavailable_since && staleMinutes >= STALE_PRICE_EXIT_MINUTES) {
            // Sustained unreadable price — most likely a drained/dead pool.
            // No real price exists to simulate an exit at, so assume a
            // total loss rather than leave this stuck forever with no way
            // to ever hit stop-loss.
            const pnlUsd = -t.position_size_usd;
            const pnlPct = -100;
            closePaperTrade(t.id, { exitPriceUsd: 0, exitReason: "stale_price", pnlUsd, pnlPct });
            await postTradeCard(bot, {
              caption: buildPaperTradeCloseMessage({
                chain,
                tokenAddress: t.token_address,
                name: t.name,
                symbol: t.symbol,
                entryPriceUsd: t.entry_price_usd,
                exitPriceUsd: 0,
                pnlUsd,
                pnlPct,
                exitReason: "stale_price",
              }),
              imageBuffer: renderCloseCard({
                chainLabel: chain.label,
                symbol: t.symbol,
                name: t.name,
                tradeMode: "paper",
                entryPriceUsd: t.entry_price_usd,
                exitPriceUsd: 0,
                pnlUsd,
                pnlPct,
                exitReason: "stale_price",
                tokenAddress: t.token_address,
              }),
            });
          } else {
            touchPaperTradeStalePrice(t.id);
          }
          continue;
        }

        const pnlPct = ((pair.priceUsd - t.entry_price_usd) / t.entry_price_usd) * 100;
        let exitReason = null;

        if (settings.superComandoEnabled && t.comando_active) {
          // Already riding — take_profit_pct is now a protected floor, not
          // a sell target. Below it, close immediately regardless of AI;
          // at/above it, ask the (throttled) AI whether this is the moment
          // to bank the bigger gain or keep letting it run.
          if (pnlPct < t.take_profit_pct) {
            exitReason = "comando_floor";
          } else {
            const peakPct = Math.max(t.comando_peak_pct ?? pnlPct, pnlPct);
            const dueForAiCheck = Date.now() - (t.comando_last_ai_check_at || 0) >= COMANDO_AI_CHECK_INTERVAL_MS;
            if (dueForAiCheck) {
              const minutesHeld = (Date.now() - t.comando_activated_at) / 60000;
              const verdict = await shouldExitMooner({
                symbol: t.symbol,
                name: t.name,
                pnlPct,
                peakPct,
                floorPct: t.take_profit_pct,
                minutesHeld,
              });
              touchComando(t.id, { peakPct, aiCheckedAt: Date.now() });
              if (verdict.sell) exitReason = "comando_ai_exit";
            } else {
              touchComando(t.id, { peakPct, aiCheckedAt: t.comando_last_ai_check_at });
            }
          }
        } else if (settings.superComandoEnabled && pnlPct >= t.take_profit_pct && qualifiesForComando(t, settings)) {
          // Just crossed the take-profit target, and this token's call-time
          // profile matches the backtested "genuine mover" signature —
          // instead of closing, hand it over to ride mode.
          activateComandoMode(t.id, { peakPct: pnlPct });
          await postUpdate(
            bot,
            buildComandoActivatedMessage({ chain, tokenAddress: t.token_address, name: t.name, symbol: t.symbol, pnlPct, floorPct: t.take_profit_pct })
          );
        } else if (pnlPct >= t.take_profit_pct) {
          exitReason = "take_profit";
        } else if (pnlPct <= t.stop_loss_pct) {
          exitReason = "stop_loss";
        }

        if (exitReason) {
          const pnlUsd = t.position_size_usd * (pnlPct / 100);
          closePaperTrade(t.id, { exitPriceUsd: pair.priceUsd, exitReason, pnlUsd, pnlPct });
          await postTradeCard(bot, {
            caption: buildPaperTradeCloseMessage({
              chain,
              tokenAddress: t.token_address,
              name: t.name,
              symbol: t.symbol,
              entryPriceUsd: t.entry_price_usd,
              exitPriceUsd: pair.priceUsd,
              pnlUsd,
              pnlPct,
              exitReason,
            }),
            imageBuffer: renderCloseCard({
              chainLabel: chain.label,
              symbol: t.symbol,
              name: t.name,
              tradeMode: "paper",
              entryPriceUsd: t.entry_price_usd,
              exitPriceUsd: pair.priceUsd,
              pnlUsd,
              pnlPct,
              exitReason,
              tokenAddress: t.token_address,
            }),
          });
        } else {
          touchPaperTrade(t.id);
        }
      } catch (err) {
        console.error(`[paperTrading] failed to check ${t.symbol} (${t.chain}):`, err.message);
      }
    }
  });

  console.log(`[paperTrading] position checker scheduled every 2m`);
  return task;
}
