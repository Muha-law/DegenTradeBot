import fs from "node:fs";
import path from "node:path";
import { getBestPair, pairSummary } from "../risk/dexscreener.js";
import { getTokenSecurity } from "../risk/goplus.js";
import { getDataDir, seedFileIfMissing } from "../dataDir.js";

const filtersPath = path.join(getDataDir(), "filters.json");

// Merged over whatever's persisted — an already-provisioned Railway volume
// has its own filters.json from before any given key existed, and
// seedFileIfMissing only copies the bundled template onto a volume that has
// no file at all yet, so a new key added here would otherwise silently never
// reach a live instance without this merge.
const DEFAULTS = {
  requireRoundTripTaxCheck: true,
  maxLiquidityToMarketCapRatio: 0.6,
};

export function loadFilters() {
  seedFileIfMissing("filters.json");
  const raw = JSON.parse(fs.readFileSync(filtersPath, "utf8"));
  return { ...DEFAULTS, ...raw };
}

export function saveFilters(filters) {
  fs.writeFileSync(filtersPath, JSON.stringify(filters, null, 2));
}

const isTrue = (v) => v === "1" || v === 1 || v === true;

// Cheap, DexScreener-only re-check of liquidity against the same floor
// applyFilter already enforces — used right before a buy executes to catch
// a rug that happened in the gap between the original filter pass and the
// on-chain purchase. Deliberately skips the GoPlus/Etherscan/AI round trip
// that computeRiskScore does — this only needs to answer "is the liquidity
// still there," not re-score the whole token.
export async function checkFreshLiquidity(chain, tokenAddress) {
  const filters = loadFilters();
  const dexPair = await getBestPair(chain.dexscreenerChainId, tokenAddress);
  const pair = pairSummary(dexPair, tokenAddress);
  const liquidityUsd = pair?.liquidityUsd || 0;
  if (liquidityUsd < filters.minLiquidityUsd) {
    return {
      pass: false,
      liquidityUsd,
      reason: `Liquidity dropped to $${liquidityUsd.toFixed(0)} (below $${filters.minLiquidityUsd} minimum) — rug between call and buy`,
    };
  }
  return { pass: true, liquidityUsd };
}

// Re-checks GoPlus's honeypot verdict right before a real buy executes.
// GoPlus can lag behind indexing a brand-new token by anywhere from seconds
// to a couple minutes — the original computeRiskScore pass may have run
// before GoPlus had anything on this token at all (an empty result,
// indistinguishable in the score from "chain not covered"), but by the time
// we're about to spend real money — after AI screens, the Telegram send,
// etc. — GoPlus has often caught up. Confirmed live on SKHYB/BNB Chain:
// GoPlus returned nothing at the original call, but re-querying it minutes
// later showed is_honeypot: true — the correct answer existed, just not yet
// when the bot first asked. Fails open (pass: true) on no data or a lookup
// error — this is a bonus second chance to catch what the first pass
// missed, not a new hard requirement for chains/tokens GoPlus never covers.
export async function checkFreshHoneypotStatus(chain, tokenAddress) {
  try {
    const sec = await getTokenSecurity(chain.goplusChainId, tokenAddress);
    if (sec && isTrue(sec.is_honeypot)) {
      return { pass: false, reason: "GoPlus now flags this token as a honeypot (wasn't indexed yet at the original filter pass)" };
    }
    const sellTax = sec ? Number(sec.sell_tax) || 0 : 0;
    if (sellTax >= 0.5) {
      return { pass: false, reason: `GoPlus now shows sell tax ${(sellTax * 100).toFixed(0)}% (wasn't indexed yet at the original filter pass)` };
    }
    if (sec && isTrue(sec.owner_change_balance)) {
      return { pass: false, reason: "GoPlus now shows the owner can alter holder balances (wasn't indexed yet at the original filter pass)" };
    }
    return { pass: true };
  } catch {
    return { pass: true };
  }
}

