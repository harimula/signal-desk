# Strategy research — 39 stocks, 1993-01-29 → 2026-10-23

Costs 0.05%/side · 10% of equity per position · max 6 positions · out-of-sample = 2016-09-06 onward (never used to choose anything).

| Strategy | Regime filter | CAGR (all) | Sharpe (all) | Max DD | **OOS CAGR** | **OOS Sharpe** | OOS Max DD | Trades | Win % | Exp./trade | PF |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Current bot rules (intraday pullback, S3 → R1, stop S4) | off | -8.66% | -1.84 | −95.3% | **-8.42%** | **-1.86** | −59.1% | 29994 | 32.5% | -0.10% | 0.76 |
| Current bot rules (intraday pullback, S3 → R1, stop S4) | on | -8.63% | -2.06 | −95.2% | **-8.72%** | **-2.01** | −60.4% | 27273 | 32.2% | -0.11% | 0.73 |
| RSI-2 mean reversion (Connors): above 200-day, RSI-2 < 10, buy at next open, sell when close > 5-day avg (max 10 days) | off | +8.74% | 0.93 | −15.1% | **+3.35%** | **0.41** | −14.5% | 10723 | 65.0% | +0.27% | 1.32 |
| RSI-2 mean reversion (Connors): above 200-day, RSI-2 < 10, buy at next open, sell when close > 5-day avg (max 10 days) | on | +8.11% | 0.93 | −14.5% | **+2.80%** | **0.37** | −14.5% | 9825 | 64.9% | +0.28% | 1.34 |
| RSI-2 mean reversion + 3× range stop | off | +6.20% | 0.68 | −20.7% | **+2.61%** | **0.34** | −15.4% | 11684 | 65.0% | +0.19% | 1.19 |
| RSI-2 mean reversion + 3× range stop | on | +5.88% | 0.69 | −21.3% | **+2.10%** | **0.29** | −15.4% | 10695 | 64.9% | +0.19% | 1.20 |
| RSI-2 with quick exits (owner's choice): same entries; sell at +10% or −5% during the day, otherwise when close > 5-day avg (max 10 days) | off | +5.15% | 0.60 | −16.9% | **+1.01%** | **0.16** | −14.0% | 12368 | 63.5% | +0.15% | 1.14 |
| RSI-2 with quick exits (owner's choice): same entries; sell at +10% or −5% during the day, otherwise when close > 5-day avg (max 10 days) | on | +4.81% | 0.60 | −16.7% | **+0.53%** | **0.11** | −13.6% | 11229 | 63.6% | +0.15% | 1.15 |
| RSI-2 with only the +10% take-profit (25% disaster stop) | off | +8.62% | 0.92 | −15.4% | **+3.19%** | **0.40** | −15.4% | 10731 | 65.0% | +0.27% | 1.32 |
| RSI-2 with only the +10% take-profit (25% disaster stop) | on | +7.91% | 0.92 | −15.4% | **+2.58%** | **0.34** | −15.4% | 9831 | 64.9% | +0.27% | 1.33 |
| RSI-2 with only the −5% stop | off | +5.29% | 0.62 | −16.9% | **+1.08%** | **0.17** | −14.8% | 12348 | 63.5% | +0.15% | 1.15 |
| RSI-2 with only the −5% stop | on | +4.91% | 0.61 | −16.8% | **+0.59%** | **0.11** | −14.4% | 11215 | 63.6% | +0.16% | 1.16 |
| RSI-2 with the owner's settings: buy below 25, sell at +10% or on the bounce, 25% stop | off | +8.39% | 0.88 | −14.5% | **+3.35%** | **0.41** | −14.3% | 11278 | 64.9% | +0.25% | 1.29 |
| RSI-2 with the owner's settings: buy below 25, sell at +10% or on the bounce, 25% stop | on | +7.74% | 0.88 | −14.3% | **+2.29%** | **0.30** | −14.3% | 10309 | 64.8% | +0.25% | 1.30 |
| RSI-2 (buy below 10) with +10% take-profit, 25% stop | off | +8.62% | 0.92 | −15.4% | **+3.19%** | **0.40** | −15.4% | 10731 | 65.0% | +0.27% | 1.32 |
| RSI-2 (buy below 10) with +10% take-profit, 25% stop | on | +7.91% | 0.92 | −15.4% | **+2.58%** | **0.34** | −15.4% | 9831 | 64.9% | +0.27% | 1.33 |
| RSI-2 short (mirror of the bot): below 200-day, RSI-2 > 90, short at next open, cover when close < 5-day avg (max 10 days) | off | -5.52% | -0.54 | −86.0% | **-8.40%** | **-0.95** | −61.1% | 7614 | 59.8% | -0.23% | 0.84 |
| Trend breakout: close at a 50-day high above the 200-day, exit on a 20-day low | off | +8.42% | 0.68 | −43.4% | **+9.24%** | **0.89** | −12.2% | 903 | 45.2% | +3.72% | 2.10 |
| Trend breakout: close at a 50-day high above the 200-day, exit on a 20-day low | on | +8.48% | 0.70 | −40.3% | **+9.21%** | **0.90** | −11.9% | 870 | 45.2% | +3.89% | 2.17 |
| SPY buy & hold | – | +8.82% | 0.55 | −56.5% | **+13.07%** | **0.78** | −34.1% | – | – | – | – |

| Russell 2000 (small caps) buy & hold | – | +7.69% | 0.44 | −59.9% | **+8.17%** | **0.45** | −43.1% | – | – | – | – |


## The last 5 years (2021-10-22 → 2026-10-23), from a fresh start

Benchmarks include dividends (ETF adjusted closes). The bot keeps at most 60% invested (6 positions × 10%).

| | Total | Per year | Worst fall | Sharpe | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|---|---|---|
| **USA bot — RSI-2 dip buying** | +7.80% | +1.50% | −14.5% | 0.22 | +2.50% | +1.20% | +2.80% | +4.90% | -2.50% | -1.10% |
| Large caps — S&P 500 (SPY) | +79.30% | +12.40% | −24.5% | 0.77 | +5.20% | -18.20% | +26.20% | +24.90% | +17.70% | +12.30% |
| Mid caps — S&P MidCap 400 (IJH) | +39.40% | +6.90% | −24.1% | 0.44 | +1.90% | -13.10% | +16.40% | +13.90% | +7.40% | +10.50% |
| Small caps — Russell 2000 (IWM) | +29.00% | +5.20% | −31.9% | 0.34 | -1.90% | -20.50% | +16.80% | +11.40% | +12.70% | +12.80% |
| Tech — Vanguard Information Technology (VGT) | +130.60% | +18.20% | −35.1% | 0.77 | +7.50% | -29.70% | +52.70% | +29.30% | +21.80% | +26.90% |
| Nasdaq-100 (QQQ) | +94.00% | +14.20% | −35.1% | 0.69 | +6.50% | -32.60% | +54.90% | +25.60% | +20.80% | +15.10% |

### USA bot sizing variants, same 5 years

| Variant | Total | Per year | Worst fall | Sharpe | Trades |
|---|---|---|---|---|---|
| Balanced (10% × 6 stocks), tested rules | +7.80% | +1.50% | −14.5% | 0.22 | 1541 |
| Aggressive (12% × 8 stocks), tested rules | +21.00% | +3.90% | −18.8% | 0.37 | 1946 |
| Aggressive + 10% take-profit | +20.90% | +3.90% | −19.1% | 0.37 | 1948 |
| Aggressive with your settings (buy below 25, +10% take-profit) | +17.00% | +3.20% | −20.6% | 0.31 | 2070 |
| All-in (16% × 6 = 96%), tested rules | +11.30% | +2.20% | −22.4% | 0.23 | 1541 |
| Stock part of a 60/30/10 split, your settings (12% of the stake per stock = 20% of the part, max 5) | +18.70% | +3.50% | −26.8% | 0.30 | 1389 |
| PUT stand-in: short stock on RSI-2 pops, run on its own money (25% each, max 4) | -72.30% | -22.70% | −73.2% | -1.31 | 927 |

## Five ideas to make the bot different (Aggressive sizing, your settings as the base)

| Idea | Per year, 33 yrs | Worst fall | **Per year since 2016-09-06** | Worst fall since | Trades | Win % | Last 5 yrs per year | $100k after 40.8% tax, 5 yrs |
|---|---|---|---|---|---|---|---|---|
| Your settings today (buy below 25, +10% take-profit, 25% stop) | +12.39% | −22.3% | **+4.86%** | −20.6% | 14289 | 64.7% | +2.80% | $108,022 |
| 1 · Quality dips only: the stock passes 6+ of the 8 trend-template points | +13.67% | −21.4% | **+6.09%** | −21.4% | 13169 | 65.3% | +3.50% | $110,805 |
| 2a · Only dips on days the whole market also fell | +10.77% | −18.0% | **+4.92%** | −15.7% | 10640 | 65.0% | +3.40% | $110,459 |
| 2b · Only dips on market panic days (S&P 500 down 1% or more) | +7.76% | −17.9% | **+4.10%** | −17.9% | 4360 | 68.1% | +4.30% | $113,570 |
| 3 · Leaders first: among the dips, buy those that beat the market most over 3 months | +13.68% | −20.6% | **+4.17%** | −20.6% | 14405 | 64.9% | +2.80% | $108,562 |
| 4 · Second engine: half the money on your dip rule, half on trend breakout | +12.51% | −25.1% | **+9.80%** | −17.1% | 15387 | 63.3% | +6.30% | $120,282 |
| 5 · Bigger buys when the market is nervous (1.5× when S&P 500 swings exceed their 1-year norm, 0.75× when calm) | +11.95% | −25.6% | **+3.35%** | −25.6% | 12537 | 64.4% | +0.80% | $95,304 |

Survivorship bias (today’s big companies, looking back) flatters every strategy, so treat these as an upper bound. Not financial advice.
