// India bot — SIMULATION (no broker, no real orders). Runs once a day after the NSE close (india-sim.yml).
//
// It replays, one real trading day at a time, exactly what the NSE research (research.mjs, BT_MARKET=IN) tested:
//   · entries planned at a day's close fill at the NEXT day's official open price, in whole shares;
//   · exits are decided on the day's close and fill at that close;
//   · 0.15 % per side for Indian costs (STT, stamp duty, exchange/SEBI fees, GST, DP charge, slippage).
// Two independent "sleeves" share the stake: trend breakout and RSI-2 dip buying, each with its own cash, positions and
// record, so the live results can be compared with each other, with the research and with simply holding the Nifty 50.
//
// Prices: Yahoo Finance daily bars for the Nifty 100 (.NS) and ^NSEI, split events applied to open positions.
// State:  bot/india-journal.json (encrypted with JOURNAL_KEY like the US journal). Settings: bot/config-in.json.
// Alerts: one Telegram message per processed day (bot/telegram.mjs).
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sma, rsi2, rsi2Trigger } from './strategy.mjs';
import { encryptJournal, decryptJournal } from './jcrypt.mjs';
import { tgOn, tgSend } from './telegram.mjs';

export const NIFTY100 = ['RELIANCE', 'TCS', 'HDFCBANK', 'ICICIBANK', 'INFY', 'BHARTIARTL', 'ITC', 'SBIN', 'LT', 'HINDUNILVR', 'KOTAKBANK', 'AXISBANK', 'BAJFINANCE', 'MARUTI', 'ASIANPAINT', 'HCLTECH', 'SUNPHARMA', 'TITAN', 'ULTRACEMCO', 'WIPRO', 'NTPC', 'POWERGRID', 'ONGC', 'NESTLEIND', 'M&M', 'TATASTEEL', 'JSWSTEEL', 'ADANIENT', 'ADANIPORTS', 'COALINDIA', 'BAJAJFINSV', 'HDFCLIFE', 'SBILIFE', 'TECHM', 'GRASIM', 'HINDALCO', 'DRREDDY', 'CIPLA', 'DIVISLAB', 'EICHERMOT', 'HEROMOTOCO', 'BAJAJ-AUTO', 'BRITANNIA', 'APOLLOHOSP', 'INDUSINDBK', 'TATACONSUM', 'BPCL', 'SHRIRAMFIN', 'TRENT', 'BEL', 'HAL', 'LTIM', 'DMART', 'PIDILITIND', 'SIEMENS', 'GODREJCP', 'DABUR', 'HAVELLS', 'AMBUJACEM', 'SHREECEM', 'BANKBARODA', 'PNB', 'CANBK', 'IOC', 'GAIL', 'VEDL', 'DLF', 'ICICIPRULI', 'ICICIGI', 'SBICARD', 'MARICO', 'COLPAL', 'BERGEPAINT', 'TORNTPHARM', 'LUPIN', 'AUROPHARMA', 'ZYDUSLIFE', 'MOTHERSON', 'TVSMOTOR', 'BOSCHLTD', 'ABB', 'CHOLAFIN', 'MUTHOOTFIN', 'INDIGO', 'NAUKRI', 'JINDALSTEL', 'TATAPOWER', 'ADANIGREEN', 'ADANIPOWER', 'IRCTC', 'HDFCAMC', 'PFC', 'RECLTD', 'UNITDSPR', 'BAJAJHLDNG', 'ETERNAL', 'JIOFIN', 'POLYCAB', 'CGPOWER', 'VBL'];

