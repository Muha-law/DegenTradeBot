import fs from "node:fs";
import path from "node:path";
import { getCollectionStats } from "../risk/opensea.js";
import { getDataDir, seedFileIfMissing } from "../dataDir.js";
import { getWalletTrackRecord } from "../store/db.js";

const filtersPath = path.join(getDataDir(), "nftFilters.json");

export function loadNftFilters() {
  seedFileIfMissing("nftFilters.json");
  return JSON.parse(fs.readFileSync(filtersPath, "utf8"));
}

export function saveNftFilters(filters) {
  fs.writeFileSync(filtersPath, JSON.stringify(filters, null, 2));
}

const isTrue = (v) => v === "1" || v === 1 || v === true;

// Cheap re-check of floor price right before a buy executes — same role as
// filters/filter.js's checkFreshLiquidity, catching a floor collapse in the
// gap between the original filter pass and the on-chain purchase.
export async function checkFreshFloorPrice(slug) {
  const filters = loadNftFilters();
  const stats = await getCollectionStats(slug).catch(() => null);
  const floorPriceEth = stats?.floorPriceEth || 0;
  if (filters.maxFloorPriceEth > 0 && floorPriceEth > filters.maxFloorPriceEth) {
    return {
      pass: false,
      floorPriceEth,
      reason: `Floor price jumped to ${floorPriceEth} ETH (above ${filters.maxFloorPriceEth} ETH maximum) since the call`,
    };
  }
  return { pass: true, floorPriceEth };
}

// Decides whether a scored NFT collection gets "called". Returns { pass, reasons }.
//
// Unlike the token filter, this is source-aware: a `new_collection` call
// fires the moment OpenSea indexes a freshly deployed collection, which
// structurally means there's often no secondary-market activity yet (still
// minting) — gating on floor price/volume there doesn't measure risk, it
// just measures "hasn't started trading," and would silently block every
// new-collection call forever the moment someone tightens minFloorPriceEth
// above its 0 default. A `copy_trade` call, by contrast, only ever fires
// because a listing existed and got bought, so a real market is already
// there and those checks are meaningful. Ownership/verification/risk-score
// checks come from mint/deploy-time data either way, so those stay
// unconditional.
export function applyNftFilter(riskResult, { source, triggerBuyPriceEth, triggerWalletAddress } = {}) {
  const filters = loadNftFilters();
  const reasons = [];
  const { security, stats, collection, totalSupply, score } = riskResult;

  if (score < filters.minRiskScore) reasons.push(`Risk score ${score} below minimum ${filters.minRiskScore}`);

  if (source !== "new_collection") {
    const floor = stats?.floorPriceEth || 0;
    if (floor < filters.minFloorPriceEth) reasons.push(`Floor price ${floor} ETH below minimum ${filters.minFloorPriceEth} ETH`);
    if (filters.maxFloorPriceEth > 0 && floor > filters.maxFloorPriceEth) {
      reasons.push(`Floor price ${floor} ETH above maximum ${filters.maxFloorPriceEth} ETH`);
    }

    const vol24h = stats?.volume24hEth || 0;
    if (filters.minVolume24hEth > 0 && vol24h < filters.minVolume24hEth) {
      reasons.push(`24h volume ${vol24h} ETH below minimum ${filters.minVolume24hEth} ETH`);
    }
  }

  // Copy-trade-specific quality gate — a wallet buying a near-zero-value
  // item isn't much of a conviction signal. No token-side equivalent (yet):
  // token calls only ever have one trigger source.
  if (source === "copy_trade" && filters.minCopyTradeBuyEth > 0 && triggerBuyPriceEth != null) {
    if (triggerBuyPriceEth < filters.minCopyTradeBuyEth) {
      reasons.push(`Copy-trade buy-in ${triggerBuyPriceEth} ETH below minimum ${filters.minCopyTradeBuyEth} ETH — too small to treat as a signal`);
    }
  }

  // Wallet track-record gate — only meaningful once a wallet has enough
  // *resolved* signals (see nftOutcomeTracker.js) to say anything; a wallet
  // with fewer than minWalletSignals passes through untouched rather than
  // being auto-rejected for having no history yet — the whole point of
  // tracking is to let a new wallet earn a track record, not lock it out
  // before it can build one. Both fields default to 0 (no-op) since there's
  // no history to gate on until the tracker has run for a while.
  if (source === "copy_trade" && triggerWalletAddress && (filters.minWalletSignals > 0 || filters.minWalletWinRatePercent > 0)) {
    const record = getWalletTrackRecord(triggerWalletAddress);
    // A wallet with zero resolved signals always passes — it hasn't had the
    // chance to build a record yet, and judging it as "0% win rate" would
    // block every newly-added wallet forever the moment
    // minWalletWinRatePercent is set (signals >= 0 is vacuously true under
    // the default minWalletSignals of 0, which is exactly how the earlier
    // version of this gate misfired).
    if (record.signals > 0 && record.signals >= filters.minWalletSignals) {
      const winRatePct = (record.winRate ?? 0) * 100;
      if (winRatePct < filters.minWalletWinRatePercent) {
        reasons.push(`Wallet's copy-trade win rate ${winRatePct.toFixed(0)}% below minimum ${filters.minWalletWinRatePercent}% (${record.signals} tracked signals)`);
      }
    }
  }

  const numOwners = stats?.numOwners ?? 0;
  if (numOwners < filters.minOwnerCount) reasons.push(`Owner count ${numOwners} below minimum ${filters.minOwnerCount}`);

  if (stats?.numOwners != null && totalSupply) {
    const concentrationPct = (1 - stats.numOwners / totalSupply) * 100;
    if (concentrationPct > filters.maxOwnerConcentrationPercent) {
      reasons.push(`Ownership concentration ${concentrationPct.toFixed(0)}% above maximum ${filters.maxOwnerConcentrationPercent}%`);
    }
  }

  if (filters.requireSafelistedOrVerified) {
    const status = collection?.safelistStatus || "not_requested";
    if (status !== "verified" && status !== "approved") reasons.push(`Not verified/approved on OpenSea (status: ${status})`);
  }

  if (filters.blockMalicious && security && isTrue(security.malicious_nft_contract)) {
    reasons.push("Flagged as malicious contract");
  }

  return { pass: reasons.length === 0, reasons, filters };
}
