import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

const MODEL = "claude-haiku-4-5";

// Distinct from rugDetector.js (Groq) — that screens name/symbol/deployer
// text patterns fast and cheap on every call. This runs on the quantitative
// on-chain signals (liquidity, volume, LP-lock) with real backtested base
// rates as grounding context, catching combinations a fixed numeric
// threshold can't express. Groq keeps its existing job unchanged; this is an
// additional layer, not a replacement.
const client = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;

// Baseline numbers from scripts/collectRugDataset.js + backtestLpLock.js —
// 530 real historical Robinhood Chain launches, archive-state-verified
// reserve trajectories. Update this comment (and the prompt below) if the
// study is ever re-run with fresh data.
const SYSTEM_PROMPT = `You assess rug-pull risk for a newly launched token on Robinhood Chain, immediately before a
trading bot decides whether to call/buy it. This chain is unusually risky: a backtest of 530 real historical
launches (reconstructed directly from on-chain archive state, launch reserves vs current reserves) found an
83.6% base rate of pools losing effectively all liquidity, and this held true across every launch-liquidity
size bucket — bigger initial pools were not meaningfully safer. LP-lock status at launch is a real but weak
signal: locked/burned LP pools still failed 70.4% of the time vs 88.2% for unlocked, because organic sell
pressure alone can drain a pool's native-asset reserves even when the LP itself can't be pulled.

Given this, your job is NOT to find "safe" tokens — very few exist by this chain's numbers, and a token merely
matching the general baseline risk of this chain is not something to flag, since that risk is already priced
into every other filter this token had to pass to reach you. Your job is to flag when a SPECIFIC token looks
unusually risky even by this chain's already-poor standard: signals stacking worse than the baseline (e.g.
unlocked LP combined with volume that looks wash-traded relative to liquidity, or a thin/manipulated-looking
liquidity-to-market-cap ratio), or a name/symbol that's an exact or near-exact clone of another known token
(classic copycat-rug setup). Judge only the information given — you have no other context.

Respond with ONLY a JSON object of the exact shape: {"riskLevel": "baseline" | "elevated" | "severe", "reasoning": string}.
Use "severe" sparingly — only when you'd genuinely expect this specific token to underperform even this chain's
83.6% base rug rate. Most tokens should come back "baseline" or "elevated".`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    riskLevel: { type: "string", enum: ["baseline", "elevated", "severe"] },
    reasoning: { type: "string", description: "brief explanation for the assessment" },
  },
  required: ["riskLevel", "reasoning"],
  additionalProperties: false,
};

function formatLpLock(lpLock) {
  if (!lpLock) return "unknown (no on-chain data available yet)";
  return `${(lpLock.lockedFraction * 100).toFixed(0)}% locked/burned (${lpLock.isLocked ? "locked" : "unlocked"})`;
}

// Gracefully defaults to "baseline" (never blocks a call) if no API key is
// configured or the request fails — this is an additional signal on top of
// the numeric filters and LP-lock gate, not a hard dependency for those to
// keep working.
export async function analyzeRugRisk({ name, symbol, chain, ageMinutes, liquidityUsd, marketCapUsd, volume24hUsd, lpLock, groqVerdict }) {
  if (!client) return { riskLevel: "baseline", reasoning: null };

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: "json_schema", schema: RESPONSE_SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            `Chain: ${chain}`,
            `Token name: ${name || "(unknown)"}`,
            `Symbol: ${symbol || "(unknown)"}`,
            `Age: ${ageMinutes != null ? `${ageMinutes.toFixed(0)} minutes` : "unknown"}`,
            `Liquidity: $${(liquidityUsd || 0).toFixed(0)}`,
            `Market cap: $${(marketCapUsd || 0).toFixed(0)}`,
            `24h volume: $${(volume24hUsd || 0).toFixed(0)}`,
            `LP lock status: ${formatLpLock(lpLock)}`,
            groqVerdict?.reasoning ? `Name/pattern screen flagged: ${groqVerdict.reasoning}` : null,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      console.error("[rugAnalyst] Claude declined the request, defaulting to baseline");
      return { riskLevel: "baseline", reasoning: null };
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return { riskLevel: "baseline", reasoning: null };

    const parsed = JSON.parse(textBlock.text);
    const riskLevel = ["baseline", "elevated", "severe"].includes(parsed.riskLevel) ? parsed.riskLevel : "baseline";
    return { riskLevel, reasoning: parsed.reasoning || null };
  } catch (err) {
    console.error("[rugAnalyst] AI analysis failed, defaulting to baseline:", err.message);
    return { riskLevel: "baseline", reasoning: null };
  }
}
