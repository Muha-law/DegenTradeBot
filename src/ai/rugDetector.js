import { config } from "../config.js";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
// 8B model: plenty capable for a short classification call like this, and
// the free tier gives it ~5x the daily headroom of the 70B model (14.4K
// req/day + 500K tokens/day vs 1K req/day + 100K tokens/day) — worth more
// here than the extra size, since this task doesn't need deep reasoning.
const GROQ_MODEL = "llama-3.1-8b-instant";

const SYSTEM_PROMPT = `You screen newly launched crypto tokens for scam/rug-pull patterns before a trading bot calls them.
Judge only the information given to you — you have no other context.
Flag as suspicious: names/symbols impersonating well-known tokens or brands (fake wrapped/bridged versions,
lookalike tickers with swapped characters), overt scam language ("guaranteed", "1000x", "presale", "airdrop claim"),
or a deployer address pattern that looks auto-generated for spam (rare — usually you can't tell from the address alone,
so don't flag on deployer address unless something else about the name/symbol is already suspicious).
Do not flag a token merely for having a generic, meme-y, or joke name — most legitimate degen tokens look exactly like that.
Only flag when there's a specific, nameable red flag.

If one or more "namesake" tokens are listed — prior calls with the exact same name but a different contract
address on the same chain — weigh whether this new token is likely a copycat cashing in on a name that already
pumped (classic scam pattern: clone a trending name right after it moves, hoping buyers ape the wrong contract).
Signals that raise suspicion: a namesake is already up significantly and this new one appeared shortly after;
multiple prior namesakes exist (a name that's been cloned repeatedly). Signals that lower suspicion: this is the
only namesake so far, or prior namesakes performed poorly/flat (less incentive to clone a loser). A second launch
by the same original team after a failed first attempt is plausible and not inherently suspicious on its own —
only flag the namesake angle when the pattern actually looks exploitative, not just "a name repeats."

Respond with ONLY a JSON object of the exact shape: {"suspicious": boolean, "reasoning": string}. No other text.`;

function formatNamesakes(namesakes) {
  if (!namesakes || namesakes.length === 0) return "";
  const lines = namesakes.map((n, i) => {
    const pct = n.pctChangeSinceCall != null ? `${n.pctChangeSinceCall >= 0 ? "+" : ""}${n.pctChangeSinceCall.toFixed(0)}%` : "unknown";
    const ageHrs = ((Date.now() - n.calledAt) / 3_600_000).toFixed(1);
    return `  ${i + 1}. CA ${n.tokenAddress}, called ${ageHrs}h ago, performance since call: ${pct}`;
  });
  return `\n\nNamesake tokens (same name, different CA, same chain):\n${lines.join("\n")}`;
}

// Screens a token's name/symbol/deployer for scam patterns via Groq (free
// tier, OpenAI-compatible chat completions API). Gracefully no-ops (never
// blocks a call) if no API key is configured or the request fails for any
// reason — this is an extra signal, not a hard dependency. Pass `namesakes`
// (prior same-name calls on this chain, from findRecentCallsByName) to have
// the AI weigh a possible copycat pattern alongside the base scam screen.
export async function screenForRugPatterns({ name, symbol, deployerAddress, chain, namesakes }) {
  if (!config.groqApiKey) return { suspicious: false, reasoning: null };

  try {
    const res = await fetch(GROQ_API_URL, {
      method: "POST",
      signal: AbortSignal.timeout(20000),
      headers: {
        Authorization: `Bearer ${config.groqApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 300,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Chain: ${chain}\nToken name: ${name || "(unknown)"}\nSymbol: ${symbol || "(unknown)"}\nDeployer address: ${deployerAddress || "(unknown)"}${formatNamesakes(namesakes)}`,
          },
        ],
      }),
    });

    if (!res.ok) {
      console.error(`[rugDetector] Groq API error ${res.status}: ${await res.text()}`);
      return { suspicious: false, reasoning: null };
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return { suspicious: false, reasoning: null };

    const parsed = JSON.parse(content);
    return { suspicious: Boolean(parsed.suspicious), reasoning: parsed.reasoning || null };
  } catch (err) {
    console.error("[rugDetector] AI screen failed, skipping:", err.message);
    return { suspicious: false, reasoning: null };
  }
}
