import { computeRiskScore } from "./risk/riskScore.js";
import { applyFilter } from "./filters/filter.js";
import { recordCall, recordDeployerOutcome, hasBeenCalled, findRecentCallsByName } from "./store/db.js";
import { postCall } from "./telegram/bot.js";
import { openPaperTradeIfRoom } from "./paperTrading.js";
import { openRealTradeIfRoom } from "./realTrading.js";
import { screenForRugPatterns } from "./ai/rugDetector.js";
import { analyzeRugRisk } from "./ai/rugAnalyst.js";
import { getBestPair, pairSummary } from "./risk/dexscreener.js";

// For each prior same-name call, fetches its current price (best-effort) so
// the AI screen can see whether the earlier namesake already pumped —
// central to judging whether the new one looks like a copycat.
async function withPerformance(chain, priorCalls) {
  return Promise.all(
    priorCalls.map(async (p) => {
      let pctChangeSinceCall = null;
      try {
        const dexPair = await getBestPair(chain.dexscreenerChainId, p.token_address);
        const pair = pairSummary(dexPair, p.token_address);
        if (pair?.priceUsd && p.call_price_usd > 0) {
          pctChangeSinceCall = ((pair.priceUsd - p.call_price_usd) / p.call_price_usd) * 100;
        }
      } catch {
        // best-effort — leave pctChangeSinceCall null if the lookup fails
      }
      return { tokenAddress: p.token_address, calledAt: p.called_at, pctChangeSinceCall };
    })
  );
}

// Scores a token, runs it through the filter, and posts+records a call if
// it passes. Shared by the live pair watcher (age 0) and the recheck queue
// (re-evaluated periodically as liquidity/holders build up).
export async function evaluateToken(bot, { chain, dexName, pairAddress, tokenAddress, ageMinutes }) {
  // A token can reach here twice — e.g. an overlapping recheck-queue cycle
  // re-processing a token another cycle already called while it was busy
  // scoring earlier entries. Checked first so an already-called token skips
  // both the API calls and, more importantly, never sends a second message.
  if (hasBeenCalled(chain.key, tokenAddress)) {
    return { pass: false, reasons: ["Already called"], riskResult: null };
  }

  const riskResult = await computeRiskScore(chain, tokenAddress);
  const { pass, reasons, filters } = applyFilter(riskResult, ageMinutes);

  if (riskResult.deployerAddress) {
    recordDeployerOutcome(riskResult.deployerAddress, { lowScore: riskResult.score < 40 });
  }

  if (!pass) {
    return { pass: false, reasons, riskResult };
  }

  const { name, symbol } = riskResult;

  // Optional extra gate, on top of the numeric filters above — an AI read on
  // whether the name/symbol/deployer looks like a scam pattern. Toggle lives
  // in filters.json (requireAiScreen) and no-ops if no API key is configured.
  let groqVerdict = null;
  if (filters.requireAiScreen) {
    const priorCalls = findRecentCallsByName(chain.key, name, tokenAddress);
    const namesakes = priorCalls.length ? await withPerformance(chain, priorCalls) : [];
    groqVerdict = await screenForRugPatterns({ name, symbol, deployerAddress: riskResult.deployerAddress, chain: chain.key, namesakes });
    if (groqVerdict.suspicious) {
      return { pass: false, reasons: [`AI screen flagged: ${groqVerdict.reasoning || "suspicious pattern"}`], riskResult };
    }
  }

  // Second, distinct AI gate — quantitative signals (liquidity/volume/LP-lock)
  // weighed against real backtested base rates for this chain, catching
  // combinations the fixed numeric thresholds above can't express. Toggle
  // lives in filters.json (requireClaudeRugAnalysis); no-ops without an
  // Anthropic key. Only rejects on "severe" — "elevated"/"baseline" both pass,
  // since most tokens on this chain are elevated risk by nature (see
  // src/ai/rugAnalyst.js) and gating on that would block nearly everything.
  if (filters.requireClaudeRugAnalysis) {
    const claudeVerdict = await analyzeRugRisk({
      name,
      symbol,
      chain: chain.key,
      ageMinutes: ageMinutes ?? null,
      liquidityUsd: riskResult.pair?.liquidityUsd,
      marketCapUsd: riskResult.pair?.marketCapUsd,
      volume24hUsd: riskResult.pair?.volume24h,
      lpLock: riskResult.lpLock,
      groqVerdict,
    });
    if (claudeVerdict.riskLevel === "severe") {
      return { pass: false, reasons: [`AI rug analysis flagged severe risk: ${claudeVerdict.reasoning || "no reasoning given"}`], riskResult };
    }
  }

  const messageId = await postCall(bot, { chain, tokenAddress, riskResult, name, symbol });

  const sec = riskResult.security;
  const top10Pct = sec?.holders?.length ? sec.holders.slice(0, 10).reduce((s, h) => s + (Number(h.percent) || 0), 0) * 100 : null;

  recordCall({
    chain: chain.key,
    tokenAddress,
    pairAddress,
    symbol: symbol || null,
    name: name || null,
    callPriceUsd: riskResult.pair?.priceUsd || 0,
    callMarketCapUsd: riskResult.pair?.marketCapUsd || 0,
    riskScore: riskResult.score,
    riskGrade: riskResult.grade,
    telegramMessageId: messageId,
    calledAt: Date.now(),
    // Snapshot of the scoring inputs, for future preset/algorithm analysis —
    // see the note in db.js on why this wasn't captured historically.
    callLiquidityUsd: riskResult.pair?.liquidityUsd ?? null,
    callVolume24hUsd: riskResult.pair?.volume24h ?? null,
    callHolderCount: sec?.holder_count != null ? Number(sec.holder_count) : null,
    callTop10Pct: top10Pct,
    callCreatorPct: sec?.creator_percent != null ? Number(sec.creator_percent) * 100 : null,
    callIsOpenSource: sec?.is_open_source != null ? (sec.is_open_source === "1" || sec.is_open_source === 1 ? 1 : 0) : null,
    callIsMintable: sec?.is_mintable != null ? (sec.is_mintable === "1" || sec.is_mintable === 1 ? 1 : 0) : null,
  });

  // Paper trading always runs alongside real trading (not replaced by it) —
  // it's the ongoing validation signal for the strategy regardless of
  // whether real funds are also in play.
  await openPaperTradeIfRoom(bot, {
    chain,
    tokenAddress,
    symbol,
    name,
    priceUsd: riskResult.pair?.priceUsd,
    marketCapUsd: riskResult.pair?.marketCapUsd,
  });
  // No-ops unless realTradingSettings.enabled is explicitly true and a
  // wallet is configured — see realTrading.js.
  await openRealTradeIfRoom(bot, {
    chain,
    tokenAddress,
    symbol,
    name,
    priceUsd: riskResult.pair?.priceUsd,
    marketCapUsd: riskResult.pair?.marketCapUsd,
  });

  return { pass: true, riskResult, name, symbol };
}
