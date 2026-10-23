# Strategy research — India (NSE) — 99 stocks, 2007-09-17 → 2026-10-22

Costs 0.15%/side · 10% of equity per position · max 6 positions · out-of-sample = 2021-02-11 onward (never used to choose anything).

| Strategy | Regime filter | CAGR (all) | Sharpe (all) | Max DD | **OOS CAGR** | **OOS Sharpe** | OOS Max DD | Trades | Win % | Exp./trade | PF |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Current bot rules (intraday pullback, S3 → R1, stop S4) | off | -27.37% | -2.66 | −99.9% | **-42.20%** | **-5.28** | −95.6% | 40013 | 33.0% | -0.15% | 0.75 |
| Current bot rules (intraday pullback, S3 → R1, stop S4) | on | -26.40% | -2.71 | −99.8% | **-39.90%** | **-5.30** | −94.5% | 36262 | 32.8% | -0.16% | 0.74 |
| RSI-2 mean reversion (Connors): above 200-day, RSI-2 < 10, buy at next open, sell when close > 5-day avg (max 10 days) | off | +13.78% | 1.05 | −21.9% | **+4.01%** | **0.41** | −21.5% | 9483 | 63.6% | +0.28% | 1.28 |
| RSI-2 mean reversion (Connors): above 200-day, RSI-2 < 10, buy at next open, sell when close > 5-day avg (max 10 days) | on | +11.41% | 0.95 | −23.4% | **+4.72%** | **0.49** | −19.2% | 8527 | 63.4% | +0.26% | 1.26 |
| RSI-2 mean reversion + 3× range stop | off | +5.66% | 0.46 | −39.0% | **-0.05%** | **0.05** | −32.1% | 10227 | 62.4% | +0.12% | 1.10 |
| RSI-2 mean reversion + 3× range stop | on | +4.61% | 0.41 | −33.4% | **+1.14%** | **0.16** | −29.5% | 9165 | 62.3% | +0.11% | 1.10 |
| RSI-2 short (mirror of the bot): below 200-day, RSI-2 > 90, short at next open, cover when close < 5-day avg (max 10 days) | off | +2.52% | 0.25 | −44.5% | **-1.70%** | **-0.11** | −26.5% | 7226 | 63.6% | +0.10% | 1.07 |
| Trend breakout: close at a 50-day high above the 200-day, exit on a 20-day low | off | +11.25% | 0.87 | −41.6% | **+12.72%** | **0.95** | −16.1% | 488 | 39.5% | +5.02% | 2.05 |
| Trend breakout: close at a 50-day high above the 200-day, exit on a 20-day low | on | +11.70% | 0.91 | −37.1% | **+11.15%** | **0.86** | −24.4% | 456 | 41.0% | +5.91% | 2.19 |
| Nifty 50 buy & hold | – | +8.85% | 0.53 | −59.9% | **+7.32%** | **0.59** | −17.2% | – | – | – | – |

| Nifty Midcap 50 buy & hold (from 2007-09-24) | – | +15.80% | 0.46 | −75.1% | **+16.87%** | **0.96** | −22.6% | – | – | – | – |

Survivorship bias (today’s big companies, looking back) flatters every strategy, so treat these as an upper bound. Not financial advice.
