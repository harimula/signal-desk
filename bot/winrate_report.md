# Win-rate study — 27 October 2026

**Question (owner):** *"Win rate is less than 50%; I need it at 80%. Change the settings and the bot logic."*

**Live record that morning:** 19 closed trades, 42% won — stocks 5 of 8 (63%), PUTs 1 of 6 (17%), SPY quick
options 2 of 5 (40%), CALLs none closed. Far too few trades to judge a rule, so every change below was decided
on history, not on these 19.

**Answer in one line:** only the stock dip rule can win 8 trades in 10, and only with a different sell rule —
sell at the first close at least 0.5% above the buy price (held up to 15 sessions), with a market filter. No
option setting reached 80% at a profit in any test, so CALLs, PUTs, SPY quick options and day trading were
switched off on the owner's account and their money went to stocks.

Before tax. Today's big companies looking back (survivorship bias) flatter every rule alike. Not financial advice.

## 1. The stock rule

Daily prices 1993–2026 for the 39 large companies of the original research (Yahoo, split-adjusted), and the bot's
own scan list (200 most-traded stocks over $50) for 2016–2026. Portfolio as the bot runs it: 12% of the money
per stock, at most 8, 0.05% cost per side, buy level RSI-2 25 with intraday signals, leaders first, +10%
take-profit and a 25% stop unless the row says otherwise. Intraday buys fill **in time order** — the dips
already below their level when entries open take the free slots first (leaders first among them), then the dips
that needed the smallest further fall — because that is how the live bot fills them. The last two rows show
how much an optimistic fill order (the best-ranked dips of the whole day, as if the bot knew in the morning
which stocks would dip by the afternoon) would flatter the result.

| Rule | Won | Avg win | Avg loss | Avg trade | Trades/yr | Per year 1993–2026 | Worst fall | Per year 2016–26 | Per year last 5 | Worst fall last 5 | Scan list 2016–26: won · per year |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Your settings until 2026-10-27 (sell on the bounce, 10-day hold) | 65.2% | +1.8% | −2.7% | +0.22% | 421 | +10.6% | −25% | +4.3% | +2.3% | −16% | 65.9% · +15.3% |
| Bounce + market filter | 65.3% | +1.7% | −2.5% | +0.22% | 327 | +8.5% | −20% | +3.7% | +1.0% | −14% | 65.7% · +14.8% |
| First close +0.5%, 10-day hold | 78.3% | +1.8% | −5.1% | +0.30% | 332 | +11.5% | −29% | +5.4% | +0.6% | −20% | 79.7% · +24.5% |
| First close +0.5%, 15-day hold | 82.3% | +1.8% | −6.3% | +0.35% | 288 | +11.9% | −40% | +7.3% | +2.0% | −21% | 83.7% · +25.3% |
| **First close +0.5%, 15-day hold, market filter (new settings)** | **82.4%** | +1.7% | −5.9% | +0.39% | 226 | +10.3% | **−18%** | +6.4% | +1.8% | −14% | 83.8% · +22.6% |
| First close +0.25%, 15-day hold, market filter | 85.0% | +1.5% | −6.1% | +0.37% | 244 | +10.8% | −20% | +7.8% | +3.6% | −14% | 85.2% · +20.9% |
| First close +1%, 15-day hold, market filter | 77.8% | +2.2% | −5.7% | +0.43% | 196 | +9.8% | −20% | +6.0% | −0.3% | −15% | 81.7% · +22.4% |
| First close +0.5%, 20-day hold, market filter | 85.4% | +1.7% | −7.1% | +0.43% | 205 | +10.4% | −23% | +5.5% | −0.1% | −14% | 86.1% · +20.6% |
| New settings, buying the next morning instead (intraday off) | 82.8% | +1.7% | −5.8% | +0.42% | 214 | +10.8% | −21% | +6.2% | +3.1% | −14% | 82.8% · +16.3% |
| New settings with buy level 10 | 82.3% | +1.7% | −5.9% | +0.38% | 222 | +10.0% | −17% | +7.9% | +3.1% | −15% | 83.8% · +22.7% |
| New settings, optimistic fill order | 83.5% | +1.8% | −6.2% | +0.45% | 231 | +12.5% | −17% | +9.7% | +5.2% | −15% | 85.7% · +37.5% |
| Until 2026-10-27, optimistic fill order | 66.4% | +1.7% | −2.7% | +0.26% | 426 | +13.4% | −24% | +10.0% | +7.0% | −14% | 67.9% · +29.4% |

What it shows:
- **The sell rule is what sets the win rate.** Every exit that sells on a bounce — a close above the 5-day
  average or above yesterday's high, RSI-2 above 70 — wins about 2 trades in 3 (selling at the first up close:
  58%), whatever the buy level (25, 10 or 5) or the entry (intraday, next open, a limit 1–5% below yesterday's
  close). Selling only at a profitable close lifts it to about 4 in 5: most dips
  recover a little within days; the ones that don't are held to the time limit.
- **The price of a high win rate is larger losses.** The average loss more than doubles (−2.7% → −5.9%); the
  average win is unchanged (+1.7–1.8%). Per year the new rule earns about the same as the old one — a little
  more since 2016, a little less in the last five years — and nothing here beats the S&P 500 in the recent
  years (about +13% a year since 2016).
