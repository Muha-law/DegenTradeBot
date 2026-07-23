import { getTokenSecurity } from "./goplus.js";
import { getBestPair, pairSummary } from "./dexscreener.js";
import { getContractCreator, getDeployerTxCount } from "./explorer.js";
import { getDeployerHistory } from "../store/db.js";
import { checkLpLock } from "./lpLock.js";
import { detectDangerousFunctions } from "./dangerousFunctions.js";

const WEIGHTS = {
  contractSafety: 35,
  liquidityLock: 25,
  holderDistribution: 20,
  deployerHistory: 20,
};

// When a data source has nothing for us, score it as a mild risk rather
// than a coin-flip "average" — missing verification isn't reassuring.
const NO_DATA_FACTOR = 0.3;

const isTrue = (v) => v === "1" || v === 1 || v === true;

function scoreContractSafety(sec, flags) {
  if (!sec) return { points: WEIGHTS.contractSafety * NO_DATA_FACTOR, fatal: false };

  if (isTrue(sec.is_honeypot)) {
    flags.push("🚨 Honeypot detected (cannot sell) — score forced to 0");
    return { points: 0, fatal: true };
  }

  // A token can pass is_honeypot (a boolean heuristic GoPlus itself computes)
  // while its own reported sell_tax says a sale returns almost nothing —
  // functionally identical to a honeypot regardless of what the boolean
  // says. Confirmed real motivation: MNEMO/Robinhood — a third-party bot's
  // own buy/sell simulation printed "Tax: S 100%" and flagged it as a
  // honeypot; a sell tax at that level is a honeypot by definition, no
  // heuristic needed.
  const earlySellTax = Number(sec.sell_tax) || 0;
  if (earlySellTax >= 0.5) {
    flags.push(`🚨 Sell tax ${(earlySellTax * 100).toFixed(0)}% — effectively unsellable, treated as honeypot`);
    return { points: 0, fatal: true };
  }

  // Owner can rewrite a holder's balance directly — a different mechanism
  // from a transfer-block or a tax, but the same outcome: your balance can
  // be zeroed at will regardless of what any sell simulation shows.
  // Confirmed real motivation: this is exactly how catnip drained the
  // wallet earlier in production — a non-standard balance-manipulation
  // function that bypasses Transfer events entirely, so neither a block
  // explorer nor a sell simulation ever sees it happen. GoPlus already
  // flags this; we just weren't reading the field.
  if (isTrue(sec.owner_change_balance)) {
    flags.push("🚨 Owner can directly alter holder balances — score forced to 0");
    return { points: 0, fatal: true };
  }

  let points = WEIGHTS.contractSafety;
  const deduct = (amount, flag) => {
    points -= amount;
    flags.push(flag);
  };

  if (!isTrue(sec.is_open_source)) deduct(10, "Contract not open source / verified");
  if (isTrue(sec.is_proxy)) deduct(7, "Upgradeable proxy contract");
  if (isTrue(sec.is_mintable)) deduct(8, "Supply is mintable");
  if (isTrue(sec.hidden_owner)) deduct(8, "Hidden owner detected");
  if (isTrue(sec.can_take_back_ownership)) deduct(8, "Ownership can be reclaimed");
  if (isTrue(sec.selfdestruct)) deduct(8, "Selfdestruct function present");
  if (isTrue(sec.cannot_sell_all)) deduct(6, "Cannot sell full balance");
  if (isTrue(sec.is_blacklisted)) deduct(7, "Blacklist function present");
  if (isTrue(sec.trading_cooldown)) deduct(4, "Trading cooldown function present");
  if (isTrue(sec.slippage_modifiable) || isTrue(sec.personal_slippage_modifiable))
    deduct(4, "Slippage/tax can be modified by owner");

  const buyTax = Number(sec.buy_tax) || 0;
  const sellTax = Number(sec.sell_tax) || 0;
  if (buyTax > 0.1 || sellTax > 0.1) deduct(6, `High tax (buy ${(buyTax * 100).toFixed(0)}% / sell ${(sellTax * 100).toFixed(0)}%)`);

  return { points: Math.max(0, points), fatal: false };
}

