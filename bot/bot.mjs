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
import { sma, rsi2, liveSignal, rsi2Trigger, rsi2ExitLevel, r2d, rsi2Signal, rsi2Exit, rsi2ShortSignal, rsi2ShortExit, profitExit, profitExitLevel, marketAbove200 } from './strategy.mjs';
import { buildJournal, optionEvents } from './journal.mjs';
import { guard, loadEvents, symbolRisk } from './news.mjs';
import { sectorOf, stockQty, optionQty, regimeOf, lossStreak, openRisk, sideDayPl } from './risk.mjs';
import { normalize, entryEndMin, summary as cfgSummary } from './config.mjs';
import { tgOn, tgSend, tgPoll } from './telegram.mjs';
import { scanUniverse } from './scan.mjs';
import { daySetup, marketMode, dayShares, dayExit, dayTrail, encodeDayId, decodeDayId, SESSION_OPEN } from './daytrade.mjs';
import { spySignal, spyExit, spyFresh, encodeSpyId, decodeSpyId, isSpyOption } from './spyopt.mjs';
import { wheelCycle as wheelCycleInfo, putStrike, callStrike, wheelTpPrice, wheelId, isWheelSell, isWheelBuy, isWheelId, parseOcc, wheelReconcile, trendThrough, soldFor } from './wheel.mjs';

const PAPER = { key: process.env.ALPACA_KEY, secret: process.env.ALPACA_SECRET, url: process.env.ALPACA_URL || 'https://paper-api.alpaca.markets' };
const LIVE = { key: process.env.ALPACA_LIVE_KEY, secret: process.env.ALPACA_LIVE_SECRET, url: 'https://api.alpaca.markets' };
export const HAVE_KEYS = !!(PAPER.key && PAPER.secret) || !!(LIVE.key && LIVE.secret);
let KEY, SECRET, H;
const PRIVATE = !!process.env.JOURNAL_KEY;                  // privacy mode: encrypted journal, redacted logs
// Privacy mode hides what is traded and how much from the public Actions logs: option symbols, amounts/prices/counts, and
// ticker-like words (a short list of plain words such as STOP or VWAP stays readable).
const KEEP = new Set(['STOP', 'VWAP', 'RSI', 'ET', 'AM', 'PM', 'UTC', 'OK', 'DRY', 'PAPER', 'LIVE', 'US', 'IN', 'TP', 'CALL', 'PUT', 'CALLS', 'PUTS', 'ETF', 'API', 'GET', 'POST', 'DELETE', 'HTTP', 'JSON', 'SL', 'EOD', 'P', 'L', 'A', 'I']);
export const redactText = s => String(s)
  .replace(/\b[A-Z]{1,6}\d{6}[CP]\d{8}\b/g, '\u2022')                       // option contract symbols
  .replace(/\$?\d[\d,]*(\.\d+)?/g, '\u2022')                                  // amounts, prices, quantities
  .replace(/\b[A-Z][A-Z.]{0,5}\b/g, w => KEEP.has(w) ? w : '\u2022');          // tickers
