// Signal Desk paper-trading bot — runs every 5 minutes via GitHub Actions.
// Trades an ALPACA PAPER account (fake money, real prices). Stateless: each run rebuilds
// its picture from the broker; trade plans ride inside each order's client_order_id.
//
// What it trades
//  - Stock day trades (long): limit buy at S3 on uptrend+washout stocks, sell limit at R1.
//    At 3:45pm ET winners and small losers are sold. A stock down more than BOT_HOLD_LOSS%
//    is HELD instead of sold, with a sell limit at breakeven (+0.3%) until it recovers.
//    Hard floor BOT_HOLD_FLOOR% and max BOT_MAX_HOLD_DAYS still apply to held stocks.
//  - CALLs on the same long setups, PUTs on the mirror (downtrend+stretched) setups,
//    bought when the stock touches the entry level. Exits: half at +50%, all at +100%,
//    all at -50%, all by 3:40pm the next session, never into expiry day.
// Safety: paper endpoint by default; bot/STOP file flattens and halts; daily loss cap.
import fs from 'node:fs';
import { sma, rsi2, liveSignal, rsi2Trigger, rsi2ExitLevel, r2d, rsi2Signal, rsi2Exit, rsi2ShortSignal, rsi2ShortExit } from './strategy.mjs';
import { buildJournal } from './journal.mjs';
import { guard, loadEvents, symbolRisk } from './news.mjs';
import { sectorOf, stockQty, optionQty, regimeOf, lossStreak, openRisk } from './risk.mjs';
import { normalize, entryEndMin, summary as cfgSummary } from './config.mjs';
import { scanUniverse } from './scan.mjs';

const PAPER = { key: process.env.ALPACA_KEY, secret: process.env.ALPACA_SECRET, url: process.env.ALPACA_URL || 'https://paper-api.alpaca.markets' };
const LIVE = { key: process.env.ALPACA_LIVE_KEY, secret: process.env.ALPACA_LIVE_SECRET, url: 'https://api.alpaca.markets' };
export const HAVE_KEYS = !!(PAPER.key && PAPER.secret) || !!(LIVE.key && LIVE.secret);
let KEY, SECRET, H;
const PRIVATE = !!process.env.JOURNAL_KEY;                  // privacy mode: encrypted journal, redacted logs
export const redact = s => PRIVATE ? String(s).replace(/\$?\d[\d,]*(\.\d+)?/g, '\u2022') : String(s);
const DATA = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';
const DRY = process.env.BOT_DRY === '1';
const NTFY = process.env.NTFY_TOPIC || '';
const HOLD_LOSS = 1.5, MAX_HOLD_DAYS = 30, TP = 1;

// ---- settings: bot/config.json (written by the Settings tab), re-applied live by applyConfig() ----
export let CFG = normalize(null);
let BASE, STK_ON, OPT_ON, PUT_ON, MAX_POS, MAX_OPT, OPT_TP, LOSS_CAP, HOLD_FLOOR, UNIVERSE, RISK_PCT, OPT_RISK_PCT, MAX_HEAT, MAX_PER_SECTOR, MAX_STREAK, WEEK_CAP, STALE_MIN, ENTRY_END;
export function applyConfig(raw) {
  CFG = normalize(raw);
  const wantLive = CFG.mode === 'live', canLive = !!(LIVE.key && LIVE.secret);
  const acct = wantLive && canLive ? LIVE : PAPER;
  if (wantLive && !canLive) console.log('Live mode requested but no live keys are set \u2014 staying on paper.');
  BASE = acct.url; KEY = acct.key; SECRET = acct.secret;
  H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET, 'content-type': 'application/json' };
  STK_ON = CFG.stocks; OPT_ON = CFG.options; PUT_ON = !!CFG.puts; MAX_POS = CFG.maxPositions; MAX_OPT = CFG.maxOptions; OPT_TP = CFG.optTakeProfit;
  LOSS_CAP = CFG.dayCap; HOLD_FLOOR = CFG.holdFloor; UNIVERSE = CFG.universe === 'scan' && scanCache.symbols ? scanCache.symbols : CFG.symbols; RISK_PCT = CFG.riskPct; OPT_RISK_PCT = CFG.optRiskPct;
  MAX_HEAT = CFG.maxHeat; MAX_PER_SECTOR = CFG.perSector; MAX_STREAK = CFG.streak; WEEK_CAP = CFG.weekCap; STALE_MIN = CFG.staleMin; ENTRY_END = entryEndMin(CFG);
  return CFG;
}
// Market-scan universe: rebuilt once per trading day (and whenever the scan settings change).
let scanCache = { day: '', key: '', symbols: null, info: null };
async function ensureUniverse() {
  if (CFG.universe !== 'scan') { UNIVERSE = CFG.symbols; return; }
  const key = CFG.scanSize + ':' + CFG.scanMinPrice;
  if (scanCache.symbols && scanCache.day === TODAY && scanCache.key === key) { UNIVERSE = scanCache.symbols; return; }
  try {
    const r = await scanUniverse({ T, D, size: CFG.scanSize, minPrice: CFG.scanMinPrice, log: m => act(m) });
    if (r.symbols.length >= 5) { scanCache = { day: TODAY, key, symbols: r.symbols, info: r }; UNIVERSE = r.symbols; barsCache = { at: 0, bars: null }; }
    else act('market scan returned too few stocks (' + r.symbols.length + ') \u2014 keeping the previous list');
  } catch (e) { act('market scan failed (' + (e.message || e).slice(0, 80) + ') \u2014 using ' + (scanCache.symbols ? "yesterday's scan" : 'the listed stocks')); }
  if (!scanCache.symbols) UNIVERSE = CFG.symbols;
}
export const scanInfo = () => scanCache.info;
export function loadConfigFile() { try { return JSON.parse(fs.readFileSync('bot/config.json', 'utf8')); } catch (e) { return null; } }
applyConfig(loadConfigFile());

