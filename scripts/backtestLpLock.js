// Reads data/rugDataset.json (530 historical V2 pairs with known rug/survive
// outcomes) and tests whether LP-token lock status shortly after launch
// actually predicts survival. A Uniswap V2 pair contract IS the LP token
// (standard ERC20) — no GoPlus/external API needed, just totalSupply() and
// balanceOf() on well-known burn/zero addresses, queried at the same
// archive-safe block range already validated by collectRugDataset.js.
//
// Run: node scripts/backtestLpLock.js
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IN_PATH = path.join(__dirname, "..", "data", "rugDataset.json");
const OUT_PATH = path.join(__dirname, "..", "data", "lpLockBacktest.json");

const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const LAUNCH_CHECK_OFFSET = 1000; // blocks after creation — "what the bot would've seen at buy time"
const CONCURRENCY = 5;
const RETRY_ATTEMPTS = 4;

const RUG_DRAWDOWN_THRESHOLD = 0.9;
const DUST_NATIVE = 0.0005;
const LOCKED_FRACTION_THRESHOLD = 0.5; // majority of LP supply burned/zeroed counts as "locked"

const erc20Iface = new ethers.Interface([
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

let reqId = 1;
async function rpc(method, params, attempt = 1) {
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: reqId++, method, params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
    return body.result;
  } catch (err) {
    if (attempt >= RETRY_ATTEMPTS || /missing trie node/i.test(err.message)) throw err;
    await new Promise((r) => setTimeout(r, 400 * attempt));
    return rpc(method, params, attempt + 1);
  }
}

function toHexBlock(n) {
  return "0x" + Math.max(0, Math.floor(n)).toString(16);
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await worker(items[i], i);
      } catch {
        results[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, runner));
  return results;
}

function isRugged(rec) {
  if (rec.launchNativeReserve <= 0) return null;
  if (rec.currentNativeReserve <= DUST_NATIVE) return true;
  const drawdown = (rec.launchNativeReserve - rec.currentNativeReserve) / rec.launchNativeReserve;
  return drawdown >= RUG_DRAWDOWN_THRESHOLD;
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(IN_PATH, "utf8"));
  const dataset = raw.dataset.filter((r) => isRugged(r) !== null);
  console.log(`[lp-lock] checking LP-lock status for ${dataset.length} pairs at launch+${LAUNCH_CHECK_OFFSET} blocks...`);

  let done = 0;
  const results = await mapLimit(dataset, CONCURRENCY, async (rec) => {
    const blockTag = toHexBlock(rec.createdBlock + LAUNCH_CHECK_OFFSET);
    const totalSupplyData = erc20Iface.encodeFunctionData("totalSupply", []);
    const deadBalData = erc20Iface.encodeFunctionData("balanceOf", [DEAD_ADDRESS]);
    const zeroBalData = erc20Iface.encodeFunctionData("balanceOf", [ZERO_ADDRESS]);

    const [totalRaw, deadRaw, zeroRaw] = await Promise.all([
      rpc("eth_call", [{ to: rec.pairAddress, data: totalSupplyData }, blockTag]),
      rpc("eth_call", [{ to: rec.pairAddress, data: deadBalData }, blockTag]),
      rpc("eth_call", [{ to: rec.pairAddress, data: zeroBalData }, blockTag]),
    ]);

    done++;
    if (done % 50 === 0) console.log(`[lp-lock] ${done}/${dataset.length}`);

    const total = BigInt(totalRaw);
    if (total === 0n) return null;
    const dead = BigInt(deadRaw);
    const zero = BigInt(zeroRaw);
    const lockedFraction = Number(((dead + zero) * 10000n) / total) / 10000;

    return {
      tokenAddress: rec.tokenAddress,
      symbol: rec.symbol,
      lockedFraction,
      isLocked: lockedFraction >= LOCKED_FRACTION_THRESHOLD,
      rugged: isRugged(rec),
    };
  });

  const usable = results.filter(Boolean);
  console.log(`[lp-lock] ${usable.length}/${dataset.length} successfully checked`);

  const locked = usable.filter((r) => r.isLocked);
  const unlocked = usable.filter((r) => !r.isLocked);
  const ruggedRate = (arr) => (arr.length ? (arr.filter((r) => r.rugged).length / arr.length) * 100 : null);

  console.log(`\nLocked at launch (>=${LOCKED_FRACTION_THRESHOLD * 100}% LP burned/zeroed): n=${locked.length}, rug rate=${ruggedRate(locked)?.toFixed(1)}%`);
  console.log(`Unlocked at launch: n=${unlocked.length}, rug rate=${ruggedRate(unlocked)?.toFixed(1)}%`);

  // Finer breakdown — is there a meaningful gradient, or is it binary?
  const buckets = [
    ["0% locked", (r) => r.lockedFraction === 0],
    ["0-25%", (r) => r.lockedFraction > 0 && r.lockedFraction < 0.25],
    ["25-50%", (r) => r.lockedFraction >= 0.25 && r.lockedFraction < 0.5],
    ["50-90%", (r) => r.lockedFraction >= 0.5 && r.lockedFraction < 0.9],
    ["90-100%", (r) => r.lockedFraction >= 0.9],
  ];
  console.log("\nRug rate by locked-fraction bucket:");
  for (const [label, fn] of buckets) {
    const group = usable.filter(fn);
    console.log(`  ${label.padEnd(12)} n=${String(group.length).padEnd(6)} rug rate=${ruggedRate(group)?.toFixed(1) ?? "—"}%`);
  }

  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify(
      {
        analyzedAt: Date.now(),
        totalChecked: usable.length,
        lockedRugRatePct: ruggedRate(locked),
        unlockedRugRatePct: ruggedRate(unlocked),
        records: usable,
      },
      null,
      2
    )
  );
  console.log(`\nWrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("[lp-lock] fatal:", err);
  process.exit(1);
});