export const redact = s => PRIVATE ? redactText(s) : String(s);
if (PRIVATE && !globalThis.__sdLogWrapped) {                                   // every console line in privacy mode goes through the redactor,
  globalThis.__sdLogWrapped = true; const out = console.log.bind(console);     // including error messages that quote a symbol
  console.log = (...a) => out(redactText(a.map(x => typeof x === 'string' ? x : (x && x.message) || JSON.stringify(x)).join(' ')));
}
const DATA = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';
const DRY = process.env.BOT_DRY === '1';
// Read-only run (journal-refresh workflow): read the account and rewrite the journal; never place, change or cancel an order,
// even when started while the market is open or while bot/STOP is set (the trading session acts on those).
const READONLY = process.env.BOT_READONLY === '1';
// Session hand-off (live.mjs sets the time this session ends): a session that ends before the close opens nothing new in
// its last 10 minutes, so no fresh trade is left unwatched while the next session starts up. Open positions are managed.
let SESSION_END = 0;
export const setSessionEnd = ms => { SESSION_END = +ms || 0; };
const sessionEnding = () => SESSION_END > 0 && Date.now() >= SESSION_END - 10 * 60000;
// When a session ends (live.mjs). One born between 6:00 and 9:25 ET — the early start that waits for the open, or the 9:20
// schedule — hands over to a fresh session at 9:25 instead of running its whole life: the fresh one's 345 minutes then last
// to about 3:10 PM, so the day's one mid-session hand-off (10 minutes without new trades) falls after the SPY window (until
// 3:00 PM) and not around noon, where on 2026-10-29 it took the day's only clean SPY setup (12:00). Others run their life.
export const HANDOVER_MIN = 9 * 60 + 25;
export function sessionEndFor(bornMs, lifeMs) {
  const p = etParts(new Date(bornMs)), s = ((+p.hour % 24) * 60 + +p.minute) * 60 + new Date(bornMs).getUTCSeconds();   // ET offsets are whole hours
  return s >= 6 * 3600 && s < HANDOVER_MIN * 60 ? bornMs + (HANDOVER_MIN * 60 - s) * 1000 : bornMs + lifeMs;
}
// The page's Pause: bot/STOP in the repo, mirrored by a running session to bot/STOP.local (git-ignored, so publishing the
// journal never has to delete it to pull, and a failed pull can never drop it).
export const STOP_FILES = ['bot/STOP', 'bot/STOP.local'];
const stopSet = () => STOP_FILES.some(f => fs.existsSync(f));
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
// Has the cache the SPY bar that completed at the last 5-minute mark? The bars endpoint publishes a bar 2–3 seconds after it
// ends, so a read made right after the mark often lacks it: the SPY signal (and the study) must see that bar.
const spyLatestIn = () => { const B = barsCache5.day === TODAY && barsCache5.bars ? barsCache5.bars.SPY || [] : [], lastDone = Math.floor(MINS / 5) * 5 - 5; return B.length > 0 && (lastDone < SESSION_OPEN || B.some(b => b.m >= lastDone)); };
// Today's SPY 5-minute bars from the cache, only when they hold the bar that completed at the last 5-minute mark (else null).
function spyBarsNow() { return spyLatestIn() ? barsCache5.bars.SPY : null; }
async function load5m(syms) {
  const want = [...new Set(syms.concat(['SPY']))];
  // kept 55 s; while the SPY bar that completed at the last 5-minute mark is missing, read again every 3 seconds until it is in
  const maxAge = spyLatestIn() ? 55000 : 3000;
  if (barsCache5.bars && barsCache5.day === TODAY && Date.now() - barsCache5.at < maxAge && want.every(x => x in barsCache5.bars)) return barsCache5.bars;
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
  const { equity, acct, positions, hist, liveOrders, G, capHit, slBudget, sellsFor, cid } = ctx, halt = ctx.halt || { stock: capHit, call: capHit, put: capHit }, skip = ctx.skip || new Set();   // skip: the wheel's stocks
  const dayC = { start: hhmm(CFG.dayStart), end: Math.min(hhmm(CFG.dayEnd), CLOSE - 30), rvol: CFG.dayRvol, target: CFG.dayTarget, timeStop: CFG.dayTimeStop, orMin: CFG.dayOrMin };
  // open day trades: entry order id tells us side, stop, target and when it opened
  const dayPos = [];
  for (const p of positions) {
    // the latest of the bot's own buys of this symbol decides who manages it: an old day-trade id never captures a later
    // swing position, and a day trade still open from an earlier day (its session died before 3:50 PM) is closed now
    const last = latestBuy(hist, o => o.symbol === p.symbol && /^sd-/.test(cid(o)));
    if (!last || !/^sd-d[cp]?-/.test(cid(last))) continue;
    const q = ownQty(p, last, hist); if (!(q > 0)) continue;
    if (!cid(last).includes('-' + TODAY + '-')) {
      const sells = sellsFor(p.symbol); if (sells.some(o => o.type === 'market')) continue;
      await closeOut(p.symbol, q, sells, `${p.symbol} day trade bought on an earlier day and still open — closing (day trades never stay overnight)`);
      continue;
    }
    const d = decodeDayId(cid(last)); if (!d) continue;
    dayPos.push({ p, e: last, d, q, und: isOpt(p.symbol) ? OPT_RE.exec(p.symbol)[1] : p.symbol, opt: isOpt(p.symbol) });
  }
  if (!CFG.dayTrade && !dayPos.length) { lastDay = null; return; }
  const todayIds = hist.filter(o => o.side === 'buy' && /^sd-d[cp]?-/.test(cid(o)) && cid(o).includes('-' + TODAY + '-') && (bought(o) || !['canceled', 'expired', 'rejected'].includes(o.status)));   // a cancelled buy that filled in part still counts
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
  for (const { p, d, q, und, opt } of dayPos) {
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
    const out = async why => { const r = await closeOut(p.symbol, q, sells, why); if (r !== 'refused') delete dayState[p.symbol]; };   // keep the trail state if the sale was refused
    const plpc = +p.unrealized_plpc * 100;
    if (opt) {
      if (plpc >= CFG.dayOptTp) { await out(`${p.symbol} day trade +${plpc.toFixed(0)}% — option take-profit`); continue; }
      if (plpc <= -CFG.dayOptStop) { await out(`${p.symbol} day trade ${plpc.toFixed(0)}% — option stop`); continue; }
      if (MINS >= CLOSE - 15) { await out(`${p.symbol} day trade — options flat 15 minutes before the close`); continue; }
    }
    const x = dayExit({ pos, px, mins: MINS, cfg: { ...dayC, flat: (dayC.flat || 950) - EARLY() } });
    if (x && (x.kind === 'stop' || x.kind === 'target') && !opt && stopLeg) continue;      // the broker's own legs handle these; the bot only steps in where no leg exists
    if (x) { await out(`${p.symbol} day trade ${x.kind === 'flat' ? 'closed' : 'exit'} — ${x.why} (${plpc >= 0 ? '+' : ''}${plpc.toFixed(1)}%)`); continue; }
    if (!opt && !sells.length) await send({ symbol: p.symbol, qty: String(q), side: 'sell', type: 'limit', limit_price: String(tick(d.target)), time_in_force: 'day', client_order_id: 'sd-x-' + p.symbol + '-' + rid() }, `${p.symbol} day trade — take-profit order at ${d.target}`);
  }

  // ---- new day trades ----
  const dayClosed = (fillsCache.closed || []).filter(c => c.inT && c.outT && c.inT.slice(0, 10) === c.outT.slice(0, 10) && !c.wheel);
  let streak = 0; for (const c of [...dayClosed].sort((a, b) => a.outT < b.outT ? 1 : -1)) { if (c.pl < 0) streak++; else break; }
  const pdtBlock = equity < 25000 && +acct.daytrade_count >= 3 && !acct.pattern_day_trader;
  const idle = !CFG.dayTrade ? 'day trading is off' : capHit ? 'daily loss limits hit' : userPause ? 'paused from Telegram' : G.block ? 'paused by the market check' : noNew ? noNew : pdtBlock ? 'pattern-day-trader limit (account under $25k)' : tradesToday >= CFG.dayMaxTrades ? `${tradesToday} day trades today — daily maximum reached` : streak >= CFG.dayStreak ? `${streak} day-trade losses in a row — done for the day` : MINS < dayC.start ? 'before the day-trade window' : MINS >= dayC.end ? 'day-trade window closed' : market === 'flat' ? 'market undecided (SPY on its VWAP) — waiting' : null;
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
    if (sg.held || skip.has(sg.sym) || laneRecent('day:' + sg.sym) || positions.some(p => (isOpt(p.symbol) ? OPT_RE.exec(p.symbol)[1] : p.symbol) === sg.sym) || liveOrders.some(o => (isOpt(o.symbol) ? OPT_RE.exec(o.symbol)[1] : o.symbol) === sg.sym)) continue;
    if (CFG.newsGuard && symbolRisk(sg.sym, newsCache.syms)) { act(`${sg.sym} day setup skipped — ${symbolRisk(sg.sym, newsCache.syms)}`); continue; }
    const label = `${sg.sym} day trade: ${sg.setup} ${sg.side === 'long' ? 'long' : 'short'} — ${sg.why}; stop ${sg.stop}, target ${sg.target}`;
    if (sg.side === 'long' && CFG.dayStock && !halt.stock) {
      const lim = r2d(sg.entry * 1.001), qty = dayShares({ equity, riskPct: CFG.dayRiskPct, entry: lim, stop: sg.stop, budget: slBudget('stock') });
      if (qty < 1) { act(`${sg.sym} day setup skipped — 1 share is above the risk or money budget`); continue; }
      await send({ symbol: sg.sym, qty: String(qty), side: 'buy', type: 'limit', limit_price: String(lim), time_in_force: 'day',
        order_class: 'bracket', take_profit: { limit_price: String(tick(sg.target)) }, stop_loss: { stop_price: String(tick(sg.stop)) },
        client_order_id: encodeDayId('sd-d-', sg.sym, sg.entry, sg.stop, sg.target, TODAY, MINS, rid()) }, label + ' · stop and target placed at the broker');
      if (ctx.useSL) ctx.useSL('stock', qty * lim);                            // the next entry this check sees the money as spent
      laneSent.set('day:' + sg.sym, Date.now()); placed++; continue;
    }
    if ((sg.side === 'long' && CFG.dayCalls && !halt.call) || (sg.side === 'short' && CFG.dayPuts && !halt.put)) {
      const kind = sg.side === 'long' ? 'call' : 'put', c = await pickDayContract(sg.sym, kind, sg.entry); if (!c) { act(`${sg.sym} ${kind.toUpperCase()}: no liquid contract 1–${CFG.dayOptDteMax} days out — skipped`); continue; }
      const qty = Math.max(0, Math.min(Math.floor(slBudget(kind) / (c.lim * 100)), Math.floor(equity * CFG.dayRiskPct * (G.budget || 1) / 100 / (c.lim * 100 * CFG.dayOptStop / 100))));
      if (qty < 1) { act(`${c.symbol}: 1 contract ($${Math.round(c.lim * 100)}) is above the day-trade risk or money budget — skipped`); continue; }
      await send({ symbol: c.symbol, qty: String(qty), side: 'buy', type: 'limit', limit_price: String(c.lim), time_in_force: 'day', client_order_id: encodeDayId(kind === 'put' ? 'sd-dp-' : 'sd-dc-', c.symbol, sg.entry, sg.stop, sg.target, TODAY, MINS, rid()) }, label.replace('day trade:', `day trade ${kind.toUpperCase()}:`));
      dayState[c.symbol] = { stop: sg.stop };
      if (ctx.useSL) ctx.useSL(kind, qty * c.lim * 100);
      laneSent.set('day:' + sg.sym, Date.now()); placed++;
    }
  }
  lastDay = { at: new Date().toISOString(), on: CFG.dayTrade, market, spyVwap: bars5.SPY && bars5.SPY.length ? r2d(vwapOf(bars5.SPY)) : null, tradesToday: tradesToday + placed, max: CFG.dayMaxTrades, streak, idle,
    window: `${CFG.dayStart}–${CFG.dayEnd} ET, flat by ${EARLY() ? mmhh(CLOSE - 10) + ' (early close today)' : '3:50 PM'}`,
    setups: setups.slice(0, 12).map(x => ({ sym: x.sym, setup: x.setup, side: x.side, entry: x.entry, stop: x.stop, target: x.target, rvol: x.rvol, why: x.why, held: x.held })),
    open: dayPos.map(({ p, d, und, opt }) => ({ s: p.symbol, und, kind: opt ? (d.kind === 'dp' ? 'put' : 'call') : 'stock', side: d.side, qty: Math.abs(+p.qty), avg: r2d(+p.avg_entry_price * (opt ? 100 : 1)), cur: r2d(+p.current_price * (opt ? 100 : 1)), pl: r2d(+p.unrealized_pl), plpc: Math.round(+p.unrealized_plpc * 1000) / 10, undPx: last[und] && last[und].p, stop: (dayState[p.symbol] || {}).stop || d.stop, target: d.target, opened: d.openMins })) };
}
// ---- SPY quick options sleeve (rules in bot/spyopt.mjs) ----
let spyState = {}, spyCapHit = false;                                   // spyState: per open symbol, the take-profit order placed for which buy { key, at }; spyCapHit: today's SPY money limit was passed (closes what is open)
const spySelling = new Set();                                            // symbols a lane is selling right now (60 s): the other lanes keep their hands off
// Exits on the open SPY option: take-profit (resting at the broker), stop, time stop, 3:45 flat, or the sleeve's halt.
// Called from the full cycle and, while a trade is open, from the 1-second fast lane (spyFast) so a stop reacts within ~1 s.
// open: [{ p: position, e: its buy order (or null in the fast lane), d: decoded id, q: the bot's own quantity, key: buy id }]
async function spyManage({ open, sellsFor, halt }) {
  for (const { p, e, d, q, key } of open) {
    if (spySelling.has(p.symbol)) continue;                                                      // another lane is already selling it
    const sells = sellsFor(p.symbol); if (sells.some(o => o.type === 'market')) continue;
    const qty = q > 0 ? Math.min(q, Math.abs(+p.qty)) : Math.abs(+p.qty), avg = +p.avg_entry_price, entry = avg > 0 ? avg : (d ? d.entry : avg);   // the fill price is the truth; the id's limit is the fallback
    const openedMins = d ? d.openMins : (e && e.filled_at ? etMinsOf(e.filled_at) : null);
    const out = async why => {
      spySelling.add(p.symbol); setTimeout(() => spySelling.delete(p.symbol), 60000);
      try { const r = await closeOut(p.symbol, qty, sells, `${p.symbol} SPY ${d ? d.kind.toUpperCase() : 'option'} ${why}`); if (r === 'refused') { spySelling.delete(p.symbol); return; } delete spyState[p.symbol]; }   // refused: let the next check try again at once
      catch (err) { spySelling.delete(p.symbol); act('SPY exit failed: ' + String(err.message || err).slice(0, 80)); }
    };
    if (d && d.day8 && d.day8 < TODAY) { await out(`— bought on ${dash8(d.day8)} and still open; SPY quick trades never stay overnight — closing`); continue; }   // the session that should have closed it at 3:45 died
    const x = spyExit({ entryPx: entry, optPx: +p.current_price, openedMins, mins: MINS, cfg: { ...CFG, spyFlat: CFG.spyFlat - EARLY() } });
    const tpPx = tickUp(entry * (1 + CFG.spyTp / 100), p.symbol);
    if (x && x.kind === 'tp' && sells.some(o => o.type === 'limit' && +o.limit_price <= tpPx + Math.max(0.015, entry * 0.005))) continue;   // the resting take-profit at today's setting (give or take rounding) handles it; one left at an older, higher setting does not make the trade wait (sold at market)
    if (x) { await out(x.why); continue; }
    if (halt.spy && spyCapHit) { await out(`— ${halt.spy}; closing`); continue; }   // the daily money limit closes what is open; a losing streak only stops new trades
    // resting take-profit, placed once per buy: remembered by the buy's id (a later trade in the same contract gets its own),
    // and placed again if it is gone after 2 minutes (cancelled or expired); a refused one is tried again after a minute
    const st = spyState[p.symbol], fresh = st && st.key === (key || '') && Date.now() - st.at < 120000;
    const part = sells.find(o => o.type === 'limit' && /^sd-x-/.test(cidOf(o)) && (+o.qty || 0) - (+o.filled_qty || 0) < qty - 1e-9);
    if (part && !tpCancelled.has(part.id)) {                                                // placed while the buy was still filling: replaced by one for the whole trade
      tpCancelled.add(part.id); act(`${p.symbol} SPY take-profit order covers only part of the trade — cancelled; a new one for all ${qty} follows`);
      if (!DRY) await T('/v2/orders/' + part.id, { method: 'DELETE' }).catch(() => {}); spyState[p.symbol] = { key: key || '', at: 0 }; continue;
    }
    if (!sells.length && !fresh) {
      spyState[p.symbol] = { key: key || '', at: Date.now() };
      const tpOk = await send({ symbol: p.symbol, qty: String(qty), side: 'sell', type: 'limit', limit_price: String(tpPx), time_in_force: 'day', client_order_id: 'sd-x-' + p.symbol + '-' + rid() }, `${p.symbol} SPY option — take-profit order at +${CFG.spyTp}%`);
      const st2 = spyState[p.symbol]; if (tpOk === 'refused' && st2 && st2.key === (key || '')) st2.at = Date.now() - 60000;   // (another lane may have sold it and cleared the state meanwhile)
    }
  }
}
// Fast lane (live.mjs, every second while a SPY trade is open): two broker calls, then the same exit rules. Nothing else.
export const spyHasOpen = () => !!(lastSpy && lastSpy.open && lastSpy.open.length);
export async function spyFast() {
  if (!spyHasOpen() || !HAVE_KEYS) return;
  setNow();
  const [positions, openOrders] = await Promise.all([T('/v2/positions'), T('/v2/orders?status=open&limit=200')]);
  const open = positions.filter(p => isSpyOption(p.symbol) && lastSpy.open.some(o => o.s === p.symbol)).map(p => { const row = lastSpy.open.find(o => o.s === p.symbol); return { p, e: null, d: decodeSpyId(row.id || '') || { kind: row.kind, entry: row.entry, openMins: row.opened }, q: row.own > 0 ? row.own : Math.abs(+p.qty), key: row.id || '' }; });   // the sleeve's own trades only
  const sellsFor = sym => openOrders.filter(o => o.symbol === sym && o.side === 'sell');
  await spyManage({ open, sellsFor, halt: { spy: lastSpy.halted } });
  const pendingBuy = openOrders.some(o => o.side === 'buy' && isSpyOption(o.symbol));
  spyHeld = new Set(positions.filter(p => isSpyOption(p.symbol)).map(p => p.symbol).concat(openOrders.filter(o => o.side === 'buy' && isSpyOption(o.symbol)).map(o => o.symbol)));
  for (const x of open) { const row = lastSpy.open.find(o => o.s === x.p.symbol); if (row) { row.pending = false; row.qty = Math.min(Math.abs(+x.p.qty), row.own > 0 ? row.own : Infinity); row.entry = +x.p.avg_entry_price || row.entry; } }
  if (!pendingBuy && Date.now() - spyPlacedAt > 10000) { lastSpy.open = lastSpy.open.filter(o => o.pending ? false : open.some(x => x.p.symbol === o.s)); spyPendingUntil = 0; }   // sold ones drop out; a filled buy frees the next entry (a just-placed order may not be listed yet)
}
// What the fast lane needs from the stream: while the sleeve is watching, the level a SPY tick must cross to wake a full cycle.
// Only while the last completed 5-minute bar has armed the break (closed in its direction on at least average volume) —
// the same condition the full check and the study ask for.
export const spyWatch = () => lastSpy && lastSpy.on && lastSpy.armed && !lastSpy.halted && !lastSpy.blocked && !sessionEnding() && (lastSpy.open || []).length < (lastSpy.maxOpen || 1) && !(lastSpy.open || []).some(o => o.pending) && (lastSpy.tradesToday || 0) < (lastSpy.max || 0) && lastSpy.level && lastSpy.market && lastSpy.market !== 'flat' && spyFresh(lastSpy.market === 'up' ? 'call' : 'put', lastSpy.level, spyLvl(lastSpy.market === 'up' ? 'call' : 'put')) && !/maximum|paused|limit|off|closed|before|session/.test(lastSpy.idle || '') ? { level: lastSpy.level, market: lastSpy.market } : null;
// the level each direction's last trade today was taken at (a new trade in that direction needs a fresh break beyond it)
let spyLevels = { day: '', call: 0, put: 0 };
let spyHeld = new Set();                                                 // every SPY option held or being bought (the sleeve's and any bought by hand), from the latest account picture
const spyLvl = k => spyLevels.day === TODAY ? spyLevels[k] || 0 : 0;
// The SPY entry window for today: no new trade in the last 30 minutes before an early close.
const spyCfgToday = () => ({ ...CFG, spyEnd: EARLY() ? mmhh(Math.min(hhmmMin(CFG.spyEnd), CLOSE - 30)) : CFG.spyEnd });
async function spyCycle(ctx) {
  const { equity, acct, positions, hist, liveOrders, G, halt, SIDE, sellsFor, cid, snapAt = 0 } = ctx;
  // the sleeve's own trades only — never touch a SPY option bought by hand (nor the part of one bought by hand)
  const open = positions.filter(p => isSpyOption(p.symbol)).map(p => { const e = latestBuy(hist, o => o.symbol === p.symbol && /^sd-y[cp]-/.test(cid(o))); return { p, e, d: e ? decodeSpyId(cid(e)) : null, q: ownQty(p, e, hist), key: e ? cid(e) : '' }; }).filter(x => x.d && x.q > 0);
  const todayIds = hist.filter(o => o.side === 'buy' && /^sd-y[cp]-/.test(cid(o)) && cid(o).includes('-' + TODAY + '-') && (bought(o) || !['canceled', 'expired', 'rejected'].includes(o.status)));   // a cancelled buy that filled in part still counts
  const tradesToday = todayIds.length;
  // unfilled entries older than 3 minutes have missed their moment; with the sleeve switched off, a working buy goes at once
  for (const o of liveOrders) if (o.side === 'buy' && /^sd-y[cp]-/.test(cid(o)) && (!CFG.spyOn || Date.now() - Date.parse(o.submitted_at || o.created_at || Date.now()) > 3 * 60000)) {
    act(`${o.symbol} SPY option buy at ${o.limit_price} ${CFG.spyOn ? 'unfilled for 3 min' : 'still working while SPY quick trades are switched off'} — cancelled`); if (!DRY) await T('/v2/orders/' + o.id, { method: 'DELETE' }).catch(() => {}); o._cancelled = true;
  }
  if (!CFG.spyOn && !open.length) { lastSpy = { at: new Date().toISOString(), on: false, money: 0, used: 0, today: null, halted: null, idle: 'switched off', tradesToday, max: CFG.spyMaxTrades, open: [] }; return; }
  const live = liveOrders.filter(o => !o._cancelled);
  await spyManage({ open, sellsFor, halt });
  // A SPY buy placed after this cycle's account picture was taken (by the live tick) is not in that picture: rebuilding
  // the sleeve's state from it would forget that order and its money. Keep the live state and decide again next cycle.
  const bars5 = await load5m([]), spyBars = bars5.SPY || [], px = ((await latestPrices(['SPY'])).SPY || {}).p;
  const sig = CFG.spyOn ? spySignal({ bars: spyBars, px, mins: MINS, cfg: spyCfgToday() }) : null;   // no new SPY trades in the last 30 minutes of an early-close day
  const dayClosed = (fillsCache.closed || []).filter(c => isSpyOption(c.sym) && c.outT && c.outT.slice(0, 10) === ymdDash(Date.now()));
  const pdtBlock = equity < 25000 && +acct.daytrade_count >= 3 && !acct.pattern_day_trader;
  const pending = live.some(o => o.side === 'buy' && /^sd-y[cp]-/.test(cid(o)));
  spyHeld = new Set(positions.filter(p => isSpyOption(p.symbol)).map(p => p.symbol).concat(live.filter(o => o.side === 'buy' && isSpyOption(o.symbol)).map(o => o.symbol)));
  if (spyPlacedAt && spyPlacedAt >= snapAt - 10000 && lastSpy) { lastSpy.at = new Date().toISOString(); return; }
  if (!pending) spyPendingUntil = 0;                                                             // the last buy (placed well before this picture) has filled or was cancelled: the next entry may go
  const maxOpen = CFG.spyMaxOpen || 1, tradeMoney = SIDE.spy.money * CFG.spyTradePct / 100, free = SIDE.spy.money - SL_used(positions, live);
  const stale = sig && sig.side && !spyFresh(sig.side, sig.level, spyLvl(sig.side));
  const idle = !CFG.spyOn ? 'switched off' : halt.spy ? halt.spy : userPause ? 'paused from Telegram' : G.block ? 'paused by the market check' : noNew ? noNew : pdtBlock ? 'pattern-day-trader limit (account under $25k)' : tradesToday >= CFG.spyMaxTrades ? `${tradesToday} SPY trades today — daily maximum reached` : pending ? 'buy order working' : open.length >= maxOpen ? (maxOpen > 1 ? `${open.length} SPY trades open — the most at once` : 'in a trade') : open.length && free < tradeMoney * 0.5 ? 'all of the SPY money is in trades' : sig && sig.idle ? sig.idle : !sig ? 'waiting for SPY bars' : sig.side && !spyLatestIn() ? 'waiting for the 5-minute bar that just closed' : stale ? `waiting for a new break (last ${sig.side.toUpperCase()} at ${spyLvl(sig.side)})` : null;
  const r0 = x => Math.round(x);
  const openRows = open.map(({ p, d, e, q }) => ({ s: p.symbol, id: e ? cid(e) : '', entry: +p.avg_entry_price || (d ? d.entry : 0), pending: false, kind: d ? d.kind : 'call', qty: q, own: q, avg: r2d(+p.avg_entry_price * 100), cur: r2d(+p.current_price * 100), pl: r2d(+p.unrealized_pl), plpc: Math.round(+p.unrealized_plpc * 1000) / 10, opened: d ? d.openMins : (e && e.filled_at ? etMinsOf(e.filled_at) : null), tp: r2d((d ? d.entry : +p.avg_entry_price) * (1 + CFG.spyTp / 100) * 100), stop: r2d((d ? d.entry : +p.avg_entry_price) * (1 - CFG.spyStop / 100) * 100) }));
  const keepPending = lastSpy && lastSpy.open ? lastSpy.open.filter(o => o.pending && live.some(l => l.symbol === o.s && l.side === 'buy')) : [];
  lastSpy = { at: new Date().toISOString(), on: !!CFG.spyOn, budget: G.budget || 1, money: r0(SIDE.spy.money), used: r0(SL_used(positions, live)), today: SIDE.spy.today ?? null, halted: halt.spy, idle, blocked: !!(pending || open.length >= maxOpen || (open.length && free < tradeMoney * 0.5)), maxOpen, tradesToday, max: CFG.spyMaxTrades, market: sig && sig.market || null, vwap: sig && sig.vwap || null, level: sig && sig.level || null, armed: !!(sig && sig.armed), spyPx: px || null,
    window: `${CFG.spyStart}–${CFG.spyEnd} ET, flat by ${EARLY() ? mmhh(CLOSE - 15) + ' (early close today)' : '3:45 PM'}`, open: openRows.concat(keepPending), closed: dayClosed.length, closedPl: r2d(dayClosed.reduce((t, c) => t + c.pl, 0)), rules: { tp: CFG.spyTp, stop: CFG.spyStop, holdMin: CFG.spyHoldMin, dte: CFG.spyDte, tradePct: CFG.spyTradePct, maxOpen } };
  if (idle || !sig || !sig.side || Date.now() < spyPendingUntil || spyEntering || spyPlacedAt >= snapAt) return;   // a tick bought while this cycle was working: decide again next cycle
  await spyPlace(sig.side, px, sig.why, Math.min(tradeMoney, free) * (G.budget || 1), sig.level);   // one trade: its % of the SPY money, never more than is free
}
// Places the SPY option order (contract → quote → limit buy). Shared by the full cycle and the tick-driven spyEnter.
let spyPendingUntil = 0, spyEntering = false;
async function spyPlace(kind, px, why, budget, level) {
  if (spyEntering) return null; spyEntering = true;
  try { return await spyPlaceInner(kind, px, why, budget, level); } finally { spyEntering = false; }
}
// B14: expiry window in trading days (weekends skipped), so a Thursday or Friday trade still finds a next-session contract
const addTradingDays = (ms, n) => { let d = new Date(ms); while (n > 0) { d = new Date(d.getTime() + 864e5); const wd = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay(); if (wd !== 0 && wd !== 6) n--; } return d; };
async function spyPlaceInner(kind, px, why, budget, level) {
  // the window reaches one trading day further than spyDte: the earliest expiry in it is taken, so on a normal day nothing
  // changes, and on the day before a market holiday (no expiry on the holiday) the next expiry after it is found
  const from = addTradingDays(Date.now(), 1), to = addTradingDays(Date.now(), CFG.spyDte + 1);
  const cj = await T(`/v2/options/contracts?underlying_symbols=SPY&type=${kind}&status=active&expiration_date_gte=${ymdDash(+from)}&expiration_date_lte=${ymdDash(+to)}&strike_price_gte=${r2d(px * 0.99)}&strike_price_lte=${r2d(px * 1.01)}&limit=200`).catch(() => ({}));
  const cs = (cj.option_contracts || []).filter(c => c.tradable !== false); if (!cs.length) { act(`SPY ${kind.toUpperCase()}: no contract 1\u2013${CFG.spyDte + 1} trading days out near ${px} \u2014 skipped`); return null; }
  const ex = [...new Set(cs.map(c => c.expiration_date))].sort()[0];
  const mine = new Set([...(lastSpy && lastSpy.open || []).map(o => o.s), ...spyHeld]);       // a new trade is its own contract: never one already held (by the bot or by hand) or being bought
  const c = cs.filter(x => x.expiration_date === ex && !mine.has(x.symbol)).sort((a, b) => Math.abs(+a.strike_price - px) - Math.abs(+b.strike_price - px))[0];
  if (!c) { act(`SPY ${kind.toUpperCase()}: every nearby contract is already one of its open trades \u2014 skipped`); return null; }
  const q = ((await D(`/v1beta1/options/quotes/latest?symbols=${c.symbol}&feed=indicative`).catch(() => ({}))).quotes || {})[c.symbol];
  if (!q || !(q.ap > 0) || !(q.bp > 0)) { act(`${c.symbol}: no live quote \u2014 skipped`); return null; }
  if ((q.ap - q.bp) / q.ap > 0.05) { act(`${c.symbol}: spread too wide (${q.bp}/${q.ap}, over 5%) \u2014 skipped`); return null; }
  const lim = tick(Math.min(q.ap, (q.ap + q.bp) / 2 * 1.02), c.symbol), qty = Math.floor(Math.max(0, budget) / (lim * 100));
  if (qty < 1) { act(`${c.symbol}: 1 contract ($${Math.round(lim * 100)}) is above this trade's SPY money ($${Math.round(budget)}, ${CFG.spyTradePct}% of the SPY share) \u2014 skipped`); return null; }
  const id = encodeSpyId(kind, c.symbol, lim, TODAY, MINS, rid());
  const placedOrder = await send({ symbol: c.symbol, qty: String(qty), side: 'buy', type: 'limit', limit_price: String(lim), time_in_force: 'day', client_order_id: id },
    `SPY ${kind.toUpperCase()} quick trade: ${why} \u00b7 out at +${CFG.spyTp}% / \u2212${CFG.spyStop}% or after ${CFG.spyHoldMin} min`);
  if (!placedOrder) return null;                                                                   // suppressed as a duplicate: nothing went out, so nothing to remember
  spyPendingUntil = Date.now() + 3 * 60000; spyPlacedAt = Date.now();                                                     // no second entry until this one has filled or been cancelled
  if (spyLevels.day !== TODAY) spyLevels = { day: TODAY, call: 0, put: 0 }; if (level > 0) spyLevels[kind] = level;   // this break is used up
  if (lastSpy) { lastSpy.idle = 'buy order working'; lastSpy.blocked = true; lastSpy.used = (lastSpy.used || 0) + qty * lim * 100; lastSpy.tradesToday = (lastSpy.tradesToday || 0) + 1; lastSpy.open = (lastSpy.open || []).concat([{ s: c.symbol, id, entry: lim, kind, qty, opened: MINS, avg: r2d(lim * 100), cur: r2d(lim * 100), pl: 0, plpc: 0, tp: r2d(lim * (1 + CFG.spyTp / 100) * 100), stop: r2d(lim * (1 - CFG.spyStop / 100) * 100), pending: true }]); }
  return c.symbol;
}
// Tick-driven entry (live.mjs → onTick for SPY): the streamed price crossed the level the last full check was waiting for.
// Everything else (window, brakes, one-at-a-time) was decided by that check seconds ago and is re-read from lastSpy.
export async function spyEnter(px) {
  const w = spyWatch(); if (!w || spyEntering || !HAVE_KEYS || Date.now() < spyPendingUntil || !lastSpy || Date.now() - Date.parse(lastSpy.at) > 90000) return false;
  if (!((w.market === 'up' && px > w.level) || (w.market === 'down' && px < w.level))) return false;
  setNow();
  // the same signal the full check uses (and the study tested), on this tick's price: the 15-minute break, SPY on the right
  // side of its VWAP, and the last completed 5-minute bar closed in that direction on at least average volume. The bars must
  // include the bar that completed at the last 5-minute mark; until they do, the next full check decides.
  const bars = spyBarsNow(); if (!bars) return false;
  const sig = spySignal({ bars, px, mins: MINS, cfg: spyCfgToday() });
  if (!sig || !sig.side || !spyFresh(sig.side, sig.level, spyLvl(sig.side))) return false;
  const kind = sig.side;
  const sym = await spyPlace(kind, px, `${sig.why} (live tick)`, Math.min(lastSpy.money * (CFG.spyTradePct ?? 100) / 100, lastSpy.money - (lastSpy.used || 0)) * (lastSpy.budget || 1), sig.level);
  return !!sym;
}
const hhmmMin = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
const mmhh = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
// Quote-driven exit (live.mjs → options stream): the open option's own bid/ask just changed. Stop, time stop and flat are
// decided here from the mid price; the take-profit is the resting limit order at the broker. One sell per position.
export async function spyOnQuote(sym, bp, ap) {
  if (!lastSpy || !lastSpy.open || !lastSpy.open.length || !(bp > 0) || !(ap > 0)) return;
  const row = lastSpy.open.find(o => o.s === sym); if (!row || row.pending || spySelling.has(sym)) return;
  const mid = (bp + ap) / 2; setNow();
  row.cur = r2d(mid * 100); row.pl = r2d((mid - row.entry) * 100 * (row.qty || 0)); row.plpc = Math.round((mid / row.entry - 1) * 1000) / 10;
  const x = spyExit({ entryPx: row.entry, optPx: mid, openedMins: row.opened, mins: MINS, cfg: { ...CFG, spyFlat: CFG.spyFlat - EARLY() } });
  if (!x || x.kind === 'tp') return;
  spySelling.add(sym); setTimeout(() => spySelling.delete(sym), 60000);
  try {
    const pos = await T('/v2/positions/' + encodeURIComponent(sym), QUICK).catch(e => (e && e.status === 404 ? null : undefined));   // already sold (e.g. the take-profit filled)? then there is nothing to sell
    if (pos === null || (pos && !(Math.abs(+pos.qty) > 0))) { lastSpy.open = lastSpy.open.filter(o => o.s !== sym); return; }
    if (pos) row.qty = Math.min(Math.abs(+pos.qty), row.own > 0 ? row.own : Infinity);            // a timeout keeps the known quantity; closeOut re-checks; never more than the bot's own part
    const openOrders = await T('/v2/orders?status=open&limit=200');
    const r = await closeOut(sym, row.qty, openOrders.filter(o => o.symbol === sym && o.side === 'sell'), `${sym} SPY ${row.kind.toUpperCase()} ${x.why} (live quote)`);
    if (r === 'refused') { spySelling.delete(sym); return; }
    delete spyState[sym];
  } catch (e) { spySelling.delete(sym); act('SPY quote exit failed: ' + String(e.message || e).slice(0, 80)); }   // free it at once: the next quote or check tries again
}
export const spyOpenSymbols = () => lastSpy && lastSpy.open ? lastSpy.open.filter(o => !o.pending).map(o => o.s) : [];
const SL_used = (positions, live) => positions.filter(p => isSpyOption(p.symbol)).reduce((t, p) => t + Math.abs(+p.market_value || 0), 0) + live.filter(o => o.side === 'buy' && isSpyOption(o.symbol)).reduce((t, o) => t + (+o.qty || 0) * (+o.limit_price || 0) * 100, 0);
const vwapOf = bars => { let pv = 0, vv = 0; for (const b of bars) { pv += (b.h + b.l + b.c) / 3 * (b.v || 0); vv += b.v || 0; } return vv ? pv / vv : bars[bars.length - 1].c; };
// Nearest-the-money contract expiring 1–N trading days out, with a tight enough market.
async function pickDayContract(und, kind, px) {
  const from = new Date(Date.now() + 864e5), to = new Date(Date.now() + CFG.dayOptDteMax * 864e5);
  const cj = await T(`/v2/options/contracts?underlying_symbols=${und}&type=${kind}&status=active&expiration_date_gte=${ymdDash(+from)}&expiration_date_lte=${ymdDash(+to)}&strike_price_gte=${r2d(px * 0.96)}&strike_price_lte=${r2d(px * 1.04)}&limit=200`).catch(() => ({}));
  const cs = (cj.option_contracts || []).filter(c => c.tradable !== false); if (!cs.length) return null;
  const ex = [...new Set(cs.map(c => c.expiration_date))].sort()[0];
  const c = cs.filter(x => x.expiration_date === ex).sort((a, b) => Math.abs(+a.strike_price - px) - Math.abs(+b.strike_price - px))[0];
  const q = ((await D(`/v1beta1/options/quotes/latest?symbols=${c.symbol}&feed=indicative`).catch(() => ({}))).quotes || {})[c.symbol];
  if (!q || !(q.ap > 0) || !(q.bp > 0) || (q.ap - q.bp) / q.ap > 0.1) return null;                 // day trades need a spread under 10%
  return { symbol: c.symbol, lim: tick(Math.min(q.ap, (q.ap + q.bp) / 2 * 1.02), c.symbol), exp: ex, strike: +c.strike_price };
}
export const scanInfo = () => scanCache.info;
// ---- the wheel: cash-secured puts and covered calls (rules in bot/wheel.mjs, tested by tools/wheel-study.mjs) ----
// Its own share of the stake (wheelSharePct, off the top of the stock share like SPY). The bookkeeping (wheelReconcile) runs
// on every check from the broker's picture; orders go out at most every 20 seconds: the take-profit buy-back of each sold
// option at any time, new puts and covered calls only in the first three trading days after a monthly expiration. Switched
// off it sells nothing new and cancels its working sales; what is open keeps its take-profit and runs to expiry. The other
// parts leave its stocks alone, and none of them ever sells one of its options (a sale would add to a sold option).
let wheelMem = { opts: {}, shares: {}, done: {} }, lastWheel = null, wheelAt = 0, wheelDaysCache = { day: '', days: [], failAt: 0 };
const wheelSkip = new Map(), wheelSent = new Map();                         // skip: 'p:SYM' / 'c:SYM' → until when a turned-down stock is left alone
const wheelNewsCache = new Map();                                           // sym → { at, arts }: wheel candidates are rarely on the RSI-2 watch list, so the shared symbol-news cache does not cover them under a market scan — their headlines are read here (kept 10 minutes)
// sent: 'p:UND' / 'c:UND' (a sale) or 'b:CONTRACT' (a buy-back) → what went out in the last 90 s (the broker may not list it yet)
const WHEEL_SENT_MS = 90000, wheelRecent = k => { const x = wheelSent.get(k); return x && Date.now() - x.at < WHEEL_SENT_MS ? x : null; };
// 'stock:SYM' / 'call:SYM' / 'put:SYM' / 'day:SYM' → when that lane last sent a buy for the stock. The broker may not list
// an order placed seconds ago, and a moved price then picks a *different* contract — the snapshot guards (positions, open
// orders, today's history) all miss it, so the same signal would buy twice. For 90 s the lane does not buy that stock
// again, and the wheel treats it as busy.
const laneSent = new Map(), laneRecent = k => (laneSent.get(k) || 0) > Date.now() - 90000;
export const wheelHas = sym => !!(wheelMem.opts[sym] || wheelMem.shares[sym]);
// What the wheel has set aside: strike × 100 of every sold put and every put sale still working, plus its shares at their price.
function wheelSetAside(positions, orders) {
  const px = new Map(positions.map(p => [p.symbol, +p.current_price])); let used = 0;
  for (const x of Object.values(wheelMem.opts)) if (x.kind === 'put') used += x.K * 100 * x.qty;
  for (const [und, s] of Object.entries(wheelMem.shares)) used += s.qty * (px.get(und) > 0 ? px.get(und) : s.cost);
  for (const o of orders) { const q = parseOcc(o.symbol); if (q && q.kind === 'put' && isWheelSell(cidOf(o))) used += q.K * 100 * Math.max(0, (+o.qty || 0) - (+o.filled_qty || 0)); }
  return used;
}
const tickDown = (p, sym = '') => { const st = tickStep(p, sym); return Math.round(Math.floor(p / st + 1e-9) * st * 100) / 100; };
const usd0 = n => '$' + Math.round(n).toLocaleString('en-US');
const dayLabel = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
async function wheelDays() {                                               // the broker's trading days, ~50 back and ~80 ahead (once a day)
  if (wheelDaysCache.day === TODAY && wheelDaysCache.days.length) return wheelDaysCache.days;
  if (Date.now() - (wheelDaysCache.failAt || 0) < 10 * 60000) return wheelDaysCache.days;   // after a failure, again in 10 minutes: no check waits on it
  const cal = await T(`/v2/calendar?start=${ymdDash(Date.now() - 50 * 864e5)}&end=${ymdDash(Date.now() + 80 * 864e5)}`, { timeoutMs: 5000, retries: 0 }).catch(() => null);
  wheelDaysCache = Array.isArray(cal) && cal.length ? { day: TODAY, days: cal.map(x => x.date).filter(Boolean).sort(), failAt: 0 } : { ...wheelDaysCache, failAt: Date.now() };
  return wheelDaysCache.days;
}
async function wheelNews(sym) {
  const c = wheelNewsCache.get(sym); if (c && Date.now() - c.at < 10 * 60000) return c.arts;
  const j = await D(`/v1beta1/news?symbols=${sym}&limit=10&sort=desc&start=${new Date(Date.now() - 72 * 3600e3).toISOString()}`).catch(() => null);
  const arts = j && Array.isArray(j.news) ? j.news : null;
  wheelNewsCache.set(sym, { at: arts ? Date.now() : Date.now() - 8 * 60000, arts: arts || [] });   // a failed read is tried again in 2 minutes
  return arts || [];
}
function wheelEventText(e) {
  const prem = e.prem * 100 * e.qty, n = e.qty * 100, kind = e.kind === 'put' ? 'put' : 'call';
  if (e.type === 'expired') return `Wheel: ${e.und} ${kind} ${e.K} expired worthless — the ${usd0(prem)} premium is kept`;
  if (e.type === 'assigned') return `Wheel: ${e.und} put ${e.K} ended in the money — ${n} shares bought at $${e.K}${e.prem > 0 ? ` (cost $${(e.K - e.prem).toFixed(2)} a share after the premium)` : ''}; covered calls are sold on them in the sale window after each monthly expiration`;
  if (e.type === 'called away') return `Wheel: ${e.und} call ${e.K} ended in the money — ${n} shares sold at $${e.K}; cash-secured puts again from the next sale window`;
  if (e.type === 'bought back') return `Wheel: ${e.und} ${kind} ${e.K} bought back`;
  return `Wheel: ${e.und} ${kind} ${e.K} is no longer in the account`;
}
// The contract to sell: the monthly expiry of the window, the strike from the rules, a usable quote (bid ≥ $0.05, spread
// under 15 % of the middle). The sale is priced at the middle (never under the bid).
async function wheelContract(und, kind, expiry, px, cost = 0) {
  const lo = kind === 'put' ? px * 0.7 : Math.max(px, cost), hi = kind === 'put' ? px : Math.max(px, cost) * 1.4;
  const cj = await T(`/v2/options/contracts?underlying_symbols=${und}&type=${kind}&status=active&expiration_date=${expiry}&strike_price_gte=${r2d(lo)}&strike_price_lte=${r2d(hi)}&limit=500`).catch(() => null);
  if (!cj) return { why: `${und}: contract list unavailable`, retry: 60000 };
  const std = new RegExp('^' + und + '\\d{6}[CP]\\d{8}$'), cs = (cj.option_contracts || []).filter(c => c.tradable !== false && std.test(c.symbol));
  const K = kind === 'put' ? putStrike(cs.map(c => +c.strike_price), px, CFG.wheelOtmPct) : callStrike(cs.map(c => +c.strike_price), px, CFG.wheelOtmPct, cost);
  if (K == null) return { why: `${und}: no ${kind} expiring ${expiry} at the strike the rules ask for` };
  const c = cs.find(x => +x.strike_price === K);
  const q = ((await D(`/v1beta1/options/quotes/latest?symbols=${c.symbol}&feed=indicative`).catch(() => ({}))).quotes || {})[c.symbol];
  if (!q || !(q.bp >= 0.05) || !(q.ap > q.bp)) return { why: `${c.symbol}: no usable quote (bid ${q && q.bp != null ? q.bp : 'none'})`, retry: 10 * 60000 };
  const mid = (q.ap + q.bp) / 2; if ((q.ap - q.bp) / mid > 0.15) return { why: `${c.symbol}: spread too wide (${q.bp}/${q.ap})`, retry: 10 * 60000 };
  return { ok: true, sym: c.symbol, K, exp: expiry, bid: q.bp, ask: q.ap, lim: Math.max(q.bp, tick(mid, c.symbol)) };
}
async function wheelSell(kind, und, c, qty, why) {
  const k = kind[0] + ':' + und; if (wheelRecent(k)) return null;          // one sale per stock at a time: the broker may not list one placed seconds ago
  wheelSent.set(k, { at: Date.now(), sym: c.sym, und, K: c.K, qty });
  return send({ symbol: c.sym, qty: String(qty), side: 'sell', type: 'limit', limit_price: String(c.lim), time_in_force: 'day', position_intent: 'sell_to_open', client_order_id: wheelId(kind, c.sym, TODAY, rid()) }, why);
}
// The stop: its take-profit order is cancelled first (confirmed, so the two cannot both fill), then what is still sold is
// bought back at market.
async function wheelBuyBack(sym, qty, legs, why) {
  await cancelConfirmed(legs); forgetBuy(sym);
  let have = qty;
  if (!DRY) { const p = await T('/v2/positions/' + encodeURIComponent(sym), QUICK).catch(e => (e && e.status === 404 ? null : undefined)); if (p === null || (p && +p.qty >= 0)) have = 0; else if (p) have = Math.min(qty, -p.qty); }
  if (!(have > 0)) { act(`${sym}: nothing left to buy back (${why})`); return null; }
  return send({ symbol: sym, qty: String(have), side: 'buy', type: 'market', time_in_force: 'day', position_intent: 'buy_to_close', client_order_id: wheelId('buy', sym, null, rid()) }, why);
}
async function wheelLane({ equity, positions, hist, liveOrders, G, pdtNear, claim }) {
  const on = !!CFG.wheelOn, today = ymdDash(Date.now()), opts = Object.entries(wheelMem.opts), shares = Object.entries(wheelMem.shares);
  const pos = sym => positions.find(p => p.symbol === sym);
  const skipW = (k, why, ms = 30 * 60000) => { wheelSkip.set(k, Date.now() + ms); act(why + ' — the wheel looks again later', 'wskip:' + k); };
  const act20 = Date.now() - wheelAt >= 20000; if (act20) wheelAt = Date.now();
  // sales that did not fill in 15 minutes have missed their price (the next check prices again); switched off, at once
  if (act20) for (const o of liveOrders) if (isWheelSell(cidOf(o)) && (!on || Date.now() - Date.parse(o.submitted_at || o.created_at || Date.now()) > 15 * 60000)) {
    act(`${o.symbol}: wheel sale at ${o.limit_price} ${on ? 'unfilled for 15 min' : 'still working while the wheel is switched off'} — cancelled`); if (!DRY) await T('/v2/orders/' + o.id, { method: 'DELETE' }).catch(() => {}); o._cancelled = true;
  }
  // a buy-back with nothing left to buy back (assigned or called away early) or with "buy back at" set to 0 is cancelled
  if (act20) for (const o of liveOrders) if (isWheelBuy(cidOf(o)) && o.type === 'limit' && !tpCancelled.has(o.id)) {
    const p = pos(o.symbol), gone = !wheelMem.opts[o.symbol] || (p && !(+p.qty < 0));   // memory drops it once it is assigned, called away or bought back
    if (!gone && CFG.wheelTp > 0) continue;
    tpCancelled.add(o.id); o._cancelled = true; forgetBuy(o.symbol); act(`${o.symbol}: wheel buy-back at ${o.limit_price} — ${gone ? 'nothing is sold any more' : '“buy back at” is 0 (hold to expiry)'} — cancelled`); if (!DRY) await T('/v2/orders/' + o.id, { method: 'DELETE' }).catch(() => {});
  }
  // what is working: a sale cancelled in this check still counts (it can fill until the cancel lands); a sale sent in the last
  // 90 s that the broker does not list yet counts too
  const live = liveOrders.filter(o => isWheelId(cidOf(o))), listed = new Set(live.map(o => o.symbol)), unds = new Set(), pending = [];
  for (const [k, x] of wheelSent) if ((k[0] === 'p' || k[0] === 'c') && Date.now() - x.at < WHEEL_SENT_MS && !listed.has(x.sym) && !wheelMem.opts[x.sym]) pending.push({ kind: k[0], ...x });
  for (const [, x] of opts) unds.add(x.und);
  for (const [und] of shares) unds.add(und);
  for (const o of live) { const q = parseOcc(o.symbol); if (q && isWheelSell(cidOf(o))) unds.add(q.und); }
  for (const x of pending) { unds.add(x.und); if (claim) claim.add(x.und); }   // a sale the broker does not list yet: the other parts keep out of its stock too
  let used = wheelSetAside(positions, live) + pending.filter(x => x.kind === 'p').reduce((t, x) => t + x.K * 100 * x.qty, 0);
  const scale = CFG.mode === 'live' ? CFG.liveSizePct / 100 : 1;          // real money starts small, like every other part
  const moneyW = on ? equity * CFG.wheelSharePct / 100 * scale : 0, free = moneyW - used;
  const days = on ? await wheelDays() : wheelDaysCache.days, info = days.length ? wheelCycleInfo(today, days) : null;   // switched off it never waits on the calendar
  let idle = !on ? 'switched off' : !info ? 'the market calendar is unavailable' : !info.window ? `next sale window ${info.windowDays.map(dayLabel).join(', ')} (puts expiring ${dayLabel(info.expiry)})` : null;
  if (act20) {
    // 1) every sold option: its take-profit buy-back rests at the broker; the stop (off by default) buys it back at market
    for (const [sym, x] of opts) {
      const p = pos(sym); if (!p) continue;
      const buys = live.filter(o => o.symbol === sym && o.side === 'buy' && !o._cancelled), cur = +p.current_price;
      if (CFG.wheelStop > 0 && x.kind === 'put' && cur > 0 && x.prem > 0 && cur >= x.prem * CFG.wheelStop) {   // puts only, as tested (a covered call's shares rose with it)
        if (buys.some(o => o.type === 'market') || wheelRecent('b:' + sym)) continue;
        wheelSent.set('b:' + sym, { at: Date.now(), sym });
        await wheelBuyBack(sym, x.qty, buys, `Wheel: ${x.und} ${x.kind} ${x.K} costs ${(cur / x.prem).toFixed(1)}× its premium — stop, bought back`).catch(() => {});
        continue;
      }
      if (!(CFG.wheelTp > 0) || (pdtNear && x.since === today)) continue;       // hold to expiry; or no same-day buy-back under the pattern-day-trader limit
      const tp = tickDown(wheelTpPrice(x.prem, CFG.wheelTp), sym), leg = buys.find(o => o.type === 'limit');
      if (!(tp > 0)) continue;
      if (leg) {
        const stale = Math.abs(+leg.limit_price - tp) > tickStep(tp, sym) + 0.005 || (+leg.qty || 0) - (+leg.filled_qty || 0) !== x.qty;
        if (stale && isWheelBuy(cidOf(leg)) && !tpCancelled.has(leg.id)) { tpCancelled.add(leg.id); forgetBuy(sym); act(`${sym} wheel take-profit at ${leg.limit_price} does not match the setting or the position — cancelled; a new one at ${tp} follows`); if (!DRY) await T('/v2/orders/' + leg.id, { method: 'DELETE' }).catch(() => {}); }
        continue;
      }
      if (wheelRecent('b:' + sym)) continue;
      wheelSent.set('b:' + sym, { at: Date.now(), sym });
      forgetBuy(sym);                                                       // a buy-back cancelled at the broker (by hand) must come back now, not after send()'s six-hour guard
      await send({ symbol: sym, qty: String(x.qty), side: 'buy', type: 'limit', limit_price: String(tp), time_in_force: 'gtc', position_intent: 'buy_to_close', client_order_id: wheelId('buy', sym, null, rid()) },
        `Wheel: ${x.und} ${x.kind} ${x.K} take-profit order — buys it back at ${tp} (${100 - CFG.wheelTp}% of the ${x.prem} premium)`).catch(() => {});
    }
    // 2) in the sale window: covered calls on the shares a put delivered, then new cash-secured puts (nothing new while the
    //    market check pauses entries — a Telegram /pause, a headline, the Fed hour, a loss limit — or a session is ending)
    if (on && info && info.window && (noNew || G.block)) idle = noNew || (userPause ? 'paused from Telegram' : 'paused by the market check');
    else if (on && info && info.window) {
      const callsSold = soldFor(hist, info.expiry, 'call'), putsSold = soldFor(hist, info.expiry, 'put');
      for (const [und, s] of shares) {
        const isCall = o => (parseOcc(o.symbol) || {}).und === und && (parseOcc(o.symbol) || {}).kind === 'call';
        const held = opts.filter(([, x]) => x.und === und && x.kind === 'call').reduce((t, [, x]) => t + x.qty, 0), working = live.filter(o => isWheelSell(cidOf(o)) && isCall(o)).reduce((t, o) => t + Math.max(0, (+o.qty || 0) - (+o.filled_qty || 0)), 0) + pending.filter(x => x.kind === 'c' && x.und === und).reduce((t, x) => t + x.qty, 0);
        const n = Math.floor(s.qty / 100) - Math.max(held, callsSold.get(und) || 0) - working;   // one sale per cycle: a call bought back early is not sold again
        if (n < 1 || (wheelSkip.get('c:' + und) || 0) > Date.now()) continue;
        const px = ((await latestPrices([und]))[und] || {}).p; if (!(px > 0)) continue;
        const c = await wheelContract(und, 'call', info.expiry, px, s.cost); if (!c.ok) { skipW('c:' + und, c.why, c.retry); continue; }
        await wheelSell('call', und, c, n, `Wheel: ${und} covered call — ${n} × ${c.K} call expiring ${dayLabel(c.exp)} (cost $${s.cost.toFixed(2)} a share; ${CFG.wheelOtmPct}% over $${r2d(px)})`);
      }
      // the trend filter as the study applied it: SPY closed above its 200-day average before each day of the window so far
      const spyT = CFG.wheelTrend ? trendThrough(spyPrev && spyPrev.days, spyPrev && spyPrev.closes, info.windowDays, today) : { ok: true };
      if (spyT.ok !== true) idle = spyT.ok === false ? `SPY closed under its 200-day average on ${dayLabel(spyT.under)} — no new puts until the next sale window (trend filter)` : 'SPY\'s 200-day average is not known yet — no new puts (trend filter)';
      else {
        let slots = CFG.wheelMaxPositions - unds.size, left = free, looked = 0;
        const busy = new Set(positions.map(p => isOpt(p.symbol) ? OPT_RE.exec(p.symbol)[1] : p.symbol).concat(liveOrders.map(o => isOpt(o.symbol) ? OPT_RE.exec(o.symbol)[1] : o.symbol)));
        for (const [k, t0] of laneSent) if (t0 > Date.now() - 90000) busy.add(k.slice(k.indexOf(':') + 1));   // a buy another lane sent seconds ago may not be listed yet
        const cands = UNIVERSE.filter(x => x !== 'SPY' && !busy.has(x) && !unds.has(x) && !putsSold.has(x)), px = await latestPrices(cands), bars = CFG.wheelTrend ? await loadBars() : null;   // a put bought back this cycle waits for the next window
        if (slots <= 0) idle = `${unds.size} stocks in the wheel — the most at once`;
        else if (left < CFG.wheelMinPrice * 100) idle = `no money left for a put (${usd0(free)} free of ${usd0(moneyW)})`;
        let sold = 0;
        for (const x of cands) {
          if (slots <= 0 || looked >= 6) break;
          const p0 = (px[x] || {}).p; if (!(p0 >= CFG.wheelMinPrice && p0 <= CFG.wheelMaxPrice) || p0 * (1 - CFG.wheelOtmPct / 100) * 100 > left) continue;
          if ((wheelSkip.get('p:' + x) || 0) > Date.now()) continue;
          if (bars) { const C = completed(bars, x); if (trendThrough(C.map(b => b.d), C.map(b => b.c), info.windowDays, today).ok !== true) continue; }   // the stock too, before each day of the window so far
          const risk = CFG.newsGuard ? symbolRisk(x, newsCache.syms) || symbolRisk(x, await wheelNews(x)) : null; if (risk) { skipW('p:' + x, `${x} — ${risk}`, 60 * 60000); continue; }
          looked++;
          const c = await wheelContract(x, 'put', info.expiry, p0); if (!c.ok) { skipW('p:' + x, c.why, c.retry); continue; }
          if (c.K * 100 > left) continue;
          const r = await wheelSell('put', x, c, 1, `Wheel: ${x} cash-secured put — 1 × ${c.K} put expiring ${dayLabel(c.exp)} (${CFG.wheelOtmPct}% under $${r2d(p0)}); ${usd0(c.K * 100)} set aside`);
          if (r && r !== 'refused') { left -= c.K * 100; used += c.K * 100; slots--; sold++; unds.add(x); if (claim) claim.add(x); }   // the other parts keep out of it from this check on
        }
        if (!sold && !idle) idle = `no stock passes right now (price $${CFG.wheelMinPrice}–$${CFG.wheelMaxPrice}, one put within ${usd0(left)} free, above its 200-day average, a usable quote) — looked again every 20 s in the window`;
      }
    }
  }
  const tpOf = (x, sym) => CFG.wheelTp > 0 ? r2d(tickDown(wheelTpPrice(x.prem, CFG.wheelTp), sym) * 100) : null;   // the buy-back order's price, per contract
  lastWheel = { at: new Date().toISOString(), on, share: on ? CFG.wheelSharePct : 0, scale, money: Math.round(moneyW), used: Math.round(used), free: Math.round(moneyW - used), idle,
    window: info ? { open: info.window, days: info.windowDays, expiry: info.expiry, last: info.last, next: info.next } : null,
    opts: opts.map(([sym, x]) => { const p = pos(sym); return { s: sym, und: x.und, kind: x.kind, K: x.K, exp: x.exp, qty: x.qty, prem: r2d(x.prem * 100), cur: p ? r2d(+p.current_price * 100) : null, pl: p ? r2d(+p.unrealized_pl) : null, tp: tpOf(x, sym), since: x.since }; }),
    shares: shares.map(([und, s]) => { const p = pos(und); return { und, qty: s.qty, cost: s.cost, px: p ? r2d(+p.current_price) : null, pl: p ? r2d((+p.current_price - s.cost) * s.qty) : null, since: s.since || null }; }),
    working: live.filter(o => !o._cancelled).map(o => ({ s: o.symbol, side: o.side, lim: +o.limit_price || null, qty: +o.qty })),
    rules: { otm: CFG.wheelOtmPct, tp: CFG.wheelTp, stop: CFG.wheelStop, trend: !!CFG.wheelTrend, minPx: CFG.wheelMinPrice, maxPx: CFG.wheelMaxPrice, maxPos: CFG.wheelMaxPositions } };
}
// Every fill of today (all pages).
async function todaysFills() {
  let f = [], token = '';
  for (let k = 0; k < 10; k++) { const pg = await T('/v2/account/activities/FILL?date=' + ymdDash(Date.now()) + '&direction=asc&page_size=100' + (token ? '&page_token=' + token : '')); if (!Array.isArray(pg) || !pg.length) break; f = f.concat(pg); if (pg.length < 100) break; token = pg[pg.length - 1].id; }
  return f;
}
// End-of-day summary to the phone: what happened today, what is still open, where the account stands.
export async function eodReport() {
  try {
    const acct = await T('/v2/account'), positions = await T('/v2/positions');
    const f = await todaysFills().catch(() => []), hist = await orderHistory(45).catch(() => []);
    const closed = buildJournal(withOpenings(f || [], hist, ymdDash(Date.now())), []).closed, pl = closed.reduce((t, c) => t + c.pl, 0), wins = closed.filter(c => c.pl > 0).length;   // swing trades sold today count with the price they were bought at
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
  for (let attempt = 0; attempt <= (retriable ? (opt.retries ?? HTTP_RETRIES) : 0); attempt++) {
    if (attempt) await sleepMs(Math.min(8000, 1000 * 2 ** (attempt - 1)) + Math.random() * 300);
    const lim = opt.timeoutMs || HTTP_TIMEOUT_MS, ac = new AbortController(), timer = setTimeout(() => ac.abort(), lim), tCall = Date.now();
    let again = false;
    engine.calls++;
    try {
      const { timeoutMs, retries, ...fo } = opt; void timeoutMs; void retries;
      const r = await fetch(base + path, { headers: H, ...fo, signal: ac.signal });
      engine.callMs += Date.now() - tCall;
      if (r.status === 204) return null;
      const tx = await r.text();
      if (r.ok) return tx ? JSON.parse(tx) : null;
      lastErr = new Error(path.split('?')[0] + ' HTTP ' + r.status + ' ' + tx.slice(0, 200)); lastErr.status = r.status;
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
const forgetBuy = sym => placed.delete('buy:' + sym + ':limit');               // the wheel cancelled its own buy-back: a replacement is not a duplicate
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
const send = async (body, why) => { why = why + alertDetail(body); const dk = (/^sd-y/.test(body.client_order_id || '') || (/^sd-wb-/.test(body.client_order_id || '') && body.type === 'market')) && body.side === 'buy' ? body.client_order_id : body.side + ':' + body.symbol + ':' + body.type, t0 = placed.get(dk); if (t0 && Date.now() - t0 < (body.side === 'buy' ? 6 * 3600e3 : 90e3)) { console.log('duplicate suppressed:', dk); return null; } placed.set(dk, Date.now()); const line = (body.side === 'buy' ? '\ud83d\udfe2 ' : '\ud83d\udd34 ') + why; act(why + ' — ' + body.side.toUpperCase() + ' ' + body.qty + ' ' + body.symbol + (body.limit_price ? ' @ ' + body.limit_price : ' at market')); if (DRY) { alerts.push(line); return { dry: true }; }
  return T('/v2/orders', { method: 'POST', body: JSON.stringify(body) }).then(r => { alerts.push(line); return r; }).catch(e => { const sure = e && e.status >= 400 && e.status < 500; if (sure) placed.delete(dk); act(`Order ${sure ? 'NOT accepted' : 'may not have arrived (no answer)'}: ${body.side} ${body.qty} ${body.symbol} — ${String(e.message || e).slice(0, 90)}`); if (body.side === 'sell') return 'refused'; throw e; }); };   // only a clear 4xx refusal frees the order for a retry: a timed-out POST may have reached the broker   // a refused sell must not stop the rest of the cycle (other positions still need managing); it is retried next check   // the phone alert goes out only for an accepted order; a rejected one must not block its own retry

// Closing a position at market, safely: cancel its resting sell orders and wait until the broker confirms each one is
// gone (a leg that filled meanwhile has already sold part of it), then re-read the position so the sale never exceeds
// what is held — selling more than is held would open a short. Returns the order, or null when nothing was left to sell.
const sleepShort = ms => new Promise(r => setTimeout(r, ms)), QUICK = { timeoutMs: 1500, retries: 0 };
async function cancelConfirmed(orders) {
  if (!DRY) for (const o of orders) {
    try { await T('/v2/orders/' + o.id, { method: 'DELETE' }); } catch (e) { /* already gone or filled: the check below sees it */ }
    let id = o.id;
    for (let k = 0; k < 4; k++) {                                                        // confirm within ~2 s (quick calls, no retries); after that, the position re-read decides
      const st = await T('/v2/orders/' + id, QUICK).catch(() => null);
      if (st && st.status === 'replaced' && st.replaced_by) { id = st.replaced_by; await T('/v2/orders/' + id, { method: 'DELETE', ...QUICK }).catch(() => {}); continue; }   // a trailed stop lives on under a new id
      if (!st || !['new', 'accepted', 'pending_new', 'pending_cancel', 'pending_replace', 'partially_filled', 'held', 'accepted_for_bidding'].includes(st.status)) break;
      await sleepShort(500);
    }
  }
}
async function closeOut(symbol, qty, sells, why) {
  await cancelConfirmed(sells);
  let have = qty;
  if (!DRY) { const pos = await T('/v2/positions/' + encodeURIComponent(symbol), QUICK).catch(e => (e && e.status === 404 ? null : undefined)); if (pos === null) have = 0; else if (pos && Math.abs(+pos.qty) > 0) have = Math.abs(+pos.qty); }   // only a real 404 means flat; a timeout keeps the known quantity
  if (have <= 0) { act(`${symbol}: already flat — nothing to sell (${why})`); return null; }
  return send({ symbol, qty: String(Math.min(qty, have)), side: 'sell', type: 'market', time_in_force: 'day', client_order_id: 'sd-x-' + symbol + '-' + rid() }, why);
}
// The take-profit of a CALL or PUT is a limit order resting at the broker at +optTakeProfit % of the buy price (rounded up to
// a valid price). When the option trades there the broker fills it at that price or better; the bot never cancels it to sell
// at market (a market sale goes at the bid, which with a +5% target can be under the target or even a loss). With no order
// resting, one is placed — when the price is already past the target it fills at once at the bid, which is then above the
// target. An order the bot left at an older setting is cancelled and the new one goes in at the next check, seconds later.
// noSameDay: under the pattern-day-trader limit no take-profit is placed (or moved) on the day of the buy.
const tpCancelled = new Set();
async function optTakeProfit(p, sells, qty, avg, noSameDay) {
  if (!(avg > 0) || !(qty > 0)) return;
  const tpPx = tickUp(avg * (1 + OPT_TP / 100), p.symbol), leg = sells.find(o => o.type === 'limit');
  if (!leg) { if (!sells.length && !noSameDay) await send({ symbol: p.symbol, qty: String(qty), side: 'sell', type: 'limit', limit_price: String(tpPx), time_in_force: 'day', client_order_id: 'sd-x-' + p.symbol + '-' + rid() }, `${p.symbol} take-profit at +${OPT_TP}% (${tpPx})`); return; }
  if (noSameDay || !/^sd-/.test(cidOf(leg))) return;                                      // an order placed by hand is the owner's: left alone
  const short = (+leg.qty || 0) - (+leg.filled_qty || 0) < qty - 1e-9;                     // placed before the rest of a buy filled in pieces: it would sell only part
  if (!short && Math.abs(+leg.limit_price - tpPx) <= tickStep(tpPx, p.symbol) + 0.005) return;   // resting at today's setting (give or take one price step), for the whole position
  if (tpCancelled.has(leg.id)) return; tpCancelled.add(leg.id);
  act(`${p.symbol} take-profit order at ${leg.limit_price} ${short ? 'covers only part of the position' : 'is from an older setting'} — cancelled; the new one at +${OPT_TP}% (${tpPx}) follows`);
  if (!DRY) await T('/v2/orders/' + leg.id, { method: 'DELETE' }).catch(() => {});
}
// ---- time in New York ----
// Every order of the last N days, oldest pages too: one call returns at most 500, and a busy account (day trades, SPY,
// daily take-profit orders) passes that in a couple of weeks — a trade older than the cap would look like a manual one.
let olderOrders = { at: 0, list: [] };
async function orderHistory(days) {
  const after = new Date(Date.now() - days * 864e5).toISOString();
  const first = await T('/v2/orders?status=all&limit=500&direction=desc&after=' + after);
  if (!Array.isArray(first) || first.length < 500) return first || [];
  const edge = first[first.length - 1].submitted_at || first[first.length - 1].created_at;
  // older pages change rarely: re-read them every 5 minutes, and at once when new orders pushed the newest page's oldest order
  // forward (the orders between the old and the new edge would otherwise be in neither list)
  if (Date.now() - olderOrders.at > 5 * 60000 || olderOrders.edge !== edge) {
    let out = [], until = edge;
    for (let k = 0; k < 8 && until; k++) {
      const pg = await T('/v2/orders?status=all&limit=500&direction=desc&after=' + after + '&until=' + encodeURIComponent(until));
      if (!Array.isArray(pg) || !pg.length) break;
      out = out.concat(pg); if (pg.length < 500) break;
      const oldest = pg[pg.length - 1].submitted_at || pg[pg.length - 1].created_at; if (!oldest || oldest === until) break; until = oldest;
    }
    olderOrders = { at: Date.now(), list: out, edge };
  }
  const seen = new Set(); return first.concat(olderOrders.list).filter(o => { const k = o.id || o.client_order_id; if (!k) return true; if (seen.has(k)) return false; seen.add(k); return true; });   // pages can overlap at the boundary
}
const etParts = d => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d).map(p => [p.type, p.value]));
let TODAY = '', MINS = 0;                                   // yyyymmdd, minutes past midnight ET
let CLOSE = 960;                                            // today's close in minutes ET (4:00 PM; 1:00 PM on early-close days such as the day after Thanksgiving and Dec 24)
export const closeMins = () => CLOSE;
let calDay = '';
// Today's session from the broker's calendar (once a day): the close time, 13:00 on early-close days. Works before the open
// and after the close too, unlike the clock's next_close.
export async function loadCalendar() {
  setNow(); if (calDay === TODAY) return CLOSE;
  try { const d = ymdDash(Date.now()), cal = await T(`/v2/calendar?start=${d}&end=${d}`, QUICK); calDay = TODAY;
    if (Array.isArray(cal) && cal[0] && cal[0].date === d && /^\d{1,2}:\d{2}$/.test(cal[0].close || '')) { const [h, m] = cal[0].close.split(':').map(Number); CLOSE = h * 60 + m; } else CLOSE = 960; } catch (e) {}
  return CLOSE;
}
const EARLY = () => 960 - CLOSE;                            // how many minutes earlier than usual the market closes today (0 normally)
export function setNow() { const ep = etParts(new Date()); TODAY = ep.year + ep.month + ep.day; MINS = (+ep.hour % 24) * 60 + +ep.minute; return MINS; }
// When was the journal on disk written, in Eastern time? { day: 'yyyymmdd', mins } or null. Readable in both plain and encrypted journals.
export function journalStamp() {
  try { const jj = JSON.parse(fs.readFileSync('bot/journal.json', 'utf8')), at = jj.at; if (!at) return null; const ep = etParts(new Date(at)); return { day: ep.year + ep.month + ep.day, mins: (+ep.hour % 24) * 60 + +ep.minute, at, done: !!jj.done }; }
  catch (e) { return null; }
}
setNow();
const ymdDash = ms => { const e = etParts(new Date(ms)); return e.year + '-' + e.month + '-' + e.day; };
const rid = () => Math.random().toString(36).slice(2, 7);
const OPT_RE = /^([A-Z.]+)(\d{6})([CP])(\d{8})$/;
// An order that put shares or contracts in the account: filled, or filled in part and then cancelled or still working.
export const bought = o => !!o && (o.status === 'filled' || ((o.status === 'partially_filled' || o.status === 'canceled' || o.status === 'expired' || o.status === 'done_for_day') && +o.filled_qty > 0));
const isOpt = s => OPT_RE.test(s);
const cidOf = o => (o && o.client_order_id) || '';
// When an order last did something: its fill, else its last update or submission (ms; 0 when unknown).
const tOf = o => Date.parse((o && (o.filled_at || o.updated_at || o.submitted_at || o.created_at)) || '') || 0;
// The most recent buy matching `pred` that put something in the account (by time, whatever order the list comes in).
const latestBuy = (hist, pred) => (hist || []).filter(o => o.side === 'buy' && bought(o) && pred(o)).reduce((a, b) => !a || tOf(b) > tOf(a) ? b : a, null);
// How much of a position is the bot's: what its own buy filled, less every sale of that symbol filled after that buy (the
// bot's exits, a broker stop leg, a sale by hand), never more than is held. 0 = nothing of it is left: a later position in
// the same symbol was bought by hand and is never the bot's to sell. A short position is never managed (a sale adds to it).
export function ownQty(p, e, hist) {
  const held = +p.qty; if (!(held > 0) || !e) return 0;
  const got = +e.filled_qty > 0 ? +e.filled_qty : e.status === 'filled' ? +e.qty || 0 : 0;
  const t0 = Date.parse(e.submitted_at || e.created_at || '') || tOf(e);              // from its submission: a buy filled in pieces completes after its first pieces could be sold
  const sold = (hist || []).filter(o => o.symbol === p.symbol && o.side === 'sell' && +o.filled_qty > 0 && tOf(o) > t0).reduce((t, o) => t + +o.filled_qty, 0);
  return Math.max(0, Math.min(held, got - sold));
}
// Today's fills, plus an opening buy for every sale whose buy was on an earlier day (a swing trade sold today), priced from
// that buy order — so a swing trade closed today at a loss counts for the losing-streak brake and the day's summary.
export function withOpenings(fills, hist, todayDash) {
  const out = [...(fills || [])], bySym = {};
  for (const f of out) (bySym[f.symbol] = bySym[f.symbol] || []).push(f);
  for (const [sym, fs2] of Object.entries(bySym)) {
    let pos = 0, short = 0;
    for (const f of [...fs2].sort((a, b) => String(a.transaction_time) < String(b.transaction_time) ? -1 : 1)) {
      const q = Math.abs(+f.qty || 0);
      if (/^buy/.test(f.side)) pos += q; else if (q > pos) { short += q - pos; pos = 0; } else pos -= q;
    }
    if (!(short > 0)) continue;
    const b = latestBuy(hist, o => o.symbol === sym && tOf(o) < Date.parse(todayDash + 'T12:00:00Z'));   // bought before today's session (12:00 UTC is before the open in summer and winter)
    const px = b && (+b.filled_avg_price || +b.limit_price); if (!(px > 0)) continue;
    out.push({ symbol: sym, side: 'buy', qty: String(short), price: String(px), transaction_time: tOf(b) > 0 ? new Date(tOf(b)).toISOString() : '1970-01-01T00:00:00Z', order_id: 'open:' + (b.id || cidOf(b) || sym) });   // its own time (never today's date: the day-trade streak counts same-day trades only)
  }
  return out;
}
// Price increments the exchanges accept. Stocks: $0.01. Options: SPY, QQQ and IWM trade in pennies at every price;
// other penny-pilot names in pennies below $3 and nickels from $3; everything else in nickels below $3 and dimes from $3.
const PENNY_ALL = /^(SPY|QQQ|IWM)\d{6}[CP]\d{8}$/;
const PILOT = /^(DIA|XLF|XLE|GLD|SLV|EEM|AAPL|AMZN|MSFT|NVDA|TSLA|META|GOOGL|GOOG|AMD|BAC|F|INTC|C|GE|T|XOM|PFE|WFC|JPM|NFLX|BABA|UBER|COIN|PLTR|SOFI|DIS|KO|WMT|CSCO|ORCL|MU|SNAP|HOOD)\d{6}[CP]\d{8}$/;
export const tickStep = (p, sym = '') => !OPT_RE.test(sym) || PENNY_ALL.test(sym) ? 0.01 : PILOT.test(sym) ? (p < 3 ? 0.01 : 0.05) : (p < 3 ? 0.05 : 0.10);
export const tick = (p, sym = '') => { const step = tickStep(p, sym); return Math.round(Math.round(p / step) * step * 100) / 100; };
// A take-profit price: rounded UP to the next valid price, so it never sells below its target (+5% on a $1.02 option that
// trades in nickels is $1.071 → $1.10, not $1.05). The real-price study asked the same: a trade at or above the target.
export const tickUp = (p, sym = '') => { const step = tickStep(p, sym); return Math.round(Math.ceil(p / step - 1e-9) * step * 100) / 100; };
const acts = [], seen = new Map();
const act = (m, key) => {                                   // same message (or the same key) within 10 min is logged once
  const k = key || m.replace(/[-+]?\d+(\.\d+)?%/g, '#');
  if (seen.has(k) && Date.now() - seen.get(k) < 10 * 60000) return;
  seen.set(k, Date.now()); console.log(redact(m)); acts.push({ t: new Date().toISOString(), m });
};
// What stops new trades in this cycle besides the market check: the final check of a session, or its last 10 minutes.
let noNew = '';
let lastWatch = null, lastSignals = null, lastClock = null, barsCache = { at: 0, bars: null }, lastPosSig = '', pendingActs = 0;
let newsCache = { at: 0, market: [], syms: [], ok: true }, lastGuard = null, spyPrev = null, weekCache = { at: 0, start: null }, fillsCache = { at: 0, closed: [], fills: [] }, lastRisk = null;
const NM = { stock: { one: 'stock', many: 'stocks', Cap: 'Stocks' }, call: { one: 'CALL', many: 'CALLs', Cap: 'CALLs' }, put: { one: 'PUT', many: 'PUTs', Cap: 'PUTs' }, spy: { one: 'SPY option', many: 'SPY options', Cap: 'SPY options' }, wheel: { one: 'wheel', many: 'wheel trades', Cap: 'Wheel' } };
let lastSpy = null, memRestored = false, flooredSyms = new Set(), prevHeld = new Map(), spyPlacedAt = 0;
const missingFill = new Map();                                            // symbol → { t0: when it vanished without a listed closing fill, short }: no day-loss halt until it shows (at most 10 minutes)
let stopMoved = new Set();
let lastSplit = null, lastDayPx = {}, haltSaid = new Set();      // money split panel, yesterday's closes, halt messages already sent today
const alerts = [];

// One full decision cycle: manage every position, then look for new entries.
let hooks = {};
export async function botCycle({ journal = false, floors = null, held = null, manageOnly = false } = {}) {
  setNow(); hooks = { floors, held };
  noNew = manageOnly ? 'the session is ending — open positions are managed, no new trades (the next session takes over)'
    : sessionEnding() ? 'this session ends in under 10 minutes — no new trades until the next one takes over' : '';
  const before = acts.length, t0 = Date.now();
  try { await run(); } catch (e) { engine.errors++; engine.lastError = String(e.message || e).slice(0, 120); engine.hourErrors.push(Date.now()); act('Error: ' + (e.message || e)); const k = 'err:' + (e.message || '').slice(0, 40); if (!seen.has(k) || Date.now() - seen.get(k) > 30 * 60000) { seen.set(k, Date.now()); alerts.push('\u26a0\ufe0f Bot error: ' + (e.message || e)); } }
  engine.cycleMs = Date.now() - t0; engine.cycleMax = Math.max(engine.cycleMax, engine.cycleMs); engine.cycles++; engine.at = Date.now();
  engine.hourErrors = engine.hourErrors.filter(t => Date.now() - t < 3600e3);
  await flushAlerts();
  pendingActs += acts.length - before;
  if ((journal || pendingActs) && !publishing) { await writeJournal().catch(e => console.log('journal error', e.message)); pendingActs = 0; }   // never while git is publishing the file (live.mjs)
  return { open: !!(lastClock && lastClock.is_open), nextOpen: lastClock && lastClock.next_open };
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
    if (wheelHas(p.symbol)) continue;                                        // the wheel holds its options to the take-profit or expiry, and has no floor
    const pc = +p.unrealized_plpc * 100;
    if (isOpt(p.symbol) && pc <= -(isSpyOption(p.symbol) ? CFG.spyStop : CFG.optStop)) return p.symbol + ' option stop level';   // take-profits rest at the broker as limit orders
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
let publishing = false; export const setPublishing = v => { publishing = !!v; };
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
  for (const s of want) b2[s] = b2[s] || [];                                  // a symbol with no bars is remembered as empty, not refetched every beat
  barsCache = { at: Date.now(), bars: b2 };
  return b2;
}
const completed = (bars, sym) => (bars[sym] || []).filter(b => b.t.slice(0, 10) < ymdDash(Date.now())).map(b => ({ d: b.t.slice(0, 10), o: b.o, h: b.h, l: b.l, c: b.c }));
const dash8 = s => s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);

// Phone alerts go to the owner's Telegram chat (bot/telegram.mjs). ntfy was removed on 2026-10-23 (public channels).
const sentAlerts = new Map();
async function flushAlerts() {
  if (!alerts.length) return;
  // A buy or sell alert (green / red dot) is held back only when the very same text went out in the last minute: two SPY
  // trades differ only in their numbers, and each must reach the phone. Other alerts (errors, limits) are held back for 20
  // minutes when only their numbers changed.
  const lines = alerts.splice(0).filter(m => { const trade = /^(🟢|🔴)/.test(m), k = trade ? 'trade:' + m : m.replace(/[\d.]+/g, '#'); if (sentAlerts.has(k) && Date.now() - sentAlerts.get(k) < (trade ? 60000 : 20 * 60000)) return false; sentAlerts.set(k, Date.now()); return true; });
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
        const S = lastSplit && lastSplit.on ? lastSplit : null, cs = CFG.callSharePct, ps = CFG.putSharePct, ys = CFG.spyOn ? CFG.spySharePct : 0, sh = { stock: 100 - cs - ps - ys, call: cs, put: ps, spy: ys };
        const kd = p => isOpt(p.symbol) ? (isSpyOption(p.symbol) ? 'spy' : (OPT_RE.exec(p.symbol) || [])[3] === 'P' ? 'put' : 'call') : 'stock';
        const used = { stock: 0, call: 0, put: 0, spy: 0 }; for (const p of pos) used[kd(p)] += val(p);
        const line = k => { const t = S && S[k] ? S[k].today : null, h = S && S[k] && S[k].halted; return `   ${NM[k].Cap}: ${usd(used[k])} of ${usd(stake * sh[k] / 100)} in use${t != null ? ' \u00b7 today ' + sgnUsd(t) : ''} \u00b7 ${h ? '\u26d4 stopped for today' : 'loss limit ' + (k === 'stock' ? CFG.dayCap : k === 'spy' ? CFG.spyDayCap : CFG.optDayCap) + '%'}`; };
        return [`Split ${sh.stock}/${cs}/${ps}${ys ? '/' + ys : ''} (stocks/CALLs/PUTs${ys ? '/SPY' : ''}):`, line('stock'), line('call'), line('put')].concat(ys ? [line('spy')] : []);
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

let sweepAt = 0;
async function run() {
  // ---- kill switch: the very first thing, before any other broker call; every delete on its own; the SPY sleeve disarmed ----
  if (!READONLY && stopSet()) {
    act('STOP file found — cancelling all orders and closing everything.');
    lastSpy = null; spyPendingUntil = Date.now() + 10 * 60000;
    if (!DRY) {
      await T('/v2/orders', { method: 'DELETE' }).catch(e => act('STOP: cancelling orders failed (' + (e.message || e).slice(0, 60) + ') — retrying next check'));
      await T('/v2/positions?cancel_orders=true', { method: 'DELETE' }).catch(e => act('STOP: closing positions failed (' + (e.message || e).slice(0, 60) + ') — retrying next check'));
    }
    return;
  }
  if (!READONLY) await ensureUniverse();
  await loadCalendar();
  if (!lastClock || Date.now() - (lastClock._at || 0) > 30000) { lastClock = await T('/v2/clock'); lastClock._at = Date.now();
    try { const nc = lastClock.next_close, ep = nc ? etParts(new Date(nc)) : null; if (ep && ep.year + ep.month + ep.day === TODAY) CLOSE = (+ep.hour % 24) * 60 + +ep.minute; } catch (e) {}   // the broker's clock knows early-close days
  }
  if (!memRestored) {                                                      // first cycle of this process: pick up today's day-state from the previous run's journal
    memRestored = true;
    try { const pv = await previousJournal(); if (pv && pv.mem && pv.mem.wheel && pv.mem.wheel.opts) wheelMem = pv.mem.wheel; if (pv && pv.mem && pv.mem.day === TODAY) { Object.assign(lastDayPx, pv.mem.lastDayPx || {}); if (pv.mem.userPause) userPause = true; for (const k of pv.mem.haltSaid || []) haltSaid.add(k); if (pv.mem.spyLevels && pv.mem.spyLevels.day === TODAY) spyLevels = pv.mem.spyLevels; if (pv.mem.userPause) act('Restarted: still paused from Telegram (/resume to allow new entries)'); } } catch (e) {}
  }
  const clock = lastClock;
  if (READONLY) return;                                                    // journal only: nothing is placed, changed or cancelled
  if (!clock.is_open) {
    // No entry order may rest while the market is closed: a dip-buy is good-till-cancelled (its broker stop must survive the
    // night), so one left by a session that ended before 3:55 PM would fill at the next open, maybe on a gap down. The
    // session that starts at 9:20 cancels it before the bell (checked every 5 minutes while closed).
    if (Date.now() - sweepAt > 5 * 60000) {
      sweepAt = Date.now();
      try {
        for (const o of (await T('/v2/orders?status=open&limit=500')) || []) if (o.side === 'buy' && /^sd-/.test(cidOf(o)) && !isWheelBuy(cidOf(o))) {   // a wheel buy-back only closes a sold option: it may rest overnight
          act(`${o.symbol} buy at ${o.limit_price} still resting while the market is closed — cancelled (no entry order is left to fill at the open)`);
          if (!DRY) await T('/v2/orders/' + o.id, { method: 'DELETE' }).catch(() => {});
        }
      } catch (e) { console.log('closed-market order check failed', e.message); }
    }
    console.log('Market closed.'); return;
  }
  // the four account questions are independent: ask them at once instead of one after another (cycle time roughly halves)
  const snapAt = Date.now();                                               // when this cycle's picture of the account was taken (the SPY lane may act after it)
  const [acct, positions, openOrders, hist] = await Promise.all([
    T('/v2/account'), T('/v2/positions'), T('/v2/orders?status=open&limit=500'),
    orderHistory(45),
  ]);
  // The stake: with stakeUsd set, the bot behaves as if the account held only that much — every size, loss limit and the
  // pattern-day-trader rule are computed on it — so a $100k practice account trades exactly like the money you mean to use.
  const acctEq = +acct.equity, acctLast = +acct.last_equity || acctEq;
  const stake = CFG.stakeUsd > 0 ? Math.min(CFG.stakeUsd, acctEq) : acctEq;
  const equity = stake, lastEq = CFG.stakeUsd > 0 ? stake - (acctEq - acctLast) : acctLast;    // today's change is the account's real change, applied to the stake
  posBySym = Object.fromEntries(positions.map(p => [p.symbol, p]));
  // ---- the wheel's bookkeeping (bot/wheel.mjs): what it holds, and what changed since the last check (expired, assigned, called away) ----
  { const R = wheelReconcile({ mem: wheelMem, positions, hist, today: ymdDash(Date.now()), now: new Date().toISOString() }); wheelMem = R.mem; for (const e of R.events) { const m = wheelEventText(e); act(m); alerts.push('\ud83d\udd01 ' + m); } }
  const wheelOrderSyms = new Set(hist.concat(openOrders).filter(o => isWheelId(cidOf(o)) && (String(o.filled_at || o.updated_at || o.submitted_at || '').slice(0, 10) === ymdDash(Date.now()) || ['new', 'accepted', 'partially_filled', 'held', 'pending_new'].includes(o.status))).map(o => o.symbol));   // its working orders and contracts it traded today — an old trade in a contract another part holds now does not make that position the wheel's
  const wheelUnds = new Set([...Object.values(wheelMem.opts).map(x => x.und), ...Object.keys(wheelMem.shares), ...openOrders.filter(o => isWheelSell(cidOf(o))).map(o => (parseOcc(o.symbol) || {}).und).filter(Boolean)]);
  const isWheelPos = sym => wheelHas(sym) || (isOpt(sym) && !posBySym[sym] && wheelOrderSyms.has(sym));   // its sold options and the shares a put delivered; a contract it bought back today (no position left) for today's fills
  const stockPos = positions.filter(p => !isOpt(p.symbol)), optPos = positions.filter(p => isOpt(p.symbol));
  if (hooks.held) { hooks.held.clear(); positions.forEach(p => hooks.held.add(isOpt(p.symbol) ? OPT_RE.exec(p.symbol)[1] : p.symbol)); }
  if (hooks.floors) { const seenF = new Set(); for (const p of stockPos) { if (wheelHas(p.symbol)) continue; seenF.add(p.symbol); hooks.floors(p.symbol, HOLD_FLOOR > 0 ? +p.avg_entry_price * (1 - HOLD_FLOOR / 100) : null); } for (const sym of flooredSyms) if (!seenF.has(sym)) hooks.floors(sym, null); flooredSyms = seenF; }   // sold symbols lose their floor, or a stale level keeps waking the loop

  // ---- news & events guard (calendar + live headlines + SPY tone) ----
  if (Date.now() - newsCache.at > 60000) {
    try {
      const since = h => new Date(Date.now() - h * 3600e3).toISOString();
      const mk = (await D(`/v1beta1/news?limit=50&sort=desc&start=${since(3)}`)).news || [];
      const newsSyms = CFG.universe === 'scan' ? [...new Set((lastWatch ? lastWatch.buy.concat(lastWatch.put) : []).concat(positions.map(p => isOpt(p.symbol) ? OPT_RE.exec(p.symbol)[1] : p.symbol), lastDay && lastDay.setups ? lastDay.setups.map(x => x.sym) : []))] : UNIVERSE;   // day setups found last check are covered from the next refresh
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
      spyPrev = prev ? { day: TODAY, c: prev.c, closes: done.map(b => b.c), days: done.map(b => b.t.slice(0, 10)) } : null;
    }
    const st = (await latestPrices(['SPY'])).SPY;
    if (spyPrev && st) spyPct = (st.p / spyPrev.c - 1) * 100;
  } catch (e) {}
  if (CFG.eventGuard) { const ev = loadEvents(), lastEv = ev.length ? ev[ev.length - 1].date : '', td = ymdDash(Date.now());
    if (!lastEv || Date.parse(lastEv) - Date.parse(td) < 45 * 864e5) { const k = 'cal:' + td; if (!haltSaid.has(k)) { haltSaid.add(k); act('Calendar warning: the economic calendar (events.json) ' + (lastEv ? 'ends ' + lastEv : 'is empty') + ' — add the next dates or the news/event guard stops seeing Fed days and CPI/jobs reports.'); } } }
  const G = lastGuard = guard({ events: CFG.eventGuard ? loadEvents() : [], todayDash: ymdDash(Date.now()), mins: MINS, headlines: CFG.newsGuard ? newsCache.market : [], spyPct });
  G.spyPct = spyPct; G.newsOk = newsCache.ok;
  const RG = regimeOf(spyPrev && spyPrev.closes);
  G.regime = RG.regime; G.longSize = 1;
  // real money starts small: every budget and risk figure is scaled by the live size setting (paper is always 100%)
  const liveScale = CFG.mode === 'live' ? CFG.liveSizePct / 100 : 1;
  if (liveScale < 1) { G.budget = (G.budget || 1) * liveScale; G.reasons.push(`Live trading at ${CFG.liveSizePct}% of the paper size (ramp-up setting)`); }
  // market filter (setting): no new dip buys — stocks or CALLs — while SPY's last close is below its 200-day average. With the
  // first-profitable-close exit this cut the worst fall of the 33-year test from -40% to -18% (tools/winrate-study.mjs).
  const MF = marketAbove200(spyPrev && spyPrev.closes);
  G.mkt = MF; G.mktBlock = CFG.marketFilter && !(MF && MF.above) ? (MF ? `SPY closed at ${MF.last}, below its 200-day average ${MF.s200}` : 'SPY\'s 200-day average is not known yet') : null;
  if (G.mktBlock) G.reasons.push(`Market filter: ${G.mktBlock} \u2014 no new dip buys (stocks and CALLs); open positions are managed as usual`);
  if (RG.regime === 'bear') G.reasons.push('Bear market regime (SPY below its 50- and 200-day averages) \u2014 fewer stocks qualify, since each must be above its own 200-day');   // reported, not enforced: the filter did not improve RSI-2 in the research
  // (neutral regime: no size change for RSI-2)
  // circuit breakers: losing streak today, weekly drawdown
  const sideStreak = { stock: null, call: null, put: null, spy: null };
  try {
    const posSig = positions.map(p => p.symbol + ':' + p.qty).sort().join(',');
    if (Date.now() - fillsCache.at > 60000 || fillsCache.posSig !== posSig || missingFill.size) {   // a position changed (or a sell fill is still missing): re-read today's fills before any day P/L is trusted
      const f = await todaysFills();
      fillsCache = { at: Date.now(), closed: buildJournal(withOpenings(f, hist, ymdDash(Date.now())), []).closed, fills: f, posSig };   // swing trades sold today count too (their buy was on an earlier day)
    }
    if (CFG.split) {                                                     // with the money split, a losing streak stops only its own side
      for (const [k, kind] of [['stock', 'Stock'], ['call', 'Call'], ['put', 'Put']]) {
        const n = lossStreak(fillsCache.closed.filter(c => c.kind === kind && !isSpyOption(c.sym) && !c.wheel));   // the wheel's trades are its own
        if (n >= MAX_STREAK) sideStreak[k] = `${n} losing ${NM[k].one} trades in a row today`;
      }
    } else {
      const streak = lossStreak(fillsCache.closed.filter(c => !c.wheel));
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
    spy:   { per: equity * (CFG.spyOn ? CFG.spySharePct : 0) / 100, cap: 0, used: 0 },     // the SPY sleeve spends its whole share on one trade at a time
    wheel: { per: 0, cap: 0, used: 0 },                                                       // set from the wheel's own count (strikes set aside + shares), below
  };
  const kindOf = sym => isWheelPos(sym) ? 'wheel' : !isOpt(sym) ? 'stock' : isSpyOption(sym) ? 'spy' : (OPT_RE.exec(sym) || [])[3] === 'P' ? 'put' : 'call';
  for (const p of positions) SL[kindOf(p.symbol)].used += Math.abs(+p.market_value || 0);
  // ---- money split: stocks and options each own a share of the stake and have their own daily loss limit ----
  const wheelHeld = equity > 0 ? Math.round(wheelSetAside(positions, openOrders) / equity * 1000) / 10 : 0;   // % of the stake it has set aside now
  const SPLIT = !!CFG.split, KINDS = ['stock', 'call', 'put', 'spy', 'wheel'], spyShare = CFG.spyOn ? CFG.spySharePct : 0, wheelShare = Math.max(CFG.wheelOn ? CFG.wheelSharePct : 0, wheelHeld);   // switched off (or above its share) it keeps what it holds until that is gone
  // When what the wheel holds outgrows the room the other shares leave (its share was cut while a put was open, or equity
  // fell hard), the stake must still not be promised twice: stocks give way first, then CALLs, PUTs and SPY shrink together,
  // so the five budgets never add up to more than 100 % of the stake.
  const base3 = CFG.callSharePct + CFG.putSharePct + spyShare, f3 = SPLIT && base3 > 0 && base3 + wheelShare > 100 ? Math.max(0, 100 - wheelShare) / base3 : 1, r10 = v => Math.round(v * 10) / 10;
  const share = { call: r10(CFG.callSharePct * f3), put: r10(CFG.putSharePct * f3), spy: r10(spyShare * f3), wheel: wheelShare, stock: Math.max(0, r10(100 - base3 * f3 - wheelShare)) };
  // the SPY sleeve always lives on its own share (even with the split off): it is an experiment and must never spend the others' money
  // (the wheel too: its puts set strikes aside for weeks, so it has no daily loss limit — capPct 100 never stops it)
  const SIDE = Object.fromEntries(KINDS.map(k => [k, { money: k === 'spy' ? equity * share.spy / 100 : k === 'wheel' ? equity * wheelShare / 100 : SPLIT ? equity * share[k] / 100 : equity, capPct: k === 'spy' ? CFG.spyDayCap : k === 'wheel' ? 100 : !SPLIT ? LOSS_CAP : k === 'stock' ? LOSS_CAP : CFG.optDayCap }]));
  const sideUsed = k => SL[k].used;
  const slBudget = k => Math.max(0, Math.min(SL[k].per * G.budget, SL[k].cap > 0 ? SL[k].cap - SL[k].used : Infinity, SPLIT ? SIDE[k].money - SL[k].used : Infinity));
  const capNote = k => SPLIT && SIDE[k].money - SL[k].used < SL[k].per ? ` (${NM[k].one} money $${Math.round(SIDE[k].money)}, $${Math.round(SL[k].used)} already in use)`
    : SL[k].cap > 0 && SL[k].cap - SL[k].used < SL[k].per ? ` (${k} money ceiling $${Math.round(SL[k].cap)}, $${Math.round(SL[k].used)} already in use)` : '';
  const capHit = dayPct <= -LOSS_CAP;
  for (const p of positions) if (+p.lastday_price > 0) lastDayPx[p.symbol] = +p.lastday_price;
  const sideDay = sideDayPl({ positions, fills: fillsCache.fills || [], lastDay: lastDayPx, spy: isSpyOption, wheel: isWheelPos });
  // a position that disappeared since the last check must have its sell fill listed, or its whole cost would count as a loss
  const heldNow = new Map(positions.map(p => [p.symbol, +p.qty || 0])), closeListed = (sym, short) => (fillsCache.fills || []).some(f => f.symbol === sym && (short ? /^buy/.test(f.side) : !/^buy/.test(f.side)));   // a sold option (the wheel) closes with a buy
  for (const [sym, q] of prevHeld) if (!heldNow.has(sym) && !closeListed(sym, q < 0) && !missingFill.has(sym)) missingFill.set(sym, { t0: Date.now(), short: q < 0 });   // sticky: stays until the broker lists the closing fill (not just for one cycle)
  for (const [sym, m] of [...missingFill]) if (heldNow.has(sym) || closeListed(sym, m.short) || Date.now() - m.t0 > 10 * 60000) missingFill.delete(sym);   // 10 min: an exercise, assignment or symbol change never lists a fill
  const fillsLag = missingFill.size > 0;
  prevHeld = heldNow;
  const halt = { stock: null, call: null, put: null, spy: null, wheel: null }; spyCapHit = false;
  { const n = lossStreak(fillsCache.closed.filter(c => isSpyOption(c.sym))); if (n >= CFG.spyStreak) sideStreak.spy = `${n} losing SPY option trades in a row today`; }
  if (SPLIT) for (const k of KINDS) {
    if (k === 'wheel') { SIDE.wheel.today = sideDay.wheel; SIDE.wheel.limit = SIDE.wheel.money; continue; }   // no daily loss limit (see above)
    const S = SIDE[k]; S.today = sideDay[k]; S.limit = S.money * S.capPct / 100;
    if (S.money > 0 && S.today <= -S.limit && !fillsLag) { halt[k] = `${NM[k].many} down $${Math.round(-S.today)} today \u2014 past the ${S.capPct}% limit on its $${Math.round(S.money)}`; if (k === 'spy') spyCapHit = true; }
    else if (sideStreak[k]) halt[k] = sideStreak[k];
  } else { if (capHit) halt.stock = halt.call = halt.put = `daily loss cap ${LOSS_CAP}% hit`;
    const S = SIDE.spy; S.today = sideDay.spy; S.limit = S.money * S.capPct / 100;                        // the SPY sleeve keeps its own brakes either way
    if (S.money > 0 && S.today <= -S.limit && !fillsLag) { halt.spy = `SPY options down $${Math.round(-S.today)} today \u2014 past the ${S.capPct}% limit on its $${Math.round(S.money)}`; spyCapHit = true; } else if (sideStreak.spy) halt.spy = sideStreak.spy; }
  for (const k of KINDS) if (halt[k] && k !== 'wheel' && !haltSaid.has(TODAY + k)) {
    haltSaid.add(TODAY + k);
    if (!SPLIT && k !== 'spy') { if (k === 'stock') alerts.push(`\u26d4 ${halt[k]} \u2014 no new trades today`); continue; }
    const others = KINDS.filter(x => x !== k && !halt[x] && (x !== 'wheel' || CFG.wheelOn)).map(x => NM[x].many);   // the wheel is named only when it is switched on
    // what happens to what is open: SPY options are closed only by the money limit (a losing streak just stops new ones);
    // CALLs and PUTs are closed under the "bounce" sell rule, and kept to their own exits under "target" (the study held them)
    const closes = k === 'spy' ? spyCapHit : k !== 'stock' && CFG.optExit !== 'target';
    const msg = `${halt[k]} \u2014 no new ${NM[k].one} trades today${k === 'stock' ? '' : closes ? '; open ' + NM[k].many + ' are closed' : '; open ' + NM[k].many + ' keep their own exits'}${others.length ? '; ' + others.join(' and ') + ' carry on' : ''}`;
    act(msg); alerts.push('\u26d4 ' + msg);
  }

  // ---- cancel stale entries; at the end of the day, every resting entry (a GTC buy left overnight would fill on a gap-down open) ----
  const eod = MINS >= CLOSE - 5;
  for (const o of openOrders) {
    if (o.side !== 'buy' || !/^sd-[sorqp]-/.test(cid(o))) continue;
    const stale = Date.now() - Date.parse(o.submitted_at || o.created_at || Date.now()) > STALE_MIN * 60000;
    if (stale || eod) {
      act(`${o.symbol} buy at ${o.limit_price} ${eod ? 'still unfilled at the close' : 'unfilled for ' + STALE_MIN + ' min'} \u2014 cancelled (${eod ? 'no entry orders are left overnight' : 'setup is stale'})`);
      if (!DRY) await T('/v2/orders/' + o.id, { method: 'DELETE' }).catch(() => {});
      o._cancelled = true;
    }
  }
  // ---- resting sell orders for something no longer held (a leg whose cancel failed, a stop left after a take-profit) ----
  { const heldSyms = new Set(positions.map(p => p.symbol));
    const buying = new Set(openOrders.filter(o => o.side === 'buy').map(o => o.symbol));
    for (const o of openOrders) if (o.side === 'sell' && !o._cancelled && !isWheelSell(cid(o)) && !heldSyms.has(o.symbol) && !buying.has(o.symbol) && o.status !== 'held' && (/^sd-/.test(cid(o)) || /stop/.test(o.type)) && Date.now() - Date.parse(o.submitted_at || o.created_at || Date.now()) > 90000) {
      act(`${o.symbol}: a ${o.type} sell order is resting for a position no longer held \u2014 cancelled (it could have opened a short)`);
      if (!DRY) await T('/v2/orders/' + o.id, { method: 'DELETE' }).catch(() => {}); o._cancelled = true;
    } }
  const liveOrders = openOrders.filter(o => !o._cancelled);
  for (const o of liveOrders) if (o.side === 'buy') SL[kindOf(o.symbol)].used += (+o.qty || 0) * (+o.limit_price || 0) * (isOpt(o.symbol) ? 100 : 1);
  // ---- SPY quick options: its own engine, every beat (manages its open trade even when switched off) ----
  try { await spyCycle({ equity, acct, positions, hist, liveOrders, G, halt, SIDE, sellsFor, cid, snapAt }); }
  catch (e) { act('SPY options engine error: ' + (e.message || e).slice(0, 120)); }
  // ---- the wheel: cash-secured puts and covered calls on its own share (bot/wheel.mjs); manages what is open even when off ----
  try { await wheelLane({ equity, positions, hist, liveOrders, G, pdtNear, claim: wheelUnds }); if (lastWheel) SL.wheel.used = lastWheel.used; }
  catch (e) { act('Wheel engine error: ' + (e.message || e).slice(0, 120)); }
  const r0 = x => Math.round(x);
  lastSplit = { at: new Date().toISOString(), on: SPLIT, shares: share, stake: r0(equity),
    ...Object.fromEntries(KINDS.map(k => [k, { money: r0(SIDE[k].money), used: r0(sideUsed(k)), today: SPLIT ? sideDay[k] : null, limitPct: SIDE[k].capPct, halted: halt[k] }])) };

  // ---- RSI-2 swing positions: sold at the close by the chosen rule (exitRule: the bounce above the 5-day average, or the first
  //      close at least exitProfitPct % above the buy price), or after maxHold sessions; take-profit and stop any time ----
  // Which positions are the bot's: the latest buy with its own id, and only the part of the position that buy still accounts
  // for (ownQty). A later position in the same symbol bought by hand is never managed or sold by these rules.
  const mine = (p, pre) => { const e = latestBuy(hist, o => o.symbol === p.symbol && pre.some(x => cid(o).startsWith(x + p.symbol + '-'))); return { p, e, q: ownQty(p, e, hist) }; };
  const handNote = x => { if (x.e && !(x.q > 0) && +x.p.qty > 0 && latestBuy(hist, o => o.symbol === x.p.symbol && /^sd-/.test(cid(o))) === x.e && !haltSaid.has('hand:' + TODAY + x.p.symbol)) { haltSaid.add('hand:' + TODAY + x.p.symbol); act(`${x.p.symbol}: held, but the bot's own buy of it was sold since — this position was bought by hand, so the bot leaves it alone`); } return x.q > 0; };   // no note when a later bot buy of another kind (a day trade) holds it, nor for a short
  const swingStk = stockPos.map(p => mine(p, ['sd-r-'])).filter(handNote);
  const swingOpt = optPos.map(p => mine(p, ['sd-q-', 'sd-p-'])).filter(handNote);
  if (swingStk.length || swingOpt.length) {
    const unds = [...new Set(swingStk.map(x => x.p.symbol).concat(swingOpt.map(x => OPT_RE.exec(x.p.symbol)[1])))];
    const bars0 = await loadBars(unds);
    const lastU = await latestPrices(unds);
    const held = (sym, day8) => { if (day8 === TODAY) return 0; return completed(bars0, sym).filter(b => b.d > dash8(day8)).length + 1; };
    for (const { p, e, q } of swingStk) {
      if (sellsFor(p.symbol).some(o => o.type === 'market')) continue;
      const day8 = cid(e).split('-')[4], plpc = +p.unrealized_plpc * 100, px = lastU[p.symbol] && lastU[p.symbol].p;
      const legs = sellsFor(p.symbol), brokerStop = legs.some(o => /stop/.test(o.type));
      const out = async why => closeOut(p.symbol, q, legs, why);
      const livePl = px ? (px / +p.avg_entry_price - 1) * 100 : plpc;
      if (HOLD_FLOOR > 0 && !brokerStop && Math.min(plpc, livePl) <= -HOLD_FLOOR) { await out(`${p.symbol} down ${Math.min(plpc, livePl).toFixed(1)}% — hit the ${HOLD_FLOOR}% hard floor`); continue; }
      if (HOLD_FLOOR > 0 && !brokerStop && !legs.length && px && MINS < CLOSE - 5) {           // a position without a broker stop (older entry, or the leg was rejected): put one on
        const fp = tick(+p.avg_entry_price * (1 - HOLD_FLOOR / 100));
        await send({ symbol: p.symbol, qty: String(q), side: 'sell', type: 'stop', stop_price: String(fp), time_in_force: 'gtc', client_order_id: 'sd-x-' + p.symbol + '-' + rid() }, `${p.symbol} — protective stop placed at the broker (${fp})`);
      }
      if (HOLD_FLOOR > 0 && brokerStop && px) {                          // the stop setting was tightened: bring older broker stops up to it
        const fp = tick(+p.avg_entry_price * (1 - HOLD_FLOOR / 100)), leg = legs.find(o => /stop/.test(o.type));
        const oldLeg = leg && +leg.stop_price < fp - 0.005;               // only an older, wider stop is touched; a correct one is left to the broker (no double sale)
        if (oldLeg && px <= fp) { await out(`${p.symbol} down ${livePl.toFixed(1)}% — below the ${HOLD_FLOOR}% stop`); continue; }
        if (oldLeg && !stopMoved.has(leg.id)) {
          stopMoved.add(leg.id);
          if (!DRY) await T('/v2/orders/' + leg.id, { method: 'PATCH', body: JSON.stringify({ stop_price: String(fp) }) }).then(() => act(`${p.symbol} broker stop moved up to ${fp} (${HOLD_FLOOR}% below the buy price)`)).catch(e2 => act(`${p.symbol} could not move the broker stop (${(e2.message || e2).slice(0, 60)}) — the bot watches the ${HOLD_FLOOR}% stop instead`));
        }
      }
      // quick take-profit: sell as soon as the gain reaches the target, at any time of day (same day only when the day-trade rule allows)
      if (CFG.stockTp > 0 && px && livePl >= CFG.stockTp && (day8 !== TODAY || !pdtNear)) { await out(`${p.symbol} +${livePl.toFixed(1)}% — take profit (target ${CFG.stockTp}%)`); continue; }
      if (MINS < CLOSE - 10 || !px) continue;                           // exits happen in the last 10 minutes, like a closing order
      const h = held(p.symbol, day8); if (h === 0) continue;             // never sell on the day it was bought
      const x = CFG.exitRule === 'profit' ? profitExit(+p.avg_entry_price, px, h, CFG.maxHold, CFG.exitProfitPct) : rsi2Exit(completed(bars0, p.symbol).map(b => b.c), px, h, CFG.maxHold);
      if (x.exit) await out(`${p.symbol} ${CFG.exitRule === 'profit' ? 'profit exit' : 'RSI-2 exit'} — ${x.why} (${plpc >= 0 ? '+' : ''}${plpc.toFixed(2)}%)`);
    }
    // Swing CALLs / PUTs. The take-profit is a resting limit order at the broker (optTakeProfit); the bot sells at market only
    // for the stop, the expiry, a Fed decision, the closing-time rule, and — under the "bounce" sell rule — a daily loss limit.
    for (const { p, e, q } of swingOpt) {
      const sells = sellsFor(p.symbol); if (sells.some(o => o.type === 'market')) continue;
      const parts = cid(e).split('-'), day8 = parts[3], und = OPT_RE.exec(p.symbol)[1], exp = '20' + OPT_RE.exec(p.symbol)[2];
      const plpc = +p.unrealized_plpc * 100, avg = +p.avg_entry_price, px = lastU[und] && lastU[und].p, K = cid(e).startsWith('sd-p-') ? 'PUT' : 'CALL';
      const out = async why => closeOut(p.symbol, q, sells, why);
      const daysToExp = (Date.parse(dash8(exp)) - Date.parse(ymdDash(Date.now()))) / 864e5;
      const h = MINS >= CLOSE - 10 && px ? held(und, day8) : 0;          // the closing-time rule, from the day after the buy
      const closeWhy = !(h > 0) ? null : CFG.optExit === 'target' ? (h >= CFG.maxHold ? `held ${h} sessions — selling the ${K} (max hold)` : null)   // 'target': no bounce exit, only take-profit, stop, max hold, expiry
        : (() => { const x = (K === 'PUT' ? rsi2ShortExit : rsi2Exit)(completed(bars0, und).map(b => b.c), px, h, CFG.maxHold); return x.exit ? `stock ${x.why} — selling the ${K}` : null; })();
      if (plpc <= -CFG.optStop) await out(`${p.symbol} ${plpc.toFixed(0)}% — option stop`);
      else if (halt[kindOf(p.symbol)] && CFG.optExit !== 'target') await out(`${p.symbol} ${SPLIT ? NM[kindOf(p.symbol)].one + ' daily loss limit' : 'daily loss cap'} hit — closing options`);   // under 'target' a loss limit only stops new trades: the study held each trade to its own exits
      else if (G.closeOptionsAt != null && MINS >= G.closeOptionsAt) await out(`${p.symbol} Fed decision in minutes — closing options`);
      else if (daysToExp <= 3) await out(`${p.symbol} ${daysToExp} days to expiry — out before time decay accelerates`);
      else if (closeWhy) await out(`${p.symbol} ${closeWhy}`);
      else await optTakeProfit(p, sells, q, avg, pdtNear && day8 === TODAY);
    }
  }

  // ---- manage stock positions (legacy intraday trades, if any remain) ----
  for (const p0 of stockPos) {
    const { p, e, q } = mine(p0, ['sd-s-']);
    if (!(q > 0)) continue;                             // not ours — never touch manual positions
    if (sellsFor(p.symbol).some(o => o.type === 'market')) continue;
    const [, , , tgtC, , day] = cid(e).split('-');
    const tgt = +tgtC / 100, avg = +p.avg_entry_price, plpc = +p.unrealized_plpc * 100;
    const held = day < TODAY;
    const sells = sellsFor(p.symbol);
    const sellAll = async why => closeOut(p.symbol, q, sells, why);
    if (HOLD_FLOOR > 0 && plpc <= -HOLD_FLOOR) { await sellAll(`${p.symbol} down ${plpc.toFixed(1)}% — hit the ${HOLD_FLOOR}% hard floor`); continue; }
    const ageDays = (Date.parse(e.filled_at || e.submitted_at) ? (Date.now() - Date.parse(e.filled_at || e.submitted_at)) / 864e5 : 0);
    if (held && ageDays > MAX_HOLD_DAYS) { await sellAll(`${p.symbol} held ${Math.round(ageDays)} days — max hold reached`); continue; }
    if (!held && MINS >= CLOSE - 15) {
      if (plpc > -HOLD_LOSS) { await sellAll(`${p.symbol} day trade closed at the bell (${plpc >= 0 ? '+' : ''}${plpc.toFixed(2)}%)`); continue; }
      act(`${p.symbol} is down ${plpc.toFixed(2)}% — holding instead of selling at a loss; will exit at breakeven`);
    }
    const goingHeld = held || (MINS >= CLOSE - 15 && plpc <= -HOLD_LOSS);
    const want = goingHeld ? tick(avg * 1.003) : tick(Math.max(avg * 1.002, Math.min(tgt, avg * (1 + TP / 100))));
    const qty = String(q);
    if (!sells.length) await send({ symbol: p.symbol, qty, side: 'sell', type: 'limit', limit_price: String(want), time_in_force: 'gtc', client_order_id: 'sd-x-' + p.symbol + '-' + rid() }, goingHeld ? `${p.symbol} recovery exit` : `${p.symbol} take-profit (first of +${TP}% or target)`);
    else if (Math.abs(+sells[0].limit_price - want) > 0.011 && sells[0].type === 'limit') {
      act(`${p.symbol} moving sell limit ${sells[0].limit_price} → ${want}`);
      if (!DRY) await T('/v2/orders/' + sells[0].id, { method: 'PATCH', body: JSON.stringify({ limit_price: String(want) }) }).catch(e => act(`${p.symbol}: could not move the sell order (${(e.message || e).slice(0, 60)})`));
    }
  }

  // ---- manage option positions (legacy intraday options, if any remain) ----
  // A resting limit sells everything at +OPT_TP% the instant it trades there.
  // The bot cancels it and sells at market for the stop, time stop, expiry and loss cap.
  for (const p0 of optPos) {
    const { p, e, q } = mine(p0, ['sd-o-']);
    if (!(q > 0)) continue;
    if (sellsFor(p.symbol).some(o => o.type === 'market')) continue;
    const day = cid(e).split('-')[3];
    const plpc = +p.unrealized_plpc * 100, avg = +p.avg_entry_price;
    const m = OPT_RE.exec(p.symbol), exp = '20' + m[2];
    const sells = sellsFor(p.symbol);
    const out = async why => closeOut(p.symbol, q, sells, why);
    if (plpc <= -CFG.optStop) await out(`${p.symbol} ${plpc.toFixed(0)}% — option stop`);
    else if (halt[kindOf(p.symbol)]) await out(`${p.symbol} ${SPLIT ? NM[kindOf(p.symbol)].one + ' daily loss limit' : 'daily loss cap'} hit — closing options`);
    else if (G.closeOptionsAt != null && MINS >= G.closeOptionsAt) await out(`${p.symbol} Fed decision in minutes — closing options before the volatility`);
    else if (exp <= TODAY) await out(`${p.symbol} expires today — out`);
    else if (day < TODAY && MINS >= CLOSE - 20) await out(`${p.symbol} time stop — options are held one night at most`);
    else await optTakeProfit(p, sells, q, avg, false);
  }

  // ---- day trading (own windows and limits; manages its open trades every beat, even when the switch is off) ----
  // every swing part is done for the day: each one hit its limit, or is switched off, or has no share of the money (a part
  // that is off must not keep the others' limits from counting — with PUTs off, stocks and CALLs both stopped is all of it)
  const PARTS = ['stock', 'call', 'put'], partOn = { stock: STK_ON, call: OPT_ON, put: PUT_ON };
  const partDone = k => !!halt[k] || !partOn[k] || (SPLIT && !(SIDE[k].money > 0));
  const bothHalted = PARTS.every(partDone) && PARTS.some(k => halt[k]);
  try { await dayTradeCycle({ equity, acct, positions, hist, liveOrders, G, capHit: bothHalted, halt, slBudget, useSL: (k, amt) => { SL[k].used += amt; }, sellsFor, cid, skip: wheelUnds }); }
  catch (e) { act('Day-trade engine error: ' + (e.message || e).slice(0, 120)); }

  // ---- what the bot is looking at (always, even when it cannot enter: the Bot trades tab shows it) ----
  const gated = bothHalted || MINS < G.minStart || MINS >= Math.min(ENTRY_END, CLOSE - 15) || G.block || !!noNew;
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
        undPx: r2d((last[und] && last[und].p) || cl[cl.length - 1] || 0), exitLevel: !opt && CFG.exitRule === 'profit' ? profitExitLevel(avg, CFG.exitProfitPct) : opt && CFG.optExit === 'target' ? null : rsi2ExitLevel(cl), exitSide: isPut ? 'below' : 'above', exitBy: !opt && CFG.exitRule === 'profit' ? 'profit' : opt && CFG.optExit === 'target' ? 'target' : 'bounce' };
      if (!opt) row.floor = HOLD_FLOOR > 0 ? r2d(avg * (1 - HOLD_FLOOR / 100)) : null;
      else if (isSpyOption(p.symbol)) Object.assign(row, { exitBy: 'spy', exitLevel: null, tp: r2d(tickUp(avg * (1 + CFG.spyTp / 100), p.symbol) * mult), stop: r2d(avg * mult * (1 - CFG.spyStop / 100)), holdMin: CFG.spyHoldMin });   // SPY quick trades: their own take-profit, stop and minutes
      else { row.tp = r2d(tickUp(avg * (1 + OPT_TP / 100), p.symbol) * mult); row.stop = r2d(avg * mult * (1 - CFG.optStop / 100)); }
      if (opt) { const m2 = OPT_RE.exec(p.symbol); row.exp = '20' + m2[2].slice(0, 2) + '-' + m2[2].slice(2, 4) + '-' + m2[2].slice(4, 6); }
      if (isWheelPos(p.symbol)) {                                         // the wheel's: a sold option (its buy-back price) or shares a put delivered (their cost)
        const wx = wheelMem.opts[p.symbol], ws = wheelMem.shares[p.symbol];
        Object.assign(row, { wheel: opt ? 'sold' : 'shares', exitBy: 'wheel', exitLevel: null, floor: null, stop: null, tp: opt && wx && CFG.wheelTp > 0 ? r2d(tickDown(wheelTpPrice(wx.prem, CFG.wheelTp), p.symbol) * 100) : null, cost: ws ? ws.cost : null });
      }
      heldRows.push(row);
    }
    lastWatch = { at: new Date().toISOString(), idle: bothHalted ? (SPLIT ? 'all daily loss limits hit' : 'daily loss cap hit') : MINS < G.minStart ? 'before the entry window' : MINS >= Math.min(ENTRY_END, CLOSE - 15) ? `swing entry window closed for today (entries 9:45\u2013${CFG.entryEnd} ET; Bot settings \u2192 4. Strategy)` : userPause ? 'paused from Telegram' : G.block ? 'paused by the market check' : noNew ? noNew : G.mktBlock ? 'market filter: ' + G.mktBlock + ' \u2014 no new dip buys' : null, thr: CFG.rsiThreshold, maxHold: CFG.maxHold, exitRule: CFG.exitRule, exitPct: CFG.exitProfitPct, optExit: CFG.optExit, mktFilter: !!CFG.marketFilter, mkt: G.mkt || null, pickBy: CFG.pickBy || 'dip', held: heldRows, intraday: !!CFG.intraday, universe: CFG.universe, scanned: scanCache.info ? scanCache.info.scanned : null, scanAt: scanCache.info ? scanCache.info.at : null, on: { stocks: STK_ON, calls: OPT_ON, puts: PUT_ON },
      buy: STK_ON ? sigs.map(x => x.sym) : [], call: OPT_ON ? sigs.map(x => x.sym) : [], put: PUT_ON ? shortSigs.map(x => x.sym) : [], total: UNIVERSE.length, rows };
  }
  if (shortSigs.length) act(`RSI-2 pops (PUT candidates): ${shortSigs.map(s => s.sym + ' (' + s.r2 + ')').join(', ')}`, 'pops:' + shortSigs.map(s => s.sym).join(','));   // logged again when the names change, not every time an RSI value moves
  // ---- new entries ----
  if (bothHalted) { if (!SPLIT) act(`Daily loss cap ${LOSS_CAP}% hit (${dayPct.toFixed(2)}%) — no new trades today`); return; }
  if (MINS < G.minStart || MINS >= Math.min(ENTRY_END, CLOSE - 15)) { console.log('Outside the RSI-2 entry window.'); return; }
  if (G.block) { console.log(userPause ? 'Paused from Telegram.' : 'Paused by market check.'); return; }
  if (noNew) { console.log(noNew); return; }

  // ---- portfolio risk: heat (money at risk to the stops) and sector concentration ----
  const stopFor = (sym, ord) => {
    const r = ord && /^sd-r-/.test(cid(ord)) ? ord : hist.find(o => o.side === 'buy' && cid(o).startsWith('sd-r-' + sym + '-'));
    if (r) { const unit = +cid(r).split('-')[3] / 100, base = ord ? +ord.limit_price : +((positions.find(x => x.symbol === sym) || {}).avg_entry_price || 0); return base ? base - unit : null; }
    const src = ord && /^sd-s-/.test(cid(ord)) ? ord : hist.find(o => o.side === 'buy' && cid(o).startsWith('sd-s-' + sym + '-'));
    return src ? +cid(src).split('-')[4] / 100 : null;
  };
  let heat = openRisk({ positions: positions.filter(p => !isWheelPos(p.symbol)), orders: liveOrders.filter(o => !isWheelId(cid(o))), stopFor, optStopFor: sym => (isSpyOption(sym) ? CFG.spyStop : CFG.optStop) / 100 });   // the wheel's money is its own share, set aside in full
  const heatCap = equity * MAX_HEAT / 100;
  const undOf = s => isOpt(s) ? OPT_RE.exec(s)[1] : s;
  const sectorCount = {};
  for (const s of positions.filter(p => !isWheelPos(p.symbol)).map(p => p.symbol).concat(liveOrders.filter(o => o.side === 'buy' && !isWheelId(cid(o))).map(o => o.symbol))) { const k = sectorOf(undOf(s)); sectorCount[k] = (sectorCount[k] || 0) + 1; }
  const sectorFull = sym => sectorOf(sym) !== 'Other' && (sectorCount[sectorOf(sym)] || 0) >= MAX_PER_SECTOR;
  lastRisk = { heatPct: heat / equity * 100, capPct: MAX_HEAT, sectors: sectorCount, regime: G.regime };

  // ---- RSI-2 entries (selected by the 33-year out-of-sample research) ----
  lastSignals = { longs: [], shorts: [], rsi2: sigs, at: Date.now() };
  if (sigs.length) act(`RSI-2 dips ${CFG.intraday ? 'right now (intraday)' : 'today'}${CFG.pickBy === 'leaders' ? ', leaders first' : ''}: ${sigs.map(s => s.sym + ' (RSI-2 ' + s.r2 + (s.lead != null ? ', ' + (s.lead >= 0 ? '+' : '') + s.lead + '% vs market' : '') + ')').join(', ')}`, 'dips:' + sigs.map(s => s.sym).join(','));
  const todays = hist.filter(o => o.side === 'buy' && cid(o).includes('-' + TODAY + '-') && (bought(o) || !['canceled', 'expired', 'rejected'].includes(o.status)));   // a cancelled buy that filled in part still counts

  if (STK_ON && !halt.stock && !G.mktBlock) {
    let slots = MAX_POS - stockPos.length - liveOrders.filter(o => o.side === 'buy' && !isOpt(o.symbol)).length;
    for (const s of sigs) {
      if (slots <= 0) break;
      if (!s.px || wheelUnds.has(s.sym) || stockPos.some(p => p.symbol === s.sym) || liveOrders.some(o => o.symbol === s.sym) || todays.some(o => cid(o).startsWith('sd-r-' + s.sym + '-'))) continue;   // a wheel stock is the wheel's
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
      laneSent.set('stock:' + s.sym, Date.now());
      SL.stock.used += qty * lim; heat += add; sectorCount[sectorOf(s.sym)] = (sectorCount[sectorOf(s.sym)] || 0) + 1; slots--;
    }
  }

  // CALLs on the same RSI-2 dips (puts are off: the short side was not part of the winning research)
  if ((OPT_ON || PUT_ON) && !G.noOptions && !(halt.call && halt.put)) {
    // max option positions counts the swing CALLs and PUTs only (open, and buys working): SPY quick trades, day trades and
    // options bought by hand have their own limits or none
    const swingOpen = swingOpt.length + liveOrders.filter(o => o.side === 'buy' && /^sd-[qp]-/.test(cid(o))).length;
    let slots = MAX_OPT - swingOpen;
    const hasOptOn = und => optPos.some(p => OPT_RE.exec(p.symbol)[1] === und) || liveOrders.some(o => isOpt(o.symbol) && OPT_RE.exec(o.symbol)[1] === und);
    const optSets = [];
    if (OPT_ON && !G.mktBlock) optSets.push(['call', sigs]);
    if (PUT_ON) optSets.push(['put', shortSigs]);
    for (const [kind, list] of optSets) for (const s of list) {
      const K = kind.toUpperCase();
      if (halt[kind]) break;
      // checks that need no broker call come first: a full book, no money or no room under the risk cap stops the list
      // (each candidate below costs two calls — contract and quote — and the list is looked at every few seconds)
      if (slots <= 0) { act(`${K}: ${swingOpen} option trades open or being bought — the most at once (max option positions ${MAX_OPT}); no new ones until one is sold`, 'optfull:' + swingOpen); break; }
      if (!(slBudget(kind) >= 1)) { act(`${K}: no money left for a new one today${capNote(kind)}`, 'optmoney:' + kind); break; }
      if (heat >= heatCap) { act(`${K}: total risk is at the ${MAX_HEAT}% cap — no new option trades until it falls`, 'optheat'); break; }
      // a call is skipped once the dip has bounced 1%+; a put once the pop has already fallen 1%+
      if (!s.px || wheelUnds.has(s.sym) || hasOptOn(s.sym) || laneRecent(kind + ':' + s.sym) || (kind === 'call' ? s.px > s.prevClose * 1.01 : s.px < s.prevClose * 0.99) || (CFG.newsGuard && symbolRisk(s.sym, newsCache.syms)) || sectorFull(s.sym)) continue;
      if (todays.some(o => isOpt(o.symbol) && OPT_RE.exec(o.symbol)[1] === s.sym)) continue;
      // a candidate turned down after a broker call (no contract, no quote, spread too wide, over the budget or the risk cap)
      // is looked at again after 10 minutes, not on every check
      const sk = kind + ':' + s.sym; if ((optSkip.get(sk) || 0) > Date.now()) continue;
      const skip = m => { optSkip.set(sk, Date.now() + 10 * 60000); act(m + ' (looked at again in 10 min)'); };
      const cj = await T(`/v2/options/contracts?underlying_symbols=${s.sym}&type=${kind}&status=active&expiration_date_gte=${ymdDash(Date.now() + (CFG.optDays ?? 14) * 864e5)}&expiration_date_lte=${ymdDash(Date.now() + ((CFG.optDays ?? 14) + 21) * 864e5)}&strike_price_gte=${r2d(s.px * 0.95)}&strike_price_lte=${r2d(s.px * 1.05)}&limit=200`).catch(e => { act(`${s.sym} ${K}: contract list unavailable (${String(e.message || e).slice(0, 60)})`); return null; });
      if (!cj) { optSkip.set(sk, Date.now() + 60000); continue; }                       // a failed call: try again in a minute
      const cs = (cj.option_contracts || []).filter(c => c.tradable !== false);
      if (!cs.length) { skip(`${s.sym} ${K}: no contract ${CFG.optDays ?? 14}–${(CFG.optDays ?? 14) + 21} days out near ${s.px}`); continue; }
      const ex = [...new Set(cs.map(c => c.expiration_date))].sort()[0];
      const c = cs.filter(x => x.expiration_date === ex).sort((a, b) => Math.abs(+a.strike_price - s.px) - Math.abs(+b.strike_price - s.px))[0];
      const q = ((await D(`/v1beta1/options/quotes/latest?symbols=${c.symbol}&feed=indicative`).catch(() => ({}))).quotes || {})[c.symbol];
      if (!q || !(q.ap > 0) || !(q.bp > 0)) { skip(`${c.symbol}: no live quote — skipped`); continue; }
      const maxSpr = Math.min(0.2, CFG.optStop / 200, OPT_TP / 100);    // the spread must be under half the stop (or the stop fires on the spread alone) and under the take-profit (or the spread eats the target)
      if ((q.ap - q.bp) / q.ap > maxSpr) { skip(`${c.symbol}: spread too wide (${q.bp}/${q.ap}, over ${+(maxSpr * 100).toFixed(1)}% for a +${OPT_TP}% take-profit / ${CFG.optStop}% stop) — skipped`); continue; }
      const lim = tick(Math.min(q.ap, (q.ap + q.bp) / 2 * 1.03), c.symbol);
      const qty = optionQty({ equity, riskPct: OPT_RISK_PCT * G.budget, price: lim, budget: slBudget(kind), stopPct: CFG.optStop });
      if (qty < 1) { skip(`${c.symbol}: 1 contract ($${Math.round(lim * 100)}) is above this trade's money budget — skipped${capNote(kind)}`); continue; }
      const addO = qty * lim * 100 * CFG.optStop / 100;                 // money lost if it reaches its stop
      if (heat + addO > heatCap) { skip(`${c.symbol} skipped — total risk would exceed ${MAX_HEAT}% of the account`); continue; }
      await send({ symbol: c.symbol, qty: String(qty), side: 'buy', type: 'limit', limit_price: String(lim), time_in_force: 'day',
        client_order_id: `${kind === 'put' ? 'sd-p-' : 'sd-q-'}${c.symbol}-${TODAY}-${qty}-${rid()}` }, kind === 'put' ? `${s.sym} PUT on RSI-2 pop (RSI-2 ${s.r2}, below 200-day ${s.s200})` : `${s.sym} CALL on RSI-2 dip (RSI-2 ${s.r2})`);
      laneSent.set(kind + ':' + s.sym, Date.now());
      SL[kind].used += qty * lim * 100; heat += addO; sectorCount[sectorOf(s.sym)] = (sectorCount[sectorOf(s.sym)] || 0) + 1; slots--;
    }
  }
}
const optSkip = new Map();                                                 // 'call:SYM' → until when a turned-down candidate is left alone

