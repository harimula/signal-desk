# Signal Desk trading bot

Paper money first: the bot trades an **Alpaca paper account** (fake money, real prices).
It runs on GitHub Actions and watches every second during market hours. No computer of
yours needs to stay on.

## Why it trades what it trades
`bot/research.mjs` tested four strategies on 39 large US stocks from 1993 to 2026, with
0.05% costs per side, 10% of equity per position and at most 6 positions, judged on the
last 30% of years (2016–2026), which were never used to choose anything:

| Strategy | Out-of-sample yearly return | Sharpe | Max drawdown |
|---|---|---|---|
| **RSI-2 dip buying (what the bot runs)** | **+3.3%** | **0.41** | **−14.5%** |
| Old intraday pullback rules (retired) | −6.6% | −2.36 | −50.0% |
| Trend breakout | +9.2% | 0.90 | −11.9% |
| SPY buy & hold | +13.1% | 0.78 | −34.1% |

**Corrected 2026-10-25.** Earlier versions of this table showed RSI-2 at +16.4% a year. The
simulator let money from a 4 PM sale pay for a 9:30 AM buy on the same day (look-ahead); fixed,
RSI-2 makes +8.7% a year over all 33 years (SPY +8.8%, with a −56% worst fall against −15%) but
only +3.3% a year in the out-of-sample decade, well behind simply holding SPY.

Full table: `bot/research_report.md` (re-run: Actions → strategy-research → Run workflow).
Survivorship bias (today's big companies, looking back) flatters every result — treat them
as an upper bound. Past results do not predict future results.

## The strategy
- **Buy:** a stock whose last close is above its 200-day average with RSI-2 below 10 (a
  sharp dip inside an uptrend). Bought in the first trading hour (from 9:45, after 10:15 on
  CPI/jobs days), market leaders first (or deepest dip first — a setting). Skipped if it already bounced 1%+ since yesterday's close.
- **Sell:** at +10% (take-profit, changeable), otherwise in the last 10 minutes of the session once the price is above its 5-day average,
  or after 10 sessions. No stop order — the version with a stop did worse in testing — but a
  25% hard floor stays on as a disaster brake.
- **CALLs** on the same dips: strike nearest the price, expiry 14–35 days. Sold with the
  stock's exit, at +50% (resting order at the broker), at −50%, or 3 days before expiry.
  Options were *not* backtested (no free historical option prices).

## Professional risk controls
- **Position sizing:** each stock trade is sized so a 3×-average-range move against it costs at
  most **0.5%** of the account, and never more than 10% of the account per position.
  Option trades: the −50% stop costs at most 0.5% of the account.
- **Total risk cap:** money at risk across all open positions and pending orders ≤ **3%**.
- **Sector cap:** at most **2** positions per sector.
- **Circuit breakers:** stop for the day after **3** losing trades in a row or **−3%** on the
  day; no new trades after **−6%** in a week.
- **Stale orders:** entries unfilled after 45 minutes are cancelled.
- **Idempotency:** the same order can never be sent twice.
- **News & events guard:** Fed decision days (no new trades 1:30–3:00pm, no new options, half
  size), CPI/jobs/PPI mornings (wait until 10:15), Fed minutes (paused 1:45–2:30pm), breaking
  war/policy/crisis headlines (30-minute pause), company news or earnings (stock skipped).
- **Kill switch:** add a file named `bot/STOP` → everything is cancelled and sold within seconds.

## Monitoring
- **Bot trades tab** on your site: running / not-reporting status, risk dashboard (regime,
  money at risk vs cap, sectors), performance (expectancy, profit factor, win rate, drawdown,
  by Stock/Call), the 33-year scorecard, and every trade with entry and exit times.
- **Phone alerts (free):** Telegram — create your bot with @BotFather, then Bot settings → 1 →
  Connect Telegram. You get every buy/sell, halt and error, and commands like /status and /money.
- **Tests:** `node bot/test.mjs` (29 checks) runs automatically on every change.

## Control panel (Bot settings tab on your site)
Everything below is set from the **Bot settings** tab, not by editing files:
risk profile (Conservative / Balanced / Aggressive / Custom), capital per stock and per option
trade, max positions, strategy parameters, the stock universe, the news and calendar guards,
paper vs live mode, and Pause / Resume / Run now. Settings save to `bot/config.json`; the bot
re-reads it every minute. Broker keys are encrypted in your browser with GitHub's public key
and stored as repository secrets — they never appear on the page or in the repo.

Connect once per device with a fine-grained GitHub token (Contents, Secrets and Actions:
read & write, scoped to this repo only). The token stays in that browser.

## Setup (about 10 minutes)
1. Sign up free at https://alpaca.markets, switch to **Paper**, generate API keys.
2. Repo → Settings → Secrets and variables → Actions → add `ALPACA_KEY`, `ALPACA_SECRET`
   (Telegram is connected from the site's Bot settings). Never paste keys into chat or code.
3. Actions tab → enable **paper-trade-bot**.

## Tuning (Settings → Secrets and variables → Actions → Variables)
`BOT_RISK_PCT` (0.5) · `BOT_MAX_HEAT` (3) · `BOT_MAX_PER_SECTOR` (2) · `BOT_PER_TRADE` (0 = 10% of
equity) · `BOT_OPT_BUDGET` (0 = 2% of equity) · `BOT_OPT_TAKE_PROFIT` (50) · `BOT_MAX_POSITIONS` (6)
· `BOT_MAX_OPTIONS` (4) · `BOT_HOLD_FLOOR` (25) · `BOT_STOCKS` / `BOT_OPTIONS` (0 = off) · `BOT_SYMBOLS`.

## Real money
Run paper for at least 2–3 months and compare live results with the research first.
Live trading uses **separate** credentials: add `ALPACA_LIVE_KEY` and `ALPACA_LIVE_SECRET` as
repository secrets (the paper keys stay as they are), then flip Mode to **Live** in Bot settings
and type the confirmation phrase. The bot only talks to the live endpoint when both the mode is
`live` and live keys exist — a paper key can never reach the live account. That decision and
those keys are yours alone, losses included. This is a rules engine, not financial advice.
See `SECURITY.md` for the full checklist (2FA, private journal, PDT rule, what stays public).
