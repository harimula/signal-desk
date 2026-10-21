# Signal Desk trading bot — setup (paper money first)

The bot trades an **Alpaca paper account** — fake money, real market prices — using the
same rules as the dashboard's Day trading tab. It runs on GitHub Actions and **watches every second** for the whole session: a quick
check each second (prices, fills, option levels) and a full decision cycle every 20 seconds
— instantly when the quick check sees a fill or a trigger. No computer of yours needs to
stay on.

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

## What it trades
**Stock day trades** — buy limit at S3 when a stock closed above its 20-day average with
RSI-2 ≤ 40. The moment it fills, a sell limit sits at the broker at **+1% or the R1 target,
whichever comes first** — profit is taken early, any time of day, and the slot frees up for
the next trade (up to 3 trades per stock per day). At 3:45pm ET anything still open that is
a winner or a small loser is sold.
**A stock down more than 1.5% at the close is HELD instead of sold at a loss** — it gets a
sell limit at breakeven (+0.3%) and waits to recover. Two guards stay on: a hard floor at
−25% and a 30-day maximum hold.

**CALLs** on the same uptrend setups, **PUTs** on the mirror setups (downtrend stock that
bounced up hard, RSI-2 ≥ 60) — bought only once the stock actually touches the trigger
level. Strike nearest the trigger, expiry 6–17 days out, skipped if the bid/ask spread is
wider than 20%. Exits: a sell limit at **+50%** sits at the broker from the moment it fills (instant
profit-taking); all out at −50%, all by 3:40pm the next session, never into expiry day. Options are never held at a loss "to recover" — they decay.

Stands aside the first 15 minutes; no new entries after 3:00pm. If the account is down 3%
on the day it stops opening trades and closes its options (held stocks stay).

Alpaca paper accounts normally have options enabled; if options orders are rejected, turn
options on in the Alpaca dashboard (paper) or set `BOT_OPTIONS=0`.

## Watching it
Your site's **Bot trades** tab shows every trade — bought when, sold when, at what price —
day-by-day P/L, total realized P/L, open positions and the account value. It reads
`bot/journal.json`, which the bot updates after trades and about every 30 minutes.

## Controls (Settings → Secrets and variables → Actions → Variables)
`BOT_PER_TRADE` ($500 per stock trade), `BOT_OPT_BUDGET` ($300 per option trade),
`BOT_MAX_POSITIONS` (6 stocks), `BOT_MAX_OPTIONS` (4), `BOT_HOLD_LOSS` (1.5),
`BOT_HOLD_FLOOR` (25), `BOT_TAKE_PROFIT` (1 = +1% stock quick profit),
`BOT_OPT_TAKE_PROFIT` (50 = +50% option profit), `BOT_MAX_ENTRIES_PER_SYM` (3),
`BOT_STOCKS` / `BOT_OPTIONS` (set to 0 to switch either off).

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

## How the every-second watching works
GitHub can only *start* a job every 5 minutes, so each job starts once and stays alive for
the session (up to ~5h45m — GitHub's limit is 6h); the next scheduled job waits in the queue
and takes over the moment the first one ends. Each second it makes 1–2 light requests
(positions, latest prices); every 20 seconds, or the instant it sees a fill or a price
touching a trigger, it runs a full cycle. That stays under Alpaca's 200-requests/minute limit.
Profit-taking sell orders rest at Alpaca, so they fill at broker speed regardless.
Keep the repo public: public repos get unlimited free Actions minutes (a private repo would
burn ~8,000 minutes a month this way).
