# Signal Desk trading bot — setup (paper money first)

The bot trades an **Alpaca paper account** — fake money, real market prices — using the
same rules as the dashboard's Day trading tab. It runs on GitHub Actions every 5 minutes
during US market hours. No computer of yours needs to stay on.

It can hold several stocks at once (default 6) and re-enter a stock after a target or
stop hits (default 2 entries per stock per day) — multiple trades per day by design.

## 1. Create a free Alpaca account (you do this part)
1. Sign up at https://alpaca.markets (choose the free individual account).
2. In the dashboard, make sure the **Paper** toggle (top-left) is on.
3. Go to the API keys panel and generate a key pair for the PAPER account.

## 2. Give the keys to the bot (GitHub secrets — not in code)
Repo → Settings → Secrets and variables → Actions → New repository secret:
- `ALPACA_KEY` — the key id
- `ALPACA_SECRET` — the secret

Secrets are encrypted and never appear in the code or logs.

## 3. Turn it on
Actions tab → "paper-trade-bot" → enable. It then runs itself every 5 minutes while the
market is open. Watch results at https://app.alpaca.markets (paper).

## The rules it follows
- Buy limit at S3 when a stock closed above its 20-day average with RSI-2 ≤ 40.
- Bracket order: target R1, stop S4 — target and stop live at the broker, not in the bot.
- Stands aside the first 15 minutes. Flattens everything at 3:45pm ET. Never holds overnight.
- Stops for the day if the account drops 3% (BOT_DAILY_LOSS_CAP).

## Controls (optional repo variables)
`BOT_PER_TRADE` ($500), `BOT_MAX_POSITIONS` (6), `BOT_MAX_ENTRIES_PER_SYM` (2),
`BOT_DAILY_LOSS_CAP` (3), `BOT_SYMBOLS` (comma list).

## Kill switch
Create a file named `bot/STOP` in the repo (GitHub → Add file). Next run (≤5 min) the bot
cancels all orders, sells everything, and halts until you delete the file.

## The 40-year backtest
Actions tab → "backtest" → Run workflow. It pulls up to 40 years of daily bars for 40
long-lived symbols, replays the same rules, and commits `bot/backtest_report.md` with
overall, per-year and per-symbol results. Honest limits: daily bars (40-year minute data
does not exist), one trade/symbol/day in the test, no fees, survivorship bias.

## Real money — read this first
Run paper for at least 1–2 months and compare with the backtest. If you ever switch
(`ALPACA_URL=https://api.alpaca.markets` + live keys), that decision and those keys are
yours alone, losses included. This is a rules demo, not financial advice.
