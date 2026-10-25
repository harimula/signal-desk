# Strategy research — India (NSE) — 99 stocks, 2007-09-17 → 2026-10-23

Costs 0.15%/side · 10% of equity per position · max 6 positions · out-of-sample = 2021-02-12 onward (never used to choose anything).

| Strategy | Regime filter | CAGR (all) | Sharpe (all) | Max DD | **OOS CAGR** | **OOS Sharpe** | OOS Max DD | Trades | Win % | Exp./trade | PF |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Current bot rules (intraday pullback, S3 → R1, stop S4) | off | -41.16% | -4.45 | −100.0% | **-51.09%** | **-6.78** | −98.3% | 40021 | 30.6% | -0.25% | 0.59 |
| Current bot rules (intraday pullback, S3 → R1, stop S4) | on | -39.11% | -4.42 | −100.0% | **-48.14%** | **-6.69** | −97.6% | 36262 | 30.4% | -0.26% | 0.58 |
| RSI-2 mean reversion (Connors): above 200-day, RSI-2 < 10, buy at next open, sell when close > 5-day avg (max 10 days) | off | -5.95% | -0.53 | −71.2% | **-10.63%** | **-1.20** | −48.6% | 6633 | 57.7% | -0.15% | 0.87 |
| RSI-2 mean reversion (Connors): above 200-day, RSI-2 < 10, buy at next open, sell when close > 5-day avg (max 10 days) | on | -5.66% | -0.55 | −71.5% | **-8.63%** | **-1.05** | −42.6% | 5984 | 57.8% | -0.17% | 0.86 |
| RSI-2 mean reversion + 3× range stop | off | -8.69% | -0.82 | −83.1% | **-11.55%** | **-1.34** | −50.8% | 7157 | 57.5% | -0.22% | 0.83 |
| RSI-2 mean reversion + 3× range stop | on | -7.99% | -0.82 | −80.8% | **-9.61%** | **-1.20** | −45.2% | 6436 | 57.3% | -0.23% | 0.82 |
| RSI-2 with quick exits (owner's choice): same entries; sell at +10% or −5% during the day, otherwise when close > 5-day avg (max 10 days) | off | -14.43% | -1.38 | −95.1% | **-11.56%** | **-1.39** | −50.8% | 8261 | 55.1% | -0.34% | 0.76 |
| RSI-2 with quick exits (owner's choice): same entries; sell at +10% or −5% during the day, otherwise when close > 5-day avg (max 10 days) | on | -12.94% | -1.31 | −93.3% | **-9.67%** | **-1.26** | −45.1% | 7359 | 55.0% | -0.34% | 0.76 |
| RSI-2 with only the +10% take-profit (25% disaster stop) | off | -4.49% | -0.39 | −62.5% | **-10.66%** | **-1.21** | −48.7% | 6670 | 57.8% | -0.11% | 0.91 |
| RSI-2 with only the +10% take-profit (25% disaster stop) | on | -4.27% | -0.40 | −63.6% | **-8.71%** | **-1.06** | −42.8% | 6021 | 57.8% | -0.12% | 0.90 |
| RSI-2 with only the −5% stop | off | -14.90% | -1.41 | −95.6% | **-11.64%** | **-1.40** | −51.0% | 8228 | 55.0% | -0.36% | 0.75 |
| RSI-2 with only the −5% stop | on | -13.46% | -1.34 | −94.0% | **-9.71%** | **-1.27** | −45.3% | 7326 | 54.9% | -0.36% | 0.75 |
| RSI-2 with the owner's settings: buy below 25, sell at +10% or on the bounce, 25% stop | off | -3.59% | -0.29 | −57.0% | **-9.26%** | **-1.03** | −44.3% | 6803 | 57.8% | -0.08% | 0.93 |
| RSI-2 with the owner's settings: buy below 25, sell at +10% or on the bounce, 25% stop | on | -3.44% | -0.30 | −59.0% | **-7.67%** | **-0.92** | −39.4% | 6120 | 57.7% | -0.09% | 0.92 |
| RSI-2 (buy below 10) with +10% take-profit, 25% stop | off | -4.49% | -0.39 | −62.5% | **-10.66%** | **-1.21** | −48.7% | 6670 | 57.8% | -0.11% | 0.91 |
| RSI-2 (buy below 10) with +10% take-profit, 25% stop | on | -4.27% | -0.40 | −63.6% | **-8.71%** | **-1.06** | −42.8% | 6021 | 57.8% | -0.12% | 0.90 |
| RSI-2 short (mirror of the bot): below 200-day, RSI-2 > 90, short at next open, cover when close < 5-day avg (max 10 days) | off | -8.57% | -0.76 | −86.3% | **-8.19%** | **-1.02** | −41.2% | 5323 | 58.9% | -0.29% | 0.82 |
| Trend breakout: close at a 50-day high above the 200-day, exit on a 20-day low | off | +13.25% | 1.02 | −39.6% | **+16.14%** | **1.15** | −16.5% | 471 | 41.4% | +6.22% | 2.32 |
| Trend breakout: close at a 50-day high above the 200-day, exit on a 20-day low | on | +13.34% | 1.03 | −37.9% | **+11.54%** | **0.89** | −25.6% | 449 | 42.1% | +6.66% | 2.41 |
| Nifty 50 buy & hold | – | +8.82% | 0.53 | −59.9% | **+7.26%** | **0.58** | −17.2% | – | – | – | – |

| Nifty Midcap 50 buy & hold (from 2007-09-24) | – | +15.67% | 0.46 | −75.1% | **+16.49%** | **0.94** | −22.6% | – | – | – | – |


## The last 5 years (2021-10-22 → 2026-10-23), from a fresh start

Benchmarks include dividends (index-fund NAVs, after the funds’ fees). The bot keeps at most 60% invested (6 positions × 10%).

| | Total | Per year | Worst fall | Sharpe | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|---|---|---|
| **India bot — trend breakout + RSI-2, 50/50** | +11.80% | +2.30% | −21.6% | 0.27 | -2.20% | -3.20% | +27.30% | +4.80% | -2.70% | -9.00% |
| Trend breakout | +70.50% | +11.30% | −16.5% | 0.92 | -1.30% | +12.00% | +41.00% | +15.70% | -0.60% | -5.00% |
| RSI-2 mean reversion | -47.20% | -12.00% | −47.6% | -1.38 | -3.10% | -18.90% | +7.90% | -15.40% | -8.20% | -20.00% |
| Large caps — Nifty 50 index fund | +31.30% | +5.60% | −15.7% | 0.47 | -4.20% | +5.80% | +21.10% | +9.70% | +11.70% | -12.80% |
| Next 50 — Nifty Next 50 index fund | +59.50% | +9.80% | −26.5% | 0.62 | -0.20% | +0.60% | +26.80% | +27.90% | +2.60% | -4.50% |
| Mid caps — Nifty Midcap 150 index fund | +82.00% | +12.70% | −21.0% | 0.81 | -0.20% | +3.60% | +44.30% | +24.20% | +5.80% | -7.20% |
| Small caps — Nifty Smallcap 250 index fund | +74.80% | +11.80% | −26.8% | 0.71 | +4.00% | -3.40% | +48.30% | +26.50% | -5.60% | -1.70% |

Survivorship bias (today’s big companies, looking back) flatters every strategy, so treat these as an upper bound. Not financial advice.
