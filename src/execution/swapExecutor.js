import { Contract, formatEther, parseEther, MaxUint256 } from "ethers";
import { getWalletForChain, getProvider } from "../wallet.js";
import { getBestPair, pairSummary } from "../risk/dexscreener.js";

const ROUTER_ABI = [
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])",
];

const FACTORY_ABI = ["function getPair(address tokenA, address tokenB) view returns (address pair)"];

// SwapRouter02's exactInputSingle — verified against real on-chain calldata
// (see chains.js's v3RouterAddress comment). No `deadline` field: SwapRouter02
// dropped it compared to the original V1 SwapRouter.
const V3_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
];

const V3_POOL_ABI = ["function fee() view returns (uint24)"];

// QuoterV2 — only declared where chains.js has a verified v3QuoterAddress.
const V3_QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

// Burn address — universal target for a sellability probe. Most honeypot
// tokens block outgoing transfers entirely (blacklist/pause/trading-disabled
// flag) rather than only blocking transfers to a specific router, so testing
// against a neutral destination catches the dominant pattern without needing
// to know which router a real sell would eventually use.
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";

// WETH-style wrapped-native token — `withdraw` unwraps back to native
// currency. Every wrapped-native token on an EVM chain implements this.
const WETH_ABI = ["function withdraw(uint256 wad)", "function balanceOf(address) view returns (uint256)"];

// A distinct, non-retryable failure: the swap transaction itself confirmed
// on-chain (real money/tokens spent, real gas paid) but the expected side of
// the trade never arrived — no tokens on a buy, no native currency on a
// sell. Same honeypot mechanism either direction, a different one than
// "can't sell" (which verifySellable/probeSellability check for). Confirmed
// live on SKHYB/BNB Chain (buy side): withSlippageRetry used to treat this
// identically to an ordinary revert and retry with more slippage tolerance —
// but each "retry" is a brand new real swap, not a resend of a failed
// transaction, so retrying just repeated the same guaranteed-nothing outcome
// twice more before the wallet ran too low to try a third time. More
// slippage tolerance can never fix a token that doesn't deliver at all on
// either side, so this must never be retried.
export class SwapDeliveredNothingError extends Error {}

// Hard ceiling independent of realTradingSettings.json — defense in depth
// so a settings-file bug or bad input can never size an *automated* trade
// far beyond what was ever intended, no matter what positionSizeUsd says.
const ABSOLUTE_MAX_USD_PER_TRADE = 50;

// Separate, more generous ceiling for the manual trading terminal — these
// are deliberate human-initiated actions, not automated decisions, but
// still bounded against a fat-finger (typing 1 instead of 0.01, etc.).
const ABSOLUTE_MAX_NATIVE_PER_MANUAL_TRADE = 0.05;

const DEADLINE_SECONDS = 120;

// A HOODBOT-style buy reverted on-chain because the price moved between
// quoting and the transaction actually landing — the estimate-gas step
// passed, meaning it wasn't going to fail at the moment it was checked.
// Retrying the identical transaction would just fail the same way again;
// retrying with more slippage tolerance gives it room to succeed against a
// price that's since moved further.
//
// The FIRST attempt always uses the caller's own configured slippageBps
// (that value is still fully respected as the intended baseline tolerance).
// Only the RETRY attempts are allowed to climb past it, up to this absolute
// ceiling — capping retries at the same configured value defeats the point
// of retrying at all, which is exactly what happened silently by default:
// the old ladder was [500, 750, 1000] but got hard-capped at the caller's
// ceiling, and since 500bps is also the default slippageBps, every retry
// ladder in production collapsed to a single attempt with zero room to
// escalate (confirmed live: every FLETCH-style buy failure logged
// "attempt 1/1" no matter how many rungs were defined above).
const ABSOLUTE_MAX_RETRY_SLIPPAGE_BPS = 1000;
const RETRY_ESCALATION_STEPS_BPS = [750, 1000];

