import fs from "node:fs";
import path from "node:path";
import { CHAINS } from "./chains.js";
import { getDataDir } from "./dataDir.js";

const settingsPath = path.join(getDataDir(), "nftChains.json");

// Chains this bot knows that OpenSea also indexes — the NFT feature is
// OpenSea-backed end to end, so a chain OpenSea doesn't cover (BSC) can't
// be offered no matter what the token side supports. Matches the slug map
// in risk/opensea.js.
export const NFT_CAPABLE_CHAIN_KEYS = ["ethereum", "base", "arbitrum", "robinhood"].filter((key) => CHAINS[key]);

// Which chains NFT features (collection sniping, wallet copy-trading,
// paper/real trading) are active on — deliberately separate from the token
// side's chain toggles, so e.g. Base can run tokens-only while Robinhood
// runs both. Seeded once from the NFT_CHAINS env var (default
// "base,robinhood") on first run; data/nftChains.json is the source of
// truth after that, edited live from the Chains menu — the same
// persistence pattern as chainSettings.js on the token side.
function seedFromEnv() {
  const envChains = (process.env.NFT_CHAINS || "base,robinhood")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((key) => NFT_CAPABLE_CHAIN_KEYS.includes(key));
  return [...new Set(envChains)];
}

export function loadEnabledNftChains() {
  if (!fs.existsSync(settingsPath)) {
    const seeded = seedFromEnv();
    saveEnabledNftChains(seeded);
    return seeded;
  }
  const data = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  return (data.enabled || []).filter((key) => NFT_CAPABLE_CHAIN_KEYS.includes(key));
}

export function saveEnabledNftChains(enabled) {
  fs.writeFileSync(settingsPath, JSON.stringify({ enabled }, null, 2));
}

export function isNftChainEnabled(key) {
  return loadEnabledNftChains().includes(key);
}

export function setNftChainEnabled(key, enabled) {
  if (!NFT_CAPABLE_CHAIN_KEYS.includes(key)) throw new Error(`Chain "${key}" isn't available for NFTs`);
  const current = new Set(loadEnabledNftChains());
  if (enabled) current.add(key);
  else current.delete(key);
  saveEnabledNftChains([...current]);
}

export function getNftChainKeys() {
  return loadEnabledNftChains();
}

export function getNftChainDefs() {
  return getNftChainKeys().map((key) => ({ key, ...CHAINS[key] }));
}
