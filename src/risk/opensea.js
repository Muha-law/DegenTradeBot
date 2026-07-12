import fetch from "node-fetch";
import { config } from "../config.js";

const BASE_URL = "https://api.opensea.io/api/v2";

// OpenSea v2 requires an API key for any meaningful rate limit — unlike
// DexScreener/GoPlus (which this bot can call unauthenticated at low
// volume), there's no unauthenticated fallback worth relying on here.
// Every exported function below throws if no key is configured; callers
// (watchers, pipeline) are expected to check config.openseaApiKey up front
// and simply not start the NFT feature at all without one — same pattern as
// hasWallet() gating real trading elsewhere in this codebase.
function requireApiKey() {
  if (!config.openseaApiKey) throw new Error("OPENSEA_API_KEY not configured");
  return config.openseaApiKey;
}

// Global limiter across EVERY OpenSea call this process makes — two chain
// watchers, the wallet watcher, the outcome tracker, and the trade checkers
// all share one API key with a documented free-tier ceiling of 60 reads/min.
// Pacing per-watcher (the first attempt) doesn't compose: each watcher
// individually respected its own spacing while their combined rate blew the
// budget (~109/min with two chains and 95 watched wallets). A single
// serialized queue is the only spot that sees the true global rate.
const MIN_REQUEST_SPACING_MS = 1100;
let requestChain = Promise.resolve();
let lastRequestAt = 0;

function throttled(fn) {
  const run = requestChain.then(async () => {
    const wait = lastRequestAt + MIN_REQUEST_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return fn();
  });
  // The chain must survive individual failures — anchor the next request on
  // settled, not fulfilled, or one 429 would break the queue forever.
  requestChain = run.catch(() => {});
  return run;
}

