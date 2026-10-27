// Real-price check of the CALL / PUT exit rules (2026-10-27). The win-rate study priced single-stock options with a model;
// this replays a sample of the bot's own CALL and PUT signals since March 2024 on the real option prices (daily bars of the
// contract the bot would have bought), next to the model on the same signals. Run by .github/workflows/option-check.yml
// with the paper keys (market data only); reads research-data/daily.json.gz and writes research-data/option-check.json.
import fs from 'node:fs';
import { loadDaily, prepare, triggerBelow, triggerAbove, optionExitModel } from './winrate-study.mjs';

const KEY = process.env.ALPACA_KEY, SECRET = process.env.ALPACA_SECRET;
if (!KEY || !SECRET) { console.log('no market-data keys'); process.exit(1); }
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let calls = 0;
async function get(url) {
  for (let a = 0; a < 6; a++) {
    await sleep(320); calls++;
    let r; try { r = await fetch(url, { headers: H }); } catch (e) { await sleep(2000 * (a + 1)); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(4000 * (a + 1)); continue; }
    if (!r.ok) return { err: r.status };
    return r.json();
  }
  return { err: 'retries' };
}
const day = n => new Date(n * 864e5).toISOString().slice(0, 10);

const D = loadDaily(), P = prepare(D.bars, D.scan), { cal, S, spy } = P;
const from = cal.findIndex(d => d >= Date.parse('2024-03-01') / 864e5), to = cal.findIndex(d => d >= Date.parse('2026-09-25') / 864e5);
const THR = 25, sig = { call: [], put: [] };
for (const s of Object.keys(S)) {
  const X = S[s]; let cool = { call: -1, put: -1 };
  for (let t = from; t < to; t++) {
    const i = X.ix[t - 1], j = X.ix[t]; if (i < 205 || j !== i + 1) continue;
    if (t > cool.call && spy.c[t - 1] > spy.s200[t - 1]) {                                    // CALL: dip in an uptrend, market filter on
      const trig = triggerBelow(X.c[i - 1], X.c[i], THR);
      if (X.l[j] <= trig) { const S0 = Math.min(X.o[j], trig); if (S0 > X.sum199[i] / 199) { sig.call.push({ s, t, S0 }); cool.call = t + 10; } }
    }
    if (t > cool.put) {                                                                         // PUT: pop in a downtrend
      const trig = triggerAbove(X.c[i - 1], X.c[i], THR);
      if (X.h[j] >= trig) { const S0 = Math.max(X.o[j], trig); if (S0 < X.sum199[i] / 199) { sig.put.push({ s, t, S0 }); cool.put = t + 10; } }
    }
  }
}
const N = { call: +(process.env.N_CALL || 400), put: +(process.env.N_PUT || 200) };
const sample = (a, n) => { if (a.length <= n) return a; const step = a.length / n; return Array.from({ length: n }, (_, k) => a[Math.floor(k * step)]); };
console.log('signals', sig.call.length, 'CALL', sig.put.length, 'PUT');

