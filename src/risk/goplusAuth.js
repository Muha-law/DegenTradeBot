import crypto from "node:crypto";
import { config } from "../config.js";

const TOKEN_URL = "https://api.gopluslabs.io/api/v1/token";

let cachedToken = null;
let cachedExpiresAt = 0;

function sign(appKey, time, appSecret) {
  return crypto.createHash("sha1").update(`${appKey}${time}${appSecret}`).digest("hex");
}

async function fetchAccessToken() {
  const time = Math.floor(Date.now() / 1000);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    signal: AbortSignal.timeout(20000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_key: config.goplusAppKey, sign: sign(config.goplusAppKey, time, config.goplusAppSecret), time }),
  });
  if (!res.ok) throw new Error(`GoPlus token endpoint error ${res.status}: ${await res.text()}`);

  const body = await res.json();
  if (body.code !== 1 || !body.result?.access_token) {
    throw new Error(`GoPlus token endpoint returned unexpected shape: ${JSON.stringify(body)}`);
  }
  // GoPlus's access_token field already includes a literal "Bearer " prefix
  // — strip it here so callers can build `Authorization: Bearer ${token}`
  // themselves without ending up with a doubled "Bearer Bearer ..." header.
  const accessToken = body.result.access_token.replace(/^Bearer\s+/i, "");
  return { accessToken, expiresIn: body.result.expires_in };
}

// Returns a valid GoPlus access token, transparently fetching/refreshing as
// needed. Returns null if no app key/secret is configured — getTokenSecurity
// then falls back to unauthenticated requests (works at low volume).
export async function getGoplusAccessToken() {
  if (!config.goplusAppKey || !config.goplusAppSecret) return null;

  const now = Date.now();
  if (cachedToken && now < cachedExpiresAt) return cachedToken;

  try {
    const { accessToken, expiresIn } = await fetchAccessToken();
    // Refresh 5 minutes before actual expiry so a request never races an
    // about-to-expire token; the API's documented expiry isn't published
    // anywhere reliable, so fall back to a conservative 1h window if
    // expires_in isn't present in the response.
    const ttlMs = (Number(expiresIn) > 0 ? Number(expiresIn) : 3600) * 1000;
    cachedToken = accessToken;
    cachedExpiresAt = now + ttlMs - 5 * 60 * 1000;
    return cachedToken;
  } catch (err) {
    console.error("[goplusAuth] failed to fetch access token, falling back to unauthenticated:", err.message);
    cachedToken = null;
    cachedExpiresAt = 0;
    return null;
  }
}
