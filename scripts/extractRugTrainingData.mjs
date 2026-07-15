// Run this ON the production container (via `railway ssh`), not locally —
// it reads the live /data/bot.sqlite. Dumps one JSON array to stdout;
// redirect it to a file and feed that to trainRugModel.py.
//
//   railway ssh "node scripts/extractRugTrainingData.mjs" > trainingData.json
//
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("/data/bot.sqlite");

const rows = db.prepare(`
  SELECT
    c.chain, c.risk_score,
    c.call_liquidity_usd, c.call_volume24h_usd, c.call_market_cap_usd,
    p.exit_reason, p.pnl_pct, p.entry_at
  FROM called_tokens c
  JOIN paper_trades p ON p.chain = c.chain AND p.token_address = c.token_address
  WHERE p.status = 'closed' AND p.pnl_pct IS NOT NULL
`).all();

console.log(JSON.stringify(rows));
