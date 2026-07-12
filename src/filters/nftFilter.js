import fs from "node:fs";
import path from "node:path";
import { getCollectionStats } from "../risk/opensea.js";
import { getDataDir, seedFileIfMissing } from "../dataDir.js";

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
export function applyNftFilter(riskResult) {
  const filters = loadNftFilters();
  const reasons = [];
  const { security, stats, collection, totalSupply, score } = riskResult;

  if (score < filters.minRiskScore) reasons.push(`Risk score ${score} below minimum ${filters.minRiskScore}`);

  const floor = stats?.floorPriceEth || 0;
  if (floor < filters.minFloorPriceEth) reasons.push(`Floor price ${floor} ETH below minimum ${filters.minFloorPriceEth} ETH`);
  if (filters.maxFloorPriceEth > 0 && floor > filters.maxFloorPriceEth) {
    reasons.push(`Floor price ${floor} ETH above maximum ${filters.maxFloorPriceEth} ETH`);
  }

  const vol24h = stats?.volume24hEth || 0;
  if (filters.minVolume24hEth > 0 && vol24h < filters.minVolume24hEth) {
    reasons.push(`24h volume ${vol24h} ETH below minimum ${filters.minVolume24hEth} ETH`);
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
