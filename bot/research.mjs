// Strategy research: same universe, costs and position sizing; proper portfolio simulator
// (cash + marked-to-market positions, max 6 at once, 10% of equity each). Every strategy is
// judged on out-of-sample years (last 30%) it was never tuned on.
import fs from 'node:fs';
import { signalAt, rsi2, sma } from './strategy.mjs';
import { regimeOf } from './risk.mjs';
import { NIFTY100 as NIFTY100_LIST } from './india.mjs';

// Market: US (default) or IN (NSE). India: Nifty 100 names (today's list — survivorship bias, as for the US), the Nifty 50 index as
// benchmark and regime filter, and 0.15% per side for costs (STT 0.1%, stamp duty, exchange/SEBI fees, GST, DP charge, slippage).
const MKT = (process.env.BT_MARKET || 'US').toUpperCase();
const NIFTY100 = NIFTY100_LIST.map(s => s + '.NS').join(',');                        // one list for the research and the India bot
const BENCH = MKT === 'IN' ? '^NSEI' : 'SPY', BENCH_NAME = MKT === 'IN' ? 'Nifty 50' : 'SPY';
const OUT = MKT === 'IN' ? { json: 'bot/research-in.json', md: 'bot/research_in_report.md' } : { json: 'bot/research.json', md: 'bot/research_report.md' };
const YEARS = +(process.env.BT_YEARS || 40), COST = +(process.env.BT_COST || (MKT === 'IN' ? 0.0015 : 0.0005)), POS0 = 0.10, MAXPOS0 = 6;
let POS = POS0, MAXPOS = MAXPOS0, CAP = 1;   // CAP: the most of the money that may be invested at once (a money-split stock share)                 // sizing: changed only for the 5-year sizing variants below, then restored
const UNIVERSE = (process.env.BT_SYMBOLS || (MKT === 'IN' ? NIFTY100 : null) || 'AAPL,MSFT,KO,JNJ,PG,XOM,CVX,JPM,WMT,MCD,DIS,IBM,GE,CAT,BA,MMM,HD,INTC,ORCL,T,VZ,PFE,MRK,PEP,NKE,AXP,GS,UNH,LOW,TXN,AMD,ADBE,COST,SBUX,CSCO,QCOM,AMGN,GD,LMT').split(',');
async function pull(sym) {
  if (process.env.BT_SOURCE === 'livejson') {
    const lj = JSON.parse(fs.readFileSync('live.json', 'utf8')), row = lj.rows[sym]; if (!row) throw new Error('no row');
    const cl = row[27], flat = row[28], nb = flat.length / 4, tail = cl.slice(-nb), ds = lj.dates.US || [];
    return Array.from({ length: nb }, (_, i) => ({ d: new Date(ds[i] * 1000).toISOString().slice(0, 10), o: flat[i * 4], h: flat[i * 4 + 1], l: flat[i * 4 + 2], c: tail[i] }));
  }
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${YEARS}y&interval=1d`, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const res = (await r.json()).chart.result[0], q = res.indicators.quote[0], out = [];
  res.timestamp.forEach((t, i) => { if (q.close[i] != null && q.high[i] != null && q.low[i] != null) out.push({ d: new Date(t * 1000).toISOString().slice(0, 10), o: q.open[i] ?? q.close[i], h: q.high[i], l: q.low[i], c: q.close[i] }); });
  return out;
}

// ---- strategies: each returns, for symbol bars, a map date -> entry plan (decided at the PREVIOUS close) ----
// kind 'intraday': fill + exit on that same day. kind 'swing': buy, then hold until exitRule says go.
const STRATS = {
  daytrade: { label: 'Current bot rules (intraday pullback, S3 → R1, stop S4)', kind: 'intraday',
    plan(B, C, i) { const s = signalAt(B, C, i); return s && { entry: s.entry, stop: s.stop, target: s.target, rank: s.r2 }; } },
  rsi2: { label: 'RSI-2 mean reversion (Connors): above 200-day, RSI-2 < 10, buy at next open, sell when close > 5-day avg (max 10 days)', kind: 'swing',
    plan(B, C, i) { const s200 = sma(C, 200, i), r = rsi2(C, i); return s200 && r != null && C[i] > s200 && r < 10 ? { rank: r } : null; },
    exit(B, C, j, held) { const s5 = sma(C, 5, j); return (s5 && C[j] > s5) || held >= 10; } },
  rsi2stop: { label: 'RSI-2 mean reversion + 3× range stop', kind: 'swing',
    plan(B, C, i) { const s200 = sma(C, 200, i), r = rsi2(C, i); if (!(s200 && r != null && C[i] > s200 && r < 10)) return null; let rg = 0; for (let k = i - 9; k <= i; k++) rg += B[k].h - B[k].l; return { rank: r, stopDist: 3 * rg / 10 }; },
    exit(B, C, j, held) { const s5 = sma(C, 5, j); return (s5 && C[j] > s5) || held >= 10; } },
  rsi2quick: { label: 'RSI-2 with quick exits (owner\'s choice): same entries; sell at +10% or −5% during the day, otherwise when close > 5-day avg (max 10 days)', kind: 'swing',
    plan(B, C, i) { const s200 = sma(C, 200, i), r = rsi2(C, i); return s200 && r != null && C[i] > s200 && r < 10 ? { rank: r, stopPct: 0.05, tpPct: 0.10 } : null; },
    exit(B, C, j, held) { const s5 = sma(C, 5, j); return (s5 && C[j] > s5) || held >= 10; } },
  rsi2tp: { label: 'RSI-2 with only the +10% take-profit (25% disaster stop)', kind: 'swing',
    plan(B, C, i) { const s200 = sma(C, 200, i), r = rsi2(C, i); return s200 && r != null && C[i] > s200 && r < 10 ? { rank: r, stopPct: 0.25, tpPct: 0.10 } : null; },
    exit(B, C, j, held) { const s5 = sma(C, 5, j); return (s5 && C[j] > s5) || held >= 10; } },
  rsi2sl: { label: 'RSI-2 with only the −5% stop', kind: 'swing',
    plan(B, C, i) { const s200 = sma(C, 200, i), r = rsi2(C, i); return s200 && r != null && C[i] > s200 && r < 10 ? { rank: r, stopPct: 0.05 } : null; },
    exit(B, C, j, held) { const s5 = sma(C, 5, j); return (s5 && C[j] > s5) || held >= 10; } },
  rsi2own: { label: 'RSI-2 with the owner\'s settings: buy below 25, sell at +10% or on the bounce, 25% stop', kind: 'swing',
    plan(B, C, i) { const s200 = sma(C, 200, i), r = rsi2(C, i); return s200 && r != null && C[i] > s200 && r < 25 ? { rank: r, stopPct: 0.25, tpPct: 0.10 } : null; },
    exit(B, C, j, held) { const s5 = sma(C, 5, j); return (s5 && C[j] > s5) || held >= 10; } },
  rsi2tp10: { label: 'RSI-2 (buy below 10) with +10% take-profit, 25% stop', kind: 'swing',
    plan(B, C, i) { const s200 = sma(C, 200, i), r = rsi2(C, i); return s200 && r != null && C[i] > s200 && r < 10 ? { rank: r, stopPct: 0.25, tpPct: 0.10 } : null; },
    exit(B, C, j, held) { const s5 = sma(C, 5, j); return (s5 && C[j] > s5) || held >= 10; } },
  // Short side (stock short is the cleanest proxy for buying puts: same direction, no decay or option spread).
  rsi2short: { label: 'RSI-2 short (mirror of the bot): below 200-day, RSI-2 > 90, short at next open, cover when close < 5-day avg (max 10 days)', kind: 'swing', short: true,
    plan(B, C, i) { const s200 = sma(C, 200, i), r = rsi2(C, i); return s200 && r != null && C[i] < s200 && r > 90 ? { rank: -r } : null; },
    exit(B, C, j, held) { const s5 = sma(C, 5, j); return (s5 && C[j] < s5) || held >= 10; } },
  breakout: { label: 'Trend breakout: close at a 50-day high above the 200-day, exit on a 20-day low', kind: 'swing',
    plan(B, C, i) { const s200 = sma(C, 200, i); if (!s200 || C[i] <= s200) return null; let hi = -1; for (let k = i - 50; k < i; k++) hi = Math.max(hi, C[k]); return C[i] > hi ? { rank: -C[i] / s200 } : null; },
    exit(B, C, j) { let lo = 1e18; for (let k = j - 20; k < j; k++) lo = Math.min(lo, B[k].l); return C[j] < lo; } },
};

function simulate(key, data, calendar, regimeOn, useRegime) {
  const S = typeof key === 'string' ? STRATS[key] : key;
  let cash = 1, open = [];                       // open: {sym, sh, px (last mark), entryPx, held, stop}
  const days = [], trades = [];
  for (let t = 1; t < calendar.length; t++) {
    const d = calendar[t], prevD = calendar[t - 1];
    // 1) new entries at today's open from plans made at yesterday's close. Cash and free slots are what was there at the
    //    open: positions that will be sold later today still hold their money and their slot (no look-ahead).
    const startOpen = open.slice();
    const equityPrev = cash + open.reduce((s, p) => s + p.sh * p.px, 0);
    if (!useRegime || regimeOn[prevD] !== 'bear') {
      const cands = [];
      for (const sym in data) {
        const D = data[sym], i = D.idx[prevD]; if (i == null || i < 210 || open.some(p => p.sym === sym)) continue;
        if (D.idx[d] == null) continue;
        const pl = S.plan(D.B, D.C, i); if (pl) cands.push({ sym, pl, j: D.idx[d] });
      }
      cands.sort((a, b) => a.pl.rank - b.pl.rank);
      let invested = equityPrev - cash;
      for (const c of cands) {
        if (open.length >= MAXPOS) break;
        const D = data[c.sym], b = D.B[c.j]; let alloc = equityPrev * POS * (c.pl.size || 1);
        if (CAP < 1 && invested + alloc > equityPrev * CAP) alloc = equityPrev * CAP - invested;      // the stock share is full: buy what fits, then stop
        if (alloc < equityPrev * POS * 0.25) break;
        if (alloc > cash) break;
        invested += alloc;
        if (S.kind === 'intraday') {
          const fill = b.o < c.pl.entry ? b.o : (b.l <= c.pl.entry ? c.pl.entry : null); if (fill == null) continue;
          let ex; if (fill <= c.pl.stop) ex = b.c; else if (b.l <= c.pl.stop) ex = c.pl.stop; else if (b.h >= c.pl.target && (b.o < c.pl.entry || b.c >= c.pl.target)) ex = Math.max(c.pl.target, fill); else ex = b.c;   // limit fill later in the day: target only if the close confirms it
          const r = (ex * (1 - COST)) / (fill * (1 + COST)) - 1; cash += alloc * r; trades.push(r);
        } else {
          const fill = b.o, sh = alloc / (fill * (1 + COST));
          cash -= alloc;
          const p = { sym: c.sym, sh, px: S.short ? 2 * fill - b.c : b.c, entryPx: fill, held: 0, alloc, stop: c.pl.stopDist ? fill - c.pl.stopDist : c.pl.stopPct ? fill * (1 - c.pl.stopPct) : null, tp: c.pl.tpPct ? fill * (1 + c.pl.tpPct) : null };
          if (p.stop && b.l <= p.stop) { cash += sh * p.stop * (1 - COST); trades.push((p.stop * (1 - COST)) / (fill * (1 + COST)) - 1); }
          else if (p.tp && b.h >= p.tp) { cash += sh * p.tp * (1 - COST); trades.push((p.tp * (1 - COST)) / (fill * (1 + COST)) - 1); }
          else open.push(p);
        }
      }
    }
    // 2) manage the positions held from before today (stops/targets during the day, rule exits at the close)
    for (const p of startOpen) {
      const D = data[p.sym], j = D.idx[d]; if (j == null) continue;
      const b = D.B[j];
      let exitPx = null;
      if (p.stop && b.l <= p.stop) exitPx = Math.min(b.o, p.stop);              // the stop is checked first: a day that touches both counts as a loss
      else if (p.tp && b.h >= p.tp) exitPx = Math.max(b.o, p.tp);
      else { p.held++; if (S.exit(D.B, D.C, j, p.held)) exitPx = b.c; }
      if (exitPx != null) {
        if (S.short) { const r = (p.entryPx - exitPx) / p.entryPx - 2 * COST; cash += p.alloc * (1 + r); trades.push(r); }
        else { cash += p.sh * exitPx * (1 - COST); trades.push((exitPx * (1 - COST)) / (p.entryPx * (1 + COST)) - 1); }
        p.done = true;
      }
      else p.px = S.short ? 2 * p.entryPx - b.c : b.c;          // a short is marked as margin plus the gain or loss
    }
    open = open.filter(p => !p.done);
    const eq = cash + open.reduce((s, p) => s + p.sh * p.px, 0);
    days.push({ d, eq });
  }
  return { days, trades };
}
function stats(days, trades, from, to) {
  const ds = days.filter(x => (!from || x.d >= from) && (!to || x.d < to)); if (ds.length < 2) return null;
  const rets = ds.slice(1).map((x, i) => x.eq / ds[i].eq - 1), mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  let pk = ds[0].eq, mdd = 0; for (const x of ds) { pk = Math.max(pk, x.eq); mdd = Math.max(mdd, 1 - x.eq / pk); }
  const yrs = (Date.parse(ds[ds.length - 1].d) - Date.parse(ds[0].d)) / (365.25 * 864e5);
  const g = ds[ds.length - 1].eq / ds[0].eq;
  return { from: ds[0].d, to: ds[ds.length - 1].d, cagr: (g ** (1 / Math.max(yrs, 0.1)) - 1) * 100, sharpe: sd ? mean / sd * Math.sqrt(252) : 0, maxDD: mdd * 100 };
}
const tstats = tr => { const w = tr.filter(x => x > 0), l = tr.filter(x => x <= 0), gw = w.reduce((a, b) => a + b, 0), gl = -l.reduce((a, b) => a + b, 0); return { n: tr.length, win: tr.length ? w.length / tr.length * 100 : 0, exp: tr.length ? (gw - gl) / tr.length * 100 : 0, pf: gl > 0 ? gw / gl : null }; };

const spy = await pull(BENCH);
const calendar = spy.map(b => b.d), regimeOn = {};
spy.forEach((b, i) => { regimeOn[b.d] = regimeOf(spy.slice(Math.max(0, i - 299), i + 1).map(x => x.c)).regime; });
const data = {};
for (const s of UNIVERSE) {
  try { const B = await pull(s); data[s] = { B, C: B.map(b => b.c), idx: Object.fromEntries(B.map((b, i) => [b.d, i])) }; }
  catch (e) { console.log('skip', s, e.message); }
  if (process.env.BT_SOURCE !== 'livejson') await new Promise(r => setTimeout(r, 250));
}
const split = calendar[Math.floor(calendar.length * 0.7)];
const results = [];
for (const key of Object.keys(STRATS)) for (const rg of (STRATS[key].short ? [false] : [false, true])) {   // the bear-market block would defeat a short strategy
  const { days, trades } = simulate(key, data, calendar, regimeOn, rg);
  results.push({ key, regime: rg, label: STRATS[key].label, all: stats(days, trades), ins: stats(days, trades, null, split), oos: stats(days, trades, split), t: tstats(trades) });
  console.log(key, rg ? 'regime' : 'plain', JSON.stringify(results[results.length - 1].oos));
}
const spyDays = spy.map(b => ({ d: b.d, eq: b.c }));
const spyAll = stats(spyDays, [], null, null), spyOos = stats(spyDays, [], split);
// extra yardsticks (India: small and mid caps), measured over the same dates as the strategies; a missing index is skipped
const EXTRA = MKT === 'IN' ? [['^CNXSC', 'Nifty Smallcap 100'], ['^NSEMDCP50', 'Nifty Midcap 50'], ['^CRSMID', 'Nifty Midcap 100']] : [['^RUT', 'Russell 2000 (small caps)']];
const extras = [];
for (const [sym, name] of EXTRA) {
  try { const B = (await pull(sym)).filter(b => b.d >= calendar[0]); if (B.length < 250) throw new Error('too short'); const ds = B.map(b => ({ d: b.d, eq: b.c })); extras.push({ sym, name, from: B[0].d, all: stats(ds, [], null, null), oos: stats(ds, [], split) }); }
  catch (e) { console.log('benchmark skipped', sym, e.message); }
}
// ---- the last 5 years, as the bot would have run them from a fresh start, against large / mid / small caps ----
// Benchmarks include dividends: India = index-fund NAVs (AMFI via mfapi.in; after the funds' fees), US = ETF adjusted closes.
async function pullMf(code) {
  const r = await fetch(`https://api.mfapi.in/mf/${code}`); if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json(); return { name: j.meta && j.meta.scheme_name, B: (j.data || []).map(x => { const [dd, mm, yy] = x.date.split('-'); return { d: `${yy}-${mm}-${dd}`, c: +x.nav }; }).filter(x => x.c > 0).sort((a, b) => a.d < b.d ? -1 : 1) };
}
async function pullAdj(sym) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=7y&interval=1d`, { headers: { 'user-agent': 'Mozilla/5.0' } }); if (!r.ok) throw new Error('HTTP ' + r.status);
  const res = (await r.json()).chart.result[0], ac = ((res.indicators.adjclose || [])[0] || {}).adjclose || res.indicators.quote[0].close;
  return { B: res.timestamp.map((t, i) => ({ d: new Date(t * 1000).toISOString().slice(0, 10), c: ac[i] })).filter(x => x.c > 0) };
}
const BENCH5 = MKT === 'IN'
  ? [['large', 'Large caps — Nifty 50 index fund', () => pullMf(118482)], ['next', 'Next 50 — Nifty Next 50 index fund', () => pullMf(143341)], ['mid', 'Mid caps — Nifty Midcap 150 index fund', () => pullMf(147622)], ['small', 'Small caps — Nifty Smallcap 250 index fund', () => pullMf(147623)]]
  : [['large', 'Large caps — S&P 500 (SPY)', () => pullAdj('SPY')], ['mid', 'Mid caps — S&P MidCap 400 (IJH)', () => pullAdj('IJH')], ['small', 'Small caps — Russell 2000 (IWM)', () => pullAdj('IWM')], ['tech', 'Tech — Vanguard Information Technology (VGT)', () => pullAdj('VGT')], ['nasdaq', 'Nasdaq-100 (QQQ)', () => pullAdj('QQQ')]];
function curveStats(pts) {                                   // pts: [[date, value]] from 1.0
  const v = pts.map(p => p[1]), n = v.length, yrs = (Date.parse(pts[n - 1][0]) - Date.parse(pts[0][0])) / (365.25 * 864e5);
  let pk = v[0], dd = 0; for (const x of v) { pk = Math.max(pk, x); dd = Math.max(dd, 1 - x / pk); }
  const r = v.slice(1).map((x, i) => x / v[i] - 1), m = r.reduce((a, b) => a + b, 0) / r.length, sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / r.length);
  const years = {}; let prevEnd = v[0];
  for (let i = 0; i < n; i++) { const y = pts[i][0].slice(0, 4), last = i === n - 1 || pts[i + 1][0].slice(0, 4) !== y; if (last) { years[y] = Math.round((v[i] / prevEnd - 1) * 1000) / 10; prevEnd = v[i]; } }
  return { total: Math.round((v[n - 1] / v[0] - 1) * 1000) / 10, cagr: Math.round(((v[n - 1] / v[0]) ** (1 / Math.max(yrs, 0.1)) - 1) * 1000) / 10, maxDD: Math.round(dd * 1000) / 10, sharpe: sd ? Math.round(m / sd * Math.sqrt(252) * 100) / 100 : 0, years };
}
const last = calendar[calendar.length - 1], from5 = new Date(Date.parse(last) - 5 * 365.25 * 864e5).toISOString().slice(0, 10);
const cal5 = calendar.filter(d => d >= from5);
const thin = pts => pts.filter((p, i) => i % 5 === 0 || i === pts.length - 1).map(([d, x]) => [d, Math.round(x * 10000) / 10000]);
const h5 = { from: cal5[0], to: last, series: [] };
const botCurve = key => { const { days, trades } = simulate(key, data, cal5, regimeOn, false); return { pts: days.map(x => [x.d, x.eq]), trades: trades.length }; };
const parts = MKT === 'IN' ? [['breakout', 0.5], ['rsi2', 0.5]] : [['rsi2', 1]];
const curves = Object.fromEntries(parts.map(([k]) => [k, botCurve(k)]));
const botPts = curves[parts[0][0]].pts.map(([d], i) => [d, parts.reduce((t, [k, w]) => t + w * curves[k].pts[i][1], 0)]);
h5.series.push({ key: 'bot', kind: 'bot', label: MKT === 'IN' ? 'India bot — trend breakout + RSI-2, 50/50' : 'USA bot — RSI-2 dip buying', trades: parts.reduce((t, [k]) => t + curves[k].trades, 0), ...curveStats(botPts), pts: thin(botPts) });
if (parts.length > 1) for (const [k] of parts) h5.series.push({ key: k, kind: 'part', label: STRATS[k].label.split(':')[0].split('(')[0].trim(), trades: curves[k].trades, ...curveStats(curves[k].pts), pts: thin(curves[k].pts) });
// sizing variants for the USA bot (shown in the research report, not on the chart): the presets' money per stock × max stocks
if (MKT === 'US') {
  h5.variants = [];
  for (const [nm, pos, mx, key] of [['Balanced (10% × 6 stocks), tested rules', 0.10, 6, 'rsi2'], ['Aggressive (12% × 8 stocks), tested rules', 0.12, 8, 'rsi2'], ['Aggressive + 10% take-profit', 0.12, 8, 'rsi2tp10'], ['Aggressive with your settings (buy below 25, +10% take-profit)', 0.12, 8, 'rsi2own'], ['All-in (16% × 6 = 96%), tested rules', 0.16, 6, 'rsi2'], ['Stock part of a 60/30/10 split, your settings (12% of the stake per stock = 20% of the part, max 5)', 0.20, 5, 'rsi2own'], ['PUT stand-in: short stock on RSI-2 pops, run on its own money (25% each, max 4)', 0.25, 4, 'rsi2short']]) {
    POS = pos; MAXPOS = mx; const c = botCurve(key); POS = POS0; MAXPOS = MAXPOS0;
    h5.variants.push({ label: nm, pos, maxPos: mx, strat: key, trades: c.trades, ...curveStats(c.pts) });
  }
}
for (const [key, label, get] of BENCH5) {
  try {
    const { B } = await get(); const m = Object.fromEntries(B.map(b => [b.d, b.c]));
    let lastV = null; const raw = cal5.map(d => { if (m[d] != null) lastV = m[d]; return [d, lastV]; }).filter(p => p[1] != null);
    if (!raw.length || raw[0][0] > cal5[5]) throw new Error('history starts ' + (raw[0] && raw[0][0]));
    const pts = raw.map(([d, x]) => [d, x / raw[0][1]]);
    h5.series.push({ key, kind: 'bench', label, ...curveStats(pts), pts: thin(pts) });
  } catch (e) { console.log('5-year benchmark skipped', key, e.message); h5.series.push({ key, kind: 'bench', label, missing: String(e.message).slice(0, 80) }); }
}

// ---- the 5-year card's mode buttons: the three presets with the default rules, and the owner's saved settings ----
if (MKT === 'US') {
  const SPYI = Object.fromEntries(spy.map((b, i) => [b.d, i])), SPYC = spy.map(b => b.c);
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync('bot/config.json', 'utf8')); } catch (e) {}
  const mk = ({ thr, tp, stop, hold, leaders }) => ({ kind: 'swing',
    plan(B, C, i) { const s200 = sma(C, 200, i), r = rsi2(C, i); if (!(s200 && r != null && C[i] > s200 && r < thr)) return null;
      let rank = r; if (leaders && i >= 60) { const k = SPYI[B[i].d], m = k != null && k >= 60 ? SPYC[k] / SPYC[k - 60] - 1 : 0; rank = -((C[i] / C[i - 60] - 1) - m); }
      return { rank, stopPct: stop / 100, tpPct: tp > 0 ? tp / 100 : null }; },
    exit(B, C, j, held) { const s5 = sma(C, 5, j); return (s5 && C[j] > s5) || held >= hold; } });
  const def = { thr: 10, tp: 10, stop: 25, hold: 10, leaders: true };            // the bot's defaults for the strategy settings
  const spyShare = cfg.spyOn === false ? 0 : (cfg.spySharePct ?? 5);
  const stockShare = cfg.split === false ? 1 : Math.max(0, 100 - (cfg.callSharePct ?? 30) - (cfg.putSharePct ?? 10) - spyShare) / 100;
  const mine = { thr: cfg.rsiThreshold ?? 10, tp: cfg.stockTp ?? 10, stop: cfg.holdFloor ?? 25, hold: cfg.maxHold ?? 10, leaders: (cfg.pickBy || 'leaders') === 'leaders' };
  const minePos = cfg.stockUnit === 'usd' ? 0.10 : (cfg.stockPct ?? 10) / 100, mineMax = cfg.maxPositions ?? 6;
  h5.modes = {};
  const runMode = (key, label, strat, pos, mx, cap) => { POS = pos; MAXPOS = mx; CAP = cap; const c = botCurve(strat); POS = POS0; MAXPOS = MAXPOS0; CAP = 1; h5.modes[key] = { label, pos, maxPos: mx, cap, trades: c.trades, ...curveStats(c.pts), pts: thin(c.pts) }; };
  runMode('conservative', 'Conservative — 8% × up to 4 stocks', mk(def), 0.08, 4, 1);
  runMode('balanced', 'Balanced — 10% × up to 6 stocks', mk(def), 0.10, 6, 1);
  runMode('aggressive', 'Aggressive — 12% × up to 8 stocks', mk(def), 0.12, 8, 1);
  runMode('mine', `Your settings — ${Math.round(minePos * 100)}% × up to ${mineMax} stocks, buy below ${mine.thr}, ${mine.tp > 0 ? '+' + mine.tp + '% take-profit' : 'no take-profit'}, ${mine.leaders ? 'leaders first' : 'deepest dip first'}${stockShare < 1 ? ', stocks ' + Math.round(stockShare * 100) + '% of the money' : ''}`, mk(mine), minePos, mineMax, stockShare);
  h5.modes.mine.settings = { ...mine, pos: minePos, maxPos: mineMax, stockShare, preset: cfg.preset || 'balanced', savedAt: cfg.updatedAt || null };
  for (const [k, m] of Object.entries(h5.modes)) console.log('mode', k, m.cagr, m.maxDD, m.trades);
}

// ---- five ideas to make the USA bot different, each from the owner's settings, Aggressive sizing (12% × 8) ----
let ideas = null;
if (MKT === 'US') {
  const SI = Object.fromEntries(spy.map((b, i) => [b.d, i])), SC = spy.map(b => b.c);
  const spyRet = (d, n) => { const i = SI[d]; return i != null && i >= n ? SC[i] / SC[i - n] - 1 : null; };
  const vol20 = SC.map((_, i) => { if (i < 21) return null; let m = 0, v = 0; const r = []; for (let k = i - 19; k <= i; k++) r.push(SC[k] / SC[k - 1] - 1); m = r.reduce((a, b) => a + b, 0) / 20; v = r.reduce((a, b) => a + (b - m) ** 2, 0) / 20; return Math.sqrt(v * 252); });
  const volMed = vol20.map((_, i) => { if (i < 272) return null; const w = vol20.slice(i - 251, i + 1).filter(x => x != null).sort((a, b) => a - b); return w[w.length >> 1]; });
  const ownDip = (C, i) => { const s200 = sma(C, 200, i), r = rsi2(C, i); return s200 && r != null && C[i] > s200 && r < 25 ? r : null; };
  const own = { stopPct: 0.25, tpPct: 0.10 }, exit = (B, C, j, held) => { const s5 = sma(C, 5, j); return (s5 && C[j] > s5) || held >= 10; };
  const template = (B, C, i) => {                   // the site's 8-point trend template (the gate to a Top Buy rating)
    if (i < 260) return 0; const p = C[i], m50 = sma(C, 50, i), m100 = sma(C, 100, i), m200 = sma(C, 200, i), m100a = sma(C, 100, i - 21);
    let hi = -1, lo = 1e18; for (let k = i - 251; k <= i; k++) { hi = Math.max(hi, B[k].h); lo = Math.min(lo, B[k].l); }
    const r60 = C[i] / C[i - 60] - 1, r120 = C[i] / C[i - 120] - 1, s60 = spyRet(B[i].d, 60), s120 = spyRet(B[i].d, 120);
    return [p > m100 && p > m200, m100 > m200, m50 > m100 && m50 > m200, p > m50, m100 > m100a, p >= lo * 1.25, p >= hi * 0.75, (s60 != null && r60 > s60) || (s120 != null && r120 > s120)].filter(Boolean).length;
  };
  const mk = plan => ({ kind: 'swing', plan, exit });
  const IDEAS = [
    ['base', 'Your settings today (buy below 25, +10% take-profit, 25% stop)', mk((B, C, i) => { const r = ownDip(C, i); return r == null ? null : { rank: r, ...own }; })],
    ['quality', '1 · Quality dips only: the stock passes 6+ of the 8 trend-template points', mk((B, C, i) => { const r = ownDip(C, i); return r == null || template(B, C, i) < 6 ? null : { rank: r, ...own }; })],
    ['mktdown', '2a · Only dips on days the whole market also fell', mk((B, C, i) => { const r = ownDip(C, i), m = spyRet(B[i].d, 1); return r == null || m == null || m >= 0 ? null : { rank: r, ...own }; })],
    ['panic', '2b · Only dips on market panic days (S&P 500 down 1% or more)', mk((B, C, i) => { const r = ownDip(C, i), m = spyRet(B[i].d, 1); return r == null || m == null || m > -0.01 ? null : { rank: r, ...own }; })],
    ['leaders', '3 · Leaders first: among the dips, buy those that beat the market most over 3 months', mk((B, C, i) => { const r = ownDip(C, i), m = spyRet(B[i].d, 60); return r == null || i < 60 ? null : { rank: -((C[i] / C[i - 60] - 1) - (m || 0)), ...own }; })],
    ['fear', '5 · Bigger buys when the market is nervous (1.5× when S&P 500 swings exceed their 1-year norm, 0.75× when calm)', mk((B, C, i) => { const r = ownDip(C, i); if (r == null) return null; const k = SI[B[i].d], hiVol = k != null && vol20[k] != null && volMed[k] != null && vol20[k] > volMed[k]; return { rank: r, ...own, size: hiVol ? 1.5 : 0.75 }; })],
  ];
  POS = 0.12; MAXPOS = 8;
  const run = S => simulate(S, data, calendar, regimeOn, false);
  const curves = Object.fromEntries(IDEAS.map(([k, , S]) => [k, run(S)]));
  const brk = run(STRATS.breakout);
  POS = POS0; MAXPOS = MAXPOS0;
  // idea 4: half the money on your dip rule, half on trend breakout (each on its own half)
  const bd = Object.fromEntries(brk.days.map(x => [x.d, x.eq]));
  { let eq = 1, pa = null, pb = null; const cd = [];                    // rebalanced to 50/50 every day, so neither half swamps the other
    for (const x of curves.base.days) { const b = bd[x.d]; if (pa != null && b != null && pb != null) eq *= 1 + 0.5 * (x.eq / pa - 1) + 0.5 * (b / pb - 1); cd.push({ d: x.d, eq }); pa = x.eq; if (b != null) pb = b; }
    curves.combo = { days: cd, trades: curves.base.trades.concat(brk.trades) }; }
  IDEAS.splice(5, 0, ['combo', '4 · Second engine: half the money on your dip rule, half on trend breakout', null]);
  const T = 0.408, afterTax = yrs => { let v = 100000, carry = 0; for (const r of yrs) { const g = v * r, n = g + carry; let t = 0; if (n > 0) { t = n * T; carry = 0; } else carry = n; v += g - t; } return Math.round(v); };
  ideas = IDEAS.map(([key, label]) => {
    const c = curves[key], d5 = c.days.filter(x => x.d >= from5), pts = d5.map(x => [x.d, x.eq / d5[0].eq]), c5 = curveStats(pts);
    return { key, label, all: stats(c.days, c.trades), oos: stats(c.days, c.trades, split), t: tstats(c.trades), five: { cagr: c5.cagr, maxDD: c5.maxDD, years: c5.years, afterTax: afterTax(Object.keys(c5.years).sort().map(y => c5.years[y] / 100)) } };
  });
  for (const x of ideas) console.log('idea', x.key, x.all.cagr.toFixed(1), x.oos.cagr.toFixed(1), x.five.cagr, x.five.afterTax);
}

const f = (x, d = 2) => x == null || !isFinite(x) ? 'n/a' : (+x).toFixed(d), pc = x => x == null ? 'n/a' : (x >= 0 ? '+' : '') + f(x) + '%';
let md = `# Strategy research${MKT === 'IN' ? ' — India (NSE)' : ''} — ${Object.keys(data).length} stocks, ${calendar[0]} → ${calendar[calendar.length - 1]}\n\nCosts ${(COST * 100).toFixed(2)}%/side · 10% of equity per position · max ${MAXPOS} positions · out-of-sample = ${split} onward (never used to choose anything).\n\n`;
md += `| Strategy | Regime filter | CAGR (all) | Sharpe (all) | Max DD | **OOS CAGR** | **OOS Sharpe** | OOS Max DD | Trades | Win % | Exp./trade | PF |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const r of results) md += `| ${r.label} | ${r.regime ? 'on' : 'off'} | ${pc(r.all && r.all.cagr)} | ${f(r.all && r.all.sharpe)} | −${f(r.all && r.all.maxDD, 1)}% | **${pc(r.oos && r.oos.cagr)}** | **${f(r.oos && r.oos.sharpe)}** | −${f(r.oos && r.oos.maxDD, 1)}% | ${r.t.n} | ${f(r.t.win, 1)}% | ${pc(r.t.exp)} | ${f(r.t.pf)} |\n`;
md += `| ${BENCH_NAME} buy & hold | – | ${pc(spyAll.cagr)} | ${f(spyAll.sharpe)} | −${f(spyAll.maxDD, 1)}% | **${pc(spyOos.cagr)}** | **${f(spyOos.sharpe)}** | −${f(spyOos.maxDD, 1)}% | – | – | – | – |\n\n`;
for (const x of extras) md += `| ${x.name} buy & hold${x.from > calendar[0] ? ` (from ${x.from})` : ''} | – | ${pc(x.all && x.all.cagr)} | ${f(x.all && x.all.sharpe)} | −${f(x.all && x.all.maxDD, 1)}% | **${pc(x.oos && x.oos.cagr)}** | **${f(x.oos && x.oos.sharpe)}** | −${f(x.oos && x.oos.maxDD, 1)}% | – | – | – | – |\n`;
if (extras.length) md += '\n';
md += `\n## The last 5 years (${h5.from} → ${h5.to}), from a fresh start\n\nBenchmarks include dividends (${MKT === 'IN' ? 'index-fund NAVs, after the funds’ fees' : 'ETF adjusted closes'}). The bot keeps at most 60% invested (6 positions × 10%).\n\n| | Total | Per year | Worst fall | Sharpe | ${Object.keys((h5.series[0] || {}).years || {}).join(' | ')} |\n|---|---|---|---|---|${Object.keys((h5.series[0] || {}).years || {}).map(() => '---').join('|')}|\n`;
for (const x of h5.series) md += x.missing ? `| ${x.label} | n/a (${x.missing}) |\n` : `| ${x.kind === 'bot' ? '**' + x.label + '**' : x.label} | ${pc(x.total)} | ${pc(x.cagr)} | −${f(x.maxDD, 1)}% | ${f(x.sharpe)} | ${Object.keys(h5.series[0].years).map(y => x.years[y] == null ? '–' : pc(x.years[y])).join(' | ')} |\n`;
if (h5.variants) { md += `\n### USA bot sizing variants, same 5 years\n\n| Variant | Total | Per year | Worst fall | Sharpe | Trades |\n|---|---|---|---|---|---|\n`; for (const x of h5.variants) md += `| ${x.label} | ${pc(x.total)} | ${pc(x.cagr)} | −${f(x.maxDD, 1)}% | ${f(x.sharpe)} | ${x.trades} |\n`; }
if (ideas) { md += `\n## Five ideas to make the bot different (Aggressive sizing, your settings as the base)\n\n| Idea | Per year, 33 yrs | Worst fall | **Per year since ${split}** | Worst fall since | Trades | Win % | Last 5 yrs per year | $100k after 40.8% tax, 5 yrs |\n|---|---|---|---|---|---|---|---|---|\n`; for (const x of ideas) md += `| ${x.label} | ${pc(x.all.cagr)} | −${f(x.all.maxDD, 1)}% | **${pc(x.oos.cagr)}** | −${f(x.oos.maxDD, 1)}% | ${x.t.n} | ${f(x.t.win, 1)}% | ${pc(x.five.cagr)} | $${x.five.afterTax.toLocaleString('en-US')} |\n`; }
md += `\nSurvivorship bias (today’s big companies, looking back) flatters every strategy, so treat these as an upper bound. Not financial advice.\n`;
fs.writeFileSync(OUT.md, md);
fs.writeFileSync(OUT.json, JSON.stringify({ at: new Date().toISOString(), market: MKT, bench: BENCH_NAME, cost: COST, symbols: Object.keys(data), split, results, ideas, spy: { all: spyAll, oos: spyOos }, extras, history5: h5 }));
console.log(md);
