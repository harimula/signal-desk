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

const KEY = process.env.ALPACA_KEY, SECRET = process.env.ALPACA_SECRET;
export const HAVE_KEYS = !!(KEY && SECRET);
const BASE = process.env.ALPACA_URL || 'https://paper-api.alpaca.markets';
const DATA = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';
const n = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? +process.env[k] : d);
const STK_ON = process.env.BOT_STOCKS !== '0', OPT_ON = process.env.BOT_OPTIONS !== '0';
const BUDGET = n('BOT_PER_TRADE', 500), OPT_BUDGET = n('BOT_OPT_BUDGET', 300);
const MAX_POS = n('BOT_MAX_POSITIONS', 6), MAX_OPT = n('BOT_MAX_OPTIONS', 4), MAX_ENTRIES = n('BOT_MAX_ENTRIES_PER_SYM', 3);
const TP = n('BOT_TAKE_PROFIT', 1), OPT_TP = n('BOT_OPT_TAKE_PROFIT', 50); // quick-profit exits, in %
const LOSS_CAP = n('BOT_DAILY_LOSS_CAP', 3), HOLD_LOSS = n('BOT_HOLD_LOSS', 1.5), HOLD_FLOOR = n('BOT_HOLD_FLOOR', 25), MAX_HOLD_DAYS = n('BOT_MAX_HOLD_DAYS', 30);
const UNIVERSE = (process.env.BOT_SYMBOLS || 'AAPL,MSFT,NVDA,AMZN,META,GOOGL,TSLA,AMD,JPM,BAC,XOM,CVX,KO,PEP,WMT,HD,DIS,INTC,CSCO,QCOM,ORCL,CRM,ADBE,NFLX,UBER,PLTR,SHOP,COIN,SOFI,F').split(',').map(s => s.trim()).filter(Boolean);
const DRY = process.env.BOT_DRY === '1';

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
const send = async (body, why) => { act(why + ' — ' + body.side.toUpperCase() + ' ' + body.qty + ' ' + body.symbol + (body.limit_price ? ' @ ' + body.limit_price : ' at market')); if (!DRY) return T('/v2/orders', { method: 'POST', body: JSON.stringify(body) }); };

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
let newsCache = { at: 0, market: [], syms: [], ok: true }, lastGuard = null, spyPrev = null;

