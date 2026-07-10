import cron from "node-cron";
import { CHAINS } from "./chains.js";
import { isPaused } from "./botState.js";
import { loadRealTradingSettings } from "./realTradingSettings.js";
import { getBestPair, pairSummary } from "./risk/dexscreener.js";
import { shouldExitMooner } from "./ai/superComando.js";
import { buyToken, sellToken } from "./execution/swapExecutor.js";
import { hasWallet } from "./wallet.js";
import {
  openRealTrade,
  getOpenRealTrades,
  touchRealTrade,
  closeRealTrade,
  getRealTradingStats,
  activateRealComandoMode,
  touchRealComando,
  getCalledTokenSnapshot,
} from "./store/db.js";
import { postUpdate } from "./telegram/bot.js";
import {
  buildRealTradeOpenMessage,
  buildRealTradeCloseMessage,
  buildRealTradeFailedMessage,
  buildComandoActivatedMessage,
} from "./telegram/formatMessage.js";

const CHECK_CRON = "*/2 * * * *";
// Same throttle rationale as paper trading's Super Comando — see paperTrading.js.
const COMANDO_AI_CHECK_INTERVAL_MS = 5 * 60 * 1000;

function isSanePrice(n) {
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n < 1e12;
}

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

  let result;
  try {
    result = await buyToken(chain, tokenAddress, settings.positionSizeUsd, settings.slippageBps);
  } catch (err) {
    console.error(`[realTrading] BUY FAILED for ${symbol} (${chain.key}):`, err.message);
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

  await postUpdate(
    bot,
    buildRealTradeOpenMessage({
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
    })
  );
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
        if (!pair || !isSanePrice(pair.priceUsd)) {
          touchRealTrade(t.id);
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
            sellResult = await sellToken(chain, t.token_address, t.token_amount_raw, settings.slippageBps);
          } catch (err) {
            // Sell reverted or failed — position is still genuinely open
            // on-chain. Leave it open and retry next cycle rather than
            // mark it closed on a transaction that never happened.
            console.error(`[realTrading] SELL FAILED for ${t.symbol} (${t.chain}), exitReason=${exitReason}:`, err.message);
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
          await postUpdate(
            bot,
            buildRealTradeCloseMessage({
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
            })
          );
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
