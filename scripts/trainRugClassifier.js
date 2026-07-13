// Logistic regression trained from scratch (gradient descent, no external
// ML library) — deliberately simple given the dataset size (530 rows) and
// the goal of an advisory signal, not a black-box gate. Keeps the live bot
// pure Node/JS with zero new runtime dependencies (no Python needed to run
// inference in production — only to have written this script, and even
// that wasn't needed).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");

const FEATURE_KEYS = ["launchNativeReserve", "lockedFraction", "hasLpData", "tokenChangeRatio"];
const LEARNING_RATE = 0.1;
const EPOCHS = 2000;
const L2_LAMBDA = 0.01; // small regularization — 530 rows is little enough to overfit fast otherwise

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

// z-score normalize each feature — logistic regression via gradient descent
// converges badly otherwise when features are on wildly different scales
// (launchNativeReserve ranges 0-20+, lockedFraction is 0-1).
function computeNormStats(rows) {
  const stats = {};
  for (const key of FEATURE_KEYS) {
    const values = rows.map((r) => r.features[key]);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    stats[key] = { mean, std: Math.sqrt(variance) || 1 };
  }
  return stats;
}

function normalize(features, stats) {
  return FEATURE_KEYS.map((key) => (features[key] - stats[key].mean) / stats[key].std);
}

function trainLogisticRegression(X, y, epochs, lr, l2) {
  const n = X.length;
  const d = X[0].length;
  let weights = new Array(d).fill(0);
  let bias = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;

    for (let i = 0; i < n; i++) {
      const z = X[i].reduce((sum, x, j) => sum + x * weights[j], bias);
      const pred = sigmoid(z);
      const error = pred - y[i];
      for (let j = 0; j < d; j++) gradW[j] += error * X[i][j];
      gradB += error;
    }

    for (let j = 0; j < d; j++) {
      weights[j] -= lr * (gradW[j] / n + l2 * weights[j]);
    }
    bias -= lr * (gradB / n);
  }

  return { weights, bias };
}

function predict(features, model) {
  const z = features.reduce((sum, x, j) => sum + x * model.weights[j], model.bias);
  return sigmoid(z);
}

function evaluate(X, y, model, label) {
  let correct = 0;
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let i = 0; i < X.length; i++) {
    const prob = predict(X[i], model);
    const pred = prob >= 0.5 ? 1 : 0;
    if (pred === y[i]) correct++;
    if (pred === 1 && y[i] === 1) tp++;
    if (pred === 1 && y[i] === 0) fp++;
    if (pred === 0 && y[i] === 0) tn++;
    if (pred === 0 && y[i] === 1) fn++;
  }
  const accuracy = correct / X.length;
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  console.log(`[${label}] n=${X.length} accuracy=${(accuracy * 100).toFixed(1)}% precision=${precision != null ? (precision * 100).toFixed(1) + "%" : "n/a"} recall=${recall != null ? (recall * 100).toFixed(1) + "%" : "n/a"}`);
  return { accuracy, precision, recall, tp, fp, tn, fn };
}

function main() {
  const { rows } = JSON.parse(fs.readFileSync(path.join(dataDir, "mlTrainingSet.json"), "utf8"));

  // Fixed shuffle seed (simple LCG) so this is reproducible run to run.
  let seed = 42;
  function rand() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  }
  const shuffled = [...rows].sort(() => rand() - 0.5);

  const splitAt = Math.floor(shuffled.length * 0.8);
  const trainRows = shuffled.slice(0, splitAt);
  const testRows = shuffled.slice(splitAt);

  const stats = computeNormStats(trainRows); // normalize using TRAIN stats only — no test leakage
  const Xtrain = trainRows.map((r) => normalize(r.features, stats));
  const ytrain = trainRows.map((r) => r.label);
  const Xtest = testRows.map((r) => normalize(r.features, stats));
  const ytest = testRows.map((r) => r.label);

  console.log(`[train] ${trainRows.length} train rows, ${testRows.length} test rows`);

  const model = trainLogisticRegression(Xtrain, ytrain, EPOCHS, LEARNING_RATE, L2_LAMBDA);

  console.log("\n--- Evaluation ---");
  const trainMetrics = evaluate(Xtrain, ytrain, model, "train");
  const testMetrics = evaluate(Xtest, ytest, model, "test");

  // A model that just always predicts "rugged" (matching the 83.6% base
  // rate) gets ~84% accuracy for free — that's the bar this actually needs
  // to clear to be worth anything over a coin flip weighted by the prior.
  const alwaysRugAccuracy = ytest.filter((y) => y === 1).length / ytest.length;
  console.log(`\n[baseline] always predicting "rugged": ${(alwaysRugAccuracy * 100).toFixed(1)}% accuracy on test set`);

  console.log("\n--- Learned weights (normalized scale) ---");
  FEATURE_KEYS.forEach((key, i) => console.log(`  ${key}: ${model.weights[i].toFixed(3)}`));
  console.log(`  bias: ${model.bias.toFixed(3)}`);

  fs.writeFileSync(
    path.join(dataDir, "rugClassifierModel.json"),
    JSON.stringify(
      {
        trainedAt: Date.now(),
        featureKeys: FEATURE_KEYS,
        normStats: stats,
        weights: model.weights,
        bias: model.bias,
        trainMetrics,
        testMetrics,
        alwaysRugBaselineAccuracy: alwaysRugAccuracy,
      },
      null,
      2
    )
  );
  console.log("\nWrote data/rugClassifierModel.json");
}

main();
