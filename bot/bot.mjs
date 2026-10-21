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
import { signalAt, signalShortAt, r2d } from './strategy.mjs';
import { buildJournal } from './journal.mjs';
import { guard, loadEvents, symbolRisk } from './news.mjs';
import { sectorOf, stockQty, optionQty, regimeOf, lossStreak, openRisk } from './risk.mjs';

const KEY = process.env.ALPACA_KEY, SECRET = process.env.ALPACA_SECRET;
export const HAVE_KEYS = !!(KEY && SECRET);
const BASE = process.env.ALPACA_URL || 'https://paper-api.alpaca.markets';
const DATA = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';
const n = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? +process.env[k] : d);
const STK_ON = process.env.BOT_STOCKS !== '0', OPT_ON = process.env.BOT_OPTIONS !== '0';
const BUDGET = n('BOT_PER_TRADE', 0), OPT_BUDGET = n('BOT_OPT_BUDGET', 0);   // 0 = auto: 10% of equity per stock position, 2% per option trade
const MAX_POS = n('BOT_MAX_POSITIONS', 6), MAX_OPT = n('BOT_MAX_OPTIONS', 4), MAX_ENTRIES = n('BOT_MAX_ENTRIES_PER_SYM', 3);
const TP = n('BOT_TAKE_PROFIT', 1), OPT_TP = n('BOT_OPT_TAKE_PROFIT', 50); // quick-profit exits, in %
const LOSS_CAP = n('BOT_DAILY_LOSS_CAP', 3), HOLD_LOSS = n('BOT_HOLD_LOSS', 1.5), HOLD_FLOOR = n('BOT_HOLD_FLOOR', 25), MAX_HOLD_DAYS = n('BOT_MAX_HOLD_DAYS', 30);
const UNIVERSE = (process.env.BOT_SYMBOLS || 'AAPL,MSFT,NVDA,AMZN,META,GOOGL,TSLA,AMD,JPM,BAC,XOM,CVX,KO,PEP,WMT,HD,DIS,INTC,CSCO,QCOM,ORCL,CRM,ADBE,NFLX,UBER,PLTR,SHOP,COIN,SOFI,F').split(',').map(s => s.trim()).filter(Boolean);
const DRY = process.env.BOT_DRY === '1';
// professional risk limits (all % of account equity)
const RISK_PCT = n('BOT_RISK_PCT', 0.5), OPT_RISK_PCT = n('BOT_OPT_RISK_PCT', 0.5), MAX_HEAT = n('BOT_MAX_HEAT', 3);
const MAX_PER_SECTOR = n('BOT_MAX_PER_SECTOR', 2), MAX_STREAK = n('BOT_MAX_LOSS_STREAK', 3), WEEK_CAP = n('BOT_WEEKLY_LOSS_CAP', 6), STALE_MIN = n('BOT_STALE_ORDER_MIN', 45);
const NTFY = process.env.NTFY_TOPIC || '';

const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET, 'content-type': 'application/json' };
async function call(base, path, opt = {}) {
  let r = await fetch(base + path, { headers: H, ...opt });
  if (r.status === 429) { await new Promise(z => setTimeout(z, 3000)); r = await fetch(base + path, { headers: H, ...opt }); }   // rate limited: back off once
  if (r.status === 204) return null;
  const tx = await r.text();
  if (!r.ok) throw new Error(path.split('?')[0] + ' HTTP ' + r.status + ' ' + tx.slice(0, 200));
  return tx ? JSON.parse(tx) : null;
}
const T = (p, o) => call(BASE, p, o), D = (p, o) => call(DATA, p, o);
const send = async (body, why) => { alerts.push((body.side === 'buy' ? '\ud83d\udfe2 ' : '\ud83d\udd34 ') + why); act(why + ' — ' + body.side.toUpperCase() + ' ' + body.qty + ' ' + body.symbol + (body.limit_price ? ' @ ' + body.limit_price : ' at market')); if (!DRY) return T('/v2/orders', { method: 'POST', body: JSON.stringify(body) }); };

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
  seen.set(k, Date.now()); console.log(m); acts.push({ t: new Date().toISOString(), m });
};
let lastSignals = null, lastClock = null, barsCache = { at: 0, bars: null }, lastPosSig = '', pendingActs = 0;
let newsCache = { at: 0, market: [], syms: [], ok: true }, lastGuard = null, spyPrev = null, weekCache = { at: 0, start: null }, fillsCache = { at: 0, closed: [] }, lastRisk = null;
const alerts = [];

