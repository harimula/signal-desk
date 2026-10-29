// Why did (or didn't) the SPY quick-trade part trade? A read-only replay for given days (default: the last four trading
// days, New York time). It places nothing, cancels nothing and changes no setting.
//   Market part (in the clear — market data and public headlines only):
//     · SPY's 5-minute and 1-minute bars from the bot's own feed (Alpaca, IEX) and the day's headlines from the bot's own
//       source (Alpaca news); the bot's market check (bot/news.mjs guard) minute by minute, with the calendar (events.json);
//     · the bot's entry test (bot/spyopt.mjs spySignal + spyFresh) with the saved settings (bot/config.json) on each minute's
//       high (CALL) and low (PUT): the rule in force since the 2026-10-27 audit — the last 5-minute bar closed in SPY's
//       direction on at least the day's average volume ("armed"), then a break of the 15-minute high/low — and the live-tick
//       rule before it, which bought any fresh break on the right side of VWAP;
//     · the 5-minute bars that armed it, how often a bar reached the day's average volume, and the quote spread of the
//       contracts it would buy right now (it skips a spread over 5% of the asking price).
//   Account part (only with SEAL_PUB set, and then sealed — encrypted to that public key, RSA-OAEP + AES-256-GCM — because
//   the bot's trades are private): the SPY option buy orders of those days and how they ended, the account's daily equity
//   for the weekly loss check, and the trading sessions' own (already redacted) log lines about SPY, the market check and
//   skipped orders.
// Run by .github/workflows/spy-why.yml; writes research-data/spy-why.json (pushed to the research-data branch, not main).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spySignal, spyFresh, SPY_DEFAULTS } from '../bot/spyopt.mjs';
import { vwap } from '../bot/daytrade.mjs';
import { guard, classify, KEYWORDS, IDIOMS } from '../bot/news.mjs';
import { normalize } from '../bot/config.mjs';

const KEY = process.env.ALPACA_KEY, SECRET = process.env.ALPACA_SECRET;
if (!KEY || !SECRET) { console.log('no Alpaca keys'); process.exit(1); }
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET };
const DATA = 'https://data.alpaca.markets', TRADE = process.env.ALPACA_URL || 'https://paper-api.alpaca.markets';
const GH = process.env.GITHUB_TOKEN, REPO = process.env.REPO || process.env.GITHUB_REPOSITORY, SEAL = (process.env.SEAL_PUB || '').trim();
const GHH = { Authorization: 'Bearer ' + GH, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const OUT = process.env.OUT || 'research-data/spy-why.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, headers = H) {
  for (let a = 0; a < 5; a++) {
    await sleep(800);                                                    // the running bot shares these keys: stay far below the rate limit
    let r; try { r = await fetch(url, { headers }); } catch (e) { await sleep(2000 * (a + 1)); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(4000 * (a + 1)); continue; }
    if (!r.ok) return { err: r.status };
    return r.json();
  }
  return { err: 'retries' };
}
const etParts = ms => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
const etDay = ms => { const p = etParts(ms); return `${p.year}-${p.month}-${p.day}`; };
const etMin = ms => { const p = etParts(ms); return +p.hour * 60 + +p.minute; };
const hm = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
const hhmm = s => +String(s).slice(0, 2) * 60 + +String(s).slice(3, 5);
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const wd = d => new Date(d + 'T12:00:00Z').getUTCDay();
const tradingDaysAfter = (d, n) => { while (n > 0) { d = addDays(d, 1); if (![0, 6].includes(wd(d))) n--; } return d; };
const r2 = x => Math.round(x * 100) / 100;
const endIso = day => new Date(Math.min(Date.parse(addDays(day, 1) + 'T02:00:00Z'), Date.now() - 1000)).toISOString();

