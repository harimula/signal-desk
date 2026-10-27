// Real-time session runner. Event-driven, not polled:
//  - Broker "trade updates" stream: every fill/cancel is pushed the instant it happens -> decision cycle right away.
//  - Market-data stream (IEX): every trade tick on the watched stocks is pushed -> prices are always live,
//    hard-floor exits fire within a second, closing-time exits use the true live price.
//  - A decision cycle also runs on a steady beat (every 2s; every 1s in the last 10 minutes) as a safety net,
//    and REST polling takes over automatically if a stream ever drops.
// Entries and take-profits are resting limit orders at the broker, so they execute at exchange speed anyway.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { HAVE_KEYS, closeMins, loadCalendar, setPublishing, botCycle, fastCheck, setNow, clockInfo, applyConfig, CFG, pushPrice, endpoints, streamStats, redact, eodReport, heartbeat, journalStamp, morningHello, tgPollCycle, spyFast, spyHasOpen, spyWatch, spyEnter, spyOnQuote, spyOpenSymbols, setSessionEnd } from './bot.mjs';
import { encode as mpEncode, decode as mpDecode } from './msgpack.mjs';
import { summary } from './config.mjs';

if (!HAVE_KEYS) { console.log('No Alpaca keys configured - nothing to do.'); process.exit(0); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LIFE = (+process.env.RUN_MINUTES || 350) * 60000, born = Date.now();
setSessionEnd(born + LIFE);                                   // the bot opens nothing new in this session's last 10 minutes (hand-off)
const BEAT = +process.env.BEAT_MS || 2000, BEAT_CLOSE = 1000, MIN_GAP = 250, JOURNAL_EVERY = 60000, COMMIT_EVERY = 10 * 60000;
let lastBeat = 0, lastFull = 0, lastJournal = 0, lastCommit = 0, errors = 0, lastCfg = 0, cfgSeen = JSON.stringify(CFG), cycling = false;
const queue = [];                                             // reasons to run a cycle immediately
const wake = why => { if (!queue.includes(why)) queue.push(why); };
let lastSpyFast = 0, spyBusy = false, lastFastCheck = 0;

// ---- settings hot-reload (Settings tab -> bot/config.json) ----
const ghPagesBase = () => { const r = process.env.GITHUB_REPOSITORY || ''; const [o, n] = r.split('/'); return o && n ? `https://${o.toLowerCase()}.github.io/${n}/` : ''; };
const CONFIG_URL = process.env.CONFIG_URL || (ghPagesBase() ? ghPagesBase() + 'bot/config.json' : '');
// The fetch runs beside the loop with a 5-second deadline (a slow GitHub Pages must never hold up exits); the settings it
// brings are applied between two decision cycles, never in the middle of one.
let cfgBusy = false, cfgPending = null;
async function pollConfig() {
  if (!CONFIG_URL) return;                                    // no Pages URL known: settings stay as the repo file had them
  if (cfgBusy || Date.now() - lastCfg < (+process.env.CONFIG_POLL_MS || 60000)) return; lastCfg = Date.now(); cfgBusy = true;
  try {
    const r = await fetch(CONFIG_URL + '?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(5000) }); if (!r.ok) return;
    cfgPending = await r.json();
  } catch (e) { console.log('config poll failed', e.message); }
  finally { cfgBusy = false; }
}
function applyPendingConfig() {
  if (!cfgPending) return; const raw = cfgPending; cfgPending = null;
  const c = applyConfig(raw), s = JSON.stringify(c);
  if (s !== cfgSeen) {
    cfgSeen = s; console.log('⚙️ settings applied:', summary(c)); lastJournal = 0; wake('settings changed');
    const e2 = endpoints();
    if (e2.trading !== EP.trading || e2.key !== EP.key) { console.log('account switched to', /paper/.test(e2.trading) ? 'PAPER' : 'LIVE', '— reconnecting streams'); Object.assign(EP, e2); try { tradeWs && tradeWs.close(); dataWs && dataWs.close(); } catch (x) {} }
    else resubscribe();
  }
}
// ---- kill switch from the page: Pause writes bot/STOP to GitHub; a running session must see it within seconds, not at the next
// run. Polled every 15 s through the GitHub API with the workflow's own token (5-second deadline, beside the loop) and
// mirrored to bot/STOP.local, which bot.mjs checks next to bot/STOP. The mirror is git-ignored: publishing the journal never
// has to delete it to pull, so a failed pull cannot drop the Pause.
let lastStopPoll = 0, stopBusy = false;
const STOP_MIRROR = 'bot/STOP.local';
async function pollStop() {
  const repo = process.env.GITHUB_REPOSITORY, tok = process.env.GITHUB_TOKEN; if (!repo || !tok) return;
  if (stopBusy || Date.now() - lastStopPoll < 15000) return; lastStopPoll = Date.now(); stopBusy = true;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/bot/STOP?ref=main&t=${Date.now()}`, { headers: { authorization: 'Bearer ' + tok, accept: 'application/vnd.github+json', 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(5000) });
    if (r.status === 200 && !fs.existsSync(STOP_MIRROR)) { fs.writeFileSync(STOP_MIRROR, 'stop (from the page)'); console.log('⛔ STOP set on the page — acting now'); wake('STOP'); }
    else if (r.status === 404 && (fs.existsSync(STOP_MIRROR) || fs.existsSync('bot/STOP'))) {
      for (const f of [STOP_MIRROR, 'bot/STOP']) try { fs.unlinkSync(f); } catch (e) {}   // the checked-out copy too: the page removed it
      console.log('▶ STOP removed on the page — trading resumes'); wake('resume');
    }
  } catch (e) { console.log('stop poll failed', e.message); }
  finally { stopBusy = false; }
}
// ---- live view: the journal also goes to a one-commit branch `live` every minute, without growing the repo's history ----
// (the encrypted journal cannot be delta-compressed, so a commit a minute on main would add gigabytes a year). The page
// reads it from there through the GitHub API when it has the owner's token, so Bot trades is about a minute behind
// instead of ten. Each publish replaces the branch with a new parentless commit; old ones are garbage-collected by GitHub.
let liveBusy = false, liveSent = 0, liveMtime = 0;
async function publishLive() {
  const repo = process.env.GITHUB_REPOSITORY, tok = process.env.GITHUB_TOKEN;
  if (!repo || !tok || liveBusy || process.env.BOT_NO_COMMIT === '1') return;
  let st; try { st = fs.statSync('bot/journal.json'); } catch (e) { return; }
  if (st.mtimeMs === liveMtime || Date.now() - liveSent < 55000) return;
  liveBusy = true; liveSent = Date.now();
  const gh = async (path, method, body) => { const r = await fetch(`https://api.github.com/repos/${repo}${path}`, { method, headers: { authorization: 'Bearer ' + tok, accept: 'application/vnd.github+json', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) }); if (!r.ok) { const e = new Error(path.split('?')[0] + ' HTTP ' + r.status); e.status = r.status; throw e; } return r.json(); };
  try {
    const blob = await gh('/git/blobs', 'POST', { content: fs.readFileSync('bot/journal.json').toString('base64'), encoding: 'base64' });
    const tree = await gh('/git/trees', 'POST', { tree: [{ path: 'bot/journal.json', mode: '100644', type: 'blob', sha: blob.sha }] });
    const commit = await gh('/git/commits', 'POST', { message: 'live journal', tree: tree.sha, parents: [] });
    try { await gh('/git/refs/heads/live', 'PATCH', { sha: commit.sha, force: true }); }
    catch (e) { if (e.status === 404 || e.status === 422) await gh('/git/refs', 'POST', { ref: 'refs/heads/live', sha: commit.sha }); else throw e; }
    liveMtime = st.mtimeMs;
  } catch (e) { console.log('live view publish skipped:', e.message); }
  finally { liveBusy = false; }
}

// Publishing the journal runs git in a child process, so a slow or unreachable GitHub never stalls the trading loop
// (stops, SPY exits and quotes keep running). While it runs, the bot does not rewrite the journal file.
let committing = false;
const COMMIT_SH = `git add bot/journal.json; git add bot/scan.json live.json news.json 2>/dev/null || true
git diff --cached --quiet && exit 0
git commit -q -m "Bot journal" || exit 0
timeout 30 git push -q && exit 0
if timeout 45 git pull -q --rebase --autostash -X theirs origin main; then timeout 30 git push -q && exit 0; else git rebase --abort 2>/dev/null; fi
exit 1`;
function commit() {
  if (process.env.BOT_NO_COMMIT === '1' || committing) return Promise.resolve();
  committing = true; setPublishing(true);
  let saved = null; try { saved = fs.readFileSync('bot/journal.json'); } catch (e) {}
  return new Promise(resolve => {
    let err = '';
    const c = spawn('bash', ['-c', COMMIT_SH], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 150000 });
    c.stderr.on('data', d => { err += d; });
    const done = code => {
      if (code) console.log('commit skipped:', (err.split('\n').find(Boolean) || 'exit ' + code).slice(0, 160));
      if (saved) { try { const now = fs.readFileSync('bot/journal.json'); if (!now.length) fs.writeFileSync('bot/journal.json', saved); } catch (e) { fs.writeFileSync('bot/journal.json', saved); } }   // a reset must never lose the journal
      committing = false; setPublishing(false); resolve();
    };
    c.on('error', () => done(1)); c.on('exit', code => done(code));
  });
}

// ---- site prices: GitHub's scheduler often skips the 10-minute refresh-prices runs during market hours, so the
// session (alive all day) refreshes live.json / news.json itself, in a child process that never blocks a cycle.
// The next commit publishes them with the journal. BOT_NO_PRICES=1 turns it off (tests).
const PRICES_EVERY = 10 * 60000; let lastPrices = 0, pricesBusy = false, lastTg = 0, tgBusy = false;
function refreshPrices() {
  if (process.env.BOT_NO_PRICES === '1' || process.env.BOT_NO_COMMIT === '1') return;
  pricesBusy = true; lastPrices = Date.now();
  const run = (file, next) => { const env = { PATH: process.env.PATH, HOME: process.env.HOME, TZ: process.env.TZ || '', ...(file === 'news.mjs' ? { ALPACA_KEY: process.env.ALPACA_KEY || '', ALPACA_SECRET: process.env.ALPACA_SECRET || '' } : {}) };   // refreshers get no Telegram, GitHub or journal secrets; only the news reader gets the (read-only) market-data keys
    const c = spawn(process.execPath, [file], { stdio: 'ignore', env }); const t = setTimeout(() => c.kill(), 4 * 60000); c.on('exit', code => { clearTimeout(t); if (file === 'fetch.mjs') console.log('site prices refreshed' + (code ? ' (exit ' + code + ')' : '')); next(); }); c.on('error', () => { clearTimeout(t); next(); }); };
  run('fetch.mjs', () => run('news.mjs', () => { pricesBusy = false; lastCommit = 0; }));    // commit right after, so the page sees them now
}

// ---- streams ----
const EP = endpoints();
const tradeWsUrl = () => process.env.ALPACA_TRADE_WS || EP.trading.replace(/^http/, 'ws') + '/stream';
const DATA_WS = process.env.ALPACA_DATA_WS || 'wss://stream.data.alpaca.markets/v2/iex';
const OPT_WS = process.env.ALPACA_OPT_WS || 'wss://stream.data.alpaca.markets/v1beta1/indicative';   // options quotes: MessagePack only
let tradeWs = null, dataWs = null, optWs = null, subscribed = [], optSubscribed = [], tradeOk = false, dataOk = false, optOk = false;
const heldUnds = new Set();                                   // underlyings of open positions (kept subscribed)
function openWs(url, onOpen, onMsg, label, opts = {}) {
  let ws;
  if (typeof WebSocket === 'undefined') { console.log(label, 'cannot open: this Node has no WebSocket (needs Node 22+) - running on polling only'); return null; }
  try { ws = opts.headers ? new WebSocket(url, { headers: opts.headers }) : new WebSocket(url); } catch (e) { console.log(label, 'cannot open:', e.message); return null; }
  ws.onopen = () => { console.log(label, 'connected'); onOpen(ws); };
  ws.onmessage = ev => {
    const parse = raw => { try { onMsg(opts.msgpack ? mpDecode(raw) : JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString())); } catch (e) {} };
    if (typeof ev.data === 'string') parse(ev.data);
    else if (ev.data && ev.data.arrayBuffer) ev.data.arrayBuffer().then(b => parse(Buffer.from(b)));   // binary frames (paper trade stream, options stream)
    else if (ev.data) parse(Buffer.from(ev.data));
  };
  ws.onclose = () => { console.log(label, 'closed - reconnecting in 5s'); if (label === 'trade-stream') tradeOk = false; else if (label === 'options-stream') { optOk = false; optSubscribed = []; } else dataOk = false; setTimeout(() => connectStreams(label), 5000); };
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
      else if (m.T === 'error') { console.log('data-stream error', m.code, m.msg); if (m.code === 405 || /symbol limit/i.test(m.msg || '')) { process.env.STREAM_MAX = String(Math.max(5, Math.floor((+(process.env.STREAM_MAX || 30)) / 2))); subscribed = []; setTimeout(resubscribe, 1000); } }   // over the plan's symbol limit (405): halve and retry; a connection limit (406) is not about the symbols
    }
  }, 'data-stream');
  // options quotes for the SPY sleeve's open trade: exits react to each quote instead of the 1-second poll (which stays as the fallback)
  if (which === 'both' || which === 'options-stream') optWs = openWs(OPT_WS, ws => ws.send(mpEncode({ action: 'auth', key: EP.key, secret: EP.secret })), arr => {
    for (const m of Array.isArray(arr) ? arr : [arr]) {
      if (m.T === 'success' && m.msg === 'authenticated') { optOk = true; optSubscribed = []; resubscribeOptions(); }
      else if (m.T === 'q' && m.S) { spyOnQuote(m.S, +m.bp, +m.ap).catch(e => console.log('spy quote exit', e.message)); }
      else if (m.T === 'error') console.log('options-stream error', m.code, m.msg);
    }
  }, 'options-stream', { msgpack: true, headers: { 'Content-Type': 'application/msgpack' } });
}
function resubscribeOptions() {
  if (!optWs || optWs.readyState !== 1 || !optOk) return;
  const want = spyOpenSymbols();
  if (want.join(',') === optSubscribed.join(',')) return;
  if (optSubscribed.length) optWs.send(mpEncode({ action: 'unsubscribe', quotes: optSubscribed }));
  if (want.length) optWs.send(mpEncode({ action: 'subscribe', quotes: want }));
  optSubscribed = want; if (want.length) console.log('options-stream: quotes for', want.join(','));
}
function resubscribe() {
  if (!dataWs || dataWs.readyState !== 1 || !dataOk) return;
  // The free (IEX) data plan streams at most 30 symbols; asking for more is refused outright (no ticks at all). SPY first
  // (the SPY sleeve's entries ride on its ticks), then what is held (floor exits), then the closest dips on the watch list.
  const want = [...new Set(['SPY', ...heldUnds, ...endpoints().universe])].slice(0, +(process.env.STREAM_MAX || 30));
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
  if (sym === 'SPY') { const w = spyWatch(); if (w && ((w.market === 'up' && px > w.level) || (w.market === 'down' && px < w.level)) && !floorFired.has('spy')) { floorFired.add('spy'); setTimeout(() => floorFired.delete('spy'), 10000); spyEnter(px).then(ok => { console.log('\u26a1 SPY tick through', w.level, ok ? '- order placed' : '- no order'); resubscribeOptions(); wake('SPY broke ' + w.level); }).catch(e => console.log('spy tick entry', e.message)); } }
}

