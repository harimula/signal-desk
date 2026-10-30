# The wheel study — 29 October 2026

**Question (owner):** *"Can you do covered calls and cash secured puts or else it's a too much ask?"*

**Answer in one line:** yes. On real option prices since February 2024, a put sold 5% under the price and bought
back at half its premium made money **92% of the time** on 39 large companies, and the wheel earned about
**+7.9% a year** on the money it had in use (trend filter on). Simply holding the same stocks made +15.7% a year
and SPY +17.5%: a covered call gives up the rise above its strike, and the shares a put delivers still fall in a
crash (worst month April 2025, −6.8%). The bot has it now (`bot/wheel.mjs`), **switched off** until the owner
gives it a share of the money.

Before tax. Today's companies looking back (survivorship bias) flatter every row alike. Not financial advice.

## 1. What was tested

`tools/wheel-study.mjs` (workflow `wheel-study.yml`, output `research-data/wheel-study.json` on the
`research-data` branch), 32 monthly rounds: first put sold 20 February 2024, last expiration 16 October 2026.

- **The cycle.** On the first trading day after a monthly expiration (the third Friday, or the trading day
  before it when that Friday is a holiday) sell one put that expires at the next monthly expiration, at the
  highest strike at least X% under the last close, fully cash-secured (strike × 100 set aside). At expiry: above
  the strike the premium is kept; under it the 100 shares are bought at the strike. With shares, sell a call each
  month at the lowest strike at or above both their cost (strike − premium) and X% over the price, until the
  shares are called away; then puts again.
- **Prices.** Each contract's own daily bars from Alpaca (options history starts February 2024). A sale fills at
  that day's average traded price less half an assumed 4% spread, on the first of the cycle's first three
  trading days on which one of the three strikes nearest the target traded; a premium under $0.05 is skipped.
  The buy-back at half (and the stop at 3×) fills at its price on the first day the contract trades through it,
  or at the open when it gaps through.
- **Stock prices.** Raw (not split-adjusted) daily bars from the broker, compared with the strikes; splits found
  from Yahoo's adjusted series, and a cycle across a split is skipped.
- **Lists.** *Large companies*: the 39 stocks of the original research, any price. *Scan stocks*: up to 60 of
  the bot's market-scan stocks priced $15–$150 when the put is sold.
- **Accounts.** Each stock is its own account, with fractional contracts so a $500 stock and a $20 stock count
  alike. A month's result is the average of the stocks that held a put or shares that month; holding the same
  stocks and holding SPY are the comparisons.
- **Variants.** X = 0, 5 or 10%; held to expiry, bought back at half the premium, or bought back at half with a
  stop at 3× the premium; with or without the **trend filter** (a put only when SPY and the stock closed above
  their 200-day averages before each day of the window up to the sale — one close under and that stock sells no
  put until the next window; calls on shares already held carry on). One sale per stock per cycle: money freed by
  an early buy-back waits for the next window.

Columns: *Puts won* — puts that made money (a put assigned under its cost loses); *Avg win / Avg loss / Worst
put* — on the cash set aside; *Calls won* — covered calls whose month (call plus the shares under it) made money;
*Per year* — compounded from the monthly results; *Largest fall* — from a high to a low, month by month.
*2024 from 20 February; 2026 to 16 October.

## 2. The 39 large companies

