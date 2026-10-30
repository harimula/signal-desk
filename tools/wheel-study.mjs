// Wheel study (2026-10-29; owner: "Can you do covered calls and cash secured puts"): cash-secured puts, and covered calls
// on the shares a put delivers, replayed on real option prices — the daily bars of each contract from the broker's
// market-data API, which go back to February 2024.
//   Monthly cycle, as most wheel traders run it: on the first trading day after a monthly expiration, sell the put that
//   expires at the next one (~33 days) X % under the stock's last close. If the stock closes under the strike at expiry,
//   the shares are bought at the strike; from the next cycle a call is sold each month at a strike at or above both the
//   cost (strike − premium) and X % above the price, until the shares are called away. Then puts again.
//   Prices: sold at the contract's average traded price that day less half an assumed 4 % spread (the first of the
//   cycle's first three days on which one of the three strikes nearest the target traded); a buy-back (take-profit at
//   half the premium; stop at three times it) at the target, or at the open when the price gapped through it, plus half
//   the spread. Expiry: the stock's close decides (assigned / called away when in the money by a cent).
//   Each stock is its own fully cash-secured account (fractional contracts, so every stock weighs the same; idle cash
//   earns nothing). The portfolio is the average of the stocks that held a position in a cycle.
//   Variants: X = 0 / 5 / 10 %; hold to expiry, take-profit, take-profit + stop; with or without the bot's trend filter
//   (SPY and the stock above their 200-day averages the day before a put is sold).
//   Lists: the research list's long-standing large companies ("base", any price) and the bot's market-scan stocks that
//   cost $15–$150 when the put is sold ("scan": what a $10,000–$20,000 part can afford, one contract at a time). Both
//   lists are today's names: survivorship flatters them (stocks that collapsed or left the lists are missing).
// Read-only; market data only. Writes research-data/wheel-study.json (workflow wheel-study.yml → branch research-data).
//   node tools/wheel-study.mjs        (needs ALPACA_KEY / ALPACA_SECRET and research-data/daily.json.gz)
import fs from 'node:fs';
import { loadDaily } from './winrate-study.mjs';

const KEY = process.env.ALPACA_KEY, SECRET = process.env.ALPACA_SECRET;
if (!KEY || !SECRET) { console.log('no market-data keys'); process.exit(1); }
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET };
const DATA = 'https://data.alpaca.markets', TRADE = 'https://paper-api.alpaca.markets';
const OUT = process.env.OUT || 'research-data/wheel-study.json';
const SPREAD = 0.04, HALF = SPREAD / 2, MIN_PREMIUM = 0.05, LOW = 15, HIGH = 150, SCAN_MAX = +(process.env.SCAN_MAX || 60);
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

// ---- stock prices: split-adjusted history for the trend filter, raw (unadjusted) prices to compare with strikes ----
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
// splits: a day whose raw close-to-close move differs from the split-adjusted one by more than 25 % (factor = new shares per old)
function splitsOf(sym, raw) {
  const A = D.bars[sym]; if (!A) return [];
  const adj = new Map(A.days.map((d, i) => [d, A.c[i]])), out = [];
  for (let i = 1; i < raw.length; i++) {
    const a0 = adj.get(dn(raw[i - 1].d)), a1 = adj.get(dn(raw[i].d)); if (!(a0 > 0 && a1 > 0)) continue;
    const f = (a1 / a0) / (raw[i].c / raw[i - 1].c); if (f > 1.25 || f < 0.8) out.push({ d: raw[i].d, f: Math.round(f * 100) / 100 });
  }
  return out;
}

// ---- the monthly expirations (third Friday, or the trading day before it when that Friday is a holiday) ----
function monthlyExpiries(cal) {
  const set = new Set(cal), out = [];
  for (let y = 2024; y <= 2026; y++) for (let m = 0; m < 12; m++) {
    const first = new Date(Date.UTC(y, m, 1)), off = (5 - first.getUTCDay() + 7) % 7;
    let d = new Date(Date.UTC(y, m, 1 + off + 14));
    for (let k = 0; k < 4 && !set.has(d.toISOString().slice(0, 10)); k++) d = new Date(d.getTime() - 864e5);
    const s = d.toISOString().slice(0, 10); if (set.has(s)) out.push(s);
  }
  return out;
}

