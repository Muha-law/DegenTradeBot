import { listRecentCollections } from "../risk/opensea.js";
import { hasSeenNftCollection, markNftCollectionSeen } from "../store/db.js";

// OpenSea's own rate limits are stricter than the free public RPC endpoints
// the token-side watchers poll — 30s keeps well under typical API-key
// limits while still catching a new collection within a minute of OpenSea
// indexing it.
const POLL_INTERVAL_MS = 30000;

// Simpler than watchers/pollingWatcher.js's block-range cursor — there's no
// block number here, just "the most recently created collections OpenSea
// knows about." Each poll re-fetches the same recent window and lets
// seen_nft_collections do the dedup, rather than tracking a cursor that
// could drift if OpenSea's indexing reorders slightly.
export function startNftCollectionWatcher(chain, onNewCollection) {
  let stopped = false;
  let timer = null;

  async function poll() {
    if (stopped) return;
    try {
      const collections = await listRecentCollections(chain.key, { limit: 50 });
      for (const c of collections) {
        if (!c.contractAddress) continue; // no on-chain contract yet (metadata-only draft) — nothing to score
        if (hasSeenNftCollection(chain.key, c.contractAddress)) continue;
        markNftCollectionSeen(chain.key, c.contractAddress);
        onNewCollection({
          chain,
          contractAddress: c.contractAddress,
          slug: c.slug,
          name: c.name,
          imageUrl: c.imageUrl,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      console.error(`[${chain.key}] NFT collection poll failed:`, err.message);
    } finally {
      if (!stopped) timer = setTimeout(poll, POLL_INTERVAL_MS);
    }
  }

  console.log(`[${chain.key}] polling OpenSea for new NFT collections every ${POLL_INTERVAL_MS}ms`);
  poll();

  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
