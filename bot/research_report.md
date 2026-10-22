# Strategy research — 39 stocks, 1993-01-29 → 2026-10-22

Costs 0.05%/side · 10% of equity per position · max 6 positions · out-of-sample = 2016-09-02 onward (never used to choose anything).

| Strategy | Regime filter | CAGR (all) | Sharpe (all) | Max DD | **OOS CAGR** | **OOS Sharpe** | OOS Max DD | Trades | Win % | Exp./trade | PF |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Current bot rules (intraday pullback, S3 → R1, stop S4) | off | -3.74% | -0.76 | −72.6% | **-4.10%** | **-0.87** | −35.0% | 29993 | 33.9% | -0.04% | 0.90 |
| Current bot rules (intraday pullback, S3 → R1, stop S4) | on | -4.28% | -0.98 | −77.3% | **-4.71%** | **-1.05** | −39.1% | 27272 | 33.6% | -0.05% | 0.87 |
| RSI-2 mean reversion (Connors): above 200-day, RSI-2 < 10, buy at next open, sell when close > 5-day avg (max 10 days) | off | +28.27% | 2.13 | −14.3% | **+16.36%** | **1.44** | −11.9% | 14912 | 70.1% | +0.57% | 1.79 |
| RSI-2 mean reversion (Connors): above 200-day, RSI-2 < 10, buy at next open, sell when close > 5-day avg (max 10 days) | on | +25.29% | 2.08 | −11.9% | **+15.00%** | **1.39** | −11.9% | 13687 | 70.1% | +0.57% | 1.81 |
| RSI-2 mean reversion + 3× range stop | off | +21.85% | 1.64 | −18.2% | **+12.65%** | **1.13** | −12.7% | 16344 | 68.7% | +0.42% | 1.49 |
| RSI-2 mean reversion + 3× range stop | on | +19.82% | 1.60 | −18.2% | **+11.84%** | **1.10** | −12.2% | 14992 | 68.6% | +0.42% | 1.50 |
| RSI-2 short (mirror of the bot): below 200-day, RSI-2 > 90, short at next open, cover when close < 5-day avg (max 10 days) | off | +4.09% | 0.39 | −46.4% | **-1.78%** | **-0.12** | −25.9% | 9844 | 64.5% | +0.16% | 1.12 |
| Trend breakout: close at a 50-day high above the 200-day, exit on a 20-day low | off | +6.94% | 0.57 | −50.5% | **+6.39%** | **0.63** | −16.9% | 960 | 42.0% | +3.05% | 1.81 |
| Trend breakout: close at a 50-day high above the 200-day, exit on a 20-day low | on | +7.70% | 0.63 | −44.7% | **+7.13%** | **0.70** | −13.6% | 913 | 42.8% | +3.50% | 1.98 |
| SPY buy & hold | – | +8.83% | 0.55 | −56.5% | **+13.14%** | **0.78** | −34.1% | – | – | – | – |

Survivorship bias (today’s big companies, looking back) flatters every strategy, so treat these as an upper bound. Not financial advice.