| Put sold | Exit | Trend filter | Puts | Puts won | Avg win | Avg loss | Worst put | Calls won | Per year | 2024* | 2025 | 2026* | Worst month | Largest fall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| at the price | held to expiry | on | 406 | 69.0% | +2.1% | −4.7% | −21.1% | 80.2% | +10.2% | +3.4% | +15.2% | +8.4% | −6.2% (2025-04) | −8.2% |
| at the price | bought back at half | on | 498 | 84.3% | +1.4% | −5.8% | −24.4% | 88.7% | +10.7% | +4.3% | +13.7% | +10.0% | −5.9% (2025-04) | −7.0% |
| at the price | half, or stop at 3× | on | 679 | 80.7% | +1.4% | −5.0% | −16.3% | 87.5% | +5.8% | +2.1% | +6.4% | +6.6% | −7.8% (2025-04) | −9.7% |
| 5% under | held to expiry | on | 575 | 85.2% | +0.9% | −4.4% | −19.6% | 83.7% | +8.2% | +0.7% | +11.9% | +9.1% | −7.2% (2025-04) | −8.9% |
| **5% under** | **bought back at half** | **on** | 597 | 91.8% | +0.6% | −5.3% | −22.9% | 91.3% | **+7.9%** | +1.1% | +9.0% | +10.8% | −6.8% (2025-04) | −8.7% |
| 5% under | half, or stop at 3× | on | 720 | 82.4% | +0.6% | −2.4% | −12.8% | 89.5% | +4.3% | +0.5% | +1.4% | +9.6% | −1.3% (2025-03) | −1.3% |
| 10% under | held to expiry | on | 606 | 93.7% | +0.4% | −4.3% | −20.8% | 89.8% | +8.6% | −0.5% | +7.8% | +15.7% | −10.0% (2025-04) | −10.0% |
| 10% under | bought back at half | on | 636 | 97.0% | +0.3% | −5.6% | −20.8% | 95.0% | +9.0% | +1.4% | +12.0% | +10.4% | −8.9% (2025-04) | −9.0% |
| 10% under | half, or stop at 3× | on | 692 | 86.4% | +0.3% | −1.2% | −9.6% | — | +1.0% | +0.6% | +0.2% | +1.7% | −0.8% (2026-07) | −0.8% |
| at the price | held to expiry | off | 425 | 68.0% | +2.1% | −4.7% | −21.1% | 80.3% | +9.4% | +3.6% | +13.4% | +7.7% | −6.3% (2025-04) | −8.4% |
| at the price | bought back at half | off | 553 | 83.5% | +1.3% | −6.1% | −29.3% | 88.7% | +9.4% | +4.1% | +12.1% | +8.5% | −6.2% (2025-04) | −7.7% |
| at the price | half, or stop at 3× | off | 993 | 79.7% | +1.4% | −5.2% | −33.9% | 88.0% | +3.0% | +0.5% | +4.1% | +3.4% | −3.9% (2025-04) | −5.7% |
| 5% under | held to expiry | off | 656 | 85.5% | +0.9% | −4.5% | −19.6% | 83.0% | +8.0% | +1.2% | +11.8% | +8.1% | −6.0% (2025-04) | −7.6% |
| 5% under | bought back at half | off | 757 | 91.5% | +0.6% | −6.2% | −29.8% | 90.3% | +6.3% | +1.0% | +9.6% | +6.0% | −4.9% (2025-04) | −6.2% |
| 5% under | half, or stop at 3× | off | 1218 | 81.4% | +0.7% | −2.5% | −13.9% | 89.5% | +1.7% | −0.7% | +2.3% | +2.8% | −1.2% (2025-03) | −2.8% |
| 10% under | held to expiry | off | 808 | 94.2% | +0.4% | −4.4% | −20.8% | 89.3% | +7.1% | +0.5% | +9.8% | +8.6% | −4.8% (2025-04) | −5.0% |
| 10% under | bought back at half | off | 938 | 96.9% | +0.3% | −6.6% | −26.8% | 93.3% | +4.1% | +0.6% | +7.8% | +2.4% | −2.9% (2025-04) | −3.2% |
| 10% under | half, or stop at 3× | off | 1176 | 84.8% | +0.3% | −1.3% | −10.1% | — | +1.1% | −0.1% | +1.2% | +1.7% | −0.6% (2026-07) | −1.1% |

## 3. The bot's own scan stocks, $15–$150