// ---- option contracts and their daily bars ----
async function chain(sym, type, from, to, wanted) {                         // standard contracts (not split-adjusted ones) at the wanted expiries
  const rx = new RegExp('^' + sym + '\\d{6}[CP]\\d{8}$'), byExp = {};
  for (const status of ['inactive', 'active']) {
    let token = '';
    for (let k = 0; k < 60; k++) {
      const j = await get(`${TRADE}/v2/options/contracts?underlying_symbols=${sym}&type=${type}&status=${status}&expiration_date_gte=${from}&expiration_date_lte=${to}&limit=10000${token ? '&page_token=' + token : ''}`);
      if (j.err) break;
      for (const c of j.option_contracts || []) if (wanted.has(c.expiration_date) && rx.test(c.symbol)) (byExp[c.expiration_date] = byExp[c.expiration_date] || []).push({ K: +c.strike_price, s: c.symbol });
      token = j.next_page_token; if (!token) break;
    }
  }
  for (const e of Object.keys(byExp)) { const seen = new Set(); byExp[e] = byExp[e].filter(x => !seen.has(x.s) && seen.add(x.s)).sort((a, b) => a.K - b.K); }
  return byExp;
}
const bars = new Map();                                                     // contract → Map(date → {o,h,l,c,vw})
async function fetchBars(list) {                                            // list: [{s, from, to}] — keeps each contract's bars within its own cycle
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
const putCands = (strikes, S0, X) => { const tgt = S0 * (1 - X), below = strikes.filter(x => x.K <= tgt).slice(-2).reverse(), above = strikes.filter(x => x.K > tgt).slice(0, 1); return below.concat(above); };
const callCands = (strikes, S0, X, cost) => strikes.filter(x => x.K >= Math.max(S0 * (1 + X), cost)).slice(0, 3);

// ---- one stock, every variant side by side (the calls each variant may sell are read in one request per cycle) ----
function step(st, cy, a) {                                                  // a: one variant's account {v, cash, sh, cost, puts, calls, marks}
  const v = a.v, pos0 = a.sh > 0;
  if (!cy.ok) { a.marks.push({ d: cy.exp, E: null, active: false }); return; }
  for (const sp of cy.splits) if (a.sh > 0) { a.sh *= sp.f; a.cost /= sp.f; }
  let sold = null;
  if (!cy.splits.length) {
    for (const day of cy.days.slice(0, 3)) {                              // the first of the cycle's first three days with a trade
      const S0 = st.closeBefore(day); if (!(S0 > 0)) continue;
      let cands;
      if (a.sh === 0) {
        if (st.list === 'scan' && (S0 < LOW || S0 > HIGH)) break;
        if (v.filter && !(aboveTrend('SPY', day) && aboveTrend(st.sym, day))) break;
        cands = putCands(cy.putChain, S0, v.X);
      } else {
        cands = callCands(cy.callChain || [], S0, v.X, a.cost);
        if (!cands.length) break;                                           // nothing at or above the cost: keep the shares this month
      }
      const hit = cands.find(x => (bars.get(x.s) || new Map()).has(day));
      if (hit) { const p = bars.get(hit.s).get(day).vw * (1 - HALF); if (p >= MIN_PREMIUM) sold = { kind: a.sh === 0 ? 'put' : 'call', day, S0, K: hit.K, s: hit.s, p }; break; }
    }
  }
  const SE = cy.closeExp;
  if (sold) {
    const n = sold.kind === 'put' ? a.cash / sold.K : a.sh;                 // shares' worth (fractional): a put is fully cash-secured
    a.cash += n * sold.p;
    let closed = null; const B = bars.get(sold.s);
    for (const d of cy.days) {
      if (d <= sold.day) continue;
      const b = B.get(d); if (!b) continue;
      if (v.stop && sold.kind === 'put' && b.h * (1 + HALF) >= v.stop * sold.p) { closed = { why: 'stop', px: Math.max(b.o * (1 + HALF), v.stop * sold.p) }; break; }
      if (v.tp && b.l * (1 + HALF) <= v.tp * sold.p) { closed = { why: 'tp', px: Math.min(b.o * (1 + HALF), v.tp * sold.p) }; break; }
    }
    if (closed) a.cash -= n * closed.px;
    if (sold.kind === 'put') {
      let why = closed ? closed.why : 'expired', pl = closed ? sold.p - closed.px : sold.p;
      if (!closed && SE < sold.K) { why = 'assigned'; pl = sold.p - (sold.K - SE); a.cash -= n * sold.K; a.sh = n; a.cost = sold.K - sold.p; }
      a.puts.push({ sym: st.sym, entry: sold.day, exp: cy.exp, S0: r2(sold.S0), K: sold.K, p: r2(sold.p), why, ret: pl / sold.K, y: cy.exp.slice(0, 4) });
    } else {
      let why = closed ? closed.why : 'expired', pl = closed ? sold.p - closed.px : sold.p - Math.max(0, SE - sold.K);
      if (!closed && SE > sold.K) { why = 'called'; a.cash += a.sh * sold.K; a.sh = 0; }
      a.calls.push({ sym: st.sym, entry: sold.day, exp: cy.exp, S0: r2(sold.S0), K: sold.K, p: r2(sold.p), why, ret: pl / sold.S0, y: cy.exp.slice(0, 4) });
    }
  }
  a.marks.push({ d: cy.exp, E: a.cash + a.sh * SE, active: !!sold || pos0 || a.sh > 0 });
}
async function runStock(st, variants) {
  const A = variants.map(v => ({ v, cash: 1, sh: 0, cost: 0, puts: [], calls: [], marks: [] }));
  for (const cy of st.cycles) {
    if (cy.ok && !cy.splits.length && A.some(a => a.sh > 0)) {               // calls for every variant that holds shares, in one request
      cy.callChain = await st.callChainAt(cy.exp);
      const need = [];
      for (const a of A) if (a.sh > 0) for (const day of cy.days.slice(0, 3)) { const S0 = st.closeBefore(day); if (S0 > 0) for (const c of callCands(cy.callChain, S0, a.v.X, a.cost)) need.push({ s: c.s, from: cy.entry, to: cy.exp }); }
      if (need.length) await fetchBars([...new Map(need.map(x => [x.s, x])).values()]);
    }
    for (const a of A) step(st, cy, a);
  }
  return A;
}

// ---- stats ----
function tradeStats(a) {
  const n = a.length, w = a.filter(x => x.ret > 0), l = a.filter(x => x.ret <= 0), why = {};
  for (const x of a) why[x.why] = (why[x.why] || 0) + 1;
  const worst = a.reduce((m, x) => !m || x.ret < m.ret ? x : m, null);
  return { n, winPct: n ? r2(w.length / n * 100) : null, avgPct: n ? pc(mean(a.map(x => x.ret))) : null, avgWinPct: w.length ? pc(mean(w.map(x => x.ret))) : null, avgLossPct: l.length ? pc(mean(l.map(x => x.ret))) : null,
    worstPct: worst ? pc(worst.ret) : null, worst: worst ? `${worst.sym} ${worst.entry}→${worst.exp} strike ${worst.K} (stock ${worst.S0})` : null, why };
}
function portfolio(runs, cycles) {                                          // average monthly return of the stocks that held a position
  const months = [];
  for (let k = 0; k < cycles.length; k++) {
    const rs = [];
    for (const r of runs) { const m = r.marks[k], p = k ? r.marks[k - 1] : null, E0 = p ? p.E : 1; if (m && m.E != null && E0 != null && m.active) rs.push(m.E / E0 - 1); }
    months.push({ d: cycles[k].exp, r: rs.length ? mean(rs) : 0, n: rs.length });
  }
  return summarizeMonths(months);
}
function summarizeMonths(months) {
  let eq = 1, peak = 1, dd = 0; const byYear = {};
  for (const m of months) { eq *= 1 + m.r; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1); const y = m.d.slice(0, 4); byYear[y] = (byYear[y] || 1) * (1 + m.r); }
  const yrs = months.length / 12.17, worst = months.reduce((w, m) => !w || m.r < w.r ? m : w, null);
  return { months: months.length, totalPct: pc(eq - 1), perYearPct: pc(Math.pow(eq, 1 / yrs) - 1), worstMonthPct: worst ? pc(worst.r) : null, worstMonth: worst ? worst.d : null, maxDrawdownPct: pc(dd),
    upMonthsPct: r2(months.filter(m => m.r > 0).length / months.length * 100), byYearPct: Object.fromEntries(Object.entries(byYear).map(([y, v]) => [y, pc(v - 1)])), avgStocks: Math.round(mean(months.map(m => m.n)) || 0) };
}

