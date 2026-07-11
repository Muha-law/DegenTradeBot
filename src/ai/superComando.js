import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

const MODEL = "claude-haiku-4-5";

// Cheap, throttled (once per 5m per riding position — see paperTrading.js /
// realTrading.js) exit-decision calls. Not latency-sensitive like
// rugDetector's buy-path screen, so this runs on Claude instead of Groq —
// better judgment on "is this a reversal or normal noise" for a real-money
// decision, at negligible cost for this call volume.
const client = config.anthropicApiKey ? new Anthropic({ apiKey: config.anthropicApiKey }) : null;

const SYSTEM_PROMPT = `You help decide whether to sell a crypto paper-trading position that has already blown past its
normal take-profit target and is being held longer in hopes of a bigger run ("let it ride" mode, nicknamed
Super Comando). You'll be given the current PnL%, the peak PnL% reached so far, the protected floor (the position
sells automatically the moment PnL% drops below this, independent of you — you don't need to protect against a
total reversal, that's already handled), and how long it's been riding.

Decide whether to SELL NOW (lock in the current gain) or KEEP HOLDING (let it keep trying to run further).
Lean toward selling when: price has pulled back meaningfully from its peak (lost a large share of the peak gain),
it has been riding a long time without setting new highs (momentum stalling), or the pullback from peak looks like
a reversal starting rather than normal volatility.
Lean toward holding when: price is at or near its peak, or the pullback from peak is small and looks like normal
noise rather than a trend change.`;

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    sell: { type: "boolean", description: "true to sell now, false to keep holding" },
    reasoning: { type: "string", description: "brief explanation for the decision" },
  },
  required: ["sell", "reasoning"],
  additionalProperties: false,
};

// Advises whether to exit a paper trade that's already past its take-profit
// target and being held longer (Super Comando mode). Gracefully defaults to
// "keep holding" if no API key is configured or the request fails — the
// floor-protection rule in paperTrading.js is the actual safety net, so a
// missed AI check just costs one data point, not real risk.
export async function shouldExitMooner({ symbol, name, pnlPct, peakPct, floorPct, minutesHeld }) {
  if (!client) return { sell: false, reasoning: null };

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 250,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: "json_schema", schema: RESPONSE_SCHEMA } },
      messages: [
        {
          role: "user",
          content: `Token: ${name || "Unknown"} (${symbol || "?"})\nCurrent PnL: +${pnlPct.toFixed(1)}%\nPeak PnL so far: +${peakPct.toFixed(1)}%\nProtected floor (auto-sells below this): +${floorPct.toFixed(1)}%\nRiding for: ${minutesHeld.toFixed(0)} minutes since crossing the floor`,
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      console.error("[superComando] Claude declined the request, holding");
      return { sell: false, reasoning: null };
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return { sell: false, reasoning: null };

    const parsed = JSON.parse(textBlock.text);
    return { sell: Boolean(parsed.sell), reasoning: parsed.reasoning || null };
  } catch (err) {
    console.error("[superComando] AI exit check failed, holding:", err.message);
    return { sell: false, reasoning: null };
  }
}
