import fetch from "node-fetch";
import { getGoplusAccessToken } from "./goplusAuth.js";

const BASE_URL = "https://api.gopluslabs.io/api/v1/token_security";
const NFT_BASE_URL = "https://api.gopluslabs.io/api/v1/nft_security";

// Contract + liquidity + holder safety data in one call.
// Works unauthenticated at low volume; set GOPLUS_APP_KEY/GOPLUS_APP_SECRET
// to raise limits — see goplusAuth.js for the sign+token-exchange flow.
export async function getTokenSecurity(goplusChainId, tokenAddress) {
  const url = `${BASE_URL}/${goplusChainId}?contract_addresses=${tokenAddress.toLowerCase()}`;
  const headers = {};
  const accessToken = await getGoplusAccessToken();
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`GoPlus API error ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.code !== 1) throw new Error(`GoPlus API returned code ${body.code}: ${body.message}`);

  const data = body.result?.[tokenAddress.toLowerCase()];
  if (!data) return null;
  return data;
}

// NFT-contract counterpart of getTokenSecurity — same auth flow, same
// unauthenticated-fallback behavior. Field names (nft_verified,
// nft_open_source, nft_proxy, malicious_nft_contract, nft_owner_number, ...)
// per GoPlus's NFT Security API; verify against docs.gopluslabs.io if the
// response shape ever looks unexpected.
export async function getNftSecurity(goplusChainId, contractAddress) {
  const url = `${NFT_BASE_URL}/${goplusChainId}?contract_addresses=${contractAddress.toLowerCase()}`;
  const headers = {};
  const accessToken = await getGoplusAccessToken();
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`GoPlus NFT API error ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.code !== 1) throw new Error(`GoPlus NFT API returned code ${body.code}: ${body.message}`);

  const data = body.result?.[contractAddress.toLowerCase()];
  if (!data) return null;
  return data;
}
