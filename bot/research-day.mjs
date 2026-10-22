// Day-trading research: replays the EXACT rules the live engine runs (bot/daytrade.mjs) over every 5-minute bar the
// broker's data feed has (IEX, 2016 onward) for the bot's universe, then searches the sensible parameter range.
//   ALPACA_KEY=… ALPACA_SECRET=… node bot/research-day.mjs
// Why not 30–40 years: intraday price history that old does not exist in any public feed; the swing rule (RSI-2)
// is tested on 33–40 years of daily closes separately. Ten years of 5-minute bars is the honest maximum here.
//
// Honesty rules of this test: entry at the close of the signal bar plus slippage; the stop is assumed hit before the
// target whenever one 5-minute bar touches both; flat at the 15:45 bar's close; one trade per stock per day, at most
// N per day across stocks, and the two-losses-in-a-row stop, all applied in time order like the bot does.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { daySetup, dayExit, dayTrail, runningVwap, SESSION_OPEN } from './daytrade.mjs';
import { DEFAULT_SYMBOLS, DEFAULTS } from './config.mjs';

const KEY = process.env.ALPACA_KEY, SECRET = process.env.ALPACA_SECRET;
const DATA = 'https://data.alpaca.markets', H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET };
const SYMS = (process.env.BT_DAY_SYMBOLS || DEFAULT_SYMBOLS.join(',')).split(',').map(s => s.trim()).filter(Boolean);
const START = process.env.BT_DAY_START || '2016-01-01', END = new Date().toISOString().slice(0, 10);
const SLIP = +(process.env.BT_DAY_SLIP || 0.0003);          // 0.03 % per side: a large-cap spread plus a tick of slippage
const RISK_USD = 500;                                        // 0.5 % of a $100k account, for the dollar columns
const r2 = x => Math.round(x * 100) / 100, r3 = x => Math.round(x * 1000) / 1000;