// Runs `attempt(slippageBps)` against an escalating slippage ladder until
// one succeeds, retrying only on an actual failure — not a blanket
// retry-anything wrapper, so callers should still let genuinely
// non-retryable errors (e.g. no wallet configured) surface normally, since
// those will just fail identically on every rung and only waste time.
export async function withSlippageRetry(attempt, configuredBps) {
  const ladder = [configuredBps];
  for (const bps of RETRY_ESCALATION_STEPS_BPS) {
    if (bps > ladder[ladder.length - 1] && bps <= ABSOLUTE_MAX_RETRY_SLIPPAGE_BPS) ladder.push(bps);
  }

  let lastErr;
  for (let i = 0; i < ladder.length; i++) {
    try {
      const result = await attempt(ladder[i]);
      if (i > 0) console.log(`[slippageRetry] succeeded on attempt ${i + 1}/${ladder.length} at ${ladder[i] / 100}% slippage`);
      return result;
    } catch (err) {
      // A confirmed-but-delivered-nothing swap already spent real money/
      // tokens on this exact rung — retrying at higher slippage doesn't
      // resend a failed transaction, it executes a brand new real swap for
      // the same guaranteed-zero outcome. Stop immediately instead of
      // paying for the same non-result again.
      if (err instanceof SwapDeliveredNothingError) throw err;
      lastErr = err;
      console.error(`[slippageRetry] attempt ${i + 1}/${ladder.length} (${ladder[i] / 100}% slippage) failed: ${err.message}`);
    }
  }
  throw lastErr;
}

function requireWallet(chain) {
  const wallet = getWalletForChain(chain);
  if (!wallet) throw new Error("No wallet configured (WALLET_PRIVATE_KEY unset)");
  return wallet;
}

// Best-effort post-buy honeypot check: static-calls a tiny transfer of the
// just-bought, actually-owned balance to confirm the wallet can move the
// token at all. This is the most reliable signal available on a chain
// GoPlus doesn't cover (see riskScore.js's goplusUnsupported flag) — it
// uses real, already-owned on-chain state instead of guessing at storage
// slots to simulate a purchase that hasn't happened yet.
//
// Tests a transfer to the PAIR specifically (falling back to a generic burn
// address only when no pair address is known) — NOT a generic destination.
// Confirmed live on two stuck real positions (NACH, ENDM) that this
// distinction matters: both allow ordinary wallet-to-wallet transfers just
// fine (a transfer to DEAD_ADDRESS would have reported "sellable"), but
// their contracts enforce a maxTxAmount cap specifically on transfers TO
// the liquidity pair — i.e. selling — which only a pair-targeted test can
// catch. probeSellability() (the pre-call gate) already tests against the
// real pair for this reason; this fallback now matches it.
// Read-only balance check — used by the position checker to notice when a
// wallet's actual holding of a token has fallen out of sync with the amount
// recorded at buy time (e.g. a contract-side confiscation/burn that skips
// the standard Transfer event), so it can correct or write off the position
// instead of retrying an amount that can never sell.
export async function getTokenBalance(chain, tokenAddress, holderAddress) {
  const token = new Contract(tokenAddress, ERC20_ABI, getProvider(chain));
  return token.balanceOf(holderAddress);
}

export async function verifySellable(chain, tokenAddress, tokenAmountRaw, pairAddress) {
  const wallet = requireWallet(chain);
  const token = new Contract(tokenAddress, ERC20_ABI, wallet);
  const amountIn = BigInt(tokenAmountRaw);
  if (amountIn <= 0n) return { sellable: false, reason: "No token balance to test" };
  const testAmount = amountIn > 100n ? amountIn / 100n : amountIn;
  const destination = pairAddress || DEAD_ADDRESS;
  try {
    await token.transfer.staticCall(destination, testAmount);
    return { sellable: true };
  } catch (err) {
    return { sellable: false, reason: err.shortMessage || err.message };
  }
}

async function currentNativeUsdPrice(chain, tokenAddress) {
  const dexPair = await getBestPair(chain.dexscreenerChainId, tokenAddress);
  const pair = pairSummary(dexPair, tokenAddress);
  if (!pair || !pair.nativeUsdPrice) throw new Error("Could not derive native currency price from this token's pair");
  return { pair, dexPair, nativeUsdPrice: pair.nativeUsdPrice };
}

