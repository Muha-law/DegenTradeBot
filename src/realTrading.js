import cron from "node-cron";
import { CHAINS } from "./chains.js";
import { isPaused } from "./botState.js";
import { loadRealTradingSettings } from "./realTradingSettings.js";
import { getBestPair, pairSummary } from "./risk/dexscreener.js";
import { checkFreshLiquidity } from "./filters/filter.js";
import { shouldExitMooner } from "./ai/superComando.js";
import { buyToken, sellToken, verifySellable, withSlippageRetry } from "./execution/swapExecutor.js";
import { hasWallet } from "./wallet.js";
import {
  openRealTrade,
  getOpenRealTrades,
  touchRealTrade,
  touchRealTradeStalePrice,
  closeRealTrade,
  getRealTradingStats,
  activateRealComandoMode,
  touchRealComando,
  getCalledTokenSnapshot,
} from "./store/db.js";
import { postUpdate, postTradeCard } from "./telegram/bot.js";
import {
  buildRealTradeOpenMessage,
  buildRealTradeCloseMessage,
  buildRealTradeFailedMessage,
  buildComandoActivatedMessage,
} from "./telegram/formatMessage.js";
import { renderOpenCard, renderCloseCard } from "./telegram/tradeCard.js";

const CHECK_CRON = "*/2 * * * *";
// Same throttle rationale as paper trading's Super Comando — see paperTrading.js.
const COMANDO_AI_CHECK_INTERVAL_MS = 5 * 60 * 1000;

// Same rationale as paperTrading.js's constant of the same name — 30
// minutes of sustained unreadable price is well past any transient blip
// we've observed self-heal, and is when the checker stops skipping the
// position and forces a real sell attempt instead.
const STALE_PRICE_EXIT_MINUTES = 30;

function isSanePrice(n) {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n < 1e12;
}

// See the matching constant/comment in paperTrading.js — a near-empty pool's
// reserve-ratio price can look "sane" by magnitude alone while backed by a
// few cents of real liquidity. For real trades the actual dollar PnL is
// still protected (it's computed from real swap proceeds, not this price),
// but the exit *decision* (take-profit/stop-loss/Super Comando comparisons
// below) and the recorded exitPriceUsd both use pair.priceUsd directly, so
// a corrupted price could still trigger a bogus early exit or an AI check
// fed nonsense data.
const MIN_REALIZABLE_LIQUIDITY_USD = 25;

// See the matching function in paperTrading.js — same backtested gate,
// applied identically to real trades.
function qualifiesForComando(trade, settings) {
  const snapshot = getCalledTokenSnapshot(trade.chain, trade.token_address);
  if (!snapshot || snapshot.call_volume24h_usd == null) return false;
  return snapshot.call_volume24h_usd <= settings.superComandoMaxCallVolumeUsd;
}

