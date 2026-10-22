# Day-trading research — 2016-01-01 → 2026-10-22

30 stocks + SPY, 3,582,575 five-minute bars, 477,754 raw signals. Entry at the close of the signal bar + slippage; stop assumed hit before target inside a bar; flat at the 15:45 bar close; 1 trade per stock per day, max per day and 2-loss streak applied in time order. Shorts are simulated as stock shorts (a proxy for PUTs: no option spread or time decay included). IEX volume is a slice of the market but consistent across the test.

**Verdict: marginal — positive but thin.**

| Settings | Trades | Win | Avg R | Per trade ($500 risk) | Profit factor | Worst drawdown (R) | Years positive |
|---|---|---|---|---|---|---|---|
| Bot defaults: OR 15 min · rel. vol ≥ 1.2× · target 2R · time stop 60 min · entries until 15:30 · market filter on | 4430 | 36% | -0.029 | $-14 | 0.93 | 173.94 | 2/7 |
| Best found: OR 15 min · rel. vol ≥ 1.2× · target 3R · time stop 90 min · entries until 11:30 · market filter on | 4337 | 33% | 0.006 | $3 | 1.01 | 92.62 | 4/7 |

## Variants of the best

| Variant | Trades | Win | Avg R | Per trade | Profit factor | Worst drawdown (R) | Years positive |
|---|---|---|---|---|---|---|---|
| ORB only | 4074 | 32% | -0.001 | $0 | 1 | 117.1 | 4/7 |
| VWAP pullback only | 3553 | 31% | -0.033 | $-16 | 0.93 | 142.85 | 2/7 |
| Longs only (shares / CALLs) | 3008 | 32% | -0.04 | $-20 | 0.92 | 194.72 | 1/7 |
| Shorts only (PUT proxy: stock short) | 2799 | 31% | 0.03 | $15 | 1.06 | 100.34 | 5/7 |
| Without the market filter | 4611 | 32% | -0.019 | $-9 | 0.96 | 180.33 | 3/7 |
| Morning only (entries until 11:30) | 4337 | 33% | 0.006 | $3 | 1.01 | 92.62 | 4/7 |

## Best settings, year by year

| Year | Trades | Win | Total R |
|---|---|---|---|
| 2020 | 300 | 34% | 13.11 |
| 2021 | 691 | 35% | 42.96 |
| 2022 | 719 | 34% | 64.5 |
| 2023 | 695 | 33% | 13.78 |
| 2024 | 684 | 31% | -19.98 |
| 2025 | 692 | 28% | -64.66 |
| 2026 | 556 | 34% | -22.78 |

## Top 12 parameter sets

| Settings | Trades | Win | Avg R | Per trade | Profit factor | Worst drawdown (R) | Years positive |
|---|---|---|---|---|---|---|---|
| OR 15 min · rel. vol ≥ 1.2× · target 3R · time stop 90 min · entries until 11:30 · market filter on | 4337 | 33% | 0.006 | $3 | 1.01 | 92.62 | 4/7 |
| OR 15 min · rel. vol ≥ 1× · target 3R · time stop 90 min · entries until 11:30 · market filter on | 4558 | 32% | 0.003 | $2 | 1.01 | 118.49 | 4/7 |
| OR 15 min · rel. vol ≥ 1.2× · target 3R · time stop 90 min · entries until 15:30 · market filter on | 4436 | 32% | 0.002 | $1 | 1 | 90.81 | 4/7 |
| OR 15 min · rel. vol ≥ 1× · target 3R · time stop 90 min · entries until 15:30 · market filter on | 4612 | 32% | -0.001 | $0 | 1 | 165.33 | 4/7 |
| OR 15 min · rel. vol ≥ 1.2× · target 3R · time stop 60 min · entries until 11:30 · market filter on | 4333 | 33% | -0.005 | $-3 | 0.99 | 107.05 | 4/7 |
| OR 15 min · rel. vol ≥ 1× · target 3R · time stop 60 min · entries until 11:30 · market filter on | 4553 | 33% | -0.005 | $-2 | 0.99 | 135.61 | 3/7 |
| OR 30 min · rel. vol ≥ 2× · target 3R · time stop 90 min · entries until 11:30 · market filter on | 2410 | 33% | -0.009 | $-4 | 0.98 | 68.6 | 3/7 |
| OR 15 min · rel. vol ≥ 1.2× · target 3R · time stop 60 min · entries until 15:30 · market filter on | 4430 | 33% | -0.009 | $-5 | 0.98 | 123.01 | 4/7 |
| OR 30 min · rel. vol ≥ 1× · target 3R · time stop 90 min · entries until 11:30 · market filter on | 4560 | 33% | -0.009 | $-4 | 0.98 | 196.48 | 4/7 |
| OR 15 min · rel. vol ≥ 1× · target 3R · time stop 60 min · entries until 15:30 · market filter on | 4605 | 33% | -0.01 | $-5 | 0.98 | 189.63 | 3/7 |
| OR 30 min · rel. vol ≥ 2× · target 3R · time stop 60 min · entries until 11:30 · market filter on | 2401 | 33% | -0.016 | $-8 | 0.96 | 81.94 | 4/7 |
| OR 30 min · rel. vol ≥ 1.2× · target 3R · time stop 90 min · entries until 11:30 · market filter on | 4316 | 33% | -0.012 | $-6 | 0.97 | 150.39 | 3/7 |