// Every broker call has a deadline, and reads are retried with backoff on rate limits, server errors and network
// faults. Order placement (POST) is never retried here: a repeat could double a position, and the idempotency
// guard in send() plus the client_order_id already protect against the slow-broker case.
const HTTP_TIMEOUT_MS = +process.env.HTTP_TIMEOUT_MS || 15000, HTTP_RETRIES = 3;
const sleepMs = ms => new Promise(z => setTimeout(z, ms));
async function call(base, path, opt = {}) {
  const method = (opt.method || 'GET').toUpperCase(), retriable = method !== 'POST';
  let lastErr = null;
  for (let attempt = 0; attempt <= (retriable ? HTTP_RETRIES : 0); attempt++) {
    if (attempt) await sleepMs(Math.min(8000, 1000 * 2 ** (attempt - 1)) + Math.random() * 300);
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), HTTP_TIMEOUT_MS);
    let again = false;
    try {
      const r = await fetch(base + path, { headers: H, ...opt, signal: ac.signal });
      if (r.status === 204) return null;
      const tx = await r.text();
      if (r.ok) return tx ? JSON.parse(tx) : null;
      lastErr = new Error(path.split('?')[0] + ' HTTP ' + r.status + ' ' + tx.slice(0, 200));
      again = r.status === 429 || r.status >= 500;                                 // other 4xx: our mistake, retrying will not help
    } catch (e) {
      lastErr = new Error(path.split('?')[0] + ' ' + (e.name === 'AbortError' ? `timed out after ${HTTP_TIMEOUT_MS / 1000}s` : e.message));
      again = e.name === 'AbortError' || /fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket/i.test(e.message);
    } finally { clearTimeout(timer); }
    if (!again || !retriable) break;
  }
  throw lastErr;
}
const T = (p, o) => call(BASE, p, o), D = (p, o) => call(DATA, p, o);
export const httpCall = call;                               // for tests only
// Idempotency: never send the same order twice, even if the broker is slow to list it.
const placed = new Map();
// Price and profit detail for phone alerts (setting alertDetail, on by default). Buys show size and limit price;
// sells show the position's entry price, the current price and the open profit at the moment the sell is sent.
let posBySym = {};
const money = n => (n < 0 ? '\u2212$' : '$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
function alertDetail(body) {
  if (CFG.alertDetail === false) return '';
  const opt = isOpt(body.symbol), mult = opt ? 100 : 1;
  if (body.side === 'buy') return body.limit_price ? ` \u00b7 ${body.qty} ${opt ? 'contract' : 'share'}${+body.qty === 1 ? '' : 's'} @ $${opt ? (+body.limit_price * 100).toFixed(2) + '/contract' : body.limit_price}${+body.qty > 0 ? ' (' + money(+body.qty * +body.limit_price * mult) + ')' : ''}` : '';
  const p = posBySym[body.symbol]; if (!p) return '';
  const avg = +p.avg_entry_price, cur = +p.current_price, pl = +p.unrealized_pl, plpc = +p.unrealized_plpc * 100;
  if (!(avg > 0) || !(cur > 0)) return '';
  const unit = opt ? '/contract' : '';
  return ` \u00b7 bought $${(avg * mult).toFixed(2)}${unit}, selling \u2248$${(cur * mult).toFixed(2)}${unit} \u2192 ${pl >= 0 ? '+' : ''}${money(pl)} (${plpc >= 0 ? '+' : ''}${plpc.toFixed(1)}%)`;
}
const send = async (body, why) => { why = why + alertDetail(body); const dk = body.side + ':' + body.symbol + ':' + body.type, t0 = placed.get(dk); if (t0 && Date.now() - t0 < (body.side === 'buy' ? 6 * 3600e3 : 90e3)) { console.log('duplicate suppressed:', dk); return null; } placed.set(dk, Date.now()); alerts.push((body.side === 'buy' ? '\ud83d\udfe2 ' : '\ud83d\udd34 ') + why); act(why + ' — ' + body.side.toUpperCase() + ' ' + body.qty + ' ' + body.symbol + (body.limit_price ? ' @ ' + body.limit_price : ' at market')); if (!DRY) return T('/v2/orders', { method: 'POST', body: JSON.stringify(body) }); };

// ---- time in New York ----
const etParts = d => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map(p => [p.type, p.value]));
let TODAY = '', MINS = 0;                                   // yyyymmdd, minutes past midnight ET
export function setNow() { const ep = etParts(new Date()); TODAY = ep.year + ep.month + ep.day; MINS = (+ep.hour % 24) * 60 + +ep.minute; return MINS; }
setNow();
const ymdDash = ms => { const e = etParts(new Date(ms)); return e.year + '-' + e.month + '-' + e.day; };
const rid = () => Math.random().toString(36).slice(2, 7);
const OPT_RE = /^([A-Z.]+)(\d{6})([CP])(\d{8})$/;
const isOpt = s => OPT_RE.test(s);
const tick = p => p >= 3 ? Math.round(p * 20) / 20 : Math.round(p * 100) / 100;
const acts = [], seen = new Map();
const act = m => {                                          // same message within 10 min is logged once
  const k = m.replace(/[-+]?\d+(\.\d+)?%/g, '#');
  if (seen.has(k) && Date.now() - seen.get(k) < 10 * 60000) return;
  seen.set(k, Date.now()); console.log(redact(m)); acts.push({ t: new Date().toISOString(), m });
};
let lastWatch = null, lastSignals = null, lastClock = null, barsCache = { at: 0, bars: null }, lastPosSig = '', pendingActs = 0;
let newsCache = { at: 0, market: [], syms: [], ok: true }, lastGuard = null, spyPrev = null, weekCache = { at: 0, start: null }, fillsCache = { at: 0, closed: [] }, lastRisk = null;
const alerts = [];

// One full decision cycle: manage every position, then look for new entries.
let hooks = {};
export async function botCycle({ journal = false, floors = null, held = null } = {}) {
  setNow(); hooks = { floors, held };
  const before = acts.length;
  try { await run(); } catch (e) { act('Error: ' + (e.message || e)); const k = 'err:' + (e.message || '').slice(0, 40); if (!seen.has(k) || Date.now() - seen.get(k) > 30 * 60000) { seen.set(k, Date.now()); alerts.push('\u26a0\ufe0f Bot error: ' + (e.message || e)); } }
  await flushAlerts();
  pendingActs += acts.length - before;
  if (journal || pendingActs) { await writeJournal().catch(e => console.log('journal error', e.message)); pendingActs = 0; }
  return { open: !!(lastClock && lastClock.is_open) };
}