// Called whenever a real call passes the filter. Executes an actual on-chain
// buy, budget-capped by realTradingSettings, only if real trading is
// explicitly enabled and a wallet is configured. No-ops otherwise — this
// never runs alongside paper trading being the only thing enabled.
export async function openRealTradeIfRoom(bot, { chain, tokenAddress, symbol, name, priceUsd }) {
  const settings = loadRealTradingSettings();
  if (!settings.enabled) return;
  if (!hasWallet()) return;
  if (!isSanePrice(priceUsd)) return;
  if (!chain.routerAddress) {
    console.error(`[realTrading] no router configured for ${chain.key}, skipping ${symbol}`);
    return;
  }

  const stats = getRealTradingStats();
  if (stats.deployedUsd + settings.positionSizeUsd > settings.totalBudgetUsd) {
    console.log(`[realTrading] budget exhausted (${stats.deployedUsd}/${settings.totalBudgetUsd}) — skipping ${symbol}`);
    return;
  }

  // Fresh re-check right before spending real money — the filter pass that
  // got us here can be seconds to minutes stale, long enough for liquidity
  // to have been pulled in the meantime.
  const liq = await checkFreshLiquidity(chain, tokenAddress);
  if (!liq.pass) {
    console.error(`[realTrading] ${symbol}: ${liq.reason} — aborting buy`);
    await postUpdate(bot, buildRealTradeFailedMessage({ chain, tokenAddress, name, symbol, reason: liq.reason }));
    return;
  }

  let result;
  try {
    result = await withSlippageRetry((bps) => buyToken(chain, tokenAddress, settings.positionSizeUsd, bps), settings.slippageBps);
  } catch (err) {
    console.error(`[realTrading] BUY FAILED for ${symbol} (${chain.key}) after slippage retries:`, err.message);
    await postUpdate(bot, buildRealTradeFailedMessage({ chain, tokenAddress, name, symbol, reason: err.message }));
    return;
  }

  const res = openRealTrade({
    chain: chain.key,
    tokenAddress,
    symbol: symbol || null,
    name: name || null,
    entryPriceUsd: result.entryPriceUsd,
    positionSizeUsd: settings.positionSizeUsd,
    takeProfitPct: settings.takeProfitPct,
    stopLossPct: settings.stopLossPct,
    entryAt: Date.now(),
    tokenAmountRaw: result.tokenAmountRaw,
    nativeSpent: result.nativeSpent,
    entryTxHash: result.txHash,
    entryGasUsd: result.gasUsd,
  });
  if (res.changes === 0) {
    // Bought on-chain but a row already existed for this token (shouldn't
    // happen given hasBeenCalled dedup upstream, but never silently strand
    // a real position untracked).
    console.error(`[realTrading] bought ${symbol} but DB row already existed — tx ${result.txHash} needs manual reconciliation`);
    return;
  }

  // Best-effort honeypot check using the real, just-bought balance — see
  // swapExecutor.js's verifySellable for why this matters on a chain GoPlus
  // doesn't cover. Catches the blacklist/pause/trading-disabled pattern in
  // seconds instead of leaving a bad position to be discovered hours later.
  const sellCheck = await verifySellable(chain, tokenAddress, result.tokenAmountRaw);
  if (!sellCheck.sellable) {
    console.error(`[realTrading] ⚠️ SELLABILITY CHECK FAILED for ${symbol} (${chain.key}): ${sellCheck.reason} — likely honeypot, attempting immediate exit`);
    await postUpdate(
      bot,
      buildRealTradeFailedMessage({
        chain,
        tokenAddress,
        name,
        symbol,
        reason: `⚠️ Bought successfully, but a sellability check right after failed — likely a honeypot: ${sellCheck.reason}. Attempting immediate exit.`,
      })
    );
    try {
      // Deliberately not using withSlippageRetry here — verifySellable just
      // predicted this exact sell would fail because the token's own
      // transfer logic rejects it (blacklist/pause/disabled trading), not
      // because of price movement. More slippage tolerance can't fix that;
      // retrying would just burn time re-failing the same way.
      const sellResult = await sellToken(chain, tokenAddress, result.tokenAmountRaw, settings.slippageBps);
      const pnlUsd = sellResult.proceedsUsd - settings.positionSizeUsd - result.gasUsd - sellResult.gasUsd;
      const pnlPct = (pnlUsd / settings.positionSizeUsd) * 100;
      closeRealTrade(res.lastInsertRowid, {
        exitPriceUsd: 0,
        exitReason: "honeypot_immediate_exit",
        pnlUsd,
        pnlPct,
        nativeReceived: sellResult.nativeReceived,
        exitTxHash: sellResult.txHash,
        exitGasUsd: sellResult.gasUsd,
      });
      await postTradeCard(bot, {
        caption: buildRealTradeCloseMessage({
          chain,
          tokenAddress,
          name,
          symbol,
          entryPriceUsd: result.entryPriceUsd,
          exitPriceUsd: 0,
          pnlUsd,
          pnlPct,
          exitReason: "honeypot_immediate_exit",
          txHash: sellResult.txHash,
          gasUsd: sellResult.gasUsd,
        }),
        imageBuffer: renderCloseCard({
          chainLabel: chain.label,
          symbol,
          name,
          tradeMode: "real",
          entryPriceUsd: result.entryPriceUsd,
          exitPriceUsd: 0,
          pnlUsd,
          pnlPct,
          exitReason: "honeypot_immediate_exit",
          tokenAddress,
        }),
      });
    } catch (err) {
      // Expected for a true honeypot — the static-call already predicted
      // this. Leave the position open; the normal 2-minute checker (and the
      // stale-price forced-exit fallback) will keep retrying at zero cost
      // (these reverts happen at the free gas-estimate stage, never broadcast).
      console.error(`[realTrading] immediate exit attempt also failed for ${symbol} (expected for a confirmed honeypot):`, err.message);
    }
    return;
  }

  await postTradeCard(bot, {
    caption: buildRealTradeOpenMessage({
      chain,
      tokenAddress,
      name,
      symbol,
      entryPriceUsd: result.entryPriceUsd,
      positionSizeUsd: settings.positionSizeUsd,
      takeProfitPct: settings.takeProfitPct,
      stopLossPct: settings.stopLossPct,
      txHash: result.txHash,
      gasUsd: result.gasUsd,
    }),
    imageBuffer: renderOpenCard({
      chainLabel: chain.label,
      symbol,
      name,
      tradeMode: "real",
      entryPriceUsd: result.entryPriceUsd,
      positionSizeUsd: settings.positionSizeUsd,
      takeProfitPct: settings.takeProfitPct,
      stopLossPct: settings.stopLossPct,
      tokenAddress,
    }),
  });
}