// ---- graceful shutdown: GitHub (or a person) cancelling the run sends SIGINT/SIGTERM. Finish the cycle in flight,
// write the journal and push it, then leave. Resting orders at the broker are untouched: they are day orders.
let stopping = false;
const onSignal = sig => { if (stopping) return; stopping = true; setSessionEnd(Date.now()); console.log(`${sig} received \u2014 finishing the current cycle, saving the journal`); };
process.on('SIGTERM', () => onSignal('SIGTERM')); process.on('SIGINT', () => onSignal('SIGINT'));
process.on('unhandledRejection', e => console.log('unhandled rejection', redact(String((e && e.message) || e))));

// ---- main loop ----
const m0 = setNow();
// GitHub's scheduler often starts runs late, so the workflow also fires from 8:45 ET (7:45 in winter) and the run waits here
// until 9:20 instead of exiting: the session is up before the open even when the 9:20 start is delayed.
if (m0 >= 6 * 60 && m0 < 9 * 60 + 20) {   // from 6:00 ET: tools/kick-bot.mjs may start the session early (GitHub's schedule is unreliable)
  console.log(`Early start (${Math.floor(m0 / 60)}:${String(m0 % 60).padStart(2, '0')} ET) - waiting until 9:20 ET.`); while (setNow() < 9 * 60 + 20) await sleep(15000); }   // the session's life counts from the process start: GitHub kills a job after 358 minutes, early wait included