// Cheap 1-second check (2 requests): does anything need a full cycle right now?
const fired = new Set();
export async function fastCheck() {
  setNow();
  if (!lastClock || !lastClock.is_open) return false;
  const pos = await T('/v2/positions');
  const sig = pos.map(p => p.symbol + ':' + p.qty).sort().join(',');
  if (sig !== lastPosSig) { lastPosSig = sig; return 'a fill happened'; }      // bought or sold: re-plan, maybe re-enter
  for (const p of pos) {
    const pc = +p.unrealized_plpc * 100;
    if (isOpt(p.symbol) && (pc <= -50 || pc >= OPT_TP)) return p.symbol + ' option exit level';
    if (!isOpt(p.symbol) && HOLD_FLOOR > 0 && pc <= -HOLD_FLOOR) return p.symbol + ' hard floor';
  }
  if (OPT_ON && lastSignals && MINS >= 585 && MINS < 900) {
    const syms = [...new Set(lastSignals.longs.concat(lastSignals.shorts).map(s => s.sym))];
    if (syms.length) {
      const tr = (await D(`/v2/stocks/trades/latest?symbols=${syms.join(',')}&feed=iex`)).trades || {};
      for (const s of lastSignals.longs) { const px = tr[s.sym] && tr[s.sym].p; const k = TODAY + 'C' + s.sym; if (px && px <= s.entry * 1.002 && !fired.has(k)) { fired.add(k); return s.sym + ' touched CALL entry ' + s.entry; } }
      for (const s of lastSignals.shorts) { const px = tr[s.sym] && tr[s.sym].p; const k = TODAY + 'P' + s.sym; if (px && px >= s.entry * 0.998 && !fired.has(k)) { fired.add(k); return s.sym + ' touched PUT entry ' + s.entry; } }
    }
  }
  return false;
}
export const clockInfo = () => lastClock;
// Live prices pushed by the market-data stream (live.mjs). Fresh = under 5 seconds old.
export const livePx = {};
export const streamStats = { ticks: 0, fills: 0, lastTick: 0 };
export function pushPrice(sym, px, t) { livePx[sym] = { p: px, at: t || Date.now() }; streamStats.ticks++; streamStats.lastTick = Date.now(); }
async function latestPrices(syms) {
  const out = {}, miss = [];
  for (const s of syms) { const v = livePx[s]; if (v && Date.now() - v.at < 5000) out[s] = { p: v.p }; else miss.push(s); }
  if (miss.length) { try { Object.assign(out, (await D(`/v2/stocks/trades/latest?symbols=${miss.join(',')}&feed=iex`)).trades || {}); } catch (e) {} }
  return out;
}
export const endpoints = () => ({ trading: BASE, key: KEY, secret: SECRET, universe: CFG.universe === 'scan' ? [...new Set((lastWatch ? lastWatch.buy.concat(lastWatch.put) : []))].slice(0, 25) : UNIVERSE });

// Daily bars for the universe + anything we hold; refreshed every 30 minutes (~230 sessions).
async function loadBars(extra = []) {
  const want = [...new Set(UNIVERSE.concat(extra))];
  if (barsCache.bars && Date.now() - barsCache.at < 30 * 60000 && want.every(s => barsCache.bars[s])) return barsCache.bars;
  const start = new Date(Date.now() - 340 * 864e5).toISOString(), b2 = {};
  let token = '';
  for (let k = 0; k < 20; k++) {
    const j = await D(`/v2/stocks/bars?symbols=${want.join(',')}&timeframe=1Day&start=${start}&limit=10000&adjustment=split&feed=iex&sort=asc${token ? '&page_token=' + token : ''}`);
    for (const [s, arr] of Object.entries(j.bars || {})) b2[s] = (b2[s] || []).concat(arr);
    token = j.next_page_token; if (!token) break;
  }
  barsCache = { at: Date.now(), bars: b2 };
  return b2;
}
const completed = (bars, sym) => (bars[sym] || []).filter(b => b.t.slice(0, 10) < ymdDash(Date.now())).map(b => ({ d: b.t.slice(0, 10), o: b.o, h: b.h, l: b.l, c: b.c }));
const dash8 = s => s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);

// Phone alerts via ntfy.sh (free): install the ntfy app, subscribe to your secret topic name.
const sentAlerts = new Map();
async function flushAlerts() {
  if (!alerts.length) return;
  const lines = alerts.splice(0).filter(m => { const k = m.replace(/[\d.]+/g, '#'); if (sentAlerts.has(k) && Date.now() - sentAlerts.get(k) < 20 * 60000) return false; sentAlerts.set(k, Date.now()); return true; });
  if (!NTFY || !lines.length || DRY || !CFG.alerts) return;
  try {
    await fetch('https://ntfy.sh/' + encodeURIComponent(NTFY), { method: 'POST', body: lines.join('\n'),
      headers: { Title: 'Signal Desk bot' + (lines.length > 1 ? ' (' + lines.length + ')' : ''), Priority: lines.some(l => /\u26d4|\u26a0/.test(l)) ? 'high' : 'default', Tags: 'chart_with_upwards_trend' } });
  } catch (e) { console.log('alert failed', e.message); }
}

