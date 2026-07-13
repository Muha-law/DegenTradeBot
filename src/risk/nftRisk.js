import { getNftSecurity } from "./goplus.js";
import { getContract, getCollection, getCollectionStats } from "./opensea.js";
import { getContractCreator, getDeployerTxCount } from "./explorer.js";
import { getDeployerHistory } from "../store/db.js";

// Same weighting shape as risk/riskScore.js (token side) — contract safety
// carries the most weight, deployer history the least directly-observable
// signal. "Liquidity & lock" becomes "marketplace liquidity" here (floor
// price / volume / OpenSea verification status stand in for DEX liquidity,
// since there's no LP to lock for an NFT collection).
const WEIGHTS = {
  contractSafety: 35,
  marketplaceLiquidity: 25,
  holderDistribution: 20,
  deployerHistory: 20,
};

const NO_DATA_FACTOR = 0.3;

const isTrue = (v) => v === "1" || v === 1 || v === true;

function scoreContractSafety(sec, flags) {
  if (!sec) return { points: WEIGHTS.contractSafety * NO_DATA_FACTOR, fatal: false };

  if (isTrue(sec.malicious_nft_contract)) {
    flags.push("🚨 Flagged as a malicious contract — score forced to 0");
    return { points: 0, fatal: true };
  }

  let points = WEIGHTS.contractSafety;
  const deduct = (amount, flag) => {
    points -= amount;
    flags.push(flag);
  };

  if (!isTrue(sec.nft_open_source)) deduct(10, "Contract not open source / verified");
  if (isTrue(sec.nft_proxy)) deduct(7, "Upgradeable proxy contract");
  if (!isTrue(sec.nft_verified) && sec.nft_verified != null) deduct(6, "Contract not marked verified by GoPlus");

  return { points: Math.max(0, points), fatal: false };
}

function scoreMarketplaceLiquidity(collection, stats, flags) {
  let points = 0;

  const status = collection?.safelistStatus || "not_requested";
  if (status === "verified") points += 10;
  else if (status === "approved") points += 6;
  else if (status === "requested") points += 2;
  else flags.push("Not verified/approved on OpenSea");

  const floor = stats?.floorPriceEth || 0;
  if (floor >= 1) points += 8;
  else if (floor >= 0.1) points += 5;
  else if (floor > 0) points += 2;
  else flags.push("No floor price yet (no active listings)");

  const vol24h = stats?.volume24hEth || 0;
  if (vol24h >= 5) points += 7;
  else if (vol24h >= 1) points += 4;
  else if (vol24h > 0) points += 1;
  else flags.push("No 24h trading volume");

  return Math.min(WEIGHTS.marketplaceLiquidity, points);
}

function scoreHolderDistribution(stats, totalSupply, flags) {
  if (!stats || stats.numOwners == null || !totalSupply) return WEIGHTS.holderDistribution * NO_DATA_FACTOR;

  let points = 0;
  const ratio = stats.numOwners / totalSupply;
  if (ratio >= 0.6) points += 12;
  else if (ratio >= 0.3) points += 7;
  else if (ratio >= 0.1) points += 3;
  else flags.push(`Highly concentrated ownership (${stats.numOwners} owners / ${totalSupply} supply)`);

  if (stats.numOwners >= 500) points += 8;
  else if (stats.numOwners >= 100) points += 5;
  else if (stats.numOwners >= 20) points += 2;
  else flags.push(`Only ${stats.numOwners} owners`);

  return Math.min(WEIGHTS.holderDistribution, points);
}

// Identical logic to riskScore.js's scoreDeployerHistory — deliberately
// duplicated rather than shared, matching this codebase's existing pattern
// of parallel token/NFT (and paper/real trading) modules that stay
// independently readable rather than sharing a common helper.
async function scoreDeployerHistory(chain, contractAddress, flags) {
  const creation = await getContractCreator(chain, contractAddress).catch(() => ({
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
      flags.push(`Deployer has ${localHistory.low_score_count}/${localHistory.tokens_deployed} prior low-risk-score contracts`);
    } else if (badRatio > 0.2) {
      points -= 10;
      flags.push("Deployer has some prior low-scoring contracts");
    }
  }

  const chainStats = await getDeployerTxCount(chain, creation.deployerAddress).catch(() => null);
  if (chainStats && chainStats.contractCreations > 15) {
    points -= 6;
    flags.push(`Deployer has created ${chainStats.contractCreations} contracts (serial deployer)`);
  }

  return { points: Math.max(0, points), deployerAddress: creation.deployerAddress };
}

function gradeFor(score) {
  if (score >= 80) return { grade: "A", label: "Very Low Risk" };
  if (score >= 60) return { grade: "B", label: "Low Risk" };
  if (score >= 40) return { grade: "C", label: "Medium Risk" };
  if (score >= 20) return { grade: "D", label: "High Risk" };
  return { grade: "F", label: "Extreme Risk — likely scam" };
}

// chain must carry goplusChainId/etherscanChainId like the token-side chain
// objects — NFT support currently covers Base and Robinhood Chain (see
// nftChains.js), fully chain-parameterized the same way riskScore.js is.
// Note: GoPlus doesn't cover Robinhood Chain at all (confirmed in
// riskScore.js's goplusUnsupported handling) — nft_security calls there
// fail closed to null and this degrades to NO_DATA_FACTOR automatically.
export async function computeNftRiskScore(chain, contractAddress) {
  const flags = [];

  const contractInfo = await getContract(chain.key, contractAddress).catch(() => null);
  const slug = contractInfo?.slug || null;
  if (!slug) flags.push("⚠️ Could not resolve an OpenSea collection for this contract — marketplace data unavailable");

  const [security, collection] = await Promise.all([
    getNftSecurity(chain.goplusChainId, contractAddress).catch(() => null),
    slug ? getCollection(slug).catch(() => null) : null,
  ]);
  const stats = slug ? await getCollectionStats(slug).catch(() => null) : null;

  const name = collection?.name || contractInfo?.name || null;
  const totalSupply = collection?.totalSupply ?? null;

  const { points: contractSafety, fatal } = scoreContractSafety(security, flags);
  const marketplaceLiquidity = scoreMarketplaceLiquidity(collection, stats, flags);
  const holderDistribution = scoreHolderDistribution(stats, totalSupply, flags);
  const { points: deployerHistory, deployerAddress } = await scoreDeployerHistory(chain, contractAddress, flags);

  const total = fatal ? 0 : Math.round(contractSafety + marketplaceLiquidity + holderDistribution + deployerHistory);
  const { grade, label } = gradeFor(total);

  return {
    score: total,
    grade,
    label,
    breakdown: {
      contractSafety: Math.round(contractSafety),
      marketplaceLiquidity: Math.round(marketplaceLiquidity),
      holderDistribution: Math.round(holderDistribution),
      deployerHistory: Math.round(deployerHistory),
    },
    flags,
    name,
    slug,
    imageUrl: collection?.imageUrl || null,
    totalSupply,
    security,
    collection,
    stats,
    deployerAddress,
  };
}
