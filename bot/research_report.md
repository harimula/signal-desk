# Strategy research — 39 stocks, 1993-01-29 → 2026-10-22

Costs 0.05%/side · 10% of equity per position · max 6 positions · out-of-sample = 2016-09-02 onward (never used to choose anything).

| Strategy | Regime filter | CAGR (all) | Sharpe (all) | Max DD | **OOS CAGR** | **OOS Sharpe** | OOS Max DD | Trades | Win % | Exp./trade | PF |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Current bot rules (intraday pullback, S3 → R1, stop S4) | off | -3.74% | -0.76 | −72.6% | **-4.10%** | **-0.87** | −35.0% | 29993 | 33.9% | -0.04% | 0.90 |
| Current bot rules (intraday pullback, S3 → R1, stop S4) | on | -4.28% | -0.98 | −77.3% | **-4.71%** | **-1.05** | −39.1% | 27272 | 33.6% | -0.05% | 0.87 |
| RSI-2 mean reversion (Connors): above 200-day, RSI-2 < 10, buy at next open, sell when close > 5-day avg (max 10 days) | off | +28.28% | 2.13 | −14.3% | **+16.40%** | **1.45** | −11.9% | 14912 | 70.1% | +0.57% | 1.79 |
| RSI-2 mean reversion (Connors): above 200-day, RSI-2 < 10, buy at next open, sell when close > 5-day avg (max 10 days) | on | +25.30% | 2.08 | −11.9% | **+15.03%** | **1.39** | −11.9% | 13687 | 70.1% | +0.57% | 1.81 |
| RSI-2 mean reversion + 3× range stop | off | +21.86% | 1.64 | −18.2% | **+12.68%** | **1.13** | −12.7% | 16344 | 68.7% | +0.42% | 1.49 |
| RSI-2 mean reversion + 3× range stop | on | +19.83% | 1.60 | −18.2% | **+11.87%** | **1.11** | −12.2% | 14992 | 68.6% | +0.42% | 1.50 |
| RSI-2 with quick exits (owner's choice): same entries; sell at +10% or −5% during the day, otherwise when close > 5-day avg (max 10 days) | off | +16.37% | 1.28 | −18.5% | **+9.85%** | **0.93** | −16.8% | 17467 | 66.6% | +0.30% | 1.31 |
| RSI-2 with quick exits (owner's choice): same entries; sell at +10% or −5% during the day, otherwise when close > 5-day avg (max 10 days) | on | +15.10% | 1.27 | −16.8% | **+9.20%** | **0.90** | −16.8% | 15891 | 66.8% | +0.31% | 1.33 |
| RSI-2 with only the +10% take-profit (25% disaster stop) | off | +28.36% | 2.14 | −13.3% | **+16.93%** | **1.49** | −10.4% | 14928 | 70.1% | +0.58% | 1.79 |
| RSI-2 with only the +10% take-profit (25% disaster stop) | on | +25.27% | 2.08 | −10.9% | **+15.48%** | **1.43** | −10.4% | 13702 | 70.1% | +0.57% | 1.80 |
| RSI-2 with only the −5% stop | off | +16.48% | 1.28 | −18.5% | **+9.80%** | **0.92** | −16.2% | 17448 | 66.6% | +0.31% | 1.31 |
| RSI-2 with only the −5% stop | on | +15.20% | 1.27 | −16.4% | **+9.15%** | **0.90** | −16.2% | 15874 | 66.8% | +0.31% | 1.33 |
| RSI-2 with the owner's settings: buy below 25, sell at +10% or on the bounce, 25% stop | off | +31.43% | 2.27 | −13.4% | **+18.95%** | **1.62** | −12.4% | 16058 | 70.5% | +0.59% | 1.82 |
| RSI-2 with the owner's settings: buy below 25, sell at +10% or on the bounce, 25% stop | on | +27.93% | 2.20 | −12.4% | **+16.72%** | **1.50** | −12.4% | 14702 | 70.5% | +0.58% | 1.83 |
| RSI-2 (buy below 10) with +10% take-profit, 25% stop | off | +28.36% | 2.14 | −13.3% | **+16.93%** | **1.49** | −10.4% | 14928 | 70.1% | +0.58% | 1.79 |
| RSI-2 (buy below 10) with +10% take-profit, 25% stop | on | +25.27% | 2.08 | −10.9% | **+15.48%** | **1.43** | −10.4% | 13702 | 70.1% | +0.57% | 1.80 |
| RSI-2 short (mirror of the bot): below 200-day, RSI-2 > 90, short at next open, cover when close < 5-day avg (max 10 days) | off | +4.08% | 0.39 | −46.4% | **-1.81%** | **-0.12** | −25.9% | 9844 | 64.5% | +0.16% | 1.12 |
| Trend breakout: close at a 50-day high above the 200-day, exit on a 20-day low | off | +6.94% | 0.57 | −50.5% | **+6.41%** | **0.63** | −16.9% | 960 | 42.0% | +3.05% | 1.81 |
| Trend breakout: close at a 50-day high above the 200-day, exit on a 20-day low | on | +7.71% | 0.63 | −44.7% | **+7.15%** | **0.70** | −13.6% | 913 | 42.8% | +3.50% | 1.98 |
| SPY buy & hold | – | +8.84% | 0.55 | −56.5% | **+13.15%** | **0.78** | −34.1% | – | – | – | – |

| Russell 2000 (small caps) buy & hold | – | +7.69% | 0.44 | −59.9% | **+8.17%** | **0.46** | −43.1% | – | – | – | – |


## The last 5 years (2021-10-21 → 2026-10-22), from a fresh start

Benchmarks include dividends (ETF adjusted closes). The bot keeps at most 60% invested (6 positions × 10%).

| | Total | Per year | Worst fall | Sharpe | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|---|---|---|
| **USA bot — RSI-2 dip buying** | +94.70% | +14.30% | −11.9% | 1.30 | +4.70% | +10.40% | +15.10% | +19.40% | +9.10% | +12.40% |
| Large caps — S&P 500 (SPY) | +80.10% | +12.50% | −24.5% | 0.77 | +5.10% | -18.20% | +26.20% | +24.90% | +17.70% | +12.90% |
| Mid caps — S&P MidCap 400 (IJH) | +40.50% | +7.00% | −24.1% | 0.45 | +2.10% | -13.10% | +16.40% | +13.90% | +7.40% | +11.20% |
| Small caps — Russell 2000 (IWM) | +29.10% | +5.20% | −31.9% | 0.34 | -2.10% | -20.50% | +16.80% | +11.40% | +12.70% | +13.20% |
| Tech — Vanguard Information Technology (VGT) | +128.50% | +18.00% | −35.1% | 0.77 | +7.10% | -29.70% | +52.70% | +29.30% | +21.80% | +26.30% |
| Nasdaq-100 (QQQ) | +92.40% | +14.00% | −35.1% | 0.69 | +5.60% | -32.60% | +54.90% | +25.60% | +20.80% | +15.10% |

### USA bot sizing variants, same 5 years

| Variant | Total | Per year | Worst fall | Sharpe | Trades |
|---|---|---|---|---|---|
| Balanced (10% × 6 stocks), tested rules | +94.70% | +14.30% | −11.9% | 1.30 | 2123 |
| Aggressive (12% × 8 stocks), tested rules | +177.10% | +22.60% | −16.0% | 1.38 | 2606 |
| Aggressive + 10% take-profit | +180.40% | +22.90% | −15.5% | 1.40 | 2608 |
| Aggressive with your settings (buy below 25, +10% take-profit) | +237.60% | +27.60% | −15.4% | 1.57 | 2882 |
| All-in (16% × 6 = 96%), tested rules | +186.00% | +23.40% | −18.6% | 1.31 | 2123 |

Survivorship bias (today’s big companies, looking back) flatters every strategy, so treat these as an upper bound. Not financial advice.
