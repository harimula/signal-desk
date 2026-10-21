# Backtest — Signal Desk bot rules

Generated 2026-10-21 · 39 stocks · 40 years requested · costs 0.05% per side · 10% of equity per position, max 6 a day

## Headline numbers

| Strategy | Period | CAGR | Sharpe | Sortino | Max drawdown | Total |
|---|---|---|---|---|---|---|
| Bot rules (regime filter ON) | 1993-01-29 → 2026-10-21 | -2.94% | -0.90 | -1.29 | −64.1% | -63.41% |
| Same rules, filter OFF | 1993-01-29 → 2026-10-21 | -2.53% | -0.69 | -1.02 | −58.6% | -57.82% |
| SPY buy & hold | 1993-02-01 → 2026-10-21 | +8.88% | 0.55 | 0.78 | −56.5% | +1659.52% |

## Is it real or curve-fit? In-sample vs out-of-sample

| Strategy | Period | CAGR | Sharpe | Sortino | Max drawdown | Total |
|---|---|---|---|---|---|---|
| In-sample (first 70%) | 1993-01-29 → 2016-09-01 | -2.83% | -0.82 | -1.21 | −50.0% | -49.24% |
| Out-of-sample (last 30%) | 2016-09-02 → 2026-10-21 | -3.18% | -1.11 | -1.53 | −28.5% | -27.91% |
| SPY, out-of-sample period | 2016-09-02 → 2026-10-21 | +13.34% | 0.79 | 1.11 | −34.1% | +255.62% |

If the out-of-sample Sharpe is far below in-sample, the edge is fading or was luck.

## Per-trade statistics (filter ON)

| | All years | Out-of-sample |
|---|---|---|
| Trades | 22548 | 6847 |
| Win rate | 34.1% | 35.4% |
| Average win | +1.05% | +0.90% |
| Average loss | -0.61% | -0.56% |
| Expectancy per trade | -0.04% | -0.05% |
| Profit factor | 0.89 | 0.87 |

## Year by year (filter ON)

| Year | Return |
|---|---|
| 1993 | -9.15% |
| 1994 | -3.70% |
| 1995 | -9.98% |
| 1996 | -3.22% |
| 1997 | -2.07% |
| 1998 | +1.62% |
| 1999 | -3.16% |
| 2000 | -6.99% |
| 2001 | -0.29% |
| 2002 | -4.56% |
| 2003 | +1.55% |
| 2004 | -4.36% |
| 2005 | -4.92% |
| 2006 | -0.29% |
| 2007 | -4.60% |
| 2008 | -1.09% |
| 2009 | +5.47% |
| 2010 | -3.03% |
| 2011 | -2.72% |
| 2012 | -1.72% |
| 2013 | +0.55% |
| 2014 | -3.30% |
| 2015 | -4.51% |
| 2016 | -2.71% |
| 2017 | -3.84% |
| 2018 | -0.60% |
| 2019 | +2.41% |
| 2020 | -1.72% |
| 2021 | -5.64% |
| 2022 | -0.66% |
| 2023 | -1.53% |
| 2024 | -5.83% |
| 2025 | -6.10% |
| 2026 | -6.60% |

## Per stock

| Stock | Trades | Win rate | Expectancy | Profit factor |
|---|---|---|---|---|
| AMD | 926 | 35% | +0.06% | 1.08 |
| QCOM | 796 | 37% | +0.04% | 1.09 |
| COST | 954 | 36% | +0.04% | 1.11 |
| ORCL | 931 | 37% | +0.01% | 1.01 |
| INTC | 961 | 35% | -0.00% | 0.99 |
| JNJ | 847 | 35% | -0.01% | 0.96 |
| GS | 644 | 37% | -0.02% | 0.96 |
| PEP | 909 | 36% | -0.02% | 0.95 |
| CSCO | 874 | 37% | -0.02% | 0.97 |
| SBUX | 889 | 36% | -0.02% | 0.96 |
| MCD | 886 | 35% | -0.02% | 0.94 |
| PFE | 892 | 34% | -0.02% | 0.94 |
| GD | 935 | 33% | -0.02% | 0.93 |
| AAPL | 922 | 42% | -0.03% | 0.94 |
| JPM | 923 | 33% | -0.03% | 0.92 |
| LOW | 946 | 34% | -0.04% | 0.92 |
| MMM | 910 | 35% | -0.04% | 0.88 |
| MSFT | 1027 | 35% | -0.04% | 0.91 |
| PG | 911 | 35% | -0.04% | 0.86 |
| TXN | 945 | 34% | -0.05% | 0.91 |
| AMGN | 1014 | 35% | -0.05% | 0.90 |
| LMT | 891 | 32% | -0.05% | 0.86 |
| WMT | 893 | 35% | -0.06% | 0.86 |
| HD | 980 | 33% | -0.06% | 0.87 |
| XOM | 850 | 34% | -0.06% | 0.82 |
| NKE | 985 | 35% | -0.07% | 0.86 |
| IBM | 865 | 32% | -0.07% | 0.82 |
| MRK | 933 | 31% | -0.08% | 0.80 |
| KO | 907 | 33% | -0.08% | 0.77 |
| GE | 869 | 29% | -0.09% | 0.79 |
| CVX | 841 | 32% | -0.09% | 0.76 |
| VZ | 831 | 31% | -0.09% | 0.74 |
| AXP | 930 | 32% | -0.11% | 0.75 |
| T | 853 | 31% | -0.11% | 0.72 |
| ADBE | 970 | 34% | -0.11% | 0.81 |
| BA | 936 | 30% | -0.12% | 0.72 |
| UNH | 1017 | 33% | -0.12% | 0.76 |
| DIS | 922 | 29% | -0.14% | 0.67 |
| CAT | 1003 | 28% | -0.15% | 0.68 |

**Limits:** daily bars (no 40-year intraday data exists), one round trip per stock per day, options not backtested, fixed symbol list (survivorship bias), costs are an estimate. Past results do not predict future results. Not financial advice.
