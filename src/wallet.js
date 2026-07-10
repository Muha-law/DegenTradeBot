import { Wallet, JsonRpcProvider, formatEther } from "ethers";
import { config } from "./config.js";

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

function getProvider(chain) {
  if (!providerCache.has(chain.key)) {
    providerCache.set(chain.key, new JsonRpcProvider(httpUrlFor(chain)));
  }
  return providerCache.get(chain.key);
}

// Returns a Wallet connected to the given chain, or null if no private key
// is configured — callers must treat null as "real trading unavailable",
// never fall back to a dummy signer.
export function getWalletForChain(chain) {
  if (!config.walletPrivateKey) return null;
  return new Wallet(config.walletPrivateKey, getProvider(chain));
}

export function hasWallet() {
  return Boolean(config.walletPrivateKey);
}

export function getWalletAddress() {
  if (!config.walletPrivateKey) return null;
  return new Wallet(config.walletPrivateKey).address;
}

export async function getNativeBalance(chain) {
  const wallet = getWalletForChain(chain);
  if (!wallet) return null;
  const raw = await getProvider(chain).getBalance(wallet.address);
  return Number(formatEther(raw));
}