// One full decision cycle: manage every position, then look for new entries.
export async function botCycle({ journal = false } = {}) {
  setNow();
  const before = acts.length;
  try { await run(); } catch (e) { act('Error: ' + (e.message || e)); }
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
      const sb = ((await D(`/v2/stocks/bars?symbols=SPY&timeframe=1Day&start=${new Date(Date.now() - 10 * 864e5).toISOString()}&limit=20&feed=iex&sort=asc`)).bars || {}).SPY || [];
      const prev = sb.filter(b => b.t.slice(0, 10) < ymdDash(Date.now())).pop();
      spyPrev = prev ? { day: TODAY, c: prev.c } : null;
    }
    const st = (((await D('/v2/stocks/trades/latest?symbols=SPY&feed=iex')).trades) || {}).SPY;
    if (spyPrev && st) spyPct = (st.p / spyPrev.c - 1) * 100;
  } catch (e) {}
  const G = lastGuard = guard({ events: loadEvents(), todayDash: ymdDash(Date.now()), mins: MINS, headlines: newsCache.market, spyPct });
  G.spyPct = spyPct; G.newsOk = newsCache.ok;
  for (const r of G.reasons) act('Market check: ' + r);
  const sellsFor = sym => openOrders.filter(o => o.symbol === sym && o.side === 'sell');
  const cid = o => o.client_order_id || '';

  // ---- kill switch ----
  if (fs.existsSync('bot/STOP')) {
    act('STOP file found — cancelling all orders and closing everything.');
    if (!DRY) { await T('/v2/orders', { method: 'DELETE' }); await T('/v2/positions?cancel_orders=true', { method: 'DELETE' }); }
    return;
  }
  const dayPct = lastEq > 0 ? (equity - lastEq) / lastEq * 100 : 0;
  const capHit = dayPct <= -LOSS_CAP;

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
    let slots = MAX_POS - stockPos.length - openOrders.filter(o => o.side === 'buy' && !isOpt(o.symbol)).length;
    for (const s of (G.noLongs ? [] : longs)) {
      if (slots <= 0) break;
      if (stockPos.some(p => p.symbol === s.sym) || openOrders.some(o => o.symbol === s.sym)) continue;
      const risk = symbolRisk(s.sym, newsCache.syms);
      if (risk) { act(`${s.sym} skipped \u2014 ${risk}`); continue; }
      if (todays.filter(o => cid(o).startsWith('sd-s-' + s.sym + '-')).length >= MAX_ENTRIES) continue;
      const qty = Math.floor(BUDGET * G.budget / s.entry);
      if (qty < 1) continue;
      await send({ symbol: s.sym, qty: String(qty), side: 'buy', type: 'limit', limit_price: String(s.entry), time_in_force: 'day',
        client_order_id: `sd-s-${s.sym}-${Math.round(s.target * 100)}-${Math.round(s.stop * 100)}-${TODAY}-${rid()}` }, `${s.sym} stock day trade (RSI-2 ${s.r2})`);
      slots--;
    }
  }

  // options: CALL on long setups, PUT on short setups — only once the stock touches the level
  if (OPT_ON && !G.noOptions) {
    let slots = MAX_OPT - optPos.length - openOrders.filter(o => o.side === 'buy' && isOpt(o.symbol)).length;
    const hasOptOn = und => optPos.some(p => OPT_RE.exec(p.symbol)[1] === und) || openOrders.some(o => isOpt(o.symbol) && OPT_RE.exec(o.symbol)[1] === und);
    const tries = (G.noLongs ? [] : longs.map(s => ({ ...s, type: 'call' }))).concat(G.noPuts ? [] : shorts.map(s => ({ ...s, type: 'put' })));
    for (const s of tries) {
      if (slots <= 0) break;
      if (!s.px || hasOptOn(s.sym)) continue;
      if (symbolRisk(s.sym, newsCache.syms)) continue;
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
      const qty = Math.floor(OPT_BUDGET * G.budget / (lim * 100));
      if (qty < 1) { act(`${c.symbol}: 1 contract ($${Math.round(lim * 100)}) is above the $${OPT_BUDGET} option budget — skipped`); continue; }
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
  const env = lastGuard ? { at: new Date().toISOString(), block: lastGuard.block, reasons: lastGuard.reasons, today: lastGuard.today, upcoming: lastGuard.upcoming, flagged: lastGuard.flagged, spyPct: lastGuard.spyPct, newsOk: lastGuard.newsOk } : (prev.env || null);
  const sig = JSON.stringify([closed.length, closed[0] && closed[0].outT, open.map(o => o.sym + o.qty), acts.length, env && env.reasons, env && env.flagged && env.flagged.length]);
  if (prev.sig === sig && prev.at && Date.now() - Date.parse(prev.at) < 30 * 60000) { console.log('journal unchanged'); return; }
  const j = { at: new Date().toISOString(), sig, paper: !process.env.ALPACA_URL || /paper/.test(process.env.ALPACA_URL),
    account: { equity: +acct.equity, last_equity: +acct.last_equity, cash: +acct.cash }, closed, open, acts: allActs, env };
  fs.writeFileSync('bot/journal.json', JSON.stringify(j));
  console.log('journal written:', closed.length, 'closed,', open.length, 'open');
}

if (import.meta.url === 'file://' + process.argv[1]) {
  if (!HAVE_KEYS) { console.log('No Alpaca keys configured - nothing to do.'); process.exit(0); }
  await botCycle({ journal: true });
}
