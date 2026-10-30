// Covered-call study (2026-10-30; owner: "Yes but covered calls is different right" → "Yes please"): what changes when
// the bot's own dip buys also sell a covered call, replayed trade by trade on real option prices (each contract's daily
// bars from the broker's market-data API, which go back to February 2024).
//   Baseline — the owner's stock rule on 100 shares: buy at the close of a day whose RSI-2 is under 25 with the close
//   above the 200-day average (and SPY above its own — the market filter); sell at the first close at least 0.5 % above
//   the buy price, after 15 sessions at the latest, or at the −25 % floor (a stop: filled at the floor, or the open when
//   the day gapped under it).
//   Covered — the same buy, plus one call sold the same day (or the next, when the contract did not trade): the lowest
//   strike at least X % above the price, expiring at the nearest monthly expiration at least 7 days out. The shares are
//   then frozen — the sell rule waits until the call is gone (bought back at half the premium in the tp50 variants, or
//   expired) — except the −25 % floor, which still sells: the call is bought back at that day's price first. A close
//   over the strike at expiry sells the shares at the strike (called away). Once the call is gone the stock rule
//   resumes; by then the 15-session clock has usually run out, so the shares go at the first close.
//   Prices as in wheel-study: fills at the day's average traded price ± half an assumed 4 % spread; premium ≥ $0.05.
//   Variants: X = 5 / 10 %, each held to expiry ("hold") and bought back at half ("tp50").
//   Lists: the research list's large companies ("base") and the bot's market-scan stocks ("scan") — both only while the
//   stock costs $15–$120 at the signal, because 12 % of a $100,000 stake buys 100+ shares only under about $120.
//   Signals are spaced per stock: the next one only after the slowest variant closed, like one slot per stock.
// Read-only; market data only. Writes research-data/covered-call-study.json (workflow covered-call-study.yml).
//   node tools/covered-call-study.mjs      (needs ALPACA_KEY / ALPACA_SECRET and research-data/daily.json.gz)
import fs from 'node:fs';
import { loadDaily } from './winrate-study.mjs';
import { rsi2 } from '../bot/strategy.mjs';

const KEY = process.env.ALPACA_KEY, SECRET = process.env.ALPACA_SECRET;
if (!KEY || !SECRET) { console.log('no market-data keys'); process.exit(1); }
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET };
const DATA = 'https://data.alpaca.markets', TRADE = 'https://paper-api.alpaca.markets';
const OUT = process.env.OUT || 'research-data/covered-call-study.json';
const SPREAD = 0.04, HALF = SPREAD / 2, MIN_PREMIUM = 0.05, LOW = 15, HIGH = 120, SCAN_MAX = +(process.env.SCAN_MAX || 60), SIG_MAX = +(process.env.SIG_MAX || 2400);
const RSI_BUY = 25, PROFIT = 0.005, MAX_HOLD = 15, FLOOR = 0.25, MIN_DTE = 7;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let calls = 0;
async function get(url) {
  for (let a = 0; a < 6; a++) {
    await sleep(330); calls++;                                              // under the free data plan's 200 requests a minute
    let r; try { r = await fetch(url, { headers: H }); } catch (e) { await sleep(2000 * (a + 1)); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(5000 * (a + 1)); continue; }
    if (!r.ok) return { err: r.status, body: (await r.text()).slice(0, 200) };
    return r.json();
  }
  return { err: 'retries' };
}
const dn = s => Math.round(Date.parse(s + 'T00:00:00Z') / 864e5);
const r2 = x => Math.round(x * 100) / 100, pc = x => Math.round(x * 10000) / 100;
const mean = a => a.length ? a.reduce((t, x) => t + x, 0) / a.length : null;

