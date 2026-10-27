// SPY quick-options study: replays the bot's SPY rule (bot/spyopt.mjs) on SPY one-minute bars from 2023 and measures each
// trade's result for a next-day CALL or PUT. Option prices come from a model (Black-Scholes, volatility = k × the VIX,
// calibrated on real option bars), and — for the last ~60 trading days — also from real option minute bars, so the
// model can be checked against reality. Reads research-data/ (tools/research-data.mjs).
//   node tools/spy-study.mjs            calibration, the model-vs-real check, then a grid of settings
import fs from 'node:fs';
import zlib from 'node:zlib';
import { SPY_DEFAULTS, spySignal } from '../bot/spyopt.mjs';   // exits are replayed inline on minute highs and lows (stop first when both are touched)

const DIR = process.env.DATA || 'research-data';
const load = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(`${DIR}/${f}`)).toString());
const HALF = 0.005;                                         // half the bid/ask spread on a next-day SPY option (~$0.01-0.02 on $2-3)

// ---- minute bars → days of {m (ET minutes), o,h,l,c,v} ----
const offCache = {};
const etMins = ms => {
  const day = new Date(ms).toISOString().slice(0, 10);
  if (offCache[day] == null) { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(day + 'T16:00:00Z')).map(x => [x.type, x.value])); offCache[day] = (+p.hour % 24) * 60 + +p.minute - 16 * 60; }
  const u = new Date(ms); return ((u.getUTCHours() * 60 + u.getUTCMinutes() + offCache[day]) % 1440 + 1440) % 1440;
};
export function loadSpy() {
  const raw = load('spy1m.json.gz').bars, days = new Map();
  let t = 0;
  for (let i = 0; i < raw.t.length; i++) {
    t += raw.t[i]; const ms = t * 60000, d = new Date(ms).toISOString().slice(0, 10);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push({ t, m: etMins(ms), o: raw.o[i], h: raw.h[i], l: raw.l[i], c: raw.c[i], v: raw.v[i] });
  }
  const daily = load('daily.json.gz').bars, vix = new Map(); let dn = 0;
  daily['^VIX'].d.forEach((x, i) => { dn += x; vix.set(new Date((dn) * 864e5).toISOString().slice(0, 10), daily['^VIX'].c[i]); });
  const list = [...days.keys()].sort();
  return list.map((d, k) => ({ d, next: list[k + 1] || null, bars: days.get(d).filter(b => b.m >= 570 && b.m < 960), vix: prevVal(vix, d) }));
}
function prevVal(map, d) { let best = null, bd = ''; for (const [k, v] of map) if (k < d && k > bd) { bd = k; best = v; } return best; }

// ---- option model ----
const Nd = x => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), y = 1 - 0.3989423 * Math.exp(-x * x / 2) * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x >= 0 ? y : 1 - y; };
export function bs(S, K, T, v, call) {
  if (T <= 0) return Math.max(0, call ? S - K : K - S);
  const s = v * Math.sqrt(T), d1 = (Math.log(S / K) + s * s / 2) / s, d2 = d1 - s;
  return call ? S * Nd(d1) - K * Nd(d2) : K * Nd(-d2) - S * Nd(-d1);
}
// time to a next-trading-day 4 PM expiry, in trading years: the rest of today + the night + one session (+ a little per extra calendar day)
export const yearsLeft = (m, day, next) => { const extra = Math.max(0, (Date.parse(next) - Date.parse(day)) / 864e5 - 1); return (Math.max(0, 960 - m) / 390 + 0.3 + 1 + 0.15 * extra) / 252; };

