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

Survivorship bias (today’s big companies, looking back) flatters every strategy, so treat these as an upper bound. Not financial advice.
