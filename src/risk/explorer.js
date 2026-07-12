import fetch from "node-fetch";
import { config } from "../config.js";

const BASE_URL = "https://api.etherscan.io/v2/api";

// Looks up who deployed the token contract. Requires ETHERSCAN_API_KEY.
// Etherscan's free tier only covers a subset of chains via the V2 API (as
// of writing: Ethereum and Arbitrum, but not Base or BSC) — `reason` lets
// callers tell "not supported on this plan" apart from "genuinely not found"
// instead of silently treating both the same way.
export async function getContractCreator(etherscanChainId, tokenAddress) {
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
    const reason = /not supported|upgrade your api plan/i.test(`${body.result} ${body.message}`)
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

// Counts how many contracts a deployer address has created (proxy for
// "serial token deployer" behavior often seen in rug patterns).
export async function getDeployerTxCount(etherscanChainId, deployerAddress) {
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
  if (body.status !== "1" || !Array.isArray(body.result)) return { txCount: 0, contractCreations: 0 };

  const contractCreations = body.result.filter((tx) => tx.to === "" || tx.to === null).length;
  return { txCount: body.result.length, contractCreations };
}
