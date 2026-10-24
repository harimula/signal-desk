// Real-time session runner. Event-driven, not polled:
//  - Broker "trade updates" stream: every fill/cancel is pushed the instant it happens -> decision cycle right away.
//  - Market-data stream (IEX): every trade tick on the watched stocks is pushed -> prices are always live,
//    hard-floor exits fire within a second, closing-time exits use the true live price.
//  - A decision cycle also runs on a steady beat (every 2s; every 1s in the last 10 minutes) as a safety net,
//    and REST polling takes over automatically if a stream ever drops.
// Entries and take-profits are resting limit orders at the broker, so they execute at exchange speed anyway.
import { execSync, spawn } from 'node:child_process';
import { HAVE_KEYS, botCycle, fastCheck, setNow, clockInfo, applyConfig, CFG, pushPrice, endpoints, streamStats, redact, eodReport, heartbeat, journalStamp, morningHello, tgPollCycle, spyFast, spyHasOpen, spyWatch } from './bot.mjs';
import { summary } from './config.mjs';

if (!HAVE_KEYS) { console.log('No Alpaca keys configured - nothing to do.'); process.exit(0); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LIFE = (+process.env.RUN_MINUTES || 350) * 60000, born = Date.now();
const BEAT = +process.env.BEAT_MS || 2000, BEAT_CLOSE = 1000, MIN_GAP = 250, JOURNAL_EVERY = 120000, COMMIT_EVERY = 10 * 60000;
let lastBeat = 0, lastFull = 0, lastJournal = 0, lastCommit = 0, errors = 0, lastCfg = 0, cfgSeen = JSON.stringify(CFG), cycling = false;
const queue = [];                                             // reasons to run a cycle immediately
const wake = why => { if (!queue.includes(why)) queue.push(why); };
let lastSpyFast = 0, spyBusy = false;

// ---- settings hot-reload (Settings tab -> bot/config.json) ----
const ghPagesBase = () => { const r = process.env.GITHUB_REPOSITORY || ''; const [o, n] = r.split('/'); return o && n ? `https://${o.toLowerCase()}.github.io/${n}/` : ''; };
const CONFIG_URL = process.env.CONFIG_URL || (ghPagesBase() ? ghPagesBase() + 'bot/config.json' : '');
async function pollConfig() {
  if (!CONFIG_URL) return;                                    // no Pages URL known: settings stay as the repo file had them
  if (Date.now() - lastCfg < (+process.env.CONFIG_POLL_MS || 60000)) return; lastCfg = Date.now();
  try {
    const r = await fetch(CONFIG_URL + '?t=' + Date.now(), { cache: 'no-store' }); if (!r.ok) return;
    const c = applyConfig(await r.json()), s = JSON.stringify(c);
    if (s !== cfgSeen) {
      cfgSeen = s; console.log('\u2699\ufe0f settings applied:', summary(c)); lastJournal = 0; wake('settings changed');
      const e2 = endpoints();
      if (e2.trading !== EP.trading || e2.key !== EP.key) { console.log('account switched to', /paper/.test(e2.trading) ? 'PAPER' : 'LIVE', '\u2014 reconnecting streams'); Object.assign(EP, e2); try { tradeWs && tradeWs.close(); dataWs && dataWs.close(); } catch (x) {} }
      else resubscribe();
    }
  } catch (e) { console.log('config poll failed', e.message); }
}
function commit() {
  if (process.env.BOT_NO_COMMIT === '1') return;
  try { execSync('git add bot/journal.json && (git add bot/scan.json live.json news.json 2>/dev/null || true) && (git diff --cached --quiet || (git commit -q -m "Bot journal" && (git push -q || (git pull -q --rebase -X theirs origin main && git push -q))))', { stdio: 'inherit', shell: '/bin/bash' }); }
  catch (e) { console.log('commit skipped:', e.message.split('\n')[0]); }
}

// ---- site prices: GitHub's scheduler often skips the 10-minute refresh-prices runs during market hours, so the
// session (alive all day) refreshes live.json / news.json itself, in a child process that never blocks a cycle.
// The next commit publishes them with the journal. BOT_NO_PRICES=1 turns it off (tests).
const PRICES_EVERY = 10 * 60000; let lastPrices = 0, pricesBusy = false, lastTg = 0, tgBusy = false;
function refreshPrices() {
  if (process.env.BOT_NO_PRICES === '1' || process.env.BOT_NO_COMMIT === '1') return;
  pricesBusy = true; lastPrices = Date.now();
  const run = (file, next) => { const c = spawn(process.execPath, [file], { stdio: 'ignore', env: process.env }); const t = setTimeout(() => c.kill(), 4 * 60000); c.on('exit', code => { clearTimeout(t); if (file === 'fetch.mjs') console.log('site prices refreshed' + (code ? ' (exit ' + code + ')' : '')); next(); }); c.on('error', () => { clearTimeout(t); next(); }); };
  run('fetch.mjs', () => run('news.mjs', () => { pricesBusy = false; lastCommit = 0; }));    // commit right after, so the page sees them now
}

// ---- streams ----
const EP = endpoints();
const tradeWsUrl = () => process.env.ALPACA_TRADE_WS || EP.trading.replace(/^http/, 'ws') + '/stream';
const DATA_WS = process.env.ALPACA_DATA_WS || 'wss://stream.data.alpaca.markets/v2/iex';
let tradeWs = null, dataWs = null, subscribed = [], tradeOk = false, dataOk = false;
const heldUnds = new Set();                                   // underlyings of open positions (kept subscribed)
function openWs(url, onOpen, onMsg, label) {
  let ws;
  try { ws = new WebSocket(url); } catch (e) { console.log(label, 'cannot open:', e.message); return null; }
  ws.onopen = () => { console.log(label, 'connected'); onOpen(ws); };
  ws.onmessage = ev => {
    const parse = txt => { try { onMsg(JSON.parse(txt)); } catch (e) {} };
    if (typeof ev.data === 'string') parse(ev.data);
    else if (ev.data && ev.data.arrayBuffer) ev.data.arrayBuffer().then(b => parse(Buffer.from(b).toString()));   // paper stream uses binary frames
    else if (ev.data) parse(Buffer.from(ev.data).toString());
  };
  ws.onclose = () => { console.log(label, 'closed - reconnecting in 5s'); if (label === 'trade-stream') tradeOk = false; else dataOk = false; setTimeout(() => connectStreams(label), 5000); };
  ws.onerror = e => console.log(label, 'error', (e && e.message) || '');
  return ws;
}
function connectStreams(which = 'both') {
  if (process.env.NO_STREAMS === '1') return;
  if (which === 'both' || which === 'trade-stream') tradeWs = openWs(tradeWsUrl(), ws => ws.send(JSON.stringify({ action: 'auth', key: EP.key, secret: EP.secret })), m => {
    if (m.stream === 'authorization') { tradeOk = m.data && m.data.status === 'authorized'; if (tradeOk) tradeWs.send(JSON.stringify({ action: 'listen', data: { streams: ['trade_updates'] } })); else console.log('trade-stream auth failed'); }
    if (m.stream === 'trade_updates' && m.data) {
      const ev = m.data.event, o = m.data.order || {};
      if (['fill', 'partial_fill', 'canceled', 'expired', 'rejected'].includes(ev)) { streamStats.fills++; console.log('\u26a1', redact(ev + ' ' + o.side + ' ' + o.qty + ' ' + o.symbol + (m.data.price ? ' @ ' + m.data.price : ''))); wake(ev + ' ' + o.symbol); }
    }
  }, 'trade-stream');
  if (which === 'both' || which === 'data-stream') dataWs = openWs(DATA_WS, ws => ws.send(JSON.stringify({ action: 'auth', key: EP.key, secret: EP.secret })), arr => {
    for (const m of Array.isArray(arr) ? arr : [arr]) {
      if (m.T === 'success' && m.msg === 'authenticated') { dataOk = true; subscribed = []; resubscribe(); }
      else if (m.T === 't' && m.S && m.p > 0) { pushPrice(m.S, m.p, Date.parse(m.t) || Date.now()); onTick(m.S, m.p); }
      else if (m.T === 'error') console.log('data-stream error', m.msg);
    }
  }, 'data-stream');
}
function resubscribe() {
  if (!dataWs || dataWs.readyState !== 1 || !dataOk) return;
  const want = [...new Set(endpoints().universe.concat([...heldUnds], ['SPY']))].slice(0, 200);
  if (JSON.stringify(want) === JSON.stringify(subscribed)) return;
  if (subscribed.length) dataWs.send(JSON.stringify({ action: 'unsubscribe', trades: subscribed }));
  dataWs.send(JSON.stringify({ action: 'subscribe', trades: want }));
  subscribed = want; console.log('data-stream: streaming', want.length, 'symbols');
}
// per-tick reactions that cannot wait for the beat: hard floor on a held stock
const floorPx = {};                                            // symbol -> price at which the hard floor trips (set by the cycle)
export function setFloor(sym, px) { if (px) floorPx[sym] = px; else delete floorPx[sym]; }
const floorFired = new Set();
function onTick(sym, px) {
  if (floorPx[sym] && px <= floorPx[sym] && !floorFired.has(sym)) { floorFired.add(sym); wake('floor ' + sym); setTimeout(() => floorFired.delete(sym), 15000); }
  // SPY quick options: a tick through the sleeve's level starts a full cycle at once instead of waiting for the next beat
  if (sym === 'SPY') { const w = spyWatch(); if (w && ((w.market === 'up' && px > w.level) || (w.market === 'down' && px < w.level)) && !floorFired.has('spy')) { floorFired.add('spy'); wake('SPY broke ' + w.level); setTimeout(() => floorFired.delete('spy'), 10000); } }
}

// ---- graceful shutdown: GitHub (or a person) cancelling the run sends SIGINT/SIGTERM. Finish the cycle in flight,
// write the journal and push it, then leave. Resting orders at the broker are untouched: they are day orders.
let stopping = false;
const onSignal = sig => { if (stopping) return; stopping = true; console.log(`${sig} received \u2014 finishing the current cycle, saving the journal`); };
process.on('SIGTERM', () => onSignal('SIGTERM')); process.on('SIGINT', () => onSignal('SIGINT'));
process.on('unhandledRejection', e => console.log('unhandled rejection', redact(String((e && e.message) || e))));

// ---- main loop ----
const m0 = setNow();
// GitHub's scheduler often starts runs 10-20 minutes late, so the workflow also fires from 8:45 ET and the run waits here
// until 9:20 instead of exiting: the session is up before the open even when the 9:20 start is delayed.
if (m0 >= 8 * 60 + 45 && m0 < 9 * 60 + 20) { console.log(`Early start (${Math.floor(m0 / 60)}:${String(m0 % 60).padStart(2, '0')} ET) - waiting until 9:20 ET.`); while (setNow() < 9 * 60 + 20) await sleep(15000); }
const m1 = setNow();
if (m1 < 9 * 60 + 20 || m1 >= 16 * 60 + 5) { console.log('Outside 9:20-16:05 ET - next scheduled run will take over.'); process.exit(0); }
// Started after the close (the run that was queued behind the day's session): if that session reached the close and wrote
// its journal, there is nothing left to do — rewriting the journal from an empty memory or sending a second day summary
// would only do harm. If it died early (journal older than 3:55 PM), fall through: one cycle, journal, summary, exit.
if (m1 >= 16 * 60) {
  const js = journalStamp(), todayET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  if (js && js.day === todayET.year + todayET.month + todayET.day && js.mins >= 15 * 60 + 55) { console.log(`Market closed and today's session already finished its journal at ${js.at} - nothing to do.`); process.exit(0); }
  console.log('Market closed and today\'s journal is incomplete - running one closing cycle.');
}
// first run of the day (no journal from today yet, market hours): send the good-morning alert once the first cycle is done
const firstToday = (() => { const js = journalStamp(); const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()).replace(/-/g, ''); return !js || js.day !== d; })();
let helloSent = !firstToday || m1 >= 16 * 60;
connectStreams();
await pollConfig();
while (Date.now() - born < LIFE && !stopping) {
  const mins = setNow();
  if (mins >= 16 * 60 + 5) break;
  await pollConfig();
  const beat = mins >= 15 * 60 + 50 ? BEAT_CLOSE : BEAT;
  let why = queue.shift() || (Date.now() - lastFull >= beat ? 'beat' : null);
  if (!why && !(tradeOk && dataOk)) { try { why = await fastCheck(); errors = 0; } catch (e) { errors++; if (errors > 20) await sleep(5000); } }   // streams down: poll instead
  if (why && !cycling && Date.now() - lastFull >= MIN_GAP) {
    cycling = true;
    if (why !== 'beat') console.log('▶', why);
    try {
      const r = await botCycle({ journal: Date.now() - lastJournal >= JOURNAL_EVERY, floors: setFloor, held: heldUnds });
      if (Date.now() - lastJournal >= JOURNAL_EVERY) lastJournal = Date.now();
      if (!helloSent && r.open) { helloSent = true; await morningHello(); }
      const ck = clockInfo();
      if (!r.open && ck && !ck.is_open) { console.log('Market is closed - stopping.'); break; }
      resubscribe();
    } catch (e) { console.log('cycle error', e.message); }
    lastFull = Date.now(); cycling = false;
  }
  if (Date.now() - lastSpyFast >= 1000 && !cycling && !spyBusy && spyHasOpen()) { spyBusy = true; lastSpyFast = Date.now(); spyFast().catch(e => console.log('spy fast lane', e.message)).finally(() => { spyBusy = false; }); }   // 1-second exits while a SPY trade is open
  if (Date.now() - lastPrices >= PRICES_EVERY && !pricesBusy) refreshPrices();
  if (Date.now() - lastTg >= 3000 && !tgBusy) { tgBusy = true; lastTg = Date.now(); tgPollCycle().finally(() => { tgBusy = false; }); }   // Telegram commands, off the decision path
  if (Date.now() - lastCommit >= COMMIT_EVERY) { commit(); lastCommit = Date.now(); }
  if (Date.now() - lastBeat >= 60000) { lastBeat = Date.now(); heartbeat(); }
  await sleep(queue.length ? 50 : 200);
}
try { await botCycle({ journal: true }); } catch (e) { console.log('final cycle error', e.message); }
if (setNow() >= 16 * 60 && !stopping) await eodReport();   // the session that reaches the close sends the day's summary
commit();
try { tradeWs && tradeWs.close(); dataWs && dataWs.close(); } catch (e) {}
console.log('Session runner finished.');
process.exit(0);
