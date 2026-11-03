// Same-day-expiry (0DTE) SPY entry study — "when should the sleeve buy its CALLs and PUTs?" (owner, 2026-11-03:
// results are bad, change the strategy, it buys at the wrong time).
//
// Replays the bot's exact SPY rule (bot/spyopt.mjs spySignal) minute by minute on real SPY one-minute bars since 2023,
// pricing a SAME-day-expiry option with the Black-Scholes model (volatility = k0 × VIX, k0 calibrated on real 0DTE
// minute bars when research-data/spyopt0.json.gz is present) — and, on the days with real 0DTE bars, on those real
// prices too. Entries pay the ask plus the fast-fill cushion (~1%), like the owner's setting. On top of the bot's rule
// it tests entry filters: morning only, a wider gap from the VWAP, beyond the previous day's high/low, and a retest
// entry (wait for the price to come back to the broken level instead of chasing the break).
//   node tools/spy0-study.mjs           calibration, his settings as they are, the exit grid, the entry filters
import fs from 'node:fs';
import zlib from 'node:zlib';
import { SPY_DEFAULTS, spySignal } from '../bot/spyopt.mjs';
import { loadSpy, bs, calibrate, modelPricer, runDay } from './spy-study.mjs';

const DIR = process.env.DATA || 'research-data';
const load = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(`${DIR}/${f}`)).toString());
const HALF = 0.005;                                          // half the spread; entries below also pay the fast-fill cushion
const FAST = 0.01;                                           // "pay up to get in quickly": ~2 price steps on a $2 option
const hhmm = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };

// time to TODAY'S 4 PM expiry, in trading years (floor of 2 minutes so the model stays sane at the end)
export const years0 = m => Math.max(2, 960 - m) / 390 / 252;

