import "dotenv/config";

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const primaryChatId = required("TELEGRAM_CHAT_ID");
// Extra broadcast destinations (channels, other groups) — comma separated,
// e.g. "@superalphachannel,@anotherchannel". The bot must already be an
// admin with post permission in each. Signals go to all of these plus the
// primary chat.
const extraDestinations = (process.env.TELEGRAM_SIGNAL_CHANNELS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// A separate, narrower broadcast list from the one above — only postCall()
// sends here, i.e. only tokens that passed every guardrail (filters,
// selective-honeypot probe, optional AI screens), not trade updates, errors,
// or anything else broadcast() carries. Meant for a public-facing
// channel/group meant to be shared, additive to the primary chat.
const callsChannels = (process.env.TELEGRAM_CALLS_CHANNELS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const config = {
  telegram: {
    botToken: required("TELEGRAM_BOT_TOKEN"),
    chatId: primaryChatId,
    destinations: [primaryChatId, ...extraDestinations],
    // Signal channels alone, without the primary chat — needed wherever a
    // message must reach shared destinations but explicitly NOT duplicate to
    // the primary chat (e.g. postCall's admin-only eligibility note, which
    // sends to chatId separately with extra detail signal channels don't get).
    signalChannels: extraDestinations,
    callsChannels,
    adminUserId: process.env.ADMIN_USER_ID ? String(process.env.ADMIN_USER_ID) : null,
  },
  // Active chains are managed dynamically — see chainSettings.js.
  etherscanApiKey: process.env.ETHERSCAN_API_KEY || null,
  groqApiKey: process.env.GROQ_API_KEY || null,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
  goplusAppKey: process.env.GOPLUS_APP_KEY || null,
  goplusAppSecret: process.env.GOPLUS_APP_SECRET || null,
  openseaApiKey: process.env.OPENSEA_API_KEY || null,
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY || null,
  realTradingPasscode: process.env.REAL_TRADING_PASSCODE || null,
  priceUpdateIntervalMinutes: Number(process.env.PRICE_UPDATE_INTERVAL_MINUTES || 10),
  priceUpdateWindowHours: Number(process.env.PRICE_UPDATE_WINDOW_HOURS || 6),
};

export function getRpcUrl(chain) {
  return required(chain.wssEnvVar);
}
