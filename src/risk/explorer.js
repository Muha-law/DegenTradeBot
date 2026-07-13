import fetch from "node-fetch";
import { config } from "../config.js";

const BASE_URL = "https://api.etherscan.io/v2/api";

async function getContractCreatorFromEtherscan(etherscanChainId, tokenAddress) {
  if (!config.etherscanApiKey) return { ok: false, reason: "no_api_key" };

  const params = new URLSearchParams({
    chainid: String(etherscanChainId),
    module: "contract",
    action: "getcontractcreation",
    contractaddresses: tokenAddress,
    apikey: config.etherscanApiKey,
  });

  const res = await fetch(`${BASE_URL}?${params}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Etherscan API error ${res.status}: ${await res.text()}`);
  const body = await res.json();

  if (body.status !== "1") {
    // Etherscan's actual wording for an unrecognized chainid is "unsupported
    // chainid parameter" (confirmed live for Robinhood Chain's 4663) — the
    // original "not supported" match missed this ("unsupported" doesn't
    // contain that substring), misclassifying it as "not_found" instead of
    // "unsupported_chain" and silently skipping the Blockscout fallback below.
    const reason = /not supported|unsupported|upgrade your api plan/i.test(`${body.result} ${body.message}`)
      ? "unsupported_chain"
      : "not_found";
    return { ok: false, reason };
  }
  if (!Array.isArray(body.result) || body.result.length === 0) return { ok: false, reason: "not_found" };

  return {
    ok: true,
    deployerAddress: body.result[0].contractCreator,
    creationTxHash: body.result[0].txHash,
  };
}

// Blockscout instances expose the same Etherscan-shaped API for free,
// unauthenticated, at /api?module=...&action=... — verified live against
// robinhoodchain.blockscout.com (module=contract&action=getcontractcreation
// returned a real deployer address for a token Etherscan V2 doesn't cover at
// all). Used as a fallback for chains chains.js gives a blockscoutBaseUrl,
// so deployer-history tracking (scoreDeployerHistory below) isn't
// permanently blind on chains outside Etherscan's coverage.
async function getContractCreatorFromBlockscout(blockscoutBaseUrl, tokenAddress) {
  const params = new URLSearchParams({
    module: "contract",
    action: "getcontractcreation",
    contractaddresses: tokenAddress,
  });
  const res = await fetch(`${blockscoutBaseUrl}/api?${params}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Blockscout API error ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (!Array.isArray(body.result) || body.result.length === 0) return { ok: false, reason: "not_found" };
  return {
    ok: true,
    deployerAddress: body.result[0].contractCreator,
    creationTxHash: body.result[0].txHash,
  };
}

// Looks up who deployed the token contract — tries Etherscan V2 first
// (requires ETHERSCAN_API_KEY; only covers a subset of chains), falling
// back to the chain's own Blockscout instance when Etherscan doesn't cover
// it and chains.js has one configured. `reason` lets callers tell "not
// supported on this plan" apart from "genuinely not found" instead of
// silently treating both the same way.
export async function getContractCreator(chain, tokenAddress) {
  const result = await getContractCreatorFromEtherscan(chain.etherscanChainId, tokenAddress);
  if (result.ok || !chain.blockscoutBaseUrl) return result;
  if (result.reason !== "unsupported_chain" && result.reason !== "no_api_key") return result;
  return getContractCreatorFromBlockscout(chain.blockscoutBaseUrl, tokenAddress).catch(() => ({ ok: false, reason: "error" }));
}

async function getDeployerTxCountFromEtherscan(etherscanChainId, deployerAddress) {
  if (!config.etherscanApiKey) return null;

  const params = new URLSearchParams({
    chainid: String(etherscanChainId),
    module: "account",
    action: "txlist",
    address: deployerAddress,
    sort: "asc",
    apikey: config.etherscanApiKey,
  });

  const res = await fetch(`${BASE_URL}?${params}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Etherscan API error ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.status !== "1" || !Array.isArray(body.result)) return null;

  const contractCreations = body.result.filter((tx) => tx.to === "" || tx.to === null).length;
  return { txCount: body.result.length, contractCreations };
}

async function getDeployerTxCountFromBlockscout(blockscoutBaseUrl, deployerAddress) {
  const params = new URLSearchParams({
    module: "account",
    action: "txlist",
    address: deployerAddress,
    sort: "asc",
  });
  const res = await fetch(`${blockscoutBaseUrl}/api?${params}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Blockscout API error ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (!Array.isArray(body.result)) return null;

  const contractCreations = body.result.filter((tx) => tx.to === "" || tx.to === null).length;
  return { txCount: body.result.length, contractCreations };
}

// Counts how many contracts a deployer address has created (proxy for
// "serial token deployer" behavior often seen in rug patterns) — same
// Etherscan-then-Blockscout fallback as getContractCreator above.
export async function getDeployerTxCount(chain, deployerAddress) {
  const fromEtherscan = await getDeployerTxCountFromEtherscan(chain.etherscanChainId, deployerAddress);
  if (fromEtherscan || !chain.blockscoutBaseUrl) return fromEtherscan;
  return getDeployerTxCountFromBlockscout(chain.blockscoutBaseUrl, deployerAddress).catch(() => null);
}