// A token can genuinely have no on-chain pair yet on EITHER AMM version —
// e.g. still pre-graduation on Noxa's bonding curve. Checking this up front
// (V2 factory only — V3 is handled separately via findV3Pool) turns that
// into a clean, expected skip instead of an on-chain revert on every
// attempt. The AMM factory is always the first entry in a chain's factories
// list (see chains.js) — Noxa's own launch factory, listed after it,
// doesn't expose getPair().
async function hasRealPair(chain, tokenAddress) {
  const factoryAddress = chain.factories?.[0]?.address;
  if (!factoryAddress) return true; // no factory info to check against — don't block on an unknown
  const factory = new Contract(factoryAddress, FACTORY_ABI, getWalletForChain(chain)?.provider);
  const pairAddress = await factory.getPair(tokenAddress, chain.wrappedNative);
  return pairAddress !== "0x0000000000000000000000000000000000000000";
}

// DexScreener flags Uniswap V3 pairs via `labels: ["v3"]` — a completely
// different swap interface (concentrated liquidity, fee tiers) from the V2
// router this file otherwise assumes. Reads the pool's own fee tier
// directly off-chain from the pair address DexScreener already gave us,
// rather than probing standard fee tiers against the V3 factory.
async function findV3Pool(chain, dexPair) {
  if (!chain.v3RouterAddress || !dexPair?.labels?.includes("v3") || !dexPair.pairAddress) return null;
  const pool = new Contract(dexPair.pairAddress, V3_POOL_ABI, getWalletForChain(chain)?.provider);
  const fee = await pool.fee();
  return { poolAddress: dexPair.pairAddress, fee };
}

// Live on-chain quote via QuoterV2, when the chain has one verified (see
// chains.js's v3QuoterAddress comment). Returns null if unavailable — or if
// the call itself fails — so callers fall back to the DexScreener-price
// estimate. This is what actually fixes "Too little received" reverts: it
// reflects the pool's real state right before the swap, not a DexScreener
// snapshot that can already be a few seconds stale on a thin, fast-moving
// new-token pool.
async function getV3Quote(chain, tokenIn, tokenOut, fee, amountIn) {
  if (!chain.v3QuoterAddress) return null;
  try {
    const quoter = new Contract(chain.v3QuoterAddress, V3_QUOTER_ABI, getWalletForChain(chain)?.provider);
    const result = await quoter.quoteExactInputSingle.staticCall({
      tokenIn,
      tokenOut,
      amountIn,
      fee,
      sqrtPriceLimitX96: 0n,
    });
    return result[0];
  } catch (err) {
    console.error(`[swapExecutor] on-chain quote failed, falling back to DexScreener estimate: ${err.message}`);
    return null;
  }
}

// Slippage tolerance only protects against "worse than expected by X%" —
// if the pool was already drained between the DexScreener snapshot (`pair`)
// and this on-chain quote, the "expected" baseline for that percentage is
// itself already catastrophic, so a normal slippage check does nothing.
// Confirmed live: BEAR's pool held 1 wei of native reserves by the time the
// buy landed (fully drained), and the swap "succeeded" — real $2 spent for
// a fraction of a cent of tokens, recorded as a $30 billion entry price.
// This compares the fresh on-chain quote against the recent DexScreener
// price directly and refuses to buy if they've diverged by more than 20x,
// rather than trusting slippage tolerance to catch a baseline that's
// already broken.
const MAX_QUOTE_DIVERGENCE_FACTOR = 20;

function assertQuoteIsSane({ expectedOutRaw, decimals, nativeAmount, nativeUsdPrice, pair }) {
  if (!pair?.priceUsd) return; // no reference price to compare against — nothing to check
  const expectedOutHuman = Number(expectedOutRaw) / 10 ** Number(decimals);
  if (expectedOutHuman <= 0) throw new Error("On-chain quote returned zero tokens — pool is drained, aborting buy");
  const usdValue = nativeAmount * nativeUsdPrice;
  const impliedPriceUsd = usdValue / expectedOutHuman;
  if (impliedPriceUsd > pair.priceUsd * MAX_QUOTE_DIVERGENCE_FACTOR) {
    throw new Error(
      `On-chain quote implies a price ${(impliedPriceUsd / pair.priceUsd).toFixed(0)}x above the recent market price — pool likely drained since the last check, aborting buy`
    );
  }
}

