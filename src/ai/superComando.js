import { config } from "../config.js";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";

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
noise rather than a trend change.

Respond with ONLY a JSON object of the exact shape: {"sell": boolean, "reasoning": string}. No other text.`;

// Advises whether to exit a paper trade that's already past its take-profit
// target and being held longer (Super Comando mode). Gracefully defaults to
// "keep holding" if no API key is configured or the request fails — the
// floor-protection rule in paperTrading.js is the actual safety net, so a
// missed AI check just costs one data point, not real risk.
export async function shouldExitMooner({ symbol, name, pnlPct, peakPct, floorPct, minutesHeld }) {
  if (!config.groqApiKey) return { sell: false, reasoning: null };

  try {
    const res = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.groqApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 250,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Token: ${name || "Unknown"} (${symbol || "?"})\nCurrent PnL: +${pnlPct.toFixed(1)}%\nPeak PnL so far: +${peakPct.toFixed(1)}%\nProtected floor (auto-sells below this): +${floorPct.toFixed(1)}%\nRiding for: ${minutesHeld.toFixed(0)} minutes since crossing the floor`,
          },
        ],
      }),
    });

    if (!res.ok) {
      console.error(`[superComando] Groq API error ${res.status}: ${await res.text()}`);
      return { sell: false, reasoning: null };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { sell: false, reasoning: null };

    const parsed = JSON.parse(content);
    return { sell: Boolean(parsed.sell), reasoning: parsed.reasoning || null };
  } catch (err) {
    console.error("[superComando] AI exit check failed, holding:", err.message);
    return { sell: false, reasoning: null };
  }
}
