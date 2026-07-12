import { CHAINS } from "./chains.js";

// Which chains NFT features (collection sniping, wallet copy-trading,
// paper/real trading) are active on — deliberately separate from the token
// side's CHAINS env var. Defaults to Base + Robinhood Chain, not Ethereum,
// per the current scope of this feature. Shared by index.js (which chains
// to start watchers for) and telegram/bot.js (on-demand /nftscore chain
// detection, menu text) so both read the same list instead of duplicating
// the env parsing.
export function getNftChainKeys() {
  return (process.env.NFT_CHAINS || "base,robinhood")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((key) => CHAINS[key]);
}

export function getNftChainDefs() {
  return getNftChainKeys().map((key) => ({ key, ...CHAINS[key] }));
}
