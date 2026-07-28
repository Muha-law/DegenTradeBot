import { createCanvas, GlobalFonts } from "@napi-rs/canvas";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, "..", "..", "assets");

// Same bundled-font approach as tradeCard.js — a bare Railway container has no
// system fonts. Inter (clean/legible) fits a data-dense calendar far better
// than the comic display font the trade cards use.
let fontsRegistered = false;
function ensureFonts() {
  if (fontsRegistered) return;
  GlobalFonts.registerFromPath(path.join(ASSETS_DIR, "fonts", "Inter.ttf"), "Inter");
  fontsRegistered = true;
}

const WIDTH = 1000;
const HEIGHT = 1140;
const PAD = 40;

const COLORS = {
  bg: "#0d1117",
  cell: "#161b22",
  cellBorder: "#232a34",
  text: "#e6edf3",
  muted: "#7d8590",
  faint: "#4b525c",
  green: "#3fb950",
  greenBg: "rgba(63,185,80,0.14)",
  greenEdge: "#2ea043",
  red: "#f85149",
  redBg: "rgba(248,81,73,0.14)",
  redEdge: "#da3633",
  pill: "#21262d",
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Compact money for a cell — keeps whole-dollar precision for small P&L (the
// realistic range for these positions) but drops to K/M so a rare big number
// never overflows the cell.
function fmtMoney(n, { sign = true } = {}) {
  const abs = Math.abs(n);
  const s = n < 0 ? "-" : sign ? "+" : "";
  if (abs >= 100000) return `${s}$${(abs / 1000).toFixed(0)}K`;
  if (abs >= 1000) return `$${n < 0 ? "-" : sign ? "+" : ""}${(abs).toFixed(2)}`.replace(/(\.\d\d)\d+$/, "$1");
  if (abs >= 10) return `${s}$${abs.toFixed(2)}`;
  return `${s}$${abs.toFixed(2)}`;
}

// Renders a monthly PnL calendar image matching the mockup: a 7-column grid,
// each day tinted green/red by that day's realized P&L, with the month total
// up top. `dailyPnl` is an object keyed by day-of-month (1..31) → realized USD;
// days absent from it are shown as $0 (no closed trades that day). `mode` is
// "real" or "paper" (label only). Returns a PNG buffer.
export function renderPnlCalendar({ year, month, mode, dailyPnl = {}, monthTotal = 0 }) {
  ensureFonts();
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // ---- Header: month title (left) + mode pill ----
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = COLORS.text;
  ctx.font = "600 52px Inter";
  ctx.fillText(`${MONTH_NAMES[month]} ${year}`, PAD, 78);

  const pillText = mode === "real" ? "REAL" : "PAPER";
  ctx.font = "600 24px Inter";
  const pillW = ctx.measureText(pillText).width + 36;
  roundedRect(ctx, WIDTH - PAD - pillW, 44, pillW, 44, 22);
  ctx.fillStyle = COLORS.pill;
  ctx.fill();
  ctx.fillStyle = mode === "real" ? COLORS.green : "#58a6ff";
  ctx.textAlign = "center";
  ctx.fillText(pillText, WIDTH - PAD - pillW / 2, 75);

  // ---- Monthly PnL label + big total ----
  ctx.textAlign = "left";
  ctx.fillStyle = COLORS.muted;
  ctx.font = "500 30px Inter";
  ctx.fillText("Monthly PnL", PAD, 150);

  const totalColor = monthTotal > 0 ? COLORS.green : monthTotal < 0 ? COLORS.red : COLORS.muted;
  ctx.textAlign = "right";
  ctx.fillStyle = totalColor;
  ctx.font = "700 48px Inter";
  ctx.fillText(fmtMoney(monthTotal), WIDTH - PAD, 152);

  // ---- Weekday header row ----
  const gridTop = 210;
  const gap = 12;
  const cellW = (WIDTH - 2 * PAD - 6 * gap) / 7;
  ctx.font = "500 24px Inter";
  ctx.fillStyle = COLORS.muted;
  ctx.textAlign = "center";
  WEEKDAYS.forEach((d, i) => {
    const x = PAD + i * (cellW + gap) + cellW / 2;
    ctx.fillText(d, x, gridTop);
  });

  // ---- Day grid ----
  const firstWeekday = new Date(Date.UTC(year, month, 1)).getUTCDay(); // 0=Sun
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const rows = Math.ceil((firstWeekday + daysInMonth) / 7);
  const cellsTop = gridTop + 24;
  const cellH = Math.min(150, (HEIGHT - cellsTop - PAD - (rows - 1) * gap) / rows);

  for (let day = 1; day <= daysInMonth; day++) {
    const cellIndex = firstWeekday + day - 1;
    const col = cellIndex % 7;
    const row = Math.floor(cellIndex / 7);
    const x = PAD + col * (cellW + gap);
    const y = cellsTop + row * (cellH + gap);

    const hasTrades = Object.prototype.hasOwnProperty.call(dailyPnl, day);
    const pnl = hasTrades ? dailyPnl[day] : 0;
    const isProfit = hasTrades && pnl > 0;
    const isLoss = hasTrades && pnl < 0;

    // Cell background
    roundedRect(ctx, x, y, cellW, cellH, 14);
    ctx.fillStyle = isProfit ? COLORS.greenBg : isLoss ? COLORS.redBg : COLORS.cell;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = isProfit ? COLORS.greenEdge : isLoss ? COLORS.redEdge : COLORS.cellBorder;
    ctx.stroke();

    // Colored left accent bar for active days (matches the mockup's edge)
    if (isProfit || isLoss) {
      roundedRect(ctx, x, y, 6, cellH, 3);
      ctx.fillStyle = isProfit ? COLORS.greenEdge : COLORS.redEdge;
      ctx.fill();
    }

    // Day number (top-left)
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.font = "600 24px Inter";
    ctx.fillStyle = hasTrades ? COLORS.text : COLORS.muted;
    ctx.fillText(String(day), x + 16, y + 34);

    // P&L (centered lower)
    const pnlText = hasTrades ? fmtMoney(pnl) : "$0";
    ctx.textAlign = "center";
    ctx.font = hasTrades ? "700 26px Inter" : "500 22px Inter";
    ctx.fillStyle = isProfit ? COLORS.green : isLoss ? COLORS.red : COLORS.faint;
    ctx.fillText(pnlText, x + cellW / 2, y + cellH - 26);
  }

  return canvas.toBuffer("image/png");
}
