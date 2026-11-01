# Day-trading research — 2016-01-01 → 2026-11-01

30 stocks + SPY, 3,596,600 five-minute bars, 479,467 raw signals. Entry at the close of the signal bar + slippage; stop assumed hit before target inside a bar; flat at the 15:45 bar close; 1 trade per stock per day, max per day and 2-loss streak applied in time order. Shorts are simulated as stock shorts (a proxy for PUTs: no option spread or time decay included). IEX volume is a slice of the market but consistent across the test.

**Verdict: no edge found.**

| Settings | Trades | Win | Avg R | Per trade ($500 risk) | Profit factor | Worst drawdown (R) | Years positive |
|---|---|---|---|---|---|---|---|
| Bot defaults: OR 15 min · rel. vol ≥ 1.2× · target 2R · time stop 60 min · entries until 15:30 · market filter on | 4448 | 36% | -0.028 | $-14 | 0.94 | 167.06 | 2/7 |
| Best found: OR 15 min · rel. vol ≥ 1.2× · target 3R · time stop 90 min · entries until 11:30 · market filter on | 4355 | 33% | 0.006 | $3 | 1.01 | 148.84 | 4/7 |

## Variants of the best

| Variant | Trades | Win | Avg R | Per trade | Profit factor | Worst drawdown (R) | Years positive |
|---|---|---|---|---|---|---|---|
| ORB only | 4091 | 32% | -0.001 | $0 | 1 | 105.47 | 4/7 |
| VWAP pullback only | 3566 | 31% | -0.032 | $-16 | 0.93 | 167.37 | 2/7 |
| Longs only (shares / CALLs) | 3022 | 32% | -0.039 | $-19 | 0.92 | 141.21 | 1/7 |
| Shorts only (PUT proxy: stock short) | 2810 | 31% | 0.03 | $15 | 1.06 | 80.26 | 5/7 |
| Without the market filter | 4629 | 32% | -0.019 | $-9 | 0.96 | 135.24 | 3/7 |
| Morning only (entries until 11:30) | 4355 | 33% | 0.006 | $3 | 1.01 | 148.84 | 4/7 |

## Best settings, year by year

| Year | Trades | Win | Total R |
|---|---|---|---|
| 2020 | 300 | 34% | 13.11 |
| 2021 | 691 | 35% | 42.96 |
| 2022 | 719 | 34% | 64.5 |
| 2023 | 695 | 33% | 13.78 |
| 2024 | 684 | 31% | -19.98 |
| 2025 | 692 | 28% | -64.66 |
| 2026 | 574 | 35% | -22.44 |

## Top 12 parameter sets

| Settings | Trades | Win | Avg R | Per trade | Profit factor | Worst drawdown (R) | Years positive |
|---|---|---|---|---|---|---|---|
| OR 15 min · rel. vol ≥ 1.2× · target 3R · time stop 90 min · entries until 11:30 · market filter on | 4355 | 33% | 0.006 | $3 | 1.01 | 148.84 | 4/7 |
| OR 15 min · rel. vol ≥ 1× · target 3R · time stop 90 min · entries until 11:30 · market filter on | 4576 | 32% | 0.002 | $1 | 1 | 133.57 | 4/7 |
| OR 15 min · rel. vol ≥ 1.2× · target 3R · time stop 90 min · entries until 15:30 · market filter on | 4454 | 32% | 0.002 | $1 | 1 | 157.57 | 4/7 |
| OR 15 min · rel. vol ≥ 1× · target 3R · time stop 90 min · entries until 15:30 · market filter on | 4630 | 32% | -0.003 | $-1 | 0.99 | 151.78 | 4/7 |
| OR 15 min · rel. vol ≥ 1.2× · target 3R · time stop 60 min · entries until 11:30 · market filter on | 4351 | 33% | -0.005 | $-2 | 0.99 | 159.36 | 4/7 |
| OR 30 min · rel. vol ≥ 2× · target 3R · time stop 90 min · entries until 11:30 · market filter on | 2420 | 33% | -0.008 | $-4 | 0.98 | 88.03 | 3/7 |
| OR 15 min · rel. vol ≥ 1× · target 3R · time stop 60 min · entries until 11:30 · market filter on | 4571 | 33% | -0.006 | $-3 | 0.99 | 135.86 | 3/7 |
| OR 15 min · rel. vol ≥ 1.2× · target 3R · time stop 60 min · entries until 15:30 · market filter on | 4448 | 33% | -0.009 | $-5 | 0.98 | 168.72 | 4/7 |
| OR 30 min · rel. vol ≥ 1× · target 3R · time stop 90 min · entries until 11:30 · market filter on | 4578 | 33% | -0.009 | $-5 | 0.98 | 142.44 | 4/7 |
| OR 15 min · rel. vol ≥ 1× · target 3R · time stop 60 min · entries until 15:30 · market filter on | 4623 | 33% | -0.011 | $-6 | 0.97 | 154.96 | 3/7 |
| OR 30 min · rel. vol ≥ 1.2× · target 3R · time stop 90 min · entries until 11:30 · market filter on | 4333 | 33% | -0.012 | $-6 | 0.97 | 183.96 | 3/7 |
| OR 30 min · rel. vol ≥ 2× · target 3R · time stop 60 min · entries until 11:30 · market filter on | 2411 | 33% | -0.017 | $-8 | 0.96 | 91.52 | 4/7 |
