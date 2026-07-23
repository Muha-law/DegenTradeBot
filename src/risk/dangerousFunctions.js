import { getProvider } from "../wallet.js";
import { extractSelectors } from "./selectorExtraction.js";

// A different question from bytecodeAnalysis.js's "how many functions here
// are unrecognized" (too noisy — legit custom tokens have plenty of benign
// unusual functions, confirmed live: DRIP, a legitimate token, scored
// similarly to confirmed scams because both share a common public
// generator template). This asks a narrower, higher-confidence question
// instead: does this contract expose a SPECIFIC, known-dangerous
// capability, regardless of whether it's active right now.
//
// Motivated by a real, repeating pattern: PONGO, 狗屎运, and DIH (three real
// trades, all on Robinhood Chain, which GoPlus doesn't cover at all) each
// passed every pre-buy check — including a real simulated sell — and were
// genuinely sellable at that moment, then had their balance vanish later
// with no corresponding sell from us. That's the signature of a contract
// the owner can drain at will, on their own schedule, independent of
// anything a point-in-time sell simulation can observe. No behavioral
// check (ours or anyone's) can catch a trap that isn't armed yet at check
// time — the only way to see it coming is to check whether the capability
// exists in the code at all.

// Direct arbitrary-balance manipulation — lets someone other than the
// holder move or destroy their tokens without that holder's involvement.
// No legitimate ERC20 needs any of these (note: burnFrom is deliberately
// excluded — that one's a standard, legitimate OpenZeppelin function
// gated by the token owner's own allowance, not a backdoor). Presence
// alone is treated as a fatal signal — there's no ordinary reason for a
// token contract to need this.
const TIER1_CONFISCATION_SELECTORS = {
  "0x33bebb77": "forceTransfer(address,address,uint256)",
  "0xda72c1e8": "adminTransfer(address,address,uint256)",
  "0x47298f82": "confiscate(address,uint256)",
  "0x5205f92f": "confiscateTokens(address,uint256)",
  "0xeb9253c0": "seize(address,uint256)",
  "0x88b9e10e": "seizeTokens(address,uint256)",
  "0x033bb4c1": "wipeBalance(address)",
  "0x32ba65aa": "clearBalance(address)",
  "0x06dd0419": "adminBurn(address,uint256)",
  "0x2850a0bd": "destroyBalance(address)",
  "0xe30443bc": "setBalance(address,uint256)",
  "0xe4ad9a18": "takeTokens(address,uint256)",
  "0xb8dbf876": "transferFromOwner(address,address,uint256)",
};

// Blacklist/trading-toggle/tax-rewrite capability — the classic "legit at
// launch, rug later" switches. Softer signal than tier 1: some genuinely
// benign tokens use a temporary blacklist or trading-enable switch during
// launch specifically to fend off snipers, so presence alone isn't
// treated as fatal — just surfaced as a flag alongside the numeric score,
// same as the social signals in riskScore.js.
const TIER2_SWITCH_SELECTORS = {
  "0xf9f92be4": "blacklist(address)",
  "0xf3290d75": "blacklistAddress(address)",
  "0x153b0d1e": "setBlacklist(address,bool)",
  "0x9cfe42da": "addBlacklist(address)",
  "0x44337ea1": "addToBlacklist(address)",
  "0x537df3b6": "removeFromBlacklist(address)",
  "0xc2880d57": "_blacklist(address,bool)",
  "0x342aa8b5": "setBot(address,bool)",
  "0x9c0db5f3": "setBots(address[],bool)",
  "0x129476ab": "blacklistWallet(address,bool)",
  "0xfe575a87": "isBlacklisted(address)",
  "0xc2e5ec04": "setTradingEnabled(bool)",
  "0x8a8c523c": "enableTrading()",
  "0x1031e36e": "pauseTrading()",
  "0xe01af92c": "setSwapEnabled(bool)",
  "0x8cd09d50": "setSellTax(uint256)",
  "0xdc1052e2": "setBuyTax(uint256)",
  "0x0b78f9c0": "setFees(uint256,uint256)",
  "0x6db79437": "updateFees(uint256,uint256)",
  "0x061c82d0": "setTaxFeePercent(uint256)",
};

// EIP-1167 minimal proxy ("clone") — a fixed 45-byte template (10-byte
// prefix + 20-byte implementation address + 15-byte suffix) that cheap
// factories commonly deploy instead of full contract code. Confirmed live:
// 狗屎运 (one of the three balance_vanished honeypots this check exists
// for) is deployed exactly this way — reading its own bytecode directly
// found zero selectors at all, not because it has no logic, but because
// the real logic lives in a separate, shared implementation contract this
// proxy delegates every call to. Skipping this resolution step doesn't
// just miss the dangerous-function check for clone-deployed tokens, it
// falsely reports "clean" for having checked nothing.
const CLONE_PREFIX = "363d3d373d3d3d363d73";
const CLONE_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

function resolveCloneTarget(bytecodeHex) {
  const hex = bytecodeHex.slice(2).toLowerCase();
  if (hex.length !== 90 || !hex.startsWith(CLONE_PREFIX) || !hex.endsWith(CLONE_SUFFIX)) return null;
  return "0x" + hex.slice(20, 60);
}

const cache = new Map();

// Returns { confiscationFunctions: string[], switchFunctions: string[] } —
// arrays of matched human-readable signatures, empty when none found.
// Never throws; a lookup failure just means "nothing detected", the same
// fail-open posture as every other self-hosted check in this file.
export async function detectDangerousFunctions(chain, tokenAddress) {
  const cacheKey = `${chain.key}:${tokenAddress.toLowerCase()}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const promise = (async () => {
    const provider = getProvider(chain);
    // A transient RPC hiccup shouldn't silently look identical to "checked,
    // nothing found" — that's the one failure mode this check can't afford,
    // since the whole point is catching a capability a behavioral check
    // would miss. A couple of retries costs nothing against how rarely
    // this runs (once per token, cached after).
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let bytecode = await provider.getCode(tokenAddress);
        const cloneTarget = resolveCloneTarget(bytecode);
        if (cloneTarget) bytecode = await provider.getCode(cloneTarget);
        const selectors = extractSelectors(bytecode);
        const confiscationFunctions = selectors
          .filter((s) => TIER1_CONFISCATION_SELECTORS[s])
          .map((s) => TIER1_CONFISCATION_SELECTORS[s]);
        const switchFunctions = selectors.filter((s) => TIER2_SWITCH_SELECTORS[s]).map((s) => TIER2_SWITCH_SELECTORS[s]);
        return { confiscationFunctions, switchFunctions };
      } catch (err) {
        if (attempt === 2) {
          console.error(`[dangerousFunctions] check failed for ${tokenAddress} after retries:`, err.message);
          return { confiscationFunctions: [], switchFunctions: [] };
        }
        await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
      }
    }
  })();

  cache.set(cacheKey, promise);
  return promise;
}
