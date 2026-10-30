# Covered calls on the dip buys — 30 October 2026

**Question (owner):** *"Yes but covered calls is different right"* — covered calls need no extra cash, so could the
stock part's own buys sell them, instead of only the wheel's shares?

**Answer in one line:** it earned a little more per trade in the test (about +0.5 % with the standard settings), but it
paid for that by holding each trade twice as long, cutting the win rate under 80 %, giving the edge back in 2026's
strong market — and a few times it turned a quick +2 % win into a −20 % loss, because the shares were frozen under the
call while the stock collapsed. **Nothing in the bot was changed.**

Before tax. One market window (Feb 2024 – Oct 2026, mostly rising), today's stocks looking back. Not financial advice.

## 1. What was tested

`tools/covered-call-study.mjs` (workflow `covered-call-study.yml`, output `research-data/covered-call-study.json`),
trade by trade on each contract's real daily bars:

- **Plain (the bot today):** buy 100 shares at the close of a day whose RSI-2 is under 25 with the close above the
  200-day average and SPY above its own (the market filter); sell at the first close at least 0.5 % above the buy
  price, after 15 sessions at the latest, or at the −25 % floor.
- **Covered:** the same buy, plus one call sold the same day — the lowest strike 5 % (or 10 %) over the price, expiring
  at the nearest monthly expiration at least 7 days out, held to expiry or bought back at half the premium (tp50). The
  shares are **frozen** while the call is open: the sell rule waits; only the −25 % floor still sells (buying the call
  back first, at that day's price). A close over the strike at expiry sells the shares at the strike. Once the call is
  gone, the sell rule resumes — by then the 15-session clock has usually run out, so the shares go at the next close.
- Fills at the day's average traded price ± half an assumed 4 % spread; premium at least $0.05. Signals spaced per
  stock (one position at a time). Stocks priced **$15–$120** at the signal: 12 % of a $100,000 stake buys 100+ shares
  only under about $120 — this rule can never cover most of the account's buys. About a quarter of the signals had no
  usable 5 % call at all (111 → 83 paired on the large companies, 174 → 145 on the scan list).

## 2. Results — large companies (83 paired trades)

| | Won | Avg/trade | Avg win | Avg loss | Worst | Sessions held | vs plain, per trade | Trades worse off | Called away |
|---|---|---|---|---|---|---|---|---|---|
| **Plain rule** | **80.7 %** | −0.09 % | +1.8 % | −8.1 % | −25.0 % | 5.1 | — | — | — |
| Call 5 % over, bought back at half | 78.3 % | +0.42 % | +2.8 % | −8.1 % | −23.0 % | 9.8 | **+0.51 %** | 19 % | 7 % |
| Call 5 % over, held to expiry | 67.5 % | +0.69 % | +3.8 % | −5.7 % | −21.2 % | 15.0 | +0.79 % | 30 % | 11 % |
| Call 10 % over, bought back at half* | 78.9 % | −0.08 % | +2.7 % | −10.7 % | −23.8 % | 9.2 | +0.50 % | 24 % | 3 % |
| Call 10 % over, held to expiry* | 57.9 % | −0.57 % | +4.5 % | −7.5 % | −22.8 % | 16.1 | +0.01 % | 42 % | 5 % |

## 3. Results — the bot's scan stocks, $15–$120 (145 paired trades)

| | Won | Avg/trade | Avg win | Avg loss | Worst | Sessions held | vs plain, per trade | Trades worse off | Called away |
|---|---|---|---|---|---|---|---|---|---|
| **Plain rule** | **86.9 %** | +0.84 % | +2.5 % | −10.4 % | −29.3 % | 4.5 | — | — | — |
| Call 5 % over, bought back at half | 77.9 % | +1.42 % | +4.3 % | −8.9 % | −26.9 % | 10.7 | **+0.57 %** | 21 % | 15 % |
| Call 5 % over, held to expiry | 69.7 % | +2.07 % | +6.1 % | −7.1 % | −24.7 % | 14.6 | +1.22 % | 26 % | 30 % |
| Call 10 % over, bought back at half* | 87.9 % | +3.27 % | +5.4 % | −11.9 % | −24.0 % | 9.6 | +1.67 % | 18 % | 15 % |
| Call 10 % over, held to expiry* | 71.7 % | +2.98 % | +7.6 % | −8.8 % | −23.0 % | 14.7 | +1.38 % | 34 % | 21 % |

\* The 10 %-over rows only contain the trades where such a call existed with a real premium (38 of 83, 99 of 145) —
stocks volatile enough to pay for a far-away strike. Their "vs plain" is measured on that smaller, livelier subset, so
it is not comparable row-to-row with the 5 % rows.

## 4. What the numbers say

- **The call added about half a percent per trade** with the standard settings (5 % over, bought back at half) — the
  premiums more than paid for the capped winners *in this window*.
- **It ties the money up twice as long** (10–11 sessions against 4.5–5), so per session in the market the plain rule
  earned more on the scan list (+0.19 %/session against +0.13 %). The bot has 8 slots and lives off recycling money
  into the next dip; a frozen slot is a dip not bought. The per-trade edge shrinks or disappears once that is counted.
- **The win rate falls below 80 %** in every 5 % variant (78 % at best, 58–70 % held to expiry) — the rule the owner
  asked for on 2026-10-27 was chosen for its 80 %+ win rate.
- **2026 flipped the sign.** By entry year, "5 % over, bought back at half" was +1.1 % / +0.25 % / −0.01 % per trade
  (2024 / 2025 / 2026) on the large companies and +0.92 % / +0.58 % / **−0.45 %** on the scan list: the stronger the
  market, the more the cap costs.
- **The freeze is the real danger.** NBIS 2025-11-04: the plain rule sold +5.8 % the next day; covered, the stock
  collapsed through the −25 % floor while the shares were frozen — **−20.3 %**, a 26-point swing on one trade. MRVL
  2025-02-27: +4.8 % plain, −17.5 % covered. INTC 2026-07-07: +2.0 % plain, −19.8 % covered. The averages above
  include these; a couple more of them and the edge is gone.
- **Statistically thin:** with ~100–150 trades and single-trade swings of ±20 %, an average edge of half a percent is
  about one standard error from zero — this window cannot prove it is real.

## 5. Why it stays out of the bot

The owner's stock rule was rebuilt on 2026-10-27 around three things: an 80 %+ win rate, selling fast (first
profitable close), and the money never being stuck. The covered call works against all three, pays mainly in
sideways-to-down months (2024-style), gives it back in trending ones (2026), and adds a new way to lose big (the
freeze). The wheel already sells covered calls where they belong: on 100-share lots that are *meant* to sit for weeks.
The owner can ask for it anyway; it would go in as a separate switched-off setting like everything else.

## 6. Reproduce

```
gh workflow run covered-call-study.yml                # needs the paper Alpaca keys (stock and option bars)
git fetch origin +research-data:refs/remotes/origin/research-data
git show origin/research-data:research-data/covered-call-study.json > covered-call-study.json
```