function scoreLiquidityLock(sec, pair, lpLock, flags) {
  let points = 0;
  const liq = pair?.liquidityUsd || 0;

  if (liq >= 50000) points += 12;
  else if (liq >= 20000) points += 9;
  else if (liq >= 5000) points += 5;
  else if (liq > 0) points += 1;
  else flags.push("No liquidity data found yet");

  const mcap = pair?.marketCapUsd || 0;
  if (mcap > 0 && liq > 0) {
    const ratio = liq / mcap;
    if (ratio >= 0.15) points += 5;
    else if (ratio >= 0.05) points += 3;
    else flags.push("Liquidity is thin relative to market cap");
  }

  const lpHolders = sec?.lp_holders || [];
  if (lpHolders.length > 0) {
    const lockedPct = lpHolders.reduce((sum, h) => {
      const isLockedOrBurned = isTrue(h.is_locked) || h.tag === "Burn Address" || h.address?.toLowerCase().startsWith("0x000000000000000000000000000000000000dead");
      return sum + (isLockedOrBurned ? Number(h.percent) || 0 : 0);
    }, 0);
    if (lockedPct >= 0.8) points += 8;
    else if (lockedPct >= 0.4) points += 4;
    else flags.push("LP largely unlocked/unburned");
  } else if (lpLock) {
    // GoPlus doesn't cover this chain (lp_holders is always empty here) — an
    // on-chain check of the pair contract's own LP-token balances (it IS the
    // ERC20 LP token) stands in instead. Validated against 257 historical
    // Robinhood Chain pairs: locked-at-launch tokens rugged 70.4% of the time
    // vs 88.2% unlocked — real signal, sized accordingly (not a pass/fail
    // guarantee, which is why it's a modest point swing, not the whole
    // category).
    if (lpLock.lockedFraction >= 0.8) points += 8;
    else if (lpLock.lockedFraction >= 0.4) points += 4;
    else flags.push("LP not locked/burned (on-chain check)");
  } else {
    // No LP data available from either source — common for very fresh
    // tokens, and exactly where an unlocked LP is most dangerous. Treated as
    // a missing-data risk like everywhere else in this file (no bonus).
    flags.push("LP lock status unavailable");
  }

  return Math.min(WEIGHTS.liquidityLock, points);
}

function scoreHolderDistribution(sec, flags) {
  if (!sec) return WEIGHTS.holderDistribution * NO_DATA_FACTOR;

  let points = 0;
  const holderCount = Number(sec.holder_count) || 0;
  if (holderCount >= 200) points += 8;
  else if (holderCount >= 50) points += 5;
  else if (holderCount >= 20) points += 2;
  else flags.push(`Only ${holderCount} holders`);

  const holders = sec.holders || [];
  const top10Pct = holders.slice(0, 10).reduce((sum, h) => sum + (Number(h.percent) || 0), 0);
  if (top10Pct <= 0.3) points += 7;
  else if (top10Pct <= 0.5) points += 4;
  else flags.push(`Top 10 holders own ${(top10Pct * 100).toFixed(0)}% of supply`);

  const creatorPct = Number(sec.creator_percent) || 0;
  if (creatorPct <= 0.02) points += 5;
  else if (creatorPct <= 0.1) points += 2;
  else flags.push(`Creator wallet holds ${(creatorPct * 100).toFixed(0)}% of supply`);

  return Math.min(WEIGHTS.holderDistribution, points);
}

async function scoreDeployerHistory(chain, tokenAddress, flags) {
  const creation = await getContractCreator(chain, tokenAddress).catch(() => ({
    ok: false,
    reason: "error",
  }));

  if (!creation.ok) {
    if (creation.reason === "unsupported_chain") {
      flags.push("Deployer history unavailable (chain not covered by Etherscan or Blockscout)");
    } else if (creation.reason !== "no_api_key") {
      flags.push("Deployer history unavailable");
    }
    return { points: WEIGHTS.deployerHistory * NO_DATA_FACTOR, deployerAddress: null };
  }

  const localHistory = getDeployerHistory(creation.deployerAddress);
  let points = WEIGHTS.deployerHistory;

  if (localHistory && localHistory.tokens_deployed > 0) {
    const badRatio = localHistory.low_score_count / localHistory.tokens_deployed;
    if (badRatio > 0.5) {
      points = 2;
      flags.push(`Deployer has ${localHistory.low_score_count}/${localHistory.tokens_deployed} prior low-risk-score tokens`);
    } else if (badRatio > 0.2) {
      points -= 10;
      flags.push("Deployer has some prior low-scoring tokens");
    }
  }

  const chainStats = await getDeployerTxCount(chain, creation.deployerAddress).catch(() => null);
  if (chainStats && chainStats.contractCreations > 15) {
    points -= 6;
    flags.push(`Deployer has created ${chainStats.contractCreations} contracts (serial deployer)`);
  }

  return { points: Math.max(0, points), deployerAddress: creation.deployerAddress };
}

// Informational only — unlike everything else in this file, these aren't
// backtested against real outcomes yet (no equivalent of the 257-pair
// LP-lock backtest or the 420-call volume-ceiling backtest behind it), so
// they never touch the score or gate a call. They just ride along in the
// same flags list scoreContractSafety/scoreLiquidityLock/etc. already
// populate, for a human to weigh. Mirrors WatchTower's own "Social Threat
// Radar" module, built on the same DexScreener response we already fetch
// for liquidity/mcap — no extra API call.
function scoreSocialSignals(pair, flags) {
  if (!pair) return;

  if (pair.hasSocials === false) {
    flags.push("No social links or website found on DexScreener");
  }

  if (pair.buys24h != null && pair.sells24h != null && pair.buys24h + pair.sells24h > 0) {
    if (pair.sells24h > 0) {
      const buySellRatio = pair.buys24h / pair.sells24h;
      if (buySellRatio < 0.5) {
        flags.push(`Heavy sell pressure (24h) — ${pair.buys24h} buys / ${pair.sells24h} sells`);
      }
    }
  }

  if (pair.priceChange24h != null) {
    const ageHours = pair.createdAt ? (Date.now() - pair.createdAt) / 3600000 : Infinity;
    if (pair.priceChange24h <= -50) {
      flags.push(`⚠️ Price down ${pair.priceChange24h.toFixed(0)}% in 24h — possible dump already in progress`);
    } else if (pair.priceChange24h >= 500 && ageHours < 48) {
      flags.push(`⚠️ Price up ${pair.priceChange24h.toFixed(0)}% in 24h on a token this new — pump-and-dump risk`);
    }
  }
}