| Put sold | Exit | Trend filter | Puts | Puts won | Avg win | Avg loss | Worst put | Calls won | Per year | 2024* | 2025 | 2026* | Worst month | Largest fall |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| at the price | held to expiry | on | 478 | 76.6% | +3.5% | −4.9% | −24.6% | 75.4% | +32.3% | +17.0% | +38.1% | +29.1% | −10.2% (2025-04) | −15.7% |
| at the price | bought back at half | on | 591 | 87.0% | +2.2% | −6.5% | −27.3% | 80.5% | +28.9% | +13.2% | +30.9% | +31.5% | −11.8% (2025-04) | −17.7% |
| at the price | half, or stop at 3× | on | 715 | 84.5% | +2.2% | −8.2% | −25.3% | 82.5% | +16.7% | +5.9% | +16.6% | +21.6% | −13.2% (2025-04) | −20.2% |
| 5% under | held to expiry | on | 604 | 86.9% | +2.0% | −4.6% | −26.0% | 76.9% | +31.3% | +12.8% | +34.4% | +34.9% | −10.8% (2025-04) | −15.2% |
| **5% under** | **bought back at half** | **on** | 679 | 93.2% | +1.3% | −5.7% | −26.0% | 86.0% | **+25.8%** | +9.1% | +25.7% | +33.3% | −12.1% (2025-04) | −16.6% |
| 5% under | half, or stop at 3× | on | 801 | 85.8% | +1.3% | −5.1% | −20.1% | 87.0% | +13.4% | +4.7% | +20.2% | +10.7% | −9.8% (2025-04) | −14.5% |
| 10% under | held to expiry | on | 697 | 93.4% | +1.1% | −5.7% | −23.3% | 77.6% | +34.7% | +11.6% | +28.8% | +52.2% | −14.4% (2025-04) | −19.8% |
| 10% under | bought back at half | on | 731 | 96.3% | +0.7% | −8.0% | −23.3% | 84.9% | +26.9% | +6.9% | +20.3% | +45.3% | −14.4% (2025-04) | −19.0% |
| 10% under | half, or stop at 3× | on | 800 | 85.9% | +0.8% | −3.5% | −17.7% | 66.7% | +7.5% | +2.3% | +12.9% | +4.8% | −15.3% (2025-04) | −19.3% |
| at the price | held to expiry | off | 547 | 75.5% | +3.8% | −5.7% | −34.9% | 76.1% | +31.8% | +17.8% | +34.1% | +30.9% | −10.5% (2025-04) | −16.1% |
| at the price | bought back at half | off | 702 | 86.0% | +2.3% | −7.4% | −34.9% | 81.2% | +29.5% | +12.9% | +30.6% | +33.9% | −11.1% (2025-04) | −16.3% |
| at the price | half, or stop at 3× | off | 989 | 82.2% | +2.4% | −8.2% | −25.3% | 81.6% | +15.2% | +6.2% | +11.7% | +22.3% | −9.4% (2025-04) | −16.4% |
| 5% under | held to expiry | off | 696 | 84.9% | +2.2% | −5.8% | −34.5% | 76.1% | +30.3% | +14.0% | +32.0% | +33.1% | −10.1% (2025-04) | −14.7% |
| 5% under | bought back at half | off | 830 | 91.5% | +1.4% | −7.0% | −34.5% | 84.6% | +26.6% | +10.3% | +28.3% | +31.5% | −10.6% (2025-04) | −14.7% |
| 5% under | half, or stop at 3× | off | 1241 | 82.8% | +1.5% | −5.0% | −25.5% | 88.5% | +8.6% | +5.0% | +8.5% | +8.9% | −4.8% (2025-04) | −9.3% |
| 10% under | held to expiry | off | 906 | 92.2% | +1.2% | −6.6% | −33.6% | 76.0% | +28.9% | +12.2% | +25.6% | +38.4% | −9.0% (2025-04) | −13.5% |
| 10% under | bought back at half | off | 946 | 94.6% | +0.7% | −7.9% | −33.6% | 85.8% | +24.8% | +6.7% | +23.0% | +36.4% | −8.6% (2025-04) | −12.2% |
| 10% under | half, or stop at 3× | off | 1250 | 82.7% | +0.9% | −3.1% | −17.7% | 92.0% | +5.8% | +2.2% | +5.3% | +7.9% | −2.5% (2025-04) | −6.3% |

## 4. Against simply holding