// One full decision cycle: manage every position, then look for new entries.
export async function botCycle({ journal = false } = {}) {
  setNow();
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

// Phone alerts via ntfy.sh (free): install the ntfy app, subscribe to your secret topic name.
const sentAlerts = new Map();
async function flushAlerts() {
  if (!alerts.length) return;
  const lines = alerts.splice(0).filter(m => { const k = m.replace(/[\d.]+/g, '#'); if (sentAlerts.has(k) && Date.now() - sentAlerts.get(k) < 20 * 60000) return false; sentAlerts.set(k, Date.now()); return true; });
  if (!NTFY || !lines.length || DRY) return;
  try {
    await fetch('https://ntfy.sh/' + encodeURIComponent(NTFY), { method: 'POST', body: lines.join('\n'),
      headers: { Title: 'Signal Desk bot' + (lines.length > 1 ? ' (' + lines.length + ')' : ''), Priority: lines.some(l => /\u26d4|\u26a0/.test(l)) ? 'high' : 'default', Tags: 'chart_with_upwards_trend' } });
  } catch (e) { console.log('alert failed', e.message); }
}

async function run() {
  const clock = lastClock = await T('/v2/clock');
  if (!clock.is_open) { console.log('Market closed.'); return; }
  const acct = await T('/v2/account');
  const equity = +acct.equity, lastEq = +acct.last_equity || equity;
  const positions = await T('/v2/positions');
  const openOrders = await T('/v2/orders?status=open&limit=500');
  const hist = await T('/v2/orders?status=all&limit=500&direction=desc&after=' + new Date(Date.now() - 45 * 864e5).toISOString());
  const stockPos = positions.filter(p => !isOpt(p.symbol)), optPos = positions.filter(p => isOpt(p.symbol));

  // ---- news & events guard (calendar + live headlines + SPY tone) ----
  if (Date.now() - newsCache.at > 60000) {
    try {
      const since = h => new Date(Date.now() - h * 3600e3).toISOString();
      const mk = (await D(`/v1beta1/news?limit=50&sort=desc&start=${since(3)}`)).news || [];
      const sy = (await D(`/v1beta1/news?symbols=${UNIVERSE.join(',')}&limit=50&sort=desc&start=${since(72)}`)).news || [];
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
    const st = (((await D('/v2/stocks/trades/latest?symbols=SPY&feed=iex')).trades) || {}).SPY;
    if (spyPrev && st) spyPct = (st.p / spyPrev.c - 1) * 100;
  } catch (e) {}
  const G = lastGuard = guard({ events: loadEvents(), todayDash: ymdDash(Date.now()), mins: MINS, headlines: newsCache.market, spyPct });
  G.spyPct = spyPct; G.newsOk = newsCache.ok;
  const RG = regimeOf(spyPrev && spyPrev.closes);
  G.regime = RG.regime; G.longSize = 1;
  if (RG.regime === 'bear') { G.noLongs = true; G.reasons.push('Bear market regime (SPY below its 50- and 200-day averages) \u2014 no new stock buys or CALLs'); }
  else if (RG.regime === 'neutral') { G.longSize = 0.5; G.reasons.push('Choppy regime (SPY near its 50-day average) \u2014 long trades at half size'); }
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
  const bud = BUDGET > 0 ? BUDGET : equity * 0.10, obud = OPT_BUDGET > 0 ? OPT_BUDGET : equity * 0.02;
  const capHit = dayPct <= -LOSS_CAP;

  // ---- cancel stale entries ----
  for (const o of openOrders) {
    if (o.side !== 'buy' || !/^sd-[so]-/.test(cid(o))) continue;
    if (Date.now() - Date.parse(o.submitted_at || o.created_at || Date.now()) > STALE_MIN * 60000) {
      act(`${o.symbol} buy at ${o.limit_price} unfilled for ${STALE_MIN} min \u2014 cancelled (setup is stale)`);
      if (!DRY) await T('/v2/orders/' + o.id, { method: 'DELETE' }).catch(() => {});
      o._cancelled = true;
    }
  }
  const liveOrders = openOrders.filter(o => !o._cancelled);

  // ---- manage stock positions ----
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
    else if (plpc <= -50) await out(`${p.symbol} ${plpc.toFixed(0)}% \u2014 option stop`);
    else if (capHit) await out(`${p.symbol} daily loss cap hit \u2014 closing options`);
    else if (G.closeOptionsAt != null && MINS >= G.closeOptionsAt) await out(`${p.symbol} Fed decision in minutes \u2014 closing options before the volatility`);
    else if (exp <= TODAY) await out(`${p.symbol} expires today \u2014 out`);
    else if (day < TODAY && MINS >= 940) await out(`${p.symbol} time stop \u2014 options are held one night at most`);
    else if (!sells.length) await send({ symbol: p.symbol, qty: String(qty), side: 'sell', type: 'limit', limit_price: String(tick(avg * (1 + OPT_TP / 100))), time_in_force: 'day', client_order_id: 'sd-x-' + p.symbol + '-' + rid() }, `${p.symbol} take-profit at +${OPT_TP}%`);
  }

  // ---- new entries ----
  if (capHit) { act(`Daily loss cap ${LOSS_CAP}% hit (${dayPct.toFixed(2)}%) — no new trades today`); return; }
  if (MINS < G.minStart || MINS >= 900) { console.log('Outside the entry window.'); return; }
  if (G.block) { console.log('Paused by market check.'); return; }

  // ---- portfolio risk: heat (money at risk to the stops) and sector concentration ----
  const stopFor = (sym, ord) => {
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

  if (!barsCache.bars || Date.now() - barsCache.at > 30 * 60000) {         // daily bars: refresh every 30 min
    const start = new Date(Date.now() - 130 * 864e5).toISOString();
    const b2 = {};
    let token = '';
    for (let k = 0; k < 10; k++) {
      const j = await D(`/v2/stocks/bars?symbols=${UNIVERSE.join(',')}&timeframe=1Day&start=${start}&limit=10000&adjustment=split&feed=iex&sort=asc${token ? '&page_token=' + token : ''}`);
      for (const [s, arr] of Object.entries(j.bars || {})) b2[s] = (b2[s] || []).concat(arr);
      token = j.next_page_token; if (!token) break;
    }
    barsCache = { at: Date.now(), bars: b2 };
  }
  const bars = barsCache.bars;
  const last = (await D(`/v2/stocks/trades/latest?symbols=${UNIVERSE.join(',')}&feed=iex`)).trades || {};
  const todayDash = ymdDash(Date.now());
  const longs = [], shorts = [];
  for (const sym of UNIVERSE) {
    const bs = bars[sym] || [];
    const B = bs.filter(b => b.t.slice(0, 10) < todayDash).map(b => ({ o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
    if (B.length < 25) continue;
    const C = B.map(b => b.c), i = B.length - 1;
    const L = signalAt(B, C, i); if (L) longs.push({ sym, ...L, px: last[sym] && last[sym].p });
    const S = signalShortAt(B, C, i); if (S) shorts.push({ sym, ...S, px: last[sym] && last[sym].p });
  }
  const order = (a, b) => (b.strong - a.strong) || (a.r2 - b.r2);
  longs.sort(order); shorts.sort((a, b) => (b.strong - a.strong) || (b.r2 - a.r2));
  lastSignals = { longs, shorts, at: Date.now() };
  const todays = hist.filter(o => o.side === 'buy' && cid(o).includes('-' + TODAY + '-') && o.status !== 'canceled' && o.status !== 'expired' && o.status !== 'rejected');

  // stock day trades
  if (STK_ON) {
    let slots = MAX_POS - stockPos.length - liveOrders.filter(o => o.side === 'buy' && !isOpt(o.symbol)).length;
    for (const s of (G.noLongs ? [] : longs)) {
      if (slots <= 0) break;
      if (stockPos.some(p => p.symbol === s.sym) || openOrders.some(o => o.symbol === s.sym)) continue;
      const risk = symbolRisk(s.sym, newsCache.syms);
      if (risk) { act(`${s.sym} skipped \u2014 ${risk}`); continue; }
      if (todays.filter(o => cid(o).startsWith('sd-s-' + s.sym + '-')).length >= MAX_ENTRIES) continue;
      if (sectorFull(s.sym)) { act(`${s.sym} skipped \u2014 already ${MAX_PER_SECTOR} positions in ${sectorOf(s.sym)}`); continue; }
      const qty = stockQty({ equity, riskPct: RISK_PCT * G.budget * G.longSize, entry: s.entry, stop: s.stop, budget: bud * G.budget * G.longSize });
      if (qty < 1) continue;
      const add = qty * (s.entry - s.stop);
      if (heat + add > heatCap) { act(`${s.sym} skipped \u2014 total risk would exceed ${MAX_HEAT}% of the account`); continue; }
      heat += add; sectorCount[sectorOf(s.sym)] = (sectorCount[sectorOf(s.sym)] || 0) + 1;
      await send({ symbol: s.sym, qty: String(qty), side: 'buy', type: 'limit', limit_price: String(s.entry), time_in_force: 'day',
        client_order_id: `sd-s-${s.sym}-${Math.round(s.target * 100)}-${Math.round(s.stop * 100)}-${TODAY}-${rid()}` }, `${s.sym} stock day trade (RSI-2 ${s.r2})`);
      slots--;
    }
  }

  // options: CALL on long setups, PUT on short setups — only once the stock touches the level
  if (OPT_ON && !G.noOptions) {
    let slots = MAX_OPT - optPos.length - liveOrders.filter(o => o.side === 'buy' && isOpt(o.symbol)).length;
    const hasOptOn = und => optPos.some(p => OPT_RE.exec(p.symbol)[1] === und) || openOrders.some(o => isOpt(o.symbol) && OPT_RE.exec(o.symbol)[1] === und);
    const tries = (G.noLongs ? [] : longs.map(s => ({ ...s, type: 'call' }))).concat(G.noPuts ? [] : shorts.map(s => ({ ...s, type: 'put' })));
    for (const s of tries) {
      if (slots <= 0) break;
      if (!s.px || hasOptOn(s.sym)) continue;
      if (symbolRisk(s.sym, newsCache.syms)) continue;
      if (sectorFull(s.sym)) continue;
      const touched = s.type === 'call' ? s.px <= s.entry * 1.002 : s.px >= s.entry * 0.998;
      if (!touched) continue;
      if (todays.filter(o => isOpt(o.symbol) && OPT_RE.exec(o.symbol)[1] === s.sym).length >= MAX_ENTRIES) continue;
      const cj = await T(`/v2/options/contracts?underlying_symbols=${s.sym}&type=${s.type}&status=active&expiration_date_gte=${ymdDash(Date.now() + 6 * 864e5)}&expiration_date_lte=${ymdDash(Date.now() + 17 * 864e5)}&strike_price_gte=${r2d(s.entry * 0.95)}&strike_price_lte=${r2d(s.entry * 1.05)}&limit=200`);
      const cs = (cj.option_contracts || []).filter(c => c.tradable !== false);
      if (!cs.length) { act(`${s.sym} ${s.type.toUpperCase()}: no contract 6–17 days out near ${s.entry}`); continue; }
      const ex = [...new Set(cs.map(c => c.expiration_date))].sort()[0];
      const c = cs.filter(x => x.expiration_date === ex).sort((a, b) => Math.abs(+a.strike_price - s.entry) - Math.abs(+b.strike_price - s.entry))[0];
      const q = ((await D(`/v1beta1/options/quotes/latest?symbols=${c.symbol}&feed=indicative`)).quotes || {})[c.symbol];
      if (!q || !(q.ap > 0) || !(q.bp > 0)) { act(`${c.symbol}: no live quote — skipped`); continue; }
      if ((q.ap - q.bp) / q.ap > 0.2) { act(`${c.symbol}: spread too wide (${q.bp}/${q.ap}) — skipped`); continue; }
      const lim = tick(Math.min(q.ap, (q.ap + q.bp) / 2 * 1.03));
      const qty = optionQty({ equity, riskPct: OPT_RISK_PCT * G.budget * (s.type === 'call' ? G.longSize : 1), price: lim, budget: obud * G.budget * (s.type === 'call' ? G.longSize : 1) });
      const addO = qty * lim * 100 * 0.5;
      if (qty >= 1 && heat + addO > heatCap) { act(`${c.symbol} skipped \u2014 total risk would exceed ${MAX_HEAT}% of the account`); continue; }
      if (qty >= 1) { heat += addO; sectorCount[sectorOf(s.sym)] = (sectorCount[sectorOf(s.sym)] || 0) + 1; }
      if (qty < 1) { act(`${c.symbol}: 1 contract ($${Math.round(lim * 100)}) is above this trade's risk budget — skipped`); continue; }
      await send({ symbol: c.symbol, qty: String(qty), side: 'buy', type: 'limit', limit_price: String(lim), time_in_force: 'day',
        client_order_id: `sd-o-${c.symbol}-${TODAY}-${qty}-${rid()}` }, `${s.sym} ${s.type.toUpperCase()} (stock touched ${s.entry})`);
      slots--;
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
  const allActs = (prev.acts || []).concat(acts).slice(-80);
  const env = lastGuard ? { at: new Date().toISOString(), block: lastGuard.block, regime: lastGuard.regime, reasons: lastGuard.reasons, today: lastGuard.today, upcoming: lastGuard.upcoming, flagged: lastGuard.flagged, spyPct: lastGuard.spyPct, newsOk: lastGuard.newsOk } : (prev.env || null);
  const sig = JSON.stringify([closed.length, closed[0] && closed[0].outT, open.map(o => o.sym + o.qty), acts.length, env && env.reasons, env && env.flagged && env.flagged.length]);
  if (prev.sig === sig && prev.at && Date.now() - Date.parse(prev.at) < 10 * 60000) { console.log('journal unchanged'); return; }
  const j = { at: new Date().toISOString(), sig, paper: !process.env.ALPACA_URL || /paper/.test(process.env.ALPACA_URL),
    account: { equity: +acct.equity, last_equity: +acct.last_equity, cash: +acct.cash }, closed, open, acts: allActs, env,
    risk: lastRisk, limits: { riskPct: RISK_PCT, optRiskPct: OPT_RISK_PCT, maxHeat: MAX_HEAT, perSector: MAX_PER_SECTOR, streak: MAX_STREAK, weekCap: WEEK_CAP, dayCap: LOSS_CAP } };
  fs.writeFileSync('bot/journal.json', JSON.stringify(j));
  console.log('journal written:', closed.length, 'closed,', open.length, 'open');
}

if (import.meta.url === 'file://' + process.argv[1]) {
  if (!HAVE_KEYS) { console.log('No Alpaca keys configured - nothing to do.'); process.exit(0); }
  await botCycle({ journal: true });
}