function gradeFor(score) {
  if (score >= 80) return { grade: "A", label: "Very Low Risk" };
  if (score >= 60) return { grade: "B", label: "Low Risk" };
  if (score >= 40) return { grade: "C", label: "Medium Risk" };
  if (score >= 20) return { grade: "D", label: "High Risk" };
  return { grade: "F", label: "Extreme Risk — likely scam" };
}

export async function computeRiskScore(chain, tokenAddress) {
  const flags = [];

  let goplusUnsupported = false;
  const [security, dexPair] = await Promise.all([
    getTokenSecurity(chain.goplusChainId, tokenAddress).catch((err) => {
      // GoPlus returns code 2022 "The main chain is not supported" for
      // chains it hasn't onboarded (confirmed: Robinhood Chain isn't in
      // /supported_chains at all) — distinct from a transient API error,
      // and worth surfacing since it means contract-safety/holder/LP-lock
      // scoring below is running on zero real data for this chain, not
      // just this one token.
      if (/not supported/i.test(err.message)) goplusUnsupported = true;
      return null;
    }),
    getBestPair(chain.dexscreenerChainId, tokenAddress).catch(() => null),
  ]);
  if (goplusUnsupported) {
    flags.push("⚠️ GoPlus doesn't cover this chain — contract safety, holder, and LP-lock checks are all running blind");
  }
  const pair = pairSummary(dexPair, tokenAddress);

  // marketCap/fdv from DexScreener only apply when our token is the pair's
  // base side; derive it ourselves from GoPlus total supply otherwise.
  if (pair && !pair.marketCapUsd && security?.total_supply) {
    pair.marketCapUsd = pair.priceUsd * Number(security.total_supply);
  }

  const name = security?.token_name || pair?.name || null;
  const symbol = security?.token_symbol || pair?.symbol || null;

  // Only worth the RPC round trip when GoPlus has nothing (the Robinhood
  // Chain case) — when GoPlus data exists, scoreLiquidityLock already uses
  // it and never looks at lpLock.
  const needsOnChainLpCheck = (!security || (security.lp_holders || []).length === 0) && pair?.pairAddress;
  const lpLock = needsOnChainLpCheck ? await checkLpLock(chain, pair.pairAddress) : null;

  const { points: contractSafety, fatal } = scoreContractSafety(security, flags);
  const liquidityLock = scoreLiquidityLock(security, pair, lpLock, flags);
  const holderDistribution = scoreHolderDistribution(security, flags);
  const { points: deployerHistory, deployerAddress } = await scoreDeployerHistory(chain, tokenAddress, flags);
  scoreSocialSignals(pair, flags);

  // Self-hosted, chain-independent (works regardless of GoPlus coverage) —
  // see dangerousFunctions.js. Confiscation-tier functions have no
  // legitimate reason to exist in a token contract, so a match is fatal
  // the same way is_honeypot is, independent of whether it's ever misfired
  // in testing — the absence of a hit so far reflects the small validation
  // sample, not the rule being wrong. Switch-tier (blacklist/trading-toggle)
  // is common enough in benign anti-snipe launches that it stays
  // informational only, same as the social signals above.
  const dangerousFunctions = await detectDangerousFunctions(chain, tokenAddress).catch((err) => {
    console.error(`[riskScore] dangerous-function check failed for ${tokenAddress}:`, err.message);
    return { confiscationFunctions: [], switchFunctions: [] };
  });
  if (dangerousFunctions.confiscationFunctions.length > 0) {
    flags.push(`🚨 Contract exposes an arbitrary balance-manipulation function (${dangerousFunctions.confiscationFunctions.join(", ")}) — score forced to 0`);
  }
  if (dangerousFunctions.switchFunctions.length > 0) {
    flags.push(`⚠️ Contract has a trading-restriction switch (${dangerousFunctions.switchFunctions.join(", ")}) — can be flipped after launch`);
  }

  // A honeypot means nothing else matters — you can't sell no matter how
  // good liquidity/holders/deployer history look.
  const fatalOverall = fatal || dangerousFunctions.confiscationFunctions.length > 0;
  const total = fatalOverall ? 0 : Math.round(contractSafety + liquidityLock + holderDistribution + deployerHistory);
  const { grade, label } = gradeFor(total);

  return {
    score: total,
    grade,
    label,
    breakdown: {
      contractSafety: Math.round(contractSafety),
      liquidityLock: Math.round(liquidityLock),
      holderDistribution: Math.round(holderDistribution),
      deployerHistory: Math.round(deployerHistory),
    },
    flags,
    dangerousFunctions,
    name,
    symbol,
    security,
    pair,
    lpLock,
    deployerAddress,
  };
}