const m1 = setNow();
await loadCalendar();                                                   // today's real close (13:00 on early-close days)
if (m1 < 9 * 60 + 20 || m1 >= closeMins() + 5) { console.log('Outside 9:20-16:05 ET - next scheduled run will take over.'); process.exit(0); }
// Started after the close (the run that was queued behind the day's session): if that session reached the close and wrote
// its journal, there is nothing left to do — rewriting the journal from an empty memory or sending a second day summary
// would only do harm. If it died early (journal older than 3:55 PM), fall through: one cycle, journal, summary, exit.
if (m1 >= closeMins()) {
  const js = journalStamp(), todayET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  if (js && js.day === todayET.year + todayET.month + todayET.day && (js.done || js.mins >= closeMins())) { console.log(`Market closed and today's session already finished its journal at ${js.at} - nothing to do.`); process.exit(0); }
  console.log('Market closed and today\'s journal is incomplete - running one closing cycle.');
}
// first run of the day (no journal from today yet, market hours): send the good-morning alert once the first cycle is done
const firstToday = (() => { const js = journalStamp(); const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()).replace(/-/g, ''); return !js || js.day !== d; })();
let helloSent = !firstToday || m1 >= closeMins();
connectStreams();
await pollConfig(); applyPendingConfig();
while (Date.now() - born < LIFE && !stopping) {
  const mins = setNow();
  if (mins >= closeMins() + 5) break;
  pollConfig(); pollStop();                                              // beside the loop, each with a 5-second deadline
  if (!cycling && !spyBusy) applyPendingConfig();
  const beat = mins >= closeMins() - 10 ? BEAT_CLOSE : BEAT;
  let why = queue.shift() || (Date.now() - lastFull >= beat ? 'beat' : null);
  if (!why && !(tradeOk && dataOk) && Date.now() - lastFastCheck >= 1000) { lastFastCheck = Date.now(); try { why = await fastCheck(); errors = 0; } catch (e) { errors++; if (errors > 20) await sleep(5000); } }   // streams down: poll instead, at most once a second
  if (why && !cycling && !spyBusy && Date.now() - lastFull >= MIN_GAP) {
    cycling = true;
    if (why !== 'beat') console.log('▶', why);
    try {
      const jNow = !committing && Date.now() - lastJournal >= JOURNAL_EVERY;   // never rewrite the journal while git is publishing it
      const r = await botCycle({ journal: jNow, floors: setFloor, held: heldUnds });
      if (jNow) lastJournal = Date.now();
      if (!helloSent && r.open) { helloSent = true; await morningHello(); }
      const ck = clockInfo();
      if (!r.open && ck && !ck.is_open) {
        // closed: leave only when the day is over or the next open is not today; before the bell, wait for it (the 9:20 start must not exit)
        const todayET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
        const openDay = ck.next_open ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ck.next_open)) : '';
        if (setNow() >= closeMins() || openDay !== todayET) { console.log('Market is closed - stopping.'); break; }
        const waitMs = Math.max(5000, Math.min(60000, Date.parse(ck.next_open) - Date.now()));
        console.log(`Market opens at ${ck.next_open} - waiting.`); await sleep(waitMs);
      }
      resubscribe(); resubscribeOptions();
    } catch (e) { console.log('cycle error', e.message); }
    lastFull = Date.now(); cycling = false;
  }
  if (Date.now() - lastSpyFast >= 1000 && !cycling && !spyBusy && spyHasOpen()) { spyBusy = true; lastSpyFast = Date.now(); spyFast().catch(e => console.log('spy fast lane', e.message)).finally(() => { spyBusy = false; resubscribeOptions(); }); }   // 1-second exits while a SPY trade is open (fallback to the quote stream)
  if (Date.now() - lastPrices >= PRICES_EVERY && !pricesBusy) refreshPrices();
  if (Date.now() - lastTg >= 3000 && !tgBusy) { tgBusy = true; lastTg = Date.now(); tgPollCycle().finally(() => { tgBusy = false; }); }   // Telegram commands, off the decision path
  if (Date.now() - lastCommit >= COMMIT_EVERY && !committing) { lastCommit = Date.now(); commit(); }
  if (!committing) publishLive();                                          // the page's live view, about once a minute
  if (Date.now() - lastBeat >= 60000) { lastBeat = Date.now(); heartbeat(); }
  await sleep(queue.length ? 50 : 200);
}
// Reached the time limit while the market is still open (GitHub ends a job after 6 hours): start the next session first,
// before the final check and the publish, instead of hoping GitHub's schedule fires. It queues behind this one and starts
// the moment this job ends. Tried twice: a missed hand-off leaves the afternoon to the 5-minute schedule.
if (!stopping && Date.now() - born >= LIFE && setNow() < closeMins() - 2 && process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY) {
  for (let k = 0; k < 2; k++) {
    try {
      const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/trade.yml/dispatches`, { method: 'POST', headers: { authorization: 'Bearer ' + process.env.GITHUB_TOKEN, accept: 'application/vnd.github+json', 'content-type': 'application/json' }, body: JSON.stringify({ ref: 'main' }), signal: AbortSignal.timeout(15000) });
      console.log(r.status === 204 ? 'next session started (it takes over when this one ends)' : 'could not start the next session: HTTP ' + r.status);
      if (r.status === 204) break;
    } catch (e) { console.log('could not start the next session:', e.message); }
    await sleep(3000);
  }
}
while (committing) await sleep(500);                                    // let a publish in progress finish before the final journal write
applyPendingConfig();
// the final check manages what is open (exits, take-profit orders) but opens nothing: a trade placed now would be left
// unwatched while the next session starts
try { await botCycle({ journal: true, manageOnly: true }); } catch (e) { console.log('final cycle error', e.message); }
if (setNow() >= closeMins() && !stopping) await eodReport();   // the session that reaches the close sends the day's summary
await commit();
try { tradeWs && tradeWs.close(); dataWs && dataWs.close(); optWs && optWs.close(); } catch (e) {}
console.log('Session runner finished.');
process.exit(0);