| List | | Per year | 2024* | 2025 | 2026* | Worst month | Largest fall | Months up |
|---|---|---|---|---|---|---|---|---|
| Large companies | **Wheel: 5% under, half, trend filter** | **+7.9%** | +1.1% | +9.0% | +10.8% | −6.8% (2025-04) | −8.7% | 69% |
| Large companies | Holding the same stocks | +15.7% | +8.6% | +16.8% | +15.6% | −7.3% (2025-04) | −10.8% | 72% |
| Scan stocks | **Wheel: 5% under, half, trend filter** | **+25.8%** | +9.1% | +25.7% | +33.3% | −12.1% (2025-04) | −16.6% | 84% |
| Scan stocks | Holding the same stocks | +71.1% | +51.9% | +69.1% | +59.8% | −12.2% (2025-04) | −20.7% | 72% |
| — | SPY | +17.5% | +18.4% | +15.1% | +12.2% | −6.7% (2025-04) | −12.3% | 75% |

## 5. What the numbers say

- **The further under the price, the more puts win — but not more money.** At the price 69% of puts won, 5% under
  85%, 10% under 94% (held to expiry, large companies); the yearly result stayed between +7% and +10%, because a
  closer put collects a larger premium.
- **Buying back at half wins more often** (5% under: 85% → 92%) at about the same yearly result with the trend
  filter (+8.2% → +7.9%; without it +8.0% → +6.3%): the gain is taken early, and a put that is bought back cannot
  be assigned later in the month. The average loss grows, because the puts left to run are the ones going wrong.
- **A stop makes it worse.** Buying a put back when it costs 3× its premium cut the yearly result on the large
  companies to +1% to +6%: most puts that tripled were dips that came back before expiry.
- **The trend filter** sold no puts into April 2025 (SPY closed under its 200-day average on 21 March, the day
  before that window opened) and never made the worst put worse; it took 5–10 points off it in 9 of the 12 rows
  without a stop. On the large companies the yearly result was better with it in all six of those rows; on the
  scan stocks it was mixed.
- **April 2025 was the worst month in nearly every row.** The filter stops new puts, not losses on shares already
  held from an earlier put: a covered call keeps a little premium but does not protect the shares from a fall.
- **The wheel trails holding.** It gives up the rise above each call's strike. On the scan stocks it made
  +26% a year against +71% for holding them — today's most-traded stocks are, by definition, ones that rose a
  lot, so both numbers are far too good; the gap between them is the part to trust.

## 6. Why the bot's results will differ

- **Survivorship and hindsight.** Both lists are today's companies.
- **Money in use only.** A month's figure averages the stocks that held a put or shares; money waiting (the trend
  filter on, no stock passing, between a buy-back and the next window) is not in it. About a quarter of the
  stock-months had nothing in use with the filter on (30 of 39 large companies on average), so the yearly result
  on the part's whole share is lower than the table's.
- **One to three stocks, not thirty.** The bot sells whole contracts on at most 3 stocks (setting), so a 10%
  share of $100,000 ($10,000) holds one put at a strike up to $100. One assignment in a crash moves its result
  by 20–35% of that money (the worst single puts above), where the table's average of 30–40 stocks moved by less
  than a third of that.
- **Spread and fills.** The assumed 4% spread may be too low on less-traded strikes; the bot sells only when the
  quote's spread is under 15% of its middle. Daily bars cannot show whether a buy-back at half would have filled
  at that exact price.
- **Not modelled:** dividends (kept by the shareholder), early assignment (American-style options can be
  assigned before expiry, most often just before an ex-dividend date), and taxes (short-term gains).
- **32 months:** one rising market with one sharp fall.

## 7. What the bot does (`bot/wheel.mjs`, `wheelLane()` in `bot/bot.mjs`)

The rules above with **5% under, buy back at half, no stop, trend filter on**, one sale per stock per cycle,
stocks priced $15–$150, at most 3 at once, one contract each, on the wheel's own share of the stake (10% when
switched on, taken from the stock share). The stop, when set, buys back puts only, as tested. Off by default.
Details in `docs/ARCHITECTURE.md` §5.5 and in the settings guide, section 4d.

## 8. Reproduce

```
gh workflow run wheel-study.yml                       # needs the paper Alpaca keys (option and stock bars)
git fetch origin +research-data:refs/remotes/origin/research-data
git show origin/research-data:research-data/wheel-study.json > wheel-study.json
```
