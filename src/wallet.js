import { Wallet, JsonRpcProvider, formatEther } from "ethers";
import { config } from "./config.js";
import { CHAINS } from "./chains.js";

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