// ---- stock prices: split-adjusted history for the signals, raw (unadjusted) prices for entries, exits and strikes ----
const D = loadDaily();
const sma200 = sym => { const b = D.bars[sym]; if (!b) return null; const s = new Float64Array(b.c.length).fill(NaN); let a = 0; for (let i = 0; i < b.c.length; i++) { a += b.c[i]; if (i >= 200) a -= b.c[i - 200]; if (i >= 199) s[i] = a / 200; } return { days: b.days, c: b.c, s }; };
const trendCache = {};
function aboveTrend(sym, dateStr) {                                          // the last close before dateStr above its 200-day average
  const T = trendCache[sym] || (trendCache[sym] = sma200(sym)); if (!T) return false;
  const d = dn(dateStr); let lo = 0, hi = T.days.length - 1, k = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (T.days[m] < d) { k = m; lo = m + 1; } else hi = m - 1; }
  return k >= 0 && T.c[k] > T.s[k];
}
let FEED = 'sip';
async function rawDaily(syms) {
  const out = {}, end = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  for (let i = 0; i < syms.length; i += 40) {
    const chunk = syms.slice(i, i + 40); let token = '';
    for (let k = 0; k < 200; k++) {
      let j = await get(`${DATA}/v2/stocks/bars?symbols=${chunk.join(',')}&timeframe=1Day&start=2024-01-02&end=${end}&adjustment=raw&feed=${FEED}&limit=10000${token ? '&page_token=' + token : ''}`);
      if (j.err && FEED === 'sip' && !token) { FEED = 'iex'; console.log('SIP daily bars refused (' + j.err + '), using IEX'); k--; continue; }
      if (j.err) throw new Error('stock bars HTTP ' + j.err + ' ' + (j.body || ''));
      for (const [s, arr] of Object.entries(j.bars || {})) (out[s] = out[s] || []).push(...arr.map(b => ({ d: b.t.slice(0, 10), o: b.o, h: b.h, l: b.l, c: b.c })));
      token = j.next_page_token; if (!token) break;
    }
  }
  return out;
}
function splitsOf(sym, raw) {                                               // raw vs adjusted close-to-close move off by 25 %+
  const A = D.bars[sym]; if (!A) return [];
  const adj = new Map(A.days.map((d, i) => [d, A.c[i]])), out = [];
  for (let i = 1; i < raw.length; i++) {
    const a0 = adj.get(dn(raw[i - 1].d)), a1 = adj.get(dn(raw[i].d)); if (!(a0 > 0 && a1 > 0)) continue;
    const f = (a1 / a0) / (raw[i].c / raw[i - 1].c); if (f > 1.25 || f < 0.8) out.push(raw[i].d);
  }
  return out;
}
function monthlyExpiries(cal) {                                             // third Friday, or the trading day before it on a holiday
  const set = new Set(cal), out = [];
  for (let y = 2024; y <= 2026; y++) for (let m = 0; m < 12; m++) {
    const first = new Date(Date.UTC(y, m, 1)), off = (5 - first.getUTCDay() + 7) % 7;
    let d = new Date(Date.UTC(y, m, 1 + off + 14));
    for (let k = 0; k < 4 && !set.has(d.toISOString().slice(0, 10)); k++) d = new Date(d.getTime() - 864e5);
    const s = d.toISOString().slice(0, 10); if (set.has(s)) out.push(s);
  }
  return out;
}

