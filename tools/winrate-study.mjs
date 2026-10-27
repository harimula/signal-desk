// Win-rate study for the RSI-2 stock rule: which entry and exit rules raise the share of winning trades, and what each costs
// in profit. Reads the price history that tools/research-data.mjs saved (branch `research-data`, folder research-data/).
//   node tools/winrate-study.mjs [grid]     grid = quick | full (default quick); DATA=<folder> to read from elsewhere
// Portfolio simulation as in bot/research.mjs (cash + positions, entries before exits on the same day, 0.05% per side),
// with the bot's own entry modes: next open, a limit below yesterday's close, or intraday when the live price crosses the
// RSI-2 trigger (the bot's "intraday" setting). Every figure is before tax. Survivorship bias flatters every rule equally.
import fs from 'node:fs';
import zlib from 'node:zlib';

const DIR = process.env.DATA || 'research-data';
const load = f => JSON.parse(zlib.gunzipSync(fs.readFileSync(`${DIR}/${f}`)).toString());
const COST = 0.0005;

// ---- data: day numbers → one calendar (SPY's), every symbol aligned to it ----
export function loadDaily() {
  const raw = load('daily.json.gz'), out = {};
  for (const [s, b] of Object.entries(raw.bars)) {
    let d = 0; const days = b.d.map(x => (d += x)), cut = Math.floor((Date.parse(raw.at) - 5 * 3600e3) / 864e5);   // drop the download day's unfinished bar
    let n = days.length; while (n && days[n - 1] >= cut) n--;
    out[s] = { days: days.slice(0, n), o: b.o.slice(0, n), h: b.h.slice(0, n), l: b.l.slice(0, n), c: b.c.slice(0, n), v: b.v.slice(0, n) };
  }
  return { base: raw.base, scan: raw.scan, bars: out };
}
export function prepare(bars, syms, spyKey = 'SPY') {
  const spy = bars[spyKey], cal = spy.days, T = cal.length, pos = new Map(cal.map((d, i) => [d, i]));
  const S = {};
  for (const s of syms) {
    const b = bars[s]; if (!b || b.c.length < 260) continue;
    const n = b.c.length, ix = new Int32Array(T).fill(-1);
    for (let i = 0; i < n; i++) { const t = pos.get(b.days[i]); if (t != null) ix[t] = i; }
    const C = b.c, s200 = new Float64Array(n).fill(NaN), s5 = new Float64Array(n).fill(NaN), r2 = new Float64Array(n).fill(NaN), sum199 = new Float64Array(n).fill(NaN);
    let a = 0; for (let i = 0; i < n; i++) { a += C[i]; if (i >= 200) a -= C[i - 200]; if (i >= 199) s200[i] = a / 200; }
    let a199 = 0; for (let i = 0; i < n; i++) { a199 += C[i]; if (i >= 199) a199 -= C[i - 199]; if (i >= 198) sum199[i] = a199; }
    let a5 = 0; for (let i = 0; i < n; i++) { a5 += C[i]; if (i >= 5) a5 -= C[i - 5]; if (i >= 4) s5[i] = a5 / 5; }
    for (let i = 3; i < n; i++) r2[i] = rsi2At(C[i - 2], C[i - 1], C[i]);
    S[s] = { ix, o: b.o, h: b.h, l: b.l, c: C, s200, s5, r2, sum199, n };
  }
  return { cal, T, S, spy: { c: spy.c, s200: (() => { const r = new Float64Array(T).fill(NaN); let a = 0; for (let i = 0; i < T; i++) { a += spy.c[i]; if (i >= 200) a -= spy.c[i - 200]; if (i >= 199) r[i] = a / 200; } return r; })() } };
}
// RSI-2 exactly as bot/strategy.mjs computes it: the last two day-to-day moves, simple averages.
export function rsi2At(c0, c1, c2) {
  let g = 0, l = 0; const d1 = c1 - c0, d2 = c2 - c1;
  if (d1 >= 0) g += d1; else l -= d1; if (d2 >= 0) g += d2; else l -= d2;
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
// The highest price today at which RSI-2 is below thr, given the last two completed closes (closed form of rsi2Trigger).
export function triggerBelow(c0, c1, thr) {
  const d1 = c1 - c0;
  if (d1 >= 0) return c1 - d1 * (100 / thr - 1) - 1e-9;                     // needs a fall big enough to outweigh yesterday's rise
  return c1 + (-d1) * thr / (100 - thr) - 1e-9;                             // yesterday fell: even a small rise keeps it low
}

// ---- one portfolio run ----
// p: { thr, entry: 'open'|'intraday'|'limit', lim (fraction below yesterday's close), exit, m (profit margin), hold,
//      stop (fraction, 0 = none), tp (fraction, 0 = none), mkt (SPY above its 200-day), rank: 'leaders'|'dip', pos, maxPos }
export function run(P, p, from = 0, to = Infinity) {
  const { cal, T, S, spy } = P, syms = Object.keys(S);
  let cash = 1, open = [];
  const eq = [], trades = [];
  const firstAt = d => { const k = cal.findIndex(x => x >= d); return k < 0 ? T : k; };
  const t0 = Math.max(1, firstAt(from)), t1 = to === Infinity ? T : Math.max(t0 + 1, firstAt(to));
  for (let t = t0; t < t1; t++) {
    const startOpen = open.slice();
    const equityPrev = cash + open.reduce((s, q) => s + q.sh * q.px, 0);
    // 1) entries (decided from yesterday's close; intraday entries trigger during today)
    const mktOk = !p.mkt || spy.c[t - 1] > spy.s200[t - 1];
    if (mktOk && p.entry !== 'close') {
      const cands = [];
      for (const s of syms) {
        const X = S[s], i = X.ix[t - 1], j = X.ix[t]; if (i < 205 || j !== i + 1 || open.some(q => q.s === s)) continue;
        let fill = null, rank = 0;
        if (p.entry === 'intraday') {
          const trig = triggerBelow(X.c[i - 1], X.c[i], p.thr); if (!(X.l[j] <= trig)) continue;
          fill = Math.min(X.o[j], trig); if (!(fill > X.sum199[i] / 199)) continue;      // still above its 200-day average with today's price
          rank = rsi2At(X.c[i - 1], X.c[i], fill);
        } else {
          if (!(X.c[i] > X.s200[i] && X.r2[i] < p.thr)) continue;
          rank = X.r2[i];
          if (p.entry === 'limit') { const lp = X.c[i] * (1 - p.lim); if (!(X.l[j] <= lp)) continue; fill = Math.min(X.o[j], lp); }
          else { if (p.skipBounce && X.o[j] > X.c[i] * 1.01) continue; fill = X.o[j]; }   // skipBounce: the bot skips a dip that already bounced 1%+ above yesterday's close
        }
        if (p.rank === 'leaders') { const k = i - 60; const m = spy.c[t - 1] / spy.c[t - 61] - 1; rank = k >= 0 ? -((X.c[i] / X.c[k] - 1) - m) : 0; }
        if (p.rank === 'first' && p.entry === 'intraday') {     // time order, as the live bot fills: dips already below their level when entries open come first (leaders first among them), then the smaller the fall still needed from the open, the earlier
          const k = i - 60, m = spy.c[t - 1] / spy.c[t - 61] - 1, lead = k >= 0 ? -((X.c[i] / X.c[k] - 1) - m) : 0, wait = (X.o[j] - fill) / X.o[j];
          rank = (wait < 0.001 ? 0 : wait) + lead * 1e-6;
        }
        cands.push({ s, fill, rank, j });
      }
      cands.sort((a, b) => a.rank - b.rank);
      let taken = 0;
      for (const c of cands) {
        if (open.length + taken >= p.maxPos) break;
        const alloc = equityPrev * p.pos; if (alloc > cash) break;
        const X = S[c.s], sh = alloc / (c.fill * (1 + COST)); cash -= alloc; taken++;
        const q = { s: c.s, sh, px: X.c[c.j], entry: c.fill, held: 0, d0: t, stop: p.stop ? c.fill * (1 - p.stop) : 0, tp: p.tp ? c.fill * (1 + p.tp) : 0 };
        // the day of the buy: a next-open buy can hit its stop or target the same day; an intraday/limit buy (made on the dip)
        // only its stop, judged at the close
        if (p.entry === 'open' && q.stop && X.l[c.j] <= q.stop) close(q, Math.min(X.o[c.j], q.stop), t, 'stop');
        else if (p.entry === 'open' && q.tp && X.h[c.j] >= q.tp) close(q, Math.max(X.o[c.j], q.tp), t, 'tp');
        else if (p.entry !== 'open' && q.stop && X.c[c.j] <= q.stop) close(q, X.c[c.j], t, 'stop');
        else open.push(q);
      }
    }
    // 2) positions from before today: stop, target, then the rule exit at the close
    for (const q of startOpen) {
      const X = S[q.s], j = X.ix[t]; if (j < 0) continue;
      q.held++;
      if (q.stop && X.l[j] <= q.stop) { close(q, Math.min(X.o[j], q.stop), t, 'stop'); continue; }
      if (q.tp && X.h[j] >= q.tp) { close(q, Math.max(X.o[j], q.tp), t, 'tp'); continue; }
      const C = X.c[j], why = exitRule(p, X, j, q);
      if (why) { close(q, C, t, why); continue; }
      if (q.held >= p.hold) { close(q, C, t, 'time'); continue; }
      q.px = C;
    }
    open = open.filter(q => !q.done);
    // 3) entry 'close': buy in the last minutes on today's (near-)close prices, among ALL of today's dips — the sells made at this
    //    close have already freed their slot and money (both happen in the same last minutes)
    if (p.entry === 'close' && (!p.mkt || spy.c[t] > spy.s200[t])) {
      const equityNow = cash + open.reduce((s, q) => s + q.sh * q.px, 0), cands = [];
      for (const s of syms) {
        const X = S[s], j = X.ix[t]; if (j < 205 || open.some(q => q.s === s)) continue;
        if (!(X.c[j] > X.s200[j] && X.r2[j] < p.thr)) continue;
        let rank = X.r2[j];
        if (p.rank === 'leaders') { const k = j - 60, m = spy.c[t] / spy.c[t - 60] - 1; rank = k >= 0 ? -((X.c[j] / X.c[k] - 1) - m) : 0; }
        cands.push({ s, rank, j });
      }
      cands.sort((a, b) => a.rank - b.rank);
      for (const c of cands) {
        if (open.length >= p.maxPos) break;
        const alloc = equityNow * p.pos; if (alloc > cash) break;
        const X = S[c.s], f = X.c[c.j]; cash -= alloc;
        open.push({ s: c.s, sh: alloc / (f * (1 + COST)), px: f, entry: f, held: 0, d0: t, stop: p.stop ? f * (1 - p.stop) : 0, tp: p.tp ? f * (1 + p.tp) : 0 });
      }
    }
    eq.push(cash + open.reduce((s, q) => s + q.sh * q.px, 0));
  }
  function close(q, px, t, why) { cash += q.sh * px * (1 - COST); trades.push({ r: (px * (1 - COST)) / (q.entry * (1 + COST)) - 1, why, days: t - q.d0, t, s: q.s }); q.done = true; }
  return { eq, trades, from: cal[t0], to: cal[t1 - 1], days: t1 - t0 };
}
function exitRule(p, X, j, q) {
  const C = X.c[j];
  switch (p.exit) {
    case 'sma5': return C > X.s5[j] ? 'rule' : null;                                      // the bot today
    case 'upclose': return C > X.c[j - 1] ? 'rule' : null;                                // first up close
    case 'prevhigh': return C > X.h[j - 1] ? 'rule' : null;                               // close above yesterday's high
    case 'rsi70': return X.r2[j] > 70 ? 'rule' : null;
    case 'profit': return C >= q.entry * (1 + p.m) ? 'rule' : null;                       // first close at a profit
    case 'sma5profit': return C > X.s5[j] && C >= q.entry * (1 + p.m) ? 'rule' : null;   // bounce done AND at a profit
    case 'sma5orprofit': return C > X.s5[j] || C >= q.entry * (1 + p.m) ? 'rule' : null;
    default: throw new Error('exit ' + p.exit);
  }
}
// ---- CALL options on the same dips, priced with Black-Scholes (no option-price history for 33 years) ----
// Volatility = ivMult × the stock's last-20-day realised volatility (15%..150%), held fixed during the trade; buying pays
// `spread` above the model price and selling receives `spread` below it. One option at a time per stock; no money limits —
// this measures each trade, not a portfolio. o: { tp, stop, exit: 'sma5'|'stockProfit'|'optProfit', m, x, hold, dte, ivMult, spread }
const Nd = x => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), y = 1 - 0.3989423 * Math.exp(-x * x / 2) * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x >= 0 ? y : 1 - y; };
export function bsCall(S, K, T, v) { if (T <= 0) return Math.max(0, S - K); const s = v * Math.sqrt(T), d1 = (Math.log(S / K) + s * s / 2) / s; return S * Nd(d1) - K * Nd(d1 - s); }
export function optionStudy(P, p, o, from = 0) {
  const { cal, T, S, spy } = P, out = [];
  for (const s of Object.keys(S)) {
    const X = S[s]; let busyUntil = -1;
    for (let t = Math.max(1, cal.findIndex(d => d >= from)); t < T; t++) {
      if (t <= busyUntil) continue;
      const i = X.ix[t - 1], j = X.ix[t]; if (i < 205 || j !== i + 1) continue;
      if (p.mkt && !(spy.c[t - 1] > spy.s200[t - 1])) continue;
      const trig = triggerBelow(X.c[i - 1], X.c[i], p.thr); if (!(X.l[j] <= trig)) continue;
      const S0 = Math.min(X.o[j], trig); if (!(S0 > X.sum199[i] / 199)) continue;
      let m = 0, v2 = 0; for (let k = i - 19; k <= i; k++) { const r = Math.log(X.c[k] / X.c[k - 1]); m += r; v2 += r * r; }
      const vol = Math.min(1.5, Math.max(0.15, o.ivMult * Math.sqrt(Math.max(0, v2 / 20 - (m / 20) ** 2) * 252)));
      const K = S0, d0 = cal[t], exp = d0 + o.dte, c0 = bsCall(S0, K, o.dte / 365, vol) * (1 + o.spread);
      let res = null;
      for (let u = t + 1, held = 1; u < T && !res; u++, held++) {
        const jj = X.ix[u]; if (jj < 0) continue;
        const left = (exp - cal[u]) / 365, val = px => bsCall(px, K, left, vol), sell = px => val(px) * (1 - o.spread);
        if (o.stop && val(X.l[jj]) <= c0 * (1 - o.stop)) res = { r: Math.min(val(X.o[jj]), c0 * (1 - o.stop)) * (1 - o.spread) / c0 - 1, why: 'stop', u };
        else if (o.tp && val(X.h[jj]) >= c0 * (1 + o.tp)) res = { r: Math.max(val(X.o[jj]), c0 * (1 + o.tp)) / c0 - 1, why: 'tp', u };
        else {
          const C = X.c[jj], rule = o.exit === 'sma5' ? C > X.s5[jj] : o.exit === 'stockProfit' ? C >= S0 * (1 + o.m) : sell(C) >= c0 * (1 + o.x);
          if (rule) res = { r: sell(C) / c0 - 1, why: 'rule', u };
          else if (held >= o.hold || exp - cal[u] <= 3 * 7 / 5) res = { r: sell(C) / c0 - 1, why: 'time', u };
        }
      }
      if (res) { out.push(res); busyUntil = res.u; }
    }
  }
  const n = out.length, w = out.filter(x => x.r > 0);
  return { n, win: n ? w.length / n * 100 : 0, exp: n ? out.reduce((a, b) => a + b.r, 0) / n * 100 : 0, avgW: w.length ? w.reduce((a, b) => a + b.r, 0) / w.length * 100 : 0, avgL: n - w.length ? out.filter(x => x.r <= 0).reduce((a, b) => a + b.r, 0) / (n - w.length) * 100 : 0, why: out.reduce((q, x) => (q[x.why] = (q[x.why] || 0) + 1, q), {}) };
}
export function summarize(res) {
  const { eq, trades, days } = res, n = trades.length, w = trades.filter(x => x.r > 0), l = trades.filter(x => x.r <= 0);
  const gw = w.reduce((a, b) => a + b.r, 0), gl = -l.reduce((a, b) => a + b.r, 0), yrs = days / 252;
  let pk = 1, dd = 0; for (const x of eq) { pk = Math.max(pk, x); dd = Math.max(dd, 1 - x / pk); }
  return { n, win: n ? w.length / n * 100 : 0, avgW: w.length ? gw / w.length * 100 : 0, avgL: l.length ? -gl / l.length * 100 : 0, exp: n ? (gw - gl) / n * 100 : 0, pf: gl > 0 ? gw / gl : 99,
    cagr: ((eq[eq.length - 1] || 1) ** (1 / Math.max(yrs, 0.1)) - 1) * 100, dd: dd * 100, hold: n ? trades.reduce((a, b) => a + b.days, 0) / n : 0, perYr: n / Math.max(yrs, 0.1),
    worst: n ? Math.min(...trades.map(x => x.r)) * 100 : 0, why: trades.reduce((o, x) => (o[x.why] = (o[x.why] || 0) + 1, o), {}) };
}