const CONFIGS = [
  { key: 'now', tp: 0.5, stop: 0.5, rule: 'bounce', days: 14 },
  { key: 'tp5-stop90-target-14d', tp: 0.05, stop: 0.9, rule: 'none', days: 14 },
  { key: 'tp10-stop90-target-14d', tp: 0.10, stop: 0.9, rule: 'none', days: 14 },
  { key: 'tp5-stop90-target-30d', tp: 0.05, stop: 0.9, rule: 'none', days: 30 },
  { key: 'tp10-stop90-target-30d', tp: 0.10, stop: 0.9, rule: 'none', days: 30 },
];
const HOLD = 15, SPREAD = 0.02;
const out = { at: new Date().toISOString(), signals: { call: sig.call.length, put: sig.put.length }, results: {} };
for (const side of ['call', 'put']) {
  const list = sample(sig[side], N[side]), byDays = {};
  for (const days of [...new Set(CONFIGS.map(c => c.days))]) {
    byDays[days] = [];
    for (const g of list) {
      const d0 = cal[g.t], date = day(d0);
      let cj = null;
      for (const st of ['inactive', 'active']) {
        cj = await get(`https://paper-api.alpaca.markets/v2/options/contracts?underlying_symbols=${g.s}&type=${side}&status=${st}&expiration_date_gte=${day(d0 + days)}&expiration_date_lte=${day(d0 + days + 21)}&strike_price_gte=${(g.S0 * 0.95).toFixed(2)}&strike_price_lte=${(g.S0 * 1.05).toFixed(2)}&limit=500`);
        if (cj && (cj.option_contracts || []).length) break;
      }
      const cs = (cj && cj.option_contracts) || []; if (!cs.length) { byDays[days].push({ ...g, miss: 'contract' }); continue; }
      const ex = [...new Set(cs.map(c => c.expiration_date))].sort()[0];
      const c = cs.filter(x => x.expiration_date === ex).sort((a, b) => Math.abs(+a.strike_price - g.S0) - Math.abs(+b.strike_price - g.S0))[0];
      const bj = await get(`https://data.alpaca.markets/v1beta1/options/bars?symbols=${c.symbol}&timeframe=1Day&start=${date}&end=${ex}&limit=1000`);
      const bars = ((bj && bj.bars) || {})[c.symbol] || [];
      byDays[days].push({ ...g, sym: c.symbol, K: +c.strike_price, exp: Math.round(Date.parse(ex) / 864e5), bars: bars.map(b => ({ d: Math.round(Date.parse(b.t.slice(0, 10)) / 864e5), o: b.o, h: b.h, l: b.l, c: b.c, vw: b.vw })) });
    }
    console.log(side, days, 'days:', byDays[days].filter(x => x.bars && x.bars.length).length, 'of', list.length, 'with option prices; calls so far', calls);
  }
  // replay each configuration on the real bars, and the model on the same signals and expiry
  for (const cf of CONFIGS) {
    const real = [], model = [];
    for (const g of byDays[cf.days]) {
      if (!g.bars || !g.bars.length || g.bars[0].d !== cal[g.t]) continue;                     // the option must have traded on the signal day
      const X = S[g.s], b0 = g.bars[0], c0 = (b0.vw || (b0.o + b0.h + b0.l + b0.c) / 4) * (1 + SPREAD / 2);   // bought during the day: its average price, plus half the spread
      const byD = new Map(g.bars.map(b => [b.d, b])); let res = null, last = b0.c;
      for (let u = g.t + 1, held = 1; u < cal.length && !res; u++, held++) {
        const jj = X.ix[u]; if (jj < 0) continue;
        const b = byD.get(cal[u]), C = X.c[jj];
        if (b) {
          if (cf.stop && b.l <= c0 * (1 - cf.stop)) res = { r: Math.min(b.o, c0 * (1 - cf.stop)) * (1 - SPREAD / 2) / c0 - 1, why: 'stop' };
          else if (cf.tp && b.h >= c0 * (1 + cf.tp)) res = { r: Math.max(b.o, c0 * (1 + cf.tp)) / c0 - 1, why: 'tp' };
          last = b.c;
        }
        if (!res) {
          const rule = cf.rule === 'bounce' && (side === 'call' ? C > X.s5[jj] : C < X.s5[jj]);
          if (rule) res = { r: last * (1 - SPREAD / 2) / c0 - 1, why: 'rule' };
          else if (held >= HOLD || g.exp - cal[u] <= 3) res = { r: last * (1 - SPREAD / 2) / c0 - 1, why: 'time' };
        }
      }
      if (!res) continue;
      real.push(res);
      const m = optionExitModel(P, X, g.t, g.S0, side, { tp: cf.tp, stop: cf.stop, rule: cf.rule, x: 0, hold: HOLD, dte: g.exp - cal[g.t], ivMult: 1.2, spread: SPREAD }, g.K);
      if (m) model.push(m);
    }
    const st = a => { const n = a.length, w = a.filter(x => x.r > 0); return { n, win: n ? +(w.length / n * 100).toFixed(1) : null, avg: n ? +(a.reduce((s, x) => s + x.r, 0) / n * 100).toFixed(2) : null, avgW: w.length ? +(w.reduce((s, x) => s + x.r, 0) / w.length * 100).toFixed(1) : null, avgL: n - w.length ? +(a.filter(x => x.r <= 0).reduce((s, x) => s + x.r, 0) / (n - w.length) * 100).toFixed(1) : null }; };
    out.results[side + ' ' + cf.key] = { real: st(real), model: st(model) };
    console.log(side, cf.key, JSON.stringify(out.results[side + ' ' + cf.key]));
  }
}
fs.writeFileSync('research-data/option-check.json', JSON.stringify(out, null, 1));
console.log('api calls', calls);
