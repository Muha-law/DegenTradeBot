// Merges tonight's two backtest datasets (rugDataset.json — 530 tokens'
// reserve trajectories, lpLockBacktest.json — LP-lock status for 257 of
// them) into a single feature-engineered training set for the rug
// classifier. Label definition matches analyzeRugDataset.js exactly, so
// this stays consistent with everything already reported tonight.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");

const RUG_DRAWDOWN_THRESHOLD = 0.9;
const DUST_NATIVE = 0.0005;

function isRugged(rec) {
  if (rec.launchNativeReserve <= 0) return null;
  if (rec.currentNativeReserve <= DUST_NATIVE) return true;
  const drawdown = (rec.launchNativeReserve - rec.currentNativeReserve) / rec.launchNativeReserve;
  return drawdown >= RUG_DRAWDOWN_THRESHOLD;
}

function main() {
  const rugData = JSON.parse(fs.readFileSync(path.join(dataDir, "rugDataset.json"), "utf8"));
  const lpData = JSON.parse(fs.readFileSync(path.join(dataDir, "lpLockBacktest.json"), "utf8"));

  const lpByToken = new Map(lpData.records.map((r) => [r.tokenAddress.toLowerCase(), r]));

  const rows = [];
  for (const rec of rugData.dataset) {
    const rugged = isRugged(rec);
    if (rugged === null || rec.launchNativeReserve <= 0) continue;

    const lp = lpByToken.get(rec.tokenAddress.toLowerCase());
    const hasLpData = lp != null;
    const lockedFraction = hasLpData ? lp.lockedFraction : 0.5; // neutral impute — see mlRugScore.js for the matching runtime default

    // Activity signal — how much the token-side reserve moved from launch to
    // now, capped so a handful of extreme outliers don't dominate the scale.
    // Same rationale as hadTradingActivity() in analyzeRugDataset.js: a pool
    // that never traded isn't "safe," it's just untested.
    const tokenChangeRatio = rec.launchTokenReserve > 0
      ? Math.min(5, Math.abs(rec.currentTokenReserve - rec.launchTokenReserve) / rec.launchTokenReserve)
      : 0;

    rows.push({
      tokenAddress: rec.tokenAddress,
      symbol: rec.symbol,
      features: {
        launchNativeReserve: rec.launchNativeReserve,
        lockedFraction,
        hasLpData: hasLpData ? 1 : 0,
        tokenChangeRatio,
      },
      label: rugged ? 1 : 0,
    });
  }

  const ruggedCount = rows.filter((r) => r.label === 1).length;
  console.log(`[buildMlDataset] ${rows.length} usable rows, ${ruggedCount} rugged (${((ruggedCount / rows.length) * 100).toFixed(1)}%)`);
  console.log(`[buildMlDataset] ${rows.filter((r) => r.features.hasLpData).length} rows have real LP-lock data (rest imputed at 0.5)`);

  fs.writeFileSync(path.join(dataDir, "mlTrainingSet.json"), JSON.stringify({ builtAt: Date.now(), rows }, null, 2));
  console.log("[buildMlDataset] wrote data/mlTrainingSet.json");
}

main();