// ---- journal encryption (public site, private data) ----
// AES-256-GCM with a key derived from the journal passphrase (PBKDF2-SHA256, 600k rounds; older blobs carry their own `iter`).
// The page decrypts with the same passphrase; the bot decrypts its own previous entry at start-up so that nothing is lost
// across restarts (every run is a fresh process — without this, a run that starts after the close, or at 9:20 before the
// open, would publish a journal with no watch list, no market check and an empty action log).
export { encryptJournal, decryptJournal } from './jcrypt.mjs';
import { encryptJournal, decryptJournal } from './jcrypt.mjs';

// The previous journal, as this process knows it: read (and decrypted) once from disk, then kept in memory after each write.
let prevJournal = null, journalLocked = '';   // set when the saved journal must not be overwritten (see writeJournal)
async function previousJournal() {
  if (prevJournal) return prevJournal;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync('bot/journal.json', 'utf8')); } catch (e) { return (prevJournal = {}); }
  if (!raw || !raw.enc) return (prevJournal = raw || {});
  if (!PRIVATE) { journalLocked = 'the journal is encrypted but JOURNAL_KEY is missing'; return (prevJournal = { at: raw.at, sig: raw.sig }); }   // never replace it with a readable one
  try { prevJournal = { ...raw, ...(await decryptJournal(raw, process.env.JOURNAL_KEY)) }; }
  catch (e) { journalLocked = 'the journal could not be decrypted with this JOURNAL_KEY (passphrase changed?)'; prevJournal = { at: raw.at, sig: raw.sig }; }
  return prevJournal;
}
export const _resetPrevJournal = () => { prevJournal = null; journalLocked = ''; };                             // tests only
let actsFlushed = 0, journalActs = null;                                                     // the published action log; `acts` entries past actsFlushed are new
const sameAct = (a, b) => a.t === b.t && a.m === b.m;