// ---- run ----
const base = D.base.filter(s => D.bars[s]), scanAll = D.scan.filter(s => D.bars[s] && !base.includes(s));
console.log('raw daily bars for', base.length + scanAll.length + 1, 'symbols');
const RAW = await rawDaily(['SPY', ...base, ...scanAll]);
const cal = (RAW.SPY || []).map(b => b.d), lastDay = cal[cal.length - 1], calIx = new Map(cal.map((d, i) => [d, i]));
const exps = monthlyExpiries(cal).filter(e => e >= '2024-02-01' && e <= lastDay);
const cycleDefs = []; for (let k = 0; k + 1 < exps.length; k++) { const i = calIx.get(exps[k]); const days = cal.slice(i + 1, calIx.get(exps[k + 1]) + 1); if (days.length) cycleDefs.push({ entry: days[0], exp: exps[k + 1], days }); }
console.log(cycleDefs.length, 'monthly cycles', cycleDefs[0].entry, '→', cycleDefs[cycleDefs.length - 1].exp, '· feed', FEED);
// scan list: the most traded names that cost $15–$150 at the start of at least 6 cycles
const inRange = s => { const R = RAW[s] || [], m = new Map(R.map(b => [b.d, b.c])); return cycleDefs.filter(cy => { const i = calIx.get(cy.entry); const c = m.get(cal[i - 1]); return c >= LOW && c <= HIGH; }).length; };
const scan = scanAll.filter(s => inRange(s) >= 6).slice(0, SCAN_MAX);
const wantedExp = new Set(cycleDefs.map(c => c.exp)), firstExp = cycleDefs[0].exp, lastExp = cycleDefs[cycleDefs.length - 1].exp;

