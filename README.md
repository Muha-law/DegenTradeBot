# Degen Assistant Bot

Telegram bot that watches new token launches on EVM chains, filters them through
a configurable rule set, scores risk, and posts "calls" with ongoing price updates.

## What it does today

1. Listens for `PairCreated` events on DEX factories (Uniswap V2 on Ethereum/Base/Arbitrum,
   PancakeSwap V2 on BSC) via WebSocket RPC — this is how it detects new launches in real time.
2. Pulls contract-safety, liquidity/lock, and holder data (GoPlus Security API) plus
   live price/liquidity (DexScreener API) for every new token.
3. Computes a 0–100 risk score across four weighted categories: contract safety,
   liquidity & lock, holder distribution, deployer history.
4. Runs the token through `data/filters.json` — your "special filter." Only tokens that
   pass every threshold get posted to your Telegram chat as a call.
5. Re-checks price on every called token every `PRICE_UPDATE_INTERVAL_MINUTES` for
   `PRICE_UPDATE_WINDOW_HOURS`, posting % change updates.

More features (new chains, DEXs, alert types, backtesting, etc.) get added incrementally —
this is intentionally a minimal but working core.

## Setup

1. **Create the bot**: message [@BotFather](https://t.me/BotFather) on Telegram, run
   `/newbot`, copy the token into `TELEGRAM_BOT_TOKEN`.
2. **Get your chat id**: message [@userinfobot](https://t.me/userinfobot) for your personal id,
   or add the bot as admin to a channel/group and use that channel's numeric id
   (starts with `-100`). Put it in `TELEGRAM_CHAT_ID`.
3. **Get your user id** (for admin-only commands) — same @userinfobot — put in `ADMIN_USER_ID`.
4. Copy `.env.example` to `.env` and fill in the values above. The default RPC endpoints
   (publicnode.com) and GoPlus/DexScreener APIs need no signup to get started.
5. Optional but recommended: get a free [Etherscan API key](https://etherscan.io/apis) and
   set `ETHERSCAN_API_KEY` — powers the deployer-history part of the risk score. Works fine
   without it (that category just defaults to a neutral score).
6. Install deps and run:

```bash
npm install
npm start
```

## Tuning "my special filter"

Edit `data/filters.json` (or use `/setfilter <key> <value>` in Telegram, admin only) —
no restart required, it's read fresh on every token. Current thresholds:

- `minLiquidityUsd`, `minHolderCount`, `maxTop10HolderPercent`, `maxCreatorHolderPercent`
- `requireLpLockedOrBurned`, `requireNotHoneypot`, `requireOpenSource`, `blockMintable`
- `minRiskScore` — overall risk score floor
- `maxTokenAgeMinutes` — currently a no-op for the live watcher (it always reacts at age 0);
  kept for when a backlog/polling path gets added.

Tell me your exact filter rules (specific thresholds, chains to prioritize, tokens/patterns
to always exclude, etc.) and I'll encode them directly instead of the current defaults.

## Telegram commands

- `/start` — status + command list
- `/status` — watcher stats
- `/filter` — show current filter thresholds
- `/setfilter <key> <value>` — change a threshold live (admin only)
- `/score <chain> <tokenAddress>` — on-demand risk score for any token
- `/watchlist` — tokens currently being price-tracked

## Notes / next steps

- Chains are configured in `src/chains.js` (factory address, wrapped native, API chain ids).
  Add more DEXs (Uniswap V3, Aerodrome, etc.) or chains (Solana would need a different
  watcher since it's not EVM) as separate watcher modules later.
- Storage is a local SQLite file at `data/bot.sqlite` (seen pairs, called tokens, deployer
  history used to flag serial ruggers over time).
- This is not financial advice and the bot can't guarantee accuracy of third-party data
  (GoPlus/DexScreener) — treat calls as a filtered shortlist, not a buy signal.