async function executeBuy(chain, tokenAddress, nativeAmount, nativeUsdPrice, slippageBps, pair, dexPair) {
  const wallet = requireWallet(chain);
  const nativeAmountWei = parseEther(nativeAmount.toFixed(18));
  const token = new Contract(tokenAddress, ERC20_ABI, wallet.provider);
  const balBefore = await token.balanceOf(wallet.address);
  const decimals = await token.decimals();

  const v3Pool = await findV3Pool(chain, dexPair);
  let receipt;

  if (v3Pool) {
    const router = new Contract(chain.v3RouterAddress, V3_ROUTER_ABI, wallet);

    const onChainQuote = await getV3Quote(chain, chain.wrappedNative, tokenAddress, v3Pool.fee, nativeAmountWei);
    let expectedOutRaw;
    if (onChainQuote != null) {
      expectedOutRaw = onChainQuote;
    } else {
      // No verified quoter for this chain — fall back to DexScreener's live
      // spot price (the same price source this bot already trusts elsewhere).
      const usdValue = nativeAmount * nativeUsdPrice;
      const expectedTokenAmountHuman = usdValue / pair.priceUsd;
      expectedOutRaw = BigInt(Math.floor(expectedTokenAmountHuman * 10 ** Number(decimals)));
    }
    assertQuoteIsSane({ expectedOutRaw, decimals, nativeAmount, nativeUsdPrice, pair });
    const minOut = (expectedOutRaw * BigInt(10000 - slippageBps)) / 10000n;

    const tx = await router.exactInputSingle(
      {
        tokenIn: chain.wrappedNative,
        tokenOut: tokenAddress,
        fee: v3Pool.fee,
        recipient: wallet.address,
        amountIn: nativeAmountWei,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0,
      },
      { value: nativeAmountWei }
    );
    receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error(`Buy transaction reverted: ${receipt.hash}`);
  } else {
    if (!(await hasRealPair(chain, tokenAddress))) {
      throw new Error("No on-chain AMM pair exists for this token yet on Uniswap V2 or V3 — nothing to swap through.");
    }

    const router = new Contract(chain.routerAddress, ROUTER_ABI, wallet);
    const path = [chain.wrappedNative, tokenAddress];

    const amountsOut = await router.getAmountsOut(nativeAmountWei, path);
    const expectedOut = amountsOut[amountsOut.length - 1];
    assertQuoteIsSane({ expectedOutRaw: expectedOut, decimals, nativeAmount, nativeUsdPrice, pair });
    const minOut = (expectedOut * BigInt(10000 - slippageBps)) / 10000n;

    const tx = await router.swapExactETHForTokensSupportingFeeOnTransferTokens(
      minOut,
      path,
      wallet.address,
      Math.floor(Date.now() / 1000) + DEADLINE_SECONDS,
      { value: nativeAmountWei }
    );
    receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error(`Buy transaction reverted: ${receipt.hash}`);
  }

  const balAfter = await token.balanceOf(wallet.address);
  const tokenAmountRaw = balAfter - balBefore;
  if (tokenAmountRaw <= 0n) {
    throw new SwapDeliveredNothingError(
      `Buy tx confirmed but no tokens received (token blocks delivery on purchase — likely a honeypot): ${receipt.hash}`
    );
  }

  const tokenAmountHuman = Number(tokenAmountRaw) / 10 ** Number(decimals);
  const gasUsd = Number(formatEther(receipt.gasUsed * receipt.gasPrice)) * nativeUsdPrice;
  const usdSpent = nativeAmount * nativeUsdPrice;

  return {
    txHash: receipt.hash,
    tokenAmountRaw: tokenAmountRaw.toString(),
    nativeSpent: nativeAmount,
    gasUsd,
    entryPriceUsd: usdSpent / tokenAmountHuman,
    usdSpent,
  };
}

// Buys `usdAmount` worth of tokenAddress with native currency — used by the
// automated pipeline. Returns the actual on-chain results (never estimates)
// — token amount received is measured via balance-before/after.
export async function buyToken(chain, tokenAddress, usdAmount, slippageBps) {
  if (usdAmount > ABSOLUTE_MAX_USD_PER_TRADE) {
    throw new Error(`Refusing to buy $${usdAmount} — exceeds hard safety ceiling of $${ABSOLUTE_MAX_USD_PER_TRADE}/trade`);
  }
  const { pair, dexPair, nativeUsdPrice } = await currentNativeUsdPrice(chain, tokenAddress);
  return executeBuy(chain, tokenAddress, usdAmount / nativeUsdPrice, nativeUsdPrice, slippageBps, pair, dexPair);
}

