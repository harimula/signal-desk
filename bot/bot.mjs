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
import { sectorOf, stockQty, optionQty, regimeOf, lossStreak, openRisk, sideDayPl } from './risk.mjs';
import { normalize, entryEndMin, summary as cfgSummary } from './config.mjs';
import { tgOn, tgSend, tgPoll } from './telegram.mjs';
import { scanUniverse } from './scan.mjs';
import { daySetup, marketMode, dayShares, dayExit, dayTrail, encodeDayId, decodeDayId, SESSION_OPEN } from './daytrade.mjs';

const PAPER = { key: process.env.ALPACA_KEY, secret: process.env.ALPACA_SECRET, url: process.env.ALPACA_URL || 'https://paper-api.alpaca.markets' };
const LIVE = { key: process.env.ALPACA_LIVE_KEY, secret: process.env.ALPACA_LIVE_SECRET, url: 'https://api.alpaca.markets' };
export const HAVE_KEYS = !!(PAPER.key && PAPER.secret) || !!(LIVE.key && LIVE.secret);
let KEY, SECRET, H;
const PRIVATE = !!process.env.JOURNAL_KEY;                  // privacy mode: encrypted journal, redacted logs
export const redact = s => PRIVATE ? String(s).replace(/\$?\d[\d,]*(\.\d+)?/g, '\u2022') : String(s);
const DATA = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';
const DRY = process.env.BOT_DRY === '1';
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
// The market scan downloads ~20 daily bars for every US stock (12,000+), which can take minutes. It runs in the
// background so a slow or failing scan never holds up a decision cycle (open positions are managed every beat);
// until it is in, the bot uses the last successful scan (bot/scan.json, kept in the repo) or, failing that, the list.
// A failed scan is retried after 10 minutes, not on every beat.
let scanJob = null, scanFailAt = 0;
export const scanStatus = { state: 'idle', at: null, n: 0, err: '' };   // shown in the public engine line: is the scan in, running or failing?
const SCAN_FILE = 'bot/scan.json';
function savedScan() { try { const j = JSON.parse(fs.readFileSync(SCAN_FILE, 'utf8')); return Array.isArray(j.symbols) && j.symbols.length >= 5 ? j : null; } catch (e) { return null; } }
async function ensureUniverse() {
  if (CFG.universe !== 'scan') { UNIVERSE = CFG.symbols; return; }
  const key = CFG.scanSize + ':' + CFG.scanMinPrice;
  if (scanCache.symbols && scanCache.day === TODAY && scanCache.key === key) { UNIVERSE = scanCache.symbols; return; }
  if (!scanCache.symbols) { const sv = savedScan(); if (sv) scanCache = { day: sv.day || '', key: sv.key || '', symbols: sv.symbols, info: sv.info || null }; }
  if (!scanJob && Date.now() - scanFailAt > 10 * 60000) {
    act('market scan started (runs in the background; the bot keeps working meanwhile)'); Object.assign(scanStatus, { state: 'running', at: new Date().toISOString() });
    scanJob = scanUniverse({ T, D, size: CFG.scanSize, minPrice: CFG.scanMinPrice, log: m => act(m) }).then(r => {
      if (r.symbols.length >= 5) {
        scanCache = { day: TODAY, key, symbols: r.symbols, info: r }; barsCache = { at: 0, bars: null }; Object.assign(scanStatus, { state: 'done', at: new Date().toISOString(), n: r.symbols.length, err: '' });
        try { fs.writeFileSync(SCAN_FILE, JSON.stringify({ day: TODAY, key, symbols: r.symbols, info: { at: r.at, scanned: r.scanned } })); } catch (e) {}
      } else { scanFailAt = Date.now(); Object.assign(scanStatus, { state: 'failed', at: new Date().toISOString(), err: 'too few stocks (' + r.symbols.length + ')' }); act('market scan returned too few stocks (' + r.symbols.length + ') \u2014 keeping the previous list'); }
    }).catch(e => { scanFailAt = Date.now(); Object.assign(scanStatus, { state: 'failed', at: new Date().toISOString(), err: String(e.message || e).slice(0, 100) }); act('market scan failed (' + (e.message || e).slice(0, 80) + ') \u2014 using ' + (scanCache.symbols ? 'the last good scan' : 'the listed stocks') + '; retrying in 10 min'); })
      .finally(() => { scanJob = null; });
  }
  if (scanJob) await Promise.race([scanJob, sleepMs(3000)]);            // a quick scan (or a test) lands in this cycle; a slow one in a later one
  UNIVERSE = scanCache.symbols || CFG.symbols;
}