// ---- option contracts and their daily bars (as in wheel-study) ----
async function chain(sym, wanted) {
  const rx = new RegExp('^' + sym + '\\d{6}C\\d{8}$'), byExp = {};
  const from = [...wanted].sort()[0], to = [...wanted].sort().pop();
  for (const status of ['inactive', 'active']) {
    let token = '';
    for (let k = 0; k < 60; k++) {
      const j = await get(`${TRADE}/v2/options/contracts?underlying_symbols=${sym}&type=call&status=${status}&expiration_date_gte=${from}&expiration_date_lte=${to}&limit=10000${token ? '&page_token=' + token : ''}`);
      if (j.err) break;
      for (const c of j.option_contracts || []) if (wanted.has(c.expiration_date) && rx.test(c.symbol)) (byExp[c.expiration_date] = byExp[c.expiration_date] || []).push({ K: +c.strike_price, s: c.symbol });
      token = j.next_page_token; if (!token) break;
    }
  }
  for (const e of Object.keys(byExp)) { const seen = new Set(); byExp[e] = byExp[e].filter(x => !seen.has(x.s) && seen.add(x.s)).sort((a, b) => a.K - b.K); }
  return byExp;
}
const bars = new Map();                                                     // contract → Map(date → {o,h,l,c,vw})
async function fetchBars(list) {
  const need = list.filter(x => !bars.has(x.s)); if (!need.length) return;
  const win = new Map(need.map(x => [x.s, x]));
  for (let i = 0; i < need.length; i += 50) {
    const chunk = need.slice(i, i + 50), from = chunk.reduce((m, x) => x.from < m ? x.from : m, '9999'), to = chunk.reduce((m, x) => x.to > m ? x.to : m, '0000');
    for (const x of chunk) bars.set(x.s, new Map());
    let token = '';
    for (let k = 0; k < 100; k++) {
      const j = await get(`${DATA}/v1beta1/options/bars?symbols=${chunk.map(x => x.s).join(',')}&timeframe=1Day&start=${from}&end=${to}&limit=10000${token ? '&page_token=' + token : ''}`);
      if (j.err) { console.log('option bars HTTP', j.err, j.body || ''); break; }
      for (const [s, arr] of Object.entries(j.bars || {})) {
        const w = win.get(s), m = bars.get(s) || new Map();
        for (const b of arr) { const d = b.t.slice(0, 10); if (!w || (d >= w.from && d <= w.to)) m.set(d, { o: b.o, h: b.h, l: b.l, c: b.c, vw: b.vw || (b.o + b.h + b.l + b.c) / 4 }); }
        bars.set(s, m);
      }
      token = j.next_page_token; if (!token) break;
    }
  }
}

// ---- the two arms of one trade, on the raw bars from the signal day on ----
function runBaseline(raw, j0) {
  const entry = raw[j0].c, floorPx = entry * (1 - FLOOR);
  for (let j = j0 + 1; j < raw.length && j <= j0 + MAX_HOLD; j++) {
    if (raw[j].l <= floorPx) return { ret: (Math.min(raw[j].o, floorPx) - entry) / entry, days: j - j0, why: 'floor' };
    if (raw[j].c >= entry * (1 + PROFIT)) return { ret: (raw[j].c - entry) / entry, days: j - j0, why: 'profit' };
    if (j === j0 + MAX_HOLD) return { ret: (raw[j].c - entry) / entry, days: j - j0, why: 'maxhold' };
  }
  return null;                                                              // not enough bars yet: the signal is dropped
}
function runCovered(raw, j0, call, tp) {                                    // call: { s, K, prem, jSold, jExp }
  const entry = raw[j0].c, floorPx = entry * (1 - FLOOR);
  let open = true, cb = 0, lastCall = call.prem, jFree = null, why = null, proceeds = null, jEnd = null;
  for (let j = call.jSold + 1; j < raw.length; j++) {
    const b = bars.get(call.s).get(raw[j].d); if (b) lastCall = b.c;
    if (open) {
      if (raw[j].l <= floorPx) {                                            // the floor overrides the freeze: the call is bought back first
        cb = (b ? b.c : Math.max(lastCall, Math.max(0, raw[j].c - call.K))) * (1 + HALF);
        return { ret: (Math.min(raw[j].o, floorPx) + call.prem - cb - entry) / entry, days: j - j0, why: 'floor' };
      }
      if (tp && b && b.l * (1 + HALF) <= 0.5 * call.prem) { cb = Math.min(b.o * (1 + HALF), 0.5 * call.prem); open = false; jFree = j; }
      else if (j >= call.jExp) {
        const SE = raw[j].c;
        if (SE > call.K) return { ret: (call.K + call.prem - entry) / entry, days: j - j0, why: 'called' };
        open = false; jFree = j + 1;                                        // expired worthless: the shares are free from the next session
      }
      if (open) continue;
    }
    if (jFree != null && j >= jFree) {                                      // the stock rule resumes; the 15-session clock usually ran out while frozen
      if (raw[j].l <= floorPx) { proceeds = Math.min(raw[j].o, floorPx); why = 'floor'; jEnd = j; break; }
      if (raw[j].c >= entry * (1 + PROFIT) || j - j0 >= MAX_HOLD) { proceeds = raw[j].c; why = j - j0 >= MAX_HOLD ? 'maxhold' : 'profit'; jEnd = j; break; }
    }
  }
  if (proceeds == null) return null;                                        // not enough bars yet
  return { ret: (proceeds + call.prem - cb - entry) / entry, days: jEnd - j0, why: (open ? '' : tp && cb ? 'tp then ' : 'expired then ') + why };
}

