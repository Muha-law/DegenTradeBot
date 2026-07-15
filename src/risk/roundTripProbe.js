import { Interface, parseEther } from "ethers";
import { getProvider } from "../wallet.js";
import { roundTripProbeAbi, roundTripProbeBytecode } from "./roundTripProbeArtifact.js";

// Catches what probeSellability (sellability.js) structurally can't: a
// honeypot that taxes/burns almost the entire sale instead of reverting it.
// A plain staticCall of transfer() only tells us whether the call reverted —
// it can't see how many tokens actually landed, so a 100%-sell-tax token
// (transfer succeeds, value just evaporates) sails straight through it.
// Confirmed real motivation: MNEMO/Robinhood Chain — a third-party bot's own
// buy+sell simulation printed "Tax: S 100%" and flagged it a honeypot; our
// existing pre-buy checks had no equivalent for this chain (GoPlus doesn't
// cover Robinhood Chain at all, so there's no sell_tax field to read either).
//
// Technique: plant RoundTripProbe's bytecode + a scratch native-currency
// balance at a throwaway address via eth_call's state-override param, then
// call its probe() function, which really executes buy-then-sell through the
// live router in one atomic call. Every tax/fee/blacklist mechanism the
// token's own code implements applies exactly as it would for a real trade —
// there's no need to guess the token's storage layout (unlike faking a
// balance/allowance directly), because the tokens the probe sells are ones
// it just genuinely received from a real simulated buy.
//
// Only supports V2-style routers for now (swapExactETHForTokens... /
// swapExactTokensForETH...) — new-launch tokens overwhelmingly start there.
// V3-only pairs aren't probed; caller should treat honeypot: null as
// "unknown", never as "safe", same convention as probeSellability.

const SCRATCH_ADDRESS = "0x0000000000000000000000000000000000000f00";
// Round-trip loss floor to call it a honeypot. Deliberately well above
// normal LP fee (~0.25-0.3%) plus a modest allowance for price impact on
// thin liquidity — legitimate tokens with a marketing/reflection tax rarely
// exceed 10-15% each way (~25% round trip); a honeypot's sell-side tax is
// typically total or near-total.
const HONEYPOT_ROUND_TRIP_LOSS = 0.6;
// Small enough that price impact on a thin-but-real pool doesn't itself
// manufacture a false positive, large enough that rounding/dust doesn't
// swamp the result.
const PROBE_AMOUNT_NATIVE = "0.003";

// Returns:
//   { tested: true, honeypot: true|false, roundTripLossPct, nativeIn, nativeOut }
//   { tested: false, honeypot: null, reason }   — not enough support / lookup failed
// honeypot: null must be treated as "unknown", never as "safe".
export async function probeRoundTripTax(chain, tokenAddress) {
  if (!chain.routerAddress) return { tested: false, honeypot: null, reason: "No V2 router configured for this chain" };

  try {
    const provider = getProvider(chain);
    const iface = new Interface(roundTripProbeAbi);
    const amountIn = parseEther(PROBE_AMOUNT_NATIVE);

    const data = iface.encodeFunctionData("probe", [chain.routerAddress, chain.wrappedNative, tokenAddress, amountIn]);

    const result = await provider.send("eth_call", [
      { to: SCRATCH_ADDRESS, data },
      "latest",
      {
        [SCRATCH_ADDRESS]: {
          code: roundTripProbeBytecode,
          balance: "0x" + amountIn.toString(16),
        },
      },
    ]);

    const [buyOk, tokensReceived, sellOk, nativeReceived] = iface.decodeFunctionResult("probe", result);

    if (!buyOk) {
      return { tested: false, honeypot: null, reason: "Simulated buy leg reverted (unrelated to sell-side honeypot behavior)" };
    }
    if (tokensReceived === 0n) {
      return { tested: true, honeypot: null, reason: "Simulated buy leg returned zero tokens (no liquidity path?)" };
    }
    if (!sellOk) {
      // Real tokens were acquired via a real simulated buy, and the sell
      // leg failed outright — about as unambiguous a honeypot signal as
      // exists, distinct from the percentage-based tax check below.
      return { tested: true, honeypot: true, reason: "Sell leg reverted outright after a successful buy" };
    }

    const nativeOut = Number(nativeReceived) / 1e18;
    const nativeIn = Number(amountIn) / 1e18;
    const roundTripLossPct = 1 - nativeOut / nativeIn;

    return {
      tested: true,
      honeypot: roundTripLossPct >= HONEYPOT_ROUND_TRIP_LOSS,
      roundTripLossPct,
      nativeIn,
      nativeOut,
    };
  } catch (err) {
    // Only infra-level failures land here now (the contract itself no
    // longer lets either leg's revert propagate) — an RPC hiccup or a chain
    // whose node doesn't support state overrides, not honeypot evidence.
    return { tested: false, honeypot: null, reason: `Probe failed: ${err.message}` };
  }
}
