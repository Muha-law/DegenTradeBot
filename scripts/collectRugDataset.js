// Standalone research script — NOT part of the live bot. Scans Robinhood
// Chain's full on-chain history for Uniswap V2 pairs against the wrapped
// native asset, then reconstructs each pair's reserve trajectory (launch →
// now) directly from archive state via eth_call at historical block numbers.
// Output feeds the rug-detection backtest: data/rugDataset.json.
//
// Run: node scripts/collectRugDataset.js
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "data", "rugDataset.json");

const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
const V2_FACTORY = "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f";
const WRAPPED_NATIVE = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

// Empirically probed this RPC's archive retention (see conversation notes):
// eth_call succeeds up to ~2.75M blocks back from latest and reliably fails
// ("missing trie node") beyond ~3.37M blocks back, with some inconsistency
// near that boundary (likely multiple backend nodes with slightly different
// retention). MAX_BLOCKS_BACK stays well clear of that edge; MIN_BLOCKS_AGE
// still requires enough elapsed time for a rug to plausibly have happened.
const MAX_BLOCKS_BACK = 2_000_000;
const MIN_BLOCKS_AGE = 600_000;
const MAX_SAMPLES = 1200;
const CONCURRENCY = 5;
const RETRY_ATTEMPTS = 4;

const pairIface = new ethers.Interface([
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)",
]);
const reservesIface = new ethers.Interface(["function getReserves() view returns (uint112,uint112,uint32)"]);
const erc20Iface = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
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
    // Pruned archive state ("missing trie node") is permanent for that
    // block — retrying just wastes time waiting on a call that can never
    // succeed. Only retry genuinely transient failures (network hiccups,
    // rate limiting, etc).
    if (attempt >= RETRY_ATTEMPTS || /missing trie node/i.test(err.message)) throw err;
    await new Promise((r) => setTimeout(r, 400 * attempt));
    return rpc(method, params, attempt + 1);
  }
}

async function ethCall(to, data, blockTag = "latest") {
  return rpc("eth_call", [{ to, data }, blockTag]);
}

// Runs `items` through `worker` with bounded concurrency, tolerating
// individual failures (returns null for those) instead of aborting the run —
// a handful of dead/unresponsive contracts shouldn't cost the whole dataset.
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, runner));
  return results;
}

async function getReservesAt(pairAddr, blockTag) {
  const data = reservesIface.encodeFunctionData("getReserves", []);
  const raw = await ethCall(pairAddr, data, blockTag);
  if (!raw || raw === "0x") return null;
  const [r0, r1] = reservesIface.decodeFunctionResult("getReserves", raw);
  return { reserve0: r0.toString(), reserve1: r1.toString() };
}

async function getDecimals(tokenAddr) {
  try {
    const raw = await ethCall(tokenAddr, erc20Iface.encodeFunctionData("decimals", []));
    return Number(erc20Iface.decodeFunctionResult("decimals", raw)[0]);
  } catch {
    return 18; // reasonable default — most ERC20s on this chain follow it
  }
}

async function getSymbolName(tokenAddr) {
  const out = { symbol: null, name: null };
  try {
    const raw = await ethCall(tokenAddr, erc20Iface.encodeFunctionData("symbol", []));
    out.symbol = erc20Iface.decodeFunctionResult("symbol", raw)[0];
  } catch {}
  try {
    const raw = await ethCall(tokenAddr, erc20Iface.encodeFunctionData("name", []));
    out.name = erc20Iface.decodeFunctionResult("name", raw)[0];
  } catch {}
  return out;
}

function toHexBlock(n) {
  return "0x" + Math.max(0, Math.floor(n)).toString(16);
}