// ---- gather the signals ----
const spyCal = D.bars.SPY.days.map(d => new Date(d * 864e5).toISOString().slice(0, 10)).filter(d => d >= '2024-01-01');
const EXPIRIES = monthlyExpiries(spyCal);
const lastDay = spyCal[spyCal.length - 1], cutoff = new Date(Date.parse(lastDay) - 55 * 864e5).toISOString().slice(0, 10);
const LISTS = { base: D.base.filter(s => D.bars[s]), scan: D.scan.filter(s => D.bars[s]).slice(0, SCAN_MAX) };
const raws = await rawDaily([...new Set(Object.values(LISTS).flat())]);
const out = { at: new Date().toISOString(), feed: FEED, assumptions: { spreadPct: SPREAD * 100, minPremium: MIN_PREMIUM, priceRange: [LOW, HIGH], rsiBuy: RSI_BUY, profitPct: PROFIT * 100, maxHold: MAX_HOLD, floorPct: FLOOR * 100, minDte: MIN_DTE, marketFilter: true, from: '2024-02-01', to: cutoff }, lists: {}, examples: [], apiCalls: 0 };
const VARIANTS = [{ k: 'x5tp50', X: 0.05, tp: true }, { k: 'x5hold', X: 0.05, tp: false }, { k: 'x10tp50', X: 0.10, tp: true }, { k: 'x10hold', X: 0.10, tp: false }];