// Decides whether a scored token gets "called". Returns { pass, reasons }.
export function applyFilter(riskResult, tokenAgeMinutes) {
  const filters = loadFilters();
  const reasons = [];
  const { security, pair, score, lpLock } = riskResult;

  if (score < filters.minRiskScore) reasons.push(`Risk score ${score} below minimum ${filters.minRiskScore}`);

  if (tokenAgeMinutes != null && tokenAgeMinutes > filters.maxTokenAgeMinutes) {
    reasons.push(`Token age ${tokenAgeMinutes}m exceeds max ${filters.maxTokenAgeMinutes}m`);
  }

  const liq = pair?.liquidityUsd || 0;
  if (liq < filters.minLiquidityUsd) reasons.push(`Liquidity $${liq.toFixed(0)} below minimum $${filters.minLiquidityUsd}`);

  // Ceiling on market cap keeps calls in "still early" territory — a token
  // already past this size has less room left to run. 0/unset = no ceiling.
  const mcap = pair?.marketCapUsd || 0;
  if (filters.maxMarketCapUsd > 0 && mcap > filters.maxMarketCapUsd) {
    reasons.push(`Market cap $${mcap.toFixed(0)} above maximum $${filters.maxMarketCapUsd}`);
  }

  // Floor on market cap — the one lever the preset filters (basic/super
  // basic/super ultra mega) actually tune, based on real historical data:
  // call-time market cap correlated with pump outcome (higher floor → more
  // likely to hit bigger milestones). 0/unset = no floor.
  if (filters.minMarketCapUsd > 0 && mcap < filters.minMarketCapUsd) {
    reasons.push(`Market cap $${mcap.toFixed(0)} below minimum $${filters.minMarketCapUsd}`);
  }

  // Liquidity unusually high relative to market cap — backtested against
  // the 2026-07-14 honeypot batch (5 confirmed honeypots on BSC/Robinhood
  // Chain), where this ratio was the one numeric trait shared across all of
  // them and absent from the confirmed-legit comparison. 0/unset = no cap.
  if (filters.maxLiquidityToMarketCapRatio > 0 && mcap > 0) {
    const liqToMcap = liq / mcap;
    if (liqToMcap > filters.maxLiquidityToMarketCapRatio) {
      reasons.push(
        `Liquidity/market-cap ratio ${liqToMcap.toFixed(2)} above maximum ${filters.maxLiquidityToMarketCapRatio}`
      );
    }
  }

  // Volume is evidence of real trading interest, distinct from liquidity
  // just sitting idle. 0/unset = no minimum.
  const volume24h = pair?.volume24h || 0;
  if (filters.minVolume24hUsd > 0 && volume24h < filters.minVolume24hUsd) {
    reasons.push(`24h volume $${volume24h.toFixed(0)} below minimum $${filters.minVolume24hUsd}`);
  }

  // Ceiling on volume — backtested across 420 historical calls (train/test
  // validated, not just in-sample): unusually high call-time volume relative
  // to a token this new correlates with lower win rate, consistent with
  // wash-traded pump-and-dump activity rather than organic interest.
  // 0/unset = no ceiling.
  if (filters.maxVolume24hUsd > 0 && volume24h > filters.maxVolume24hUsd) {
    reasons.push(`24h volume $${volume24h.toFixed(0)} above maximum $${filters.maxVolume24hUsd}`);
  }

  if (security) {
    const holderCount = Number(security.holder_count) || 0;
    if (holderCount < filters.minHolderCount) reasons.push(`Holder count ${holderCount} below minimum ${filters.minHolderCount}`);

    const top10Pct = (security.holders || []).slice(0, 10).reduce((s, h) => s + (Number(h.percent) || 0), 0) * 100;
    if (top10Pct > filters.maxTop10HolderPercent) reasons.push(`Top 10 holders own ${top10Pct.toFixed(0)}% (max ${filters.maxTop10HolderPercent}%)`);

    const creatorPct = (Number(security.creator_percent) || 0) * 100;
    if (creatorPct > filters.maxCreatorHolderPercent) reasons.push(`Creator holds ${creatorPct.toFixed(0)}% (max ${filters.maxCreatorHolderPercent}%)`);

    if (filters.requireNotHoneypot && isTrue(security.is_honeypot)) reasons.push("Flagged as honeypot");
    // Unconditional, unlike the boolean check above — a reported sell tax
    // this high means a sale returns almost nothing back regardless of
    // whether GoPlus's own is_honeypot heuristic happened to catch it.
    const sellTax = Number(security.sell_tax) || 0;
    if (sellTax >= 0.5) reasons.push(`Sell tax ${(sellTax * 100).toFixed(0)}% — effectively unsellable`);
    // Same tier as the sell-tax check above — this is the exact mechanism
    // that drained the wallet on catnip (arbitrary balance rewrite bypassing
    // Transfer events), so it's unconditional too, not gated by a toggle.
    if (isTrue(security.owner_change_balance)) reasons.push("Owner can directly alter holder balances");
    if (filters.requireOpenSource && !isTrue(security.is_open_source)) reasons.push("Contract not open source");
    if (filters.blockMintable && isTrue(security.is_mintable)) reasons.push("Token supply is mintable");
  }

  // Deliberately outside the `if (security)` block above — GoPlus doesn't
  // cover this chain at all (security is always null here), so nesting this
  // inside that block made it a permanent no-op regardless of the setting.
  // Prefer GoPlus's lp_holders when available (other chains); fall back to
  // the on-chain check (riskScore.js) otherwise.
  if (filters.requireLpLockedOrBurned) {
    const lpHolders = security?.lp_holders || [];
    if (lpHolders.length > 0) {
      const lockedPct = lpHolders.reduce((sum, h) => {
        const locked = isTrue(h.is_locked) || h.tag === "Burn Address";
        return sum + (locked ? Number(h.percent) || 0 : 0);
      }, 0);
      if (lockedPct < 0.5) reasons.push("LP not majority locked/burned");
    } else if (lpLock) {
      if (lpLock.lockedFraction < 0.5) {
        reasons.push(`LP not majority locked/burned (on-chain check: ${(lpLock.lockedFraction * 100).toFixed(0)}% locked)`);
      }
    } else {
      // No length guard here on purpose — treating "no data from either
      // source" as "skip the check" let every fresh launch through
      // regardless of this setting, which is exactly backwards for the
      // freshest (highest-risk) tokens.
      reasons.push("LP lock status unknown (no data available) — treated as unlocked");
    }
  }

  return { pass: reasons.length === 0, reasons, filters };
}