// ---- "since the bot started": the real account (stocks + CALLs + PUTs + SPY) against $100k in each fund, same hours ----
// Starts at the first trade the bot ever made (kept in the journal once found). Hourly for the first 30 days, daily after.
// Lives inside the encrypted journal (it shows the account's value).
const SINCE_FUNDS = ['SPY', 'IJH', 'IWM', 'VGT', 'QQQ'];
let sinceCache = { at: 0, v: null };
async function sinceStart(prevSince, fills, acct) {
  const first = (fills || []).map(f => Date.parse(f.transaction_time)).filter(t => t > 0).sort((a, b) => a - b)[0];
  const start = (prevSince && prevSince.start) || (first ? ymdDash(first) : null);
  if (!start) return null;
  const now = Date.now(), tNow = new Date(now).toISOString();
  if (!sinceCache.v || sinceCache.v.start !== start || now - sinceCache.at > 10 * 60000) {
    const days = (now - Date.parse(start + 'T12:00:00Z')) / 864e5, hourly = days <= 30;
    const from = start + 'T12:00:00Z';                                                  // before the open in both summer and winter time
    const v = { start, tf: hourly ? 'hour' : 'day', pts: [], bench: {} };
    try {
      const ph = await T(`/v2/account/portfolio/history?timeframe=${hourly ? '1H' : '1D'}&start=${from}&intraday_reporting=market_hours`);
      (ph && ph.timestamp || []).forEach((t, i) => { const e = ph.equity && ph.equity[i]; if (e > 0 && t * 1000 >= Date.parse(from) - 864e5) v.pts.push([new Date(t * 1000).toISOString(), +e]); });
    } catch (e) { v.err = 'account history unavailable'; }
    try {
      const b = (await D(`/v2/stocks/bars?symbols=${SINCE_FUNDS.join(',')}&timeframe=${hourly ? '1Hour' : '1Day'}&start=${from}&limit=10000&feed=iex&adjustment=all&sort=asc`)).bars || {};
      for (const sym of SINCE_FUNDS) { const arr = (b[sym] || []).filter(x => x.o > 0 && x.c > 0); if (arr.length) v.bench[sym] = { base: arr[0].o, pts: arr.map(x => [x.t, x.c]) }; }
    } catch (e) { v.err = (v.err ? v.err + '; ' : '') + 'fund prices unavailable'; }
    sinceCache = { at: now, v };
  }
  const v = { ...sinceCache.v, at: tNow, bench: { ...sinceCache.v.bench } };
  if (!v.pts.length && +acct.equity > 0) v.pts = [[tNow, +acct.equity]];
  v.base = v.pts.length ? v.pts[0][1] : +acct.equity;                                  // the account's value before its first trade
  v.pts = v.pts.concat([[tNow, +acct.equity]]);                                         // and right now
  try { const lp = await latestPrices(SINCE_FUNDS); for (const sym of SINCE_FUNDS) if (v.bench[sym] && lp[sym] && lp[sym].p > 0) v.bench[sym] = { ...v.bench[sym], pts: v.bench[sym].pts.concat([[tNow, lp[sym].p]]) }; } catch (e) {}
  return v;
}
async function writeJournal() {
  const acct = await T('/v2/account');
  const positions = await T('/v2/positions');
  let fills = [], token = '';
  const since = ymdDash(Date.now() - 60 * 864e5);                                                // 60 days of fills is all the journal needs (older trades are already closed in it)
  for (let k = 0; k < 30; k++) {
    const j = await T('/v2/account/activities/FILL?direction=asc&page_size=100&after=' + since + 'T00:00:00Z' + (token ? '&page_token=' + token : ''));
    if (!j || !j.length) break;
    fills = fills.concat(j);
    if (j.length < 100) break;
    token = j[j.length - 1].id;
  }
  let nta = [];                                                                                  // option expiries, assignments and the shares they move: no fill of their own
  for (let k = 0, tok = ''; k < 10; k++) { const j = await T('/v2/account/activities?activity_types=OPEXP,OPASN,OPEXC,OPTRD&direction=asc&page_size=100&after=' + since + 'T00:00:00Z' + (tok ? '&page_token=' + tok : '')).catch(() => null); if (!Array.isArray(j) || !j.length) break; nta = nta.concat(j); if (j.length < 100) break; tok = j[j.length - 1].id; }
  const optEv = optionEvents(nta);
  const { closed, open } = buildJournal(fills.concat(optEv.fills), positions, optEv.events);
  for (const o of open) if (wheelHas(o.sym)) o.wheel = true;                                     // the wheel's sold options and the shares a put delivered
  const prev = await previousJournal();
  if (journalLocked && process.env.JOURNAL_RESET !== '1') { const k = 'jlock'; if (!haltSaid.has(k)) { haltSaid.add(k); act('Journal NOT saved: ' + journalLocked + '. Trading is unaffected. Fix the JOURNAL_KEY secret (or set JOURNAL_RESET=1 once to start a new journal).'); } console.log('journal not written:', journalLocked); return; }
  if (!journalActs) journalActs = (prev.acts || []).filter(a => a && a.t && a.m);
  for (const a of acts.slice(actsFlushed)) if (!journalActs.some(b => sameAct(a, b))) journalActs.push(a);   // append only what is new, once
  actsFlushed = acts.length; journalActs = journalActs.slice(-80);
  const allActs = journalActs;
  const env = lastGuard ? { at: new Date().toISOString(), block: lastGuard.block, regime: lastGuard.regime, reasons: lastGuard.reasons, today: lastGuard.today, upcoming: lastGuard.upcoming, flagged: lastGuard.flagged, spyPct: lastGuard.spyPct, newsOk: lastGuard.newsOk } : (prev.env || null);
  const lastAct = allActs[allActs.length - 1];
  const sig = JSON.stringify([userPause, haltSaid.size, closed.length, closed[0] && closed[0].outT, open.map(o => o.sym + o.qty), allActs.length, lastAct && lastAct.t, env && env.reasons, env && env.flagged && env.flagged.length]);
  const sigCmp = PRIVATE ? (await import('node:crypto')).createHash('sha256').update(sig).digest('hex').slice(0, 16) : sig;
  if (prev.sig === sigCmp && prev.at && Date.now() - Date.parse(prev.at) < 10 * 60000) { console.log('journal unchanged'); return; }
  const j = { at: new Date().toISOString(), sig, paper: /paper/.test(BASE), done: !!(lastClock && !lastClock.is_open && MINS >= CLOSE),   // the closing cycle ran: the queued run after the bell has nothing to do
    account: { equity: +acct.equity, last_equity: +acct.last_equity, cash: +acct.cash }, closed, open, acts: allActs, env,
    settings: { ...CFG, summary: cfgSummary(CFG), base: BASE.includes('paper') ? 'paper' : 'LIVE' }, stream: { ...streamStats, mode: streamStats.lastTick && Date.now() - streamStats.lastTick < 60000 ? 'streaming' : 'polling' }, engine: { cycleMs: engine.cycleMs, cycleMax: engine.cycleMax, cycles: engine.cycles, avgCallMs: engine.calls ? Math.round(engine.callMs / engine.calls) : 0, calls: engine.calls, errorsHour: engine.hourErrors.length, lastError: engine.lastError, symbols: UNIVERSE.length, beatMs: +process.env.BEAT_MS || 2000, scan: CFG.universe === 'scan' ? { ...scanStatus } : null },
    // panels the bot only computes while the market is open: a process that has not computed them yet keeps the previous ones
    risk: lastRisk || prev.risk || null, split: lastSplit || prev.split || null, spy: lastSpy || prev.spy || null, wheel: lastWheel || prev.wheel || null,
    watch: lastWatch || prev.watch || null, day: lastDay || prev.day || null,
    mem: { day: TODAY, lastDayPx, userPause, haltSaid: [...haltSaid], spyLevels, wheel: wheelMem },   // the wheel's memory carries across days (what it sold, the shares a put delivered)
    since: await sinceStart(prev.since, fills, acct).catch(() => prev.since || null),   // day-state a restart must not forget: yesterday's closes of sold-out symbols, a Telegram /pause, alerts already sent
    limits: { riskPct: RISK_PCT, optRiskPct: OPT_RISK_PCT, maxHeat: MAX_HEAT, perSector: MAX_PER_SECTOR, streak: MAX_STREAK, weekCap: WEEK_CAP, dayCap: LOSS_CAP } };
  if (PRIVATE) {
    // Only the timestamp, paper/live flag, stream health and engine health stay readable; the page decrypts the rest with the same passphrase.
    const blob = await encryptJournal(j, process.env.JOURNAL_KEY);
    const sigH = (await import('node:crypto')).createHash('sha256').update(sig).digest('hex').slice(0, 16);   // change-detector only, reveals nothing
    const pubEngine = { ...j.engine, lastError: redactText(j.engine.lastError || ''), scan: j.engine.scan ? { ...j.engine.scan, err: redactText(j.engine.scan.err || '') } : null };   // the readable part never names a symbol
    fs.writeFileSync('bot/journal.json', JSON.stringify({ ...blob, at: j.at, sig: sigH, paper: j.paper, done: j.done, stream: j.stream, engine: pubEngine }));
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