async function run() {
  await ensureUniverse();
  if (!lastClock || Date.now() - (lastClock._at || 0) > 30000) { lastClock = await T('/v2/clock'); lastClock._at = Date.now(); }
  const clock = lastClock;
  if (!clock.is_open) { console.log('Market closed.'); return; }
  const acct = await T('/v2/account');
  const equity = +acct.equity, lastEq = +acct.last_equity || equity;
  const positions = await T('/v2/positions');
  posBySym = Object.fromEntries(positions.map(p => [p.symbol, p]));
  const openOrders = await T('/v2/orders?status=open&limit=500');
  const hist = await T('/v2/orders?status=all&limit=500&direction=desc&after=' + new Date(Date.now() - 45 * 864e5).toISOString());
  const stockPos = positions.filter(p => !isOpt(p.symbol)), optPos = positions.filter(p => isOpt(p.symbol));
  if (hooks.held) { hooks.held.clear(); positions.forEach(p => hooks.held.add(isOpt(p.symbol) ? OPT_RE.exec(p.symbol)[1] : p.symbol)); }
  if (hooks.floors) { const seenF = new Set(); for (const p of stockPos) { seenF.add(p.symbol); hooks.floors(p.symbol, HOLD_FLOOR > 0 ? +p.avg_entry_price * (1 - HOLD_FLOOR / 100) : null); } }

  // ---- news & events guard (calendar + live headlines + SPY tone) ----
  if (Date.now() - newsCache.at > 60000) {
    try {
      const since = h => new Date(Date.now() - h * 3600e3).toISOString();
      const mk = (await D(`/v1beta1/news?limit=50&sort=desc&start=${since(3)}`)).news || [];
      const newsSyms = CFG.universe === 'scan' ? [...new Set((lastWatch ? lastWatch.buy.concat(lastWatch.put) : []).concat(positions.map(p => isOpt(p.symbol) ? OPT_RE.exec(p.symbol)[1] : p.symbol)))] : UNIVERSE;
      const sy = newsSyms.length ? (await D(`/v1beta1/news?symbols=${newsSyms.join(',')}&limit=50&sort=desc&start=${since(72)}`)).news || [] : [];
      newsCache = { at: Date.now(), market: mk, syms: sy, ok: true };
    } catch (e) { newsCache = { ...newsCache, at: Date.now(), ok: false }; act('News feed unavailable (' + e.message.slice(0, 60) + ') \u2014 calendar rules still apply'); }
  }
  let spyPct = null;
  try {
    if (!spyPrev || spyPrev.day !== TODAY) {
      const sb = ((await D(`/v2/stocks/bars?symbols=SPY&timeframe=1Day&start=${new Date(Date.now() - 450 * 864e5).toISOString()}&limit=1000&adjustment=split&feed=iex&sort=asc`)).bars || {}).SPY || [];
      const done = sb.filter(b => b.t.slice(0, 10) < ymdDash(Date.now()));
      const prev = done[done.length - 1];
      spyPrev = prev ? { day: TODAY, c: prev.c, closes: done.map(b => b.c) } : null;
    }
    const st = (await latestPrices(['SPY'])).SPY;
    if (spyPrev && st) spyPct = (st.p / spyPrev.c - 1) * 100;
  } catch (e) {}
  const G = lastGuard = guard({ events: CFG.eventGuard ? loadEvents() : [], todayDash: ymdDash(Date.now()), mins: MINS, headlines: CFG.newsGuard ? newsCache.market : [], spyPct });
  G.spyPct = spyPct; G.newsOk = newsCache.ok;
  const RG = regimeOf(spyPrev && spyPrev.closes);
  G.regime = RG.regime; G.longSize = 1;
  if (RG.regime === 'bear') G.reasons.push('Bear market regime (SPY below its 50- and 200-day averages) \u2014 fewer stocks qualify, since each must be above its own 200-day');   // reported, not enforced: the filter did not improve RSI-2 in the research
  // (neutral regime: no size change for RSI-2)
  // circuit breakers: losing streak today, weekly drawdown
  try {
    if (Date.now() - fillsCache.at > 60000) {
      const f = await T('/v2/account/activities/FILL?date=' + ymdDash(Date.now()) + '&direction=asc&page_size=100');
      fillsCache = { at: Date.now(), closed: buildJournal(f || [], []).closed };
    }
    const streak = lossStreak(fillsCache.closed);
    if (streak >= MAX_STREAK) { G.block = true; G.halt = true; G.reasons.push(`${streak} losing trades in a row today \u2014 done for the day (protects against a bad tape)`); }
    if (Date.now() - weekCache.at > 10 * 60000) {
      const h = await T('/v2/account/portfolio/history?period=1W&timeframe=1D');
      const eqs = (h && h.equity || []).filter(x => x != null && x > 0);
      weekCache = { at: Date.now(), start: eqs.length ? eqs[0] : null };
    }
    if (weekCache.start && (equity / weekCache.start - 1) * 100 <= -WEEK_CAP) { G.block = true; G.halt = true; G.reasons.push(`Down ${((1 - equity / weekCache.start) * 100).toFixed(1)}% this week (limit ${WEEK_CAP}%) \u2014 no new trades until next week`); }
  } catch (e) { console.log('breaker check failed', e.message); }
  for (const r of G.reasons) act('Market check: ' + r);
  if (G.halt) alerts.push('\u26d4 ' + G.reasons[G.reasons.length - 1]);
  const sellsFor = sym => openOrders.filter(o => o.symbol === sym && o.side === 'sell');
  const cid = o => o.client_order_id || '';

  // ---- kill switch ----
  if (fs.existsSync('bot/STOP')) {
    act('STOP file found — cancelling all orders and closing everything.');
    if (!DRY) { await T('/v2/orders', { method: 'DELETE' }); await T('/v2/positions?cancel_orders=true', { method: 'DELETE' }); }
    return;
  }
  const dayPct = lastEq > 0 ? (equity - lastEq) / lastEq * 100 : 0;
  // Pattern-day-trader rule: under $25k, a 4th same-day round trip in 5 business days gets the account restricted.
  const pdtNear = equity < 25000 && +acct.daytrade_count >= 3 && !acct.pattern_day_trader;
  if (pdtNear) act(`Day-trade limit reached (${acct.daytrade_count} in 5 days, account under $25k) \u2014 no same-day exits today except emergencies`);
  // Money per trade and per-sleeve ceilings: each sleeve (stock / CALL / PUT) is sized in % of the account or fixed dollars.
  const amt = (unit, pct, usd) => CFG[unit] === 'usd' ? CFG[usd] : equity * CFG[pct] / 100;
  const SL = {
    stock: { per: amt('stockUnit', 'stockPct', 'stockUsd'), cap: amt('stockUnit', 'stockCapPct', 'stockCapUsd'), used: 0 },
    call:  { per: amt('callUnit', 'optPct', 'callUsd'),     cap: amt('callUnit', 'callCapPct', 'callCapUsd'),     used: 0 },
    put:   { per: amt('putUnit', 'putPct', 'putUsd'),       cap: amt('putUnit', 'putCapPct', 'putCapUsd'),       used: 0 },
  };
  const kindOf = sym => !isOpt(sym) ? 'stock' : (OPT_RE.exec(sym) || [])[3] === 'P' ? 'put' : 'call';
  for (const p of positions) SL[kindOf(p.symbol)].used += Math.abs(+p.market_value || 0);
  const slBudget = k => Math.max(0, Math.min(SL[k].per * G.budget, SL[k].cap > 0 ? SL[k].cap - SL[k].used : Infinity));
  const capNote = k => SL[k].cap > 0 && SL[k].cap - SL[k].used < SL[k].per ? ` (${k} money ceiling $${Math.round(SL[k].cap)}, $${Math.round(SL[k].used)} already in use)` : '';
  const capHit = dayPct <= -LOSS_CAP;

  // ---- cancel stale entries ----
  for (const o of openOrders) {
    if (o.side !== 'buy' || !/^sd-[sorq]-/.test(cid(o))) continue;
    if (Date.now() - Date.parse(o.submitted_at || o.created_at || Date.now()) > STALE_MIN * 60000) {
      act(`${o.symbol} buy at ${o.limit_price} unfilled for ${STALE_MIN} min \u2014 cancelled (setup is stale)`);
      if (!DRY) await T('/v2/orders/' + o.id, { method: 'DELETE' }).catch(() => {});
      o._cancelled = true;
    }
  }
  const liveOrders = openOrders.filter(o => !o._cancelled);
  for (const o of liveOrders) if (o.side === 'buy') SL[kindOf(o.symbol)].used += (+o.qty || 0) * (+o.limit_price || 0) * (isOpt(o.symbol) ? 100 : 1);

  // ---- RSI-2 swing positions: sell at the close once above the 5-day average (or after 10 sessions) ----
  const swingStk = stockPos.map(p => ({ p, e: hist.find(o => o.side === 'buy' && o.status === 'filled' && cid(o).startsWith('sd-r-' + p.symbol + '-')) })).filter(x => x.e);
  const swingOpt = optPos.map(p => ({ p, e: hist.find(o => o.side === 'buy' && o.status === 'filled' && (cid(o).startsWith('sd-q-' + p.symbol + '-') || cid(o).startsWith('sd-p-' + p.symbol + '-'))) })).filter(x => x.e);
  if (swingStk.length || swingOpt.length) {
    const unds = [...new Set(swingStk.map(x => x.p.symbol).concat(swingOpt.map(x => OPT_RE.exec(x.p.symbol)[1])))];
    const bars0 = await loadBars(unds);
    const lastU = await latestPrices(unds);
    const held = (sym, day8) => { if (day8 === TODAY) return 0; return completed(bars0, sym).filter(b => b.d > dash8(day8)).length + 1; };
    for (const { p, e } of swingStk) {
      if (sellsFor(p.symbol).some(o => o.type === 'market')) continue;
      const day8 = cid(e).split('-')[4], plpc = +p.unrealized_plpc * 100, px = lastU[p.symbol] && lastU[p.symbol].p;
      const out = why => send({ symbol: p.symbol, qty: String(Math.abs(+p.qty)), side: 'sell', type: 'market', time_in_force: 'day', client_order_id: 'sd-x-' + p.symbol + '-' + rid() }, why);
      const livePl = px ? (px / +p.avg_entry_price - 1) * 100 : plpc;
      if (HOLD_FLOOR > 0 && Math.min(plpc, livePl) <= -HOLD_FLOOR) { await out(`${p.symbol} down ${Math.min(plpc, livePl).toFixed(1)}% \u2014 hit the ${HOLD_FLOOR}% hard floor`); continue; }
      if (MINS < 950 || !px) continue;                                  // exits happen in the last 10 minutes, like a closing order
      const h = held(p.symbol, day8); if (h === 0) continue;             // never sell on the day it was bought
      const x = rsi2Exit(completed(bars0, p.symbol).map(b => b.c), px, h, CFG.maxHold);
      if (x.exit) await out(`${p.symbol} RSI-2 exit \u2014 ${x.why} (${plpc >= 0 ? '+' : ''}${plpc.toFixed(2)}%)`);
    }
    for (const { p, e } of swingOpt) {
      const sells = sellsFor(p.symbol); if (sells.some(o => o.type === 'market')) continue;
      const parts = cid(e).split('-'), day8 = parts[3], und = OPT_RE.exec(p.symbol)[1], exp = '20' + OPT_RE.exec(p.symbol)[2];
      const qty = Math.abs(+p.qty), plpc = +p.unrealized_plpc * 100, avg = +p.avg_entry_price, px = lastU[und] && lastU[und].p;
      const out = async why => { for (const o of sells) if (!DRY) await T('/v2/orders/' + o.id, { method: 'DELETE' }); await send({ symbol: p.symbol, qty: String(qty), side: 'sell', type: 'market', time_in_force: 'day', client_order_id: 'sd-x-' + p.symbol + '-' + rid() }, why); };
      const daysToExp = (Date.parse(dash8(exp)) - Date.parse(ymdDash(Date.now()))) / 864e5;
      if (plpc >= OPT_TP) await out(`${p.symbol} +${plpc.toFixed(0)}% \u2014 take profit`);
      else if (plpc <= -CFG.optStop) await out(`${p.symbol} ${plpc.toFixed(0)}% \u2014 option stop`);
      else if (capHit) await out(`${p.symbol} daily loss cap hit \u2014 closing options`);
      else if (G.closeOptionsAt != null && MINS >= G.closeOptionsAt) await out(`${p.symbol} Fed decision in minutes \u2014 closing options`);
      else if (daysToExp <= 3) await out(`${p.symbol} ${daysToExp} days to expiry \u2014 out before time decay accelerates`);
      else if (MINS >= 950 && px && held(und, day8) > 0) { const isPut = cid(e).startsWith('sd-p-'); const x = (isPut ? rsi2ShortExit : rsi2Exit)(completed(bars0, und).map(b => b.c), px, held(und, day8), CFG.maxHold); if (x.exit) await out(`${p.symbol} stock ${x.why} \u2014 selling the ${isPut ? 'PUT' : 'CALL'}`); }
      else if (!sells.length && !(pdtNear && day8 === TODAY)) await send({ symbol: p.symbol, qty: String(qty), side: 'sell', type: 'limit', limit_price: String(tick(avg * (1 + OPT_TP / 100))), time_in_force: 'day', client_order_id: 'sd-x-' + p.symbol + '-' + rid() }, `${p.symbol} take-profit at +${OPT_TP}%`);
    }
  }

  // ---- manage stock positions (legacy intraday trades, if any remain) ----
  for (const p of stockPos) {
    const e = hist.find(o => o.side === 'buy' && o.status === 'filled' && cid(o).startsWith('sd-s-' + p.symbol + '-'));
    if (!e) continue;                                   // not ours — never touch manual positions
    if (sellsFor(p.symbol).some(o => o.type === 'market')) continue;
    const [, , , tgtC, , day] = cid(e).split('-');
    const tgt = +tgtC / 100, avg = +p.avg_entry_price, plpc = +p.unrealized_plpc * 100;
    const held = day < TODAY;
    const sells = sellsFor(p.symbol);
    const sellAll = async why => { for (const o of sells) if (!DRY) await T('/v2/orders/' + o.id, { method: 'DELETE' }); await send({ symbol: p.symbol, qty: String(Math.abs(+p.qty)), side: 'sell', type: 'market', time_in_force: 'day', client_order_id: 'sd-x-' + p.symbol + '-' + rid() }, why); };
    if (HOLD_FLOOR > 0 && plpc <= -HOLD_FLOOR) { await sellAll(`${p.symbol} down ${plpc.toFixed(1)}% — hit the ${HOLD_FLOOR}% hard floor`); continue; }
    const ageDays = (Date.parse(e.filled_at || e.submitted_at) ? (Date.now() - Date.parse(e.filled_at || e.submitted_at)) / 864e5 : 0);
    if (held && ageDays > MAX_HOLD_DAYS) { await sellAll(`${p.symbol} held ${Math.round(ageDays)} days — max hold reached`); continue; }
    if (!held && MINS >= 945) {
      if (plpc > -HOLD_LOSS) { await sellAll(`${p.symbol} day trade closed at the bell (${plpc >= 0 ? '+' : ''}${plpc.toFixed(2)}%)`); continue; }
      act(`${p.symbol} is down ${plpc.toFixed(2)}% — holding instead of selling at a loss; will exit at breakeven`);
    }
    const goingHeld = held || (MINS >= 945 && plpc <= -HOLD_LOSS);
    const want = goingHeld ? tick(avg * 1.003) : tick(Math.max(avg * 1.002, Math.min(tgt, avg * (1 + TP / 100))));
    const qty = String(Math.abs(+p.qty));
    if (!sells.length) await send({ symbol: p.symbol, qty, side: 'sell', type: 'limit', limit_price: String(want), time_in_force: 'gtc', client_order_id: 'sd-x-' + p.symbol + '-' + rid() }, goingHeld ? `${p.symbol} recovery exit` : `${p.symbol} take-profit (first of +${TP}% or target)`);
    else if (Math.abs(+sells[0].limit_price - want) > 0.011 && sells[0].type === 'limit') {
      act(`${p.symbol} moving sell limit ${sells[0].limit_price} → ${want}`);
      if (!DRY) await T('/v2/orders/' + sells[0].id, { method: 'PATCH', body: JSON.stringify({ limit_price: String(want) }) });
    }
  }

  // ---- manage option positions ----
  // A resting limit sells everything at +OPT_TP% the instant it trades there.
  // The bot cancels it and sells at market for the stop, time stop, expiry and loss cap.
  for (const p of optPos) {
    const e = hist.find(o => o.side === 'buy' && o.status === 'filled' && cid(o).startsWith('sd-o-' + p.symbol + '-'));
    if (!e) continue;
    if (sellsFor(p.symbol).some(o => o.type === 'market')) continue;
    const day = cid(e).split('-')[3];
    const qty = Math.abs(+p.qty), plpc = +p.unrealized_plpc * 100, avg = +p.avg_entry_price;
    const m = OPT_RE.exec(p.symbol), exp = '20' + m[2];
    const sells = sellsFor(p.symbol);
    const out = async why => { for (const o of sells) if (!DRY) await T('/v2/orders/' + o.id, { method: 'DELETE' }); await send({ symbol: p.symbol, qty: String(qty), side: 'sell', type: 'market', time_in_force: 'day', client_order_id: 'sd-x-' + p.symbol + '-' + rid() }, why); };
    if (plpc >= OPT_TP) await out(`${p.symbol} +${plpc.toFixed(0)}% \u2014 take profit`);
    else if (plpc <= -CFG.optStop) await out(`${p.symbol} ${plpc.toFixed(0)}% \u2014 option stop`);
    else if (capHit) await out(`${p.symbol} daily loss cap hit \u2014 closing options`);
    else if (G.closeOptionsAt != null && MINS >= G.closeOptionsAt) await out(`${p.symbol} Fed decision in minutes \u2014 closing options before the volatility`);
    else if (exp <= TODAY) await out(`${p.symbol} expires today \u2014 out`);
    else if (day < TODAY && MINS >= 940) await out(`${p.symbol} time stop \u2014 options are held one night at most`);
    else if (!sells.length) await send({ symbol: p.symbol, qty: String(qty), side: 'sell', type: 'limit', limit_price: String(tick(avg * (1 + OPT_TP / 100))), time_in_force: 'day', client_order_id: 'sd-x-' + p.symbol + '-' + rid() }, `${p.symbol} take-profit at +${OPT_TP}%`);
  }

  // ---- what the bot is looking at (always, even when it cannot enter: the Bot trades tab shows it) ----
  const gated = capHit || MINS < G.minStart || MINS >= ENTRY_END || G.block;
  if (gated && lastWatch && Date.now() - Date.parse(lastWatch.at) < 20000) return;   // nothing to enter: refresh the watch list every 20 s, not every beat
  const bars = await loadBars();
  const last = await latestPrices(UNIVERSE);
  const sigs = [];
  for (const sym of UNIVERSE) {
    const B = completed(bars, sym); if (B.length < 205) continue;
    const px0 = last[sym] && last[sym].p, s = CFG.intraday && px0 ? liveSignal(B, px0, 'long', CFG.rsiThreshold) : rsi2Signal(B, B.map(b => b.c), B.length - 1, CFG.rsiThreshold); if (s) sigs.push({ sym, ...s, px: last[sym] && last[sym].p });
  }
  sigs.sort((a, b) => a.r2 - b.r2);                                      // deepest dip first, like the backtest
  const shortSigs = [];                                                  // PUT candidates (switch is OFF unless Trade puts is ticked)
  if (PUT_ON) for (const sym of UNIVERSE) {
    const B = completed(bars, sym); if (B.length < 205) continue;
    const px0 = last[sym] && last[sym].p, s = CFG.intraday && px0 ? liveSignal(B, px0, 'short', CFG.rsiThreshold) : rsi2ShortSignal(B, B.map(b => b.c), B.length - 1, CFG.rsiThreshold); if (s) shortSigs.push({ sym, ...s, px: last[sym] && last[sym].p });
  }
  shortSigs.sort((a, b) => b.r2 - a.r2);                                 // most stretched pop first
  {  // what the bot is looking at, for the Bot trades tab: every watched stock with its RSI-2 and trend, plus who qualifies for each kind of trade
    const rows = [];
    for (const sym of UNIVERSE) {
      const B = completed(bars, sym); if (B.length < 205) continue;
      const cl = B.map(b => b.c); if (CFG.intraday && last[sym] && last[sym].p > 0) cl.push(last[sym].p);
      const r = rsi2(cl), m = sma(cl, 200);
      if (r == null || m == null) continue;
      const base = B.map(b => b.c);                                  // completed closes only: the trigger is a level for today's close
      rows.push({ s: sym, px: r2d((last[sym] && last[sym].p) || cl[cl.length - 1]), r2: Math.round(r * 10) / 10, up: cl[cl.length - 1] > m, s200: r2d(m),
        prev: r2d(base[base.length - 1]), buyAt: rsi2Trigger(base, CFG.rsiThreshold, 'long'), putAt: PUT_ON ? rsi2Trigger(base, CFG.rsiThreshold, 'short') : null });
    }
    const heldRows = [];
    for (const p of positions) {
      const opt = isOpt(p.symbol), und = opt ? OPT_RE.exec(p.symbol)[1] : p.symbol, isPut = opt && OPT_RE.exec(p.symbol)[3] === 'P';
      const cl = completed(bars, und).map(b => b.c), mult = opt ? 100 : 1;
      const avg = +p.avg_entry_price, cur = +p.current_price;
      const row = { s: p.symbol, und, kind: opt ? (isPut ? 'put' : 'call') : 'stock', qty: Math.abs(+p.qty), avg: r2d(avg * mult), cur: r2d(cur * mult), pl: r2d(+p.unrealized_pl), plpc: Math.round(+p.unrealized_plpc * 1000) / 10,
        undPx: r2d((last[und] && last[und].p) || cl[cl.length - 1] || 0), exitLevel: rsi2ExitLevel(cl), exitSide: isPut ? 'below' : 'above' };
      if (!opt) row.floor = HOLD_FLOOR > 0 ? r2d(avg * (1 - HOLD_FLOOR / 100)) : null;
      else { row.tp = r2d(avg * mult * (1 + OPT_TP / 100)); row.stop = r2d(avg * mult * (1 - CFG.optStop / 100)); const m2 = OPT_RE.exec(p.symbol); row.exp = '20' + m2[2].slice(0, 2) + '-' + m2[2].slice(2, 4) + '-' + m2[2].slice(4, 6); }
      heldRows.push(row);
    }
    lastWatch = { at: new Date().toISOString(), idle: capHit ? 'daily loss cap hit' : MINS < G.minStart ? 'before the entry window' : MINS >= ENTRY_END ? 'entry window closed for today' : G.block ? 'paused by the market check' : null, thr: CFG.rsiThreshold, maxHold: CFG.maxHold, held: heldRows, intraday: !!CFG.intraday, universe: CFG.universe, scanned: scanCache.info ? scanCache.info.scanned : null, scanAt: scanCache.info ? scanCache.info.at : null, on: { stocks: STK_ON, calls: OPT_ON, puts: PUT_ON },
      buy: STK_ON ? sigs.map(x => x.sym) : [], call: OPT_ON ? sigs.map(x => x.sym) : [], put: PUT_ON ? shortSigs.map(x => x.sym) : [], total: UNIVERSE.length, rows };
  }
  if (shortSigs.length) act(`RSI-2 pops (PUT candidates): ${shortSigs.map(s => s.sym + ' (' + s.r2 + ')').join(', ')}`);
  // ---- new entries ----
  if (capHit) { act(`Daily loss cap ${LOSS_CAP}% hit (${dayPct.toFixed(2)}%) — no new trades today`); return; }
  if (MINS < G.minStart || MINS >= ENTRY_END) { console.log('Outside the RSI-2 entry window.'); return; }
  if (G.block) { console.log('Paused by market check.'); return; }

  // ---- portfolio risk: heat (money at risk to the stops) and sector concentration ----
  const stopFor = (sym, ord) => {
    const r = ord && /^sd-r-/.test(cid(ord)) ? ord : hist.find(o => o.side === 'buy' && cid(o).startsWith('sd-r-' + sym + '-'));
    if (r) { const unit = +cid(r).split('-')[3] / 100, base = ord ? +ord.limit_price : +((positions.find(x => x.symbol === sym) || {}).avg_entry_price || 0); return base ? base - unit : null; }
    const src = ord && /^sd-s-/.test(cid(ord)) ? ord : hist.find(o => o.side === 'buy' && cid(o).startsWith('sd-s-' + sym + '-'));
    return src ? +cid(src).split('-')[4] / 100 : null;
  };
  let heat = openRisk({ positions, orders: liveOrders, stopFor });
  const heatCap = equity * MAX_HEAT / 100;
  const undOf = s => isOpt(s) ? OPT_RE.exec(s)[1] : s;
  const sectorCount = {};
  for (const s of positions.map(p => p.symbol).concat(liveOrders.filter(o => o.side === 'buy').map(o => o.symbol))) { const k = sectorOf(undOf(s)); sectorCount[k] = (sectorCount[k] || 0) + 1; }
  const sectorFull = sym => sectorOf(sym) !== 'Other' && (sectorCount[sectorOf(sym)] || 0) >= MAX_PER_SECTOR;
  lastRisk = { heatPct: heat / equity * 100, capPct: MAX_HEAT, sectors: sectorCount, regime: G.regime };

  // ---- RSI-2 entries (selected by the 33-year out-of-sample research) ----
  lastSignals = { longs: [], shorts: [], rsi2: sigs, at: Date.now() };
  if (sigs.length) act(`RSI-2 dips ${CFG.intraday ? 'right now (intraday)' : 'today'}: ${sigs.map(s => s.sym + ' (' + s.r2 + ')').join(', ')}`);
  const todays = hist.filter(o => o.side === 'buy' && cid(o).includes('-' + TODAY + '-') && !['canceled', 'expired', 'rejected'].includes(o.status));

  if (STK_ON) {
    let slots = MAX_POS - stockPos.length - liveOrders.filter(o => o.side === 'buy' && !isOpt(o.symbol)).length;
    for (const s of sigs) {
      if (slots <= 0) break;
      if (!s.px || stockPos.some(p => p.symbol === s.sym) || liveOrders.some(o => o.symbol === s.sym) || todays.some(o => cid(o).startsWith('sd-r-' + s.sym + '-'))) continue;
      if (s.px > s.prevClose * 1.01) { act(`${s.sym} skipped \u2014 already bounced ${((s.px / s.prevClose - 1) * 100).toFixed(1)}% since yesterday's close`); continue; }
      const risk = CFG.newsGuard ? symbolRisk(s.sym, newsCache.syms) : null; if (risk) { act(`${s.sym} skipped \u2014 ${risk}`); continue; }
      if (sectorFull(s.sym)) { act(`${s.sym} skipped \u2014 already ${MAX_PER_SECTOR} positions in ${sectorOf(s.sym)}`); continue; }
      const lim = r2d(s.px * 1.002);
      const qty = stockQty({ equity, riskPct: RISK_PCT * G.budget, entry: lim, stop: lim - s.riskUnit, budget: slBudget('stock') });
      if (qty < 1) { if (SL.stock.cap > 0) act(`${s.sym}: no room left in the stock money ceiling \u2014 skipped${capNote('stock')}`); continue; }
      const add = qty * s.riskUnit;
      if (heat + add > heatCap) { act(`${s.sym} skipped \u2014 total risk would exceed ${MAX_HEAT}% of the account`); continue; }
      await send({ symbol: s.sym, qty: String(qty), side: 'buy', type: 'limit', limit_price: String(lim), time_in_force: 'day',
        client_order_id: `sd-r-${s.sym}-${Math.round(s.riskUnit * 100)}-${TODAY}-${rid()}` }, `${s.sym} RSI-2 dip buy (RSI-2 ${s.r2}, above 200-day ${s.s200})`);
      SL.stock.used += qty * lim; heat += add; sectorCount[sectorOf(s.sym)] = (sectorCount[sectorOf(s.sym)] || 0) + 1; slots--;
    }
  }

  // CALLs on the same RSI-2 dips (puts are off: the short side was not part of the winning research)
  if ((OPT_ON || PUT_ON) && !G.noOptions) {
    let slots = MAX_OPT - optPos.length - liveOrders.filter(o => o.side === 'buy' && isOpt(o.symbol)).length;
    const hasOptOn = und => optPos.some(p => OPT_RE.exec(p.symbol)[1] === und) || liveOrders.some(o => isOpt(o.symbol) && OPT_RE.exec(o.symbol)[1] === und);
    const optSets = [];
    if (OPT_ON) optSets.push(['call', sigs]);
    if (PUT_ON) optSets.push(['put', shortSigs]);
    for (const [kind, list] of optSets) for (const s of list) {
      const K = kind.toUpperCase();
      if (slots <= 0) break;
      // a call is skipped once the dip has bounced 1%+; a put once the pop has already fallen 1%+
      if (!s.px || hasOptOn(s.sym) || (kind === 'call' ? s.px > s.prevClose * 1.01 : s.px < s.prevClose * 0.99) || (CFG.newsGuard && symbolRisk(s.sym, newsCache.syms)) || sectorFull(s.sym)) continue;
      if (todays.some(o => isOpt(o.symbol) && OPT_RE.exec(o.symbol)[1] === s.sym)) continue;
      const cj = await T(`/v2/options/contracts?underlying_symbols=${s.sym}&type=${kind}&status=active&expiration_date_gte=${ymdDash(Date.now() + 14 * 864e5)}&expiration_date_lte=${ymdDash(Date.now() + 35 * 864e5)}&strike_price_gte=${r2d(s.px * 0.95)}&strike_price_lte=${r2d(s.px * 1.05)}&limit=200`);
      const cs = (cj.option_contracts || []).filter(c => c.tradable !== false);
      if (!cs.length) { act(`${s.sym} ${K}: no contract 14\u201335 days out near ${s.px}`); continue; }
      const ex = [...new Set(cs.map(c => c.expiration_date))].sort()[0];
      const c = cs.filter(x => x.expiration_date === ex).sort((a, b) => Math.abs(+a.strike_price - s.px) - Math.abs(+b.strike_price - s.px))[0];
      const q = ((await D(`/v1beta1/options/quotes/latest?symbols=${c.symbol}&feed=indicative`)).quotes || {})[c.symbol];
      if (!q || !(q.ap > 0) || !(q.bp > 0)) { act(`${c.symbol}: no live quote \u2014 skipped`); continue; }
      if ((q.ap - q.bp) / q.ap > 0.2) { act(`${c.symbol}: spread too wide (${q.bp}/${q.ap}) \u2014 skipped`); continue; }
      const lim = tick(Math.min(q.ap, (q.ap + q.bp) / 2 * 1.03));
      const qty = optionQty({ equity, riskPct: OPT_RISK_PCT * G.budget, price: lim, budget: slBudget(kind) });
      if (qty < 1) { act(`${c.symbol}: 1 contract ($${Math.round(lim * 100)}) is above this trade's money budget \u2014 skipped${capNote(kind)}`); continue; }
      const addO = qty * lim * 100 * 0.5;
      if (heat + addO > heatCap) { act(`${c.symbol} skipped \u2014 total risk would exceed ${MAX_HEAT}% of the account`); continue; }
      await send({ symbol: c.symbol, qty: String(qty), side: 'buy', type: 'limit', limit_price: String(lim), time_in_force: 'day',
        client_order_id: `${kind === 'put' ? 'sd-p-' : 'sd-q-'}${c.symbol}-${TODAY}-${qty}-${rid()}` }, kind === 'put' ? `${s.sym} PUT on RSI-2 pop (RSI-2 ${s.r2}, below 200-day ${s.s200})` : `${s.sym} CALL on RSI-2 dip (RSI-2 ${s.r2})`);
      SL[kind].used += qty * lim * 100; heat += addO; sectorCount[sectorOf(s.sym)] = (sectorCount[sectorOf(s.sym)] || 0) + 1; slots--;
    }
  }
}