async function main() {
  console.log("[collect] fetching latest block + all V2 PairCreated logs...");
  const latestHex = await rpc("eth_blockNumber", []);
  const latestBlock = parseInt(latestHex, 16);

  const topic0 = pairIface.getEvent("PairCreated").topicHash;
  const logs = await rpc("eth_getLogs", [
    { address: V2_FACTORY, topics: [topic0], fromBlock: "0x0", toBlock: latestHex },
  ]);
  console.log(`[collect] ${logs.length} total V2 pairs found on-chain`);

  const wrapped = WRAPPED_NATIVE.toLowerCase();
  const decoded = logs
    .map((log) => {
      const parsed = pairIface.decodeEventLog("PairCreated", log.data, log.topics);
      return {
        token0: parsed.token0,
        token1: parsed.token1,
        pair: parsed.pair,
        createdBlock: parseInt(log.blockNumber, 16),
      };
    })
    .filter((p) => p.token0.toLowerCase() === wrapped || p.token1.toLowerCase() === wrapped)
    .map((p) => ({
      ...p,
      tokenAddress: p.token0.toLowerCase() === wrapped ? p.token1 : p.token0,
      nativeIsToken0: p.token0.toLowerCase() === wrapped,
    }));
  console.log(`[collect] ${decoded.length} are native-paired (matches live bot's own filter)`);

  const oldestBlock = latestBlock - MAX_BLOCKS_BACK;
  const newestBlock = latestBlock - MIN_BLOCKS_AGE;
  const eligible = decoded
    .filter((p) => p.createdBlock >= oldestBlock && p.createdBlock <= newestBlock)
    .sort((a, b) => b.createdBlock - a.createdBlock)
    .slice(0, MAX_SAMPLES);
  console.log(`[collect] ${eligible.length} eligible (block ${oldestBlock}-${newestBlock}, staying inside retained archive state), processing...`);

  let done = 0;
  const failReasons = { noLaunchLiquidity: 0, error: 0 };
  const results = await mapLimit(eligible, CONCURRENCY, async (p) => {
    let launch = null;
    let current = null;
    let decimals = 18;
    let symbol = null;
    let name = null;
    try {
      // Liquidity mint can land a few blocks after pair creation — search
      // forward in small steps until reserves are non-zero, capped so a pair
      // that never got liquidity doesn't stall the run.
      for (const offset of [5, 20, 50, 200, 1000, 5000, 20000]) {
        const r = await getReservesAt(p.pair, toHexBlock(p.createdBlock + offset));
        if (r && (r.reserve0 !== "0" || r.reserve1 !== "0")) {
          launch = r;
          break;
        }
      }
      current = await getReservesAt(p.pair, "latest");
      decimals = await getDecimals(p.tokenAddress);
      ({ symbol, name } = await getSymbolName(p.tokenAddress));
    } catch (err) {
      failReasons.error++;
      console.error(`[collect] RPC error on ${p.pair}: ${err.message}`);
    }

    done++;
    if (done % 50 === 0) console.log(`[collect] ${done}/${eligible.length}`);

    if (!launch) {
      failReasons.noLaunchLiquidity++;
      return null;
    }
    if (!current) return null;

    const launchNative = Number(ethers.formatUnits(p.nativeIsToken0 ? launch.reserve0 : launch.reserve1, 18));
    const currentNative = Number(ethers.formatUnits(p.nativeIsToken0 ? current.reserve0 : current.reserve1, 18));
    const launchToken = Number(ethers.formatUnits(p.nativeIsToken0 ? launch.reserve1 : launch.reserve0, decimals));
    const currentToken = Number(ethers.formatUnits(p.nativeIsToken0 ? current.reserve1 : current.reserve0, decimals));

    return {
      tokenAddress: p.tokenAddress,
      pairAddress: p.pair,
      symbol,
      name,
      createdBlock: p.createdBlock,
      launchNativeReserve: launchNative,
      currentNativeReserve: currentNative,
      launchTokenReserve: launchToken,
      currentTokenReserve: currentToken,
      decimals,
    };
  });

  const dataset = results.filter(Boolean);
  console.log(
    `[collect] ${dataset.length}/${eligible.length} successfully sampled ` +
      `(${failReasons.noLaunchLiquidity} never got liquidity within 20k blocks, ${failReasons.error} RPC errors)`
  );

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({ collectedAt: Date.now(), latestBlock, oldestBlock, newestBlock, dataset }, null, 2));
  console.log(`[collect] wrote ${dataset.length} records to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error("[collect] fatal:", err);
  process.exit(1);
});
