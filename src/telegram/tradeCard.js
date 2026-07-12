import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, "..", "..", "assets");

// Bundled in-repo rather than relying on whatever fonts/images happen to be
// on the host — a bare Railway container has neither by default. Bangers is
// the comic-book display font (bold, condensed, hand-lettered look); Inter
// covers anything that needs to stay legible at small sizes. Registered
// once per process.
let fontsRegistered = false;
function ensureFonts() {
  if (fontsRegistered) return;
  GlobalFonts.registerFromPath(path.join(ASSETS_DIR, "fonts", "Inter.ttf"), "Inter");
  GlobalFonts.registerFromPath(path.join(ASSETS_DIR, "fonts", "Bangers.ttf"), "Bangers");
  fontsRegistered = true;
}

let bgImagePromise = null;
function loadBgImage() {
  if (!bgImagePromise) bgImagePromise = loadImage(path.join(ASSETS_DIR, "images", "tradeCardBg.png"));
  return bgImagePromise;
}

// Matches the source art's native resolution — drawn 1:1, no scaling/
// distortion. The character sits in the lower-left of the frame by design
// (see the generation prompt), leaving the upper-right open for text.
const WIDTH = 1376;
const HEIGHT = 768;
const TEXT_X = 600;

const COLORS = {
  white: "#ffffff",
  muted: "#e2e8f0",
  green: "#22c55e",
  red: "#ef4444",
  paper: "#7dd3fc",
  real: "#fbbf24",
  black: "#000000",
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

// Comic-book "pop" text: thick black outline behind a solid fill, the same
// technique the RickBurpBot-style reference card uses to stay readable over
// a busy illustrated background without needing a solid text-box behind it.
function strokedText(ctx, text, x, y, { font, fill = COLORS.white, strokeWidth = 8, align = "left" } = {}) {
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = strokeWidth;
  ctx.strokeStyle = COLORS.black;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

// Deliberately not formatMessage.js's fmtPriceCompact — its subscript-digit
// notation (e.g. "$0.0₄350") uses Unicode subscript characters Bangers has
// no glyphs for, which rendered as a broken tofu box. Plain decimals/
// exponential notation only, since Bangers is a fairly minimal display font.
function fmtPriceForCard(n) {
  if (!n || !Number.isFinite(n) || n <= 0) return "n/a";
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toExponential(2)}`;
}

function fmtCompactNumber(n) {
  if (n == null || !Number.isFinite(n) || n <= 0) return "n/a";
  const trim = (v) => v.toFixed(1).replace(/\.0$/, "");
  if (n >= 1_000_000_000) return `${trim(n / 1_000_000_000)}B`;
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}K`;
  return Math.round(n).toString();
}

function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 24) return remMin > 0 ? `${hours}h ${remMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

async function drawBase(ctx, { tradeMode, chainLabel, sourceLabel }) {
  const bg = await loadBgImage();
  ctx.drawImage(bg, 0, 0, WIDTH, HEIGHT);

  // Left-to-right dark gradient — the source art already leaves the right
  // side visually open, this just adds a bit more contrast headroom for
  // text without needing an opaque panel behind it.
  const grad = ctx.createLinearGradient(TEXT_X - 150, 0, WIDTH, 0);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.35)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  const modeColor = tradeMode === "real" ? COLORS.real : COLORS.paper;
  strokedText(ctx, "DEGEN ASSISTANT", 40, 56, { font: "40px Bangers", fill: COLORS.white, strokeWidth: 6 });

  const badgeText = tradeMode === "real" ? "REAL TRADE" : "PAPER TRADE";
  ctx.font = "32px Bangers";
  const badgeWidth = ctx.measureText(badgeText).width + 44;
  const badgeX = WIDTH - 40 - badgeWidth;
  roundedRect(ctx, badgeX, 28, badgeWidth, 50, 25);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fill();
  ctx.strokeStyle = modeColor;
  ctx.lineWidth = 3;
  ctx.stroke();
  strokedText(ctx, badgeText, badgeX + 22, 63, { font: "32px Bangers", fill: modeColor, strokeWidth: 4 });

  strokedText(ctx, `${chainLabel} · ${sourceLabel}`, TEXT_X, 130, { font: "34px Bangers", fill: COLORS.muted, strokeWidth: 5 });
}

function drawFooter(ctx, tokenAddress) {
  const shortAddr = tokenAddress ? `${tokenAddress.slice(0, 10)}…${tokenAddress.slice(-8)}` : "";
  ctx.font = "22px Inter";
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.fillText(shortAddr, WIDTH - 30, HEIGHT - 24);
}

// Card shown when a position (paper or real) is opened.
export async function renderOpenCard({
  chainLabel,
  symbol,
  name,
  tradeMode,
  entryPriceUsd,
  entryMarketCapUsd,
  positionSizeUsd,
  takeProfitPct,
  stopLossPct,
  tokenAddress,
}) {
  ensureFonts();
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  await drawBase(ctx, { tradeMode, chainLabel, sourceLabel: "position opened" });

  const headline = entryMarketCapUsd > 0 ? `${symbol || "?"} @ ${fmtCompactNumber(entryMarketCapUsd)}` : symbol || "?";
  strokedText(ctx, headline, TEXT_X, 250, { font: "104px Bangers", fill: COLORS.white, strokeWidth: 10 });
  if (name) strokedText(ctx, name, TEXT_X, 300, { font: "34px Bangers", fill: COLORS.muted, strokeWidth: 5 });

  const modeColor = tradeMode === "real" ? COLORS.real : COLORS.paper;
  strokedText(ctx, `ENTRY ${fmtPriceForCard(entryPriceUsd)}`, TEXT_X, 400, { font: "72px Bangers", fill: modeColor, strokeWidth: 9 });

  const stats = [
    { label: "SIZE", value: `$${positionSizeUsd.toFixed(0)}` },
    { label: "TARGET", value: `+${takeProfitPct}%`, color: COLORS.green },
    { label: "STOP", value: `${stopLossPct}%`, color: COLORS.red },
  ];
  stats.forEach((s, i) => {
    const x = TEXT_X + i * 250;
    strokedText(ctx, s.label, x, 480, { font: "26px Bangers", fill: COLORS.muted, strokeWidth: 4 });
    strokedText(ctx, s.value, x, 530, { font: "48px Bangers", fill: s.color || COLORS.white, strokeWidth: 7 });
  });

  drawFooter(ctx, tokenAddress);
  return canvas.toBuffer("image/png");
}

const EXIT_REASON_LABELS = {
  take_profit: "take profit",
  stop_loss: "stop loss",
  comando_floor: "Super Comando floor",
  comando_ai_exit: "Super Comando (AI)",
  manual_close_all: "manual close",
  manual_close: "manual close",
  manual_sell: "manual sell",
  stale_price: "stale price",
  stale_price_exit: "stale price (forced exit)",
  honeypot_immediate_exit: "honeypot (immediate exit)",
};

// Card shown when a position closes — the "flex" card: big colored PnL%
// dominates, same visual weighting as the RickBurpBot-style reference.
export async function renderCloseCard({
  chainLabel,
  symbol,
  name,
  tradeMode,
  entryPriceUsd,
  entryMarketCapUsd,
  exitPriceUsd,
  currentMarketCapUsd,
  pnlUsd,
  pnlPct,
  exitReason,
  tokenAddress,
  holdDurationMs,
}) {
  ensureFonts();
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  const won = pnlPct >= 0;
  const resultColor = won ? COLORS.green : COLORS.red;
  const heldLabel = fmtDuration(holdDurationMs);

  await drawBase(ctx, {
    tradeMode,
    chainLabel,
    sourceLabel: `${EXIT_REASON_LABELS[exitReason] || "closed"}${heldLabel ? ` · held ${heldLabel}` : ""}`,
  });

  const headline = entryMarketCapUsd > 0 ? `${symbol || "?"} @ ${fmtCompactNumber(entryMarketCapUsd)}` : symbol || "?";
  strokedText(ctx, headline, TEXT_X, 220, { font: "88px Bangers", fill: COLORS.white, strokeWidth: 9 });
  if (name) strokedText(ctx, name, TEXT_X, 268, { font: "32px Bangers", fill: COLORS.muted, strokeWidth: 5 });

  const pctText = `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%`;
  strokedText(ctx, pctText, TEXT_X, 430, { font: "150px Bangers", fill: resultColor, strokeWidth: 14 });

  const multiplier = entryPriceUsd > 0 ? exitPriceUsd / entryPriceUsd : 1;
  strokedText(ctx, `${multiplier.toFixed(2)}x  ·  ${pnlUsd >= 0 ? "+" : "-"}$${Math.abs(pnlUsd).toFixed(0)}`, TEXT_X, 480, {
    font: "42px Bangers",
    fill: COLORS.muted,
    strokeWidth: 6,
  });

  const nowLabel = currentMarketCapUsd > 0 ? `NOW: ${fmtCompactNumber(currentMarketCapUsd)}` : `EXIT ${fmtPriceForCard(exitPriceUsd)}`;
  strokedText(ctx, nowLabel, TEXT_X, 560, { font: "56px Bangers", fill: COLORS.white, strokeWidth: 8 });

  drawFooter(ctx, tokenAddress);
  return canvas.toBuffer("image/png");
}
