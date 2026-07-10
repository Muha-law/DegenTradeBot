const explorerUrls = {
  ethereum: (addr) => `https://etherscan.io/token/${addr}`,
  base: (addr) => `https://basescan.org/token/${addr}`,
  bsc: (addr) => `https://bscscan.com/token/${addr}`,
  arbitrum: (addr) => `https://arbiscan.io/token/${addr}`,
};

const gradeEmoji = { A: "🟢", B: "🟩", C: "🟡", D: "🟠", F: "🔴" };

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
    `⚠️ *REAL trade FAILED* — ${name || "Unknown"} (${symbol || "?"}) on ${chain.label}`,
    `${reason}`,
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

// Per-trade breakdown for the Active Trades view — the summary above only
// shows aggregates, this lists each open position with its live price/PnL.
export function buildActiveTradesMessage({ trades, totalUnrealizedUsd }) {
  if (trades.length === 0) return "📋 *Active Trades*\n\nNothing open right now.";

  const lines = trades.map((t) => {
    const pctLabel = t.pnlPct == null ? "price unavailable" : `${t.pnlPct >= 0 ? "🟢+" : "🔴"}${t.pnlPct.toFixed(1)}%`;
    const usdLabel = t.pnlUsd == null ? "" : ` (${t.pnlUsd >= 0 ? "+" : ""}${fmtUsd(Math.abs(t.pnlUsd))})`;
    const nowLabel = t.currentPriceUsd != null ? `$${fmtPrice(t.currentPriceUsd)}` : "n/a";
    const comandoTag = t.comando_active ? ` 🪖 riding (floor +${t.take_profit_pct}%, peak +${(t.comando_peak_pct ?? t.pnlPct ?? 0).toFixed(1)}%)` : "";
    return [
      `*${t.symbol || "?"}* (${t.chain}) — #${t.id} — ${pctLabel}${usdLabel}${comandoTag}`,
      `Entry: $${fmtPrice(t.entry_price_usd)} | Now: ${nowLabel} | Size: ${fmtUsd(t.position_size_usd)}`,
      `\`${t.token_address}\``,
    ].join("\n");
  });

  const totalLabel = `${totalUnrealizedUsd >= 0 ? "+" : ""}${fmtUsd(Math.abs(totalUnrealizedUsd))}`;
  return `📋 *Active Trades* (${trades.length})\nUnrealized PnL: ${totalLabel}\n\n${lines.join("\n\n")}`;
}
