// Reads data/rugDataset.json (produced by collectRugDataset.js) and derives
// rug-rate statistics bucketed by launch liquidity, to sanity-check and
// calibrate the bot's filter thresholds against real historical outcomes
// instead of guessed numbers.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IN_PATH = path.join(__dirname, "..", "data", "rugDataset.json");

// A pair is "rugged" if native-asset reserves collapsed from launch to now —
// currency-agnostic (works regardless of ETH's own price movement over the
// sampling period) and matches what actually hurt real positions tonight
// (pools drained to near-zero between call and check).
const RUG_DRAWDOWN_THRESHOLD = 0.9;
const DUST_NATIVE = 0.0005; // treat anything below this as effectively zero

function isRugged(rec) {
  if (rec.launchNativeReserve <= 0) return null; // no usable launch snapshot
  if (rec.currentNativeReserve <= DUST_NATIVE) return true;
  const drawdown = (rec.launchNativeReserve - rec.currentNativeReserve) / rec.launchNativeReserve;
  return drawdown >= RUG_DRAWDOWN_THRESHOLD;
}

// A pool whose token-side reserve barely moved from launch to now had no
// real trading — its native reserve looking "stable" isn't safety, it's just
// nobody bothered to buy or rug it. Without this, small/dead pools would
// artificially drag down the rug rate for low-liquidity buckets and make
// tiny launches look safer than they are.
function hadTradingActivity(rec) {
  if (!rec.launchTokenReserve || rec.launchTokenReserve <= 0) return false;
  const change = Math.abs(rec.currentTokenReserve - rec.launchTokenReserve) / rec.launchTokenReserve;
  return change > 0.05;
}

function bucketStats(dataset, bucketFn, labels) {
  const buckets = new Map(labels.map((l) => [l, { total: 0, rugged: 0 }]));
  for (const rec of dataset) {
    const rugged = isRugged(rec);
    if (rugged === null) continue;
    const label = bucketFn(rec);
    if (!buckets.has(label)) continue;
    const b = buckets.get(label);
    b.total++;
    if (rugged) b.rugged++;
  }
  return buckets;
}

function printBuckets(title, buckets) {
  console.log(`\n${title}`);
  for (const [label, { total, rugged }] of buckets) {
    const pct = total > 0 ? ((rugged / total) * 100).toFixed(1) : "—";
    console.log(`  ${label.padEnd(20)} n=${String(total).padEnd(6)} rug rate=${pct}%`);
  }
}

function main() {
  const raw = JSON.parse(fs.readFileSync(IN_PATH, "utf8"));
  const dataset = raw.dataset;
  console.log(`Loaded ${dataset.length} records (collected ${new Date(raw.collectedAt).toISOString()})`);

  const usable = dataset.filter((r) => r.launchNativeReserve > 0);
  const ruggedCount = usable.filter((r) => isRugged(r)).length;
  console.log(`\nUsable records (had a readable launch snapshot): ${usable.length}`);
  console.log(`Overall rug rate (>=${RUG_DRAWDOWN_THRESHOLD * 100}% native-reserve drawdown): ${((ruggedCount / usable.length) * 100).toFixed(1)}%`);

  const active = usable.filter(hadTradingActivity);
  const dead = usable.filter((r) => !hadTradingActivity(r));
  console.log(`\nOf those: ${active.length} had real trading activity (token reserve moved >5%), ${dead.length} never traded (token-side reserve essentially untouched)`);
  console.log(`Dead/never-traded pools are NOT safety — they're pools nobody bothered to buy into or rug. Excluding them from the liquidity-bucket analysis below.`);

  const liqBucketFn = (r) => {
    const v = r.launchNativeReserve;
    if (v < 0.5) return "< 0.5 native";
    if (v < 1) return "0.5 - 1";
    if (v < 2) return "1 - 2";
    if (v < 5) return "2 - 5";
    if (v < 10) return "5 - 10";
    return ">= 10";
  };
  const liqLabels = ["< 0.5 native", "0.5 - 1", "1 - 2", "2 - 5", "5 - 10", ">= 10"];

  printBuckets("Rug rate by launch native-side reserve (ALL usable records):", bucketStats(usable, liqBucketFn, liqLabels));
  printBuckets("Rug rate by launch native-side reserve (ACTIVELY TRADED only):", bucketStats(active, liqBucketFn, liqLabels));

  // Distribution shape — useful for picking a threshold that isn't just
  // "always reject" or "never reject" given how skewed this population is.
  const sorted = [...usable].map((r) => r.launchNativeReserve).sort((a, b) => a - b);
  const pct = (p) => sorted[Math.floor(sorted.length * p)];
  console.log(`\nLaunch native-reserve distribution: p10=${pct(0.1)?.toFixed(3)} p25=${pct(0.25)?.toFixed(3)} p50=${pct(0.5)?.toFixed(3)} p75=${pct(0.75)?.toFixed(3)} p90=${pct(0.9)?.toFixed(3)}`);

  fs.writeFileSync(
    path.join(__dirname, "..", "data", "rugDatasetAnalysis.json"),
    JSON.stringify(
      {
        analyzedAt: Date.now(),
        totalUsable: usable.length,
        activeCount: active.length,
        deadCount: dead.length,
        overallRugRatePct: (ruggedCount / usable.length) * 100,
        liquidityBucketsAll: Object.fromEntries(bucketStats(usable, liqBucketFn, liqLabels)),
        liquidityBucketsActiveOnly: Object.fromEntries(bucketStats(active, liqBucketFn, liqLabels)),
      },
      null,
      2
    )
  );
  console.log("\nWrote data/rugDatasetAnalysis.json");
}

main();