// =====================================================================================================================
// Day trading (experimental, OFF by default) — rules in docs/daytrading-rules.html, logic in daytrade.mjs.
// Separate order-id prefixes (sd-d-, sd-dc-, sd-dp-) keep it apart from the RSI-2 swing strategy.
// =====================================================================================================================
let barsCache5 = { at: 0, bars: null, day: '' }, dayState = {}, lastDay = null;
const etMinsOf = iso => { const e = etParts(new Date(iso)); return (+e.hour % 24) * 60 + +e.minute; };
const hhmm = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
async function load5m(syms) {
  const want = [...new Set(syms.concat(['SPY']))];
  if (barsCache5.bars && barsCache5.day === TODAY && Date.now() - barsCache5.at < 55000 && want.every(x => x in barsCache5.bars)) return barsCache5.bars;
  const out = {}; for (const x of want) out[x] = [];
  let token = '';
  for (let k = 0; k < 20; k++) {
    const j = await D(`/v2/stocks/bars?symbols=${want.join(',')}&timeframe=5Min&start=${ymdDash(Date.now())}T12:00:00Z&limit=10000&feed=iex&sort=asc${token ? '&page_token=' + token : ''}`);
    for (const [x, arr] of Object.entries(j.bars || {})) out[x] = (out[x] || []).concat(arr.map(b => ({ ...b, m: etMinsOf(b.t) })).filter(b => b.m >= SESSION_OPEN && b.m < 960));
    token = j.next_page_token; if (!token) break;
  }
  barsCache5 = { at: Date.now(), bars: out, day: TODAY };
  return out;
}
async function dayTradeCycle(ctx) {
  const { equity, acct, positions, hist, liveOrders, G, capHit, slBudget, sellsFor, cid } = ctx, halt = ctx.halt || { stock: capHit, call: capHit, put: capHit };
  const dayC = { start: hhmm(CFG.dayStart), end: hhmm(CFG.dayEnd), rvol: CFG.dayRvol, target: CFG.dayTarget, timeStop: CFG.dayTimeStop, orMin: CFG.dayOrMin };
  // open day trades: entry order id tells us side, stop, target and when it opened
  const dayPos = [];
  for (const p of positions) {
    const e = hist.find(o => o.side === 'buy' && o.status === 'filled' && /^sd-d[cp]?-/.test(cid(o)) && o.symbol === p.symbol);
    const d = e && decodeDayId(cid(e)); if (!d) continue;
    dayPos.push({ p, e, d, und: isOpt(p.symbol) ? OPT_RE.exec(p.symbol)[1] : p.symbol, opt: isOpt(p.symbol) });
  }
  if (!CFG.dayTrade && !dayPos.length) { lastDay = null; return; }
  const todayIds = hist.filter(o => o.side === 'buy' && /^sd-d[cp]?-/.test(cid(o)) && cid(o).includes('-' + TODAY + '-') && !['canceled', 'expired', 'rejected'].includes(o.status));
  const tradesToday = todayIds.length, tradedSyms = new Set(todayIds.map(o => isOpt(o.symbol) ? OPT_RE.exec(o.symbol)[1] : o.symbol));
  // cancel day entries that did not fill within 10 minutes (a day trade that is not filling has missed its moment)
  for (const o of liveOrders) if (o.side === 'buy' && /^sd-d[cp]?-/.test(cid(o)) && Date.now() - Date.parse(o.submitted_at || o.created_at || Date.now()) > 10 * 60000) {
    act(`${o.symbol} day-trade buy at ${o.limit_price} unfilled for 10 min — cancelled`); if (!DRY) await T('/v2/orders/' + o.id, { method: 'DELETE' }).catch(() => {}); o._cancelled = true;
  }
  const unds = [...new Set(dayPos.map(x => x.und))];
  const bars5 = await load5m(CFG.dayTrade ? UNIVERSE.concat(unds) : unds);
  const last = await latestPrices([...new Set(UNIVERSE.concat(unds, ['SPY']))]);
  const spyPx = last.SPY && last.SPY.p, market = marketMode(bars5.SPY, spyPx);

  // ---- manage open day trades ----
  for (const { p, d, und, opt } of dayPos) {
    const sells = sellsFor(p.symbol); if (sells.some(o => o.type === 'market')) continue;
    const px = last[und] && last[und].p; if (!px) continue;
    const st = dayState[p.symbol] || (dayState[p.symbol] = { stop: d.stop });
    const pos = { side: d.side, entry: opt ? d.entry : (+p.avg_entry_price || d.entry), stop: st.stop, target: d.target, openedMins: d.openMins };
    const stopLeg = sells.find(o => /stop/.test(o.type));
    const tr = dayTrail({ pos, px });
    if (tr) {
      st.stop = tr.stop; pos.stop = tr.stop; act(`${p.symbol} ${tr.why} (${tr.stop})`);
      if (stopLeg && !DRY) await T('/v2/orders/' + stopLeg.id, { method: 'PATCH', body: JSON.stringify({ stop_price: String(tick(tr.stop)) }) }).then(() => act(`${p.symbol} broker stop moved to ${tick(tr.stop)}`)).catch(e => act(`${p.symbol} could not move the broker stop (${(e.message || e).slice(0, 60)}) \u2014 the bot watches it instead`));
    }
    const out = async why => { for (const o of sells) if (!DRY) await T('/v2/orders/' + o.id, { method: 'DELETE' }).catch(() => {}); await send({ symbol: p.symbol, qty: String(Math.abs(+p.qty)), side: 'sell', type: 'market', time_in_force: 'day', client_order_id: 'sd-x-' + p.symbol + '-' + rid() }, why); delete dayState[p.symbol]; };
    const plpc = +p.unrealized_plpc * 100;
    if (opt) {
      if (plpc >= CFG.dayOptTp) { await out(`${p.symbol} day trade +${plpc.toFixed(0)}% — option take-profit`); continue; }
      if (plpc <= -CFG.dayOptStop) { await out(`${p.symbol} day trade ${plpc.toFixed(0)}% — option stop`); continue; }
      if (MINS >= 945) { await out(`${p.symbol} day trade — options flat by 3:45 PM`); continue; }
    }
    const x = dayExit({ pos, px, mins: MINS, cfg: dayC });
    if (x && (x.kind === 'stop' || x.kind === 'target') && !opt && stopLeg) continue;      // the broker's own legs handle these; the bot only steps in where no leg exists
    if (x) { await out(`${p.symbol} day trade ${x.kind === 'flat' ? 'closed' : 'exit'} — ${x.why} (${plpc >= 0 ? '+' : ''}${plpc.toFixed(1)}%)`); continue; }
    if (!opt && !sells.length) await send({ symbol: p.symbol, qty: String(Math.abs(+p.qty)), side: 'sell', type: 'limit', limit_price: String(tick(d.target)), time_in_force: 'day', client_order_id: 'sd-x-' + p.symbol + '-' + rid() }, `${p.symbol} day trade — take-profit order at ${d.target}`);
  }

  // ---- new day trades ----
  const dayClosed = (fillsCache.closed || []).filter(c => c.inT && c.outT && c.inT.slice(0, 10) === c.outT.slice(0, 10));
  let streak = 0; for (const c of [...dayClosed].sort((a, b) => a.outT < b.outT ? 1 : -1)) { if (c.pl < 0) streak++; else break; }
  const pdtBlock = equity < 25000 && +acct.daytrade_count >= 3 && !acct.pattern_day_trader;
  const idle = !CFG.dayTrade ? 'day trading is off' : capHit ? 'daily loss limits hit' : G.block ? 'paused by the market check' : pdtBlock ? 'pattern-day-trader limit (account under $25k)' : tradesToday >= CFG.dayMaxTrades ? `${tradesToday} day trades today — daily maximum reached` : streak >= CFG.dayStreak ? `${streak} day-trade losses in a row — done for the day` : MINS < dayC.start ? 'before the day-trade window' : MINS >= dayC.end ? 'day-trade window closed' : market === 'flat' ? 'market undecided (SPY on its VWAP) — waiting' : null;
  const setups = [];
  if (CFG.dayTrade) {
    const dailyBars = await loadBars();
    const avgVol = sym => { const B = completed(dailyBars || {}, sym); const w = B.slice(-10); return w.length ? w.reduce((t, b) => t + (b.v || 0), 0) / w.length : 0; };
    for (const sym of UNIVERSE) {
      if (sym === 'SPY') continue;
      const px = last[sym] && last[sym].p, B = bars5[sym] || [];
      const sg = daySetup({ bars: B, px, mins: MINS, avgDailyVol: avgVol(sym), market, cfg: dayC });
      if (sg) setups.push({ sym, ...sg, held: tradedSyms.has(sym) });
    }
    setups.sort((a, b) => (b.rvol || 0) - (a.rvol || 0));
  }
  let placed = 0;
  if (!idle) for (const sg of setups) {
    if (tradesToday + placed >= CFG.dayMaxTrades) break;
    if (sg.held || positions.some(p => (isOpt(p.symbol) ? OPT_RE.exec(p.symbol)[1] : p.symbol) === sg.sym) || liveOrders.some(o => (isOpt(o.symbol) ? OPT_RE.exec(o.symbol)[1] : o.symbol) === sg.sym)) continue;
    if (CFG.newsGuard && symbolRisk(sg.sym, newsCache.syms)) { act(`${sg.sym} day setup skipped — ${symbolRisk(sg.sym, newsCache.syms)}`); continue; }
    const label = `${sg.sym} day trade: ${sg.setup} ${sg.side === 'long' ? 'long' : 'short'} — ${sg.why}; stop ${sg.stop}, target ${sg.target}`;
    if (sg.side === 'long' && CFG.dayStock && !halt.stock) {
      const lim = r2d(sg.entry * 1.001), qty = dayShares({ equity, riskPct: CFG.dayRiskPct, entry: lim, stop: sg.stop, budget: slBudget('stock') });
      if (qty < 1) { act(`${sg.sym} day setup skipped — 1 share is above the risk or money budget`); continue; }
      await send({ symbol: sg.sym, qty: String(qty), side: 'buy', type: 'limit', limit_price: String(lim), time_in_force: 'day',
        order_class: 'bracket', take_profit: { limit_price: String(tick(sg.target)) }, stop_loss: { stop_price: String(tick(sg.stop)) },
        client_order_id: encodeDayId('sd-d-', sg.sym, sg.entry, sg.stop, sg.target, TODAY, MINS, rid()) }, label + ' · stop and target placed at the broker');
      placed++; continue;
    }
    if ((sg.side === 'long' && CFG.dayCalls && !halt.call) || (sg.side === 'short' && CFG.dayPuts && !halt.put)) {
      const kind = sg.side === 'long' ? 'call' : 'put', c = await pickDayContract(sg.sym, kind, sg.entry); if (!c) { act(`${sg.sym} ${kind.toUpperCase()}: no liquid contract 1–${CFG.dayOptDteMax} days out — skipped`); continue; }
      const qty = Math.max(0, Math.min(Math.floor(slBudget(kind) / (c.lim * 100)), Math.floor(equity * CFG.dayRiskPct * (G.budget || 1) / 100 / (c.lim * 100 * CFG.dayOptStop / 100))));
      if (qty < 1) { act(`${c.symbol}: 1 contract ($${Math.round(c.lim * 100)}) is above the day-trade risk or money budget — skipped`); continue; }
      await send({ symbol: c.symbol, qty: String(qty), side: 'buy', type: 'limit', limit_price: String(c.lim), time_in_force: 'day', client_order_id: encodeDayId(kind === 'put' ? 'sd-dp-' : 'sd-dc-', c.symbol, sg.entry, sg.stop, sg.target, TODAY, MINS, rid()) }, label.replace('day trade:', `day trade ${kind.toUpperCase()}:`));
      dayState[c.symbol] = { stop: sg.stop };
      placed++;
    }
  }
  lastDay = { at: new Date().toISOString(), on: CFG.dayTrade, market, spyVwap: bars5.SPY && bars5.SPY.length ? r2d(vwapOf(bars5.SPY)) : null, tradesToday: tradesToday + placed, max: CFG.dayMaxTrades, streak, idle,
    window: `${CFG.dayStart}–${CFG.dayEnd} ET, flat by 3:50 PM`,
    setups: setups.slice(0, 12).map(x => ({ sym: x.sym, setup: x.setup, side: x.side, entry: x.entry, stop: x.stop, target: x.target, rvol: x.rvol, why: x.why, held: x.held })),
    open: dayPos.map(({ p, d, und, opt }) => ({ s: p.symbol, und, kind: opt ? (d.kind === 'dp' ? 'put' : 'call') : 'stock', side: d.side, qty: Math.abs(+p.qty), avg: r2d(+p.avg_entry_price * (opt ? 100 : 1)), cur: r2d(+p.current_price * (opt ? 100 : 1)), pl: r2d(+p.unrealized_pl), plpc: Math.round(+p.unrealized_plpc * 1000) / 10, undPx: last[und] && last[und].p, stop: (dayState[p.symbol] || {}).stop || d.stop, target: d.target, opened: d.openMins })) };
}
const vwapOf = bars => { let pv = 0, vv = 0; for (const b of bars) { pv += (b.h + b.l + b.c) / 3 * (b.v || 0); vv += b.v || 0; } return vv ? pv / vv : bars[bars.length - 1].c; };
// Nearest-the-money contract expiring 1–N trading days out, with a tight enough market.
async function pickDayContract(und, kind, px) {
  const from = new Date(Date.now() + 864e5), to = new Date(Date.now() + CFG.dayOptDteMax * 864e5);
  const cj = await D(`/v2/options/contracts?underlying_symbols=${und}&type=${kind}&status=active&expiration_date_gte=${ymdDash(+from)}&expiration_date_lte=${ymdDash(+to)}&strike_price_gte=${r2d(px * 0.96)}&strike_price_lte=${r2d(px * 1.04)}&limit=200`).catch(() => ({}));
  const cs = (cj.option_contracts || []).filter(c => c.tradable !== false); if (!cs.length) return null;
  const ex = [...new Set(cs.map(c => c.expiration_date))].sort()[0];
  const c = cs.filter(x => x.expiration_date === ex).sort((a, b) => Math.abs(+a.strike_price - px) - Math.abs(+b.strike_price - px))[0];
  const q = ((await D(`/v1beta1/options/quotes/latest?symbols=${c.symbol}&feed=indicative`).catch(() => ({}))).quotes || {})[c.symbol];
  if (!q || !(q.ap > 0) || !(q.bp > 0) || (q.ap - q.bp) / q.ap > 0.1) return null;                 // day trades need a spread under 10%
  return { symbol: c.symbol, lim: tick(Math.min(q.ap, (q.ap + q.bp) / 2 * 1.02)), exp: ex, strike: +c.strike_price };
}
export const scanInfo = () => scanCache.info;
// End-of-day summary to the phone: what happened today, what is still open, where the account stands.
export async function eodReport() {
  try {
    const acct = await T('/v2/account'), positions = await T('/v2/positions');
    const f = await T('/v2/account/activities/FILL?date=' + ymdDash(Date.now()) + '&direction=asc&page_size=100').catch(() => []);
    const closed = buildJournal(f || [], []).closed, pl = closed.reduce((t, c) => t + c.pl, 0), wins = closed.filter(c => c.pl > 0).length;
    const eq = +acct.equity, day = +acct.last_equity > 0 ? (eq / +acct.last_equity - 1) * 100 : 0;
    const open = positions.map(p => `${p.symbol} ${(+p.unrealized_plpc * 100) >= 0 ? '+' : ''}${(+p.unrealized_plpc * 100).toFixed(1)}%`).join(', ');
    const stake = CFG.stakeUsd > 0 ? CFG.stakeUsd : eq, dayUsd = eq - (+acct.last_equity || eq);
    const detail = CFG.alertDetail === false ? '' : (CFG.stakeUsd > 0 ? ` · stake $${Math.round(stake).toLocaleString('en-US')}: ${dayUsd >= 0 ? '+' : '\u2212'}$${Math.abs(dayUsd).toFixed(0)} today (${(dayUsd / stake * 100) >= 0 ? '+' : ''}${(dayUsd / stake * 100).toFixed(2)}%)` : ` · account $${Math.round(eq).toLocaleString('en-US')} (${day >= 0 ? '+' : ''}${day.toFixed(2)}% today)`);
    alerts.push(`\ud83d\udcc5 Day done: ${closed.length} round trip${closed.length === 1 ? '' : 's'}${closed.length ? ` (${wins} won) ${pl >= 0 ? '+' : '\u2212'}$${Math.abs(pl).toFixed(0)}` : ''}${detail} · open: ${open || 'nothing'}${lastDay && lastDay.tradesToday ? ` · ${lastDay.tradesToday} day trade${lastDay.tradesToday === 1 ? '' : 's'}` : ''}`);
    await flushAlerts();
  } catch (e) { console.log('eod report failed', e.message); }
}
// Good-morning alert: the first run of the day says it is up, so a silent phone means "nothing happened", not "is it broken?".
export async function morningHello() {
  try {
    const positions = await T('/v2/positions');
    alerts.push(`\u2705 Bot is up for the day \u2014 watching ${UNIVERSE.length} stocks${CFG.universe === 'scan' ? ' (market scan follows in the background)' : ''}, holding ${positions.length} position${positions.length === 1 ? '' : 's'}. You get an alert for every buy and sell, and a summary after 4 PM.`);
    await flushAlerts();
  } catch (e) { console.log('morning alert failed', e.message); }
}
// Optional external heartbeat (e.g. a healthchecks.io ping URL in HEARTBEAT_URL): a service that alerts when pings stop.
export async function heartbeat() {
  const u = process.env.HEARTBEAT_URL; if (!u) return;
  try { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 5000); await fetch(u, { method: 'POST', body: 'ok', signal: ac.signal }); clearTimeout(t); } catch (e) {}
}