// ---- real option bars (last ~60 days) ----
export function loadReal() {
  const raw = load('spyopt.json.gz').bars, by = {};
  for (const [sym, b] of Object.entries(raw)) {
    const m = /^SPY(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(sym); if (!m) continue;
    const day = b.day, rec = by[day] || (by[day] = {}), map = new Map();
    for (let i = 0; i < b.t.length; i++) map.set(b.t[i], { o: b.o[i], h: b.h[i], l: b.l[i], c: b.c[i] });
    rec[sym] = { K: +m[5] / 1000, call: m[4] === 'C', bars: map };
  }
  return by;
}

// calibrate k (option volatility = k × VIX) on near-the-money real bars
export function calibrate(days, real) {
  const pts = [];
  for (const D of days) {
    const R = real[D.d]; if (!R || !D.next || !D.vix) continue;
    const spot = new Map(D.bars.map(b => [b.t, b]));
    for (const o of Object.values(R)) for (const [t, ob] of o.bars) {
      const s = spot.get(t); if (!s || Math.abs(s.c - o.K) > 1.5 || ob.c < 0.2) continue;
      pts.push({ S: s.c, K: o.K, T: yearsLeft(s.m, D.d, D.next), vix: D.vix / 100, call: o.call, px: ob.c, m: s.m });
    }
  }
  let best = null;
  for (let k = 0.5; k <= 1.6; k += 0.02) {
    let e = 0; for (const p of pts) { const q = bs(p.S, p.K, p.T, k * p.vix, p.call); e += Math.log(q / p.px) ** 2; }
    if (!best || e < best.e) best = { k: +k.toFixed(2), e };
  }
  const errs = pts.map(p => Math.abs(bs(p.S, p.K, p.T, best.k * p.vix, p.call) / p.px - 1)).sort((a, b) => a - b);
  return { k: best.k, n: pts.length, medErr: errs[errs.length >> 1] * 100, p90Err: errs[Math.floor(errs.length * 0.9)] * 100 };
}

// ---- one day of the bot's SPY rule ----
// cfg: the spy* settings. price(tr, minuteBar, which) returns the option price for an open trade at that minute
// ('o','h','l','c' of the underlying for the model; real bars when available), or null when unknown.
export function runDay(D, cfg, priceAt, open0) {
  const C = { ...SPY_DEFAULTS, ...cfg }, out = [], open = [], five = [], lastLvl = { call: 0, put: 0 };
  let trades = 0, streak = 0, dayPl = 0, stopped = false;
  for (const b of D.bars) {
    // 5-minute bars completed before this minute
    const m5 = b.m - (b.m % 5);
    // 1) manage open trades with this minute
    for (const tr of open) {
      if (tr.done) continue;
      const hi = priceAt(tr, b, tr.call ? 'h' : 'l'), lo = priceAt(tr, b, tr.call ? 'l' : 'h'), op = priceAt(tr, b, 'o');
      if (hi == null || lo == null || op == null) continue;
      let exitPx = null, why = null;
      if (b.m >= C.spyFlat) { exitPx = op * (1 - HALF); why = 'flat'; }
      else if (lo <= tr.entry * (1 - C.spyStop / 100)) { exitPx = Math.min(op, tr.entry * (1 - C.spyStop / 100)) * (1 - HALF); why = 'stop'; }
      else if (hi >= tr.entry * (1 + C.spyTp / 100)) { exitPx = Math.max(op, tr.entry * (1 + C.spyTp / 100)); why = 'tp'; }
      else if (b.m - tr.m >= C.spyHoldMin) { exitPx = op * (1 - HALF); why = 'time'; }
      if (exitPx != null) {
        tr.done = true; const r = exitPx / tr.entry - 1; out.push({ r, why, side: tr.call ? 'call' : 'put', m: tr.m, d: D.d });
        streak = r > 0 ? 0 : streak + 1; dayPl += r * C.spyTradePct / 100;
        if (streak >= C.spyStreak || dayPl <= -C.spyDayCap / 100) stopped = true;
      }
    }
    // 2) a new trade? (the bot's own signal function, fed the bars completed before this minute and this minute's break price)
    const done = five.filter(x => x.m + 5 <= b.m);
    if (!stopped && trades < C.spyMaxTrades && open.filter(x => !x.done).length < C.spyMaxOpen && b.m >= hhmm(C.spyStart) && b.m < hhmm(C.spyEnd) && done.length >= 4) {
      const last3 = done.slice(-3), hiL = Math.max(...last3.map(x => x.h)), loL = Math.min(...last3.map(x => x.l));
      for (const [px, side] of [[b.h > hiL ? Math.max(b.o, hiL + 0.01) : null, 'call'], [b.l < loL ? Math.min(b.o, loL - 0.01) : null, 'put']]) {
        if (px == null) continue;
        const sig = spySignal({ bars: done, px, mins: b.m, cfg: C });
        if (!sig || sig.side !== side) continue;
        if (!(lastLvl[side] === 0 || (side === 'call' ? sig.level > lastLvl[side] : sig.level < lastLvl[side]))) continue;   // a fresh break only
        const tr = { call: side === 'call', m: b.m, S: px, K: Math.round(px), t: b.t };
        const e = open0(tr, b); if (e == null) continue;
        tr.entry = e * (1 + HALF); open.push(tr); trades++; lastLvl[side] = sig.level;
        break;
      }
    }
    // 3) fold this minute into its 5-minute bar
    const cur = five[five.length - 1];
    if (cur && cur.m === m5) { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; }
    else five.push({ m: m5, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
  }
  return out;
}
const hhmm = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };

export function modelPricer(D, k) {
  const v = k * D.vix / 100;
  return {
    open0: (tr, b) => bs(tr.S, tr.K, yearsLeft(b.m, D.d, D.next), v, tr.call),
    priceAt: (tr, b, w) => bs(b[w], tr.K, yearsLeft(b.m, D.d, D.next), v, tr.call),
  };
}
export function realPricer(D, R) {
  const occ = (call, K) => `SPY${D.next.slice(2, 4)}${D.next.slice(5, 7)}${D.next.slice(8, 10)}${call ? 'C' : 'P'}${String(Math.round(K * 1000)).padStart(8, '0')}`;
  const lastPx = new Map();
  const at = (tr, b, w) => {
    const o = R[occ(tr.call, tr.K)]; if (!o) return null;
    const bar = o.bars.get(b.t);
    if (bar) { lastPx.set(tr, bar.c); return w === 'o' ? bar.o : w === 'c' ? bar.c : (w === 'h') === tr.call ? bar.h : bar.l; }
    return lastPx.get(tr) ?? null;
  };
  return {
    open0: (tr, b) => { const o = R[occ(tr.call, tr.K)]; if (!o) return null; const bar = o.bars.get(b.t + 1) || o.bars.get(b.t); return bar ? bar.o : null; },
    priceAt: at,
  };
}
const stat = tr => { const n = tr.length, w = tr.filter(x => x.r > 0); return { n, win: n ? w.length / n * 100 : 0, exp: n ? tr.reduce((a, b) => a + b.r, 0) / n * 100 : 0, why: tr.reduce((o, x) => (o[x.why] = (o[x.why] || 0) + 1, o), {}) }; };

if (import.meta.url === `file://${process.argv[1]}`) {
  const days = loadSpy().filter(D => D.next && D.vix && D.bars.length > 300);
  const real = loadReal();
  const cal = calibrate(days, real);
  console.log(`model calibration on ${cal.n} real near-the-money minute prices: volatility = ${cal.k} × VIX, median error ${cal.medErr.toFixed(1)}%, 90% of errors under ${cal.p90Err.toFixed(1)}%`);
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync('bot/config.json', 'utf8')); } catch (e) {}
  const own = Object.fromEntries(Object.entries(cfg).filter(([k]) => k.startsWith('spy')));
  const realDays = days.filter(D => real[D.d]);
  const runAll = (list, c, how) => list.flatMap(D => { const p = how === 'real' ? realPricer(D, real[D.d]) : modelPricer(D, cal.k); return runDay(D, c, p.priceAt, p.open0); });
  const line = (name, s) => console.log(`${name.padEnd(58)} ${String(s.n).padStart(5)} ${s.win.toFixed(1).padStart(5)}%  ${(s.exp >= 0 ? '+' : '') + s.exp.toFixed(1)}%  ${JSON.stringify(s.why)}`);
  console.log(`\nsettings now (${JSON.stringify(own)})\n${''.padEnd(58)} trades  win   avg/trade  exits`);
  line(`last ${realDays.length} days, REAL option prices`, stat(runAll(realDays, own, 'real')));
  line(`same days, model prices`, stat(runAll(realDays, own, 'model')));
  line(`all ${days.length} days since ${days[0].d}, model prices`, stat(runAll(days, own, 'model')));
  console.log('\ngrid (model prices, all days)');
  const grid = [];
  for (const tp of [10, 15, 20, 30]) for (const stop of [15, 25, 40, 60]) for (const hold of [15, 30, 60]) grid.push({ ...own, spyTp: tp, spyStop: stop, spyHoldMin: hold });
  const rows = grid.map(c => ({ c, s: stat(runAll(days, c, 'model')) })).sort((a, b) => b.s.win - a.s.win);
  for (const { c, s } of rows) line(`tp ${c.spyTp} stop ${c.spyStop} hold ${c.spyHoldMin}`, s);
  if (process.env.GRID) {                                    // GRID='[{"name":..,"spyTp":..},..]': model on all days and real prices on the last ~60
    const yrs = days.length / 252, ryrs = realDays.length / 252;
    const sleeve = (tr, c, y) => tr.reduce((t, x) => t + x.r * (c.spyTradePct ?? 100) / 100, 0) / y * 100;   // % of the SPY share per year (the share is refilled from the stake every day, so it adds up rather than compounds)
    const aw = tr => { const w = tr.filter(x => x.r > 0), l = tr.filter(x => x.r <= 0); return [w.length ? w.reduce((a, b) => a + b.r, 0) / w.length * 100 : 0, l.length ? l.reduce((a, b) => a + b.r, 0) / l.length * 100 : 0]; };
    console.log(`\n${'setting'.padEnd(40)} | model ${days.length} days: trades  won  avg  avgW  avgL  sleeve/yr | real ${realDays.length} days: trades  won  avg  sleeve/yr`);
    for (const g of JSON.parse(process.env.GRID)) {
      const c = { ...own, ...g }, m = runAll(days, c, 'model'), r = runAll(realDays, c, 'real'), sm = stat(m), sr = stat(r), [w1, l1] = aw(m);
      console.log(`${(g.name || '').padEnd(40)} | ${String(sm.n).padStart(6)} ${sm.win.toFixed(1).padStart(5)}% ${(sm.exp >= 0 ? '+' : '') + sm.exp.toFixed(2)}% ${w1.toFixed(1).padStart(5)} ${l1.toFixed(1).padStart(6)} ${sleeve(m, c, yrs).toFixed(1).padStart(7)}% | ${String(sr.n).padStart(5)} ${sr.win.toFixed(1).padStart(5)}% ${(sr.exp >= 0 ? '+' : '') + sr.exp.toFixed(2)}% ${sleeve(r, c, ryrs).toFixed(1).padStart(7)}%`);
    }
  }
  if (process.env.REALGRID) { console.log('\nthe same grid on the real-price days'); for (const { c } of rows.slice(0, 15)) line(`REAL tp ${c.spyTp} stop ${c.spyStop} hold ${c.spyHoldMin}`, stat(runAll(realDays, c, 'real'))); }
}
