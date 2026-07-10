import fetch from "node-fetch";
import { getGoplusAccessToken } from "./goplusAuth.js";

const BASE_URL = "https://api.gopluslabs.io/api/v1/token_security";

// Contract + liquidity + holder safety data in one call.
// Works unauthenticated at low volume; set GOPLUS_APP_KEY/GOPLUS_APP_SECRET
// to raise limits — see goplusAuth.js for the sign+token-exchange flow.
export async function getTokenSecurity(goplusChainId, tokenAddress) {
  const url = `${BASE_URL}/${goplusChainId}?contract_addresses=${tokenAddress.toLowerCase()}`;
  const headers = {};
  const accessToken = await getGoplusAccessToken();
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`GoPlus API error ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.code !== 1) throw new Error(`GoPlus API returned code ${body.code}: ${body.message}`);

  const data = body.result?.[tokenAddress.toLowerCase()];
  if (!data) return null;
  return data;
}