for (const [list, syms] of Object.entries(LISTS)) {
  const trades = [];                                                        // { sym, day, entry, base, cov: {k: result}, prem }
  let noCall = 0, nSig = 0;
  for (const sym of syms) {
    if (nSig >= SIG_MAX) break;
    const raw = raws[sym]; if (!raw || raw.length < 30) continue;
    const splits = new Set(splitsOf(sym, raw));
    const A = D.bars[sym], T = trendCache[sym] || (trendCache[sym] = sma200(sym));
    const idxOf = new Map(raw.map((b, i) => [b.d, i]));
    const want = new Set(), sigs = [];
    let freeFrom = '';
    for (let i = 200; i < A.days.length; i++) {
      const d = new Date(A.days[i] * 864e5).toISOString().slice(0, 10);
      if (d < '2024-02-01' || d > cutoff || d <= freeFrom) continue;
      if (!(rsi2(A.c, i) < RSI_BUY) || !(A.c[i] > T.s[i])) continue;
      if (!aboveTrend('SPY', d)) continue;                                  // the owner's market filter
      const j0 = idxOf.get(d); if (j0 == null) continue;
      const entry = raw[j0].c; if (!(entry >= LOW && entry <= HIGH)) continue;
      const exp = EXPIRIES.find(e => dn(e) >= dn(d) + MIN_DTE); if (!exp || exp > cutoff) continue;
      let crossed = false; for (const sp of splits) if (sp > d && dn(sp) <= dn(exp) + 40) crossed = true;
      if (crossed) continue;
      sigs.push({ d, j0, entry, exp }); want.add(exp);
      freeFrom = new Date((dn(exp) + 40) * 864e5).toISOString().slice(0, 10);   // spaced: the next signal only after the slowest variant could close
      if (nSig + sigs.length >= SIG_MAX) break;
    }
    if (!sigs.length) continue;
    nSig += sigs.length;
    const byExp = await chain(sym, want);
    const need = [];
    for (const g of sigs) {
      const ks = byExp[g.exp] || [];
      g.cands = [...new Set([0.05, 0.10].map(X => ks.find(x => x.K >= g.entry * (1 + X))).filter(Boolean))];
      for (const c of g.cands) need.push({ s: c.s, from: g.d, to: g.exp });
    }
    await fetchBars([...new Map(need.map(x => [x.s, x])).values()]);
    for (const g of sigs) {
      const base = runBaseline(raw, g.j0); if (!base) continue;
      const jExpRaw = raw.findIndex(b => b.d >= g.exp); if (jExpRaw < 0) continue;
      const callFor = X => {
        const c = (g.cands || []).find(x => x.K >= g.entry * (1 + X)); if (!c) return null;
        for (const jS of [g.j0, g.j0 + 1]) {                                 // sold the signal day, or the next when it did not trade
          const b = jS < raw.length && bars.get(c.s) && bars.get(c.s).get(raw[jS].d);
          if (b) { const prem = b.vw * (1 - HALF); return prem >= MIN_PREMIUM ? { s: c.s, K: c.K, prem, jSold: jS, jExp: jExpRaw } : null; }
        }
        return null;
      };
      const cov = {};
      for (const v of VARIANTS) { const call = callFor(v.X); cov[v.k] = call ? runCovered(raw, g.j0, call, v.tp) : null; }
      if (!cov.x5tp50) { noCall++; continue; }                               // no usable 5 % call: not a paired trade
      trades.push({ sym, day: g.d, entry: r2(g.entry), base, cov, k5: (g.cands.find(x => x.K >= g.entry * 1.05) || {}).K });
    }
    console.log(list, sym, 'signals', sigs.length, 'paired', trades.length, 'api calls', calls);
  }
  const stat = (rows, pick) => {
    const a = rows.map(pick).filter(Boolean);
    const w = a.filter(x => x.ret > 0), why = {};
    for (const x of a) why[x.why] = (why[x.why] || 0) + 1;
    const worst = a.reduce((m, x) => !m || x.ret < m.ret ? x : m, null);
    return { n: a.length, winPct: a.length ? r2(w.length / a.length * 100) : null, avgPct: a.length ? pc(mean(a.map(x => x.ret))) : null,
      avgWinPct: w.length ? pc(mean(w.map(x => x.ret))) : null, avgLossPct: a.length - w.length ? pc(mean(a.filter(x => x.ret <= 0).map(x => x.ret))) : null,
      avgDays: a.length ? r2(mean(a.map(x => x.days))) : null, worstPct: worst ? pc(worst.ret) : null, why };
  };
  const L = { stocks: syms.length, signals: nSig, paired: trades.length, noCall, baseline: stat(trades, t => t.base), variants: {} };
  for (const v of VARIANTS) {
    const rows = trades.filter(t => t.cov[v.k]);
    const s = stat(rows, t => t.cov[v.k]);
    s.deltaAvgPct = rows.length ? pc(mean(rows.map(t => t.cov[v.k].ret - t.base.ret))) : null;
    s.worsePct = rows.length ? r2(rows.filter(t => t.cov[v.k].ret < t.base.ret - 1e-9).length / rows.length * 100) : null;
    s.extraDays = rows.length ? r2(mean(rows.map(t => t.cov[v.k].days - t.base.days))) : null;
    s.byYear = {}; for (const y of ['2024', '2025', '2026']) { const r = rows.filter(t => t.day.startsWith(y)); if (r.length) s.byYear[y] = { n: r.length, deltaAvgPct: pc(mean(r.map(t => t.cov[v.k].ret - t.base.ret))) }; }
    L.variants[v.k] = s;
  }
  const scored = trades.filter(t => t.cov.x5tp50).map(t => ({ sym: t.sym, day: t.day, entry: t.entry, base: { ret: pc(t.base.ret), days: t.base.days, why: t.base.why }, covered: { ret: pc(t.cov.x5tp50.ret), days: t.cov.x5tp50.days, why: t.cov.x5tp50.why }, delta: pc(t.cov.x5tp50.ret - t.base.ret) })).sort((a, b) => a.delta - b.delta);
  out.examples.push({ list, worst: scored.slice(0, 3), best: scored.slice(-3) });
  out.lists[list] = L;
}
out.apiCalls = calls;
fs.mkdirSync('research-data', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log('written', OUT, 'api calls', calls);