// ---- data ----
const etOffsetCache = new Map();
const etMins = iso => {                                     // minutes past midnight in New York, one Intl call per UTC day
  const day = iso.slice(0, 10);
  let off = etOffsetCache.get(day);
  if (off == null) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(day + 'T16:00:00Z')).map(x => [x.type, x.value]));
    off = ((+p.hour % 24) * 60 + +p.minute) - 16 * 60;    // ET minutes minus UTC minutes at 16:00Z
    etOffsetCache.set(day, off);
  }
  const m = ((+iso.slice(11, 13)) * 60 + +iso.slice(14, 16) + off + 1440) % 1440;
  return m;
};
async function get(path) {
  for (let a = 0; a < 6; a++) {
    const r = await fetch(DATA + path, { headers: H });
    if (r.status === 429 || r.status >= 500) { await new Promise(z => setTimeout(z, 1500 * (a + 1))); continue; }
    if (!r.ok) throw new Error(path.split('?')[0] + ' HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
    return r.json();
  }
  throw new Error('gave up on ' + path.split('?')[0]);
}
async function pull5m(sym) {
  // sessions: date -> bars [{m,o,h,l,c,v}] (regular hours only)
  const sessions = new Map();
  for (let y = +START.slice(0, 4); y <= +END.slice(0, 4); y++) {
    const s = y === +START.slice(0, 4) ? START : `${y}-01-01`, e = y === +END.slice(0, 4) ? END : `${y}-12-31`;
    let token = '';
    for (let k = 0; k < 40; k++) {
      const j = await get(`/v2/stocks/bars?symbols=${sym}&timeframe=5Min&start=${s}T00:00:00Z&end=${e}T23:59:59Z&limit=10000&adjustment=split&feed=iex&sort=asc${token ? '&page_token=' + token : ''}`);
      for (const b of (j.bars && j.bars[sym]) || []) {
        const m = etMins(b.t); if (m < SESSION_OPEN || m >= 960) continue;
        // the session date is the ET date: bars after 20:00Z can still be the same ET day
        const et = new Date(Date.parse(b.t) + (etOffsetCache.get(b.t.slice(0, 10)) || 0) * 60000).toISOString().slice(0, 10);
        if (!sessions.has(et)) sessions.set(et, []);
        sessions.get(et).push({ m, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 });
      }
      token = j.next_page_token; if (!token) break;
    }
  }
  return sessions;
}

// ---- signals: everything the live daySetup would have said at each bar close, recorded once per (orMin, side) ----
export function collectSignals(sym, sessions, spySessions) {
  const dates = [...sessions.keys()].sort(), out = [], volHist = [];
  for (const d of dates) {
    const bars = sessions.get(d); bars.sort((a, b) => a.m - b.m);
    const avgVol = volHist.length >= 5 ? volHist.slice(-10).reduce((a, b) => a + b, 0) / Math.min(10, volHist.length) : 0;
    const spy = spySessions.get(d) || [], spyRv = runningVwap(spy), spyIdx = new Map(spy.map((b, i) => [b.m, i]));
    for (let i = 3; i < bars.length; i++) {
      const now = bars[i].m + 5;                         // decisions happen when the bar closes
      if (now < 585 || now >= 955) continue;
      const si = spyIdx.get(bars[i].m), market = si == null ? 'flat' : (spy[si].c / spyRv[si] - 1 > 0.0005 ? 'up' : spy[si].c / spyRv[si] - 1 < -0.0005 ? 'down' : 'flat');
      const slice = bars.slice(0, i + 1), px = bars[i].c;
      for (const orMin of [15, 30]) for (const side of ['long', 'short']) {
        const sg = daySetup({ bars: slice, px, mins: now, avgDailyVol: avgVol, market: side === 'long' ? 'up' : 'down', cfg: { rvol: 0, start: 575, end: 960, orMin, target: 2 } });
        if (sg) out.push({ sym, d, i, m: now, orMin, side, setup: sg.setup, entry: sg.entry, stop: sg.stop, r: sg.r, rv: sg.rvol == null ? 1 : sg.rvol, mkt: market, avgVol });
      }
    }
    volHist.push(bars.reduce((t, b) => t + b.v, 0));
  }
  return out;
}

// ---- one trade's outcome under a given exit policy ----
export function playTrade(sig, bars, P) {
  const long = sig.side === 'long', slip = long ? 1 + SLIP : 1 - SLIP;
  const entryFill = sig.entry * slip, risk = Math.abs(sig.entry - sig.stop);
  const target = long ? sig.entry + P.target * risk : sig.entry - P.target * risk;
  const pos = { side: sig.side, entry: sig.entry, stop: sig.stop, target, openedMins: sig.m };
  let exitPx = null, how = '', exitM = null;
  for (let j = sig.i + 1; j < bars.length; j++) {
    const b = bars[j], mClose = b.m + 5;
    // intra-bar: stop first (conservative), then target
    if (long ? b.l <= pos.stop : b.h >= pos.stop) { exitPx = pos.stop; how = pos.stop === sig.entry ? 'breakeven' : 'stop'; exitM = mClose; break; }
    if (long ? b.h >= target : b.l <= target) { exitPx = target; how = 'target'; exitM = mClose; break; }
    const tr = dayTrail({ pos, px: b.c }); if (tr) pos.stop = tr.stop;
    const x = dayExit({ pos, px: b.c, mins: mClose, cfg: { flat: 950, timeStop: P.timeStop, timeStopR: 0.3 } });
    if (x) { exitPx = b.c; how = x.kind; exitM = mClose; break; }
  }
  if (exitPx == null) { const b = bars[bars.length - 1]; exitPx = b.c; how = 'flat'; exitM = b.m + 5; }
  const exitFill = exitPx * (long ? 1 - SLIP : 1 + SLIP);
  const pnl = long ? exitFill - entryFill : entryFill - exitFill;
  return { R: pnl / risk, how, exitM };
}

// ---- evaluate one parameter set over all recorded signals, with the bot's daily discipline ----
export function evaluate(signals, sessionsBySym, P) {
  const bySymDay = new Map();
  for (const s of signals) {
    if (s.orMin !== P.orMin) continue;
    if (P.setups !== 'both' && s.setup !== P.setups) continue;
    if (P.sides !== 'both' && s.side !== P.sides) continue;
    if (s.rv < P.rvol) continue;
    if (s.m < P.start || s.m >= P.end) continue;
    if (P.filter && s.mkt !== (s.side === 'long' ? 'up' : 'down')) continue;
    const k = s.sym + '|' + s.d;
    if (!bySymDay.has(k) || bySymDay.get(k).m > s.m) bySymDay.set(k, s);   // first qualifying signal of the day per stock
  }
  const byDay = new Map();
  for (const s of bySymDay.values()) { if (!byDay.has(s.d)) byDay.set(s.d, []); byDay.get(s.d).push(s); }
  const trades = [];
  for (const [d, list] of byDay) {
    list.sort((a, b) => a.m - b.m);
    const done = [];                                                  // trades closed so far today, in exit order
    let taken = 0;
    for (const s of list) {
      if (taken >= P.maxTrades) break;
      const closedBefore = done.filter(t => t.exitM <= s.m).sort((a, b) => a.exitM - b.exitM);
      let streak = 0; for (let i = closedBefore.length - 1; i >= 0; i--) { if (closedBefore[i].R < 0) streak++; else break; }
      if (streak >= P.streak) break;
      const t = playTrade(s, sessionsBySym.get(s.sym).get(d), P);
      done.push(t); taken++;
      trades.push({ d, sym: s.sym, side: s.side, setup: s.setup, m: s.m, R: t.R, how: t.how });
    }
  }
  return stats(trades);
}
export function stats(trades) {
  const n = trades.length; if (!n) return { n: 0 };
  const R = trades.map(t => t.R), wins = R.filter(x => x > 0), losses = R.filter(x => x <= 0);
  const sum = a => a.reduce((x, y) => x + y, 0);
  let eq = 0, pk = 0, dd = 0; for (const x of R) { eq += x; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const years = {};
  for (const t of trades) { const y = t.d.slice(0, 4); years[y] = years[y] || { n: 0, R: 0, w: 0 }; years[y].n++; years[y].R += t.R; if (t.R > 0) years[y].w++; }
  for (const y of Object.keys(years)) { years[y].R = r2(years[y].R); years[y].win = Math.round(years[y].w / years[y].n * 100); delete years[y].w; }
  const by = (key) => { const g = {}; for (const t of trades) { const k = t[key]; g[k] = g[k] || { n: 0, R: 0 }; g[k].n++; g[k].R += t.R; } for (const k of Object.keys(g)) { g[k].avgR = r3(g[k].R / g[k].n); g[k].R = r2(g[k].R); } return g; };
  const posYears = Object.values(years).filter(y => y.R > 0).length;
  return { n, winRate: Math.round(wins.length / n * 100), avgR: r3(sum(R) / n), totalR: r2(sum(R)), expectancyUsd: Math.round(sum(R) / n * RISK_USD),
    profitFactor: losses.length ? r2(sum(wins) / Math.abs(sum(losses))) : null, maxDrawdownR: r2(dd), avgWinR: wins.length ? r3(sum(wins) / wins.length) : null, avgLossR: losses.length ? r3(sum(losses) / losses.length) : null,
    years, posYears, totalYears: Object.keys(years).length, bySide: by('side'), bySetup: by('setup'), byExit: by('how'), perYear: r2(n / Math.max(1, Object.keys(years).length)) };
}

// ---- main ----
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
if (!KEY || !SECRET) { console.log('Alpaca keys are needed for intraday history (paper keys work).'); process.exit(0); }
const t0 = Date.now();
console.log(`day-trading research: ${SYMS.length} stocks + SPY, 5-minute bars ${START} → ${END}`);
const spySessions = await pull5m('SPY');
console.log(`SPY: ${spySessions.size} sessions`);
const sessionsBySym = new Map(); let signals = [], barCount = 0;
for (const sym of SYMS) {
  try {
    const s = await pull5m(sym); sessionsBySym.set(sym, s);
    for (const b of s.values()) barCount += b.length;
    const sg = collectSignals(sym, s, spySessions); signals = signals.concat(sg);
    console.log(`${sym}: ${s.size} sessions, ${sg.length} raw signals`);
  } catch (e) { console.log(`${sym}: skipped (${e.message})`); }
}
console.log(`${barCount.toLocaleString()} bars, ${signals.length.toLocaleString()} raw signals in ${Math.round((Date.now() - t0) / 1000)} s`);

const DEF = { orMin: 15, rvol: DEFAULTS.dayRvol, target: DEFAULTS.dayTarget, timeStop: DEFAULTS.dayTimeStop, start: 585, end: 930, maxTrades: DEFAULTS.dayMaxTrades, streak: DEFAULTS.dayStreak, filter: true, setups: 'both', sides: 'both' };
const grid = [];
for (const orMin of [15, 30]) for (const rvol of [1.0, 1.2, 1.5, 2.0]) for (const target of [1.5, 2, 3]) for (const timeStop of [45, 60, 90])
  for (const end of [690, 930]) for (const filter of [true, false]) grid.push({ ...DEF, orMin, rvol, target, timeStop, end, filter });
const results = grid.map(P => ({ P, S: evaluate(signals, sessionsBySym, P) })).filter(x => x.S.n > 0);
// robustness: average R per trade, weighted by how many trades support it, and demanding most years positive
const score = x => x.S.n < 300 ? -1e9 : x.S.avgR * Math.sqrt(x.S.n) * (x.S.posYears / Math.max(1, x.S.totalYears) >= 0.6 ? 1 : 0.5);
results.sort((a, b) => score(b) - score(a));
const best = results[0], def = { P: DEF, S: evaluate(signals, sessionsBySym, DEF) };
const variants = {
  'ORB only': evaluate(signals, sessionsBySym, { ...best.P, setups: 'ORB' }), 'VWAP pullback only': evaluate(signals, sessionsBySym, { ...best.P, setups: 'VWAP' }),
  'Longs only (shares / CALLs)': evaluate(signals, sessionsBySym, { ...best.P, sides: 'long' }), 'Shorts only (PUT proxy: stock short)': evaluate(signals, sessionsBySym, { ...best.P, sides: 'short' }),
  'Without the market filter': evaluate(signals, sessionsBySym, { ...best.P, filter: false }), 'Morning only (entries until 11:30)': evaluate(signals, sessionsBySym, { ...best.P, end: 690 }),
};
const verdict = best.S.n >= 300 && best.S.avgR > 0.05 && best.S.profitFactor > 1.1 && best.S.posYears / best.S.totalYears >= 0.6
  ? 'edge' : best.S.n >= 300 && best.S.avgR > 0 ? 'marginal' : 'none';
const out = { at: new Date().toISOString(), start: START, end: END, symbols: SYMS, bars: barCount, rawSignals: signals.length, slippagePerSide: SLIP, riskUsd: RISK_USD,
  verdict, default: def, best, top: results.slice(0, 12), variants,
  note: 'Entry at the close of the signal bar + slippage; stop assumed hit before target inside a bar; flat at the 15:45 bar close; 1 trade per stock per day, max per day and 2-loss streak applied in time order. Shorts are simulated as stock shorts (a proxy for PUTs: no option spread or time decay included). IEX volume is a slice of the market but consistent across the test.' };
fs.writeFileSync('bot/research-day.json', JSON.stringify(out));
const fmtP = P => `OR ${P.orMin} min · rel. vol ≥ ${P.rvol}× · target ${P.target}R · time stop ${P.timeStop} min · entries until ${Math.floor(P.end / 60)}:${String(P.end % 60).padStart(2, '0')} · market filter ${P.filter ? 'on' : 'off'}`;
const row = (name, S) => `| ${name} | ${S.n} | ${S.winRate}% | ${S.avgR} | $${S.expectancyUsd} | ${S.profitFactor ?? '–'} | ${S.maxDrawdownR} | ${S.posYears}/${S.totalYears} |`;
let md = `# Day-trading research — ${START} → ${END}\n\n${SYMS.length} stocks + SPY, ${barCount.toLocaleString()} five-minute bars, ${signals.length.toLocaleString()} raw signals. ${out.note}\n\n**Verdict: ${verdict === 'edge' ? 'the rules show an edge on this data' : verdict === 'marginal' ? 'marginal — positive but thin' : 'no edge found'}.**\n\n| Settings | Trades | Win | Avg R | Per trade ($500 risk) | Profit factor | Worst drawdown (R) | Years positive |\n|---|---|---|---|---|---|---|---|\n${row('Bot defaults: ' + fmtP(DEF), def.S)}\n${row('Best found: ' + fmtP(best.P), best.S)}\n\n## Variants of the best\n\n| Variant | Trades | Win | Avg R | Per trade | Profit factor | Worst drawdown (R) | Years positive |\n|---|---|---|---|---|---|---|---|\n${Object.entries(variants).filter(([, S]) => S.n).map(([k, S]) => row(k, S)).join('\n')}\n\n## Best settings, year by year\n\n| Year | Trades | Win | Total R |\n|---|---|---|---|\n${Object.entries(best.S.years).map(([y, v]) => `| ${y} | ${v.n} | ${v.win}% | ${v.R} |`).join('\n')}\n\n## Top 12 parameter sets\n\n| Settings | Trades | Win | Avg R | Per trade | Profit factor | Worst drawdown (R) | Years positive |\n|---|---|---|---|---|---|---|---|\n${results.slice(0, 12).map(x => row(fmtP(x.P), x.S)).join('\n')}\n`;
fs.writeFileSync('bot/research_day_report.md', md);
console.log(md.split('\n').slice(0, 12).join('\n'));
console.log(`done in ${Math.round((Date.now() - t0) / 1000)} s`);
}