async function writeJournal() {
  const acct = await T('/v2/account');
  const positions = await T('/v2/positions');
  let fills = [], token = '';
  for (let k = 0; k < 30; k++) {
    const j = await T('/v2/account/activities/FILL?direction=asc&page_size=100' + (token ? '&page_token=' + token : ''));
    if (!j || !j.length) break;
    fills = fills.concat(j);
    if (j.length < 100) break;
    token = j[j.length - 1].id;
  }
  const { closed, open } = buildJournal(fills, positions);
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync('bot/journal.json', 'utf8')); } catch (e) {}
  const allActs = (PRIVATE ? (globalThis.__acts || []) : (prev.acts || [])).concat(acts).slice(-80); globalThis.__acts = allActs;
  const env = lastGuard ? { at: new Date().toISOString(), block: lastGuard.block, regime: lastGuard.regime, reasons: lastGuard.reasons, today: lastGuard.today, upcoming: lastGuard.upcoming, flagged: lastGuard.flagged, spyPct: lastGuard.spyPct, newsOk: lastGuard.newsOk } : (prev.env || null);
  const sig = JSON.stringify([closed.length, closed[0] && closed[0].outT, open.map(o => o.sym + o.qty), acts.length, env && env.reasons, env && env.flagged && env.flagged.length]);
  const sigCmp = PRIVATE ? (await import('node:crypto')).createHash('sha256').update(sig).digest('hex').slice(0, 16) : sig;
  if (prev.sig === sigCmp && prev.at && Date.now() - Date.parse(prev.at) < 10 * 60000) { console.log('journal unchanged'); return; }
  const j = { at: new Date().toISOString(), sig, paper: /paper/.test(BASE),
    account: { equity: +acct.equity, last_equity: +acct.last_equity, cash: +acct.cash }, closed, open, acts: allActs, env,
    settings: { ...CFG, summary: cfgSummary(CFG), base: BASE.includes('paper') ? 'paper' : 'LIVE' }, stream: { ...streamStats, mode: streamStats.lastTick && Date.now() - streamStats.lastTick < 60000 ? 'streaming' : 'polling' }, risk: lastRisk, watch: lastWatch || prev.watch || null, limits: { riskPct: RISK_PCT, optRiskPct: OPT_RISK_PCT, maxHeat: MAX_HEAT, perSector: MAX_PER_SECTOR, streak: MAX_STREAK, weekCap: WEEK_CAP, dayCap: LOSS_CAP } };
  if (PRIVATE) {
    // Public site, private data: AES-256-GCM with a key derived from your passphrase (PBKDF2-SHA256, 200k rounds).
    // Only the timestamp, paper/live flag and stream health stay readable; the page decrypts the rest with the same passphrase.
    const subtle = (await import('node:crypto')).webcrypto.subtle, enc = new TextEncoder();
    const salt = (await import('node:crypto')).randomBytes(16), iv = (await import('node:crypto')).randomBytes(12);
    const km = await subtle.importKey('raw', enc.encode(process.env.JOURNAL_KEY), 'PBKDF2', false, ['deriveKey']);
    const key = await subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const ct = Buffer.from(await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(j))));
    const sigH = (await import('node:crypto')).createHash('sha256').update(sig).digest('hex').slice(0, 16);   // change-detector only, reveals nothing
    fs.writeFileSync('bot/journal.json', JSON.stringify({ enc: 1, kdf: 'PBKDF2-SHA256', iter: 200000, salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'), at: j.at, sig: sigH, paper: j.paper, stream: j.stream }));
    console.log('journal written (encrypted)');
  } else {
    fs.writeFileSync('bot/journal.json', JSON.stringify(j));
    console.log('journal written:', closed.length, 'closed,', open.length, 'open');
  }
}

if (import.meta.url === 'file://' + process.argv[1]) {
  if (!HAVE_KEYS) { console.log('No Alpaca keys configured - nothing to do.'); process.exit(0); }
  await botCycle({ journal: true });
}