// ---- settings (bot/config-in.json, written by the Bot settings tab) ----
export const IN_DEFAULTS = { stakeInr: 1000000, breakout: true, rsi2: true, breakoutShare: 50, posPct: 10, maxPos: 6, costPct: 0.15, rsiThreshold: 10, maxHold: 10, alerts: true, resetAt: null };
const clamp = (v, lo, hi, d) => { const n = +v; return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
export function normalizeIn(raw) {
  const r = raw || {}, D = IN_DEFAULTS;
  const c = {
    stakeInr: clamp(r.stakeInr, 10000, 1e9, D.stakeInr), breakout: r.breakout !== false, rsi2: r.rsi2 !== false,
    breakoutShare: clamp(r.breakoutShare, 0, 100, D.breakoutShare), posPct: clamp(r.posPct, 1, 50, D.posPct), maxPos: Math.round(clamp(r.maxPos, 1, 20, D.maxPos)),
    costPct: clamp(r.costPct, 0, 2, D.costPct), rsiThreshold: clamp(r.rsiThreshold, 1, 30, D.rsiThreshold), maxHold: Math.round(clamp(r.maxHold, 1, 30, D.maxHold)),
    alerts: r.alerts !== false, resetAt: typeof r.resetAt === 'string' && !isNaN(Date.parse(r.resetAt)) ? r.resetAt : null,
  };
  if (!c.breakout && !c.rsi2) c.breakout = true;                          // at least one strategy runs
  return c;
}

const r2 = x => Math.round(x * 100) / 100;
const lowest = (B, from, to) => { let lo = Infinity; for (let k = from; k < to; k++) lo = Math.min(lo, B[k].l); return lo; };
const highestClose = (C, from, to) => { let hi = -Infinity; for (let k = from; k < to; k++) hi = Math.max(hi, C[k]); return hi; };

// ---- the two strategies: identical to research.mjs ('breakout' and 'rsi2', regime filter off) ----
export const STRATS = {
  breakout: {
    label: 'Trend breakout', short: 'closes at a 50-day high above its 200-day average; sells on a close below its 20-day low',
    plan(B, C, i) { const s200 = sma(C, 200, i); if (!s200 || C[i] <= s200 || i < 50) return null; const hi = highestClose(C, i - 50, i); return C[i] > hi ? { rank: -C[i] / s200, why: `closed at ₹${r2(C[i])}, above its 50-day high ₹${r2(hi)} and its 200-day average ₹${r2(s200)}` } : null; },
    exit(B, C, j) { if (j < 20) return null; const lo = lowest(B, j - 20, j); return C[j] < lo ? `closed at ₹${r2(C[j])}, below its 20-day low ₹${r2(lo)}` : null; },
  },
  rsi2: {
    label: 'RSI-2 dip buying', short: 'uptrend stock (above its 200-day) whose RSI-2 fell below the buy level; sells on a close above its 5-day average or after the max hold',
    plan(B, C, i, cfg) { const s200 = sma(C, 200, i), r = rsi2(C, i); return s200 && r != null && C[i] > s200 && r < cfg.rsiThreshold ? { rank: r, why: `RSI-2 ${r.toFixed(1)} (below ${cfg.rsiThreshold}), above its 200-day average ₹${r2(s200)}` } : null; },
    exit(B, C, j, held, cfg) { const s5 = sma(C, 5, j); if (s5 && C[j] > s5) return `closed at ₹${r2(C[j])}, above its 5-day average ₹${r2(s5)}`; if (held >= cfg.maxHold) return `held ${cfg.maxHold} sessions`; return null; },
  },
};
const KEYS = Object.keys(STRATS);

// ---- journal ----
export function newJournal(cfg, startDate, niftyClose) {
  const shares = { breakout: cfg.breakout ? (cfg.rsi2 ? cfg.breakoutShare / 100 : 1) : 0, rsi2: cfg.rsi2 ? (cfg.breakout ? 1 - cfg.breakoutShare / 100 : 1) : 0 };
  const sleeves = {};
  for (const k of KEYS) { const start = Math.round(cfg.stakeInr * shares[k]); sleeves[k] = { on: start > 0, start, cash: start, open: [], pending: [], closed: [] }; }
  return { v: 1, sim: true, startedAt: new Date().toISOString(), startDate, stake: cfg.stakeInr, niftyStart: niftyClose, lastDate: startDate, sleeves, equity: [{ d: startDate, total: cfg.stakeInr, nifty: niftyClose }], acts: [] };
}
const sleeveValue = (S, data, d) => S.cash + S.open.reduce((t, p) => { const D = data[p.sym], j = D && D.idx[d]; const px = j != null ? D.C[j] : p.last; return t + p.qty * (px ?? p.entryPx); }, 0);

// One trading day for one sleeve: fill yesterday's plans at today's open, exits at today's close, plan tomorrow.
// Returns the events of the day (for the log and the alert).
export function stepSleeve(key, S, d, data, cfg, symbols) {
  const st = STRATS[key], cost = cfg.costPct / 100, ev = { bought: [], sold: [], planned: [], skipped: [] };
  // 1) yesterday's plans fill at today's open
  for (const o of S.pending) {
    const D = data[o.sym], j = D && D.idx[d];
    if (j == null) { ev.skipped.push(`${o.sym}: no trade on ${d}`); continue; }
    const fill = D.B[j].o; let qty = Math.floor(o.alloc / (fill * (1 + cost)));
    qty = Math.min(qty, Math.floor(S.cash / (fill * (1 + cost))));
    if (qty < 1) { ev.skipped.push(`${o.sym}: one share (₹${r2(fill)}) is more than the money left`); continue; }
    const paid = qty * fill * (1 + cost); S.cash -= paid;
    const p = { sym: o.sym, qty, entryPx: r2(fill), entryDate: d, held: 0, paid: r2(paid), why: o.why, last: D.C[j] };
    S.open.push(p); ev.bought.push(p);
  }
  S.pending = [];
  // 2) exits on today's close (positions bought today are first checked tomorrow, as in the research)
  for (const p of S.open) {
    if (p.entryDate === d) continue;
    const D = data[p.sym], j = D && D.idx[d]; if (j == null) continue;
    p.held++; p.last = D.C[j];
    const why = st.exit(D.B, D.C, j, p.held, cfg);
    if (why) {
      const px = D.C[j], got = p.qty * px * (1 - cost), pl = got - p.paid;
      const c = { sym: p.sym, qty: p.qty, inPx: p.entryPx, inDate: p.entryDate, outPx: r2(px), outDate: d, held: p.held, pl: r2(pl), plPct: r2(pl / p.paid * 100), why };
      S.cash += got; S.closed.push(c); p.done = true; ev.sold.push(c);
    }
  }
  S.open = S.open.filter(p => !p.done);
  for (const p of S.open) { const D = data[p.sym], j = D && D.idx[d]; if (j != null) p.last = D.C[j]; }
  // 3) plans for tomorrow's open, from today's close: deepest / strongest first, while slots and cash last
  const equity = sleeveValue(S, data, d);
  const cands = [];
  for (const sym of symbols) {
    const D = data[sym], i = D && D.idx[d]; if (i == null || i < 210 || S.open.some(p => p.sym === sym)) continue;
    const pl = st.plan(D.B, D.C, i, cfg); if (pl) cands.push({ sym, ...pl, close: D.C[i] });
  }
  cands.sort((a, b) => a.rank - b.rank);
  let cash = S.cash, slots = cfg.maxPos - S.open.length;
  for (const c of cands) {
    if (slots <= 0) break;
    const alloc = equity * cfg.posPct / 100; if (alloc > cash) break;
    S.pending.push({ sym: c.sym, plannedOn: d, alloc: r2(alloc), why: c.why, close: r2(c.close) }); ev.planned.push(c.sym);
    cash -= alloc; slots--;
  }
  S.value = r2(equity);
  return ev;
}

// What the strategies are looking at, for the India view: the names closest to triggering.
export function watchList(data, d, cfg, symbols) {
  const rows = [];
  for (const sym of symbols) {
    const D = data[sym], i = D && D.idx[d]; if (i == null || i < 210) continue;
    const C = D.C, s200 = sma(C, 200, i), r = rsi2(C, i), hi50 = highestClose(C, i - 50, i);
    if (!s200 || r == null) continue;
    const base = C.slice(0, i + 1);
    rows.push({ s: sym, px: r2(C[i]), up: C[i] > s200, s200: r2(s200), r2: Math.round(r * 10) / 10, hi50: r2(hi50), toHi: r2((hi50 / C[i] - 1) * 100), buyAt: C[i] > s200 ? rsi2Trigger(base, cfg.rsiThreshold, 'long') : null });
  }
  return {
    breakout: rows.filter(x => x.up).sort((a, b) => a.toHi - b.toHi).slice(0, 12).map(x => ({ s: x.s, px: x.px, level: x.hi50, gapPct: x.toHi, s200: x.s200 })),
    rsi2: rows.filter(x => x.up).sort((a, b) => a.r2 - b.r2).slice(0, 12).map(x => ({ s: x.s, px: x.px, r2: x.r2, buyAt: x.buyAt == null ? null : r2(x.buyAt), s200: x.s200 })),
    total: rows.length,
  };
}

// Apply share splits / bonuses that happened after a position was bought (Yahoo history is split-adjusted).
export function applySplits(J, splits) {
  const out = [];
  for (const k of KEYS) for (const p of J.sleeves[k].open) for (const s of (splits[p.sym] || [])) {
    if (s.d > p.entryDate && !(p.splits || []).includes(s.d)) { const f = s.num / s.den; p.qty = Math.round(p.qty * f); p.entryPx = r2(p.entryPx / f); (p.splits = p.splits || []).push(s.d); out.push(`${p.sym} ${s.num}:${s.den} split on ${s.d}`); }
  }
  return out;
}

// Process every completed trading day after J.lastDate. `days` = benchmark (^NSEI) dates, oldest first.
export function processDays(J, days, data, cfg, symbols, bench) {
  const events = [];
  for (const d of days.filter(x => x > J.lastDate)) {
    const evs = {};
    for (const k of KEYS) if (J.sleeves[k].on) evs[k] = stepSleeve(k, J.sleeves[k], d, data, cfg, symbols);
    const total = KEYS.reduce((t, k) => t + (J.sleeves[k].on ? sleeveValue(J.sleeves[k], data, d) : 0), 0);
    J.equity.push({ d, total: r2(total), nifty: bench.idx[d] != null ? bench.C[bench.idx[d]] : null, ...Object.fromEntries(KEYS.map(k => [k, J.sleeves[k].on ? r2(sleeveValue(J.sleeves[k], data, d)) : null])) });
    J.lastDate = d; events.push({ d, evs });
    for (const k of KEYS) { const e = evs[k]; if (!e) continue; const L = STRATS[k].label;
      e.bought.forEach(p => J.acts.push({ t: d, m: `${L}: bought ${p.qty} ${p.sym} at ₹${p.entryPx} (open) — ${p.why}` }));
      e.sold.forEach(c => J.acts.push({ t: d, m: `${L}: sold ${c.qty} ${c.sym} at ₹${c.outPx} (close), ${c.pl >= 0 ? '+' : '−'}₹${Math.abs(Math.round(c.pl)).toLocaleString('en-IN')} (${c.plPct >= 0 ? '+' : ''}${c.plPct}%) after ${c.held} sessions — ${c.why}` }));
      if (e.planned.length) J.acts.push({ t: d, m: `${L}: will buy at the next open: ${e.planned.join(', ')}` });
      e.skipped.forEach(m => J.acts.push({ t: d, m: `${L}: skipped ${m}` })); }
  }
  J.acts = J.acts.slice(-150);
  return events;
}

// The Telegram summary for one processed day.
export function dayMessage(J, ev, cfg) {
  const inr = v => '₹' + Math.round(v).toLocaleString('en-IN'), last = J.equity[J.equity.length - 1];
  const ret = (last.total / J.stake - 1) * 100, nret = J.niftyStart && last.nifty ? (last.nifty / J.niftyStart - 1) * 100 : null;
  const lines = [`🇮🇳 India bot (simulation) — ${ev.d}`];
  for (const k of KEYS) { const e = ev.evs[k]; if (!e) continue; const L = STRATS[k].label;
    e.bought.forEach(p => lines.push(`🟢 ${L}: bought ${p.qty} ${p.sym} @ ₹${p.entryPx} (${inr(p.paid)})`));
    e.sold.forEach(c => lines.push(`${c.pl >= 0 ? '✅' : '🔻'} ${L}: sold ${c.qty} ${c.sym} @ ₹${c.outPx} · ${c.pl >= 0 ? '+' : '−'}${inr(Math.abs(c.pl))} (${c.plPct >= 0 ? '+' : ''}${c.plPct}%)`));
    if (e.planned.length) lines.push(`🕘 ${L}: buys at tomorrow's open: ${e.planned.join(', ')}`); }
  if (lines.length === 1) lines.push('No trades today.');
  lines.push(`Value ${inr(last.total)} (${ret >= 0 ? '+' : ''}${ret.toFixed(2)}% since ${J.startDate})${nret == null ? '' : ` · Nifty 50 ${nret >= 0 ? '+' : ''}${nret.toFixed(2)}%`}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- runner ----------------------------------------------
const YAHOO = () => (process.env.YAHOO_BASE || 'https://query1.finance.yahoo.com').replace(/\/$/, '');
async function pull(sym) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(`${YAHOO()}/v8/finance/chart/${encodeURIComponent(sym)}?range=2y&interval=1d&events=split`, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const res = (await r.json()).chart.result[0], q = res.indicators.quote[0], B = [];
    const day = ts => new Date((ts + 5.5 * 3600) * 1000).toISOString().slice(0, 10);     // the IST trading date
    res.timestamp.forEach((ts, i) => { if (q.close[i] != null && q.open[i] != null && q.high[i] != null && q.low[i] != null) B.push({ d: day(ts), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] }); });
    const splits = Object.values((res.events && res.events.splits) || {}).map(s => ({ d: day(s.date), num: +s.numerator, den: +s.denominator })).filter(s => s.num > 0 && s.den > 0);
    return { B, splits };
  } finally { clearTimeout(t); }
}
const istNow = () => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).map(x => [x.type, x.value])); return { d: `${p.year}-${p.month}-${p.day}`, mins: (+p.hour % 24) * 60 + +p.minute }; };

async function loadJournal(file, pass) {
  let raw = null; try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
  if (!raw || !raw.enc) return raw;
  if (!pass) { console.log('journal is encrypted but JOURNAL_KEY is missing — starting fresh'); return null; }
  try { return await decryptJournal(raw, pass); } catch (e) { console.log('previous India journal could not be decrypted — starting fresh'); return null; }
}
async function saveJournal(file, J, pass) {
  const body = { ...J, at: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(pass ? { ...(await encryptJournal(body, pass)), at: body.at, lastDate: J.lastDate, sim: true } : body));
}

export async function runIndia({ file = 'bot/india-journal.json', cfgFile = 'bot/config-in.json', log = console.log } = {}) {
  let cfgRaw = null; try { cfgRaw = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch (e) {}
  const cfg = normalizeIn(cfgRaw), pass = process.env.JOURNAL_KEY || '';
  const now = istNow();
  const bench = await pull('^NSEI');
  // a bar dated today is complete only after the close (15:30 IST; wait to 15:45 for the official close price)
  const done = b => b.d < now.d || (b.d === now.d && now.mins >= 15 * 60 + 45);
  const days = bench.B.filter(done).map(b => b.d);
  if (!days.length) { log('no completed NSE trading day yet'); return null; }
  const benchD = { B: bench.B, C: bench.B.map(b => b.c), idx: Object.fromEntries(bench.B.map((b, i) => [b.d, i])) };
  const symbols = NIFTY100.map(s => s + '.NS'), data = {}, splits = {};
  for (const s of symbols) {
    try { const { B, splits: sp } = await pull(s); const Bd = B.filter(done); data[s] = { B: Bd, C: Bd.map(b => b.c), idx: Object.fromEntries(Bd.map((b, i) => [b.d, i])) }; splits[s] = sp; }
    catch (e) { log('skip', s, e.message); }
    await new Promise(r => setTimeout(r, +(process.env.YAHOO_PAUSE_MS ?? 200)));
  }
  let J = await loadJournal(file, pass);
  const latest = days[days.length - 1];
  if (!J || (cfg.resetAt && Date.parse(cfg.resetAt) > Date.parse(J.startedAt))) {
    J = newJournal(cfg, latest, benchD.C[benchD.idx[latest]]);
    // first evening: plan tomorrow's entries from today's close so the first fills happen at the next open
    for (const k of KEYS) if (J.sleeves[k].on) { const ev = stepSleeve(k, J.sleeves[k], latest, data, cfg, symbols.filter(s => data[s])); if (ev.planned.length) J.acts.push({ t: latest, m: `${STRATS[k].label}: will buy at the next open: ${ev.planned.join(', ')}` }); }
    J.acts.push({ t: latest, m: `Simulation started with ₹${cfg.stakeInr.toLocaleString('en-IN')} (${Object.entries(J.sleeves).filter(([, S]) => S.on).map(([k, S]) => STRATS[k].label + ' ₹' + S.start.toLocaleString('en-IN')).join(', ')})` });
    log('India simulation started on', latest);
  }
  const sp = applySplits(J, splits); sp.forEach(m => J.acts.push({ t: latest, m: 'Adjusted for ' + m }));
  const events = processDays(J, days, data, cfg, symbols.filter(s => data[s]), benchD);
  J.watch = { d: latest, ...watchList(data, latest, cfg, symbols.filter(s => data[s])) };
  J.cfg = cfg; J.universe = { listed: symbols.length, loaded: Object.keys(data).length };
  await saveJournal(file, J, pass);
  log(`India simulation: ${events.length} new day(s), last ${J.lastDate}`);
  if (cfg.alerts && tgOn()) for (const ev of events) { try { await tgSend(dayMessage(J, ev, cfg)); } catch (e) { log('telegram failed', e.message); } }
  return { J, events };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runIndia().catch(e => { console.error('India run failed:', e.message); process.exit(1); });
}