const VARIANTS = [];
for (const X of [0, 0.05, 0.10]) for (const [mk, tp, stop] of [['hold', 0, 0], ['tp50', 0.5, 0], ['tp50-stop3x', 0.5, 3]]) for (const filter of [false, true]) VARIANTS.push({ key: `otm${Math.round(X * 100)}-${mk}${filter ? '-trend' : ''}`, X, tp, stop, filter });
const out = { at: new Date().toISOString(), feed: FEED, assumptions: { spreadPct: SPREAD * 100, minPremium: MIN_PREMIUM, scanPriceRange: [LOW, HIGH], cycles: cycleDefs.length, from: cycleDefs[0].entry, to: lastExp }, lists: {}, bench: {} };
const runsBy = {};
for (const [list, syms] of [['base', base], ['scan', scan]]) {
  out.lists[list] = { stocks: syms.length, symbols: syms, variants: {} };
  const prepared = [];
  for (const sym of syms) {
    const R = RAW[sym] || []; if (R.length < 100) continue;
    const close = new Map(R.map(b => [b.d, b.c])), splits = splitsOf(sym, R);
    const closeBefore = day => { let i = calIx.get(day) - 1; while (i >= 0 && !close.has(cal[i])) i--; return i >= 0 ? close.get(cal[i]) : null; };
    const pc0 = await chain(sym, 'put', firstExp, lastExp, wantedExp);
    let callAll = null;
    const st = { sym, list, closeBefore, callChainAt: async e => { if (!callAll) callAll = await chain(sym, 'call', firstExp, lastExp, wantedExp); return callAll[e] || []; },
      cycles: cycleDefs.map(cy => ({ ...cy, ok: close.has(cy.exp) && close.has(cy.days[0]), closeExp: close.get(cy.exp), putChain: pc0[cy.exp] || [], splits: splits.filter(sp => sp.d > cal[calIx.get(cy.entry) - 1] && sp.d <= cy.exp) })) };
    // the puts every variant may need, in one go (the calls depend on each variant's cost, so they are read as needed)
    const need = [];
    for (const cy of st.cycles) for (const day of cy.days.slice(0, 3)) { const S0 = closeBefore(day); if (S0 > 0 && (list !== 'scan' || (S0 >= LOW && S0 <= HIGH))) for (const X of [0, 0.05, 0.10]) for (const c of putCands(cy.putChain, S0, X)) need.push({ s: c.s, from: cy.entry, to: cy.exp }); }
    const uniq = [...new Map(need.map(x => [x.s, x])).values()];
    await fetchBars(uniq);
    prepared.push(st);
    console.log(list, sym, 'puts at', Object.keys(pc0).length, 'expiries,', uniq.length, 'contracts · splits', JSON.stringify(splits), '· api calls', calls);
  }
  const perStock = [];
  for (const st of prepared) perStock.push(await runStock(st, VARIANTS));
  for (let vi = 0; vi < VARIANTS.length; vi++) {
    const v = VARIANTS[vi], runs = perStock.map(A => A[vi]);
    runsBy[list + ' ' + v.key] = runs;
    const allPuts = runs.flatMap(r => r.puts), allCalls = runs.flatMap(r => r.calls);
    const crash = allPuts.filter(t => t.exp >= '2025-04-01' && t.exp <= '2025-04-30');
    out.lists[list].variants[v.key] = { puts: tradeStats(allPuts), calls: tradeStats(allCalls), wheel: portfolio(runs, cycleDefs),
      putsByYear: Object.fromEntries(['2024', '2025', '2026'].map(y => [y, tradeStats(allPuts.filter(t => t.y === y))])), april2025Puts: tradeStats(crash) };
    const w = out.lists[list].variants[v.key];
    console.log(list, v.key.padEnd(26), 'puts', w.puts.n, 'won', w.puts.winPct + '%', 'avg', w.puts.avgPct + '%', 'worst', w.puts.worstPct + '%', '| wheel', w.wheel.perYearPct + '%/yr', 'worst month', w.wheel.worstMonthPct + '%', 'maxDD', w.wheel.maxDrawdownPct + '%', '| calls', w.calls.n, '· api calls', calls);
  }
  // the same stocks simply held, and SPY, over the same cycles (split-adjusted closes)
  const adj = s => { const A = D.bars[s]; return A ? new Map(A.days.map((d, i) => [d, A.c[i]])) : new Map(); };
  const hold = [], spyM = [], SPYa = adj('SPY');
  for (let k = 0; k < cycleDefs.length; k++) {
    const e0 = k ? cycleDefs[k - 1].exp : cal[calIx.get(cycleDefs[0].entry) - 1], e1 = cycleDefs[k].exp, rs = [];
    for (const st of prepared) { const A = adj(st.sym), a0 = A.get(dn(e0)), a1 = A.get(dn(e1)); if (a0 > 0 && a1 > 0) rs.push(a1 / a0 - 1); }
    hold.push({ d: e1, r: rs.length ? mean(rs) : 0, n: rs.length });
    const s0 = SPYa.get(dn(e0)), s1 = SPYa.get(dn(e1)); spyM.push({ d: e1, r: s0 > 0 && s1 > 0 ? s1 / s0 - 1 : 0, n: 1 });
  }
  out.bench[list] = { holdSameStocks: summarizeMonths(hold), spy: summarizeMonths(spyM) };
  console.log(list, 'hold the same stocks', JSON.stringify(out.bench[list].holdSameStocks), '| SPY', JSON.stringify(out.bench[list].spy));
}
// a few worked examples for the owner (5 % under, take-profit, trend filter): the scan list's April 2025 cycle
const ex = (runsBy['scan otm5-tp50-trend'] || []).flatMap(r => r.puts).filter(t => t.exp.startsWith('2025-04')).sort((a, b) => a.ret - b.ret);
out.examples = { april2025_scan_otm5_tp50_trend: ex.slice(0, 5).concat(ex.slice(-3)).map(t => ({ ...t, retPct: pc(t.ret) })) };
if (process.env.DEBUG_SYM) for (const k of ['base otm0-hold', 'base otm5-tp50-stop3x']) { const r = (runsBy[k] || []).find(x => (x.puts[0] || x.calls[0] || {}).sym === process.env.DEBUG_SYM); if (r) out['debug ' + k] = { puts: r.puts, calls: r.calls, marks: r.marks }; }
out.apiCalls = calls;
fs.mkdirSync(OUT.replace(/\/[^/]*$/, ''), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log('done · api calls', calls);