- **The market filter matters with this rule.** Without it, holding losers longer through 2000–02 and 2008
  took the worst fall to −40%; with it −18%. With the old bounce rule the filter cost more than it saved,
  which is why the original research left it out.
- **15 sessions is the balance.** 20 wins more often (85%) but earns less; 10 wins 78%.
- 0.25% instead of 0.5% wins more (85%) at a similar return but leaves less room for the price slip of a
  real sale at the close; 0.5% was kept.
- Year by year the new rule won between 77% and 89% of its trades, except 2022 (71%, a falling market) and
  2008 (11 trades: the market filter kept it out most of the year). A high win rate is not a good year by
  itself: 2025 won 77% of its trades and still lost 8.6% (the April sell-off).

## 2. CALL options on the same dips

No option-price history exists for 33 years, so CALLs were priced with Black-Scholes (volatility 1.2 × the
stock's last-20-day realised volatility, 2% paid on each side for the bid/ask), one CALL per dip, 24 days to
expiry, market filter on, each trade measured on its own (no money limits).

| Exit | 39 stocks 1993–2026: trades · won · avg trade | Scan list 2016–26: won · avg trade |
|---|---|---|
| Until 2026-10-27: +50% / −50%, sold with the stock's bounce | 42,908 · 52.5% · −1.4% | 52.8% · −0.6% |
| Sold at the stock's first close +0.5% | 40,217 · 58.9% · −1.7% | 59.0% · −0.8% |
| Option's own first close +5%, +50% take-profit, −50% stop, 10 days | 38,506 · 60.2% · −1.7% | 60.5% · −0.9% |
| Option's own first close +5%, +50% take-profit, −70% stop, 15 days | 31,030 · 67.7% · −1.5% | 67.9% · −0.4% |
| Option's own first close +5%, +50% take-profit, no stop, 15 days | 23,002 · 72.2% · −0.7% (average loss −84%) | 73.0% · +1.5% |

Time decay eats the small stock gains a high win rate is made of: the best CALL setting wins about 7 in 10,
at about break-even, with losers that go to nearly zero. **CALLs off.**

## 3. PUTs and day trading

From the earlier research (`bot/research_report.md`, `bot/research_day_report.md`): the PUT stand-in (shorting
stock on RSI-2 pops below the 200-day) lost about 8% a year in the out-of-sample years; live, PUTs won 1 of 6.
Day trading won 31–36% of trades with no edge. **Both off.**

## 4. SPY quick options

The bot's own SPY rule (`bot/spyopt.mjs`: VWAP direction + 15-minute high/low break on volume) replayed minute
by minute on SPY's IEX one-minute prices from 3 January 2023 to 27 October 2026 (947 trading days), with the
owner's brakes (10 trades a day, 3 open at once, 2 losses in a row, 25% daily loss limit, 20% per trade).
Next-day option prices come from Black-Scholes with volatility = 0.52 × VIX on a trading-time clock, fitted to
111,236 real near-the-money option prices (median error 11%); the last 60 trading days were also replayed on
the real option minute prices.

| Take-profit / stop / time stop | Model, 947 days: trades · won · avg trade | Real prices, last 60 days: won · avg trade |
|---|---|---|
| +15% / −15% / 15 min (settings until 2026-10-27) | 3,123 · 48.3% · −0.3% | 54.7% · +1.8% (model on the same days: 53.8% · +1.1%) |
| +10% / −40% / 60 min (now saved, sleeve off) | 3,728 · 72.5% · −0.1% | 69.9% · +0.7% |
| +10% / −60% / 60 min | 3,746 · 73.7% · −0.1% | 70.6% · +0.7% |
| +30% / −40% / 60 min | 3,302 · 52.4% · +0.5% | — |

No setting reached 80%, and none made money reliably. Because the sleeve trades several times a day, it would
dominate the overall win rate: with it on, expect about 3 trades in 4 to win overall. **Sleeve off**, saved at
the setting with the most winners in case the owner switches it back on.

## 5. What changed

Code: `exitRule` (`bounce` | `profit`), `exitProfitPct` and `marketFilter` settings (bot/config.mjs),
`profitExit()` and `marketAbove200()` (bot/strategy.mjs), used by the stock exit and the entry gate in
bot/bot.mjs; the page shows the profit level as the exit of each held stock and "not entering now: market filter"
when it blocks. Owner's settings (bot/config.json): sell at the first close +0.5%, max hold 10 → 15, market filter
on; CALLs, PUTs, SPY quick options and day trading off; CALL and PUT shares 20% / 5% → 0% (stocks now get 100%);
SPY rules saved at +10% / −40% / 60 minutes. Positions already open keep being managed — an open CALL by its own
rules — and nothing is sold because of the change itself.

## 6. Reproduce

```
gh workflow run research-data.yml                     # price history → branch research-data
git fetch origin +research-data:refs/remotes/origin/research-data
mkdir -p research-data && for f in daily spy1m spyopt; do git show origin/research-data:research-data/$f.json.gz > research-data/$f.json.gz; done
node tools/winrate-study.mjs report                   # table 1   (also: quick | entry | risk | refine | calls)
node tools/winrate-study.mjs calls                    # table 2
node tools/spy-study.mjs                              # table 4   (REALGRID=1 for the real-price column)
```
