import { SPY_DEFAULTS } from './spyopt.mjs';
import { WHEEL_DEFAULTS } from './wheel.mjs';
// Bot configuration: presets, defaults, validation. The front-end Settings tab writes bot/config.json;
// the bot re-reads it every minute. Secrets (API keys) are NEVER in this file.
export const PRESETS = {
  conservative: { riskPct: 0.25, optRiskPct: 0.25, maxHeat: 1.5, perSector: 1, maxPositions: 4, maxOptions: 1, dayCap: 2, weekCap: 4, streak: 2, stockPct: 8, optPct: 1 },
  balanced:     { riskPct: 0.5,  optRiskPct: 0.5,  maxHeat: 3,   perSector: 2, maxPositions: 6, maxOptions: 4, dayCap: 3, weekCap: 6, streak: 3, stockPct: 10, optPct: 2 },
  aggressive:   { riskPct: 1,    optRiskPct: 1,    maxHeat: 6,   perSector: 3, maxPositions: 8, maxOptions: 6, dayCap: 5, weekCap: 10, streak: 4, stockPct: 12, optPct: 3 },
};
export const DEFAULT_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA', 'AMD', 'JPM', 'BAC', 'XOM', 'CVX', 'KO', 'PEP', 'WMT', 'HD', 'DIS', 'INTC', 'CSCO', 'QCOM', 'ORCL', 'CRM', 'ADBE', 'NFLX', 'UBER', 'PLTR', 'SHOP', 'COIN', 'SOFI', 'F'];
export const DEFAULTS = {
  version: 1, mode: 'paper', preset: 'balanced', ...PRESETS.balanced,
  stocks: true, options: true, puts: false, intraday: false,   // puts: experimental mirror of the dip rule, OFF until ticked
  rsiThreshold: 10, maxHold: 10, entryEnd: '11:00', optTakeProfit: 50, optStop: 50, holdFloor: 25, stockTp: 10, staleMin: 45,   // stockTp: sell a stock at this % gain (0 = off: RSI-2 exit only); 10 = research-backed default
  // When a stock is sold (besides the take-profit and the stop): 'bounce' = at the close once above its 5-day average (the 33-year
  // research rule); 'profit' = at the first close at least exitProfitPct % above the buy price (win-rate study 2026-10-27).
  // marketFilter: no new dip buys (stocks and CALLs) while SPY closed below its 200-day average.
  exitRule: 'bounce', exitProfitPct: 0.5, marketFilter: false,
  // Swing CALLs and PUTs: optExit 'bounce' = also sold when the stock closes back over (PUT: under) its 5-day average; 'target' = sold
  // only at the take-profit, the stop, the max hold or 3 days before expiry. optDays = the shortest time to expiry a new one may
  // have (the nearest expiry from optDays to optDays + 21 days out is bought; 14 = the original 14–35-day window).
  optExit: 'bounce', optDays: 14,
  newsGuard: true, eventGuard: true, alerts: true, alertDetail: true, alertOnFill: false,
  symbols: DEFAULT_SYMBOLS,
  universe: 'list', scanSize: 200, scanMinPrice: 5,
  pickBy: 'leaders',   // which dips to buy first when there are more than slots: 'leaders' = strongest 3-month return vs the market; 'dip' = deepest dip
  // Day trading (experimental, OFF): rules in docs/daytrading-rules.html. Longs as shares (or CALLs), shorts as PUTs.
  dayTrade: false, dayStock: true, dayCalls: false, dayPuts: true,
  dayOrMin: 15, dayMaxTrades: 3, dayStreak: 2, dayRiskPct: 0.5, dayTarget: 2, dayRvol: 1.2, dayTimeStop: 60, dayOptTp: 50, dayOptStop: 40, dayOptDteMax: 7,
  dayStart: '09:45', dayEnd: '15:30',
  liveSizePct: 25,
  stakeUsd: 0,                           // treat the account as if it held only this much (0 = the whole account): sizing, loss limits and the PDT rule all use it                       // real-money mode starts at a quarter of the paper size; raise it month by month   // 'scan' = build the list daily from every tradable US stock, ranked by volume
  // Money per trade and a total ceiling for each sleeve (stock / CALL / PUT). Each sleeve uses either % of the account or
  // a fixed dollar amount, whichever its Unit says. A cap of 0 means no ceiling beyond the position-count limits.
  stockUnit: 'pct', callUnit: 'pct', putUnit: 'pct',
  // Money split: stocks, CALLs and PUTs each get their own share of the stake (stocks = 100 − CALLs − PUTs) and their own daily
  // loss limit (dayCap is then a % of the stock money, optDayCap a % of the CALL money and of the PUT money); off = one shared pool.
  split: true, callSharePct: 30, putSharePct: 10, optDayCap: 10,
  // SPY quick options sleeve (bot/spyopt.mjs): its own share of the stake, off the top of the stock share; experimental, not backtested
  ...SPY_DEFAULTS,
  // The wheel (bot/wheel.mjs): cash-secured puts and covered calls on their own share of the stake, off the top of the stock
  // share like SPY; OFF until switched on. Tested on real option prices since February 2024 (tools/wheel-study.mjs).
  ...WHEEL_DEFAULTS,
  putPct: 1, stockUsd: 10000, callUsd: 2000, putUsd: 1000,
  stockCapPct: 0, callCapPct: 0, putCapPct: 0, stockCapUsd: 0, callCapUsd: 0, putCapUsd: 0,
};
// [min, max] for every numeric field — anything outside is clamped, anything unknown is dropped.
export const RANGES = {
  riskPct: [0.05, 3], optRiskPct: [0.05, 3], maxHeat: [0.5, 15], perSector: [1, 10], maxPositions: [1, 20], maxOptions: [0, 10],
  dayCap: [0.5, 20], weekCap: [1, 30], streak: [1, 10], stockPct: [1, 30], optPct: [0.5, 10],
  putPct: [0.5, 10], stockUsd: [0, 1e7], callUsd: [0, 1e7], putUsd: [0, 1e7],
  callSharePct: [0, 100], putSharePct: [0, 100], optDayCap: [1, 50], spySharePct: [0, 50], spyTradePct: [10, 100], spyTp: [5, 100], spyStop: [5, 60], spyHoldMin: [2, 120], spyMaxTrades: [1, 20], spyMaxOpen: [1, 5], spyStreak: [1, 6], spyDayCap: [5, 100], spyDte: [0, 5], wheelSharePct: [0, 50], wheelOtmPct: [0, 20], wheelTp: [0, 90], wheelStop: [0, 10], wheelMinPrice: [1, 1000], wheelMaxPrice: [5, 2000], wheelMaxPositions: [1, 10], stockCapPct: [0, 100], callCapPct: [0, 100], putCapPct: [0, 100], stockCapUsd: [0, 1e7], callCapUsd: [0, 1e7], putCapUsd: [0, 1e7],
  scanSize: [50, 400], scanMinPrice: [1, 500],
  liveSizePct: [5, 100], stakeUsd: [0, 1e8], dayOrMin: [5, 60], dayMaxTrades: [1, 10], dayStreak: [1, 5], dayRiskPct: [0.1, 2], dayTarget: [1, 4], dayRvol: [0.5, 3], dayTimeStop: [15, 180], dayOptTp: [10, 200], dayOptStop: [20, 80], dayOptDteMax: [1, 14],
  rsiThreshold: [2, 30], maxHold: [1, 30], exitProfitPct: [0.1, 5], optDays: [7, 60], optTakeProfit: [5, 300], optStop: [5, 90], holdFloor: [2, 60], stockTp: [0, 100], staleMin: [5, 240],
};
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
export function normalize(raw) {
  const c = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return c;
  if (raw.preset && PRESETS[raw.preset]) { c.preset = raw.preset; Object.assign(c, PRESETS[raw.preset]); }
  else if (raw.preset === 'custom') c.preset = 'custom';
  for (const k of Object.keys(RANGES)) if (raw[k] != null && isFinite(+raw[k]) && (c.preset === 'custom' || !(k in PRESETS.balanced))) c[k] = clamp(+raw[k], RANGES[k]);
  for (const k of ['spyOn', 'spyFastFill', 'wheelOn', 'wheelTrend', 'wheelAnytime', 'split', 'stocks', 'options', 'puts', 'intraday', 'newsGuard', 'eventGuard', 'alerts', 'alertDetail', 'alertOnFill', 'dayTrade', 'dayStock', 'dayCalls', 'dayPuts', 'marketFilter']) if (typeof raw[k] === 'boolean') c[k] = raw[k];
  if (raw.exitRule === 'bounce' || raw.exitRule === 'profit') c.exitRule = raw.exitRule;
  if (raw.optExit === 'bounce' || raw.optExit === 'target') c.optExit = raw.optExit;
  if (raw.universe === 'scan' || raw.universe === 'list') c.universe = raw.universe;
  if (raw.pickBy === 'leaders' || raw.pickBy === 'dip') c.pickBy = raw.pickBy;
  for (const k of ['stockUnit', 'callUnit', 'putUnit']) if (raw[k] === 'pct' || raw[k] === 'usd') c[k] = raw[k];
  if (!c.spyOn) c.spySharePct = Math.min(c.spySharePct, 100);
  const spyShare = c.spyOn ? c.spySharePct : 0;                                                      // the shares can never add up to more than the stake
  if (c.callSharePct + c.putSharePct + spyShare > 100) c.spySharePct = Math.max(0, 100 - c.callSharePct - c.putSharePct);
  if (c.callSharePct + c.putSharePct > 100) c.putSharePct = 100 - c.callSharePct;
  const spyNow = c.spyOn ? c.spySharePct : 0;                                                        // the wheel gives way last
  if (c.wheelOn && c.callSharePct + c.putSharePct + spyNow + c.wheelSharePct > 100) c.wheelSharePct = Math.max(0, 100 - c.callSharePct - c.putSharePct - spyNow);
  if (c.wheelStop > 0 && c.wheelStop < 1.5) c.wheelStop = 1.5;                                        // a stop under 1.5× the premium would fire on the spread
  if (c.wheelMinPrice > c.wheelMaxPrice) c.wheelMaxPrice = c.wheelMinPrice;
  c.mode = raw.mode === 'live' && raw.liveConfirm === 'I UNDERSTAND THE RISK' ? 'live' : 'paper';
  const tm = v => /^\d{1,2}:\d{2}$/.test(v || '') ? v.split(':').map(Number).reduce((h, m) => h * 60 + m) : null;
  if (tm(raw.dayStart) != null && tm(raw.dayStart) >= 575 && tm(raw.dayStart) <= 720) c.dayStart = raw.dayStart;      // 9:35–12:00
  if (tm(raw.dayEnd) != null && tm(raw.dayEnd) >= 600 && tm(raw.dayEnd) <= 945) c.dayEnd = raw.dayEnd;               // 10:00–15:45
  if (tm(raw.spyStart) != null && tm(raw.spyStart) >= 575 && tm(raw.spyStart) <= 720) c.spyStart = raw.spyStart;   // 9:35–12:00
  if (tm(raw.spyEnd) != null && tm(raw.spyEnd) >= 600 && tm(raw.spyEnd) <= 930) c.spyEnd = raw.spyEnd;               // 10:00–15:30
  if (/^\d{1,2}:\d{2}$/.test(raw.entryEnd || '')) { const [h, m] = raw.entryEnd.split(':').map(Number); if (h * 60 + m >= 600 && h * 60 + m <= 945) c.entryEnd = raw.entryEnd; }   // 10:00–15:45 ET (was capped at 15:00, which silently turned a 15:30 setting into the 11:00 default)
  if (Array.isArray(raw.symbols)) { const s = [...new Set(raw.symbols.map(x => String(x).trim().toUpperCase()).filter(x => /^[A-Z.]{1,6}$/.test(x)))]; if (s.length) c.symbols = s.slice(0, 60); }
  if (raw.updatedAt) c.updatedAt = raw.updatedAt;
  return c;
}
export const entryEndMin = c => { const [h, m] = c.entryEnd.split(':').map(Number); return h * 60 + m; };
const money = (c, unit, pct, usd) => c[unit] === 'usd' ? '$' + c[usd] : c[pct] + '%';
export const summary = c => `${c.preset}${c.dayTrade ? ' · DAY-TRADING ON' : ''}${c.mode === 'live' ? ' · LIVE at ' + c.liveSizePct + '% size' : ''}${c.stakeUsd > 0 ? ' · stake $' + c.stakeUsd : ''}${c.split ? ' · split ' + (100 - c.callSharePct - c.putSharePct - (c.spyOn ? c.spySharePct : 0) - (c.wheelOn ? c.wheelSharePct : 0)) + '/' + c.callSharePct + '/' + c.putSharePct + (c.spyOn ? '/' + c.spySharePct : '') + (c.wheelOn ? '/' + c.wheelSharePct : '') + ' stocks/CALLs/PUTs' + (c.spyOn ? '/SPY' : '') + (c.wheelOn ? '/wheel' : '') : ''}${c.wheelOn ? ' · wheel: puts ' + c.wheelOtmPct + '% under, bought back at ' + (c.wheelTp > 0 ? (100 - c.wheelTp) + '% of the premium' : 'expiry') : ''} · ${c.universe === 'scan' ? 'market scan, top ' + c.scanSize : c.symbols.length + ' listed stocks'} · stocks ${c.stocks ? money(c, 'stockUnit', 'stockPct', 'stockUsd') + '/position' : 'off'} · CALLs ${c.options ? money(c, 'callUnit', 'optPct', 'callUsd') + '/trade' : 'off'} · PUTs ${c.puts ? money(c, 'putUnit', 'putPct', 'putUsd') + '/trade' : 'off'} · sells ${c.exitRule === 'profit' ? 'at the first close +' + c.exitProfitPct + '% up' : 'on the bounce'} (max ${c.maxHold} days)${c.marketFilter ? ' · market filter on' : ''} · risk ${c.riskPct}%/trade, cap ${c.maxHeat}% · ${c.mode.toUpperCase()}`;
