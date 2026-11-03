# SPY entry study — why the sleeve was losing, and what changed (2026-11-03)

The owner, after four red days: *"We are getting very, very bad results with SPY trades, we need to change the
strategy, when to buy the CALLs and PUTs … it's buying in wrong time."*

**What was tested** (`tools/spy0-study.mjs`): the bot's exact SPY rule (bot/spyopt.mjs `spySignal`), replayed minute by
minute on real SPY one-minute bars since January 2023 (~900 trading days), pricing the option two ways — a Black-Scholes
model (volatility = k × VIX) over the whole history, and **real option minute bars for the last ~60 trading days**
(next-day expiry, and same-day expiry newly added as `research-data/spyopt0.json.gz`). Entries pay the ask plus the
fast-fill cushion, as the live settings did. On top of the bot's rule it tested exits (take-profit 5–25 %, stop 25–35 %,
hold 30–60 min) and entry filters: morning-only, a wider gap from the VWAP, breaks beyond yesterday's high/low, and
retest (buy the pullback instead of the break).

**A caution on the model.** For same-day expiry the model calibrates badly (best k pinned at the grid edge, median
error 22 %), so same-day conclusions rest on the 59 days of real option prices. For next-day expiry the model tracks
real prices well enough to rank variants; the real-price table decides.

## Findings

1. **The settings of Oct 30 – Nov 3 (same-day expiry, take-profit 25 %) were the problem.**
   On the 900-day model, take-profit 25 % cuts the win rate to ~39 % (the +25 % target is rarely hit before the stop or
   the clock). On the 59 real-price days the same settings were ≈ breakeven per trade **with a worst run of 44 % of the
   sleeve** — Monday's −$4,517 (−46 %) was this setup behaving as measured, not a counting error.

2. **Same-day expiry lost money under every rule tested** — every exit grid row and every entry filter on the model,
   and all but one marginal row (+0.33 %/trade) on real prices. The option's same-day time decay eats the edge: the
   average winner pays ~+5 % while the average loser costs ~−20 to −28 %.

3. **Afternoon entries lose everywhere.** Real next-day prices: morning entries +2.3 %, afternoon −2.6 % per trade.
   The same split shows on the 900-day model in every variant. *This is the "buying at the wrong time."*

4. **The winner on both the 900-day model (best row) and the 60 real-price days:**
   **next-day expiry · entries 9:50–11:30 AM only · SPY at least 0.15 % past its VWAP · the break beyond yesterday's
   high (CALL) / low (PUT)**, with the tested exits (take-profit +5 %, stop −35 %, time stop 60 min):

   | on the last 60 days, real option prices | unfiltered rule | the new rule |
   |---|---|---|
   | trades | 156 (2.9/day) | **36 (~3/week)** |
   | won | 80.1 % | **94.4 %** |
   | average per trade | −0.68 % | **+2.76 %** |
   | worst run (of the SPY money) | 41 % | **6 %** |

5. **"Pay up to get in quickly" costs ~1.3 % per trade** — more than the whole next-day edge. It was built for
   same-day sprints; next-day contracts fill without it. Switched off.

## What changed (same day)

- New settings: `spyVwapGap` (default 0.05 % = old behaviour; **his 0.15 %**) and `spyBeyondPrev` (default off;
  **his on** — with it on, the sleeve waits until yesterday's high/low are loaded and says so).
- His settings: expiry same-day → **next-day**, take-profit 25 % → **5 %**, entries until 2:00 PM → **11:30 AM**,
  pay-up-to-get-in **off**. Stop −35 %, time stop 60 min, 20 % per trade, 3 open, 2-loss streak, 25 % day cap unchanged.

## Honest caveats

- 36 trades is a small sample: +2.76 % ± ~1.5 % per trade (about 1.8 standard errors from zero). The 900-day model
  agrees on the *ranking* (this variant is its best row too) but puts the long-run average nearer breakeven-to-small-
  positive: the last 60 days were friendlier than the long average.
- Fewer trades is the point: roughly 3 a week instead of 3 a day. Most days the sleeve will do nothing.
- This stays on the practice account until the paper record itself earns the switch (Bot settings 7 checklist).
  A measured edge is not a promise.