async function bars(tf, day) {
  let out = [], token = '';
  for (let k = 0; k < 10; k++) {
    const j = await get(`${DATA}/v2/stocks/bars?symbols=SPY&timeframe=${tf}&start=${day}T12:00:00Z&end=${endIso(day)}&limit=10000&feed=iex&sort=asc${token ? '&page_token=' + token : ''}`);
    if (j.err) throw new Error(`${tf} bars HTTP ${j.err}`);
    out = out.concat(((j.bars || {}).SPY || []).map(b => ({ ...b, ms: Date.parse(b.t), m: etMin(Date.parse(b.t)) })));
    token = j.next_page_token; if (!token) break;
  }
  return out.filter(b => etDay(b.ms) === day && b.m >= 570 && b.m < 960);   // the session, like the bot's load5m
}
async function news(day) {
  let out = [], token = '';
  for (let k = 0; k < 80; k++) {
    const j = await get(`${DATA}/v1beta1/news?start=${day}T09:00:00Z&end=${endIso(day)}&limit=50&sort=asc${token ? '&page_token=' + token : ''}`);
    if (j.err) throw new Error('news HTTP ' + j.err);
    out = out.concat((j.news || []).map(n => ({ headline: n.headline || '', created_at: n.created_at, ms: Date.parse(n.created_at) })));
    token = j.next_page_token; if (!token) break;
  }
  return out.sort((a, b) => a.ms - b.ms);
}
// which keyword made a headline count (the same whole-word test as news.mjs classify)
const wordsOf = text => { const t = ' ' + String(text).replace(IDIOMS, ' ') + ' ', hit = [];
  for (const [cat, ws] of Object.entries(KEYWORDS)) for (const w of ws) if (new RegExp('\\b' + w.replace(/\*$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (w.endsWith('*') ? '' : '\\b'), 'i').test(t)) hit.push(`${cat}: ${w}`);
  return hit; };

async function replay(day, C, events) {
  const b5 = await bars('5Min', day), b1 = await bars('1Min', day), hs = await news(day);
  if (!b1.length) return { day, note: 'no SPY bars — market closed' };
  const start = hhmm(C.spyStart), end = hhmm(C.spyEnd);
  const min = { window: 0, paused: 0, up: 0, down: 0, flat: 0, armedUp: 0, armedDown: 0 }, pauses = [], pausedBy = {}, pauseHeads = new Map();
  const now5 = [], before = [], last = { now: { call: 0, put: 0 }, before: { call: 0, put: 0 } }, lastP = { now: { call: 0, put: 0 }, before: { call: 0, put: 0 } };
  // a break counts once: a fresh level (spyFresh) advances the bot's last level only when it could act (no pause); one seen
  // during a pause is listed once and the level stays, so the same break can still be taken after the pause, as in the bot
  const take = (rule, list, s, paused, extra) => {
    if (!spyFresh(s.side, s.level, last[rule][s.side])) return;
    if (paused) { if (!spyFresh(s.side, s.level, lastP[rule][s.side])) return; lastP[rule][s.side] = s.level; }
    else last[rule][s.side] = s.level;
    list.push({ ...s, ...extra, paused });
  };
  let cur = null;
  for (const k of b1) {
    const m = k.m; if (m < start || m >= end) continue;
    min.window++;
    const at = k.ms + 59000, done = b5.filter(b => b.m + 5 <= m);
    const seen = hs.filter(h => h.ms <= at && h.ms > at - 3 * 3600e3).slice(-50).reverse();   // the bot: the latest 50 of the last 3 hours
    const g = guard({ events, todayDash: day, mins: m, headlines: seen, nowMs: at });
    if (g.block) {
      min.paused++;
      const r = (g.reasons.find(x => /^Breaking|no new trades|paused/.test(x)) || g.reasons[0] || 'market check').replace(/ — paused until.*$/, '');
      pausedBy[r] = (pausedBy[r] || 0) + 1;
      for (const h of seen) { const age = (at - h.ms) / 60000; if (age <= 30 && classify(h.headline).some(c => ['war', 'policy', 'crisis'].includes(c)) && !pauseHeads.has(h.headline)) pauseHeads.set(h.headline, { t: hm(etMin(h.ms)), headline: h.headline, words: wordsOf(h.headline) }); }
      if (!cur) cur = { from: m, to: m + 1 }; else cur.to = m + 1;
    } else if (cur) { pauses.push(cur); cur = null; }
    if (done.length < 4) continue;
    const vw = vwap(done), dC = k.c / vw - 1, mk = dC > 0.0005 ? 'up' : dC < -0.0005 ? 'down' : 'flat'; min[mk]++;
    const last3 = done.slice(-3), hi = Math.max(...last3.map(b => b.h)), lo = Math.min(...last3.map(b => b.l));
    const lb = done[done.length - 1], avgV = done.reduce((t, b) => t + (b.v || 0), 0) / done.length, volX = r2((lb.v || 0) / avgV);
    const armUp = lb.c > lb.o && lb.v >= avgV, armDn = lb.c < lb.o && lb.v >= avgV;
    if (mk === 'up' && armUp) min.armedUp++; if (mk === 'down' && armDn) min.armedDown++;
    const extra = { t: hm(m), vwap: r2(vw), bar: `${hm(lb.m)}–${hm(lb.m + 5)}`, barUp: lb.c > lb.o, volX };
    // the rule in force: spySignal on this minute's high (a CALL break) and low (a PUT break)
    for (const px of [k.h, k.l]) { const s = spySignal({ bars: done, px, mins: m, cfg: C }); if (s && s.side) take('now', now5, { side: s.side, level: s.level, px }, g.block, extra); }
    // the live-tick rule before the audit: any fresh break of the 15-minute high above VWAP, or of its low below VWAP
    if (k.h / vw - 1 > 0.0005 && k.h > hi) take('before', before, { side: 'call', level: r2(hi), px: k.h }, g.block, { ...extra, armed: armUp });
    if (k.l / vw - 1 < -0.0005 && k.l < lo) take('before', before, { side: 'put', level: r2(lo), px: k.l }, g.block, { ...extra, armed: armDn });
  }
  if (cur) pauses.push(cur);
  // every 5-minute bar that closes inside the window: did it reach the day's average volume, and did it arm the rule?
  const armedBars = [], byHour = {};
  for (let i = 3; i < b5.length; i++) {
    const b = b5[i], endM = b.m + 5; if (endM < start || endM >= end) continue;
    const done = b5.slice(0, i + 1), avgV = done.reduce((t, x) => t + (x.v || 0), 0) / done.length, vw = vwap(done), d = b.c / vw - 1;
    const mk = d > 0.0005 ? 'up' : d < -0.0005 ? 'down' : 'flat', dir = b.c > b.o ? 'up' : b.c < b.o ? 'down' : 'flat', x = (b.v || 0) / avgV;
    const hr = String(Math.floor(b.m / 60)), H1 = byHour[hr] || (byHour[hr] = { bars: 0, busy: 0, armed: 0, volX: [] });
    H1.bars++; H1.volX.push(r2(x)); if (x >= 1) H1.busy++;
    if (x >= 1 && mk !== 'flat' && dir === mk) { H1.armed++; armedBars.push({ bar: `${hm(b.m)}–${hm(endM)}`, side: mk === 'up' ? 'call' : 'put', volX: r2(x) }); }
  }
  for (const h of Object.values(byHour)) { const s = [...h.volX].sort((a, b) => a - b); h.medianVolX = s.length ? s[Math.floor(s.length / 2)] : null; delete h.volX; }
  const vols = b5.map(b => b.v || 0), first4 = vols.slice(0, 4).reduce((t, v) => t + v, 0) / Math.min(4, vols.length || 1), rest = vols.slice(4), restAvg = rest.length ? rest.reduce((t, v) => t + v, 0) / rest.length : null;
  const o = b1[0].o, hi = Math.max(...b1.map(b => b.h)), lo = Math.min(...b1.map(b => b.l)), c = b1[b1.length - 1].c;
  return { day, through: hm(b1[b1.length - 1].m + 1), spy: { open: o, high: hi, low: lo, last: c, rangePct: r2((hi / lo - 1) * 100), dayPct: r2((c / o - 1) * 100) },
    volume: { first20minBarAvg: Math.round(first4), laterBarAvg: restAvg == null ? null : Math.round(restAvg), ratio: restAvg ? r2(first4 / restAvg) : null, byHour },
    headlines: hs.length, minutes: min, pauses: pauses.map(p => `${hm(p.from)}–${hm(p.to)}`),
    pausedBy: Object.entries(pausedBy).sort((a, b) => b[1] - a[1]).map(([r, n]) => ({ minutes: n, why: r.slice(0, 160) })), pauseHeadlines: [...pauseHeads.values()],
    armedBars, signalsNow: now5, signalsBefore: before };
}

async function quotesNow(C) {
  const t = await get(`${DATA}/v2/stocks/trades/latest?symbols=SPY&feed=iex`);
  const px = (((t || {}).trades || {}).SPY || {}).p; if (!(px > 0)) return { note: 'no SPY price' };
  const today = etDay(Date.now()), from = tradingDaysAfter(today, 1), to = tradingDaysAfter(today, (C.spyDte || 1) + 1), out = { at: new Date().toISOString(), etTime: hm(etMin(Date.now())), spy: px };
  for (const kind of ['call', 'put']) {
    const j = await get(`${TRADE}/v2/options/contracts?underlying_symbols=SPY&type=${kind}&status=active&expiration_date_gte=${from}&expiration_date_lte=${to}&strike_price_gte=${(px * 0.99).toFixed(2)}&strike_price_lte=${(px * 1.01).toFixed(2)}&limit=200`);
    const cs = (j.option_contracts || []).filter(x => x.tradable !== false);
    if (!cs.length) { out[kind] = { note: 'no contract' + (j.err ? ' (HTTP ' + j.err + ')' : '') }; continue; }
    const ex = [...new Set(cs.map(x => x.expiration_date))].sort()[0];
    const near = cs.filter(x => x.expiration_date === ex).sort((a, b) => Math.abs(+a.strike_price - px) - Math.abs(+b.strike_price - px)).slice(0, 3);
    const q = (await get(`${DATA}/v1beta1/options/quotes/latest?symbols=${near.map(x => x.symbol).join(',')}&feed=indicative`)).quotes || {};
    out[kind] = near.map(x => { const z = q[x.symbol] || {}, sp = z.ap > 0 ? (z.ap - z.bp) / z.ap : null;
      return { contract: x.symbol, expiry: ex, strike: +x.strike_price, bid: z.bp ?? null, ask: z.ap ?? null, spreadPct: sp == null ? null : r2(sp * 100), ageSec: z.t ? Math.round((Date.now() - Date.parse(z.t)) / 1000) : null, botWouldSkip: !(z.ap > 0 && z.bp > 0) || sp > 0.05 }; });
  }
  return out;
}

// ---- account part (sealed) ----
async function orders(day) {
  const j = await get(`${TRADE}/v2/orders?status=all&after=${day}T11:00:00Z&until=${addDays(day, 1)}T01:00:00Z&limit=500&direction=asc&nested=false`);
  if (j.err || !Array.isArray(j)) return { err: j.err || 'not a list' };
  const spy = j.filter(o => /^sd-y[cp]-/.test(o.client_order_id || '') && o.side === 'buy');
  return { allBot: j.filter(o => /^sd-/.test(o.client_order_id || '')).length, placed: spy.length, filled: spy.filter(o => +o.filled_qty > 0).length,
    list: spy.map(o => ({ t: etParts(Date.parse(o.submitted_at || o.created_at)).hour + ':' + etParts(Date.parse(o.submitted_at || o.created_at)).minute, side: /^sd-yp/.test(o.client_order_id) ? 'put' : 'call', sym: o.symbol, lim: +o.limit_price, qty: +o.qty, filledQty: +o.filled_qty, fillPx: +o.filled_avg_price || null, status: o.status })) };
}
async function equity() {
  const a = await get(`${TRADE}/v2/account`), h = await get(`${TRADE}/v2/account/portfolio/history?period=1M&timeframe=1D`);
  return { now: a.err ? null : { equity: +a.equity, lastEquity: +a.last_equity, daytradeCount: +a.daytrade_count, pdt: !!a.pattern_day_trader },
    daily: h.err ? { err: h.err } : (h.timestamp || []).map((ts, i) => ({ d: etDay(ts * 1000 + 6 * 3600e3), eq: (h.equity || [])[i] })) };
}
const KEEP_LOG = /quick trade|tick through|skipped|unfilled|option buy|Market check|aused|Telegram|engine error|rror|15-minute|VWAP|halt|⛔|STOP|ession|Restarted|News feed|take-profit|SPY|overnight|no contract|live quote|spread|order placed|no order/;
const DROP_LOG = /site prices refreshed|data-stream: streaming|options-stream: quotes|live view publish|commit skipped|##\[/;
async function ghLog(jobId) {
  await sleep(500);
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/jobs/${jobId}/logs`, { headers: GHH, redirect: 'manual' });
  const loc = r.headers.get('location');
  if (r.status >= 300 && r.status < 400 && loc) { const r2b = await fetch(loc); return r2b.ok ? r2b.text() : { err: r2b.status }; }
  return r.ok ? r.text() : { err: r.status };
}
async function sessionLogs(day) {
  if (!GH || !REPO) return { note: 'no GitHub token' };
  const runs = [];
  for (let p = 1; p <= 4; p++) {
    const j = await get(`https://api.github.com/repos/${REPO}/actions/workflows/trade.yml/runs?created=${day}&per_page=100&page=${p}`, GHH);
    if (j.err) return { err: 'runs HTTP ' + j.err };
    runs.push(...(j.workflow_runs || [])); if ((j.workflow_runs || []).length < 100) break;
  }
  const long = runs.filter(r => r.status === 'in_progress' || (r.run_started_at && Date.parse(r.updated_at) - Date.parse(r.run_started_at) > 5 * 60000));
  const out = [];
  for (const r of long) {
    const jobs = await get(`https://api.github.com/repos/${REPO}/actions/runs/${r.id}/jobs`, GHH);
    for (const job of jobs.jobs || []) {
      const row = { run: r.id, started: job.started_at, ended: job.completed_at, status: job.status, conclusion: job.conclusion };
      if (job.status !== 'completed') { row.note = 'still running — its log can be read when it ends'; out.push(row); continue; }
      const t = await ghLog(job.id);
      if (typeof t !== 'string') { row.err = 'log HTTP ' + t.err; out.push(row); continue; }
      const lines = [];
      for (const ln of t.split('\n')) {
        const m = /^﻿?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z (.*)$/.exec(ln.trim()); if (!m) continue;
        if (!KEEP_LOG.test(m[2]) || DROP_LOG.test(m[2])) continue;
        const p = etParts(Date.parse(m[1] + 'Z')); lines.push(`${p.hour}:${p.minute}:${p.second} ${m[2].slice(0, 300)}`);
      }
      row.logLines = t.split('\n').length; row.lines = lines.slice(0, 4000); row.cut = Math.max(0, lines.length - 4000);
      out.push(row);
    }
  }
  return { runs: runs.length, sessions: out };
}
function seal(obj, pubB64) {
  const pub = crypto.createPublicKey({ key: Buffer.from(pubB64, 'base64'), format: 'der', type: 'spki' });
  const k = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { alg: 'RSA-OAEP-256 + A256GCM', key: crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, k).toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

const CFG = normalize(JSON.parse(fs.readFileSync('bot/config.json', 'utf8'))), C = { ...SPY_DEFAULTS, ...CFG };
let events = []; try { events = JSON.parse(fs.readFileSync('events.json', 'utf8')).events || []; } catch (e) {}
let days = String(process.env.DAYS || '').split(',').map(s => s.trim()).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s));
if (!days.length) { let d = etDay(Date.now()); if (etMin(Date.now()) < 590) d = addDays(d, -1); while (days.length < 4) { if (![0, 6].includes(wd(d))) days.unshift(d); d = addDays(d, -1); } }
const out = { at: new Date().toISOString(), settings: { spyOn: C.spyOn, spyStart: C.spyStart, spyEnd: C.spyEnd, spyDte: C.spyDte, spyMaxOpen: C.spyMaxOpen, newsGuard: C.newsGuard, eventGuard: C.eventGuard }, days: [], quotesNow: null };
for (const d of days) { try { out.days.push(await replay(d, C, events)); } catch (e) { out.days.push({ day: d, error: e.message }); } console.log(d, 'replayed'); }
try { out.quotesNow = await quotesNow(C); } catch (e) { out.quotesNow = { error: e.message }; }
if (SEAL) {
  const acct = { equity: null, orders: {}, logs: {} };
  try { acct.equity = await equity(); } catch (e) { acct.equity = { error: e.message }; }
  for (const d of days) {
    try { acct.orders[d] = await orders(d); } catch (e) { acct.orders[d] = { error: e.message }; }
    try { acct.logs[d] = await sessionLogs(d); } catch (e) { acct.logs[d] = { error: e.message }; }
  }
  out.account = { sealed: seal(acct, SEAL) };
}
fs.mkdirSync(OUT.replace(/\/[^/]*$/, ''), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
for (const d of out.days) console.log(d.day, d.error || d.note || `paused ${d.minutes.paused}/${d.minutes.window} min · armed bars ${d.armedBars.length} · breaks now ${d.signalsNow.filter(s => !s.paused).length} (+${d.signalsNow.filter(s => s.paused).length} in pauses) · before ${d.signalsBefore.filter(s => !s.paused).length}`);
console.log('quotes now', JSON.stringify(out.quotesNow).slice(0, 600));
