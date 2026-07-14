import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "./dataDir.js";

const settingsPath = path.join(getDataDir(), "walletSettings.json");

// Persisted override for the WALLET_PRIVATE_KEY env var — lets the trading
// wallet be created or replaced live from Telegram (admin + real-trading
// passcode gated, see telegram/bot.js) instead of requiring a Railway
// variable edit and redeploy. Same plaintext-on-volume trust boundary as the
// env var it takes priority over — nothing more, nothing less; whoever could
// already reach the Railway variable could equally reach this file.
export function loadWalletPrivateKey() {
  if (!fs.existsSync(settingsPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return data.privateKey || null;
  } catch {
    return null;
  }
}

export function saveWalletPrivateKey(privateKey) {
  fs.writeFileSync(settingsPath, JSON.stringify({ privateKey }, null, 2));
}