export function loadConfigFile() { try { return JSON.parse(fs.readFileSync('bot/config.json', 'utf8')); } catch (e) { return null; } }
applyConfig(loadConfigFile());

// Every broker call has a deadline, and reads are retried with backoff on rate limits, server errors and network
// faults. Order placement (POST) is never retried here: a repeat could double a position, and the idempotency
// guard in send() plus the client_order_id already protect against the slow-broker case.
const HTTP_TIMEOUT_MS = +process.env.HTTP_TIMEOUT_MS || 15000, HTTP_RETRIES = 3;
export const engine = { cycleMs: 0, cycleMax: 0, cycles: 0, calls: 0, callMs: 0, errors: 0, lastError: '', at: 0, hourErrors: [] };   // engine health, shown on the Bot trades tab
const sleepMs = ms => new Promise(z => setTimeout(z, ms));
async function call(base, path, opt = {}) {
  const method = (opt.method || 'GET').toUpperCase(), retriable = method !== 'POST';
  let lastErr = null;
  for (let attempt = 0; attempt <= (retriable ? HTTP_RETRIES : 0); attempt++) {
    if (attempt) await sleepMs(Math.min(8000, 1000 * 2 ** (attempt - 1)) + Math.random() * 300);
    const lim = opt.timeoutMs || HTTP_TIMEOUT_MS, ac = new AbortController(), timer = setTimeout(() => ac.abort(), lim), tCall = Date.now();
    let again = false;
    engine.calls++;
    try {
      const { timeoutMs, ...fo } = opt; void timeoutMs;
      const r = await fetch(base + path, { headers: H, ...fo, signal: ac.signal });
      engine.callMs += Date.now() - tCall;
      if (r.status === 204) return null;
      const tx = await r.text();
      if (r.ok) return tx ? JSON.parse(tx) : null;
      lastErr = new Error(path.split('?')[0] + ' HTTP ' + r.status + ' ' + tx.slice(0, 200));
      again = r.status === 429 || r.status >= 500;                                 // other 4xx: our mistake, retrying will not help
    } catch (e) {
      lastErr = new Error(path.split('?')[0] + ' ' + (e.name === 'AbortError' ? `timed out after ${lim / 1000}s` : e.message));
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
// When was the journal on disk written, in Eastern time? { day: 'yyyymmdd', mins } or null. Readable in both plain and encrypted journals.
export function journalStamp() {
  try { const at = JSON.parse(fs.readFileSync('bot/journal.json', 'utf8')).at; if (!at) return null; const ep = etParts(new Date(at)); return { day: ep.year + ep.month + ep.day, mins: (+ep.hour % 24) * 60 + +ep.minute, at }; }
  catch (e) { return null; }
}
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
let newsCache = { at: 0, market: [], syms: [], ok: true }, lastGuard = null, spyPrev = null, weekCache = { at: 0, start: null }, fillsCache = { at: 0, closed: [], fills: [] }, lastRisk = null;
const NM = { stock: { one: 'stock', many: 'stocks', Cap: 'Stocks' }, call: { one: 'CALL', many: 'CALLs', Cap: 'CALLs' }, put: { one: 'PUT', many: 'PUTs', Cap: 'PUTs' } };
let stopMoved = new Set();
let lastSplit = null, lastDayPx = {}, haltSaid = new Set();      // money split panel, yesterday's closes, halt messages already sent today
const alerts = [];

// One full decision cycle: manage every position, then look for new entries.
let hooks = {};
export async function botCycle({ journal = false, floors = null, held = null } = {}) {
  setNow(); hooks = { floors, held };
  const before = acts.length, t0 = Date.now();
  try { await run(); } catch (e) { engine.errors++; engine.lastError = String(e.message || e).slice(0, 120); engine.hourErrors.push(Date.now()); act('Error: ' + (e.message || e)); const k = 'err:' + (e.message || '').slice(0, 40); if (!seen.has(k) || Date.now() - seen.get(k) > 30 * 60000) { seen.set(k, Date.now()); alerts.push('\u26a0\ufe0f Bot error: ' + (e.message || e)); } }
  engine.cycleMs = Date.now() - t0; engine.cycleMax = Math.max(engine.cycleMax, engine.cycleMs); engine.cycles++; engine.at = Date.now();
  engine.hourErrors = engine.hourErrors.filter(t => Date.now() - t < 3600e3);
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

// Phone alerts go to the owner's Telegram chat (bot/telegram.mjs). ntfy was removed on 2026-10-23 (public channels).
const sentAlerts = new Map();
async function flushAlerts() {
  if (!alerts.length) return;
  const lines = alerts.splice(0).filter(m => { const k = m.replace(/[\d.]+/g, '#'); if (sentAlerts.has(k) && Date.now() - sentAlerts.get(k) < 20 * 60000) return false; sentAlerts.set(k, Date.now()); return true; });
  if (!lines.length || DRY || !CFG.alerts) return;
  if (tgOn()) try { await tgSend(lines.join('\n\n')); } catch (e) { console.log('telegram alert failed', e.message); }
}

// ---- Telegram commands (read-only, plus pause/resume of NEW entries; never buys or sells) ----
let userPause = false;
const usd = v => (v < 0 ? '\u2212' : '') + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
const usd2 = v => (v < 0 ? '\u2212' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sgnUsd = v => (v >= 0 ? '+' : '') + usd2(v);
export async function tgCommand(cmd) {
  if (cmd === 'start' || cmd === 'help') return ['Signal Desk bot \u2014 commands:',
    '/status \u2014 running? market check, what it watches', '/money \u2014 money in trades, free to trade, today', '/positions \u2014 what it holds and when it sells',
    '/watch \u2014 today\u2019s buy / CALL / PUT candidates', '/pause \u2014 no NEW entries (open positions stay protected)', '/resume \u2014 allow new entries again',
    '', 'Alerts for every buy and sell arrive here by themselves. I never buy or sell on a chat command.'].join('\n');
  if (cmd === 'pause') { userPause = true; return '\u23f8 Paused: no new entries until you send /resume (or until today\u2019s session ends). Open positions keep their stops, targets and exits.'; }
  if (cmd === 'resume') { userPause = false; return '\u25b6\ufe0f Resumed: new entries allowed again (the market check and risk limits still apply).'; }
  if (cmd === 'status') {
    const G = lastGuard || {}, W = lastWatch, sc = CFG.universe === 'scan' ? (scanStatus.state === 'done' ? 'market scan in' : 'market scan ' + scanStatus.state + (scanStatus.err ? ' (' + scanStatus.err.slice(0, 60) + ')' : '')) : 'your list';
    return [`\u2699\ufe0f ${BASE.includes('paper') ? 'Practice account' : 'LIVE account'} \u00b7 ${lastClock && lastClock.is_open ? 'market open' : 'market closed'}`,
      `Watching ${UNIVERSE.length} stocks (${sc}) \u00b7 last check ${(engine.cycleMs / 1000).toFixed(1)} s \u00b7 ${engine.hourErrors.length} errors in the last hour`,
      userPause ? '\u23f8 Paused by you (/resume to restart new entries)' : G.block ? '\u26d4 Market check: no new trades \u2014 ' + (G.reasons || []).slice(-2).join('; ') : '\u2705 Market check: trading normally',
      W && W.idle ? 'Not entering now: ' + W.idle : '',
      W ? `Candidates \u2014 buy: ${W.buy.length} \u00b7 CALL: ${W.call.length} \u00b7 PUT: ${W.put.length} (/watch for names)` : ''].filter(Boolean).join('\n');
  }
  if (cmd === 'money' || cmd === 'positions') {
    const [acct, pos] = await Promise.all([T('/v2/account'), T('/v2/positions')]);
    const eq = +acct.equity, stake = CFG.stakeUsd > 0 ? Math.min(CFG.stakeUsd, eq) : eq;
    const val = p => Math.abs(+p.market_value || 0), inStk = pos.filter(p => !isOpt(p.symbol)).reduce((t, p) => t + val(p), 0), inOpt = pos.filter(p => isOpt(p.symbol)).reduce((t, p) => t + val(p), 0);
    const openPl = pos.reduce((t, p) => t + (+p.unrealized_pl || 0), 0), today = eq - (+acct.last_equity || eq);
    if (cmd === 'money') return [`\ud83d\udcbc In trades now: ${usd(inStk + inOpt)} (${pos.length} position${pos.length === 1 ? '' : 's'})`,
      `   stocks ${usd(inStk)} \u00b7 options ${usd(inOpt)} \u00b7 open P/L ${sgnUsd(openPl)}`,
      `Free to trade: ${usd(Math.max(0, stake - inStk - inOpt))} of your ${CFG.stakeUsd > 0 ? usd(stake) + ' stake' : usd(eq) + ' account'}`,
      `Today: ${sgnUsd(today)} (${(today / (stake || 1) * 100).toFixed(2)}%)`].concat(CFG.split ? (() => {
        const S = lastSplit && lastSplit.on ? lastSplit : null, cs = CFG.callSharePct, ps = CFG.putSharePct, sh = { stock: 100 - cs - ps, call: cs, put: ps };
        const used = { stock: inStk, call: pos.filter(p => isOpt(p.symbol) && (OPT_RE.exec(p.symbol) || [])[3] === 'C').reduce((t, p) => t + val(p), 0), put: pos.filter(p => isOpt(p.symbol) && (OPT_RE.exec(p.symbol) || [])[3] === 'P').reduce((t, p) => t + val(p), 0) };
        const line = k => { const t = S && S[k] ? S[k].today : null, h = S && S[k] && S[k].halted; return `   ${NM[k].Cap}: ${usd(used[k])} of ${usd(stake * sh[k] / 100)} in use${t != null ? ' \u00b7 today ' + sgnUsd(t) : ''} \u00b7 ${h ? '\u26d4 stopped for today' : 'loss limit ' + (k === 'stock' ? CFG.dayCap : CFG.optDayCap) + '%'}`; };
        return [`Split ${sh.stock}/${cs}/${ps} (stocks/CALLs/PUTs):`, line('stock'), line('call'), line('put')];
      })() : []).join('\n');
    if (!pos.length) return 'Holding nothing right now.';
    const held = (lastWatch && lastWatch.held) || [];
    return ['\ud83d\udce6 Holding:'].concat(pos.map(p => {
      const opt = isOpt(p.symbol), mult = opt ? 100 : 1, h = held.find(x => x.s === p.symbol) || {};
      const rule = opt ? `take-profit ${h.tp != null ? usd2(h.tp) : '+' + OPT_TP + '%'} \u00b7 stop ${h.stop != null ? usd2(h.stop) : '\u2212' + CFG.optStop + '%'} (per contract)`
        : (h.exitLevel != null ? `sells when ${p.symbol} closes ${h.exitSide || 'above'} ${usd2(h.exitLevel)}` : 'sells by its exit rule') + (h.floor ? ` \u00b7 floor ${usd2(h.floor)}` : '');
      return `\u2022 ${p.symbol} \u00d7${Math.abs(+p.qty)} \u2014 bought ${usd2(+p.avg_entry_price * mult)}, now ${usd2(+p.current_price * mult)}, ${sgnUsd(+p.unrealized_pl)} (${(+p.unrealized_plpc * 100).toFixed(1)}%)\n   ${rule}`;
    })).join('\n');
  }
  if (cmd === 'watch') {
    const W = lastWatch; if (!W) return 'No watch list yet \u2014 it is built after the first check of the trading day.';
    const list = (on, a) => !on ? 'switched off' : a.length ? a.slice(0, 30).join(' ') + (a.length > 30 ? ` \u2026 +${a.length - 30}` : '') : 'none right now';
    return [`\ud83d\udc40 Watching ${W.total} stocks${W.idle ? ' \u00b7 not entering now: ' + W.idle : ''}`, `\ud83d\udfe2 Buy: ${list(W.on.stocks, W.buy)}`, `\ud83d\udcc8 CALL: ${list(W.on.calls, W.call)}`, `\ud83d\udcc9 PUT: ${list(W.on.puts, W.put)}`,
      'A candidate still has to pass the news guard, entry window and risk limits.'].join('\n');
  }
  return null;
}
export async function tgPollCycle() { try { return await tgPoll(tgCommand); } catch (e) { console.log('telegram poll failed', e.message); return 0; } }

async function run() {
  await ensureUniverse();
  if (!lastClock || Date.now() - (lastClock._at || 0) > 30000) { lastClock = await T('/v2/clock'); lastClock._at = Date.now(); }
  const clock = lastClock;
  if (!clock.is_open) { console.log('Market closed.'); return; }
  // the four account questions are independent: ask them at once instead of one after another (cycle time roughly halves)
  const [acct, positions, openOrders, hist] = await Promise.all([
    T('/v2/account'), T('/v2/positions'), T('/v2/orders?status=open&limit=500'),
    T('/v2/orders?status=all&limit=500&direction=desc&after=' + new Date(Date.now() - 45 * 864e5).toISOString()),
  ]);
  // The stake: with stakeUsd set, the bot behaves as if the account held only that much — every size, loss limit and the
  // pattern-day-trader rule are computed on it — so a $100k practice account trades exactly like the money you mean to use.
  const acctEq = +acct.equity, acctLast = +acct.last_equity || acctEq;
  const stake = CFG.stakeUsd > 0 ? Math.min(CFG.stakeUsd, acctEq) : acctEq;
  const equity = stake, lastEq = CFG.stakeUsd > 0 ? stake - (acctEq - acctLast) : acctLast;    // today's change is the account's real change, applied to the stake
  posBySym = Object.fromEntries(positions.map(p => [p.symbol, p]));
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
  // real money starts small: every budget and risk figure is scaled by the live size setting (paper is always 100%)
  const liveScale = CFG.mode === 'live' ? CFG.liveSizePct / 100 : 1;
  if (liveScale < 1) { G.budget = (G.budget || 1) * liveScale; G.reasons.push(`Live trading at ${CFG.liveSizePct}% of the paper size (ramp-up setting)`); }
  if (RG.regime === 'bear') G.reasons.push('Bear market regime (SPY below its 50- and 200-day averages) \u2014 fewer stocks qualify, since each must be above its own 200-day');   // reported, not enforced: the filter did not improve RSI-2 in the research
  // (neutral regime: no size change for RSI-2)
  // circuit breakers: losing streak today, weekly drawdown
  const sideStreak = { stock: null, call: null, put: null };
  try {
    if (Date.now() - fillsCache.at > 60000) {
      const f = await T('/v2/account/activities/FILL?date=' + ymdDash(Date.now()) + '&direction=asc&page_size=100');
      fillsCache = { at: Date.now(), closed: buildJournal(f || [], []).closed, fills: f || [] };
    }
    if (CFG.split) {                                                     // with the money split, a losing streak stops only its own side
      for (const [k, kind] of [['stock', 'Stock'], ['call', 'Call'], ['put', 'Put']]) {
        const n = lossStreak(fillsCache.closed.filter(c => c.kind === kind));
        if (n >= MAX_STREAK) sideStreak[k] = `${n} losing ${NM[k].one} trades in a row today`;
      }
    } else {
      const streak = lossStreak(fillsCache.closed);
      if (streak >= MAX_STREAK) { G.block = true; G.halt = true; G.reasons.push(`${streak} losing trades in a row today \u2014 done for the day (protects against a bad tape)`); }
    }
    if (Date.now() - weekCache.at > 10 * 60000) {
      const h = await T('/v2/account/portfolio/history?period=1W&timeframe=1D');
      const eqs = (h && h.equity || []).filter(x => x != null && x > 0);
      weekCache = { at: Date.now(), start: eqs.length ? eqs[0] : null };
    }
    const weekPct = weekCache.start ? (acctEq - weekCache.start) / equity * 100 : 0;        // the account's dollar change this week, measured against the stake
    if (weekCache.start && weekPct <= -WEEK_CAP) { G.block = true; G.halt = true; G.reasons.push(`Down ${(-weekPct).toFixed(1)}% this week (limit ${WEEK_CAP}%) \u2014 no new trades until next week`); }
  } catch (e) { console.log('breaker check failed', e.message); }
  if (userPause) { G.block = true; G.reasons.push('Paused from Telegram \u2014 no new entries until /resume; open positions are still managed'); }
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
  // ---- money split: stocks and options each own a share of the stake and have their own daily loss limit ----
  const SPLIT = !!CFG.split, KINDS = ['stock', 'call', 'put'];
  const share = { call: CFG.callSharePct, put: CFG.putSharePct, stock: 100 - CFG.callSharePct - CFG.putSharePct };
  const SIDE = Object.fromEntries(KINDS.map(k => [k, { money: SPLIT ? equity * share[k] / 100 : equity, capPct: !SPLIT ? LOSS_CAP : k === 'stock' ? LOSS_CAP : CFG.optDayCap }]));
  const sideUsed = k => SL[k].used;
  const slBudget = k => Math.max(0, Math.min(SL[k].per * G.budget, SL[k].cap > 0 ? SL[k].cap - SL[k].used : Infinity, SPLIT ? SIDE[k].money - SL[k].used : Infinity));
  const capNote = k => SPLIT && SIDE[k].money - SL[k].used < SL[k].per ? ` (${NM[k].one} money $${Math.round(SIDE[k].money)}, $${Math.round(SL[k].used)} already in use)`
    : SL[k].cap > 0 && SL[k].cap - SL[k].used < SL[k].per ? ` (${k} money ceiling $${Math.round(SL[k].cap)}, $${Math.round(SL[k].used)} already in use)` : '';
  const capHit = dayPct <= -LOSS_CAP;
  for (const p of positions) if (+p.lastday_price > 0) lastDayPx[p.symbol] = +p.lastday_price;
  const sideDay = sideDayPl({ positions, fills: fillsCache.fills || [], lastDay: lastDayPx });
  const halt = { stock: null, call: null, put: null };
  if (SPLIT) for (const k of KINDS) {
    const S = SIDE[k]; S.today = sideDay[k]; S.limit = S.money * S.capPct / 100;
    if (S.money > 0 && S.today <= -S.limit) halt[k] = `${NM[k].many} down $${Math.round(-S.today)} today \u2014 past the ${S.capPct}% limit on its $${Math.round(S.money)}`;
    else if (sideStreak[k]) halt[k] = sideStreak[k];
  } else if (capHit) halt.stock = halt.call = halt.put = `daily loss cap ${LOSS_CAP}% hit`;
  for (const k of KINDS) if (halt[k] && !haltSaid.has(TODAY + k)) {
    haltSaid.add(TODAY + k);
    if (!SPLIT) { if (k === 'stock') alerts.push(`\u26d4 ${halt[k]} \u2014 no new trades today`); continue; }
    const others = KINDS.filter(x => x !== k && !halt[x]).map(x => NM[x].many);
    const msg = `${halt[k]} \u2014 no new ${NM[k].one} trades today${k !== 'stock' ? '; open ' + NM[k].many + ' are closed' : ''}${others.length ? '; ' + others.join(' and ') + ' carry on' : ''}`;
    act(msg); alerts.push('\u26d4 ' + msg);
  }

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
  const r0 = x => Math.round(x);
  lastSplit = { at: new Date().toISOString(), on: SPLIT, shares: share, stake: r0(equity),
    ...Object.fromEntries(KINDS.map(k => [k, { money: r0(SIDE[k].money), used: r0(sideUsed(k)), today: SPLIT ? sideDay[k] : null, limitPct: SIDE[k].capPct, halted: halt[k] }])) };

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
      const legs = sellsFor(p.symbol), brokerStop = legs.some(o => /stop/.test(o.type));
      const out = async why => { for (const o of legs) if (!DRY) await T('/v2/orders/' + o.id, { method: 'DELETE' }).catch(() => {}); await send({ symbol: p.symbol, qty: String(Math.abs(+p.qty)), side: 'sell', type: 'market', time_in_force: 'day', client_order_id: 'sd-x-' + p.symbol + '-' + rid() }, why); };
      const livePl = px ? (px / +p.avg_entry_price - 1) * 100 : plpc;
      if (HOLD_FLOOR > 0 && !brokerStop && Math.min(plpc, livePl) <= -HOLD_FLOOR) { await out(`${p.symbol} down ${Math.min(plpc, livePl).toFixed(1)}% \u2014 hit the ${HOLD_FLOOR}% hard floor`); continue; }
      if (HOLD_FLOOR > 0 && !brokerStop && !legs.length && px && MINS < 955) {           // a position without a broker stop (older entry, or the leg was rejected): put one on
        const fp = tick(+p.avg_entry_price * (1 - HOLD_FLOOR / 100));
        await send({ symbol: p.symbol, qty: String(Math.abs(+p.qty)), side: 'sell', type: 'stop', stop_price: String(fp), time_in_force: 'gtc', client_order_id: 'sd-x-' + p.symbol + '-' + rid() }, `${p.symbol} \u2014 protective stop placed at the broker (${fp})`);
      }
      if (HOLD_FLOOR > 0 && brokerStop && px) {                          // the stop setting was tightened: bring older broker stops up to it
        const fp = tick(+p.avg_entry_price * (1 - HOLD_FLOOR / 100)), leg = legs.find(o => /stop/.test(o.type));
        const oldLeg = leg && +leg.stop_price < fp - 0.005;               // only an older, wider stop is touched; a correct one is left to the broker (no double sale)
        if (oldLeg && px <= fp) { await out(`${p.symbol} down ${livePl.toFixed(1)}% \u2014 below the ${HOLD_FLOOR}% stop`); continue; }
        if (oldLeg && !stopMoved.has(leg.id)) {
          stopMoved.add(leg.id);
          if (!DRY) await T('/v2/orders/' + leg.id, { method: 'PATCH', body: JSON.stringify({ stop_price: String(fp) }) }).then(() => act(`${p.symbol} broker stop moved up to ${fp} (${HOLD_FLOOR}% below the buy price)`)).catch(e2 => act(`${p.symbol} could not move the broker stop (${(e2.message || e2).slice(0, 60)}) \u2014 the bot watches the ${HOLD_FLOOR}% stop instead`));
        }
      }
      // quick take-profit: sell as soon as the gain reaches the target, at any time of day (same day only when the day-trade rule allows)
      if (CFG.stockTp > 0 && px && livePl >= CFG.stockTp && (day8 !== TODAY || !pdtNear)) { await out(`${p.symbol} +${livePl.toFixed(1)}% \u2014 take profit (target ${CFG.stockTp}%)`); continue; }
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
      else if (halt[kindOf(p.symbol)]) await out(`${p.symbol} ${SPLIT ? NM[kindOf(p.symbol)].one + ' daily loss limit' : 'daily loss cap'} hit \u2014 closing options`);
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
    else if (halt[kindOf(p.symbol)]) await out(`${p.symbol} ${SPLIT ? NM[kindOf(p.symbol)].one + ' daily loss limit' : 'daily loss cap'} hit \u2014 closing options`);
    else if (G.closeOptionsAt != null && MINS >= G.closeOptionsAt) await out(`${p.symbol} Fed decision in minutes \u2014 closing options before the volatility`);
    else if (exp <= TODAY) await out(`${p.symbol} expires today \u2014 out`);
    else if (day < TODAY && MINS >= 940) await out(`${p.symbol} time stop \u2014 options are held one night at most`);
    else if (!sells.length) await send({ symbol: p.symbol, qty: String(qty), side: 'sell', type: 'limit', limit_price: String(tick(avg * (1 + OPT_TP / 100))), time_in_force: 'day', client_order_id: 'sd-x-' + p.symbol + '-' + rid() }, `${p.symbol} take-profit at +${OPT_TP}%`);
  }

  // ---- day trading (own windows and limits; manages its open trades every beat, even when the switch is off) ----
  try { await dayTradeCycle({ equity, acct, positions, hist, liveOrders, G, capHit: !!(halt.stock && halt.call && halt.put), halt, slBudget, sellsFor, cid }); }
  catch (e) { act('Day-trade engine error: ' + (e.message || e).slice(0, 120)); }

  // ---- what the bot is looking at (always, even when it cannot enter: the Bot trades tab shows it) ----
  const bothHalted = !!(halt.stock && halt.call && halt.put);
  const gated = bothHalted || MINS < G.minStart || MINS >= ENTRY_END || G.block;
  if (gated && lastWatch && Date.now() - Date.parse(lastWatch.at) < 20000) return;   // nothing to enter: refresh the watch list every 20 s, not every beat
  const bars = await loadBars();
  const last = await latestPrices(UNIVERSE);
  const sigs = [];
  for (const sym of UNIVERSE) {
    const B = completed(bars, sym); if (B.length < 205) continue;
    const px0 = last[sym] && last[sym].p, s = CFG.intraday && px0 ? liveSignal(B, px0, 'long', CFG.rsiThreshold) : rsi2Signal(B, B.map(b => b.c), B.length - 1, CFG.rsiThreshold); if (s) sigs.push({ sym, ...s, px: last[sym] && last[sym].p });
  }
  // Leaders first (setting pickBy = 'leaders'): among today's dips, buy the stocks that beat the market over the last 3 months.
  // The research (33 years) ranked this above the deepest-dip order in every period. 'dip' = deepest dip first, like the original test.
  const spyR60 = spyPrev && spyPrev.closes.length > 61 ? spyPrev.closes[spyPrev.closes.length - 1] / spyPrev.closes[spyPrev.closes.length - 61] - 1 : 0;
  for (const s of sigs) { const C = completed(bars, s.sym).map(b => b.c); s.lead = C.length > 61 ? r2d(((C[C.length - 1] / C[C.length - 61] - 1) - spyR60) * 100) : null; }
  if (CFG.pickBy === 'leaders') sigs.sort((a, b) => (b.lead ?? -1e9) - (a.lead ?? -1e9) || a.r2 - b.r2);
  else sigs.sort((a, b) => a.r2 - b.r2);                                 // deepest dip first, like the backtest
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
      const lead = base.length > 61 ? r2d(((base[base.length - 1] / base[base.length - 61] - 1) - spyR60) * 100) : null;
      rows.push({ s: sym, px: r2d((last[sym] && last[sym].p) || cl[cl.length - 1]), r2: Math.round(r * 10) / 10, up: cl[cl.length - 1] > m, s200: r2d(m), lead,
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
    lastWatch = { at: new Date().toISOString(), idle: bothHalted ? (SPLIT ? 'all daily loss limits hit' : 'daily loss cap hit') : MINS < G.minStart ? 'before the entry window' : MINS >= ENTRY_END ? `swing entry window closed for today (entries 9:45\u2013${CFG.entryEnd} ET; Bot settings \u2192 4. Strategy)` : G.block ? 'paused by the market check' : null, thr: CFG.rsiThreshold, maxHold: CFG.maxHold, pickBy: CFG.pickBy || 'dip', held: heldRows, intraday: !!CFG.intraday, universe: CFG.universe, scanned: scanCache.info ? scanCache.info.scanned : null, scanAt: scanCache.info ? scanCache.info.at : null, on: { stocks: STK_ON, calls: OPT_ON, puts: PUT_ON },
      buy: STK_ON ? sigs.map(x => x.sym) : [], call: OPT_ON ? sigs.map(x => x.sym) : [], put: PUT_ON ? shortSigs.map(x => x.sym) : [], total: UNIVERSE.length, rows };
  }
  if (shortSigs.length) act(`RSI-2 pops (PUT candidates): ${shortSigs.map(s => s.sym + ' (' + s.r2 + ')').join(', ')}`);
  // ---- new entries ----
  if (bothHalted) { if (!SPLIT) act(`Daily loss cap ${LOSS_CAP}% hit (${dayPct.toFixed(2)}%) — no new trades today`); return; }
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
  if (sigs.length) act(`RSI-2 dips ${CFG.intraday ? 'right now (intraday)' : 'today'}${CFG.pickBy === 'leaders' ? ', leaders first' : ''}: ${sigs.map(s => s.sym + ' (RSI-2 ' + s.r2 + (s.lead != null ? ', ' + (s.lead >= 0 ? '+' : '') + s.lead + '% vs market' : '') + ')').join(', ')}`);
  const todays = hist.filter(o => o.side === 'buy' && cid(o).includes('-' + TODAY + '-') && !['canceled', 'expired', 'rejected'].includes(o.status));

  if (STK_ON && !halt.stock) {
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
      // the hard-floor stop travels with the order (OTO leg, good-till-cancelled) so the broker enforces it even if the bot is down
      const floorPx = HOLD_FLOOR > 0 ? tick(lim * (1 - HOLD_FLOOR / 100)) : null;
      await send({ symbol: s.sym, qty: String(qty), side: 'buy', type: 'limit', limit_price: String(lim), time_in_force: floorPx ? 'gtc' : 'day',
        ...(floorPx ? { order_class: 'oto', stop_loss: { stop_price: String(floorPx) } } : {}),
        client_order_id: `sd-r-${s.sym}-${Math.round(s.riskUnit * 100)}-${TODAY}-${rid()}` }, `${s.sym} RSI-2 dip buy (RSI-2 ${s.r2}, above 200-day ${s.s200})${floorPx ? ' · broker stop at ' + floorPx : ''}`);
      SL.stock.used += qty * lim; heat += add; sectorCount[sectorOf(s.sym)] = (sectorCount[sectorOf(s.sym)] || 0) + 1; slots--;
    }
  }

  // CALLs on the same RSI-2 dips (puts are off: the short side was not part of the winning research)
  if ((OPT_ON || PUT_ON) && !G.noOptions && !(halt.call && halt.put)) {
    let slots = MAX_OPT - optPos.length - liveOrders.filter(o => o.side === 'buy' && isOpt(o.symbol)).length;
    const hasOptOn = und => optPos.some(p => OPT_RE.exec(p.symbol)[1] === und) || liveOrders.some(o => isOpt(o.symbol) && OPT_RE.exec(o.symbol)[1] === und);
    const optSets = [];
    if (OPT_ON) optSets.push(['call', sigs]);
    if (PUT_ON) optSets.push(['put', shortSigs]);
    for (const [kind, list] of optSets) for (const s of list) {
      const K = kind.toUpperCase();
      if (halt[kind]) break;
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
      const maxSpr = Math.min(0.2, CFG.optStop / 200);                   // the spread must be under half the stop, or the stop fires on the spread alone
      if ((q.ap - q.bp) / q.ap > maxSpr) { act(`${c.symbol}: spread too wide (${q.bp}/${q.ap}, over ${+(maxSpr * 100).toFixed(1)}% for a ${CFG.optStop}% stop) \u2014 skipped`); continue; }
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

// ---- journal encryption (public site, private data) ----
// AES-256-GCM with a key derived from the journal passphrase (PBKDF2-SHA256, 600k rounds; older blobs carry their own `iter`).
// The page decrypts with the same passphrase; the bot decrypts its own previous entry at start-up so that nothing is lost
// across restarts (every run is a fresh process — without this, a run that starts after the close, or at 9:20 before the
// open, would publish a journal with no watch list, no market check and an empty action log).
export { encryptJournal, decryptJournal } from './jcrypt.mjs';
import { encryptJournal, decryptJournal } from './jcrypt.mjs';

// The previous journal, as this process knows it: read (and decrypted) once from disk, then kept in memory after each write.
let prevJournal = null;
async function previousJournal() {
  if (prevJournal) return prevJournal;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync('bot/journal.json', 'utf8')); } catch (e) { return (prevJournal = {}); }
  if (!raw || !raw.enc) return (prevJournal = raw || {});
  if (!PRIVATE) return (prevJournal = { at: raw.at, sig: raw.sig });                       // encrypted by an earlier setup, no key now: start fresh
  try { prevJournal = { ...raw, ...(await decryptJournal(raw, process.env.JOURNAL_KEY)) }; }
  catch (e) { console.log('previous journal could not be decrypted (passphrase changed?) — starting a fresh one'); prevJournal = { at: raw.at, sig: raw.sig }; }
  return prevJournal;
}
export const _resetPrevJournal = () => { prevJournal = null; };                             // tests only
let actsFlushed = 0, journalActs = null;                                                     // the published action log; `acts` entries past actsFlushed are new
const sameAct = (a, b) => a.t === b.t && a.m === b.m;

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
  const prev = await previousJournal();
  if (!journalActs) journalActs = (prev.acts || []).filter(a => a && a.t && a.m);
  for (const a of acts.slice(actsFlushed)) if (!journalActs.some(b => sameAct(a, b))) journalActs.push(a);   // append only what is new, once
  actsFlushed = acts.length; journalActs = journalActs.slice(-80);
  const allActs = journalActs;
  const env = lastGuard ? { at: new Date().toISOString(), block: lastGuard.block, regime: lastGuard.regime, reasons: lastGuard.reasons, today: lastGuard.today, upcoming: lastGuard.upcoming, flagged: lastGuard.flagged, spyPct: lastGuard.spyPct, newsOk: lastGuard.newsOk } : (prev.env || null);
  const lastAct = allActs[allActs.length - 1];
  const sig = JSON.stringify([closed.length, closed[0] && closed[0].outT, open.map(o => o.sym + o.qty), allActs.length, lastAct && lastAct.t, env && env.reasons, env && env.flagged && env.flagged.length]);
  const sigCmp = PRIVATE ? (await import('node:crypto')).createHash('sha256').update(sig).digest('hex').slice(0, 16) : sig;
  if (prev.sig === sigCmp && prev.at && Date.now() - Date.parse(prev.at) < 10 * 60000) { console.log('journal unchanged'); return; }
  const j = { at: new Date().toISOString(), sig, paper: /paper/.test(BASE),
    account: { equity: +acct.equity, last_equity: +acct.last_equity, cash: +acct.cash }, closed, open, acts: allActs, env,
    settings: { ...CFG, summary: cfgSummary(CFG), base: BASE.includes('paper') ? 'paper' : 'LIVE' }, stream: { ...streamStats, mode: streamStats.lastTick && Date.now() - streamStats.lastTick < 60000 ? 'streaming' : 'polling' }, engine: { cycleMs: engine.cycleMs, cycleMax: engine.cycleMax, cycles: engine.cycles, avgCallMs: engine.calls ? Math.round(engine.callMs / engine.calls) : 0, calls: engine.calls, errorsHour: engine.hourErrors.length, lastError: engine.lastError, symbols: UNIVERSE.length, beatMs: +process.env.BEAT_MS || 2000, scan: CFG.universe === 'scan' ? { ...scanStatus } : null },
    // panels the bot only computes while the market is open: a process that has not computed them yet keeps the previous ones
    risk: lastRisk || prev.risk || null, split: lastSplit || prev.split || null, watch: lastWatch || prev.watch || null, day: lastDay || prev.day || null,
    limits: { riskPct: RISK_PCT, optRiskPct: OPT_RISK_PCT, maxHeat: MAX_HEAT, perSector: MAX_PER_SECTOR, streak: MAX_STREAK, weekCap: WEEK_CAP, dayCap: LOSS_CAP } };
  if (PRIVATE) {
    // Only the timestamp, paper/live flag, stream health and engine health stay readable; the page decrypts the rest with the same passphrase.
    const blob = await encryptJournal(j, process.env.JOURNAL_KEY);
    const sigH = (await import('node:crypto')).createHash('sha256').update(sig).digest('hex').slice(0, 16);   // change-detector only, reveals nothing
    fs.writeFileSync('bot/journal.json', JSON.stringify({ ...blob, at: j.at, sig: sigH, paper: j.paper, stream: j.stream, engine: j.engine }));
    prevJournal = { ...j, sig: sigH };
    console.log('journal written (encrypted)');
  } else {
    fs.writeFileSync('bot/journal.json', JSON.stringify(j));
    prevJournal = j;
    console.log('journal written:', closed.length, 'closed,', open.length, 'open');
  }
}

if (import.meta.url === 'file://' + process.argv[1]) {
  if (!HAVE_KEYS) { console.log('No Alpaca keys configured - nothing to do.'); process.exit(0); }
  await botCycle({ journal: true });
}
