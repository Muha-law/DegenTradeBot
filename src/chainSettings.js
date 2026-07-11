import fs from "node:fs";
import path from "node:path";
import { CHAINS } from "./chains.js";
import { getDataDir } from "./dataDir.js";

const settingsPath = path.join(getDataDir(), "chains.json");

function seedFromEnv() {
  const envChains = (process.env.CHAINS || "base,ethereum")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((key) => CHAINS[key]);
  return [...new Set(envChains)];
}

// Which chains are actively watched, persisted so toggles survive restarts.
// Seeded once from the CHAINS env var on first run; data/chains.json is the
// source of truth after that.
export function loadEnabledChains() {
  if (!fs.existsSync(settingsPath)) {
    const seeded = seedFromEnv();
    saveEnabledChains(seeded);
    return seeded;
  }
  const data = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  return (data.enabled || []).filter((key) => CHAINS[key]);
}

export function saveEnabledChains(enabled) {
  fs.writeFileSync(settingsPath, JSON.stringify({ enabled }, null, 2));
}

export function getActiveChainDefs() {
  return loadEnabledChains().map((key) => ({ key, ...CHAINS[key] }));
}

export function isChainEnabled(key) {
  return loadEnabledChains().includes(key);
}

export function setChainEnabled(key, enabled) {
  if (!CHAINS[key]) throw new Error(`Unknown chain "${key}"`);
  const current = new Set(loadEnabledChains());
  if (enabled) current.add(key);
  else current.delete(key);
  saveEnabledChains([...current]);
}
