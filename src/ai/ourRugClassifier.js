import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A logistic regression trained on OUR OWN 110 closed paper trades (not
// borrowed from the upstream repo — see rugClassifier.js for that one).
// Label: exit_reason === "stale_price" (liquidity dropped to dust or the
// price feed died for 30+ sustained minutes — our own dead-pool/rug
// detector, see paperTrading.js). Cross-validated AUC 0.951 (5-fold x 20
// repeats), chronological held-out AUC 0.926 (train on the older 70% of
// calls by entry_at, test on strictly newer ones — the harder, honest test,
// same methodology upstream used for its own 0.857). Both meaningfully
// beat the ported upstream model's 0.702 AUC on this exact same dataset —
// expected, since this one is actually calibrated to our token population,
// not someone else's.
//
// Caveat that matters more than the AUC number: n=110, all from a ~4-day
// window (2026-07-11 to 2026-07-15). A high, temporally-validated AUC on a
// short window is real evidence, but it isn't proof this holds up for
// months — token launch patterns, deployer behavior, and our own filter
// settings all shift over time, none of which this model can see. Retrain
// as more calls close (scripts/trainRugModel.py + extractRugTrainingData.mjs
// alongside this file) rather than treating this as a one-time artifact.
const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, "ourRugModelArtifact.json"), "utf8"));

function oneHot(value, prefix, knownValues) {
  const out = {};
  for (const v of knownValues) out[`${prefix}_${v}`] = value === v ? 1 : 0;
  return out;
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

// Returns { rugProbability, crossValidatedAuc } — rugProbability in [0,1].
// chain outside the training set (currently only bsc/robinhood) falls back
// to all-zero one-hot encoding rather than a hard failure.
export function scoreOwnRugProbability({ liquidityUsd, volume24hUsd, marketCapUsd, riskScore, chain }) {
  const liq = liquidityUsd ?? 0;
  const vol = volume24hUsd ?? 0;
  const mc = marketCapUsd ?? 0;
  const volLiqRatio = liq > 0 ? vol / liq : artifact.volLiqRatioMedianFallback;

  const chainKey = artifact.categoricalValues.chain.includes(chain) ? chain : null;

  const raw = {
    liq,
    vol,
    mc,
    vol_liq_ratio: volLiqRatio,
    risk_score: riskScore ?? 0,
    ...oneHot(chainKey, "chain", artifact.categoricalValues.chain),
  };

  let z = artifact.intercept;
  artifact.featureOrder.forEach((feature, i) => {
    const standardized = (raw[feature] - artifact.scalerMean[i]) / artifact.scalerScale[i];
    z += standardized * artifact.coefficients[i];
  });

  return { rugProbability: sigmoid(z), crossValidatedAuc: artifact.crossValidatedAuc };
}