async function request(path, { method = "GET", params, body } = {}) {
  const apiKey = requireApiKey();
  const qs = params ? `?${new URLSearchParams(Object.entries(params).filter(([, v]) => v != null))}` : "";
  return throttled(async () => {
    const res = await fetch(`${BASE_URL}${path}${qs}`, {
      method,
      signal: AbortSignal.timeout(20000),
      headers: {
        "x-api-key": apiKey,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`OpenSea API error ${res.status} on ${path}: ${await res.text()}`);
    return res.json();
  });
}

// OpenSea's chain slugs differ from this bot's own chain keys in general
// (e.g. Base is "base" on both, but this mapping exists so the NFT modules
// never assume they happen to match as the feature grows to more chains).
// Robinhood Chain's slug ("robinhood") confirmed live at
// opensea.io/discover/chain/robinhood — OpenSea announced support for it
// directly (@opensea on X, "Robinhood Chain is now supported on OpenSea").
const OPENSEA_CHAIN_SLUG = { ethereum: "ethereum", base: "base", robinhood: "robinhood" };

export function openseaChainSlug(chainKey) {
  return OPENSEA_CHAIN_SLUG[chainKey] || chainKey;
}

// Resolves a raw contract address to its OpenSea collection slug + token
// standard — needed because everything else in this module (stats,
// listings, fulfillment) is keyed by collection slug, not bare address.
export async function getContract(chainKey, contractAddress) {
  const body = await request(`/chain/${openseaChainSlug(chainKey)}/contract/${contractAddress}`);
  return {
    slug: body.collection || null,
    standard: body.token_standard || null,
    name: body.name || null,
  };
}

export async function getCollection(slug) {
  const body = await request(`/collections/${slug}`);
  return {
    slug: body.collection || slug,
    name: body.name || null,
    imageUrl: body.image_url || null,
    safelistStatus: body.safelist_status || "not_requested",
    contractAddress: body.contracts?.[0]?.address || null,
    chain: body.contracts?.[0]?.chain || null,
    totalSupply: body.total_supply ?? null,
    createdDate: body.created_date || null,
    // [{fee: <percent, e.g. 2.5>, recipient, required}] — OpenSea's own
    // platform fee plus any collection royalty it enforces. Used by
    // execution/nftExecutor.js to split listing proceeds correctly instead
    // of assuming 100% goes to the seller.
    fees: body.fees || [],
  };
}

export async function getCollectionStats(slug) {
  const body = await request(`/collections/${slug}/stats`);
  const oneDay = (body.intervals || []).find((i) => i.interval === "one_day");
  return {
    floorPriceEth: body.total?.floor_price ?? null,
    numOwners: body.total?.num_owners ?? null,
    marketCapEth: body.total?.market_cap ?? null,
    totalSales: body.total?.sales ?? null,
    volume24hEth: oneDay?.volume ?? null,
    sales24h: oneDay?.sales ?? null,
  };
}

// Polling source for the new-collection watcher. Scoped server-side to one
// chain via OpenSea's own `chain` filter (confirmed on
// docs.opensea.io/reference/list_collections) — without it, "most recently
// created collections" is global across every chain OpenSea indexes, and a
// quiet chain like Robinhood could get crowded out of a 50-item window by
// higher-volume chains OpenSea also tracks. OpenSea's `created_date` itself
// reflects when OpenSea indexed the collection slug, not necessarily the
// exact contract-deploy block — can lag or lead actual on-chain deployment
// by a while. Accepted tradeoff for a data source that also gives us floor
// price / owner count / verification status, none of which a pure on-chain
// deploy-watcher could provide on its own.
export async function listRecentCollections(chainKey, { limit = 50 } = {}) {
  const body = await request("/collections", { params: { chain: openseaChainSlug(chainKey), order_by: "created_date", limit } });
  return (body.collections || []).map((c) => ({
    slug: c.collection,
    name: c.name || null,
    imageUrl: c.image_url || null,
    contractAddress: c.contracts?.[0]?.address || null,
    chain: c.contracts?.[0]?.chain || null,
    createdDate: c.created_date || null,
  }));
}

// Polling source for the wallet copy-trade watcher — sale events where
// `address` was the buyer. occurredAfter is a unix-seconds cursor.
export async function getAccountEvents(address, { eventType = "sale", chain = "ethereum", occurredAfter, limit = 50 } = {}) {
  const body = await request(`/events/accounts/${address}`, {
    params: { event_type: eventType, chain, occurred_after: occurredAfter, limit },
  });
  return (body.asset_events || []).map((e) => ({
    txHash: e.transaction?.hash || e.transaction || null,
    contractAddress: e.nft?.contract || e.asset?.contract_address || null,
    tokenId: e.nft?.identifier || e.asset?.token_id || null,
    buyer: e.buyer || null,
    seller: e.seller || null,
    priceEth: e.payment?.quantity && e.payment?.decimals != null ? Number(e.payment.quantity) / 10 ** Number(e.payment.decimals) : null,
    occurredAt: e.event_timestamp ? Number(e.event_timestamp) * 1000 : Date.now(),
  }));
}

// Cheapest currently-fulfillable listing in a collection — used both for
// "buy the floor after a copy-trade signal" (the exact item the watched
// wallet bought is no longer for sale) and "buy the floor once a brand-new
// collection has any listing at all". Returns null if nothing is listed.
export async function getCheapestListing(chainKey, contractAddress) {
  const body = await request(`/orders/${openseaChainSlug(chainKey)}/seaport/listings`, {
    params: { asset_contract_address: contractAddress, order_by: "eth_price", order_direction: "asc", limit: 1 },
  });
  const order = body.orders?.[0];
  if (!order) return null;
  const offerItem = order.protocol_data?.parameters?.offer?.[0];
  const considerationTotal = (order.protocol_data?.parameters?.consideration || []).reduce(
    (sum, c) => sum + Number(c.startAmount || 0),
    0
  );
  return {
    orderHash: order.order_hash,
    protocolAddress: order.protocol_address,
    tokenId: offerItem?.identifierOrCriteria || null,
    priceEth: considerationTotal > 0 ? considerationTotal / 1e18 : Number(order.current_price || 0) / 1e18,
    raw: order,
  };
}

// Ready-to-send transaction data for fulfilling a listing (buy path) — see
// docs.opensea.io/reference/generate_listing_fulfillment_data_v2. Returned
// `transaction` shape ({to, value, data} or similar) is sent directly via
// wallet.sendTransaction in execution/nftExecutor.js rather than pulling in
// the opensea-js SDK.
export async function getFulfillmentData({ orderHash, chainKey, protocolAddress, fulfillerAddress }) {
  const body = await request("/listings/fulfillment_data", {
    method: "POST",
    body: {
      listing: { hash: orderHash, chain: openseaChainSlug(chainKey), protocol_address: protocolAddress },
      fulfiller: { address: fulfillerAddress },
    },
  });
  return body.fulfillment_data?.transaction || null;
}

// Posts a signed Seaport listing order (sell/exit path) — order must already
// be built + signed (EIP-712 signTypedData) by the caller in nftExecutor.js.
export async function postListing(chainKey, signedOrder) {
  const body = await request(`/orders/${openseaChainSlug(chainKey)}/seaport/listings`, {
    method: "POST",
    body: signedOrder,
  });
  return body.order || body;
}
