# Signal Desk — System Documentation

**Version:** 1.9 · **Last updated:** 2026-10-25 · **Status:** living document, updated with every change (see [§9](#9-change-log-and-maintenance))

Signal Desk is a personal stock-signal website with an attached rules-based trading bot.
This document is the single place that explains **what it does** (functional), **how it is
built** (architecture) and **how it works inside** (technical), so that anyone — the owner,
a family member, a developer or a future AI assistant — can understand and maintain it.

Everything in this document and in the system is **not financial advice**. The website places
no orders; the bot places orders only on a brokerage account whose keys its owner chose to give it.

---

## Table of contents
1. [What Signal Desk is](#1-what-signal-desk-is)
2. [Functional description](#2-functional-description)
3. [Architecture](#3-architecture)
4. [Technical reference](#4-technical-reference)
5. [The trading bot in depth](#5-the-trading-bot-in-depth)
6. [Security model](#6-security-model)
7. [Operations and runbook](#7-operations-and-runbook)
8. [Testing and quality](#8-testing-and-quality)
9. [Change log and maintenance](#9-change-log-and-maintenance)
10. [Glossary](#10-glossary)

---

## 1. What Signal Desk is

| Part | What it is | Where it runs | Cost |
|---|---|---|---|
| **Website** | One static HTML page with three apps: *Signal Desk* (stocks), *Retirement* calculator, *Rent vs EMI* calculator | GitHub Pages (`https://harimula.github.io/signal-desk/`) and a private copy on claude.ai | $0 |
| **Data refresh** | Fetches prices and news every 10–15 minutes during market hours, commits them to the repo | GitHub Actions | $0 |
| **Trading bot** | Event-driven rules engine trading an Alpaca account (paper by default) during US market hours | GitHub Actions | $0 |
| **Research** | 33-year backtest harness that chose the strategy, re-runnable on demand | GitHub Actions | $0 |

Design principles:
- **No servers to maintain.** Everything is static files plus scheduled GitHub Actions jobs.
- **No secrets anywhere public.** Broker keys live only in GitHub encrypted secrets; the page never sees them.
- **No vendor lock-in.** Plain Node.js (zero npm dependencies), plain HTML/JS, plain JSON data files. Nothing depends on Claude, Anthropic or any paid service.
- **Owner's data stays with the owner.** Watchlists, portfolios, keys for live quotes and calculator inputs are stored in the owner's own browser (`localStorage`); nothing is uploaded.

---

## 2. Functional description

### 2.1 The three apps

```mermaid
flowchart LR
  AB[App bar] --> SD[📈 Signal Desk]
  AB --> RT[🌴 Retirement calculator]
  AB --> RE[🏠 Rent vs EMI calculator]
  AB --> TH[🌓 Dark / light theme]
```

**Retirement** and **Rent vs EMI** are self-contained calculators (each an `iframe` with its own
HTML file). Inputs persist in the browser so refreshing the page never resets them. The Rent vs
EMI calculator includes a SIP (systematic investment) plan for the money left over after rent.

### 2.2 Signal Desk tabs

A **USA / India switch** (with flags) beside the Signal Desk name chooses the market (remembered per device). The tabs left of the divider — Stocks, Day trading, Option trading, Bot trades, Bot settings — show the chosen market; the tabs right of it are shared.

| Tab | Purpose | Key features |
|---|---|---|
| **Stocks** (USA) | Signal board for ~40 US large caps + user tickers | Overview (market cards, best setups), Screener (sortable table: rating, score, price, day %, moving-average distance, analyst targets), Heat map, drill-down dialog per stock with chart, levels and an order ticket |
| **Stocks** (India) | Same for NSE large caps | Same views, ₹ pricing, NSE hours |
| **Day trading** | Tight intraday plans | Per stock: Buy at / Sell at / Stop at, position size for a chosen amount, copy-ready order ticket, 45-day simulated record, **P/L drill-down per stock per day** |
| **Option trading** | CALL/PUT plans on the same setups | Strike/expiry suggestion, premium estimate, exit rules, daily and overall P/L like Day trading |
| **Bot trades** | Everything the chosen bot did (USA: live practice account; India: the simulation) | Every trade with entry/exit time and P/L, daily and overall P/L, risk dashboard (heat, breakers, regime), performance vs research scorecard, live/stream indicator |
| **Bot settings** | Control panel for the chosen bot and this device (USA: sections 1–8; India: Connection, Sync, India bot) | Device sync (settings follow you, see §2.4), risk profile (Conservative/Balanced/Aggressive/Custom), capital split stocks vs options, strategy parameters, stock universe, news/event guards, paper/live mode, pause/resume/run-now, broker keys (sealed into GitHub secrets), journal passphrase |
| **News** | What is moving markets | Market brief by category, upcoming Fed/CPI/jobs schedule, tagged headlines, **news for the stocks in your portfolios** |
| **Portfolio (one tab per portfolio)** | Holdings with live P/L | Add/rename portfolios, holdings table, per-stock news |
| **My tickers** | User-added symbols | Fetched on demand, scored like the built-in universe |
| **Rules** | Every rule the page applies | Scoring table, rating bands, entry/stop/target construction |

### 2.3 Prices: three freshness levels

```mermaid
flowchart LR
  A[Snapshot<br/>live.json committed by GitHub Actions<br/>every 10–15 min in market hours] --> P[Page]
  B[On-demand refresh<br/>Yahoo Finance from the browser<br/>via optional Cloudflare worker] --> P
  C[Streaming ticks<br/>Finnhub websocket, user's own free key<br/>2.5 s smoothed updates] --> P
```

Price updates **morph the existing DOM** (no rebuild), so rows never jump, the scroll position
never moves, and a change shows as a brief green/red flash — like a broker app.

### 2.4 Settings follow you (device sync)

Everything the owner sets up — Finnhub/FMP keys, proxy URL, watchlist, portfolios, custom tickers, day-trade and option amounts, theme, auto-refresh choice, calculator inputs — is encrypted in the browser with the owner's passphrase (AES-256-GCM, PBKDF2-SHA256 × 200 000) and saved to the owner's own repo at `user/settings.enc.json` through the GitHub API. A new laptop or phone needs only the GitHub token and the passphrase (entered once in **Bot settings**); the rest arrives by itself. Pushes settle 8 s after a change and never happen more than once a minute, and are skipped entirely when the snapshot is unchanged; pulls happen on load and when the tab becomes visible again; last write wins by timestamp. Derived data rewritten on every render (`sd-dtlog`, `sd-oplog`, `sd-recs`) is excluded — syncing it produced a commit on every price tick. The token and passphrase never sync. Rent vs EMI and Retirement inputs are included.

### 2.5 Responsive behaviour

- Desktop: full tables, ‹ › arrows beside each panel to scroll wide tables.
- Phone/tablet (touch): full-width tables, company names hidden in favour of symbols, compact header, arrows hidden (swipe instead), calculators get one scroll surface.
- Dark/light theme toggle in the app bar reaches all three apps.
- The page checks for a newer build every few minutes and reloads to it without losing scroll position or inputs.

---

## 3. Architecture

### 3.1 System context

```mermaid
flowchart TB
  subgraph Owner["Owner's devices"]
    BR[Browser<br/>page + localStorage]
    PH[Phone<br/>Telegram]
  end

  subgraph GH["GitHub (free)"]
    REPO[(Repository<br/>code + data JSON)]
    PAGES[GitHub Pages<br/>static site]
    SEC[(Encrypted secrets<br/>ALPACA_*, JOURNAL_KEY, TELEGRAM_*)]
    subgraph ACT["GitHub Actions"]
      RF[refresh-prices<br/>every 10–15 min]
      TR[paper-trade-bot<br/>market hours]
      RS[strategy-research<br/>on demand]
      BT[backtest<br/>on demand]
      TS[bot-tests<br/>on push]
    end
  end

  subgraph EXT["External services"]
    YF[Yahoo Finance<br/>prices]
    FH[Finnhub<br/>streaming quotes, news]
    AL[Alpaca<br/>broker: paper or live]
    RSS[Fed / Yahoo RSS<br/>Benzinga news]
    NT[Telegram Bot API<br/>alerts + commands]
  end

  BR -->|reads| PAGES
  BR -->|optional| YF
  BR -->|optional, own key| FH
  BR -->|GitHub API, fine-grained token| REPO
  BR -->|sealed box| SEC
  PAGES --- REPO
  RF -->|writes live.json, news.json| REPO
  RF --> YF & RSS & AL
  TR -->|reads config.json| PAGES
  TR -->|orders, streams| AL
  TR -->|writes journal.json| REPO
  TR --> NT --> PH
  SEC -.->|env at run time only| TR
  RS & BT -->|reports| REPO
```

### 3.1.1 Portability — no repo name in the code

Nothing in the code names a particular account or repository. The page works out which repo it
belongs to from the GitHub Pages address it is served from (`<owner>.github.io/<repo>/`), and the
bot from `GITHUB_REPOSITORY`, which Actions sets for the repo it is running in. A copy served from
anywhere else (the claude.ai artifact) falls back to the `FALLBACK_REPO` constant near the top of
the page script — the one line to change when the project moves. Moving to another account or
repo name is therefore a copy plus re-enabling the services: see `MIGRATION.md`.

### 3.2 Repository layout

```
signal-desk/
├── index.html              the website (built; all three apps + app bar)
├── retire.html             Retirement calculator (iframe)
├── rentemi.html            Rent vs EMI calculator (iframe)
├── live.json               price snapshot written by refresh-prices
├── news.json               news feed written by refresh-prices
├── events.json             FOMC / CPI / jobs / PPI / minutes calendar through 2027
├── symbols.json            built-in universe (US + India)
├── ver.txt                 build stamp; the page polls it to self-update
├── docs/daytrading-rules.html  the day-trading rulebook (stocks, CALLs, PUTs) with how the bot applies each rule
├── docs/settings.html      owner-facing guide: what every Bot settings control does, defaults, when to change (linked from the tab)
├── tips.js               hover help for every page: label → explanation dictionary + one tooltip engine
├── vendor/qrcode.js       QR code generator (MIT), still used by the old #setup= link receiver only
├── tools/stamp.mjs         bumps the build stamp and rewrites the CSP script hashes (run after every index.html edit)
├── package.json  .nvmrc  eslint.config.js   npm scripts (test / lint / check / verify), Node 22 (needed for WebSocket), lint rules — no dependencies
├── favicon.ico  manifest.webmanifest   browser-tab icon; installable-app manifest
├── icons/                  logo.svg / logo.png, icon.svg, favicon, apple-touch, 192/512 and maskable PNGs
├── fetch.mjs               price fetcher (Yahoo) used by refresh-prices
├── news.mjs                news fetcher (RSS + Benzinga) used by refresh-prices
├── worker.js               optional Cloudflare worker: CORS proxy for Yahoo
├── bot/
│   ├── watchdog.mjs        dead-man's switch: alerts when the bot has not checked in during market hours (watchdog.yml)
│   ├── live.mjs            session runner: websockets, event loop, config hot-reload
│   ├── bot.mjs             decision cycle: entries, exits, floors, breakers, journal
│   ├── strategy.mjs        indicators and signals (SMA, RSI-2, exits)
│   ├── risk.mjs            sizing, heat, sector caps, regime, loss streak
│   ├── news.mjs            headline classifier, event guard, per-symbol risk
│   ├── config.mjs          presets, defaults, ranges, normalisation
│   ├── config.json         the control-panel settings (written by the page)
│   ├── journal.mjs         FIFO trade pairing from broker fills
│   ├── journal.json        trade journal (encrypted when JOURNAL_KEY is set)
│   ├── jcrypt.mjs          journal encryption shared by both bots (AES-256-GCM, PBKDF2 600k)
│   ├── india.mjs           India bot — simulation of the NSE research, two sleeves (trend breakout, RSI-2)
│   ├── india-journal.json  India simulation state and record (encrypted)
│   ├── config-in.json      India bot settings (stake, strategies, split, sizes)
│   ├── scan.json           last good market scan (tickers only), fallback while today's scan runs
│   ├── backtest.mjs        single-strategy backtest with costs and metrics
│   ├── research.mjs        4-strategy portfolio simulator, out-of-sample split
│   ├── research.json / research_report.md   research results (shown on Bot tab)
│   ├── backtest.json / backtest_report.md   backtest results
│   ├── spyopt.mjs          SPY quick options: signal, exits, order ids
│   ├── daytrade.mjs        day-trading signals (opening range, VWAP)
│   ├── scan.mjs            market scan: the most-traded stocks on NYSE/Nasdaq (ETFs and funds left out)
│   ├── msgpack.mjs         MessagePack codec for Alpaca's options stream (in-house, no dependency)
│   ├── telegram.mjs        Telegram alerts and read-only commands
│   ├── research-in-ideas.mjs  India 5-year research with tax (breakout, momentum, momentum + safety switch)
│   ├── research-day.mjs    day-trading research on 5-minute bars
│   ├── test.mjs            77 unit tests (run in CI)
│   ├── test-orders.mjs     113 end-to-end checks against a fake broker: which orders the bot places (CI)
│   └── test-india.mjs      15 India simulation checks (CI)
├── .github/workflows/
│   ├── refresh.yml         refresh-prices
│   ├── trade.yml           paper-trade-bot
│   ├── research.yml        strategy-research
│   ├── backtest.yml        backtest
│   ├── research-day.yml    day-trading-research
│   ├── watchdog.yml        watchdog (dead-man's switch)
│   ├── research-in.yml     india-research
│   ├── india-sim.yml       india-bot (simulation, after the NSE close)
│   └── test.yml            bot-tests
├── MIGRATION.md            moving to another account or repo name
├── docs/
│   ├── ARCHITECTURE.md     this document
│   ├── index.html          the same documentation as a web page (/docs/)
│   └── architecture.pptx   architecture slides
├── BOT.md  SECURITY.md  ACCOUNTS.md  FAMILY.md  MIGRATION.md  README.md
```

### 3.3 Data flow

```mermaid
sequenceDiagram
  autonumber
  participant Y as Yahoo / RSS / Benzinga
  participant RF as refresh-prices (Actions)
  participant R as Repo / Pages
  participant P as Page (browser)
  participant B as Bot (Actions)
  participant A as Alpaca

  loop every 10–15 min, market hours
    RF->>Y: fetch daily bars, quotes, headlines
    RF->>R: commit live.json, news.json, ver.txt
  end
  P->>R: load page, live.json, news.json, bot/journal.json
  P->>P: score, rate, render; localStorage for user data
  P-->>R: (Bot settings) write bot/config.json via GitHub API
  loop every 5 min cron, one session per day
    B->>R: read bot/config.json (hot-reload every 60 s)
    B->>A: account, positions, orders, bars
    A-->>B: trade-updates + market-data websockets
    B->>A: limit orders (entries, take-profits), market exits
    B->>R: commit bot/journal.json every 10 min and at close
  end
```

### 3.4 Deployment and scheduling

| Workflow | Trigger | What it does | Limits |
|---|---|---|---|
| `refresh-prices` | cron `*/10 13-21 * * 1-5` (US) and `*/15 3-10 * * 1-5` (India), manual | `node fetch.mjs` → `live.json`; `node news.mjs` → `news.json`; commits | ~1 min |
| `paper-trade-bot` | cron `45,50,55 12 * * 1-5` (early start, waits until 9:20 ET) + `*/5 13-21 * * 1-5`, manual; `concurrency` so only one session runs | `node bot/live.mjs` for up to 345 min; exits early if `bot/STOP` exists | 358 min timeout |
| `strategy-research` | manual | `node bot/research.mjs` → `research.json`, `research_report.md` | 40 min |
| `strategy-research-india` | manual | `BT_MARKET=IN node bot/research.mjs` → `research-in.json`, `research_in_report.md`: the same strategies on the Nifty 100 (Yahoo `.NS` history), Nifty 50 benchmark/regime, 0.15 %/side costs | 40 min |
| `india-bot-simulation` | cron `40 10 * * 1-5` + backup `10 12 * * 1-5` (after the NSE close), manual | `node bot/india.mjs`: the India bot in **simulation** — processes each completed NSE day once (fills yesterday's plans at today's open, exits at today's close, plans tomorrow), writes the encrypted `bot/india-journal.json`, one Telegram summary per day | 15 min |
| `backtest` | manual | `node bot/backtest.mjs` → `backtest.json`, `backtest_report.md` | 30 min |
| `day-trading-research` | manual, monthly (1st, 06:17 UTC) | `node bot/research-day.mjs` (Alpaca keys) → `research-day.json`, `research_day_report.md` | 120 min |
| `watchdog` | cron `*/15 13-20 * * 1-5`, manual | `node bot/watchdog.mjs`: journal older than 25 min in market hours → phone alert (hourly while down; skips holidays via the broker clock) | 3 min |
| `bot-tests` | push / PR | stamp check, ESLint, `node bot/test.mjs`, `node bot/test-orders.mjs`; `page` job: headless Chromium page tests | 10 / 12 min |

All actions are pinned to exact commit SHAs (`actions/checkout@11bd719… # v4.2.2`,
`actions/setup-node@49933ea… # v4.4.0`).

---

## 4. Technical reference

### 4.1 Website

- **Stack:** one HTML file, vanilla JavaScript, no framework, no build tooling in the repo (the owner's build script fills the price snapshot into the page template). External scripts: only libsodium (for sealing secrets), loaded from jsDelivr with Subresource Integrity hashes.
- **State:** `localStorage` keys prefixed `sd-` (watchlist, portfolios, custom tickers, theme, auto-refresh choice, Finnhub/FMP keys, GitHub token, journal passphrase) plus the calculators' own keys. All of it except the token and passphrase roams between devices through `user/settings.enc.json` in the repo (§2.4); a **setup link** can still carry quote keys to a device without the token.
- **Rendering:** `renderAll(bg)`. The foreground path rebuilds a tab; the background path (price ticks) morphs the existing DOM in place (`morphEl`/`morphKids`/`morphSet`, keyed by `data-s`), preserving `<details>` open state, row order and scroll offsets. Browser scroll anchoring is disabled; an interaction guard delays updates while the user is scrolling or typing.
- **Scoring:** each stock gets a score from trend (50/200-day averages), momentum, RSI, volume, distance to the chosen moving average, analyst targets and recent signals; the score maps to Top Buy / Buy / Hold / Sell / Top Sell bands. The Rules tab documents every weight.
- **Self-update:** the page polls `ver.txt`; when a newer build appears it reloads once, keeping tab and scroll.

### 4.2 Data files

| File | Written by | Shape |
|---|---|---|
| `live.json` | `fetch.mjs` | `{ at, rows: { SYM: [px, prevClose, …] }, bars: { SYM: [...] }, stamp }` — daily bars and latest quotes for the universe |
| `news.json` | `news.mjs` | `{ at, items: [{t, h, u, sum, s}], bySym: { SYM: [...] } }` — tagged headlines, per-ticker filtered |
| `events.json` | hand-maintained | `[{ date, time, type, title }]` — FOMC, CPI, JOBS, PPI, MINUTES |
| `bot/config.json` | Bot settings tab | see §5.4 |
| `bot/journal.json` | bot | plaintext `{ at, equity, day, trades, acts, … }` or encrypted `{ enc:1, kdf, iter, salt, iv, ct, at, sig, paper, stream, engine }` |
| `bot/research.json` | research workflow | per-strategy metrics (CAGR, Sharpe, max DD, OOS split) |
| `user/settings.enc.json` | the page (device sync) | `{ enc:1, kdf, iter, salt, iv, ct }` wrapping `{ v, at, dev, data: { key: value } }` |

### 4.3 Bot modules

| Module | Responsibility | Key exports |
|---|---|---|
| `live.mjs` | Process lifecycle for one market session; websocket subscriptions (trade updates + IEX market data); wake queue; 2 s beat (1 s after 15:50); polling fallback; config hot-reload; journal commit; stream reconnect on paper↔live switch | — |
| `bot.mjs` | One decision cycle: load bars, compute signals, apply guards, size, place/cancel orders, floors, take-profits, breakers, journal | `botCycle`, `fastCheck`, `applyConfig`, `pushPrice`, `endpoints`, `redact` |
| `strategy.mjs` | Indicators and signals | `sma`, `rsi2`, `rsi2Signal`, `rsi2Exit`, `replay` |
| `risk.mjs` | Money management | `stockQty`, `optionQty`, `regimeOf`, `lossStreak`, `openRisk`, `SECTOR` |
| `news.mjs` | Event and headline guards | `classify`, `loadEvents`, `guard`, `symbolRisk` |
| `config.mjs` | Settings schema | `PRESETS`, `DEFAULTS`, `RANGES`, `normalize`, `summary` |
| `telegram.mjs` | Alerts to the owner's Telegram chat; polls `getUpdates` every 3 s (off the decision path) and answers `/status /money /positions /watch /pause /resume /help` from `TELEGRAM_CHAT` only; never trades on a command | `tgOn`, `tgSend`, `tgPoll`, `parseCommand` |
| `journal.mjs` | Pair fills into round trips (FIFO) | `parseSym`, `buildJournal` |

Zero npm dependencies; Node 22+ (uses built-in `fetch`, `WebSocket` with headers, `crypto.webcrypto`; Node 20 has no WebSocket).

---

## 5. The trading bot in depth

### 5.1 Why RSI-2

`bot/research.mjs` simulated four strategies on 39 large US stocks, 1993 → 2026, with 0.05 %
costs per side, 10 % of equity per position, at most 6 positions, judged on the **last 30 % of
years (2016–2026), which were never used to choose anything**.

| Strategy | OOS CAGR | OOS Sharpe | OOS max drawdown |
|---|---|---|---|
| **RSI-2 mean reversion (chosen)** | **+16.4 %** | **1.45** | **−11.9 %** |
| Trend breakout | +7.2 % | 0.70 | −13.6 % |
| SPY buy & hold | +13.3 % | 0.79 | −34.1 % |
| Original intraday pullback rules (retired) | −4.1 % | −0.86 | −35.0 % |

Survivorship bias flatters all rows; treat them as an upper bound.

### 5.2 Rules

```mermaid
flowchart TD
  S([Session start 9:30 ET]) --> G{Guards}
  G -->|news crisis / FOMC window / breakers tripped| W[No new trades]
  G -->|clear| E[Entry window 9:45 → 11:00]
  E --> C{close > 200-day SMA<br/>and RSI-2 < 10<br/>and not bounced 1 %+}
  C -->|yes, market leaders first (or deepest dips)| SZ[Size: risk % of equity<br/>≤ stock % per position<br/>heat cap, ≤ 2 per sector]
  SZ --> O[Resting limit BUY<br/>+ optional CALL 14–35 DTE]
  C -->|no| H[Hold / wait]
  O --> M[Monitor every tick]
  M --> F{price ≤ −25 % floor?}
  F -->|yes| X1[Emergency market SELL]
  M --> TP{option +50 %?}
  TP -->|yes| X2[Take profit resting order]
  M --> L{last 10 min and<br/>close > 5-day SMA,<br/>or held 10 sessions}
  L -->|yes| X3[SELL at live price]
  L -->|no| N([Carry overnight])
```

- **Entries:** 9:45–11:00 ET (after 10:15 on CPI/jobs days); limit orders at the broker.
- **Exits:** last 10 minutes once the close is above the 5-day average, or after 10 sessions. A 25 % hard floor is a disaster brake (fires within a second off the stream).
- **Options:** CALL nearest strike, 14–35 days to expiry, same dips; take-profit +50 % as a resting order, stop −50 %, closed 3 days before expiry. Skipped under the pattern-day-trader guard when equity < $25 000.
- **Puts (experimental, OFF by default):** with **Trade PUT options** ticked, the mirror rule buys a PUT on a stock *below* its 200-day average whose RSI-2 is above 90 (a sharp pop in a downtrend), skipped once the pop has already fallen 1 %+ today. Same option rules as the CALLs (14–35 days, nearest strike, spread ≤ 20 %, shared 4-option cap and risk budget); exits when the stock closes below its 5-day average, after 10 sessions, or on the option take-profit / stop / expiry rules. Never backtested on options; the research workflow tests a stock-short proxy.
- **Day trading (experimental, OFF by default; `docs/daytrading-rules.html`):** 5-minute IEX bars for the universe + SPY, refreshed every 55 s. Market filter: SPY vs its session VWAP. Setups: 15-minute opening-range breakout (fresh 5-min close through the range, on the VWAP side, relative volume ≥ 1.2×) and VWAP pullback-and-reclaim on a trend day (≥ 70 % of closes on one side of the running VWAP). Stop under the range (0.1 ATR) or 1.5 ATR, whichever is closer; VWAP setup 0.25 ATR beyond the pullback; target 2R; breakeven at +1R; time stop 60 min at < 0.3R; flat 15:50 (options 15:45); entries 09:45–15:30; max 3/day, 1 per stock, 2-loss streak stop, daily cap, news guard and PDT guard. Longs = shares (or CALL), shorts = PUT only (nearest expiry 1–7 days, ATM strike, spread ≤ 10 %, +50 % / −40 % option exits). Order ids `sd-d-`/`sd-dc-`/`sd-dp-` carry entry, stop, target, date and entry minute so management survives a restart; `dayState` holds the trailed stop in memory. Runs every beat before the swing entries, independent of the RSI-2 entry window.
- **Guards:** FOMC/CPI/jobs calendar windows, live headline scan (war, White House, Fed, crisis keywords — matched on whole words, so "Stewart" and "Software" are not war headlines; a single company halting is tagged `single` and skips only that ticker), SPY tone; daily (−3 %) and weekly (−6 %) loss caps; 3-loss streak pause; stale orders cancelled after 45 min.

### 5.3 Real-time engine

```mermaid
flowchart LR
  TU[Alpaca trade-updates<br/>websocket] -->|fill / cancel| Q[Wake queue]
  MD[Alpaca IEX market data<br/>websocket] -->|every trade tick| PX[livePx] --> FC[fastCheck<br/>floors, take-profits]
  HB[Beat 2 s<br/>1 s after 15:50] --> Q
  CF[config.json poll 60 s] -->|changed| Q
  Q -->|≥ 250 ms apart| CY[botCycle]
  CY --> AL[Alpaca REST]
  CY --> J[journal.json<br/>commit every 10 min]
  CY --> NT[Telegram alert]
  AL -.->|stream down| POLL[REST polling fallback]
```

Measured in tests against a mock broker: fill → take-profit order 40 ms; crash tick → floor exit 110 ms.

**Journal continuity across runs.** Every run is a fresh process, and the panels the bot computes only while the market is open (watch list, market check, risk, day-trading block) plus the action log live in memory. At its first write the bot therefore reads the previous `bot/journal.json` back — decrypting it with `JOURNAL_KEY` when it is encrypted — and carries those panels forward until it has computed fresh ones; the action log is appended to (never re-appended) and capped at 80 entries. A run that starts at or after 16:00 ET exits at once if today's journal was already written at 15:55 or later (the day's session reached the close); otherwise it runs one closing cycle, writes the journal and sends the day summary. A previous journal written under a different passphrase is skipped with a log line, not a crash.

### 5.4 Settings (`bot/config.json`)

| Key | Meaning | Default |
|---|---|---|
| `mode` | `paper` or `live` (live also needs live keys and a typed confirmation) | paper |
| `preset` | conservative / balanced / aggressive / custom | balanced |
| `riskPct`, `optRiskPct` | % of equity lost if a stock / option trade hits its stop | 0.5 / 0.5 |
| `maxHeat` | % of equity at risk across everything open | 3 |
| `perSector`, `maxPositions`, `maxOptions` | caps | 2 / 6 / 4 |
| `dayCap`, `weekCap`, `streak` | circuit breakers (% loss, % loss, losses in a row) | 3 / 6 / 3 |
| `split`, `callSharePct`, `putSharePct`, `optDayCap` | money split: stocks (100 − CALLs − PUTs), CALLs and PUTs each own a share of the stake, their own daily loss limit (stocks `dayCap` on the stock money; CALLs and PUTs `optDayCap` on their own money) and losing streak | on / 30 / 10 / 10 |
| `spyOn`, `spySharePct`, `spyTradePct`, `spyTp`, `spyStop`, `spyHoldMin`, `spyMaxTrades`, `spyStreak`, `spyDayCap`, `spyDte`, `spyStart`, `spyEnd` | SPY quick-options sleeve (bot/spyopt.mjs): on, share of the stake, exits, brakes, expiry, window | on / 5 / 100 / 15 / 15 / 10 / 6 / 2 / 25 / 1 / 09:50 / 15:30 |
| `pickBy` | which dips to buy first when slots are short: `leaders` (60-day return vs SPY) or `dip` (deepest RSI-2) | leaders |
| `stockTp`, `holdFloor` | stock take-profit % (0 = off) and stop % (broker-side) | 10 / 25 |
| `stockPct`, `optPct` | max % of equity per stock position / option budget | 10 / 2 |
| `stocks`, `options`, `puts` | enable each instrument (CALLs, PUTs) | true / true / **false** |
| `universe`, `scanSize`, `scanMinPrice` | `list` = the `symbols` below; `scan` = each morning rank every tradable US stock (NYSE/NASDAQ/ARCA/AMEX, no OTC, plain tickers) by 20-day average dollar volume on the IEX feed and watch the top `scanSize` priced ≥ `scanMinPrice` (`bot/scan.mjs`); the scan is re-used for the day, falls back to yesterday's or the list on failure | list / 200 / $5 |
| `dayTrade`, `dayStock`, `dayCalls`, `dayPuts` | day-trading master switch and instrument per side | false / true / false / true |
| `dayOrMin`, `dayMaxTrades`, `dayStreak`, `dayRiskPct`, `dayTarget`, `dayRvol`, `dayTimeStop` | opening-range minutes, trades/day, loss streak, risk %, target in R, min relative volume, time stop minutes | 15 / 3 / 2 / 0.5 / 2 / 1.2 / 60 |
| `stakeUsd` | the stake: with a value set, every size, loss limit and the PDT rule are computed as if the account held only that much (0 = whole account); the page shows P/L against it | 0 |
| `liveSizePct` | real-money ramp: all budgets and risk figures × this % while `mode` is live (paper always 100 %) | 25 |
| `dayOptTp`, `dayOptStop`, `dayOptDteMax`, `dayStart`, `dayEnd` | option take-profit %, option stop %, max days to expiry, entry window | 50 / 40 / 7 / 09:45 / 15:30 |
| `alertDetail` | phone alerts include size and limit price on buys; entry price, exit price and open profit on sells | true |
| `intraday` | experimental: stock/CALL/PUT signals use today's live price as a provisional close (`liveSignal` in strategy.mjs) instead of waiting for the close; yesterday's close still drives the 1 % bounce rule | **false** |
| `stockUnit`, `callUnit`, `putUnit` | size each sleeve in `pct` (% of account) or `usd` (fixed dollars) | pct |
| `stockPct`, `optPct`, `putPct` / `stockUsd`, `callUsd`, `putUsd` | money per trade for each sleeve, in the chosen unit | 10 / 2 / 1 % · $10,000 / $2,000 / $1,000 |
| `stockCap*`, `callCap*`, `putCap*` (`Pct` or `Usd`) | ceiling on everything that sleeve holds plus its waiting buy orders; 0 = no ceiling | 0 |
| `rsiThreshold`, `maxHold`, `entryEnd` | strategy parameters | 10 / 10 / 11:00 |
| `optTakeProfit`, `optStop`, `holdFloor`, `staleMin` | exits | 50 / 50 / 25 / 45 |
| `newsGuard`, `eventGuard`, `alerts` | guards and alerts | true |
| `symbols` | universe | 30 US large caps |

The bot re-reads this file every 60 s from the public site, so a change in the Bot settings
tab is in force within a minute. Keys are **not** in this file.

---

## 6. Security model

```mermaid
flowchart TB
  subgraph Public["Public (GitHub Pages)"]
    P1[Page code]
    P2[config.json — settings, no keys]
    P3[live.json / news.json]
    P4[journal.json — encrypted when JOURNAL_KEY set]
  end
  subgraph Browser["Owner's browser only"]
    B1[GitHub fine-grained token]
    B2[Journal passphrase]
    B3[Finnhub / FMP keys]
  end
  subgraph Secrets["GitHub encrypted secrets"]
    S1[ALPACA_KEY / SECRET — paper]
    S2[ALPACA_LIVE_KEY / SECRET — live]
    S3[JOURNAL_KEY]
    S4[TELEGRAM_TOKEN / TELEGRAM_CHAT]
  end
  Browser -->|libsodium sealed box, SRI-pinned| Secrets
  Secrets -.->|env vars, in memory only| Bot[Bot run]
  Bot -->|AES-256-GCM, PBKDF2 600k| P4
```

- **Keys never touch the page or the repo.** The Bot settings tab seals them with GitHub's public key in the browser; only a workflow run can read them.
- **Paper and live are separate credentials.** Live trading requires `mode: live` **and** live keys **and** the typed phrase; a paper key is rejected by the live endpoint.
- **Device settings and sign-in.** Holdings, watchlist, keys and the GitHub token are stored in the public repo as one AES-256-GCM blob (PBKDF2-SHA256, 600,000 rounds — OWASP 2023; older blobs carry their own count and still open) under the owner's passphrase (≥ 12 characters); without the passphrase it is opaque. Because the blob is public on the site, **any device can sign in with the passphrase alone** (header → 👤 Sign in): it downloads the blob, decrypts it, installs the token and data, and syncs from then on. **Sign out and wipe** clears the browser. The passphrase is therefore the account password — the owner's checklist asks for a long, unique one.
- **Telegram:** the bot answers only the chat id stored in `TELEGRAM_CHAT`, ignores messages older than 30 minutes, keeps the token out of every error and log line, and has no buy or sell command — the strongest command is `/pause` (no new entries).
- **Private journal:** with `JOURNAL_KEY` set, the journal is AES-256-GCM encrypted and all numbers are scrubbed from Actions logs; the page decrypts locally with the passphrase.
- **Content-Security-Policy:** the page ships a CSP `<meta>` that allows only its own two inline scripts (whitelisted by SHA-256 hash), the SRI-pinned libsodium and the optional Firebase SDK; connections are limited to GitHub, the price and news APIs, the price relays and Firebase. A script that is not the page's own — injected through a bug, a poisoned feed or an extension — is refused by the browser. `tools/stamp.mjs` rewrites the hashes (and the build number) after every edit; CI fails if they are stale. Feed links are only clickable when they are `http(s)`; `referrer` is `strict-origin-when-cross-origin`.
- **Supply chain:** the only third-party scripts are pinned by hash; Actions are pinned to commit SHAs and watched by Dependabot; the bot has no npm dependencies.
- **Protective orders live at the broker:** every swing stock buy is an OTO order with a good-till-cancelled stop leg at the hard floor; every day-trade stock buy is a bracket (stop + target). Rule-based exits cancel the legs first, then sell at market; the day-trade breakeven rule moves the stop leg with a replace call; the bot's own stop check runs only where no leg exists. A dead-man's switch (`watchdog.yml`, every 15 min in market hours) alerts the phone when the journal has not been updated for 25 minutes; the bot sends an end-of-day summary; an optional `HEARTBEAT_URL` is pinged every minute.
- **Broker calls:** every request has a 15 s deadline; reads are retried with backoff on 429 / 5xx / network faults; order placement is never retried (the `client_order_id` and the in-process duplicate guard cover the slow-broker case). A cancelled run (SIGTERM) finishes its cycle, writes the journal and pushes it.
- **Broker API keys can trade but cannot withdraw funds** (verify in your own Alpaca settings).
- **Owner checklist** (`SECURITY.md`): 2FA everywhere (no SMS), sole collaborator on the repo, token scoped to one repo with ≤ 90-day expiry, Telegram connected through the page only, never paste keys into chat or issues.

---

## 7. Operations and runbook

### 7.1 First-time setup (≈ 20 minutes)
1. Alpaca account → Paper → generate API keys.
2. GitHub fine-grained token: only this repo; Contents, Secrets, Actions: read & write; 90-day expiry.
3. Site → **Bot settings**: connect with the token, paste Alpaca paper keys, choose a risk profile, set a journal passphrase, Save.
4. Repo → Actions → enable workflows; Settings → Actions → Workflow permissions → Read and write.
5. 2FA on GitHub, Alpaca and email.

The bot starts on the next market morning. Nothing on the owner's devices needs to stay on.

### 7.2 Day-to-day
| Need | Where |
|---|---|
| See trades, P/L, risk | Bot trades tab |
| Change risk, universe, guards | Bot settings tab → Save (in force within 60 s) |
| Pause / resume / run now | Bot settings tab buttons (writes/removes `bot/STOP`, dispatches workflow) |
| Alerts on the phone | Telegram: Bot settings → 1 → Connect Telegram; commands /status /money /positions /watch /pause /resume |
| Re-run research or backtest | Actions tab → workflow → Run workflow |

### 7.3 Going live — the procedure

Going live is a decision the owner makes once the checklist in **Bot settings → 7. Mode** is green. The page computes it from real data; it never blocks the switch.

**The checklist (what "ready" means)**

| # | Check | Why | Where it is measured |
|---|---|---|---|
| 1 | ≥ 60 trading days of paper history | fills, slippage and the guards must be seen across different market weeks | first closed trade in the journal |
| 2 | ≥ 50 closed trades | fewer is noise; the research edge is a +0.57 % average on thousands of trades | journal |
| 3 | live expectancy > 0 and ≥ half the research figure (on 30+ swing trades) | the first sign an edge is not there live | Performance card → *Live vs research* |
| 4 | worst drawdown so far < 10 % of the account | the bot's limits are working | journal |
| 5 | protective stops at the broker | survives bot downtime **for stocks**: OTO stop leg on every swing buy (GTC, at the hard floor), bracket (stop + target) on every day-trade buy. Options (CALLs, PUTs, SPY) have only a resting take-profit at the broker; their stops, time stops and end-of-day flats are bot-side — if the bot cannot run, close them in the Alpaca dashboard (SECURITY.md runbook) | code, since 2026-10-22 |
| 6 | phone alerts on + watchdog | you hear about every trade and every silence (watchdog alerts after 25 min without a check-in in market hours) | `TELEGRAM_TOKEN` + `TELEGRAM_CHAT` secrets (Bot settings → 1), `watchdog.yml` |
| 7 | live keys saved | `ALPACA_LIVE_KEY` / `ALPACA_LIVE_SECRET`, trading-only permissions | section 1 |
| 8 | live size ≤ 25 % | the ramp-up: every budget and risk figure is multiplied by `liveSizePct` in live mode | section 7 |
| 9 | experimental sleeves off or tiny | PUTs, intraday, day trading have no long record | sections 3, 4, 4b |

**Steps**

1. Checklist green (or you accept each red item knowingly).
2. On the Alpaca live account: enable options only if you intend to trade them; set the account's own daily loss limit if offered; confirm the API key cannot withdraw funds.
3. Bot settings: section 1 → paste the live keys → Save keys. Section 7 → Live size 25 → tick *Trade real money* → type `I UNDERSTAND THE RISK` → Save. The bot picks it up within a minute and reconnects to the live endpoint (`account switched to LIVE` in the log).
4. First live day: watch the Bot trades tab and the phone. Every entry should show *broker stop at …* in its line. Press **Pause — sell everything now** at the first sign of anything you do not understand.
5. Weekly: compare *Live vs research* and the drawdown. Monthly, if expectancy holds and the drawdown stays under 10 %, raise Live size: 25 → 50 → 75 → 100.
6. Never run two bots on one account; never leave `bot/STOP` in place by accident (it sells everything each cycle).

**What stays true even when "ready":** the research universe is today's survivors, so expect live results somewhat below the backtest; the IEX feed is a sample of the market (consider the consolidated feed for live money); GitHub Actions is a convenient runtime, not a guaranteed one — the broker-side stops exist because of that; taxes and wash sales are the owner's job (`SECURITY.md`).

### 7.4 Troubleshooting
| Symptom | Check |
|---|---|
| Bot tab says "No bot activity" | Actions → paper-trade-bot → latest run log; keys present? workflow enabled? |
| "What the bot is watching" card shows the fallback text | The journal on the site carries no watch block. Normal only for a brand-new setup or right after the journal passphrase was changed (the bot cannot read the previous entry); it fills in with the first check-in after 9:30 ET. Any other time: Actions → paper-trade-bot → latest run log for "previous journal could not be decrypted" |
| "Settings save failed" | Token expired or scoped wrong; regenerate |
| Prices stale | Actions → refresh-prices runs; press ↻ Refresh prices |
| Page shows lock screen | Enter the journal passphrase (same as `JOURNAL_KEY`) |
| Settings missing on a new device | Bot settings → connect GitHub, then enter the passphrase under *Sync across devices* |
| Live quotes not moving | Finnhub key saved on this device? Market open? |

---

## 8. Testing and quality

- `bot/test-orders.mjs`: serves a just-dipped stock and a just-popped stock from a fake broker and checks the exact orders one cycle places for each CALL/PUT switch combination (puts never appear unless ticked), money limits, market scan, journal continuity (a run that starts with the market closed keeps the previous encrypted entry's panels; rewrites never duplicate the action log; a foreign-passphrase entry is skipped), and — with synthetic 5-minute bars — the day-trading engine: ORB long → stock buy with levels in the id, market-down breakdown → PUT, daily maximum, flat at 15:50, stop at market, resting take-profit. Runs in CI.
- `bot/test.mjs`: 77 unit tests (indicators, journal encryption round trip, call and put signals, sizing, heat, regime, guards, journal pairing, config normalisation, RSS parsing, broker HTTP wrapper: retry, timeout, never-retry-an-order). Runs in CI on every push.
- `npm run verify` = `tools/stamp.mjs --check` (build number matches `ver.txt`, CSP hashes current, inline scripts parse) + ESLint on the bot and tools + both test files. CI (`bot-tests`) runs the same four steps on every push that touches the bot, the page or the tooling.
- `tools/page-test.mjs` (CI job `page`): headless Chromium walks every tab as a fresh visitor and as a connected owner with the Screener sub-view remembered, asserting no script errors and no CSP violations, then types into Bot settings and saves against a stand-in GitHub API.
- Accessibility: audited with the **full** axe-core rule set (2026-10-23; earlier passes ran a subset) in headless Chromium across every tab, both themes, and both calculators — zero violations; landmarks (`header`, `nav`, `main`), proper `tablist`/`tab` roles, labelled inputs, and all text colours at WCAG AA contrast (≥ 4.5 : 1) in both themes.
- Integration tests against **mock brokers** (REST + websocket) with a fake clock, covering: duplicate-order prevention, take-profit timing, floor exits off streamed ticks, config hot-reload, paper↔live reconnect, PDT guard, encrypted journal and log redaction.
- Page checks in headless Chromium at desktop and phone widths for every tab, including scroll-position preservation during live ticks.
- Research/backtest workflows produce reproducible reports committed to the repo. `day-trading-research` (manual + monthly) runs `bot/research-day.mjs`: downloads every 5-minute IEX bar since 2016 for the universe + SPY (needs the paper Alpaca keys), records what `daySetup` would have said at every bar close, then evaluates a 288-point grid (opening range 15/30 min, relative volume 1.0–2.0, target 1.5–3R, time stop 45–90 min, morning-only vs full window, market filter on/off) with the bot's daily discipline applied in time order; writes `bot/research-day.json` (verdict, defaults vs best, variants, per-year) and `bot/research_day_report.md`. The Bot trades tab shows it; Bot settings §4b can copy the best values into the form.

---

## 9. Change log and maintenance

**Maintenance rule:** every change to the website, the bot or the workflows updates this document, `docs/index.html` and, when the architecture changes, `docs/architecture.pptx`, **in the same commit**. Any change to a bot setting (new, removed, renamed, new default or range, new behaviour) also updates the owner-facing **settings guide** `docs/settings.html` (linked from the Bot settings tab) in the same commit, without being asked. After any edit to `index.html` run `node tools/stamp.mjs` (new build number + CSP hashes), and `npm run verify` before pushing. The "Last updated" line at the top and the table below are part of that commit.

| Date | Change | Docs touched |
|---|---|---|
| 2026-10-25 | **5-year card check** (owner: *"It seems incorrect in bot trading tab"*, screenshot of the card in My settings / After tax). Recomputed independently from `bot/research.json`: before tax $112,100, after tax $105,3xx, per-year columns and the benchmark lines match the research. Two small fixes: every line now starts at exactly $100,000 (the My-settings replay's first weekly point was 1.0018, which put the after-tax figure $190 high: $105,500 → $105,310); on phones the four mode buttons form a 2×2 grid instead of 3 + 1. |
| 2026-10-25 | **Fourth audit** (owner: *"audit my bot, bot setting, whole application … make it bulletproof"*). Three independent reviews in parallel (bot runtime; front end; infrastructure/security/docs) + two verification rounds on the runtime fixes. **Money paths:** (1) the false daily halt after a sale could still fire one cycle later (the guard lasted one cycle while fills were cached 60 s) → `missingFill` map, sticky until the sale is listed (max 10 min), fills re-read while it is set; (2) a buy filled in part and then cancelled (or still working) was treated as "not ours" and left without stops/exits → `bought()` everywhere; (3) early-close days (Nov 27, Dec 24, 1:00 PM) — every flat/exit was hard-wired to 4:00 PM → `CLOSE` from the broker calendar (`loadCalendar`, once a day) and clock, all exits/windows relative to it, swing entries stop at min(entry window, close − 15 min), live.mjs loop/start checks use `closeMins()`, journal carries `done`; (4) order history capped at 500 → `orderHistory()` pages back (older pages cached 5 min); (5) cancel-then-sell ignored failed cancels and could sell more than held (short) → `closeOut()`: cancels each resting sell, confirms with quick no-retry checks (follows `replaced_by`), re-reads the position (only a real 404 = flat), sells at most what is held; orphan sell orders for unheld symbols are cancelled (never the `held` leg of a waiting buy); every resting dip-buy is cancelled 5 min before the close (GTC buys used to sit overnight); (6) journal publishing ran git synchronously (minutes when GitHub is slow) → child process, journal writes paused meanwhile (`setPublishing`). Also: phone alert only after the broker accepts; a refused sell no longer aborts the cycle (`'refused'`, SPY/day-trade state kept for an immediate retry); a timed-out order keeps its duplicate key (it may have arrived); correct price increments (stocks $0.01; SPY/QQQ/IWM options $0.01; penny-pilot $0.01/<$3, $0.05 ≥$3; others $0.05/$0.10); `call()` supports `retries` and exposes `status`. **Page:** inverted day/SPY windows, empty boxes and an invalid stake are refused with plain messages (were saved and silently ignored); money-table errors use real names; stocks-at-0% note; after a passphrase change, a confirmed **Re-encrypt with this passphrase** (before, the public settings file stayed under the old passphrase); credentials excluded from the optional accounts sync; passphrase box labelled. **Infra/docs:** watchdog no longer de-duplicates by the hour (could stay silent all day at GitHub's real 15–45 min cadence); trade.yml pulls before a queued session starts (stale journal/`/pause`), final push removes the Pause mirror, dead `BOT_*` variables removed, `JOURNAL_RESET` variable passed to both bots; winter early start from 7:30 ET; SECURITY.md: what the token can do, compromise runbook, outage runbook (options are bot-managed), proxies; MIGRATION.md (Telegram, workflow list, preflight); BOT.md (tuning, tests, cadence); settings guide yours-values and minimum share price. Tests: broker 113 → 130 (+ multi-cycle false halt, partial fills ×3, early close ×3, orphan stop, kept waiting-buy leg, end-of-day cancel), page +3 (refusals, re-encrypt ×2). |
| 2026-10-25 | **SPY multi-trade review** (independent review of the change below; 4 findings + 2 follow-ups, all fixed). (1) A full cycle could rebuild the sleeve's state from an account picture taken before a tick entry, clear the pending flag and buy again on money that looked free → `snapAt` recorded before the account fetch; `spyCycle` keeps the live state and skips entry when a SPY buy was placed after (or within 10 s before) that picture; the pending flag clears only after that check. (2) A repeat CALL/PUT on a nearby break usually picked the same contract and merged into the open trade → `spyHeld` (every SPY option held or being bought, also by hand, from the latest cycle or fast lane) plus the sleeve's rows are excluded from the contract choice. (3) With several trades open, a losing-streak halt market-sold all of them → only the money limit (`spyCapHit`, reset each cycle) closes open trades; a streak or the daily maximum only stops new ones. (4) The fast lane could stop watching a tick entry until the next cycle → covered by (1). Tests +4 (cycle after a tick entry; held contract not bought; hand-held contract not bought; streak keeps an open winner); the cycle-after-tick test fails without fix (1). |
| 2026-10-25 | **SPY: several trades at once** (owner: *"I am ok to take multiple trades at a time … if you think market fall still further buy put"*; chose “new signals only”, 3 at once). New `spyMaxOpen` (1–5, default 3) in 4c. Each trade needs a fresh break: `spyFresh()` — the first trade of the day in a direction, or a 15-minute level beyond the one the previous trade in that direction used (higher for CALLs, lower for PUTs); levels kept in `spyLevels` and the journal `mem` so a restart cannot reuse a break. A PUT may open beside CALLs. Never averages down. One buy order worked at a time (`spyPendingUntil` now clears as soon as the buy fills); budget per trade = min(share × `spyTradePct`, free SPY money); `lastSpy.used` updated at placement so tick entries cannot overspend; the fast lane drops sold rows instead of wiping the list. At 100 % per trade the money runs out after one trade, so behaviour equals the old one-at-a-time. Tests +4 (fresh-break unit; second CALL on a new break with 20 %; max-open stop; same break never twice via journal memory). |
| 2026-10-25 | **Pre-flight check** (owner: *"look into it now?"* on a Sunday). New `tools/stream-check.mjs` + `.github/workflows/stream-check.yml` (preflight-check, manual): signs in to the paper account and clock, lists next-day SPY option contracts, signs in to the trade-updates, IEX stock and MessagePack options streams with the same Node 22 WebSocket calls the session uses, and reads `bot/STOP` through the GitHub API as `pollStop()` does. Places, changes and cancels nothing; prints statuses only. First run 2026-10-25: all checks passed. |
| 2026-10-25 | **Third audit** (two independent reviews: security/infrastructure and code/docs; 26 findings, 25 fixed, 1 left for the owner). **Kill switch:** Pause on the page writes `bot/STOP` to GitHub, but a running session only read its own checkout, so it kept trading until the next run → `live.mjs` `pollStop()` asks the GitHub API every 15 s (`GITHUB_TOKEN` added to trade.yml) and mirrors the file; the journal commit removes the untracked mirror before `pull --rebase --autostash` so it can never block a push. **Research look-ahead:** `research.mjs`, `research-in-ideas.mjs` sold at today's close *before* buying at today's open, so a close sale's cash and slot paid for the morning buy → entries now come first with the cash and slots held at the open; intraday limit fills count the target only if the close confirms it (`backtest.mjs`, `research.mjs`); research-day iterates days in date order; same-day (intraday) research trades now hold a slot and their money until the close (before, any number could run at once). An independent review confirmed the old order was look-ahead and the new one adds no error; on synthetic prices with no edge the old order still added about +0.3 % per trade — the same size as the drop in the real results (+0.57 % → +0.27 % per trade). US and India research re-run: US RSI-2 33-year CAGR 28.3 % → 8.7 % (SPY 8.8 %), out-of-sample 16.4 % → 3.3 % (SPY 13.1 %), 5-year bot 14.4 % → 1.5 % a year (owner's settings ≈ 3 %); trend breakout out-of-sample 9.2 %; India 5-year: breakout 8.6 % → 11.3 %, RSI-2 +1.0 % → −12.0 %, breakout on Midcap 150 after tax ₹16.0 L → ₹18.7 L; BOT.md, settings guide and the 5-year card updated. **Privacy mode:** every console line is redacted (tickers, option symbols, amounts; `redactText`), the public journal header's `engine.lastError` / `scan.err` too; refreshers get no Telegram/GitHub/journal secrets. **Journals fail closed:** an encrypted journal that cannot be decrypted (missing or changed `JOURNAL_KEY`) is never overwritten (US and India); `JOURNAL_RESET=1` starts over deliberately. **Commits:** git calls time out (60 s) and a failed rebase is aborted. **Setup link:** `#setup=` must name this site's repo and asks before replacing a saved token, passphrase or proxy. **Telegram connect** requires a one-time code (`t.me/<bot>?start=<code>`); handled commands are confirmed at once (no double answers after a restart). **Settings saved on two devices:** a save never overwrites settings another device saved meanwhile. **CSP** script sources narrowed to the exact libsodium and Firebase folders. **Scan:** NYSE Arca/Cboe listings and fund names (ETF, ETN, leveraged, inverse) left out; sector map widened to ~340 names. **India:** a position bought during a catch-up is not split-adjusted twice; the catch-up Telegram message shows that day's value; settings that need a restart say so. **Calendar:** BLS 2027 CPI/jobs/PPI dates and expected 2027 Fed minutes added; the bot warns when fewer than 45 days remain. **Other:** news matching needs `$AI`/`(AI)` for short or word-like tickers and whole words for names, undated items count as old; watchdog reads the checked-out journal (no Pages lag) and runs to 16:00 ET in winter time; refresh-prices has a timeout and no overlap; PBKDF2 iteration counts clamped on decrypt; retirement calculator rounds ages; rent-vs-EMI grid greys “about even” cells like the verdict; Node ≥ 22 everywhere. **Left for the owner:** the GitHub token travels inside the passphrase-encrypted sign-in blob (strength = the passphrase). Tests: unit 77, broker 113, India 15, page checks +5. |
| 2026-10-25 | **Second audit** (independent review of everything since the first audit + the money/order paths; 13 findings, all fixed). **False daily halt after a sale (most important):** the fills used for each part's day P/L were refreshed only every 60 s, so right after a sale the position was gone but its sell fill was not listed and the whole cost counted as a loss — a profitable CALL sale read as “CALLs down $5,000”, halted CALLs and market-sold the *other* open CALL (reproduced; a test now fails without the fix). Fills are now re-read whenever positions change (and paged beyond 100), and halts are skipped while a vanished position has no sell fill (`fillsLag`). Also: `send()` clears its duplicate key when the broker rejects an order (a failed stop could not retry for 90 s / 6 h); day-trade entries book their money (`useSL`) so two setups cannot overspend a share; STOP moved to the very top of `run()` (before the clock call); `spyFast` manages only the sleeve's own rows; `spyWatch` respects the daily SPY maximum and the pending lock is kept for 10 s after placing; `spyOnQuote` re-reads the position before selling (no sale of an option the take-profit already sold); SPY rows use the fill price as entry in every lane; the journal signature includes the day-state memory (a /resume is not lost on restart). India research: carried LT losses no longer offset ST gains (separate carries). 5-year card: reinvested, already-taxed dividends raise the funds' cost basis. Page: tickers the bot would drop (e.g. BRK-B), an empty list or > 60 are refused. Tests: 5 broker + 1 page; tooltip scan clean; accessibility clean in both markets. |
| 2026-10-25 | **SPY money per trade** (owner's request): new `spyTradePct` (10–100 %, default 100 = previous behaviour) in 3 · Capital allocation beside the SPY share. One SPY trade's budget = min(share × `spyTradePct`, free SPY money) × the live-size/FOMC budget factor, on both the cycle path (`spyCycle` → `spyPlace`) and the tick path (`spyEnter`); still one trade at a time. Journal `spy.rules.tradePct`; the allocation note shows the dollars per trade; the SPY card shows the %. Tests: 5 broker (100 / 50 / 20 % caps, tick path, no second trade while one is open), 1 unit, 2 page. |
| 2026-10-24 | **Research (India): three bot ideas after Indian tax, year by year** — new `bot/research-in-ideas.mjs` (run by research-in.yml; writes `research-in-ideas.json` / `research_in_ideas.md`): A breakout on Midcap 150 (10 %×10), B monthly 12-1 momentum top 20 of Nifty 200, C = B with cash when Nifty < 200-day. Lot-level tax (≤ 12 months 20 %, > 12 months 12.5 % above ₹1.25 L; ST losses offset both, LT only LT; carry forward; paid at calendar year end; cashed out at the end); before-tax figures from an identical untaxed run. ₹10 L, Oct 2021–Oct 2026, after tax: A ₹16.0 L, B ₹43.8 L, C ₹37.1 L, current India bot ≈ ₹11.9 L, Nifty 50 fund ₹12.9 L, Midcap 150 fund ₹17.3 L, Nifty 200 Momentum 30 fund ₹13.3 L. **B and C are not credible**: they use today's Nifty 200 members, and momentum buys exactly the stocks that rose into the index (look-ahead); the real point-in-time momentum fund made ₹13.3 L. A, though also flattered, still trails the Midcap fund. Stock lists from NSE archives (2026-10-24). |
| 2026-10-24 | **5-year card: modes and tax; docs usable from the home-screen app.** Research adds `history5.modes` (US): Conservative 8 %×4, Balanced 10 %×6, Aggressive 12 %×8 with the default strategy settings (buy < 10, +10 % TP, 25 % stop, leaders first), and *My settings* read from `bot/config.json` at research time (buy level, TP, stop, max hold, pick order, stock % and count, and the money-split stock share as an investment cap via new `CAP` in `simulate`; option/SPY shares count as cash). Results Oct 2021–Oct 2026: 10.3 / 19.8 / 29.7 / 25.5 %/yr, worst fall 7.6 / 9.3 / 14.7 / 10.0 %. Page: mode buttons and a Before tax / After tax switch on the card (per device, `sd-h5mode`, `sd-h5tax`), editable rates (`sd-h5st` 40.8 %, `sd-h5lt` 23.8 %); `h5AfterTax()` taxes the bot's net gain each calendar year at the short-term rate (losses carried) and shows cash-out value; funds pay the long-term rate on dividends yearly (approx. yields SPY 1.3 %, IJH 1.4 %, IWM 1.2 %, VGT/QQQ 0.6 %) and on the gain when sold. Table shows both amounts; phones get a compact before/after list. Docs: the site is installed as a standalone home-screen app, so `target=_blank` doc links left the app with no way back — docs now open in the same window and every doc page has a sticky “← Back to Signal Desk” bar and a one-line swipeable section menu on phones. Tests: 1 card check, 4 docs checks. |
| 2026-10-24 | **Full audit (owner's request).** Two independent reviews (bot runtime; front end) + tooltip scan + test-gap review. **Bot fixes:** Node 20 → 22 in `.nvmrc` and every workflow (Node 20 has no global `WebSocket`: trade/data/options streams never connected — journal showed `mode: polling` all day); `/v2/options/contracts` via `T()` (trading API) in `spyPlace` and `pickDayContract` (was `D()` → 404 → "no contract"); STOP check moved before any other call, each DELETE guarded, SPY sleeve disarmed; `dayPos` requires today's `sd-d*` id, `spyCycle` requires an `sd-y` id (manual SPY options untouched); `spyEntering` set inside `spyPlace`, `spyCycle` bails while entering; `send()` keys `sd-y` buys by order id and returns `{dry:true}` in DRY so `spyPlace` only mutates state when an order went out; shared `spySelling` lock in `spyManage`/`spyOnQuote`, cycles do not start while `spyBusy`; `.catch` on every cancel/PATCH; `loadBars` seeds empty symbols; live.mjs waits for `next_open` when closed before 16:00 instead of exiting, `fastCheck` ≤ 1/s, loud log when `WebSocket` is missing; journal `mem` block (lastDayPx, userPause, haltSaid) restored on the first cycle of the day; `addTradingDays` for SPY expiry; stale floors cleared; `lastSpy.budget` honoured by `spyEnter`; option entry price = fill price in every lane. **Page fixes:** `stOutOfRange()` refuses clamped values and bad time windows; `statusOf()` for Open now; go-live check includes `spyOn`; `W` defaults for older journals; `esc(null)` safe; ntfy wording removed; India connect wording; aria-labels; `role=status`; SPY labels prefixed to avoid tooltip collisions; `data-tipkey` on time-window and pick-order headings; tooltips for overview stats, sector lines (pattern), 'Last NSE day', 'GitHub token', 'Repository', table heads. **Tests:** fake broker split into trading and data hosts (wrong-host calls 404), STOP, old day id vs swing position, manual SPY option, same-contract re-entry (100 broker checks); fixture journals `tools/fixtures/journal-full.json` / `journal-old.json` render Bot trades in page tests (now 44 checks). **Docs:** settings guide rewritten with a running example ($100k, ACME) for every setting, sections 4c and India in the nav, glossary. |
| 2026-10-24 | **SPY sleeve: sub-second entries and exits** (owner: "less than a sec"). Entries: live.mjs `onTick('SPY')` now calls `spyEnter(px)` directly — contract → quote → limit buy (~0.5 s) via the shared `spyPlace()`; the full cycle keeps deciding *whether* the sleeve may trade (window, brakes) and `spyEnter` re-reads that from `lastSpy` (must be < 90 s old); `spyPendingUntil` (3 min) and a placeholder `open` row (`pending: true`) stop a second entry from either path. Exits: a third websocket to Alpaca's options quote stream (`v1beta1/indicative`, MessagePack — new dependency-free `bot/msgpack.mjs`, cross-checked against the Python library; `Content-Type: application/msgpack` on the upgrade), subscribed to the open option; each quote runs `spyOnQuote()` → `spyExit()` on the mid → cancel resting sells + market sell, once per symbol (60 s guard). The 1 s `spyFast` poll remains as the fallback and reconciles fills/pending rows. Tests: 4 broker (tick entry once, no entry below the level, quote exit once with TP leg cancelled, benign quote = nothing) + 2 unit (codec vs reference bytes, round-trip). |
| 2026-10-24 | **SPY fast lane** (owner: "can you look every second?"). A full cycle takes ~3 s (12 calls × ~200 ms), so the whole bot cannot; the SPY sleeve gets its own lane: (1) `spyFast()` in bot.mjs — while a SPY option is open, live.mjs calls it every 1 s when no cycle is running: positions + open orders (2 calls), then the shared `spyManage()` exit rules (stop / time / flat / halt; TP rests at the broker); duplicate-sell protection via `send()`'s 90 s guard. (2) Entries: `spyWatch()` exposes the level and direction the sleeve is waiting for; live.mjs `onTick('SPY')` wakes a full cycle the moment a streamed tick crosses it (10 s debounce) instead of waiting for the 2 s beat. Journal `spy.open` rows carry `id`/`entry` for the lane. Tests: 3 broker checks. |
| 2026-10-24 | **Page test no longer depends on the owner's saved shares.** The owner saved CALLs 20 / PUTs 5 (commit f605347) and the money-split checks, which assumed 30 / 10, failed in CI (the site itself was fine). The test now sets known shares first. Lesson for the maintenance notes: page checks must not assert the owner's live config values. |
| 2026-10-24 | **All money allocation in one place** (owner's request): `spySharePct` moved from section 4c into 3 · Capital allocation beside the CALL and PUT shares; a stacked allocation bar (stocks / CALLs / PUTs / SPY, with dollars when a stake or account value is known); the split checkbox is now titled as what it does (separate daily loss limits). 4c keeps only the SPY trading rules and points to section 3 for the share. |
| 2026-10-24 | **Money shares over 100 % is an error** (owner's request): `stShares()` / `shareErr()` on the page; a `role="alert"` message in sections 3 and 4c and a pill on the save bar, Save disabled and `stSave()` refuses. The bot-side clamp in config.mjs stays as a last resort for a hand-edited config.json. Tests: 2 page checks. |
| 2026-10-24 | **SPY quick options sleeve** (owner's request, modelled on a friend's alert channel: SPY CALLs/PUTs, minutes-long holds). New `bot/spyopt.mjs` (pure rules: `spySignal`, `spyExit`, id codec) and `spyCycle()` in bot.mjs, run every beat before the swing logic. Direction = SPY vs VWAP; trigger = break of the last 3 completed 5-min bars' high/low with the last bar closing that way on ≥ average volume; contract nearest the money expiring 1..`spyDte` days (default 1, never 0DTE), spread ≤ 5 %; one position; resting TP limit at +`spyTp`, bot-watched stop −`spyStop`, time stop `spyHoldMin`, flat 3:45; brakes `spyMaxTrades`, `spyStreak`, `spyDayCap` (own money). Money: a 4th part of the split, `spySharePct` (5) off the top of the stock share, always its own share even with the split off; `kindOf` maps SPY options to `spy`; `sideDayPl` gains `spy`. Journal `spy` block; Bot trades “⚡ SPY quick options” card and a 4th split card; settings section 4c; /money line. **Not backtested** (no minute-level options data) — stated in the UI and docs. Tests: 11 broker, 6 unit, 1 page. |
| 2026-10-24 | **Leaders first** (owner adopted the research): new setting `pickBy` = `leaders` (default) or `dip`. With `leaders`, today's RSI-2 dips are ranked by 60-day return minus SPY's (ties by RSI-2) before the slot loop; `dip` keeps the deepest-dip order. Watch rows gain `lead` (% vs market over 60 days), the journal watch block `pickBy`, the Bot trades table a “3-mo vs market” column and a note, the action log names the order. Options follow the same ranked list. Tests: 3 broker checks (LAG fixture: deeper dip, flat 3 months), 1 unit, 1 page. |
| 2026-10-24 | **Research: five ideas to make the USA bot different** (`ideas` in research.json; Aggressive 12 %×8, owner's settings as base; 39 stocks 1993–2026, out-of-sample from 2016-09-06). Per year all / since 2016 / last 5 yrs, and $100k after 40.8 % tax over 5 yrs: base 51.7 / 30.1 / 27.5 % → $212k; **3 · leaders first (rank dips by 60-day return vs SPY) 57.0 / 33.0 / 31.6 % → $236k, worst fall since 2016 −16.8 % vs −17.9 %** — the only idea better in every period; 1 · quality (template ≥ 6/8) 47.3 / 27.3 / 23.6 %; 5 · fear sizing 45.1 / 27.1 / 25.2 %; 4 · 50/50 with trend breakout (daily rebalanced) 29.5 / 20.7 / 16.7 %; 2a · market-down days only 25.8 / 13.6 / 12.7 %; 2b · panic days only 10.6 / 6.2 / 6.9 %. Survivorship bias inflates all absolute figures; the comparison between ideas is the point. No bot change. |
| 2026-10-23 | **Research: the 60/30/10 split over 5 years** (report only): the stock part on its 60 % (20 % of the part per stock, max 5, owner's settings) +27.2 %/yr of its own money, worst −26.2 %; PUT stand-in (short stock on RSI-2 pops, on its own money) −5.4 %/yr, worst −45.9 %. CALLs cannot be replayed (no options history). After 40.8 % tax on short-term gains: the split with CALLs at 0 % ≈ $157k from $100k; all-stock owner's settings ≈ $213k; VGT sold (23.8 % tax) ≈ $198k, held ≈ $229k; CALLs would need ≈ +24 %/yr to beat VGT sold, ≈ +39 %/yr to beat VGT held. |
| 2026-10-23 | **Research: USA bot sizing variants over 5 years** (`history5.variants`, report only): Balanced 10 %×6 +14.3 %/yr (worst −11.9 %); Aggressive 12 %×8 +22.6 % (−16.0 %); + 10 % take-profit +22.9 % (−15.5 %); owner's settings (buy below 25, +10 % take-profit) +27.6 % (−15.4 %); 16 %×6 +23.4 % (−18.6 %). VGT +18.0 % (−35.1 %), QQQ +14.0 %, SPY +12.5 %. New strategies `rsi2own`, `rsi2tp10`. Caveat: a fixed list of 39 large stocks chosen today (survivorship), fills at the open; the live bot's 1 % risk-per-trade rule can make positions smaller than 12 %. |
| 2026-10-23 | **India 5-year comparison adds Nifty Next 50** (UTI Nifty Next 50 Index Fund, Direct Growth, AMFI 143341 via mfapi.in). 2021-10-21 → 2026-10-22, per year: India bot +5.0 %, trend breakout alone +8.2 %, RSI-2 alone +1.3 %, Nifty 50 +5.6 %, Next 50 +10.0 %, Midcap 150 +13.0 %, Smallcap 250 +12.2 %. |
| 2026-10-23 | **New defaults** (owner: "keep your choice as default, let me change it"): `stockTp` default 10 (was 0) — the research's best stock rule; `holdFloor` 25; options back to `optTakeProfit` 50 / `optStop` 50 (the +20 / −10 version is untested and trades less under the spread rule). Each field's help shows its default. |
| 2026-10-23 | **Stock stop back to 25 %** (owner accepted the research): `holdFloor` 25, `stockTp` 10 kept, options +20 % / −10 % kept. Research (39 stocks, 1993–2026): previous rule +28.3 %/yr (last 10 yrs +16.4 %, worst −14.3 %); +10 %/−5 % +16.4 % (+9.9 %, −18.5 %); +10 % take-profit alone +28.4 % (+17.0 %, −13.3 %); −5 % stop alone +16.5 % (+9.8 %, −18.5 %). |
| 2026-10-23 | **Quick exits** (owner's choice: small, fast profits): new `stockTp` (stock take-profit %, 0 = off) sells a swing stock as soon as it is up that much, any time of day (same day only when the PDT rule allows). Ranges widened: `optTakeProfit` 5–300, `optStop` 5–90, `holdFloor` 2–60. Owner's settings: stocks +10 % / −5 %, options +20 % / −10 %. Tightening `holdFloor` moves older broker stop legs up (PATCH, once per leg) and sells a holding already below the new stop; a correct leg is left to the broker (no double sale). Option entries need a bid/ask spread under half the option stop (max 20 %). Research adds `rsi2quick` (RSI-2 entries, +10 % / −5 % intraday exits, stop checked first on a day that touches both). Tests: 13 broker checks + 1 unit. |
| 2026-10-23 | **Money split in three parts** (owner's choice): stocks / CALLs / PUTs at 60 / 30 / 10 by default — `callSharePct` and `putSharePct` replace `optSharePct`, stocks get the rest (the two are capped at 100 together). Each part has its own money ceiling, daily loss limit (CALLs and PUTs each `optDayCap` % of their own money) and losing streak; a stopped part closes only its own option type. `sideDayPl()` now returns stock / call / put (and `opt` = both); the journal `split` block carries `shares` and one entry per part; Bot trades shows three cards; /money shows three lines. Tests: 14 broker checks for the split. |
| 2026-10-23 | **Money split (stocks / options, first version):** new settings `split` (on), `optSharePct` (20) and `optDayCap` (10). Each side gets its own share of the stake as a money ceiling (combined with the per-instrument ceilings), its own daily loss limit (stocks: `dayCap` % of the stock money; options: `optDayCap` % of the options money) and its own losing-streak count; one side stopping never stops the other. Today's P/L per side comes from `sideDayPl()` in `bot/risk.mjs` (value now − value at yesterday's close + sells − buys, from positions and today's fills; yesterday's close for sold-out symbols is remembered from earlier checks). Journal gains a `split` block; Bot trades shows a Stocks and an Options card; Telegram /money shows both sides and one alert names the side that stopped. Weekly loss limit and the market check still cover everything. Split off = previous behaviour. Tests: 6 unit + 12 broker checks + 2 page checks. |
| 2026-10-23 | **Clean market separation:** the switch shows US and India flags (inline SVG, so Windows shows them too). With India chosen, Bot settings shows only the India bot section (no Alpaca keys, live keys, sync or US risk settings) and its own subtitle; the Day trading subtitle names the chosen market; the India bot text no longer quotes ET times or calls RSI-2 "the US strategy". A page audit of every tab in both markets finds no text from the other market apart from the switch itself. |
| 2026-10-23 | **One market switch** (owner chose it from a clickable prototype): a USA / India toggle beside the Signal Desk name (`sd-mkt`, per device). Stocks (replaces the USA stocks and India stocks tabs), Day trading, Option trading, Bot trades and Bot settings follow it; the header status, snapshot age and prices line show the chosen market; the in-tab switches (Day trading, Option trading, Bot trades) are gone; a divider separates the shared tabs (News, portfolios, My tickers, Rules). Bot settings shows only the chosen bot: USA = sections 1–8 as before; India = Connection, Sync and **2. India bot (simulation)**. Page checks: 27; full axe clean for both markets. | ARCHITECTURE §2.2; settings.html; docs/index.html |
| 2026-10-23 | 5-year history (US) also measures VGT (Vanguard Information Technology) and QQQ (Nasdaq-100), owner asked *"Does the US bot beat VGT?"*: VGT +18.2 %/yr (worst fall −35.1 %), QQQ +14.2 %/yr (−35.1 %), USA bot +14.4 %/yr (−11.9 %). | docs/index.html |
| 2026-10-23 | **5-year history card** (owner: *"see the bot history for 5 years, compare with small, mid and large caps"*). `research.mjs` replays each bot's exact rules over the last 5 years from a fresh start (India: breakout + RSI-2 50/50 as configured; US: RSI-2) and measures large/mid/small caps with dividends — India: AMFI index-fund NAVs via mfapi.in (Bandhan Nifty 50 118482, Motilal Oswal Midcap 150 147622 / Smallcap 250 147623, Direct Growth); US: SPY / IJH / IWM adjusted closes — saved as `history5` (weekly points, total, CAGR, worst fall, Sharpe, calendar years). Bot trades shows it in both views (log-scale chart + table); `--line-mid` colour token. Result: India bot +5.0 %/yr vs mid +13.0 %, small +12.2 %, Nifty 50 +5.6 % (trend breakout alone +8.2 %); USA bot +14.4 %/yr vs S&P 500 +12.4 %, mid +6.9 %, small +5.2 %, with about half the worst fall. | ARCHITECTURE §3.4; docs/index.html |
| 2026-10-23 | Bot settings **§9 India bot (simulation)**: strategies, stake, split, size, max positions, RSI-2 level/hold, Telegram summary; own Save (writes `bot/config-in.json`) and a two-press Restart (sets `resetAt`). Page checks: 22. | settings.html; docs/index.html |
| 2026-10-23 | **India view on Bot trades**: a 🇺🇸 USA bot / 🇮🇳 India bot switch (remembered per device, `sd-botmk`); the India view decrypts `bot/india-journal.json` with the same passphrase and shows status, value vs the Nifty 50 (stat strip + line chart), one card per strategy with its live record next to the NSE test, buys planned for the next open, open positions with their exit rule, what each strategy is watching (closest to a 50-day high; deepest RSI-2 dips with the trigger close), closed trades (latest 15), activity log; hover help for every new label. Research: India report also measures Nifty Smallcap 100 / Midcap 50 / Midcap 100 buy-and-hold over the same dates (US: Russell 2000), owner asked whether the strategies beat small caps. | ARCHITECTURE §2.2; docs/index.html |
| 2026-10-23 | **India step 2 — simulation bot.** Owner: separate India bot on his mother's Zerodha account (she lives in India; resident account); both strategies side by side; ₹10 lakh simulated stake. New `bot/india.mjs` replays the NSE research forward one real day at a time (Yahoo daily bars for the Nifty 100 + ^NSEI; plans at the close, fills at the next official open in whole shares, exits at the close, 0.15 %/side; split events adjust open positions; catch-up of missed days; a second run on the same day is a no-op), two sleeves with their own cash and record (trend breakout 50 %, RSI-2 50 %; 10 % per position, max 6 each), reset via `resetAt` in `bot/config-in.json`; encrypted journal (shared `bot/jcrypt.mjs`); one Telegram summary per day (🇮🇳). Workflow `india-sim.yml`. Tests: `bot/test-india.mjs` (12: rules, fills, limits, no-trade day, catch-up/idempotency, splits, message, full run against a stand-in Yahoo + Telegram). No broker and no orders: real trading is step 3 (Kite Connect, static IP, her daily login). | ARCHITECTURE §3.2, §3.4; docs/index.html |
| 2026-10-23 | **India, step 1 — research.** Owner asked for a separate India bot (Zerodha, resident account). Facts checked: SEBI retail-algo framework in force since 2026-04-01 (orders only from a broker-registered static IP; < 10 orders/s needs no exchange registration), Kite Connect order API free / data ₹500 per month / manual login every day, no Indian paper-trading accounts. Plan agreed: (1) replay the strategies on NSE, (2) a separate India bot in simulation mode on live NSE prices, (3) real orders only if (2) holds, via a static-IP server. This change: `research.mjs` takes `BT_MARKET=IN` (Nifty 100, ^NSEI, 0.15 %/side, separate output files); workflow `research-in.yml`. | ARCHITECTURE §3.4; docs/index.html |
| 2026-10-23 | **Hover help everywhere**: new `tips.js` (loaded by index.html, retire.html, rentemi.html; CSP `'self'`): ~240 label → explanation entries; table headers, stat titles, form labels and chips whose text matches get a subtle dotted underline and an accessible tooltip (mouse hover with 280 ms delay, tap on touch, keyboard focus, Esc; `aria-describedby` for screen readers); generic table words apply to `<th>` only; a MutationObserver queues every added node; `morphEl` keeps `data-tip*` / `aria-describedby` through redraws. Coverage measured: every settings and calculator label, every header/stat on every tab. **Settings defaults**: a key missing from config.json now shows (and saves) its default instead of an empty box (day-trading fields were blank). **Sync panel**: QR link and show-passphrase removed (Sign in replaces them). **Accessibility**: full axe rule set was not clean — fixed labels (amount boxes, time inputs, stock list), news chips `role=tab`, day-trade tiles `role=group` (contained an interactive ticket), Moving-average card as a region, Rules tab h2, contrast (preset descriptions, unused money fields now dashed instead of 45 % opacity, research highlight rows), calculators: `lang`, `main`, valid `dl`, labelled table header. Page checks: 20. | ARCHITECTURE §3.2, §8; settings.html; docs/index.html |
| 2026-10-23 | **ntfy removed** at the owner's request (*"No longer needed: ntfy alerts"*) — Telegram is the only alert channel. Removed from the page (topic box, test button, status dot), bot.mjs (`flushAlerts`), watchdog.mjs, both workflows' env (the bot no longer receives `NTFY_TOPIC`, so nothing goes to the public topic even though the secret still exists), the CSP and the tests; readiness item and the Guards checkbox now refer to Telegram. The leftover `NTFY_TOPIC` secret can be deleted in GitHub → Settings → Secrets. | ARCHITECTURE §3.1, §5.3, §6, §7, glossary; settings.html; docs/index.html; SECURITY.md; BOT.md; architecture.pptx |
| 2026-10-23 | Swing entry window bug (reported via Telegram: *"entry window closed"* at 1 PM with entries set until 3:30): `normalize()` accepted `entryEnd` only up to 15:00, so 15:30 silently became the 11:00 default. Range now 10:00–15:45; the page's time box has min/max and Save refuses an out-of-range time; idle text names the swing window and where to change it. Unit test (58). | settings.html; docs/index.html |
| 2026-10-23 | **Telegram alerts and commands.** New `bot/telegram.mjs`; `flushAlerts` sends to ntfy and/or Telegram; `tgCommand()` in bot.mjs answers /status /money /positions /watch /help and sets an in-memory `/pause` (adds a `G.block` reason: entries stop, exits and stops unchanged, resets at the next session) / `/resume`; runner polls every 3 s; watchdog also posts to Telegram. Secrets `TELEGRAM_TOKEN` + `TELEGRAM_CHAT` (trade.yml, watchdog.yml). Bot settings §1: *Connect Telegram* (getMe → getUpdates finds the owner's private chat → test message → both sealed as secrets); `https://api.telegram.org` in connect-src; readiness item accepts Telegram or ntfy. Safety: only the configured chat is answered, messages > 30 min old are skipped, the token never appears in errors or logs, no command can buy or sell. Tests: parser (unit, 57), 5 order checks (alert delivery, commands, other chats ignored, /pause blocks a buy, /pause never sells; 48), 2 page checks (18). | ARCHITECTURE §4.3, §6; settings.html; docs/index.html; architecture.pptx |
| 2026-10-23 | **Save keys fixed** (reported: *"Cannot read properties of undefined (reading 'ready')"*). Two causes: (1) the page paired libsodium core 0.7.16 with wrappers 0.7.13 — the 0.7.16 browser module ships a truncated WebAssembly section and never initialises → core and wrapper now both 0.7.13 (SRI re-pinned from the npm tarball); (2) the 2026-10-22 CSP blocked WebAssembly compilation → `'wasm-unsafe-eval'` added to script-src (WebAssembly only; JS `eval` stays blocked). New page check presses Save keys with the real library files and the real CSP and asserts a sealed `NTFY_TOPIC` PUT (page checks: 16; CI installs the two libsodium packages for it). | ARCHITECTURE §6, §8; docs/index.html |
| 2026-10-23 | Bot trades: **In trades now** (market value of all open positions, % of the stake) replaces the open-P/L box, with a line under the strip — stocks / options value, amount paid, open P/L, free to trade of the stake. Options counted at price × 100 per contract (`mult` from journal.mjs). | docs/index.html |
| 2026-10-23 | Alert topic saved as the full ntfy link (`https://ntfy.sh/<topic>`) now works: `ntfyTopic()` in bot.mjs, the same rule in watchdog.mjs and in the page (save + test button) reduce it to the topic name; before, the bot posted to a garbled topic. Unit test added (56). | settings.html; docs/index.html |
| 2026-10-23 | Phone alerts you can verify (reported: *"I am not getting notifications"*; the account has 0 trades, so there was nothing to send). **Send test alert** button under the topic box posts to `ntfy.sh/<typed topic>` from the browser (`https://ntfy.sh` added to connect-src); `morningHello()` sends "Bot is up for the day" once, from the first run of the day. Page checks: 15. | settings.html; docs/index.html |
| 2026-10-23 | **Finnhub live stream unblocked.** The CSP added on 2026-10-22 allowed `https://finnhub.io` but not `wss://ws.finnhub.io`, so the browser silently refused the live-price websocket. Added to `CSP_HOSTS.connect`; `stamp.mjs --check` now fails the build when the page's code connects (fetch / tryJson / WebSocket / EventSource) to a host connect-src does not allow. | ARCHITECTURE §6, §8; docs/index.html |
| 2026-10-23 | (1) Scan root cause, now visible in `engine.scan`: the data server answers `504 backend request timeout` for 500-symbol bar requests → 100 per request, a failing chunk is skipped (scan fails only if > 20 % of chunks fail). (2) Site prices: GitHub skipped every 10-minute `refresh-prices` run after 9:36 ET, so `live.mjs` now runs `fetch.mjs` + `news.mjs` in a child process every 10 min and commits `live.json` / `news.json` with the journal (`BOT_NO_PRICES=1` disables). The scheduled workflow stays as the backup outside the bot's hours. | ARCHITECTURE §3.4; docs/index.html |
| 2026-10-23 | Scan follow-up: the asset list request (~12,000 assets) also gets the 60 s limit; scan state (`running` / `done` / `failed` + error) is published in the plaintext `engine.scan` block and shown in the Bot trades engine line. | ARCHITECTURE §8; docs/index.html |
| 2026-10-23 | **Market scan no longer stalls the bot.** This morning the journal showed 30 symbols (the list, not the 200-stock scan) and 246-second cycles: the scan's large bar downloads hit the 15 s per-request limit, failed, and were retried on every cycle. Now the scan runs in the background (a cycle waits at most 3 s for it), each scan request has a 60 s limit and 500 symbols, a failure is retried after 10 min, and the last good scan is kept in `bot/scan.json` (committed by the bot) as the fallback. `call()` accepts a per-request `timeoutMs`. Order check added (a scan that hangs 20 s: cycle finishes, list stocks still traded; 43 checks). | ARCHITECTURE §3.2, §8; docs/index.html |
| 2026-10-23 | Late start fix: GitHub fired the 9:20 ET schedule at 9:34, and the page showed yesterday's journal until the first 10-minute commit. Workflow now also fires at 8:45/8:50/8:55 ET (EDT) and `live.mjs` waits until 9:20 instead of exiting; the first journal is committed right after the first cycle. | ARCHITECTURE §3.4; docs/index.html |
| 2026-10-23 | Watch card on phones: the BUY / CALL / PUT ticker lists were joined without spaces, so a long list could not wrap and ran past the card (and widened the page). Now a wrapping flex row in the mono font, with a count of stocks under each list. Checked at 390 px: no horizontal overflow. | docs/index.html |
| 2026-10-22 | **Journal continuity fix** (reported: *"In bot trading I don't see the watching card"*). Root cause from the run records: the day's session ended 16:00:04 ET, the run queued behind it started 16:00:21 ET with the market closed and, unable to read its own encrypted previous journal, rewrote it from an empty memory — no watch list, no market check, no risk panel, no day block, empty action log (same thing every morning 9:20–9:30). Fix: `previousJournal()` decrypts the last entry with `JOURNAL_KEY` and `writeJournal` carries `watch`/`env`/`risk`/`day` forward until fresh ones exist; action log appended once (also fixes a duplication bug: every rewrite re-appended the whole process log); `live.mjs` exits at once when started after the close and today's journal is already from ≥ 15:55 ET (no second day summary); page shows the card in a fallback form when a journal has no watch block. Tests: crypto round trip (unit), closed-market restart keeps panels, three rewrites never duplicate the log, foreign-passphrase journal is skipped (order checks: 42). | ARCHITECTURE §5.3, §7.4, §8; docs/index.html |
| 2026-10-22 | Engine speed and health: the cycle's four account reads run in parallel (`Promise.all`); `engine` block in the journal (and in the plaintext envelope) with cycle time, slowest cycle, broker latency, calls, errors in the last hour; shown as a line on the Bot trades tab. Decision recorded: one process for stocks and options — two bots on one account would double or fight over positions; independence comes from the per-instrument switches and money sleeves | §5.3, §5.5 |
| 2026-10-22 | **Design system pass:** IBM Plex Sans + Plex Mono (tickers), token palette — light: cool paper / ink navy / cobalt actions; dark: deep navy with an amber accent — flat cards (`--radius` 10), stat strip with hairline dividers, sticky tabs, settings page with a sticky section index, consistent 36 px controls, focus rings, reduced-motion respected; status strip and footer are landmarks (axe-core: zero findings, every tab, both themes, desktop and phone). **Stake** (`stakeUsd`): the practice account trades as the owner's real stake (sizes, loss limits, PDT, dashboard, end-of-day report) | §2, §4.1, §5.4 |
| 2026-10-22 | **Real-money readiness:** protective stops/targets at the broker (OTO leg on swing buys, bracket on day-trade buys; exits cancel legs first; breakeven via replace; bot stop check only where no leg exists); `watchdog.yml` dead-man's switch + end-of-day summary alert + optional heartbeat ping; `liveSizePct` ramp (25 % default) applied to every budget in live mode; go-live checklist computed from real data in Bot settings §7 with a Live size field; *Live vs research* expectancy line on the Performance card; PBKDF2 raised to 600k rounds (bot journal, page sync); §7.3 rewritten as the go-live procedure | §5.2, §5.4, §6, §7.3, §8 |
| 2026-10-22 | Day-trading **research** on all available intraday history (5-min IEX bars since 2016): `bot/research-day.mjs` replays the live rules, parameter grid, verdict; workflow `day-trading-research` (manual + monthly); results card on the Bot trades tab; “Put these values in the form” in §4b; `dayOrMin` setting; rulebook gains an Evidence section | §3.2, §5.4, §8 |
| 2026-10-22 | **Day trading** (experimental, off): `bot/daytrade.mjs` + `dayTradeCycle` in bot.mjs (5-min bars, SPY-VWAP market filter, ORB and VWAP-pullback setups, risk sizing, stop/target/breakeven/time-stop/flat exits, PUTs for shorts, optional CALLs, daily limits, PDT guard); Bot settings §4b; watch card “⚡ Day trading” block (setups, open day trades); Performance split same-day vs swing; rulebook `docs/daytrading-rules.html`; 7 unit tests, 9 order checks | §3.2, §5.2, §5.4, §5.5, §8 |
| 2026-10-22 | Phone header: one control row (Sign in · refresh mode · Refresh), clock and duplicate live dot hidden, tiles and key/value rows wrap so the page never scrolls sideways | §2.5 |
| 2026-10-22 | **Sign in anywhere with the passphrase** (header 👤 Sign in): the GitHub token now travels inside the encrypted sync blob (v2), a new device reads the public blob with the passphrase alone and installs token + data; older v1 blobs are re-saved automatically; **Sign out and wipe this device**; `https://*.github.io` added to CSP connect-src for the artifact copy; CI page test covers A-syncs → B-signs-in → B-signs-out | §2.4, §6, §8 |
| 2026-10-22 | Commodity price strip removed from the Portfolio tab at the owner's request (commodity holdings and the USD/INR tile stay) | §2.2 |
| 2026-10-22 | **Link a phone by QR code** (Bot settings → Sync across devices): the desktop renders a QR (self-hosted `vendor/qrcode.js`, MIT) whose link carries the GitHub token, journal passphrase and price keys in the URL fragment; scanning it installs them on the phone, cleans the address bar, shows a "linked" banner and the first sync pull follows. Same `#setup=` receiver as the price-key setup link, now UTF-8 safe | §2.4, §3.2, §6 |
| 2026-10-22 | Live quotes (FMP, Finnhub REST, Finnhub stream) now also cover the owner's own symbols (portfolio / My tickers), not just the built-in universe; the page merges every row the daily snapshot has that it lacks; common ETFs (GLD, IAU, SLV, USO, UNG, GDX, QQQ, IWM, DIA, TLT, VTI, VOO) added to `symbols.json` | §2.3, §4.2 |
| 2026-10-22 | Portfolio: **commodities** (gold, silver, WTI/Brent crude, natural gas, copper, platinum via Yahoo continuous futures in `symbols.json`; gold in grams / 10 g and silver per kg priced in ₹ from the troy-ounce quote × USD→INR), and an **Everything together** tile showing the whole portfolio in both USD and INR at an owner-set USD→INR rate (`sd-fx`, synced) or the live `USDINR=X` quote | §2.2, §4.2 |
| 2026-10-22 | Fix: the watch list was only built after the entry gates (loss cap, entry window, news pause), so a paused or after-3 PM session published no card. Now built every cycle (every 20 s while gated) with an `idle` reason shown on the card | §5.5 |
| 2026-10-22 | Settings guide `docs/settings.html` (every control, default, range, when to change, common setups), linked from the Bot settings tab; maintenance rule extended: keep it current with every settings change | §3.2, §9 |
| 2026-10-22 | Watch card shows trigger prices: for every watched stock the close that would push RSI-2 under the buy level (`rsi2Trigger`, bisection) and, with puts on, over the put level; for every holding the exit level (average of the last 4 closes = the 5-day-average crossing, `rsi2ExitLevel`), hard floor, and for options take-profit, stop and expiry | §5.2, §5.5, §8 |
| 2026-10-22 | Phone alerts carry prices and profit (`alertDetail`, on by default, switch in Guards): buys show size and limit price, sells show entry, exit and P/L | §5.4 |
| 2026-10-22 | **Fix: Bot settings Save hung forever.** With the Screener sub-view remembered, every redraw of a non-market tab ran the Screener binding and threw (`MK[tab].stocks`), which aborted the save before it reached GitHub. Binding now limited to the market tabs. Added a page error strip (bottom of the page, with line number), save made independent of redraw errors, and `tools/page-test.mjs` in CI to catch this class of bug | §2.2, §8 |
| 2026-10-22 | Bot settings: live-price redraws no longer touch the settings tab; step log under the Save bar; after a failed save, a **Copy settings** → paste on github.com fallback that needs no API access | §2.2 |
| 2026-10-22 | Bot settings page: 12 s limit on every GitHub call with a live seconds counter, plain-language diagnosis of failures (network block / expired token / missing permission / rate limit), **Test connection** button (latency, token expiry, calls left), save uses the known file version and re-reads only on conflict, settings load in parallel and only on first visit (no background refresh clobbering edits), typed edits no longer redraw the form (cursor and scroll stay), “unsaved changes” marker | §2.2, §4.1 |
| 2026-10-22 | **Market scan** universe option: the bot ranks every tradable US stock by trading volume each morning and watches the top N (default 200) instead of a fixed list; per-symbol news checks and the price stream narrow to candidates + held names in scan mode; Settings §6 radio; watch card shows the scan | §3.2, §5.2, §5.4, §8 |
| 2026-10-22 | Industry-standards pass: CSP with hashed inline scripts (`tools/stamp.mjs`), referrer/description/color-scheme meta, http(s)-only feed links, no inline event handlers; broker HTTP timeout + retry/backoff (never for orders), graceful SIGTERM shutdown; accessibility fixes (landmarks, tablist roles, labels, AA contrast in both themes); `package.json` scripts, `.nvmrc`, ESLint, Dependabot, CI runs stamp check + lint + both test files | §3.2, §6, §8, §9 |
| 2026-10-22 | **Intraday signals** option (off by default): same RSI-2 rules evaluated on the live price during the day; order test proves a stock that only dips intraday is bought with it on and ignored with it off | §5.2, §5.4 |
| 2026-10-22 | Bot trades tab: **What the bot is watching** card — the journal now carries a `watch` block (every watched stock's price, RSI-2, above/below 200-day, and who qualifies for stock buy / CALL / PUT); end-to-end test covers it | §5.5, §8 |
| 2026-10-22 | Capital allocation settings: each of stocks, CALLs and PUTs sized in % of account or fixed dollars, with a per-trade amount and an optional total ceiling per sleeve | §5.4 |
| 2026-10-22 | PUT options added as an experiment, OFF by default (**Trade PUT options** switch): RSI-2 mirror rule, shared option caps, put exits; short-side strategy added to the research workflow; end-to-end order test with a fake broker (runs in CI) | §3.2, §5.2, §5.4, §8 |
| 2026-10-22 | War keywords tightened: bare "missile", "troops" and "nuclear" no longer pause trading (defense contracts, power plants); conflict phrases such as "missile strike", "airstrikes", "nuclear weapon" still do | §5.2 |
| 2026-10-22 | Settings save: 25-second limit on GitHub calls (no more endless "Saving…") and automatic retry when another commit lands at the same moment | §4.1 |
| 2026-10-22 | News guard reads headlines only (not story summaries) for the market-wide pause and the page's tags, so a bank-loan story that mentions "the war" no longer stops trading for 30 minutes | §5.2 |
| 2026-10-22 | Passphrase diagnostics: failed unlock and the reveal box both show a character count (and flag odd characters / stray spaces) so a phone and a PC can be compared without exposing the passphrase | §4.1 |
| 2026-10-22 | Bot settings: "Show / copy the passphrase saved on this device" so a working passphrase can be pasted onto a phone instead of retyped | §4.1 |
| 2026-10-22 | Phone unlock fix: passphrase boxes stop auto-capitalising/auto-correcting; journal unlock also tries the trimmed / capitalisation / Unicode variants a phone keyboard can introduce; "Show what I type" option | §4.1 |
| 2026-10-22 | Branding: Signal Desk logo, browser-tab icon and installable app icons (home-screen install on phone and desktop); web app manifest | §3.2 |
| 2026-10-22 | News guard: whole-word keyword matching ("Stewart"/"Software" no longer read as war), single-name events skip only that ticker, everyday idioms ("war chest", "bidding war") ignored; page and bot use the same rule | §5.2 |
| 2026-10-22 | Sync fix: exclude derived per-render keys, 1-minute minimum gap, skip when unchanged (was committing every ~20 s during market hours) | §2.4 |
| 2026-10-22 | Moved to `harimula/signal-desk`; page fallback repo and docs re-pointed | §3.1.1 |
| 2026-10-22 | Portability: repo name derived from the Pages URL (page) and `GITHUB_REPOSITORY` (bot); MIGRATION.md added | §3.1.1 |
| 2026-10-22 | Device sync: settings, quote keys, watchlist, portfolios and calculator inputs roam between devices through an encrypted file in the repo; Rent vs EMI inputs now persist | §2.4, §4.1, §4.2, §6 |
| 2026-10-21 | Documentation set created: ARCHITECTURE.md, docs/index.html, architecture.pptx; docs link on the page | all |
| 2026-10-21 | Mobile layout: full-width tables, symbol-only column, compact header; arrows hidden on touch screens | §2.4 |
| 2026-10-21 | Security round: separate live keys, encrypted journal + redacted logs, PDT guard, SRI-pinned scripts, pinned Actions, SECURITY.md, FAMILY.md | §6 |
| 2026-10-21 | Real-time engine: trade-updates + market-data websockets, event-driven cycles, 2 s/1 s beat, polling fallback; stream indicator on Bot tab | §5.3 |
| 2026-10-21 | Bot settings control panel (config.json hot-reload, sealed secrets, pause/resume/run) | §2.2, §5.4 |
| 2026-10-21 | Strategy switched to RSI-2 after 4-strategy research; idempotent orders; 29 tests + CI | §5.1, §8 |
| 2026-10-21 | Risk engine, regime filter, pro backtest, alerts | §5.2 |
| 2026-10-21 | News tab, per-portfolio news, news/event guard, events calendar | §2.2 |
| 2026-10-21 | Bot trades tab; options (CALL/PUT) + stock trades; early take-profit; every-second monitoring | §2.2, §5 |
| 2026-10-21 | Paper-trading bot + 40-year backtest workflow | §3, §5 |
| 2026-10-21 | Day trading order tickets, P/L drill-down per stock per day; Option trading tab | §2.2 |
| 2026-10-21 | Flicker-free live prices (DOM morphing), scroll preservation, theme toggle, self-update | §2.3, §4.1 |
| 2026-10-21 | App switcher: Signal Desk / Retirement / Rent vs EMI (with SIP plan) | §2.1 |

---

## 10. Glossary

| Term | Meaning |
|---|---|
| **RSI-2** | 2-period Relative Strength Index; below 10 marks a sharp short-term dip |
| **SMA** | Simple moving average (e.g. 200-day) |
| **OOS** | Out-of-sample: years held back from strategy selection, used only to judge |
| **CAGR / Sharpe / max DD** | Yearly growth rate / return per unit of volatility / worst peak-to-trough loss |
| **Heat** | Total % of equity at risk across all open positions and pending orders |
| **Regime** | Market state (e.g. SPY above/below its 200-day) used to allow or block entries |
| **PDT** | Pattern Day Trader rule: under $25 000, max 3 same-day round trips in 5 business days |
| **DTE** | Days to expiry of an option |
| **Paper trading** | Simulated account with fake money and real prices |
| **Sealed box** | Public-key encryption (libsodium) used to store secrets in GitHub without the browser ever being able to read them back |
| **Telegram bot** | Your private bot (made with @BotFather) that delivers alerts and answers commands |
