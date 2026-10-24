# Strategy research — India (NSE) — 99 stocks, 2007-09-17 → 2026-10-23

Costs 0.15%/side · 10% of equity per position · max 6 positions · out-of-sample = 2021-02-12 onward (never used to choose anything).

| Strategy | Regime filter | CAGR (all) | Sharpe (all) | Max DD | **OOS CAGR** | **OOS Sharpe** | OOS Max DD | Trades | Win % | Exp./trade | PF |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Current bot rules (intraday pullback, S3 → R1, stop S4) | off | -27.39% | -2.66 | −99.9% | **-42.20%** | **-5.28** | −95.6% | 40021 | 33.0% | -0.15% | 0.75 |
| Current bot rules (intraday pullback, S3 → R1, stop S4) | on | -26.40% | -2.71 | −99.8% | **-39.82%** | **-5.29** | −94.5% | 36262 | 32.8% | -0.16% | 0.74 |
| RSI-2 mean reversion (Connors): above 200-day, RSI-2 < 10, buy at next open, sell when close > 5-day avg (max 10 days) | off | +13.69% | 1.05 | −22.1% | **+3.75%** | **0.38** | −22.1% | 9483 | 63.6% | +0.28% | 1.28 |
| RSI-2 mean reversion (Connors): above 200-day, RSI-2 < 10, buy at next open, sell when close > 5-day avg (max 10 days) | on | +11.41% | 0.95 | −23.4% | **+4.72%** | **0.49** | −19.2% | 8527 | 63.4% | +0.26% | 1.26 |
| RSI-2 mean reversion + 3× range stop | off | +5.58% | 0.46 | −39.0% | **-0.31%** | **0.03** | −32.1% | 10228 | 62.4% | +0.12% | 1.10 |
| RSI-2 mean reversion + 3× range stop | on | +4.61% | 0.41 | −33.4% | **+1.15%** | **0.16** | −29.5% | 9165 | 62.3% | +0.11% | 1.10 |
| RSI-2 with quick exits (owner's choice): same entries; sell at +10% or −5% during the day, otherwise when close > 5-day avg (max 10 days) | off | -8.78% | -0.50 | −84.3% | **-4.34%** | **-0.32** | −31.9% | 12093 | 58.4% | -0.13% | 0.91 |
| RSI-2 with quick exits (owner's choice): same entries; sell at +10% or −5% during the day, otherwise when close > 5-day avg (max 10 days) | on | -7.47% | -0.45 | −80.2% | **-2.24%** | **-0.15** | −30.0% | 10763 | 58.4% | -0.12% | 0.91 |
| RSI-2 with only the +10% take-profit (25% disaster stop) | off | +15.54% | 1.16 | −21.7% | **+3.58%** | **0.37** | −21.7% | 9540 | 63.7% | +0.31% | 1.30 |
| RSI-2 with only the +10% take-profit (25% disaster stop) | on | +13.14% | 1.07 | −20.1% | **+4.48%** | **0.47** | −19.0% | 8580 | 63.5% | +0.29% | 1.29 |
| RSI-2 with only the −5% stop | off | -10.18% | -0.59 | −88.0% | **-4.67%** | **-0.35** | −32.6% | 12036 | 58.4% | -0.15% | 0.89 |
| RSI-2 with only the −5% stop | on | -8.89% | -0.55 | −84.9% | **-2.52%** | **-0.18** | −30.6% | 10713 | 58.4% | -0.15% | 0.89 |
| RSI-2 with the owner's settings: buy below 25, sell at +10% or on the bounce, 25% stop | off | +17.51% | 1.27 | −19.5% | **+5.85%** | **0.56** | −19.5% | 9833 | 64.0% | +0.33% | 1.33 |
| RSI-2 with the owner's settings: buy below 25, sell at +10% or on the bounce, 25% stop | on | +14.21% | 1.14 | −18.3% | **+5.86%** | **0.59** | −18.3% | 8783 | 63.6% | +0.31% | 1.31 |
| RSI-2 (buy below 10) with +10% take-profit, 25% stop | off | +15.54% | 1.16 | −21.7% | **+3.58%** | **0.37** | −21.7% | 9540 | 63.7% | +0.31% | 1.30 |
| RSI-2 (buy below 10) with +10% take-profit, 25% stop | on | +13.14% | 1.07 | −20.1% | **+4.48%** | **0.47** | −19.0% | 8580 | 63.5% | +0.29% | 1.29 |
| RSI-2 short (mirror of the bot): below 200-day, RSI-2 > 90, short at next open, cover when close < 5-day avg (max 10 days) | off | +2.52% | 0.25 | −44.5% | **-1.70%** | **-0.11** | −26.5% | 7228 | 63.6% | +0.09% | 1.07 |
| Trend breakout: close at a 50-day high above the 200-day, exit on a 20-day low | off | +11.19% | 0.86 | −41.6% | **+12.29%** | **0.92** | −16.6% | 488 | 39.5% | +5.02% | 2.05 |
| Trend breakout: close at a 50-day high above the 200-day, exit on a 20-day low | on | +11.70% | 0.90 | −37.1% | **+10.89%** | **0.85** | −24.4% | 456 | 41.0% | +5.91% | 2.19 |
| Nifty 50 buy & hold | – | +8.82% | 0.53 | −59.9% | **+7.26%** | **0.58** | −17.2% | – | – | – | – |

| Nifty Midcap 50 buy & hold (from 2007-09-24) | – | +15.67% | 0.46 | −75.1% | **+16.49%** | **0.94** | −22.6% | – | – | – | – |


## The last 5 years (2021-10-22 → 2026-10-23), from a fresh start

Benchmarks include dividends (index-fund NAVs, after the funds’ fees). The bot keeps at most 60% invested (6 positions × 10%).

| | Total | Per year | Worst fall | Sharpe | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|---|---|---|
| **India bot — trend breakout + RSI-2, 50/50** | +28.10% | +5.10% | −18.9% | 0.52 | -0.40% | +8.10% | +22.30% | +11.70% | +0.30% | -13.20% |
| Trend breakout | +50.80% | +8.60% | −16.6% | 0.73 | +1.00% | +20.20% | +17.90% | +17.30% | -1.60% | -8.60% |
| RSI-2 mean reversion | +5.30% | +1.00% | −22.1% | 0.15 | -1.70% | -4.40% | +28.10% | +5.00% | +2.80% | -19.00% |
| Large caps — Nifty 50 index fund | +31.30% | +5.60% | −15.7% | 0.47 | -4.20% | +5.80% | +21.10% | +9.70% | +11.70% | -12.80% |
| Next 50 — Nifty Next 50 index fund | +59.50% | +9.80% | −26.5% | 0.62 | -0.20% | +0.60% | +26.80% | +27.90% | +2.60% | -4.50% |
| Mid caps — Nifty Midcap 150 index fund | +82.00% | +12.70% | −21.0% | 0.81 | -0.20% | +3.60% | +44.30% | +24.20% | +5.80% | -7.20% |
| Small caps — Nifty Smallcap 250 index fund | +74.80% | +11.80% | −26.8% | 0.71 | +4.00% | -3.40% | +48.30% | +26.50% | -5.60% | -1.70% |

Survivorship bias (today’s big companies, looking back) flatters every strategy, so treat these as an upper bound. Not financial advice.