// Buys an exact native-currency amount of tokenAddress — used by the manual
// trading terminal, where the human specifies "0.01 ETH" directly rather
// than a USD target.
export async function buyTokenWithNativeAmount(chain, tokenAddress, nativeAmount, slippageBps) {
  if (nativeAmount > ABSOLUTE_MAX_NATIVE_PER_MANUAL_TRADE) {
    throw new Error(`Refusing to buy ${nativeAmount} ${chain.nativeSymbol} — exceeds manual-trade safety ceiling of ${ABSOLUTE_MAX_NATIVE_PER_MANUAL_TRADE} ${chain.nativeSymbol}`);
  }
  const { pair, dexPair, nativeUsdPrice } = await currentNativeUsdPrice(chain, tokenAddress);
  return executeBuy(chain, tokenAddress, nativeAmount, nativeUsdPrice, slippageBps, pair, dexPair);
}

// Sells the full given raw token amount back to native currency. Handles
// the ERC20 approval step itself if the router doesn't already have
// sufficient allowance.
export async function sellToken(chain, tokenAddress, tokenAmountRaw, slippageBps) {
  const wallet = requireWallet(chain);
  // Unlike buys (which need nativeUsdPrice to convert a USD target into a
  // native amount up front), a sell already knows the exact token amount to
  // move — a missing/broken DexScreener price shouldn't block the attempt
  // entirely, only degrade the pricing source (on-chain quoter/getAmountsOut
  // still work fine without it). This matters most for exactly the case
  // that needs graceful handling least: a forced exit on a position whose
  // pool has gone quiet enough that DexScreener has nothing sane to report
  // — without this, the forced-exit attempt would fail here every time,
  // before ever reaching the on-chain swap logic that could actually work.
  let pair = null,
    dexPair = null,
    nativeUsdPrice = null;
  try {
    ({ pair, dexPair, nativeUsdPrice } = await currentNativeUsdPrice(chain, tokenAddress));
  } catch {
    // best-effort — proceed with on-chain-only pricing below
  }

  const token = new Contract(tokenAddress, ERC20_ABI, wallet);
  const amountIn = BigInt(tokenAmountRaw);

  let totalGasWei = 0n;
  let nativeReceived;
  let txHash;

  const v3Pool = await findV3Pool(chain, dexPair);

  if (v3Pool) {
    const router = new Contract(chain.v3RouterAddress, V3_ROUTER_ABI, wallet);
    const weth = new Contract(chain.wrappedNative, WETH_ABI, wallet);

    const allowance = await token.allowance(wallet.address, chain.v3RouterAddress);
    if (allowance < amountIn) {
      const approveTx = await token.approve(chain.v3RouterAddress, MaxUint256);
      const approveReceipt = await approveTx.wait();
      if (approveReceipt.status !== 1) throw new Error(`Approve transaction reverted: ${approveReceipt.hash}`);
      totalGasWei += approveReceipt.gasUsed * approveReceipt.gasPrice;
    }

    const onChainQuote = await getV3Quote(chain, tokenAddress, chain.wrappedNative, v3Pool.fee, amountIn);
    let expectedNativeOutWei;
    if (onChainQuote != null) {
      expectedNativeOutWei = onChainQuote;
    } else if (pair && nativeUsdPrice) {
      // No verified quoter for this chain — fall back to DexScreener's live
      // spot price (the same price source this bot already trusts elsewhere).
      const decimals = await token.decimals();
      const amountInHuman = Number(amountIn) / 10 ** Number(decimals);
      const expectedNativeOut = (amountInHuman * pair.priceUsd) / nativeUsdPrice;
      expectedNativeOutWei = parseEther(Math.max(0, expectedNativeOut).toFixed(18));
    } else {
      // Neither an on-chain quote nor DexScreener data is available. This
      // only happens on a best-effort exit (see the try/catch above) — the
      // alternative to accepting zero slippage protection here is leaving
      // the position stuck with no exit path at all, which is worse.
      expectedNativeOutWei = 0n;
    }
    const minOut = (expectedNativeOutWei * BigInt(10000 - slippageBps)) / 10000n;

    // exactInputSingle delivers WETH (not native ETH) to recipient — unwrap
    // it ourselves via WETH9's withdraw() right after.
    const wethBalBefore = await weth.balanceOf(wallet.address);
    const swapTx = await router.exactInputSingle({
      tokenIn: tokenAddress,
      tokenOut: chain.wrappedNative,
      fee: v3Pool.fee,
      recipient: wallet.address,
      amountIn,
      amountOutMinimum: minOut,
      sqrtPriceLimitX96: 0,
    });
    const swapReceipt = await swapTx.wait();
    if (swapReceipt.status !== 1) throw new Error(`Sell transaction reverted: ${swapReceipt.hash}`);
    totalGasWei += swapReceipt.gasUsed * swapReceipt.gasPrice;
    txHash = swapReceipt.hash;

    const wethBalAfter = await weth.balanceOf(wallet.address);
    const wethReceived = wethBalAfter - wethBalBefore;
    if (wethReceived <= 0n) {
      throw new SwapDeliveredNothingError(
        `Sell tx confirmed but no WETH received (token blocks delivery on sale — likely a honeypot): ${swapReceipt.hash}`
      );
    }

    const unwrapTx = await weth.withdraw(wethReceived);
    const unwrapReceipt = await unwrapTx.wait();
    if (unwrapReceipt.status !== 1) throw new Error(`WETH unwrap reverted: ${unwrapReceipt.hash}`);
    totalGasWei += unwrapReceipt.gasUsed * unwrapReceipt.gasPrice;

    nativeReceived = Number(formatEther(wethReceived));
  } else {
    const router = new Contract(chain.routerAddress, ROUTER_ABI, wallet);
    const path = [tokenAddress, chain.wrappedNative];

    const allowance = await token.allowance(wallet.address, chain.routerAddress);
    if (allowance < amountIn) {
      const approveTx = await token.approve(chain.routerAddress, MaxUint256);
      const approveReceipt = await approveTx.wait();
      if (approveReceipt.status !== 1) throw new Error(`Approve transaction reverted: ${approveReceipt.hash}`);
      totalGasWei += approveReceipt.gasUsed * approveReceipt.gasPrice;
    }

    const amountsOut = await router.getAmountsOut(amountIn, path);
    const expectedOut = amountsOut[amountsOut.length - 1];
    const minOut = (expectedOut * BigInt(10000 - slippageBps)) / 10000n;

    const nativeBalBefore = await wallet.provider.getBalance(wallet.address);

    const tx = await router.swapExactTokensForETHSupportingFeeOnTransferTokens(
      amountIn,
      minOut,
      path,
      wallet.address,
      Math.floor(Date.now() / 1000) + DEADLINE_SECONDS
    );
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error(`Sell transaction reverted: ${receipt.hash}`);
    totalGasWei += receipt.gasUsed * receipt.gasPrice;
    txHash = receipt.hash;

    const nativeBalAfter = await wallet.provider.getBalance(wallet.address);
    // Balance delta already nets out this tx's own gas cost (paid from the
    // same balance), so add the gas back to isolate the actual swap proceeds.
    const proceedsWei = nativeBalAfter - nativeBalBefore + receipt.gasUsed * receipt.gasPrice;
    // The V3 branch above already checked this (a confirmed swap that
    // delivers zero of the expected side is a honeypot symptom, not a
    // slippage problem) — this branch had no equivalent check at all before,
    // silently recording a $0-proceeds close instead of recognizing the
    // pattern and refusing to retry it.
    if (proceedsWei <= 0n) {
      throw new SwapDeliveredNothingError(
        `Sell tx confirmed but no native currency received (token blocks delivery on sale — likely a honeypot): ${receipt.hash}`
      );
    }
    nativeReceived = Number(formatEther(proceedsWei));
  }

  // nativeUsdPrice can be null on a best-effort exit with no price source at
  // all (see the try/catch at the top) — fall back to 0 rather than NaN so
  // callers' PnL math stays a number (an understated/zero USD value here,
  // not a crash) on what's already a degraded-pricing emergency exit.
  const gasUsd = nativeUsdPrice != null ? Number(formatEther(totalGasWei)) * nativeUsdPrice : 0;

  return {
    txHash,
    nativeReceived,
    gasUsd,
    // Total USD value of what the sell actually returned — NOT a per-token
    // price (there's no clean "price per token" here since fee-on-transfer
    // tokens can deliver less than amountIn implies). Callers computing PnL
    // should use this against the total position size, not per-token math.
    proceedsUsd: nativeUsdPrice != null ? nativeReceived * nativeUsdPrice : 0,
  };
}
