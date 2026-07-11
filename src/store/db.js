import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { getDataDir } from "../dataDir.js";

const dbPath = path.join(getDataDir(), "bot.sqlite");

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS seen_tokens (
    chain TEXT NOT NULL,
    pair_address TEXT NOT NULL,
    token_address TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    PRIMARY KEY (chain, pair_address)
  );

  CREATE TABLE IF NOT EXISTS called_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain TEXT NOT NULL,
    token_address TEXT NOT NULL,
    pair_address TEXT NOT NULL,
    symbol TEXT,
    name TEXT,
    call_price_usd REAL,
    call_market_cap_usd REAL,
    risk_score INTEGER,
    risk_grade TEXT,
    telegram_message_id INTEGER,
    called_at INTEGER NOT NULL,
    last_updated_at INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE(chain, token_address)
  );

  CREATE TABLE IF NOT EXISTS deployer_history (
    deployer_address TEXT PRIMARY KEY,
    tokens_deployed INTEGER NOT NULL DEFAULT 0,
    low_score_count INTEGER NOT NULL DEFAULT 0,
    last_seen_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS pending_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain TEXT NOT NULL,
    token_address TEXT NOT NULL,
    pair_address TEXT NOT NULL,
    dex_name TEXT,
    first_seen_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    UNIQUE(chain, token_address)
  );

  CREATE TABLE IF NOT EXISTS tracked_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain TEXT NOT NULL,
    token_address TEXT NOT NULL,
    symbol TEXT,
    name TEXT,
    track_price_usd REAL NOT NULL,
    track_market_cap_usd REAL,
    tracked_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    best_milestone_hit INTEGER NOT NULL DEFAULT 0,
    down50_alert_sent INTEGER NOT NULL DEFAULT 0,
    dead_alert_sent INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    UNIQUE(chain, token_address)
  );

  CREATE TABLE IF NOT EXISTS paper_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain TEXT NOT NULL,
    token_address TEXT NOT NULL,
    symbol TEXT,
    name TEXT,
    entry_price_usd REAL NOT NULL,
    position_size_usd REAL NOT NULL,
    take_profit_pct REAL NOT NULL,
    stop_loss_pct REAL NOT NULL,
    entry_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    exit_price_usd REAL,
    exit_at INTEGER,
    exit_reason TEXT,
    pnl_usd REAL,
    pnl_pct REAL,
    status TEXT NOT NULL DEFAULT 'open',
    UNIQUE(chain, token_address)
  );

  CREATE TABLE IF NOT EXISTS real_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain TEXT NOT NULL,
    token_address TEXT NOT NULL,
    symbol TEXT,
    name TEXT,
    entry_price_usd REAL NOT NULL,
    position_size_usd REAL NOT NULL,
    take_profit_pct REAL NOT NULL,
    stop_loss_pct REAL NOT NULL,
    entry_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    exit_price_usd REAL,
    exit_at INTEGER,
    exit_reason TEXT,
    pnl_usd REAL,
    pnl_pct REAL,
    status TEXT NOT NULL DEFAULT 'open',
    -- Real-execution-specific fields, absent on paper_trades:
    token_amount_raw TEXT,      -- actual on-chain token units received (string: can exceed JS safe-int range)
    native_spent REAL,          -- actual native currency spent buying in
    native_received REAL,       -- actual native currency received selling out
    entry_tx_hash TEXT,
    exit_tx_hash TEXT,
    entry_gas_usd REAL,
    exit_gas_usd REAL,
    UNIQUE(chain, token_address)
  );

  CREATE TABLE IF NOT EXISTS bot_users (
    telegram_user_id TEXT PRIMARY KEY,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
`);

// Lightweight migration: add columns to an existing called_tokens table
// without needing a real migration framework.
function addColumnIfMissing(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!existing.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
addColumnIfMissing("called_tokens", "best_milestone_hit", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("called_tokens", "last_update_sent_at", "INTEGER");
addColumnIfMissing("called_tokens", "last_update_pct", "REAL");
// Snapshot of the risk-score inputs at call time — call_market_cap_usd and
// risk_score were the only fields recorded historically, which meant a
// preset/algorithm analysis could only ever look at those two. These let a
// future analysis look at liquidity, volume, and holder structure too.
addColumnIfMissing("called_tokens", "call_liquidity_usd", "REAL");
addColumnIfMissing("called_tokens", "call_volume24h_usd", "REAL");
addColumnIfMissing("called_tokens", "call_holder_count", "INTEGER");
addColumnIfMissing("called_tokens", "call_top10_pct", "REAL");
addColumnIfMissing("called_tokens", "call_creator_pct", "REAL");
addColumnIfMissing("called_tokens", "call_is_open_source", "INTEGER");
addColumnIfMissing("called_tokens", "call_is_mintable", "INTEGER");
// Super Comando state — a trade that crossed take_profit_pct while Super
// Comando was on enters "ride" mode instead of closing immediately.
addColumnIfMissing("paper_trades", "comando_active", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("paper_trades", "comando_activated_at", "INTEGER");
addColumnIfMissing("paper_trades", "comando_peak_pct", "REAL");
addColumnIfMissing("paper_trades", "comando_last_ai_check_at", "INTEGER");
addColumnIfMissing("real_trades", "comando_active", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("real_trades", "comando_activated_at", "INTEGER");
addColumnIfMissing("real_trades", "comando_peak_pct", "REAL");
addColumnIfMissing("real_trades", "comando_last_ai_check_at", "INTEGER");
// Set the first time a position's price comes back unreadable/insane
// (isSanePrice fails) and cleared the moment a sane price is seen again —
// lets the checker distinguish a transient data blip from a genuinely dead
// pool (sustained unavailability) and force an exit attempt in the latter
// case instead of silently skipping the position forever. See
// touch*TradeStalePrice below and the checker loops in paperTrading.js /
// realTrading.js.
addColumnIfMissing("paper_trades", "price_unavailable_since", "INTEGER");
addColumnIfMissing("real_trades", "price_unavailable_since", "INTEGER");

export function hasSeenPair(chain, pairAddress) {
  return !!db
    .prepare("SELECT 1 FROM seen_tokens WHERE chain = ? AND pair_address = ?")
    .get(chain, pairAddress);
}

export function markPairSeen(chain, pairAddress, tokenAddress) {
  db.prepare(
    "INSERT OR IGNORE INTO seen_tokens (chain, pair_address, token_address, first_seen_at) VALUES (?, ?, ?, ?)"
  ).run(chain, pairAddress, tokenAddress, Date.now());
}

export function countSeen() {
  return db.prepare("SELECT COUNT(*) AS n FROM seen_tokens").get().n;
}

export function countCalled() {
  return db.prepare("SELECT COUNT(*) AS n FROM called_tokens").get().n;
}

// Checked before sending a call message, not just before the DB insert —
// the UNIQUE(chain, token_address) constraint on called_tokens only stops a
// second *row* from being written, but by then the duplicate Telegram
// message has already gone out. This catches it earlier.
export function hasBeenCalled(chain, tokenAddress) {
  return !!db.prepare("SELECT 1 FROM called_tokens WHERE chain = ? AND token_address = ?").get(chain, tokenAddress);
}

// Finds previously-called tokens sharing the same name on the same chain but
// a different contract address — the classic copycat/namesake pattern (a
// scammer relaunches a pumped token's exact name under a fresh CA). Used to
// give the AI screen context on whether a new call looks like a clone.
export function findRecentCallsByName(chain, name, excludeTokenAddress, limit = 3) {
  if (!name) return [];
  return db
    .prepare(
      `SELECT chain, token_address, symbol, name, call_price_usd, called_at
       FROM called_tokens
       WHERE chain = ? AND LOWER(name) = LOWER(?) AND token_address != ?
       ORDER BY called_at DESC LIMIT ?`
    )
    .all(chain, name, excludeTokenAddress, limit);
}

export function recordCall(entry) {
  const stmt = db.prepare(`
    INSERT INTO called_tokens
      (chain, token_address, pair_address, symbol, name, call_price_usd, call_market_cap_usd,
       risk_score, risk_grade, telegram_message_id, called_at, last_updated_at, active,
       call_liquidity_usd, call_volume24h_usd, call_holder_count, call_top10_pct,
       call_creator_pct, call_is_open_source, call_is_mintable)
    VALUES (@chain, @tokenAddress, @pairAddress, @symbol, @name, @callPriceUsd, @callMarketCapUsd,
       @riskScore, @riskGrade, @telegramMessageId, @calledAt, @calledAt, 1,
       @callLiquidityUsd, @callVolume24hUsd, @callHolderCount, @callTop10Pct,
       @callCreatorPct, @callIsOpenSource, @callIsMintable)
    ON CONFLICT(chain, token_address) DO NOTHING
  `);
  return stmt.run(entry);
}

// Deliberately does NOT filter by called_at here — the caller (priceUpdater.js)
// re-checks each row's age itself and calls deactivateCall() once it's past
// the window. Filtering by age in this query as well made that deactivation
// branch unreachable: any row old enough to need deactivating was already
// excluded from the result set before the loop could see it, so `active`
// stayed 1 forever regardless of true age.
export function getActiveCalls() {
  return db.prepare("SELECT * FROM called_tokens WHERE active = 1").all();
}

// Call-time volume/liquidity/mcap snapshot for a token — used by Super
// Comando to gate which take-profit crossings it's willing to let ride.
// Backtesting 380 historical calls found call-time 24h volume is the
// strongest available signal for distinguishing genuine movers from
// wash-traded pump-and-dumps: lower call-time volume correlated with a
// meaningfully higher chance of reaching +50%/+100%, holding up on a
// held-out time-based validation split, not just in-sample.
export function getCalledTokenSnapshot(chain, tokenAddress) {
  return db
    .prepare("SELECT call_volume24h_usd, call_liquidity_usd, call_market_cap_usd FROM called_tokens WHERE chain = ? AND token_address = ?")
    .get(chain, tokenAddress);
}

export function updateCallProgress(id, { lastUpdatedAt }) {
  db.prepare("UPDATE called_tokens SET last_updated_at = ? WHERE id = ?").run(lastUpdatedAt, id);
}

export function deactivateCall(id) {
  db.prepare("UPDATE called_tokens SET active = 0 WHERE id = ?").run(id);
}

export function updateCallMilestone(id, { bestMilestoneHit, lastUpdateSentAt, lastUpdatePct }) {
  db.prepare(
    "UPDATE called_tokens SET best_milestone_hit = ?, last_update_sent_at = ?, last_update_pct = ?, last_updated_at = ? WHERE id = ?"
  ).run(bestMilestoneHit, lastUpdateSentAt, lastUpdatePct, lastUpdateSentAt, id);
}

export function recordDeployerOutcome(deployerAddress, { lowScore }) {
  db.prepare(
    `INSERT INTO deployer_history (deployer_address, tokens_deployed, low_score_count, last_seen_at)
     VALUES (?, 1, ?, ?)
     ON CONFLICT(deployer_address) DO UPDATE SET
       tokens_deployed = tokens_deployed + 1,
       low_score_count = low_score_count + ?,
       last_seen_at = ?`
  ).run(deployerAddress, lowScore ? 1 : 0, Date.now(), lowScore ? 1 : 0, Date.now());
}

export function getDeployerHistory(deployerAddress) {
  return db.prepare("SELECT * FROM deployer_history WHERE deployer_address = ?").get(deployerAddress);
}

export function addPending({ chain, tokenAddress, pairAddress, dexName, firstSeenAt }) {
  db.prepare(
    `INSERT OR IGNORE INTO pending_tokens (chain, token_address, pair_address, dex_name, first_seen_at, last_checked_at, attempts)
     VALUES (@chain, @tokenAddress, @pairAddress, @dexName, @firstSeenAt, @firstSeenAt, 0)`
  ).run({ chain, tokenAddress, pairAddress, dexName, firstSeenAt });
}

export function getAllPending() {
  return db.prepare("SELECT * FROM pending_tokens").all();
}

export function countPending() {
  return db.prepare("SELECT COUNT(*) AS n FROM pending_tokens").get().n;
}

export function touchPending(id) {
  db.prepare("UPDATE pending_tokens SET last_checked_at = ?, attempts = attempts + 1 WHERE id = ?").run(Date.now(), id);
}

export function removePending(id) {
  db.prepare("DELETE FROM pending_tokens WHERE id = ?").run(id);
}

// Re-tracking the same token resets its baseline and alert history.
export function addTrack(entry) {
  db.prepare(
    `INSERT INTO tracked_tokens
       (chain, token_address, symbol, name, track_price_usd, track_market_cap_usd, tracked_at, last_checked_at, active)
     VALUES (@chain, @tokenAddress, @symbol, @name, @trackPriceUsd, @trackMarketCapUsd, @trackedAt, @trackedAt, 1)
     ON CONFLICT(chain, token_address) DO UPDATE SET
       symbol = excluded.symbol,
       name = excluded.name,
       track_price_usd = excluded.track_price_usd,
       track_market_cap_usd = excluded.track_market_cap_usd,
       tracked_at = excluded.tracked_at,
       last_checked_at = excluded.tracked_at,
       best_milestone_hit = 0,
       down50_alert_sent = 0,
       dead_alert_sent = 0,
       active = 1`
  ).run(entry);
}

export function getActiveTracks() {
  return db.prepare("SELECT * FROM tracked_tokens WHERE active = 1").all();
}

export function updateTrackMilestone(id, { lastCheckedAt, bestMilestoneHit }) {
  db.prepare("UPDATE tracked_tokens SET last_checked_at = ?, best_milestone_hit = ? WHERE id = ?").run(
    lastCheckedAt,
    bestMilestoneHit,
    id
  );
}

export function touchTrack(id) {
  db.prepare("UPDATE tracked_tokens SET last_checked_at = ? WHERE id = ?").run(Date.now(), id);
}

export function markDown50Alert(id) {
  db.prepare("UPDATE tracked_tokens SET down50_alert_sent = 1, last_checked_at = ? WHERE id = ?").run(Date.now(), id);
}

export function markDeadAndDeactivate(id) {
  db.prepare("UPDATE tracked_tokens SET dead_alert_sent = 1, active = 0, last_checked_at = ? WHERE id = ?").run(
    Date.now(),
    id
  );
}

export function deactivateTrack(chain, tokenAddress) {
  const res = db
    .prepare("UPDATE tracked_tokens SET active = 0 WHERE chain = ? AND token_address = ? AND active = 1")
    .run(chain, tokenAddress);
  return res.changes > 0;
}

export function openPaperTrade(entry) {
  const stmt = db.prepare(`
    INSERT INTO paper_trades
      (chain, token_address, symbol, name, entry_price_usd, position_size_usd,
       take_profit_pct, stop_loss_pct, entry_at, last_checked_at, status)
    VALUES (@chain, @tokenAddress, @symbol, @name, @entryPriceUsd, @positionSizeUsd,
       @takeProfitPct, @stopLossPct, @entryAt, @entryAt, 'open')
    ON CONFLICT(chain, token_address) DO NOTHING
  `);
  return stmt.run(entry);
}

export function getOpenPaperTrades() {
  return db.prepare("SELECT * FROM paper_trades WHERE status = 'open'").all();
}

export function getPaperTradeById(id) {
  return db.prepare("SELECT * FROM paper_trades WHERE id = ?").get(id);
}

// A trade crossed take_profit_pct while Super Comando was on — instead of
// closing, it enters "ride" mode: take_profit_pct becomes a protected floor
// (drop below it and it sells immediately) while the AI periodically judges
// whether to cash out higher or keep holding.
export function activateComandoMode(id, { peakPct }) {
  const now = Date.now();
  db.prepare(
    "UPDATE paper_trades SET comando_active = 1, comando_activated_at = ?, comando_peak_pct = ?, comando_last_ai_check_at = ? WHERE id = ?"
  ).run(now, peakPct, now, id);
}

export function touchComando(id, { peakPct, aiCheckedAt }) {
  db.prepare("UPDATE paper_trades SET comando_peak_pct = ?, comando_last_ai_check_at = ? WHERE id = ?").run(peakPct, aiCheckedAt, id);
}

export function countOpenPaperTrades() {
  return db.prepare("SELECT COUNT(*) AS n FROM paper_trades WHERE status = 'open'").get().n;
}

export function touchPaperTrade(id) {
  db.prepare("UPDATE paper_trades SET last_checked_at = ?, price_unavailable_since = NULL WHERE id = ?").run(Date.now(), id);
}

// Called instead of touchPaperTrade when this check couldn't get a sane
// price. COALESCE only sets price_unavailable_since on the *first* such
// check — later calls leave the original timestamp alone, so the caller can
// measure how long the position has actually been stuck, not just that it
// failed this one time.
export function touchPaperTradeStalePrice(id) {
  const now = Date.now();
  db.prepare(
    "UPDATE paper_trades SET last_checked_at = ?, price_unavailable_since = COALESCE(price_unavailable_since, ?) WHERE id = ?"
  ).run(now, now, id);
}

export function closePaperTrade(id, { exitPriceUsd, exitReason, pnlUsd, pnlPct }) {
  db.prepare(
    `UPDATE paper_trades
     SET status = 'closed', exit_price_usd = ?, exit_at = ?, exit_reason = ?, pnl_usd = ?, pnl_pct = ?, last_checked_at = ?
     WHERE id = ?`
  ).run(exitPriceUsd, Date.now(), exitReason, pnlUsd, pnlPct, Date.now(), id);
}

export function getPaperTradingStats() {
  const open = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(position_size_usd), 0) deployed FROM paper_trades WHERE status = 'open'").get();
  const closed = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(pnl_usd), 0) totalPnl FROM paper_trades WHERE status = 'closed'").get();
  const wins = db.prepare("SELECT COUNT(*) n FROM paper_trades WHERE status = 'closed' AND pnl_pct >= 0").get().n;
  return {
    openCount: open.n,
    deployedUsd: open.deployed,
    closedCount: closed.n,
    totalPnlUsd: closed.totalPnl,
    wins,
    winRate: closed.n > 0 ? wins / closed.n : null,
  };
}

export function getClosedPaperTrades(limit = 20) {
  return db.prepare("SELECT * FROM paper_trades WHERE status = 'closed' ORDER BY exit_at DESC LIMIT ?").all(limit);
}

// --- real_trades: same shape/lifecycle as paper_trades, plus on-chain
// execution fields (tx hashes, actual native amounts, gas cost). Entry rows
// are only ever written after a real transaction has actually confirmed —
// see realTrading.js.
export function openRealTrade(entry) {
  const stmt = db.prepare(`
    INSERT INTO real_trades
      (chain, token_address, symbol, name, entry_price_usd, position_size_usd,
       take_profit_pct, stop_loss_pct, entry_at, last_checked_at, status,
       token_amount_raw, native_spent, entry_tx_hash, entry_gas_usd)
    VALUES (@chain, @tokenAddress, @symbol, @name, @entryPriceUsd, @positionSizeUsd,
       @takeProfitPct, @stopLossPct, @entryAt, @entryAt, 'open',
       @tokenAmountRaw, @nativeSpent, @entryTxHash, @entryGasUsd)
    ON CONFLICT(chain, token_address) DO NOTHING
  `);
  return stmt.run(entry);
}

export function getOpenRealTrades() {
  return db.prepare("SELECT * FROM real_trades WHERE status = 'open'").all();
}

export function getRealTradeById(id) {
  return db.prepare("SELECT * FROM real_trades WHERE id = ?").get(id);
}

export function activateRealComandoMode(id, { peakPct }) {
  const now = Date.now();
  db.prepare(
    "UPDATE real_trades SET comando_active = 1, comando_activated_at = ?, comando_peak_pct = ?, comando_last_ai_check_at = ? WHERE id = ?"
  ).run(now, peakPct, now, id);
}

export function touchRealComando(id, { peakPct, aiCheckedAt }) {
  db.prepare("UPDATE real_trades SET comando_peak_pct = ?, comando_last_ai_check_at = ? WHERE id = ?").run(peakPct, aiCheckedAt, id);
}

export function countOpenRealTrades() {
  return db.prepare("SELECT COUNT(*) AS n FROM real_trades WHERE status = 'open'").get().n;
}

export function touchRealTrade(id) {
  db.prepare("UPDATE real_trades SET last_checked_at = ?, price_unavailable_since = NULL WHERE id = ?").run(Date.now(), id);
}

// Same purpose as touchPaperTradeStalePrice — tracks how long a real
// position has had no sane price so realTrading.js can force a sell attempt
// after a sustained outage instead of leaving the position stuck forever
// (this is what let Sunshine/unicorn sit unmanaged with no stop-loss chance
// once their pools' liquidity got drained to near-zero).
export function touchRealTradeStalePrice(id) {
  const now = Date.now();
  db.prepare(
    "UPDATE real_trades SET last_checked_at = ?, price_unavailable_since = COALESCE(price_unavailable_since, ?) WHERE id = ?"
  ).run(now, now, id);
}

export function closeRealTrade(id, { exitPriceUsd, exitReason, pnlUsd, pnlPct, nativeReceived, exitTxHash, exitGasUsd }) {
  db.prepare(
    `UPDATE real_trades
     SET status = 'closed', exit_price_usd = ?, exit_at = ?, exit_reason = ?, pnl_usd = ?, pnl_pct = ?,
         last_checked_at = ?, native_received = ?, exit_tx_hash = ?, exit_gas_usd = ?
     WHERE id = ?`
  ).run(exitPriceUsd, Date.now(), exitReason, pnlUsd, pnlPct, Date.now(), nativeReceived, exitTxHash, exitGasUsd, id);
}

// Manual trading terminal partial sell — reduces an open real position in
// place rather than closing it, since the schema tracks one row per open
// token position, not a per-sell ledger. The realized PnL for the sold
// portion is reported in the moment (Telegram message) but isn't separately
// queryable later — a known, disclosed limitation of the partial-sell path.
export function reduceRealTrade(id, { tokenAmountRaw, positionSizeUsd }) {
  db.prepare("UPDATE real_trades SET token_amount_raw = ?, position_size_usd = ?, last_checked_at = ? WHERE id = ?").run(
    tokenAmountRaw,
    positionSizeUsd,
    Date.now(),
    id
  );
}

export function getOpenRealTradeByToken(chain, tokenAddress) {
  return db.prepare("SELECT * FROM real_trades WHERE chain = ? AND token_address = ? AND status = 'open'").get(chain, tokenAddress);
}

export function getRealTradingStats() {
  const open = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(position_size_usd), 0) deployed FROM real_trades WHERE status = 'open'").get();
  const closed = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(pnl_usd), 0) totalPnl FROM real_trades WHERE status = 'closed'").get();
  const wins = db.prepare("SELECT COUNT(*) n FROM real_trades WHERE status = 'closed' AND pnl_pct >= 0").get().n;
  return {
    openCount: open.n,
    deployedUsd: open.deployed,
    closedCount: closed.n,
    totalPnlUsd: closed.totalPnl,
    wins,
    winRate: closed.n > 0 ? wins / closed.n : null,
  };
}

export function getClosedRealTrades(limit = 20) {
  return db.prepare("SELECT * FROM real_trades WHERE status = 'closed' ORDER BY exit_at DESC LIMIT ?").all(limit);
}

// Tracks distinct Telegram users who've interacted with the bot, for the
// "Bot Stats" live user count — recorded on every incoming update, not just
// /start, so it stays accurate for users who never explicitly restarted.
export function recordBotUser(telegramUserId) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO bot_users (telegram_user_id, first_seen_at, last_seen_at)
     VALUES (?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET last_seen_at = ?`
  ).run(String(telegramUserId), now, now, now);
}

export function countBotUsers() {
  return db.prepare("SELECT COUNT(*) AS n FROM bot_users").get().n;
}
