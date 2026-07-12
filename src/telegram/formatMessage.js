import { CHAINS } from "../chains.js";

const explorerUrls = {
  ethereum: (addr) => `https://etherscan.io/token/${addr}`,
  base: (addr) => `https://basescan.org/token/${addr}`,
  bsc: (addr) => `https://bscscan.com/token/${addr}`,
  arbitrum: (addr) => `https://arbiscan.io/token/${addr}`,
  // Robinhood Chain's official explorer — Blockscout-powered, confirmed live.
  robinhood: (addr) => `https://robinhoodchain.blockscout.com/address/${addr}`,
};

export function explorerUrlFor(chainKey, addr) {
  return explorerUrls[chainKey]?.(addr) || null;
}

const gradeEmoji = { A: "🟢", B: "🟩", C: "🟡", D: "🟠", F: "🔴" };

// Legacy Telegram Markdown treats _, *, `, [ as entity delimiters — an odd
// count of any of them (common in on-chain token symbols and raw error
// text, both outside our control) leaves an entity unclosed and Telegram
// rejects the whole message with "can't parse entities", silently dropping
// it. Escape before interpolating any attacker/environment-controlled text.
export function escapeMd(str) {
  if (!str) return str;
  return String(str).replace(/([_*`[])/g, "\\$1");
}

export function fmtUsd(n) {
  if (!n) return "$0";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

export function fmtPrice(n) {
  if (!n || !Number.isFinite(n) || n > 1e12) return "n/a"; // guards against bad historical data
  if (n < 0.0001) return n.toExponential(2);
  return n.toFixed(6);
}

const SUBSCRIPT_DIGITS = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];
function toSubscript(n) {
  return String(n)
    .split("")
    .map((d) => SUBSCRIPT_DIGITS[Number(d)])
    .join("");
}

// Bonk-Bot-style tiny-price display: $0.0₄339 for 0.0000339 — compresses a
// long run of leading zeros into a subscript count instead of forcing the
// reader to count digits or parse exponential notation.
export function fmtPriceCompact(n) {
  if (!n || !Number.isFinite(n) || n <= 0 || n > 1e12) return "n/a";
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;

  const str = n.toFixed(18);
  const afterDecimal = str.split(".")[1] || "";
  let zeroCount = 0;
  while (afterDecimal[zeroCount] === "0") zeroCount++;
  const sigDigits = afterDecimal.slice(zeroCount, zeroCount + 3);
  if (zeroCount < 2) return `$0.${afterDecimal.slice(0, zeroCount + 3)}`;
  return `$0.0${toSubscript(zeroCount)}${sigDigits}`;
}

function fireEmoji(multiplier) {
  if (multiplier >= 10) return "🔥🔥🔥🔥🔥";
  if (multiplier >= 5) return "🔥🔥🔥🔥";
  if (multiplier >= 3) return "🔥🔥🔥";
  if (multiplier >= 2) return "🔥🔥";
  if (multiplier >= 1.2) return "🔥";
  return "";
}

// "34m ago" / "2h 15m ago" / "3d ago" — used in milestone/follow-up/alert
// headlines so a reader can judge momentum without checking a separate
// timestamp. sinceMs is a Date.now()-style epoch ms timestamp.
function timeAgo(sinceMs) {
  if (!sinceMs) return null;
  const elapsedMin = Math.max(0, Math.floor((Date.now() - sinceMs) / 60000));
  if (elapsedMin < 1) return "just now";
  if (elapsedMin < 60) return `${elapsedMin}m ago`;
  const hours = Math.floor(elapsedMin / 60);
  const mins = elapsedMin % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m ago` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function buildCallMessage({ chain, tokenAddress, riskResult, name, symbol }) {
  const { score, grade, label, breakdown, flags, pair } = riskResult;
  const explorer = explorerUrls[chain.key]?.(tokenAddress);
  const dexUrl = pair?.pairUrl || `https://dexscreener.com/${chain.dexscreenerChainId}/${tokenAddress}`;

  const lines = [
    `📣 *NEW CALL* — ${name || "Unknown"} (${symbol || "?"}) on ${chain.label}`,
    "",
    `${gradeEmoji[grade]} *Risk Score: ${score}/100 — ${grade} (${label})*`,
    `  • Contract safety: ${breakdown.contractSafety}/35`,
    `  • Liquidity & lock: ${breakdown.liquidityLock}/25`,
    `  • Holder distribution: ${breakdown.holderDistribution}/20`,
    `  • Deployer history: ${breakdown.deployerHistory}/20`,
    "",
    `💰 Price: $${fmtPrice(pair?.priceUsd)}`,
    `💧 Liquidity: ${fmtUsd(pair?.liquidityUsd)}`,
    `🏷️ Market Cap: ${fmtUsd(pair?.marketCapUsd)}`,
    `📊 24h Volume: ${fmtUsd(pair?.volume24h)}`,
  ];

  if (flags.length) {
    lines.push("", "⚠️ *Flags:*", ...flags.slice(0, 6).map((f) => `  • ${f}`));
  }

  lines.push(
    "",
    `\`${tokenAddress}\``,
    [explorer && `[Explorer](${explorer})`, `[DexScreener](${dexUrl})`].filter(Boolean).join(" | ")
  );

  return lines.join("\n");
}

export function buildMilestoneMessage({
  chain,
  tokenAddress,
  name,
  symbol,
  trackPriceUsd,
  trackMarketCapUsd,
  currentPair,
  milestonePct,
  sinceMs,
}) {
  const currentPrice = currentPair?.priceUsd || 0;
  const currentMcap = currentPair?.marketCapUsd || 0;
  const multiplier = trackPriceUsd > 0 ? currentPrice / trackPriceUsd : 1;
  const fire = fireEmoji(multiplier);
  const ago = timeAgo(sinceMs);

  const lines = [
    `${fire ? fire + " " : "🚀 "}#${symbol || "?"} up ${milestonePct}%+ since tracked${ago ? ` ${ago}` : ""} (${multiplier.toFixed(2)}x)`,
    `${name || "Unknown"} on ${chain.label}`,
  ];

  if (trackMarketCapUsd && currentMcap) {
    lines.push(`💰 ${fmtUsd(trackMarketCapUsd)} → ${fmtUsd(currentMcap)}`);
  }

  lines.push(
    "",
    `Tracked at: $${fmtPrice(trackPriceUsd)}`,
    `Now: $${fmtPrice(currentPrice)}`,
    "",
    `\`${tokenAddress}\``
  );

  return lines.join("\n");
}

export function buildTrackAlertMessage({ chain, tokenAddress, name, symbol, trackPriceUsd, currentPair, kind, sinceMs }) {
  const currentPrice = currentPair?.priceUsd || 0;
  const pct = trackPriceUsd > 0 ? ((currentPrice - trackPriceUsd) / trackPriceUsd) * 100 : 0;
  const ago = timeAgo(sinceMs);
  const agoSuffix = ago ? ` ${ago}` : "";
  const headline =
    kind === "dead"
      ? `💀 #${symbol || "?"} looks dead — down ${Math.abs(pct).toFixed(0)}% since tracked${agoSuffix}`
      : `🔴 #${symbol || "?"} down ${Math.abs(pct).toFixed(0)}% since tracked${agoSuffix}`;

  return [
    headline,
    `${name || "Unknown"} on ${chain.label}`,
    "",
    `Tracked at: $${fmtPrice(trackPriceUsd)}`,
    `Now: $${fmtPrice(currentPrice)}`,
    "",
    `\`${tokenAddress}\``,
  ].join("\n");
}

// After the first milestone, a token gets re-announced every digest cycle
// only if it moved meaningfully since the last individual message — this is
// that "moved X since last time" alert, distinct from a round-number milestone.
export function buildFollowUpMessage({ chain, tokenAddress, name, symbol, callPriceUsd, currentPair, lastPct, currentPct, sinceMs }) {
  const currentPrice = currentPair?.priceUsd || 0;
  const multiplier = 1 + currentPct / 100;
  const fire = fireEmoji(multiplier);
  const arrow = currentPct >= lastPct ? "🟢▲" : "🔴▼";
  const ago = timeAgo(sinceMs);

  return [
    `${fire ? fire + " " : arrow + " "}#${symbol || "?"} now ${currentPct >= 0 ? "+" : ""}${currentPct.toFixed(0)}% since call${ago ? ` ${ago}` : ""} (was ${
      lastPct >= 0 ? "+" : ""
    }${lastPct.toFixed(0)}%)`,
    `${name || "Unknown"} on ${chain.label}`,
    "",
    `Call price: $${fmtPrice(callPriceUsd)}`,
    `Current price: $${fmtPrice(currentPrice)}`,
    "",
    `\`${tokenAddress}\``,
  ].join("\n");
}

// 20 per page keeps each message well under Telegram's 4096-char cap and
// readable — the bot's Watchlist view pages through the rest via a
// "Show More" button rather than dumping everything into one message.
export const WATCHLIST_PAGE_SIZE = 20;

// One page of the active-auto-call list, sorted by performance — used for
// the Watchlist view/button and the scheduled digest, instead of spamming
// one message per token. `offset` selects which page.
export function buildWatchlistDigest(entries, offset = 0) {
  if (entries.length === 0) return "📜 *Watchlist Update*\n\nNothing active right now.";

  const shown = entries.slice(offset, offset + WATCHLIST_PAGE_SIZE);
  const lines = shown.map((e, i) => {
    const pctLabel = e.pct === null ? "n/a" : `${e.pct >= 0 ? "🟢+" : "🔴"}${e.pct.toFixed(1)}%`;
    const priceLabel = e.currentPrice ? ` — $${fmtPrice(e.currentPrice)}` : "";
    return `${offset + i + 1}. *${e.symbol || "?"}* (${e.chain}) ${pctLabel}${priceLabel}\n   \`${e.tokenAddress}\``;
  });

  const from = offset + 1;
  const to = offset + shown.length;
  const rangeLabel = entries.length > WATCHLIST_PAGE_SIZE ? ` — showing ${from}-${to}` : "";

  return `📜 *Watchlist Update* (${entries.length})${rangeLabel}\n\n${lines.join("\n\n")}`;
}

export function buildPaperTradeOpenMessage({ chain, tokenAddress, name, symbol, entryPriceUsd, positionSizeUsd, takeProfitPct, stopLossPct }) {
  return [
    `📝 *Paper trade opened* — ${name || "Unknown"} (${symbol || "?"}) on ${chain.label}`,
    `Entry: $${fmtPrice(entryPriceUsd)} | Size: ${fmtUsd(positionSizeUsd)}`,
    `Target: +${takeProfitPct}% | Stop: ${stopLossPct}%`,
    "",
    `\`${tokenAddress}\``,
  ].join("\n");
}

const CLOSE_HEADLINES = {
  take_profit: "🎯 *Paper trade closed — TAKE PROFIT*",
  stop_loss: "🛑 *Paper trade closed — STOP LOSS*",
  comando_floor: "🪖 *Paper trade closed — SUPER COMANDO floor hit*",
  comando_ai_exit: "🪖 *Paper trade closed — SUPER COMANDO (AI call)*",
  manual_close_all: "🛑 *Paper trade closed — manual close all*",
  manual_close: "🛑 *Paper trade closed — manual*",
  // Price was unreadable/insane for a sustained period (dead pool/drained
  // liquidity) — closed as an assumed total loss rather than left stuck
  // with no way to ever trigger a stop-loss. See paperTrading.js.
  stale_price: "⚠️ *Paper trade closed — STALE PRICE (assumed worthless)*",
};

export function buildPaperTradeCloseMessage({ chain, tokenAddress, name, symbol, entryPriceUsd, exitPriceUsd, pnlUsd, pnlPct, exitReason }) {
  const won = pnlPct >= 0;
  const headline = CLOSE_HEADLINES[exitReason] || "⏱ *Paper trade closed — expired*";

  return [
    `${headline}`,
    `${name || "Unknown"} (${symbol || "?"}) on ${chain.label}`,
    `${won ? "🟢" : "🔴"} ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnlUsd >= 0 ? "+" : ""}${fmtUsd(Math.abs(pnlUsd))})`,
    "",
    `Entry: $${fmtPrice(entryPriceUsd)} | Exit: $${fmtPrice(exitPriceUsd)}`,
    "",
    `\`${tokenAddress}\``,
  ].join("\n");
}

// Sent when a trade crosses its take-profit target with Super Comando on —
// instead of the usual take-profit close, it's being let ride for a bigger
// gain, protected by a floor at the level it would otherwise have sold at.
export function buildComandoActivatedMessage({ chain, tokenAddress, name, symbol, pnlPct, floorPct }) {
  return [
    `🪖 *SUPER COMANDO activated* — letting it ride`,
    `${name || "Unknown"} (${symbol || "?"}) on ${chain.label}`,
    `Hit +${pnlPct.toFixed(1)}% — instead of taking profit, holding for more.`,
    `Protected floor: +${floorPct.toFixed(1)}% (auto-sells if it drops below this)`,
    "",
    `\`${tokenAddress}\``,
  ].join("\n");
}

const txExplorerUrls = {
  ethereum: (hash) => `https://etherscan.io/tx/${hash}`,
  base: (hash) => `https://basescan.org/tx/${hash}`,
  bsc: (hash) => `https://bscscan.com/tx/${hash}`,
  arbitrum: (hash) => `https://arbiscan.io/tx/${hash}`,
  // Robinhood Chain's block explorer URL isn't confirmed — omit the link
  // rather than guess one; the tx hash itself is still shown in the message.
};

export function buildRealTradeOpenMessage({ chain, tokenAddress, name, symbol, entryPriceUsd, positionSizeUsd, takeProfitPct, stopLossPct, txHash, gasUsd }) {
  const explorer = txExplorerUrls[chain.key]?.(txHash);
  return [
    `💰 *REAL trade opened* — ${name || "Unknown"} (${symbol || "?"}) on ${chain.label}`,
    `Entry: $${fmtPrice(entryPriceUsd)} | Size: ${fmtUsd(positionSizeUsd)} | Gas: ${fmtUsd(gasUsd)}`,
    `Target: +${takeProfitPct}% | Stop: ${stopLossPct}%`,
    "",
    `\`${tokenAddress}\``,
    explorer ? `[Transaction](${explorer})` : `Tx: \`${txHash}\``,
  ].join("\n");
}

const REAL_CLOSE_HEADLINES = {
  take_profit: "🎯 *REAL trade closed — TAKE PROFIT*",
  stop_loss: "🛑 *REAL trade closed — STOP LOSS*",
  comando_floor: "🪖 *REAL trade closed — SUPER COMANDO floor hit*",
  comando_ai_exit: "🪖 *REAL trade closed — SUPER COMANDO (AI call)*",
  manual_close_all: "🛑 *REAL trade closed — manual close all*",
  manual_sell: "🛑 *REAL trade closed — manual sell*",
  manual_close: "🛑 *REAL trade closed — manual*",
  // Price was unreadable/insane for a sustained period (dead pool/drained
  // liquidity) — the checker forced a real sell attempt anyway rather than
  // leaving the position stuck with no way to ever trigger a stop-loss.
  // Whatever came back is real proceeds, even if near zero. See realTrading.js.
  stale_price_exit: "⚠️ *REAL trade closed — STALE PRICE (forced exit)*",
  // Post-buy sellability check (verifySellable in swapExecutor.js) failed
  // immediately after purchase — likely a honeypot, exited on the spot
  // rather than waiting for the normal checker cycle to discover it.
  honeypot_immediate_exit: "🚨 *REAL trade closed — HONEYPOT (immediate exit)*",
};

export function buildRealTradeCloseMessage({ chain, tokenAddress, name, symbol, entryPriceUsd, exitPriceUsd, pnlUsd, pnlPct, exitReason, txHash, gasUsd }) {
  const won = pnlPct >= 0;
  const headline = REAL_CLOSE_HEADLINES[exitReason] || "⏱ *REAL trade closed — expired*";
  const explorer = txExplorerUrls[chain.key]?.(txHash);

  return [
    `${headline}`,
    `${name || "Unknown"} (${symbol || "?"}) on ${chain.label}`,
    `${won ? "🟢" : "🔴"} ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnlUsd >= 0 ? "+" : ""}${fmtUsd(Math.abs(pnlUsd))})`,
    `Entry: $${fmtPrice(entryPriceUsd)} | Exit: $${fmtPrice(exitPriceUsd)} | Gas: ${fmtUsd(gasUsd)}`,
    "",
    `\`${tokenAddress}\``,
    explorer ? `[Transaction](${explorer})` : `Tx: \`${txHash}\``,
  ].join("\n");
}

export function buildRealTradeFailedMessage({ chain, tokenAddress, name, symbol, reason }) {
  return [
    `⚠️ *REAL trade FAILED* — ${escapeMd(name) || "Unknown"} (${escapeMd(symbol) || "?"}) on ${chain.label}`,
    escapeMd(reason),
    "",
    `\`${tokenAddress}\``,
  ].join("\n");
}

export function buildPaperTradingSummary({ settings, stats, unrealizedPnlUsd }) {
  const lines = [
    "📈 *Paper Trading*",
    "",
    `Status: ${settings.enabled ? "🟢 running" : "⏸ paused"}`,
    `Budget: ${fmtUsd(settings.totalBudgetUsd)} total | ${fmtUsd(settings.positionSizeUsd)}/trade`,
    `Target: +${settings.takeProfitPct}% | Stop: ${settings.stopLossPct}%`,
    `🪖 Super Comando: ${settings.superComandoEnabled ? "🟢 ON" : "⚪️ off"}`,
    "",
    `Open positions: ${stats.openCount} (${fmtUsd(stats.deployedUsd)} of budget deployed)`,
  ];
  if (stats.openCount > 0 && unrealizedPnlUsd != null) {
    lines.push(`Unrealized PnL: ${unrealizedPnlUsd >= 0 ? "+" : ""}${fmtUsd(Math.abs(unrealizedPnlUsd))}`);
  }
  lines.push(`Closed trades: ${stats.closedCount}`);
  if (stats.closedCount > 0) {
    lines.push(`Win rate: ${(stats.winRate * 100).toFixed(1)}% (${stats.wins}/${stats.closedCount})`);
    lines.push(`Realized PnL: ${stats.totalPnlUsd >= 0 ? "+" : ""}${fmtUsd(Math.abs(stats.totalPnlUsd))}`);
  }
  return lines.join("\n");
}

export function buildRealTradingSummary({ settings, stats, unrealizedPnlUsd, walletAddress, walletBalances }) {
  const lines = [
    "💰 *Real Funds Trading*",
    "",
    `Status: ${settings.enabled ? "🔴 LIVE — real money" : "⚪️ off"}`,
    `Wallet: \`${walletAddress || "not configured"}\``,
  ];
  if (walletBalances?.length) {
    lines.push(...walletBalances.map((b) => `  ${b.label}: ${b.balance.toFixed(5)} ${b.symbol}`));
  }
  lines.push(
    "",
    `Budget: ${fmtUsd(settings.totalBudgetUsd)} total | ${fmtUsd(settings.positionSizeUsd)}/trade`,
    `Target: +${settings.takeProfitPct}% | Stop: ${settings.stopLossPct}%`,
    `Slippage tolerance: ${(settings.slippageBps / 100).toFixed(1)}%`,
    `🪖 Super Comando: ${settings.superComandoEnabled ? "🟢 ON" : "⚪️ off"}`,
    "",
    `Open positions: ${stats.openCount} (${fmtUsd(stats.deployedUsd)} of budget deployed)`
  );
  if (stats.openCount > 0 && unrealizedPnlUsd != null) {
    lines.push(`Unrealized PnL: ${unrealizedPnlUsd >= 0 ? "+" : ""}${fmtUsd(Math.abs(unrealizedPnlUsd))}`);
  }
  lines.push(`Closed trades: ${stats.closedCount}`);
  if (stats.closedCount > 0) {
    lines.push(`Win rate: ${(stats.winRate * 100).toFixed(1)}% (${stats.wins}/${stats.closedCount})`);
    lines.push(`Realized PnL: ${stats.totalPnlUsd >= 0 ? "+" : ""}${fmtUsd(Math.abs(stats.totalPnlUsd))}`);
  }
  return lines.join("\n");
}

// Per-trade breakdown for the Active Trades view — Bonk-Bot-style: wallet
// balance up top, each position shows its X-multiple, live value, market
// cap, and liquidity, with a totals footer. `walletBalances` follows the
// same {label, balance, symbol, usdValue} shape as buildRealTradingSummary's
// — omit/empty for paper trading, which has no real wallet behind it.
// --- NFT messages — mirror the token-side builders above, but floor price /
// owners / volume stand in for price / market cap / liquidity, and an extra
// "listed" state exists between open and closed (see nftTrading.js) that has
// no token-side equivalent, since exiting means creating a marketplace
// listing and waiting for a buyer rather than an instant swap.

function fmtEth(n) {
  if (n == null || !Number.isFinite(n)) return "n/a";
  if (n === 0) return "0 ETH";
  if (n < 0.0001) return `${n.toExponential(2)} ETH`;
  return `${n.toFixed(4)} ETH`;
}

export function buildNftCallMessage({ chain, contractAddress, riskResult, source, triggerWalletLabel }) {
  const { score, grade, label, breakdown, flags, name, slug, stats, totalSupply } = riskResult;
  const explorer = explorerUrlFor(chain.key, contractAddress);
  const openseaUrl = slug ? `https://opensea.io/collection/${slug}` : null;
  const sourceTag =
    source === "copy_trade" ? `👤 *Copy Signal* — ${escapeMd(triggerWalletLabel) || "a watched wallet"} just bought in` : "🆕 *New Collection*";

  const lines = [
    `📣 *NEW NFT CALL* — ${escapeMd(name) || "Unknown"} on ${chain.label}`,
    sourceTag,
    "",
    `${gradeEmoji[grade]} *Risk Score: ${score}/100 — ${grade} (${label})*`,
    `  • Contract safety: ${breakdown.contractSafety}/35`,
    `  • Marketplace liquidity: ${breakdown.marketplaceLiquidity}/25`,
    `  • Holder distribution: ${breakdown.holderDistribution}/20`,
    `  • Deployer history: ${breakdown.deployerHistory}/20`,
    "",
    `💎 Floor: ${fmtEth(stats?.floorPriceEth)}`,
    `📊 24h Volume: ${fmtEth(stats?.volume24hEth)}`,
    `👥 Owners: ${stats?.numOwners ?? "n/a"}${totalSupply ? ` / ${totalSupply} supply` : ""}`,
  ];

  if (flags.length) {
    lines.push("", "⚠️ *Flags:*", ...flags.slice(0, 6).map((f) => `  • ${f}`));
  }

  lines.push(
    "",
    `\`${contractAddress}\``,
    [explorer && `[Explorer](${explorer})`, openseaUrl && `[OpenSea](${openseaUrl})`].filter(Boolean).join(" | ")
  );

  return lines.join("\n");
}

export function buildNftPaperTradeOpenMessage({ chain, contractAddress, name, tokenId, entryPriceEth, targetMultiple, stopFloorPct }) {
  return [
    `📝 *NFT paper trade opened* — ${escapeMd(name) || "Unknown"} #${tokenId} on ${chain.label}`,
    `Entry: ${fmtEth(entryPriceEth)}`,
    `Target: ${targetMultiple}x floor | Stop: ${stopFloorPct}% of entry`,
    "",
    `\`${contractAddress}\``,
  ].join("\n");
}

export function buildNftRealTradeOpenMessage({ chain, contractAddress, name, tokenId, entryPriceEth, targetMultiple, stopFloorPct, txHash, gasEth }) {
  const explorer = txExplorerUrls[chain.key]?.(txHash);
  return [
    `💰 *REAL NFT trade opened* — ${escapeMd(name) || "Unknown"} #${tokenId} on ${chain.label}`,
    `Entry: ${fmtEth(entryPriceEth)} | Gas: ${fmtEth(gasEth)}`,
    `Target: ${targetMultiple}x floor | Stop: ${stopFloorPct}% of entry`,
    "",
    `\`${contractAddress}\``,
    explorer ? `[Transaction](${explorer})` : `Tx: \`${txHash}\``,
  ].join("\n");
}

// "Listed for sale, waiting for a buyer" — a real intermediate state with no
// token-side equivalent (a token exit is one instant swap; an NFT exit is a
// marketplace order that may sit unfilled for a while, or never fill at the
// listed price).
export function buildNftListedMessage({ chain, contractAddress, name, tokenId, listedPriceEth, reason, mode = "paper" }) {
  const modeLabel = mode === "real" ? "REAL " : "";
  const reasonLabel = reason === "stop_floor" ? "stop-loss listing" : "take-profit listing";
  return [
    `🏷️ *${modeLabel}NFT listed for sale* (${reasonLabel})`,
    `${escapeMd(name) || "Unknown"} #${tokenId} on ${chain.label}`,
    `Listed at: ${fmtEth(listedPriceEth)}`,
    "⏳ Not a guaranteed or instant exit — this waits for a buyer on OpenSea.",
    "",
    `\`${contractAddress}\``,
  ].join("\n");
}

const NFT_CLOSE_HEADLINES = {
  take_profit_sold: "🎯 *NFT trade closed — SOLD at target*",
  stop_loss_sold: "🛑 *NFT trade closed — SOLD at stop*",
  manual_close: "🛑 *NFT trade closed — manual*",
};

export function buildNftPaperTradeCloseMessage({ chain, contractAddress, name, tokenId, entryPriceEth, exitPriceEth, pnlEth, pnlPct, exitReason }) {
  const won = pnlPct >= 0;
  const headline = NFT_CLOSE_HEADLINES[exitReason] || "⏱ *NFT paper trade closed*";
  return [
    headline,
    `${escapeMd(name) || "Unknown"} #${tokenId} on ${chain.label}`,
    `${won ? "🟢" : "🔴"} ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnlEth >= 0 ? "+" : ""}${fmtEth(Math.abs(pnlEth))})`,
    "",
    `Entry: ${fmtEth(entryPriceEth)} | Exit: ${fmtEth(exitPriceEth)}`,
    "",
    `\`${contractAddress}\``,
  ].join("\n");
}

export function buildNftRealTradeCloseMessage({ chain, contractAddress, name, tokenId, entryPriceEth, exitPriceEth, pnlEth, pnlPct, exitReason, txHash, gasEth }) {
  const won = pnlPct >= 0;
  const headline = (NFT_CLOSE_HEADLINES[exitReason] || "⏱ *NFT trade closed*").replace("NFT trade", "REAL NFT trade");
  const explorer = txExplorerUrls[chain.key]?.(txHash);
  return [
    headline,
    `${escapeMd(name) || "Unknown"} #${tokenId} on ${chain.label}`,
    `${won ? "🟢" : "🔴"} ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnlEth >= 0 ? "+" : ""}${fmtEth(Math.abs(pnlEth))})`,
    `Entry: ${fmtEth(entryPriceEth)} | Exit: ${fmtEth(exitPriceEth)} | Gas: ${fmtEth(gasEth)}`,
    "",
    `\`${contractAddress}\``,
    explorer ? `[Transaction](${explorer})` : `Tx: \`${txHash}\``,
  ].join("\n");
}

export function buildNftTradingSummary({ settings, stats, mode = "paper" }) {
  const modeLabel = mode === "real" ? "💰 *Real NFT Trading*" : "📈 *NFT Paper Trading*";
  const statusLabel = mode === "real" ? (settings.enabled ? "🔴 LIVE — real money" : "⚪️ off") : settings.enabled ? "🟢 running" : "⏸ paused";
  const budgetUnit = mode === "real" ? "totalBudgetEth" : "totalBudgetEth";
  const lines = [
    modeLabel,
    "",
    `Status: ${statusLabel}`,
    `Budget: ${fmtEth(settings[budgetUnit])} total | ${fmtEth(settings.positionSizeEth)}/item`,
    `Target: ${settings.targetMultiple}x floor | Stop: ${settings.stopFloorPct}% of entry`,
    "⚠️ NFT exits list on OpenSea and wait for a buyer — not an instant swap like token trading.",
    "",
    `Open/listed positions: ${stats.openCount} (${fmtEth(stats.deployedEth)} deployed)`,
    `Closed trades: ${stats.closedCount}`,
  ];
  if (stats.closedCount > 0) {
    lines.push(`Win rate: ${(stats.winRate * 100).toFixed(1)}% (${stats.wins}/${stats.closedCount})`);
    lines.push(`Realized PnL: ${stats.totalPnlEth >= 0 ? "+" : ""}${fmtEth(Math.abs(stats.totalPnlEth))}`);
  }
  return lines.join("\n");
}

// "0.00%" / "+0.01%" / "-0.03%" — no sign on exactly zero, matching the
// Bonkbot-style reference this format is modeled on.
function fmtPctSigned(n) {
  if (n == null || !Number.isFinite(n)) return "n/a";
  if (n === 0) return "0.00%";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

// Bonkbot-style dense position card: numbered, name linked out to the block
// explorer, profit/value shown in both USD and native currency side by
// side, market cap + compact price on one line, multi-timeframe price
// change on another. Native-currency amounts (profit/value) are derived
// from nativeUsdPrice already fetched alongside the trade — paper trades
// never touched real currency, so this is a simulated equivalent ("if this
// had been a real buy on this chain"), same spirit as the rest of paper
// trading.
export function buildActiveTradesMessage({ trades, totalUnrealizedUsd, walletBalances = [], mode = "paper" }) {
  const modeLabel = mode === "real" ? "Real Funds" : "Paper";

  if (trades.length === 0) {
    return `📊 *Open Positions (0) — ${modeLabel}*\n\nNothing open right now.`;
  }

  const lines = trades.map((t, i) => {
    const hasPrice = t.pnlPct != null;
    const dot = !hasPrice ? "⚪️" : t.pnlPct >= 0 ? "🟢" : "🔴";
    const currentValueUsd = hasPrice ? t.position_size_usd + t.pnlUsd : t.position_size_usd;
    const chainLabel = CHAINS[t.chain]?.label || t.chain;
    const nativeSymbol = CHAINS[t.chain]?.nativeSymbol || "";
    const explorerUrl = explorerUrlFor(t.chain, t.token_address);
    const name = escapeMd(t.symbol) || "?";
    const nameLink = explorerUrl ? `[${name}](${explorerUrl})` : name;
    const comandoTag = t.comando_active
      ? ` 🪖 riding (floor +${t.take_profit_pct}%, peak +${(t.comando_peak_pct ?? t.pnlPct ?? 0).toFixed(1)}%)`
      : "";

    if (!hasPrice) {
      return [`${dot} *${i + 1}. ${nameLink}* (${chainLabel})${comandoTag}`, `Price unavailable — Entry: $${fmtPrice(t.entry_price_usd)}`].join("\n");
    }

    const nativePnl = t.nativeUsdPrice ? t.pnlUsd / t.nativeUsdPrice : null;
    const nativeValue = t.nativeUsdPrice ? currentValueUsd / t.nativeUsdPrice : null;
    const profitLine = `Profit: ${fmtPctSigned(t.pnlPct)}${nativePnl != null ? ` / ${nativePnl >= 0 ? "+" : ""}${nativePnl.toFixed(4)} ${nativeSymbol}` : ""}`;
    const valueLine = `Value: ${fmtUsd(currentValueUsd)}${nativeValue != null ? ` / ${nativeValue.toFixed(4)} ${nativeSymbol}` : ""}`;
    const mcapLine = `Mcap: ${fmtUsd(t.marketCapUsd)} @ ${fmtPriceCompact(t.currentPriceUsd)}`;
    const changeLine = `5m: ${fmtPctSigned(t.priceChange5m)}  1h: ${fmtPctSigned(t.priceChange1h)}  6h: ${fmtPctSigned(t.priceChange6h)}  24h: ${fmtPctSigned(t.priceChange24h)}`;

    return [`${dot} *${i + 1}. ${nameLink}* (${chainLabel})${comandoTag}`, profitLine, valueLine, mcapLine, changeLine].join("\n");
  });

  const totalValueUsd = trades.reduce((sum, t) => sum + (t.pnlUsd == null ? t.position_size_usd : t.position_size_usd + t.pnlUsd), 0);

  // "Net Worth" mirrors the Bonkbot reference: wallet balance + total open
  // position value combined, not just the positions. A native-currency
  // total only makes sense when every balance shown is the same chain's
  // currency (mixing ETH/BNB/etc. into one number would be meaningless) —
  // falls back to USD-only otherwise.
  const walletUsdTotal = walletBalances.reduce((sum, b) => sum + (b.usdValue || 0), 0);
  const netWorthUsd = totalValueUsd + walletUsdTotal;
  const singleSymbol = walletBalances.length > 0 && walletBalances.every((b) => b.symbol === walletBalances[0].symbol) ? walletBalances[0].symbol : null;
  const netWorthNative = singleSymbol && walletBalances[0].usdValue ? walletBalances.reduce((sum, b) => sum + b.balance, 0) + totalValueUsd / (walletBalances[0].usdValue / walletBalances[0].balance) : null;

  const footerLines = [];
  if (walletBalances.length) {
    for (const b of walletBalances) footerLines.push(`Balance: ${b.balance.toFixed(4)} ${b.symbol}${b.usdValue != null ? ` (${fmtUsd(b.usdValue)})` : ""}`);
  }
  footerLines.push(`Net Worth: ${netWorthNative != null ? `${netWorthNative.toFixed(4)} ${singleSymbol} / ` : ""}${fmtUsd(netWorthUsd)}`);
  const totalPctLabel = totalValueUsd - totalUnrealizedUsd > 0 ? ` (${totalUnrealizedUsd >= 0 ? "+" : ""}${((totalUnrealizedUsd / (totalValueUsd - totalUnrealizedUsd)) * 100).toFixed(0)}%)` : "";
  footerLines.push(`Unrealized PnL: ${totalUnrealizedUsd >= 0 ? "+" : ""}${fmtUsd(Math.abs(totalUnrealizedUsd))}${totalPctLabel}`);

  return [`📊 *Open Positions (${trades.length}) — ${modeLabel}*`, "", lines.join("\n\n"), "", ...footerLines].join("\n");
}
