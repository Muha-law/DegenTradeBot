import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fmtUsd, fmtPriceCompact } from "./formatMessage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Bundled in-repo (assets/fonts/Inter.ttf) rather than relying on whatever
// fonts happen to be installed on the host — a bare Railway container has
// none by default, which would otherwise render every card as blank tofu
// boxes with no error. Registered once per process; a variable font, so
// canvas font strings below select weight numerically (e.g. "700 54px Inter").
let fontsRegistered = false;
function ensureFonts() {
  if (fontsRegistered) return;
  GlobalFonts.registerFromPath(path.join(__dirname, "..", "..", "assets", "fonts", "Inter.ttf"), "Inter");
  fontsRegistered = true;
}

const WIDTH = 1200;
const HEIGHT = 630;

const COLORS = {
  bgTop: "#0b0f1a",
  bgBottom: "#161d2e",
  border: "rgba(255,255,255,0.08)",
  white: "#f8fafc",
  muted: "#94a3b8",
  mutedDim: "#64748b",
  green: "#22c55e",
  red: "#ef4444",
  paper: "#60a5fa",
  real: "#f59e0b",
};

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawBase(ctx, { tradeModeLabel, tradeModeColor, chainLabel, sourceLabel }) {
  const grad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  grad.addColorStop(0, COLORS.bgTop);
  grad.addColorStop(1, COLORS.bgBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  roundedRect(ctx, 16, 16, WIDTH - 32, HEIGHT - 32, 28);
  ctx.strokeStyle = COLORS.border;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Header row: wordmark left, mode badge right.
  ctx.font = "700 30px Inter";
  ctx.fillStyle = COLORS.mutedDim;
  ctx.textBaseline = "middle";
  ctx.fillText("DEGEN ASSISTANT", 56, 78);

  ctx.font = "700 26px Inter";
  const badgeText = tradeModeLabel;
  const badgeWidth = ctx.measureText(badgeText).width + 40;
  const badgeX = WIDTH - 56 - badgeWidth;
  roundedRect(ctx, badgeX, 52, badgeWidth, 52, 26);
  ctx.fillStyle = `${tradeModeColor}26`; // ~15% alpha fill
  ctx.fill();
  ctx.strokeStyle = tradeModeColor;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = tradeModeColor;
  ctx.fillText(badgeText, badgeX + 20, 78);

  ctx.font = "500 26px Inter";
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(`${chainLabel}${sourceLabel ? ` · ${sourceLabel}` : ""}`, 56, 130);
}

function drawSymbolHeadline(ctx, { symbol, name }) {
  const symbolText = symbol ? `$${symbol}` : "Unknown";
  ctx.font = "800 72px Inter";
  // Measure at the symbol's own font size before switching fonts below —
  // measureText reads whatever font is currently set, so measuring after
  // switching to the (smaller) name font under-measured the symbol's actual
  // on-canvas width and made the name overlap it.
  const symbolWidth = ctx.measureText(symbolText).width;
  ctx.fillStyle = COLORS.white;
  ctx.fillText(symbolText, 56, 230);

  if (name) {
    ctx.font = "500 30px Inter";
    ctx.fillStyle = COLORS.muted;
    const maxNameWidth = WIDTH - 56 - (56 + symbolWidth + 24);
    let displayName = name;
    while (displayName.length > 4 && ctx.measureText(`${displayName}…`).width > maxNameWidth) {
      displayName = displayName.slice(0, -1);
    }
    if (displayName !== name) displayName += "…";
    ctx.fillText(displayName, 56 + symbolWidth + 24, 232);
  }
}

function drawStatRow(ctx, y, stats) {
  const colWidth = (WIDTH - 112) / stats.length;
  stats.forEach((stat, i) => {
    const x = 56 + i * colWidth;
    ctx.font = "600 24px Inter";
    ctx.fillStyle = COLORS.mutedDim;
    ctx.fillText(stat.label.toUpperCase(), x, y);
    ctx.font = "700 36px Inter";
    ctx.fillStyle = stat.color || COLORS.white;
    ctx.fillText(stat.value, x, y + 44);
  });
}

function drawFooter(ctx, { tokenAddress, timestampLabel }) {
  ctx.font = "500 22px Inter";
  ctx.fillStyle = COLORS.mutedDim;
  const shortAddr = tokenAddress ? `${tokenAddress.slice(0, 10)}…${tokenAddress.slice(-8)}` : "";
  ctx.fillText(shortAddr, 56, HEIGHT - 48);
  if (timestampLabel) {
    const w = ctx.measureText(timestampLabel).width;
    ctx.fillText(timestampLabel, WIDTH - 56 - w, HEIGHT - 48);
  }
}

function nowLabel() {
  return new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

// Card shown when a position (paper or real) is opened — entry price plus
// the target/stop this position will exit at, so it reads as a commitment
// card, not just a log line.
export function renderOpenCard({ chainLabel, symbol, name, tradeMode, entryPriceUsd, positionSizeUsd, takeProfitPct, stopLossPct, tokenAddress }) {
  ensureFonts();
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  const modeColor = tradeMode === "real" ? COLORS.real : COLORS.paper;

  drawBase(ctx, { tradeModeLabel: tradeMode === "real" ? "REAL TRADE" : "PAPER TRADE", tradeModeColor: modeColor, chainLabel, sourceLabel: "position opened" });
  drawSymbolHeadline(ctx, { symbol, name });

  ctx.font = "700 64px Inter";
  ctx.fillStyle = modeColor;
  ctx.fillText(`Entry ${fmtPriceCompact(entryPriceUsd)}`, 56, 320);

  drawStatRow(ctx, 420, [
    { label: "Position Size", value: fmtUsd(positionSizeUsd) },
    { label: "Target", value: `+${takeProfitPct}%`, color: COLORS.green },
    { label: "Stop", value: `${stopLossPct}%`, color: COLORS.red },
  ]);

  drawFooter(ctx, { tokenAddress, timestampLabel: nowLabel() });
  return canvas.toBuffer("image/png");
}

const EXIT_REASON_LABELS = {
  take_profit: "Take Profit",
  stop_loss: "Stop Loss",
  comando_floor: "Super Comando Floor",
  comando_ai_exit: "Super Comando (AI)",
  manual_close_all: "Manual Close",
  manual_close: "Manual Close",
  manual_sell: "Manual Sell",
  stale_price: "Stale Price",
  stale_price_exit: "Stale Price (Forced Exit)",
  honeypot_immediate_exit: "Honeypot (Immediate Exit)",
};

// Card shown when a position closes — the "flex" card: big colored PnL%,
// multiplier, and $ amount up front, same visual language Bonkbot/Photon/
// Trojan-style bots use for a shareable result.
export function renderCloseCard({ chainLabel, symbol, name, tradeMode, entryPriceUsd, exitPriceUsd, pnlUsd, pnlPct, exitReason, tokenAddress }) {
  ensureFonts();
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  const modeColor = tradeMode === "real" ? COLORS.real : COLORS.paper;
  const won = pnlPct >= 0;
  const resultColor = won ? COLORS.green : COLORS.red;

  drawBase(ctx, {
    tradeModeLabel: tradeMode === "real" ? "REAL TRADE" : "PAPER TRADE",
    tradeModeColor: modeColor,
    chainLabel,
    sourceLabel: EXIT_REASON_LABELS[exitReason] || "closed",
  });
  drawSymbolHeadline(ctx, { symbol, name });

  const multiplier = entryPriceUsd > 0 ? exitPriceUsd / entryPriceUsd : 1;
  ctx.font = "800 96px Inter";
  ctx.fillStyle = resultColor;
  const pctText = `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%`;
  ctx.fillText(pctText, 56, 320);

  ctx.font = "600 40px Inter";
  ctx.fillStyle = COLORS.muted;
  ctx.fillText(`${multiplier.toFixed(2)}x  ·  ${pnlUsd >= 0 ? "+" : "-"}${fmtUsd(Math.abs(pnlUsd))}`, 56, 380);

  drawStatRow(ctx, 460, [
    { label: "Entry", value: fmtPriceCompact(entryPriceUsd) },
    { label: "Exit", value: fmtPriceCompact(exitPriceUsd) },
  ]);

  drawFooter(ctx, { tokenAddress, timestampLabel: nowLabel() });
  return canvas.toBuffer("image/png");
}