// ---- real option bars for contracts expiring the same day ----
export function loadReal0() {
  let raw; try { raw = load('spyopt0.json.gz').bars; } catch (e) { return null; }
  const by = {};
  for (const [sym, b] of Object.entries(raw)) {
    const m = /^SPY(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(sym); if (!m) continue;
    const rec = by[b.day] || (by[b.day] = {}), map = new Map();
    for (let i = 0; i < b.t.length; i++) map.set(b.t[i], { o: b.o[i], h: b.h[i], l: b.l[i], c: b.c[i] });
    rec[sym] = { K: +m[5] / 1000, call: m[4] === 'C', bars: map };
  }
  return by;
}
// calibrate k0 (0DTE volatility = k0 × VIX) on real near-the-money 0DTE prices; error reported morning vs afternoon
export function calibrate0(days, real0) {
  const pts = [];
  for (const D of days) {
    const R = real0 && real0[D.d]; if (!R || !D.vix) continue;
    const spot = new Map(D.bars.map(b => [b.t, b]));
    for (const o of Object.values(R)) for (const [t, ob] of o.bars) {
      const s = spot.get(t); if (!s || Math.abs(s.c - o.K) > 1.5 || ob.c < 0.15 || s.m > 940) continue;
      pts.push({ S: s.c, K: o.K, T: years0(s.m), vix: D.vix / 100, call: o.call, px: ob.c, m: s.m });
    }
  }
  if (!pts.length) return null;
  let best = null;
  for (let k = 0.5; k <= 2.2; k += 0.02) {
    let e = 0; for (const p of pts) { const q = bs(p.S, p.K, p.T, k * p.vix, p.call); e += Math.log(q / p.px) ** 2; }
    if (!best || e < best.e) best = { k: +k.toFixed(2), e };
  }
  const err = sub => { const es = sub.map(p => Math.abs(bs(p.S, p.K, p.T, best.k * p.vix, p.call) / p.px - 1)).sort((a, b) => a - b); return es.length ? { med: es[es.length >> 1] * 100, p90: es[Math.floor(es.length * 0.9)] * 100 } : null; };
  return { k: best.k, n: pts.length, all: err(pts), am: err(pts.filter(p => p.m < 720)), pm: err(pts.filter(p => p.m >= 720)) };
}

// ---- one day of the rule on a same-day option, with the entry filters under test ----
// cfg extras: _endM (no entries at/after this ET minute), _vwapDist (least |price/VWAP − 1| at entry),
// _beyondPrev (price beyond yesterday's high/low), _retest (enter on a pullback to the broken level within 15 min,
// at that minute's close — pessimistic — instead of chasing the break; the break is spent either way).
export function runDay0(D, DC, cfg, pricer) {
  const C = { ...SPY_DEFAULTS, ...cfg }, out = [], open = [], five = [], lastLvl = { call: 0, put: 0 }, pend = [];
  let trades = 0, streak = 0, dayPl = 0, stopped = false;
  const flatM = C._dte1 ? C.spyFlat : 940;                                  // same-day contract: flat by 3:20 PM; next-day: the usual 3:45
  const endM = Math.min(hhmm(C.spyEnd), C._endM || 9999);
  for (const b of D.bars) {
    const m5 = b.m - (b.m % 5);
    for (const tr of open) {                                               // 1) manage what is open
      if (tr.done) continue;
      const hi = pricer.priceAt(tr, b, tr.call ? 'h' : 'l'), lo = pricer.priceAt(tr, b, tr.call ? 'l' : 'h'), op = pricer.priceAt(tr, b, 'o');
      if (hi == null || lo == null || op == null) continue;
      let exitPx = null, why = null;
      if (b.m >= flatM) { exitPx = op * (1 - HALF); why = 'flat'; }
      else if (lo <= tr.entry * (1 - C.spyStop / 100)) { exitPx = Math.min(op, tr.entry * (1 - C.spyStop / 100)) * (1 - HALF); why = 'stop'; }
      else if (hi >= tr.entry * (1 + C.spyTp / 100)) { exitPx = Math.max(op, tr.entry * (1 + C.spyTp / 100)); why = 'tp'; }
      else if (b.m - tr.m >= C.spyHoldMin) { exitPx = op * (1 - HALF); why = 'time'; }
      if (exitPx != null) {
        tr.done = true; const r = exitPx / tr.entry - 1; out.push({ r, why, side: tr.call ? 'call' : 'put', m: tr.m, d: D.d });
        streak = r > 0 ? 0 : streak + 1; dayPl += r * (C.spyTradePct ?? 100) / 100;
        if (streak >= C.spyStreak || dayPl <= -C.spyDayCap / 100) stopped = true;
      }
    }
    const canEnter = !stopped && trades < C.spyMaxTrades && open.filter(x => !x.done).length < C.spyMaxOpen && b.m < endM;
    for (let i = pend.length - 1; i >= 0; i--) {                            // 2) a waiting retest entry
      const p = pend[i];
      if (b.m > p.until || stopped || b.m >= endM) { pend.splice(i, 1); continue; }
      if (!(p.call ? b.l <= p.level : b.h >= p.level)) continue;
      pend.splice(i, 1);
      if (!canEnter) continue;
      const tr = { call: p.call, m: b.m, S: p.level, K: p.K, t: b.t };
      const e = pricer.priceAt(tr, { ...b, o: p.level, h: p.level, l: p.level, c: p.level, m: b.m, t: b.t }, 'c');
      if (e == null || !(e > 0.05)) continue;
      tr.entry = e * (1 + HALF + (globalThis.__noFast ? 0 : FAST)); open.push(tr); trades++;
    }
    const done = five.filter(x => x.m + 5 <= b.m);                          // 3) a new break?
    if (canEnter && done.length >= 4) {
      const last3 = done.slice(-3), hiL = Math.max(...last3.map(x => x.h)), loL = Math.min(...last3.map(x => x.l));
      for (const [px, side] of [[b.h > hiL ? Math.max(b.o, hiL + 0.01) : null, 'call'], [b.l < loL ? Math.min(b.o, loL - 0.01) : null, 'put']]) {
        if (px == null) continue;
        const sig = spySignal({ bars: done, px, mins: b.m, cfg: { ...C, spyVwapGap: 0.05, spyBeyondPrev: false } });   // the study applies its own _ filters below; the live keys are mapped onto them in main
        if (!sig || sig.side !== side) continue;
        if (!(lastLvl[side] === 0 || (side === 'call' ? sig.level > lastLvl[side] : sig.level < lastLvl[side]))) continue;
        if (C._vwapDist && Math.abs(px / sig.vwap - 1) < C._vwapDist) continue;
        if (C._beyondPrev && DC.prevHi != null && !(side === 'call' ? px > DC.prevHi : px < DC.prevLo)) continue;
        lastLvl[side] = sig.level;                                          // the break is spent, entered or not
        if (C._retest) { if (pend.length < 2) pend.push({ call: side === 'call', level: sig.level, K: Math.round(px), until: b.m + 15 }); break; }
        const tr = { call: side === 'call', m: b.m, S: px, K: Math.round(px), t: b.t };
        const e = pricer.open0(tr, b); if (e == null || !(e > 0.05)) continue;
        tr.entry = e * (1 + HALF + (globalThis.__noFast ? 0 : FAST)); open.push(tr); trades++;
        break;
      }
    }
    const cur = five[five.length - 1];                                      // 4) fold the minute into its 5-minute bar
    if (cur && cur.m === m5) { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; }
    else five.push({ m: m5, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  return out;
}

export const modelPricer0 = (D, k) => {
  const v = k * D.vix / 100;
  return { open0: (tr, b) => bs(tr.S, tr.K, years0(b.m), v, tr.call), priceAt: (tr, b, w) => bs(b[w], tr.K, years0(b.m), v, tr.call) };
};
export function realPricer0(D, R) {
  const occ = (call, K) => `SPY${D.d.slice(2, 4)}${D.d.slice(5, 7)}${D.d.slice(8, 10)}${call ? 'C' : 'P'}${String(Math.round(K * 1000)).padStart(8, '0')}`;
  const lastPx = new Map();
  const at = (tr, b, w) => {
    const o = R[occ(tr.call, tr.K)]; if (!o) return null;
    const bar = o.bars.get(b.t);
    if (bar) { lastPx.set(tr, bar.c); return w === 'o' ? bar.o : w === 'c' ? bar.c : (w === 'h') === tr.call ? bar.h : bar.l; }
    return lastPx.get(tr) ?? null;
  };
  return { open0: (tr, b) => { const o = R[occ(tr.call, tr.K)]; if (!o) return null; const bar = o.bars.get(b.t + 1) || o.bars.get(b.t); return bar ? bar.o : null; }, priceAt: at };
}

// ---- stats: per trade, per sleeve-year, worst run of the sleeve ----
export function stats(tr, c, years) {
  const n = tr.length, w = tr.filter(x => x.r > 0), l = tr.filter(x => x.r <= 0), pct = (c.spyTradePct ?? 100) / 100;
  const byDay = new Map(); for (const x of tr) byDay.set(x.d, (byDay.get(x.d) || 0) + x.r * pct);
  let run = 0, pk = 0, dd = 0; for (const d of [...byDay.keys()].sort()) { run += byDay.get(d); pk = Math.max(pk, run); dd = Math.max(dd, pk - run); }
  const am = tr.filter(x => x.m < 690), pm = tr.filter(x => x.m >= 690), avg = a => a.length ? a.reduce((t, x) => t + x.r, 0) / a.length * 100 : null;
  return { n, perDay: byDay.size ? n / byDay.size : 0, win: n ? w.length / n * 100 : 0, exp: avg(tr) ?? 0,
    avgW: avg(w) ?? 0, avgL: avg(l) ?? 0, sleeveYr: years ? tr.reduce((t, x) => t + x.r * pct, 0) / years * 100 : 0,
    maxDD: dd * 100, amExp: avg(am), pmExp: avg(pm), why: tr.reduce((o, x) => (o[x.why] = (o[x.why] || 0) + 1, o), {}) };
}
const fm = (v, d = 1) => v == null ? '    –' : ((v >= 0 ? '+' : '') + v.toFixed(d)).padStart(5 + d);

if (import.meta.url === `file://${process.argv[1]}`) {
  const days = loadSpy().filter(D => D.vix && D.bars.length > 300);
  const DCs = new Map(); let prev = null;
  for (const D of days) { DCs.set(D.d, { prevHi: prev ? Math.max(...prev.bars.map(b => b.h)) : null, prevLo: prev ? Math.min(...prev.bars.map(b => b.l)) : null }); prev = D; }
  const real0 = loadReal0();
  const cal0 = real0 && calibrate0(days, real0);
  const K0 = cal0 ? cal0.k : 1.1;                                          // without real 0DTE bars yet: ~10% over VIX
  if (cal0) console.log(`0DTE model calibration on ${cal0.n} real near-the-money minute prices: volatility = ${cal0.k} × VIX · median error ${cal0.all.med.toFixed(1)}% (90% under ${cal0.all.p90.toFixed(1)}%) · morning ${cal0.am ? cal0.am.med.toFixed(1) : '–'}% · afternoon ${cal0.pm ? cal0.pm.med.toFixed(1) : '–'}%`);
  else console.log('no real 0DTE bars yet (research-data/spyopt0.json.gz missing) — model only, volatility 1.10 × VIX');
  let cfgF = {}; try { cfgF = JSON.parse(fs.readFileSync('bot/config.json', 'utf8')); } catch (e) {}
  const own = Object.fromEntries(Object.entries(cfgF).filter(([k]) => k.startsWith('spy')));
  if (own.spyVwapGap > 0.05) own._vwapDist = own.spyVwapGap / 100;            // live settings → the study's own filter knobs
  if (own.spyBeyondPrev) own._beyondPrev = true;
  if (own.spyDte !== 0) own._dte1 = true;
  console.log(`his settings: ${JSON.stringify(own)}`);
  const years = days.length / 252;
  const run0 = (c, list = days) => list.flatMap(D => runDay0(D, DCs.get(D.d), c, modelPricer0(D, K0)));
  const realDays = real0 ? days.filter(D => real0[D.d]) : [];
  const runR = c => realDays.flatMap(D => runDay0(D, DCs.get(D.d), c, realPricer0(D, real0[D.d])));
  const line = (name, s) => console.log(`${name.padEnd(44)} ${String(s.n).padStart(5)} ${(s.perDay).toFixed(1).padStart(4)}/d ${s.win.toFixed(1).padStart(5)}% ${fm(s.exp, 2)}% ${fm(s.avgW)} ${fm(s.avgL)} ${fm(s.sleeveYr, 0)}%/yr dd${s.maxDD.toFixed(0).padStart(4)}% am${fm(s.amExp, 1)} pm${fm(s.pmExp, 1)} ${JSON.stringify(s.why)}`);
  const H = `${'variant'.padEnd(44)} trades  /day   win  avg/tr  avgW  avgL  sleeve/yr  worst-run  am/pm  exits`;

  console.log('\n— as it runs now (model prices, all days) —\n' + H);
  line('A now: 0DTE tp25 stop35 hold60 to 14:00', stats(run0(own), own, years));

  console.log('\n— exits on the same entries (0DTE, window to 14:00) —');
  const exits = [];
  for (const tp of [5, 10, 15, 25]) for (const stop of [25, 35]) for (const hold of [30, 60]) exits.push({ ...own, spyTp: tp, spyStop: stop, spyHoldMin: hold });
  const exRows = exits.map(c => ({ c, s: stats(run0(c), c, years) })).sort((a, b) => b.s.sleeveYr - a.s.sleeveYr);
  for (const { c, s } of exRows) line(`tp ${c.spyTp} stop ${c.spyStop} hold ${c.spyHoldMin}`, s);

  const bestEx = exRows[0].c;
  console.log('\n— entry filters on the best exits —\n' + H);
  const F = [
    ['B best exits alone', bestEx],
    ['C morning only (no entries after 11:30)', { ...bestEx, _endM: 690 }],
    ['D VWAP gap ≥ 0.15%', { ...bestEx, _vwapDist: 0.0015 }],
    ['E VWAP gap ≥ 0.25%', { ...bestEx, _vwapDist: 0.0025 }],
    ['F beyond yesterday’s high/low', { ...bestEx, _beyondPrev: true }],
    ['G retest: buy the pullback to the level', { ...bestEx, _retest: true }],
    ['H morning + VWAP 0.15%', { ...bestEx, _endM: 690, _vwapDist: 0.0015 }],
    ['I morning + beyondPrev', { ...bestEx, _endM: 690, _beyondPrev: true }],
    ['J morning + retest', { ...bestEx, _endM: 690, _retest: true }],
    ['K morning + VWAP 0.15% + retest', { ...bestEx, _endM: 690, _vwapDist: 0.0015, _retest: true }],
    ['L morning + VWAP 0.15% + beyondPrev', { ...bestEx, _endM: 690, _vwapDist: 0.0015, _beyondPrev: true }],
  ];
  const fRows = F.map(([n, c]) => ({ n, c, s: stats(run0(c), c, years) }));
  for (const { n, s } of fRows) line(n, s);

  if (realDays.length) {
    console.log(`\n— the same, on REAL 0DTE option prices (${realDays.length} days) —\n` + H);
    line('A now', stats(runR(own), own, realDays.length / 252));
    for (const [n, c] of F) line(n, stats(runR(c), c, realDays.length / 252));
  }
  // ---- next-day expiry (the studied instrument), same entry filters, via the same engine ----
  const { loadReal, realPricer } = await import('./spy-study.mjs');
  const real1 = loadReal();
  const dys1 = days.filter(D => D.next);
  const k1 = calibrate(dys1, real1).k;
  console.log(`\nnext-day model calibration: volatility = ${k1} × VIX`);
  const d1 = { ...own, spyTp: 5, spyStop: 35, spyHoldMin: 60, spyEnd: '15:00', _dte1: true };
  const yrs1 = dys1.length / 252;
  const run1 = c => dys1.flatMap(D => runDay0(D, DCs.get(D.d), c, modelPricer(D, k1)));
  const r1Days = dys1.filter(D => real1[D.d]);
  const run1R = c => r1Days.flatMap(D => runDay0(D, DCs.get(D.d), c, realPricer(D, real1[D.d])));
  const F1 = [
    ['Z next-day tp5/35/60 (with fast-fill cost)', d1],
    ['Z1 morning only (no entries after 11:30)', { ...d1, _endM: 690 }],
    ['Z2 entries to 13:30', { ...d1, _endM: 810 }],
    ['Z3 VWAP gap ≥ 0.15%', { ...d1, _vwapDist: 0.0015 }],
    ['Z4 beyond yesterday’s high/low', { ...d1, _beyondPrev: true }],
    ['Z5 retest: buy the pullback to the level', { ...d1, _retest: true }],
    ['Z6 morning + VWAP 0.15%', { ...d1, _endM: 690, _vwapDist: 0.0015 }],
    ['Z7 morning + retest', { ...d1, _endM: 690, _retest: true }],
    ['Z8 VWAP 0.15% + retest', { ...d1, _vwapDist: 0.0015, _retest: true }],
    ['Z9 morning + VWAP 0.15% + beyondPrev', { ...d1, _endM: 690, _vwapDist: 0.0015, _beyondPrev: true }],
    ['Z10 tp10 on Z6', { ...d1, spyTp: 10, _endM: 690, _vwapDist: 0.0015 }],
    ['Z11 tp15 on Z6', { ...d1, spyTp: 15, _endM: 690, _vwapDist: 0.0015 }],
  ];
  console.log('\n— NEXT-day expiry (model, all days; entries pay the fast-fill cushion like his setting) —\n' + H);
  const z = F1.map(([n, c]) => ({ n, c, s: stats(run1(c), c, yrs1) }));
  for (const { n, s } of z) line(n, s);
  console.log(`\n— the same on REAL next-day option prices (${r1Days.length} days) —\n` + H);
  for (const [n, c] of F1) line(n, stats(run1R(c), c, r1Days.length / 252));
  console.log('\n— finalists on REAL prices WITHOUT the fast-fill cushion (entries at the ask, as the October study measured) —\n' + H);
  globalThis.__noFast = true;
  for (const [n, c] of F1) line(n + ' (ask only)', stats(run1R(c), c, r1Days.length / 252));
  globalThis.__noFast = false;
}