export function startRealTradeChecker(bot) {
  const task = cron.schedule(CHECK_CRON, async () => {
    if (isPaused()) return;
    const settings = loadRealTradingSettings();
    if (!settings.enabled) return;

    const open = getOpenRealTrades();
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
            // Force a real sell attempt anyway rather than leave this stuck
            // forever with no way to ever hit stop-loss (this is exactly
            // what let a position sit unmanaged once its pool's liquidity
            // got drained to near-zero). Whatever proceeds come back are
            // real, even if near zero; if the sell itself fails (e.g. truly
            // zero liquidity), leave it open and retry next cycle — same
            // discipline as any other exit attempt in this loop.
            console.error(`[realTrading] ${t.symbol} (${t.chain}) price unavailable for ${staleMinutes.toFixed(0)}m — forcing sell attempt`);
            let sellResult;
            try {
              sellResult = await withSlippageRetry((bps) => sellToken(chain, t.token_address, t.token_amount_raw, bps), settings.slippageBps);
            } catch (err) {
              console.error(`[realTrading] stale-price forced sell failed for ${t.symbol} (${t.chain}) after slippage retries:`, err.message);
              touchRealTradeStalePrice(t.id);
              continue;
            }

            const pnlUsd = sellResult.proceedsUsd - t.position_size_usd - t.entry_gas_usd - sellResult.gasUsd;
            const realizedPnlPct = (pnlUsd / t.position_size_usd) * 100;
            closeRealTrade(t.id, {
              exitPriceUsd: 0,
              exitReason: "stale_price_exit",
              pnlUsd,
              pnlPct: realizedPnlPct,
              nativeReceived: sellResult.nativeReceived,
              exitTxHash: sellResult.txHash,
              exitGasUsd: sellResult.gasUsd,
            });
            await postTradeCard(bot, {
              caption: buildRealTradeCloseMessage({
                chain,
                tokenAddress: t.token_address,
                name: t.name,
                symbol: t.symbol,
                entryPriceUsd: t.entry_price_usd,
                exitPriceUsd: 0,
                pnlUsd,
                pnlPct: realizedPnlPct,
                exitReason: "stale_price_exit",
                txHash: sellResult.txHash,
                gasUsd: sellResult.gasUsd,
              }),
              imageBuffer: renderCloseCard({
                chainLabel: chain.label,
                symbol: t.symbol,
                name: t.name,
                tradeMode: "real",
                entryPriceUsd: t.entry_price_usd,
                exitPriceUsd: 0,
                pnlUsd,
                pnlPct: realizedPnlPct,
                exitReason: "stale_price_exit",
                tokenAddress: t.token_address,
              }),
            });
          } else {
            touchRealTradeStalePrice(t.id);
          }
          continue;
        }

        const pnlPct = ((pair.priceUsd - t.entry_price_usd) / t.entry_price_usd) * 100;
        let exitReason = null;

        if (settings.superComandoEnabled && t.comando_active) {
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
              touchRealComando(t.id, { peakPct, aiCheckedAt: Date.now() });
              if (verdict.sell) exitReason = "comando_ai_exit";
            } else {
              touchRealComando(t.id, { peakPct, aiCheckedAt: t.comando_last_ai_check_at });
            }
          }
        } else if (settings.superComandoEnabled && pnlPct >= t.take_profit_pct && qualifiesForComando(t, settings)) {
          activateRealComandoMode(t.id, { peakPct: pnlPct });
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
          let sellResult;
          try {
            sellResult = await withSlippageRetry((bps) => sellToken(chain, t.token_address, t.token_amount_raw, bps), settings.slippageBps);
          } catch (err) {
            // Sell reverted or failed even across the slippage ladder —
            // position is still genuinely open on-chain. Leave it open and
            // retry next cycle rather than mark it closed on a transaction
            // that never happened.
            console.error(`[realTrading] SELL FAILED for ${t.symbol} (${t.chain}), exitReason=${exitReason}, after slippage retries:`, err.message);
            touchRealTrade(t.id);
            continue;
          }

          // Real realized PnL — actual sale proceeds minus what was put in
          // and both legs' real gas cost, not derived from price % (which
          // ignores slippage and fee-on-transfer token losses).
          const pnlUsd = sellResult.proceedsUsd - t.position_size_usd - t.entry_gas_usd - sellResult.gasUsd;
          const realizedPnlPct = (pnlUsd / t.position_size_usd) * 100;
          closeRealTrade(t.id, {
            exitPriceUsd: pair.priceUsd,
            exitReason,
            pnlUsd,
            pnlPct: realizedPnlPct,
            nativeReceived: sellResult.nativeReceived,
            exitTxHash: sellResult.txHash,
            exitGasUsd: sellResult.gasUsd,
          });
          await postTradeCard(bot, {
            caption: buildRealTradeCloseMessage({
              chain,
              tokenAddress: t.token_address,
              name: t.name,
              symbol: t.symbol,
              entryPriceUsd: t.entry_price_usd,
              exitPriceUsd: pair.priceUsd,
              pnlUsd,
              pnlPct: realizedPnlPct,
              exitReason,
              txHash: sellResult.txHash,
              gasUsd: sellResult.gasUsd,
            }),
            imageBuffer: renderCloseCard({
              chainLabel: chain.label,
              symbol: t.symbol,
              name: t.name,
              tradeMode: "real",
              entryPriceUsd: t.entry_price_usd,
              exitPriceUsd: pair.priceUsd,
              pnlUsd,
              pnlPct: realizedPnlPct,
              exitReason,
              tokenAddress: t.token_address,
            }),
          });
        } else {
          touchRealTrade(t.id);
        }
      } catch (err) {
        console.error(`[realTrading] failed to check ${t.symbol} (${t.chain}):`, err.message);
      }
    }
  });

  console.log(`[realTrading] position checker scheduled every 2m`);
  return task;
}