// ---- driver ----
if (import.meta.url === `file://${process.argv[1]}`) {
  const D = loadDaily(), grid = process.argv[2] || 'quick';
  const dn = s => Math.round(Date.parse(s + 'T00:00:00Z') / 864e5);
  const U = { base: prepare(D.bars, D.base), scan: prepare(D.bars, D.scan) };
  const OWN = { thr: 25, entry: 'intraday', lim: 0, exit: 'sma5', m: 0, hold: 10, stop: 0.25, tp: 0.10, mkt: false, rank: 'leaders', pos: 0.12, maxPos: 8 };
  const periods = [['all', 0, Infinity], ['oos', dn('2016-01-01'), Infinity], ['5y', dn('2021-10-27'), Infinity]];
  const row = (name, p) => {
    const out = { name };
    for (const [u, P] of Object.entries(U)) for (const [k, a, b] of periods) { if (u === 'scan' && k === 'all') continue; out[u + '.' + k] = summarize(run(P, p, a, b)); }
    return out;
  };
  const f1 = x => (x >= 0 ? '+' : '') + x.toFixed(1);
  const show = r => { const a = r['base.all'], o = r['base.oos'], f = r['base.5y'], s = r['scan.oos'], g = r['scan.5y'];
    console.log([r.name.padEnd(44), `${a.win.toFixed(1)}%`.padStart(6), `${a.exp >= 0 ? '+' : ''}${a.exp.toFixed(2)}`.padStart(6), String(a.n).padStart(5), f1(a.cagr).padStart(6), ('-' + a.dd.toFixed(0)).padStart(4), '|', `${o.win.toFixed(1)}%`.padStart(6), f1(o.cagr).padStart(6), '|', `${f.win.toFixed(1)}%`.padStart(6), f1(f.cagr).padStart(6), ('-' + f.dd.toFixed(0)).padStart(4), '|', `${s.win.toFixed(1)}%`.padStart(6), f1(s.cagr).padStart(6), '|', `${g.win.toFixed(1)}%`.padStart(6), f1(g.cagr).padStart(6), ('-' + g.dd.toFixed(0)).padStart(4), a.hold.toFixed(1).padStart(5), f1(a.worst).padStart(6)].join(' ')); };
  console.log('rule'.padEnd(44), '  base 1993+: win  exp/tr  trades cagr  dd | 2016+: win cagr | 5y: win cagr dd | scan 2016+: win cagr | scan 5y: win cagr dd | hold worst');
  const variants = [];
  const add = (name, over) => variants.push([name, { ...OWN, ...over }]);
  if (grid === 'quick') {
    add('your settings now', {});
    add('tested rule (buy<10, next open)', { thr: 10, entry: 'open' });
    for (const thr of [25, 10, 5]) for (const ex of [['sma5', 0], ['profit', 0.005], ['profit', 0.01], ['sma5profit', 0.005], ['upclose', 0], ['prevhigh', 0], ['rsi70', 0]])
      add(`buy<${thr} intraday, exit ${ex[0]}${ex[1] ? ' ' + ex[1] * 100 + '%' : ''}`, { thr, exit: ex[0], m: ex[1] });
  }
  if (grid === 'entry') {
    for (const thr of [25, 10, 5]) for (const [en, lim] of [['intraday', 0], ['open', 0], ['limit', 0.01], ['limit', 0.02], ['limit', 0.03], ['limit', 0.05]])
      for (const ex of [['sma5', 0], ['profit', 0.005]]) add(`buy<${thr} ${en}${lim ? ' -' + lim * 100 + '%' : ''}, ${ex[0]}`, { thr, entry: en, lim, exit: ex[0], m: ex[1] });
  }
  const THR = +(process.env.THR || 25);
  if (grid === 'risk') {
    for (const ex of [['sma5', 0], ['profit', 0.005], ['sma5profit', 0.005]]) for (const hold of [10, 15, 20, 30]) for (const stop of [0.25, 0.15, 0.10, 0]) for (const mkt of [false, true])
      add(`buy<${THR} ${ex[0]} hold${hold} stop${stop * 100}${mkt ? ' mkt' : ''}`, { thr: THR, exit: ex[0], m: ex[1], hold, stop, mkt });
  }
  if (grid === 'refine') {
    add('your settings now', {});
    for (const m of [0.0025, 0.005, 0.01]) for (const hold of [12, 15]) for (const stop of [0.25, 0.20, 0.15]) for (const tp of [0.10, 0])
      add(`profit+${m * 100}% hold${hold} stop${stop * 100} tp${tp * 100} mkt`, { exit: 'profit', m, hold, stop, tp, mkt: true });
  }
  if (grid === 'calls') {
    const sig = { thr: 25, mkt: true };
    const base = { tp: 0.5, stop: 0.5, exit: 'sma5', m: 0, x: 0, hold: 15, dte: 24, ivMult: 1.2, spread: 0.02 };
    const tests = [['now: +50% / -50% / stock SMA5 exit', {}], ['stock first close +0.5%', { exit: 'stockProfit', m: 0.005 }], ['stock first close +1%', { exit: 'stockProfit', m: 0.01 }]];
    for (const x of [0.05, 0.10, 0.20]) for (const [tp, stop] of [[0.5, 0.5], [0.5, 0], [0.3, 0.5], [0.5, 0.7]]) for (const hold of [5, 10, 15]) tests.push([`option first close +${x * 100}%, tp ${tp * 100} stop ${stop * 100} hold ${hold}`, { exit: 'optProfit', x, tp, stop, hold }]);
    console.log('\nCALLs on the same dips (model prices) — trades, win %, average result per trade (% of premium), avg win, avg loss');
    for (const [u, P] of Object.entries(U)) for (const [name, over] of tests) {
      const r = optionStudy(P, sig, { ...base, ...over }, u === 'scan' ? dn('2016-01-01') : 0);
      console.log(`${u.padEnd(5)} ${name.padEnd(50)} ${String(r.n).padStart(6)} ${r.win.toFixed(1).padStart(5)}% ${(r.exp >= 0 ? '+' : '') + r.exp.toFixed(1)}% ${r.avgW.toFixed(1)} ${r.avgL.toFixed(1)} ${JSON.stringify(r.why)}`);
    }
  }
  if (grid === 'report') {                                    // the markdown table in bot/winrate_report.md
    // intraday buys are filled in time order (see rank 'first'): the realistic model for the live bot
    const F = { rank: 'first' };
    const R = [['Your settings until 2026-10-27 (sell on the bounce, 10-day hold)', F],
      ['Bounce + market filter', { ...F, mkt: true }],
      ['First close +0.5%, 10-day hold', { ...F, exit: 'profit', m: 0.005 }],
      ['First close +0.5%, 15-day hold', { ...F, exit: 'profit', m: 0.005, hold: 15 }],
      ['**First close +0.5%, 15-day hold, market filter (new settings)**', { ...F, exit: 'profit', m: 0.005, hold: 15, mkt: true }],
      ['First close +0.25%, 15-day hold, market filter', { ...F, exit: 'profit', m: 0.0025, hold: 15, mkt: true }],
      ['First close +1%, 15-day hold, market filter', { ...F, exit: 'profit', m: 0.01, hold: 15, mkt: true }],
      ['First close +0.5%, 20-day hold, market filter', { ...F, exit: 'profit', m: 0.005, hold: 20, mkt: true }],
      ['New settings, buying the next morning instead (intraday off)', { exit: 'profit', m: 0.005, hold: 15, mkt: true, entry: 'open', skipBounce: true }],
      ['New settings with buy level 10', { ...F, thr: 10, exit: 'profit', m: 0.005, hold: 15, mkt: true }],
      ['New settings, optimistic fill order (best-ranked dips of the whole day)', { exit: 'profit', m: 0.005, hold: 15, mkt: true }],
      ['Until 2026-10-27, optimistic fill order', {}]];
    const pc = x => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(1) + '%';
    console.log('| Rule | Won | Avg win | Avg loss | Avg trade | Trades/yr | Per year 1993–2026 | Worst fall | Per year 2016–26 | Per year last 5 | Worst fall last 5 | Scan list 2016–26: won · per year |\n|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const [name, over] of R) { const r = row(name, { ...OWN, ...over }), a = r['base.all'], o = r['base.oos'], f = r['base.5y'], sc = r['scan.oos'];
      console.log(`| ${name} | ${a.win.toFixed(1)}% | ${pc(a.avgW)} | ${pc(a.avgL)} | ${(a.exp >= 0 ? '+' : '−') + Math.abs(a.exp).toFixed(2)}% | ${Math.round(a.perYr)} | ${pc(a.cagr)} | −${a.dd.toFixed(0)}% | ${pc(o.cagr)} | ${pc(f.cagr)} | −${f.dd.toFixed(0)}% | ${sc.win.toFixed(1)}% · ${pc(sc.cagr)} |`); }
  }
  if (process.env.ONLY) for (const v of JSON.parse(process.env.ONLY)) add(v.name, v);
  for (const [name, p] of variants) show(row(name, p));
  // year by year for chosen rules: YEARS='[{"name":..., ...params}]'
  if (process.env.YEARS) for (const v of JSON.parse(process.env.YEARS)) for (const [u, P] of Object.entries(U)) {
    const p = { ...OWN, ...v }, res = run(P, p), yrs = {};
    for (const tr of res.trades) { const y = new Date(P.cal[tr.t] * 864e5).getUTCFullYear(); (yrs[y] = yrs[y] || []).push(tr.r); }
    let prevEq = 1, k = 0; const eqY = {}; for (let t = 1; t < P.T; t++) { const y = new Date(P.cal[t] * 864e5).getUTCFullYear(); eqY[y] = res.eq[k] / prevEq - 1; if (t + 1 < P.T && new Date(P.cal[t + 1] * 864e5).getUTCFullYear() !== y) prevEq = res.eq[k]; k++; }
    console.log(`\n${v.name} — ${u}: year  trades  win%  return`);
    for (const y of Object.keys(yrs)) { const a = yrs[y]; console.log(`  ${y} ${String(a.length).padStart(5)} ${(a.filter(x => x > 0).length / a.length * 100).toFixed(1).padStart(5)}% ${((eqY[y] || 0) * 100).toFixed(1).padStart(6)}%`); }
  }
}
