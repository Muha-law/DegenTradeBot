import { Wallet, JsonRpcProvider, formatEther } from "ethers";
import { config } from "./config.js";
import { CHAINS } from "./chains.js";
import { loadWalletPrivateKey } from "./walletSettings.js";

// Per-chain HTTP providers, built lazily and cached. Real trading needs
// eth_sendRawTransaction (write), which the existing per-chain WSS RPCs
// also support over their HTTP form — reusing the same endpoints rather
// than requiring separate config.
const providerCache = new Map();

function httpUrlFor(chain) {
  if (chain.httpRpcUrl) return chain.httpRpcUrl;
  const wss = process.env[chain.wssEnvVar];
  if (!wss) throw new Error(`No RPC configured for ${chain.key} (${chain.wssEnvVar})`);
  return wss.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}

export function getProvider(chain) {
  if (!providerCache.has(chain.key)) {
    providerCache.set(chain.key, new JsonRpcProvider(httpUrlFor(chain)));
  }
  return providerCache.get(chain.key);
}

// The persisted store (set via Telegram — /wallet create or import) takes
// priority over the WALLET_PRIVATE_KEY env var, so changing it live never
// needs a redeploy. Re-read on every call rather than cached at module load,
// since it can change at any time while the bot is running.
function currentPrivateKey() {
  return loadWalletPrivateKey() || config.walletPrivateKey || null;
}

// Returns a Wallet connected to the given chain, or null if no private key
// is configured — callers must treat null as "real trading unavailable",
// never fall back to a dummy signer.
export function getWalletForChain(chain) {
  const privateKey = currentPrivateKey();
  if (!privateKey) return null;
  return new Wallet(privateKey, getProvider(chain));
}

export function hasWallet() {
  return Boolean(currentPrivateKey());
}

export function getWalletAddress() {
  const privateKey = currentPrivateKey();
  if (!privateKey) return null;
  return new Wallet(privateKey).address;
}

// Deliberately named distinctly from the getters above — this hands back the
// raw private key, not just an address. Only for the Telegram wallet-reveal
// flow (admin + passcode gated there), never for anything on a hot path.
export function getPrivateKeyForExport() {
  return currentPrivateKey();
}

export async function getNativeBalance(chain) {
  const wallet = getWalletForChain(chain);
  if (!wallet) return null;
  const raw = await getProvider(chain).getBalance(wallet.address);
  return Number(formatEther(raw));
}

// ENS resolution always goes through Ethereum mainnet (the ENS registry
// lives there, regardless of which chain the resolved address is later
// watched/traded on — an address is the same across every EVM chain). Used
// by the NFT wallet-copy-trade "Add Wallet" flow so a watched wallet can be
// entered as a human-readable .eth name instead of a raw address. Returns
// null (not a throw) if the name doesn't resolve, so callers can give a
// clean "couldn't resolve that name" reply instead of a stack trace.
export async function resolveEnsName(name) {
  const provider = getProvider({ key: "ethereum", ...CHAINS.ethereum });
  return provider.resolveName(name.toLowerCase()).catch(() => null);
}
