# Strategy research — 39 stocks, 1993-01-29 → 2026-10-23

Costs 0.05%/side · 10% of equity per position · max 6 positions · out-of-sample = 2016-09-06 onward (never used to choose anything).

| Strategy | Regime filter | CAGR (all) | Sharpe (all) | Max DD | **OOS CAGR** | **OOS Sharpe** | OOS Max DD | Trades | Win % | Exp./trade | PF |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Current bot rules (intraday pullback, S3 → R1, stop S4) | off | -3.74% | -0.76 | −72.6% | **-4.09%** | **-0.86** | −35.0% | 29994 | 34.0% | -0.04% | 0.90 |
| Current bot rules (intraday pullback, S3 → R1, stop S4) | on | -4.27% | -0.98 | −77.3% | **-4.70%** | **-1.04** | −39.1% | 27273 | 33.6% | -0.05% | 0.87 |
| RSI-2 mean reversion (Connors): above 200-day, RSI-2 < 10, buy at next open, sell when close > 5-day avg (max 10 days) | off | +28.29% | 2.13 | −14.3% | **+16.42%** | **1.45** | −11.9% | 14914 | 70.1% | +0.57% | 1.79 |
| RSI-2 mean reversion (Connors): above 200-day, RSI-2 < 10, buy at next open, sell when close > 5-day avg (max 10 days) | on | +25.31% | 2.08 | −11.9% | **+15.05%** | **1.39** | −11.9% | 13689 | 70.1% | +0.57% | 1.80 |
| RSI-2 mean reversion + 3× range stop | off | +21.86% | 1.64 | −18.2% | **+12.70%** | **1.13** | −12.7% | 16346 | 68.7% | +0.42% | 1.49 |
| RSI-2 mean reversion + 3× range stop | on | +19.84% | 1.60 | −18.2% | **+11.89%** | **1.11** | −12.2% | 14994 | 68.6% | +0.42% | 1.50 |
| RSI-2 with quick exits (owner's choice): same entries; sell at +10% or −5% during the day, otherwise when close > 5-day avg (max 10 days) | off | +16.38% | 1.28 | −18.5% | **+9.85%** | **0.93** | −16.8% | 17468 | 66.6% | +0.30% | 1.31 |
| RSI-2 with quick exits (owner's choice): same entries; sell at +10% or −5% during the day, otherwise when close > 5-day avg (max 10 days) | on | +15.11% | 1.27 | −16.8% | **+9.20%** | **0.90** | −16.8% | 15892 | 66.8% | +0.31% | 1.33 |
| RSI-2 with only the +10% take-profit (25% disaster stop) | off | +28.37% | 2.14 | −13.3% | **+16.95%** | **1.50** | −10.4% | 14930 | 70.1% | +0.58% | 1.79 |
| RSI-2 with only the +10% take-profit (25% disaster stop) | on | +25.28% | 2.08 | −10.9% | **+15.50%** | **1.43** | −10.4% | 13704 | 70.1% | +0.56% | 1.80 |
| RSI-2 with only the −5% stop | off | +16.49% | 1.28 | −18.5% | **+9.80%** | **0.92** | −16.2% | 17449 | 66.6% | +0.31% | 1.31 |
| RSI-2 with only the −5% stop | on | +15.20% | 1.27 | −16.4% | **+9.15%** | **0.90** | −16.2% | 15875 | 66.8% | +0.31% | 1.33 |
| RSI-2 with the owner's settings: buy below 25, sell at +10% or on the bounce, 25% stop | off | +31.44% | 2.27 | −13.4% | **+18.99%** | **1.62** | −12.4% | 16060 | 70.5% | +0.59% | 1.81 |
| RSI-2 with the owner's settings: buy below 25, sell at +10% or on the bounce, 25% stop | on | +27.94% | 2.20 | −12.4% | **+16.75%** | **1.50** | −12.4% | 14704 | 70.5% | +0.58% | 1.83 |
| RSI-2 (buy below 10) with +10% take-profit, 25% stop | off | +28.37% | 2.14 | −13.3% | **+16.95%** | **1.50** | −10.4% | 14930 | 70.1% | +0.58% | 1.79 |
| RSI-2 (buy below 10) with +10% take-profit, 25% stop | on | +25.28% | 2.08 | −10.9% | **+15.50%** | **1.43** | −10.4% | 13704 | 70.1% | +0.56% | 1.80 |
| RSI-2 short (mirror of the bot): below 200-day, RSI-2 > 90, short at next open, cover when close < 5-day avg (max 10 days) | off | +4.11% | 0.40 | −46.4% | **-1.68%** | **-0.11** | −25.9% | 9845 | 64.5% | +0.16% | 1.12 |
| Trend breakout: close at a 50-day high above the 200-day, exit on a 20-day low | off | +6.96% | 0.57 | −50.5% | **+6.51%** | **0.64** | −16.9% | 960 | 42.0% | +3.05% | 1.81 |
| Trend breakout: close at a 50-day high above the 200-day, exit on a 20-day low | on | +7.73% | 0.64 | −44.7% | **+7.25%** | **0.71** | −13.6% | 913 | 42.8% | +3.50% | 1.98 |
| SPY buy & hold | – | +8.82% | 0.55 | −56.5% | **+13.07%** | **0.78** | −34.1% | – | – | – | – |

| Russell 2000 (small caps) buy & hold | – | +7.69% | 0.44 | −59.9% | **+8.17%** | **0.45** | −43.1% | – | – | – | – |


## The last 5 years (2021-10-22 → 2026-10-23), from a fresh start

Benchmarks include dividends (ETF adjusted closes). The bot keeps at most 60% invested (6 positions × 10%).

| | Total | Per year | Worst fall | Sharpe | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|---|---|---|
| **USA bot — RSI-2 dip buying** | +95.70% | +14.40% | −11.9% | 1.31 | +5.00% | +10.40% | +15.10% | +19.40% | +9.10% | +12.70% |
| Large caps — S&P 500 (SPY) | +79.30% | +12.40% | −24.5% | 0.77 | +5.20% | -18.20% | +26.20% | +24.90% | +17.70% | +12.30% |
| Mid caps — S&P MidCap 400 (IJH) | +39.40% | +6.90% | −24.1% | 0.44 | +1.90% | -13.10% | +16.40% | +13.90% | +7.40% | +10.50% |
| Small caps — Russell 2000 (IWM) | +29.00% | +5.20% | −31.9% | 0.34 | -1.90% | -20.50% | +16.80% | +11.40% | +12.70% | +12.80% |
| Tech — Vanguard Information Technology (VGT) | +130.60% | +18.20% | −35.1% | 0.77 | +7.50% | -29.70% | +52.70% | +29.30% | +21.80% | +26.90% |
| Nasdaq-100 (QQQ) | +94.00% | +14.20% | −35.1% | 0.69 | +6.50% | -32.60% | +54.90% | +25.60% | +20.80% | +15.10% |

### USA bot sizing variants, same 5 years

| Variant | Total | Per year | Worst fall | Sharpe | Trades |
|---|---|---|---|---|---|
| Balanced (10% × 6 stocks), tested rules | +95.70% | +14.40% | −11.9% | 1.31 | 2123 |
| Aggressive (12% × 8 stocks), tested rules | +178.80% | +22.80% | −16.0% | 1.38 | 2606 |
| Aggressive + 10% take-profit | +182.00% | +23.10% | −15.5% | 1.41 | 2608 |
| Aggressive with your settings (buy below 25, +10% take-profit) | +238.80% | +27.70% | −15.4% | 1.57 | 2880 |
| All-in (16% × 6 = 96%), tested rules | +188.30% | +23.60% | −18.6% | 1.32 | 2123 |
| Stock part of a 60/30/10 split, your settings (12% of the stake per stock = 20% of the part, max 5) | +232.20% | +27.20% | −26.2% | 1.33 | 1958 |
| PUT stand-in: short stock on RSI-2 pops, run on its own money (25% each, max 4) | -24.20% | -5.40% | −45.9% | -0.14 | 1234 |

## Five ideas to make the bot different (Aggressive sizing, your settings as the base)

| Idea | Per year, 33 yrs | Worst fall | **Per year since 2016-09-06** | Worst fall since | Trades | Win % | Last 5 yrs per year | $100k after 40.8% tax, 5 yrs |
|---|---|---|---|---|---|---|---|---|
| Your settings today (buy below 25, +10% take-profit, 25% stop) | +51.72% | −18.7% | **+30.06%** | −17.9% | 20121 | 70.4% | +27.50% | $212,341 |
| 1 · Quality dips only: the stock passes 6+ of the 8 trend-template points | +47.31% | −17.3% | **+27.27%** | −17.3% | 18119 | 70.5% | +23.60% | $192,572 |
| 2a · Only dips on days the whole market also fell | +25.83% | −17.9% | **+13.55%** | −14.1% | 13355 | 68.3% | +12.70% | $144,039 |
| 2b · Only dips on market panic days (S&P 500 down 1% or more) | +10.59% | −14.8% | **+6.16%** | −14.3% | 4758 | 69.1% | +6.90% | $122,552 |
| 3 · Leaders first: among the dips, buy those that beat the market most over 3 months | +56.97% | −19.6% | **+33.01%** | −16.8% | 20377 | 70.5% | +31.60% | $236,054 |
| 4 · Second engine: half the money on your dip rule, half on trend breakout | +48.66% | −18.7% | **+30.06%** | −17.9% | 21280 | 68.9% | +27.50% | $212,341 |
| 5 · Bigger buys when the market is nervous (1.5× when S&P 500 swings exceed their 1-year norm, 0.75× when calm) | +45.06% | −20.7% | **+27.15%** | −20.7% | 17754 | 69.9% | +25.20% | $200,149 |

Survivorship bias (today’s big companies, looking back) flatters every strategy, so treat these as an upper bound. Not financial advice.
