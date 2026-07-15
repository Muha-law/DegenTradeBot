import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A logistic regression trained on 406 closed historical trades (call-time
// features only — nothing this couldn't know before ever calling a token),
// cross-validated AUC 0.87-0.91 across three model types, chronological
// held-out test AUC 0.857 (train on older calls, test on strictly newer
// ones — the honest test for "would this have worked going forward").
// Logistic regression specifically chosen for deployment over the slightly
// stronger tree-based models (Random Forest cross-val AUC 0.91) because a
// coefficient dot-product ports directly to JS with no runtime dependency,
// versus needing to either port full tree structures or run a Python
// service alongside the bot for a marginal accuracy gain.
//
// Re-train with scripts kept alongside this artifact (not in this repo) any
// time the dataset materially grows — this is a static snapshot, not a
// model that updates itself.
const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, "rugModelArtifact.json"), "utf8"));

function oneHot(value, prefix, knownValues) {
  const out = {};
  for (const v of knownValues) out[`${prefix}_${v}`] = value === v ? 1 : 0;
  return out;
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

// Returns { rugProbability, flags } — rugProbability in [0,1]. Higher =
// more likely to end in a rug_writeoff based on the training data's
// definition of "rug" (price became unfetchable/unsellable). Does NOT
// distinguish honeypot-from-day-1 vs liquidity-pulled-later; the training
// label doesn't currently make that distinction either (see the earlier
// data-quality note this was built from).
export function scoreRugProbability({ liquidityUsd, volume24hUsd, marketCapUsd, riskScore, chain, launchSource }) {
  const liq = liquidityUsd ?? 0;
  const vol = volume24hUsd ?? 0;
  const mc = marketCapUsd ?? 0;
  const volLiqRatio = liq > 0 ? vol / liq : artifact.volLiqRatioMedianFallback;

  const chainKey = artifact.categoricalValues.chain.includes(chain) ? chain : null;
  const sourceKey = artifact.categoricalValues.launch_source.includes(launchSource) ? launchSource : "unknown";

  const raw = {
    liq,
    vol,
    mc,
    vol_liq_ratio: volLiqRatio,
    risk_score: riskScore ?? 0,
    ...oneHot(chainKey, "chain", artifact.categoricalValues.chain),
    ...oneHot(sourceKey, "launch_source", artifact.categoricalValues.launch_source),
  };

  let z = artifact.intercept;
  artifact.featureOrder.forEach((feature, i) => {
    const standardized = (raw[feature] - artifact.scalerMean[i]) / artifact.scalerScale[i];
    z += standardized * artifact.coefficients[i];
  });

  return { rugProbability: sigmoid(z), modelTestAuc: artifact.chronologicalTestAuc };
}
