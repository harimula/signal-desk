// End-to-end check against a fake broker: which orders does one decision cycle place?
//   node bot/test-orders.mjs
// A stock that just dipped (uptrend, RSI-2 ~0) and one that just popped (downtrend, RSI-2 ~100) are served
// at 10:00 ET on a Friday, and the bot runs once for each combination of the CALL and PUT switches.
// Each case runs in its own process and its own temp folder, so the real journal is never touched.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

if (process.argv[2] === 'child') {
  const cfg = JSON.parse(process.argv[3]), FAKE = JSON.parse(process.argv[4] || '{}');
  const REAL = Date, FIXED = REAL.parse(FAKE.time || '2026-10-23T14:00:00Z');          // Fri 10:00 ET by default, inside the entry window
  globalThis.Date = class extends REAL { constructor(...a) { if (a.length) super(...a); else super(FIXED); } static now() { return FIXED; } };

  const weekdays = n => { const out = []; let d = new REAL('2026-10-22T04:00:00Z'); while (out.length < n) { if (d.getUTCDay() % 6) out.unshift(new REAL(d)); d = new REAL(d.getTime() - 864e5); } return out; };
  const days = weekdays(300);
  const series = (start, end, tail) => days.map((d, i) => {
    const base = i < 298 ? start + (end - start) * i / 297 : null;
    return { d, base };
  }).reduce((acc, x, i) => {
    let c;
    if (x.base != null) c = x.base; else c = acc.length ? acc[acc.length - 1].c * (1 + tail[i - 298]) : end;
    acc.push({ t: x.d.toISOString().slice(0, 10) + 'T04:00:00Z', o: c, h: c * 1.004, l: c * 0.996, c, v: 1e6 });   // volume patched per symbol below
    return acc;
  }, []);
  const BARS = {
    DIP: series(80, 120, [-0.04, -0.04]),        // uptrend, two sharp down days  -> RSI-2 ~ 0, above 200-day
    LAG: (() => { const a = series(60, 118, [-0.05, -0.05]); const f = a[234].c; for (let i = 235; i < 298; i++) Object.assign(a[i], { o: f, h: f * 1.004, l: f * 0.996, c: f }); for (let i = 298; i < 300; i++) { const c = a[i - 1].c * 0.95; Object.assign(a[i], { o: c, h: c * 1.004, l: c * 0.996, c }); } return a; })(),   // also dipping (−5% twice) but flat for the 3 months before: 'leaders first' picks DIP (still rising), 'deepest dip' would pick LAG
    POP: series(120, 80, [0.04, 0.04]),          // downtrend, two sharp up days  -> RSI-2 ~ 100, below 200-day
    FALL: series(80, 120, [0.001, 0.001]),       // uptrend, quiet at yesterday's close; the live price below drops it 10%
    SPY: series(400, 520, [0.001, 0.001]),
    QUIET: series(200, 210, [0.001, 0.001]),      // ordinary liquid stock, no signal
    ORB: series(95, 100.5, [0.001, 0.001]),
    ORB2: series(95, 100.5, [0.001, 0.001]),        // day-trade stock: flat daily picture, action is intraday
    BRK: series(105, 100.5, [-0.001, -0.001]),
    JUNK: series(2, 3, [-0.04, -0.04]),           // penny stock that also dipped: the scan must drop it (price < $5)
  };
  BARS.JUNK.forEach(b => b.v = 5e7); BARS.SPY.forEach(b => b.v = 5e6);
  const lastC = s => BARS[s][BARS[s].length - 1].c;
  // intraday 5-minute bars for today (UTC times; 13:30Z = 9:30 ET on an EDT day)
  const m5 = (hm, o, h, l, c, v) => ({ t: '2026-10-23T' + hm + ':00Z', o, h, l, c, v, n: 100, vw: c });
  const ORB5 = [m5('13:30', 100.2, 101, 100, 100.6, 60000), m5('13:35', 100.6, 100.9, 100.1, 100.4, 50000), m5('13:40', 100.4, 100.8, 100.2, 100.7, 50000), m5('13:45', 100.7, 100.95, 100.5, 100.9, 55000), m5('13:50', 100.9, 101.6, 100.8, 101.5, 90000)];
  const BRK5 = ORB5.map(b => ({ ...b, o: 201 - b.o, h: 201 - b.l, l: 201 - b.h, c: 201 - b.c }));
  const SPY5 = (FAKE.spy || 'up') === 'up' ? [m5('13:30', 500, 501, 499.5, 500.6, 2e6), m5('13:35', 500.6, 501.2, 500.4, 501, 2e6), m5('13:40', 501, 501.8, 500.9, 501.6, 2e6), m5('13:45', 501.6, 502, 501.4, 501.9, 2e6), m5('13:50', 501.9, 502.5, 501.8, 502.3, 2e6)]
    : [m5('13:30', 500, 500.5, 499, 499.4, 2e6), m5('13:35', 499.4, 499.6, 498.8, 499, 2e6), m5('13:40', 499, 499.1, 498.2, 498.4, 2e6), m5('13:45', 498.4, 498.6, 498, 498.1, 2e6), m5('13:50', 498.1, 498.2, 497.2, 497.5, 2e6)];
  const BARS5 = { ORB: ORB5, ORB2: ORB5, BRK: BRK5, SPY: SPY5, ...(FAKE.bars5 || {}) };
  const LIVE = { ORB: 101.55, ORB2: 101.55, BRK: 99.45, SPY: (FAKE.spy || 'up') === 'up' ? 502.4 : 497.4, ...(FAKE.live || {}) };
  const orders = [], unknown = [], deletes = [], patches = [], tgSent = [];
  const tgMsg = (id, chat, text) => ({ update_id: id, message: { chat: { id: chat }, date: Math.floor(FIXED / 1000), text } });
  const tgConfirms = [];
  const tgQueue = [(FAKE.tgBefore || []).map((t, i) => tgMsg(100 + i, t[0], t[1])), (FAKE.tgAfter || []).map((t, i) => tgMsg(200 + i, t[0], t[1]))];
  const occ = (und, type, px) => und + '261113' + type[0].toUpperCase() + String(Math.round(px) * 1000).padStart(8, '0');

  const TRADING_ONLY = /^\/v2\/(account|positions|orders|clock|assets|calendar|options\/contracts)/, DATA_ONLY = /^\/v2\/stocks\/|^\/v1beta1\//;
  const handler = isData => (req, res) => {
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    if (!/^\/bottest-token/.test(p) && ((isData && TRADING_ONLY.test(p)) || (!isData && DATA_ONLY.test(p)))) { unknown.push((isData ? 'DATA ' : 'TRADING ') + req.method + ' ' + p); res.statusCode = 404; res.setHeader('content-type', 'application/json'); return res.end('{"message":"wrong host"}'); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const send = o => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      if (p === '/bottest-token/getUpdates') { let q = {}; try { q = JSON.parse(body || '{}'); } catch (e) {} if (q.limit === 1) { tgConfirms.push(q.offset); return send({ ok: true, result: [] }); } return send({ ok: true, result: tgQueue.shift() || [] }); }   // limit 1 = the bot confirming what it handled
      if (p === '/bottest-token/sendMessage') { tgSent.push(JSON.parse(body)); return send({ ok: true, result: { message_id: tgSent.length } }); }
      if (p === '/v2/calendar') { const d = u.searchParams.get('start'); return send([{ date: d, open: '09:30', close: FAKE.calClose || '16:00' }]); }
      if (p === '/v2/clock' && FAKE.clockFail) { res.statusCode = 500; return send({ message: 'down' }); }
      if (p.startsWith('/v2/positions/') && req.method === 'GET') { const one = (FAKE.positions || []).find(x => x.symbol === decodeURIComponent(p.split('/').pop())); if (!one) { res.statusCode = 404; return send({ message: 'position does not exist' }); } return send(one); }
      if (p === '/v2/clock') return send({ is_open: !FAKE.closed, timestamp: new REAL(FIXED).toISOString(), next_open: '2026-10-26T09:30:00-04:00', next_close: FAKE.nextClose || '2026-10-23T16:00:00-04:00' });
      if (p === '/v2/account') return send({ equity: '100000', last_equity: '100000', cash: '100000', buying_power: '400000', pattern_day_trader: false, daytrade_count: 0, status: 'ACTIVE', multiplier: '4' });
      if (p === '/v2/positions' && req.method === 'GET') return send(FAKE.positions || []);
      if (p === '/v2/assets' && FAKE.slowAssets) return setTimeout(() => send([]), FAKE.slowAssets);
      if (p === '/v2/assets') return send(Object.keys(BARS).map(s => ({ symbol: s, tradable: true, exchange: 'NASDAQ' })).concat([{ symbol: 'OTCX', tradable: true, exchange: 'OTC' }, { symbol: 'WARR.WS', tradable: true, exchange: 'NYSE' }]));
      if (p === '/v2/account/activities/FILL') return send(FAKE.fills || []);
      if (p === '/v2/account/portfolio/history') return send({ equity: [100000, 100000], timestamp: [1, 2], base_value: 100000 });
      if (p === '/v2/orders' && req.method === 'DELETE') { deletes.push('all-orders'); return send([]); }
      if (p.startsWith('/v2/positions') && req.method === 'DELETE') { deletes.push('all-positions'); return send([]); }
      if (p.startsWith('/v2/orders/') && req.method === 'DELETE') { deletes.push(p.split('/').pop()); return send(null); }
      if (p.startsWith('/v2/orders/') && req.method === 'GET') { const id = p.split('/').pop(); return send({ id, status: deletes.includes(id) ? 'canceled' : 'new' }); }   // single order: the bot confirms a cancel went through
      if (p.startsWith('/v2/orders/') && req.method === 'PATCH') { patches.push({ id: p.split('/').pop(), ...JSON.parse(body || '{}') }); return send({ id: 'r' + patches.length, status: 'replaced' }); }
      if (p === '/v2/orders' && req.method === 'POST') { const o = JSON.parse(body); orders.push(o); return send({ id: 'o' + orders.length, status: 'accepted', ...o }); }
      if (p === '/v2/orders') return send(u.searchParams.get('status') === 'open' ? (FAKE.open || []) : (FAKE.hist || []));
      if (p === '/v2/stocks/bars' && u.searchParams.get('timeframe') === '5Min') { const out = {}; for (const s of (u.searchParams.get('symbols') || '').split(',')) if (BARS5[s]) out[s] = BARS5[s]; return send({ bars: out }); }
      if (p === '/v2/stocks/bars') { const out = {}; for (const s of (u.searchParams.get('symbols') || '').split(',')) if (BARS[s]) out[s] = BARS[s]; return send({ bars: out }); }
      if (p === '/v2/stocks/trades/latest') { const out = {}; for (const s of (u.searchParams.get('symbols') || '').split(',')) if (LIVE[s] != null) out[s] = { p: LIVE[s], t: '2026-10-23T14:00:00Z' }; else if (BARS[s]) out[s] = { p: s === 'FALL' ? lastC(s) * 0.9 : lastC(s), t: '2026-10-23T14:00:00Z' }; return send({ trades: out }); }
      if (p === '/v1beta1/news') return send({ news: [] });
      if (p === '/v2/options/contracts') {
        const und = u.searchParams.get('underlying_symbols'), type = u.searchParams.get('type'), px = lastC(und);
        return send({ option_contracts: [{ symbol: occ(und, type, px), expiration_date: '2026-11-13', strike_price: String(Math.round(px)), tradable: true, type }] });
      }
      if (p === '/v1beta1/options/quotes/latest') { const out = {}; for (const s of (u.searchParams.get('symbols') || '').split(',')) out[s] = FAKE.quote || { ap: 2.05, bp: 2.0 }; return send({ quotes: out }); }
      unknown.push(req.method + ' ' + p); send({});
    });
  };
  const server = http.createServer(handler(false)), dataServer = http.createServer(handler(true));
  await new Promise(r => server.listen(0, '127.0.0.1', r)); await new Promise(r => dataServer.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port, dataUrl = 'http://127.0.0.1:' + dataServer.address().port;
  process.env.ALPACA_URL = url; process.env.ALPACA_DATA_URL = dataUrl;
  process.env.ALPACA_KEY = 'test'; process.env.ALPACA_SECRET = 'test';
  if (FAKE.journalKey) process.env.JOURNAL_KEY = FAKE.journalKey;
  if (FAKE.reset) process.env.JOURNAL_RESET = '1';
  if (FAKE.tg) { process.env.TELEGRAM_API = url; process.env.TELEGRAM_TOKEN = 'test-token'; process.env.TELEGRAM_CHAT = '42'; }                        // privacy mode: encrypted journal (must be set before the import)
  fs.mkdirSync('bot', { recursive: true });
  const bot = await import(pathToFileURL(path.join(HERE, 'bot.mjs')).href);
  if (FAKE.stop) fs.writeFileSync('bot/STOP', 'stop');
  if (FAKE.prevJournal) fs.writeFileSync('bot/journal.json', JSON.stringify(FAKE.journalKey ? await bot.encryptJournal(FAKE.prevJournal, FAKE.prevKey || FAKE.journalKey, 1000) : FAKE.prevJournal));   // what the previous run left behind
  bot.applyConfig({ symbols: ['DIP', 'POP', 'FALL'], mode: 'paper', newsGuard: false, eventGuard: false, ...cfg });
  if (FAKE.tg) await bot.tgPollCycle();
  const tc0 = REAL.now(); await bot.botCycle({ journal: !!FAKE.closed }); const cycleMs = REAL.now() - tc0;
  if (FAKE.tg) await bot.tgPollCycle();
  if (FAKE.positionsAfter) { FAKE.positions = FAKE.positionsAfter; if (FAKE.fillsAfter) FAKE.fills = FAKE.fillsAfter; }
  if (FAKE.cycles > 1) for (let k = 1; k < FAKE.cycles; k++) await bot.botCycle({ journal: true });   // a longer session: the journal is rewritten several times
  let fast = null;
  if (FAKE.fast) { const before = orders.length; FAKE.positions = FAKE.fast.positions; await bot.spyFast(); fast = { placed: orders.slice(before), hasOpen: bot.spyHasOpen() }; }
  let tickEntry = null;
  if (FAKE.tick2) { const before = orders.length; const ok = await bot.spyEnter(FAKE.tick2); tickEntry = { ok, placed: orders.slice(before) }; }
  if (FAKE.tick) { const before = orders.length; const ok = await bot.spyEnter(FAKE.tick); const again = await bot.spyEnter(FAKE.tick); tickEntry = { ok, again, placed: orders.slice(before), open: bot.spyOpenSymbols() };
    if (FAKE.cycleAfterTick) { LIVE.SPY = FAKE.tick + 0.6; const b2 = orders.length; await bot.botCycle({ journal: false }); tickEntry.after = { placed: orders.slice(b2), hasOpen: bot.spyHasOpen() }; } }   // a full cycle right after a tick entry
  let quoteExit = null;
  if (FAKE.quote2) { if (FAKE.quoteGone) FAKE.positions = []; const before = orders.length; await bot.spyOnQuote(FAKE.quote2.sym, FAKE.quote2.bp, FAKE.quote2.ap); await bot.spyOnQuote(FAKE.quote2.sym, FAKE.quote2.bp, FAKE.quote2.ap); quoteExit = { placed: orders.slice(before), deletes: [...deletes] }; }
  const spyW = bot.spyWatch();
  server.closeAllConnections && server.closeAllConnections(); server.close(); dataServer.closeAllConnections && dataServer.closeAllConnections(); dataServer.close();
  let jj = null; try { jj = JSON.parse(fs.readFileSync('bot/journal.json', 'utf8')); if (jj.enc) jj = { ...jj, ...(await bot.decryptJournal(jj, FAKE.journalKey)) }; } catch (e) {}
  let keptOld = false; if (FAKE.prevKey) try { await bot.decryptJournal(JSON.parse(fs.readFileSync('bot/journal.json', 'utf8')), FAKE.prevKey); keptOld = true; } catch (e) {}
  const watch = jj && jj.watch, day = jj && jj.day, env = jj && jj.env, acts = jj && jj.acts ? jj.acts.map(a => a.m) : null;
  process.stdout.write('RESULT ' + JSON.stringify({ since: jj && jj.since, keptOld, tgConfirms, tickEntry, quoteExit, fast, spyWatch: spyW, spy: jj && jj.spy, split: jj && jj.split, cycleMs, tgSent, acts, watch, day, env, enc: !!(jj && jj.enc), deletes, patches, orders, unknown, options: orders.filter(o => /\d{6}[CP]\d{8}$/.test(o.symbol)).map(o => ({ symbol: o.symbol, id: o.client_order_id.split('-').slice(0, 2).join('-') })) }) + '\n');   // not console.log: privacy mode redacts that
  process.exit(0);
}

function run(cfg, fake) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-orders-'));
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'child', JSON.stringify(cfg), JSON.stringify(fake || {})], { cwd: tmp, encoding: 'utf8', timeout: 90000 });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  if (!line) throw new Error('no result for ' + JSON.stringify(cfg) + '\n' + r.stdout + r.stderr);
  return JSON.parse(line.slice(7));
}

let passed = 0;
const check = (name, fn) => { try { fn(); console.log('  ✓', name); passed++; } catch (e) { console.log('  ✗', name, '\n   ', e.message); process.exitCode = 1; } };

const A = run({ stocks: true, options: true });                       // default: puts off
check('default: stock buy on the dip stock', () => assert.ok(A.orders.some(o => o.symbol === 'DIP' && o.side === 'buy')));
check('default: the swing buy carries a broker-side stop at the hard floor (OTO leg, good-till-cancelled)', () => { const o = A.orders.find(x => x.symbol === 'DIP' && x.side === 'buy'); assert.equal(o.order_class, 'oto'); assert.equal(o.time_in_force, 'gtc'); const fl = +o.stop_loss.stop_price; assert.ok(Math.abs(fl / +o.limit_price - 0.75) < 0.002, 'floor ' + fl + ' vs limit ' + o.limit_price); });
check('default: CALL on the dip stock (sd-q-)', () => { assert.equal(A.options.length, 1); assert.match(A.options[0].symbol, /^DIP\d{6}C/); assert.equal(A.options[0].id, 'sd-q'); });
check('alerts: a buy alert carries size and price', () => assert.ok((A.acts || []).some(m => /DIP RSI-2 dip buy .*\u00b7 \d+ shares @ \$[\d.]+ \(\$[\d,]+/.test(m)), JSON.stringify(A.acts)));
check('default: no PUT is ever placed', () => assert.ok(!A.orders.some(o => /^POP\d{6}P/.test(o.symbol))));

const B = run({ stocks: true, options: true, puts: true });
check('puts on: CALL still placed on the dip stock', () => assert.ok(B.options.some(o => /^DIP\d{6}C/.test(o.symbol) && o.id === 'sd-q')));
check('puts on: PUT placed on the pop stock (sd-p-)', () => assert.ok(B.options.some(o => /^POP\d{6}P/.test(o.symbol) && o.id === 'sd-p')));
check('alerts: an option buy alert shows contracts and the per-contract price', () => assert.ok((B.acts || []).some(m => /PUT on RSI-2 pop.*\u00b7 \d+ contracts? @ \$[\d.]+\/contract \(\$[\d,]+\)/.test(m)), JSON.stringify(B.acts)));
check('puts on: no stock order for the pop stock (no shorting stock)', () => assert.ok(!B.orders.some(o => o.symbol === 'POP')));
check('puts on: PUT is a limit buy of whole contracts', () => { const o = B.orders.find(x => /^POP\d{6}P/.test(x.symbol)); assert.equal(o.side, 'buy'); assert.equal(o.type, 'limit'); assert.ok(+o.qty >= 1 && Number.isInteger(+o.qty)); });

const C = run({ stocks: false, options: false, puts: true });
check('puts only: just the PUT, nothing else', () => { assert.equal(C.orders.length, 1); assert.match(C.orders[0].symbol, /^POP\d{6}P/); });

const D = run({ stocks: true, options: false, puts: false });
check('options off, puts off: stock only', () => { assert.ok(D.orders.every(o => !/\d{6}[CP]\d{8}$/.test(o.symbol))); });

const E = run({ stocks: true, options: true, puts: true, stockUnit: 'usd', stockUsd: 1000, callUnit: 'usd', callUsd: 150, putUnit: 'usd', putUsd: 500 });
check('dollars: stock buy never exceeds the fixed dollar amount', () => { const o = E.orders.find(x => x.symbol === 'DIP'); assert.ok(o); assert.ok(+o.qty * +o.limit_price <= 1000, o.qty + ' x ' + o.limit_price); });
check('dollars: CALL skipped when one contract costs more than the call amount', () => assert.ok(!E.orders.some(o => /^DIP\d{6}C/.test(o.symbol))));
check('dollars: PUT placed when one contract fits the put amount', () => assert.ok(E.orders.some(o => /^POP\d{6}P/.test(o.symbol))));

check('watch list: published with RSI-2 for each stock, and who qualifies for BUY / CALL / PUT', () => {
  assert.ok(B.watch, 'no watch data in the journal');
  assert.deepEqual(B.watch.buy, ['DIP']); assert.deepEqual(B.watch.call, ['DIP']); assert.deepEqual(B.watch.put, ['POP']);
  const dip = B.watch.rows.find(r => r.s === 'DIP'), pop = B.watch.rows.find(r => r.s === 'POP');
  assert.ok(dip.up && dip.r2 < 10); assert.ok(!pop.up && pop.r2 > 90);
  assert.deepEqual(A.watch.put, []);
});

const I0 = run({ stocks: true, options: false, intraday: false });
check('intraday off: a stock that only dips during the day is NOT bought', () => assert.ok(!I0.orders.some(o => o.symbol === 'FALL')));
const I1 = run({ stocks: true, options: false, intraday: true });
check('intraday on: the same stock IS bought on the live-price dip', () => assert.ok(I1.orders.some(o => o.symbol === 'FALL' && o.side === 'buy')));
check('intraday on: stocks that qualified at the close still qualify, and the watch list says live', () => { assert.ok(I1.orders.some(o => o.symbol === 'DIP')); assert.equal(I1.watch.intraday, true); assert.ok(I1.watch.buy.includes('FALL')); });

const S = run({ stocks: true, options: false, universe: 'scan', scanSize: 50, scanMinPrice: 5, symbols: ['AAPL'] });
check('market scan: the list setting is ignored and the most-traded stocks are watched instead', () => { assert.equal(S.watch.universe, 'scan'); assert.ok(S.watch.rows.some(r => r.s === 'DIP')); assert.ok(!S.watch.rows.some(r => r.s === 'AAPL')); });
check('market scan: a penny stock is dropped even though it dipped and trades heavily', () => { assert.ok(!S.orders.some(o => o.symbol === 'JUNK')); assert.ok(!S.watch.rows.some(r => r.s === 'JUNK')); assert.equal(S.watch.scanned, 9); });
check('market scan: the dip stock found by the scan is bought', () => assert.ok(S.orders.some(o => o.symbol === 'DIP' && o.side === 'buy')));

// ---- day trading ----
const DT = { stocks: false, options: false, puts: false, dayTrade: true, dayStock: true, dayPuts: true, dayCalls: false, symbols: ['ORB', 'BRK', 'QUIET'], dayRvol: 1.2 };
const D0 = run({ stocks: true, options: true, symbols: ['ORB', 'BRK'] });
check('day trading off: the breakout stock is NOT bought and no day ids appear', () => assert.ok(!D0.orders.some(o => /^sd-d/.test(o.client_order_id))));
const D1 = run(DT);
check('day trading on, market up: ORB long → stock buy with stop/target in the order id', () => {
  const o = D1.orders.find(x => x.symbol === 'ORB' && x.side === 'buy'); assert.ok(o, JSON.stringify(D1.orders.map(x => x.symbol)) + ' ' + JSON.stringify(D1.acts));
  const d = /^sd-d-ORB-(\d+)-(\d+)-(\d+)-20261023-600-/.exec(o.client_order_id); assert.ok(d, o.client_order_id);
  const entry = +d[1] / 100, stop = +d[2] / 100, tgt = +d[3] / 100; assert.ok(stop < entry && tgt > entry && Math.abs((tgt - entry) - 2 * (entry - stop)) < 0.03, 'levels ' + [entry, stop, tgt]);
});
check('day trading: the entry is a bracket order with the stop and the target at the broker', () => { const o = D1.orders.find(x => x.symbol === 'ORB' && x.side === 'buy'); assert.equal(o.order_class, 'bracket'); assert.ok(+o.stop_loss.stop_price < +o.limit_price && +o.take_profit.limit_price > +o.limit_price, JSON.stringify(o)); });
check('day trading on, market up: the breakdown stock is left alone (no shorting stock, PUTs only when the market is down)', () => assert.ok(!D1.orders.some(o => /^BRK/.test(o.symbol))));
check('day trading: sizing never risks more than 0.5% at the stop nor more than the stock money budget', () => { const o = D1.orders.find(x => x.symbol === 'ORB'); const d = /-(\d+)-(\d+)-(\d+)-20261023/.exec(o.client_order_id); const risk = (+d[1] - +d[2]) / 100 * +o.qty; assert.ok(risk <= 500 && risk > 50, 'risk $' + risk); assert.ok(+o.qty * +o.limit_price <= 10000, 'spent ' + (+o.qty * +o.limit_price)); });
const D2 = run(DT, { spy: 'down' });
check('day trading on, market down: ORB breakdown → PUT (sd-dp-), no stock buy', () => { assert.ok(D2.orders.some(o => /^BRK\d{6}P/.test(o.symbol) && /^sd-dp-/.test(o.client_order_id)), JSON.stringify(D2.orders.map(o => o.symbol + ' ' + o.client_order_id)) + JSON.stringify(D2.acts)); assert.ok(!D2.orders.some(o => o.symbol === 'ORB')); });
const D3 = run({ ...DT, dayMaxTrades: 1 }, { hist: [{ symbol: 'QUIET', side: 'buy', status: 'filled', client_order_id: 'sd-d-QUIET-20500-20300-20900-20261023-590-zz', qty: '10', limit_price: '205' }] });
check('day trading: the daily maximum of trades is honoured', () => { assert.ok(!D3.orders.some(o => o.symbol === 'ORB'), JSON.stringify(D3.orders)); assert.ok(/daily maximum/.test(D3.day.idle || ''), D3.day.idle); });
const openPos = { symbol: 'ORB', qty: '98', avg_entry_price: '101.6', current_price: '102.2', market_value: '10015', unrealized_pl: '58.8', unrealized_plpc: '0.0059' };
const histBuy = { symbol: 'ORB', side: 'buy', status: 'filled', client_order_id: 'sd-d-ORB-10160-10040-10400-20261023-600-ab1', qty: '98', limit_price: '101.6' };
const D4 = run(DT, { time: '2026-10-23T19:52:00Z', positions: [openPos], hist: [histBuy], live: { ORB: 102.2 } });
check('day trading: an open day trade is sold flat at 3:50 PM whatever the price', () => assert.ok(D4.orders.some(o => o.symbol === 'ORB' && o.side === 'sell' && o.type === 'market'), JSON.stringify(D4.orders) + JSON.stringify(D4.acts)));
const D5 = run(DT, { time: '2026-10-23T14:30:00Z', positions: [openPos], hist: [histBuy], live: { ORB: 100.3 } });
check('day trading: the stop sells at market as soon as the price is through it', () => assert.ok(D5.orders.some(o => o.symbol === 'ORB' && o.side === 'sell' && o.type === 'market'), JSON.stringify(D5.orders)));
const legs = [{ id: 'leg-stop', symbol: 'ORB', side: 'sell', type: 'stop', stop_price: '100.4', qty: '98', status: 'new', client_order_id: 'x1' }, { id: 'leg-tp', symbol: 'ORB', side: 'sell', type: 'limit', limit_price: '104', qty: '98', status: 'new', client_order_id: 'x2' }];
const D5b = run(DT, { time: '2026-10-23T14:30:00Z', positions: [openPos], hist: [histBuy], open: legs, live: { ORB: 100.3 } });
check('day trading: with the broker stop leg in place, the bot does NOT double-sell when the price is through the stop', () => assert.ok(!D5b.orders.some(o => o.symbol === 'ORB' && o.side === 'sell'), JSON.stringify(D5b.orders)));
const D4b = run(DT, { time: '2026-10-23T19:52:00Z', positions: [openPos], hist: [histBuy], open: legs, live: { ORB: 102.2 } });
check('day trading: flat at 3:50 cancels both broker legs, then sells at market', () => { assert.deepEqual([...D4b.deletes].sort(), ['leg-stop', 'leg-tp']); assert.ok(D4b.orders.some(o => o.symbol === 'ORB' && o.side === 'sell' && o.type === 'market')); });
const D7 = run(DT, { time: '2026-10-23T14:30:00Z', positions: [openPos], hist: [histBuy], open: legs, live: { ORB: 102.9 } });   // +1R and more (entry 101.6, stop 100.4)
check('day trading: at +1R the broker stop leg is moved to breakeven', () => { assert.ok(D7.patches.some(p => p.id === 'leg-stop' && Math.abs(+p.stop_price - 101.6) < 0.01), JSON.stringify(D7.patches) + JSON.stringify(D7.acts)); assert.ok(!D7.orders.some(o => o.symbol === 'ORB' && o.side === 'sell')); });
const D6 = run(DT, { time: '2026-10-23T14:30:00Z', positions: [openPos], hist: [histBuy], live: { ORB: 102.2 } });
check('day trading: while the trade is working, a take-profit order rests at the target and nothing is sold', () => { const s = D6.orders.filter(o => o.symbol === 'ORB' && o.side === 'sell'); assert.equal(s.length, 1, JSON.stringify(s)); assert.equal(s[0].type, 'limit'); assert.equal(+s[0].limit_price, 104); });

const ST = run({ stocks: true, options: false, symbols: ['DIP'], stakeUsd: 5000 });
check('stake: with a $5,000 stake the buy is sized on $5,000, not on the $100,000 account', () => { const o = ST.orders.find(x => x.symbol === 'DIP' && x.side === 'buy'); assert.ok(o, JSON.stringify(ST.acts)); assert.ok(+o.qty * +o.limit_price <= 500 + 120, 'spent ' + (+o.qty * +o.limit_price) + ' (10% of the stake is $500)'); });

const F = run({ stocks: true, options: true, puts: true, stockUnit: 'usd', stockUsd: 5000, stockCapUsd: 50, callCapPct: 0.1, putUnit: 'usd', putUsd: 5000, putCapUsd: 100 });
check('ceilings: nothing bought when each sleeve ceiling is below one unit', () => assert.equal(F.orders.length, 0, JSON.stringify(F.orders.map(o => o.symbol))));

// ---- the journal survives restarts: a run that starts with the market closed must not blank out what the day's run published ----
const prevJ = { at: '2026-10-23T20:03:00Z', sig: 'x', acts: [{ t: '2026-10-23T19:58:00.000Z', m: 'Earlier today: DIP RSI-2 dip buy' }], env: { at: '2026-10-23T19:58:00Z', block: false, reasons: ['Bear market regime'], flagged: [] },
  risk: { heatPct: 1.2, capPct: 6 }, watch: { at: '2026-10-23T19:58:00Z', rows: [{ s: 'DIP', r2: 3.1, up: true }], buy: ['DIP'], call: ['DIP'], put: [], on: { stocks: true, calls: true, puts: false }, total: 3 }, day: { on: false, setups: [] } };
const J1 = run({ stocks: true, options: true }, { time: '2026-10-23T20:01:00Z', closed: true, journalKey: 'test-pass', prevJournal: prevJ });   // 4:01 PM ET, market closed, encrypted journal on disk
check('journal: a run that starts after the close keeps the watch list, market check, risk panel and day block from the day\'s run (decrypting its own previous entry)', () => {
  assert.ok(J1.enc, 'journal was not encrypted'); assert.ok(J1.watch, 'watch list lost: ' + JSON.stringify(J1));
  assert.deepEqual(J1.watch.buy, ['DIP']); assert.equal(J1.watch.at, '2026-10-23T19:58:00Z');
  assert.deepEqual(J1.env.reasons, ['Bear market regime']); assert.ok(J1.day && J1.day.on === false);
});
check('journal: the action log carries over across a restart instead of starting empty', () => assert.ok((J1.acts || []).includes('Earlier today: DIP RSI-2 dip buy'), JSON.stringify(J1.acts)));
const J2 = run({ stocks: true, options: true }, { journalKey: 'test-pass', prevJournal: prevJ, cycles: 3 });   // market open: three cycles, three journal writes
check('journal: an open-market cycle replaces the carried-over watch list with a fresh one', () => { assert.ok(J2.watch && J2.watch.at !== '2026-10-23T19:58:00Z', JSON.stringify(J2.watch && J2.watch.at)); assert.ok(J2.watch.rows.length >= 3); });
check('journal: rewriting the journal several times never duplicates the action log', () => { const a = J2.acts || []; assert.ok(a.length > 1, JSON.stringify(a)); assert.equal(new Set(a).size, a.length, 'duplicates: ' + JSON.stringify(a)); assert.equal(a[0], 'Earlier today: DIP RSI-2 dip buy'); });
const J3 = run({ stocks: true, options: true }, { time: '2026-10-23T20:01:00Z', closed: true, journalKey: 'test-pass', prevKey: 'old-pass', prevJournal: prevJ });
check('journal: a journal written under another passphrase is never overwritten (no crash, old journal kept)', () => { assert.ok(J3.keptOld, 'the old journal was replaced'); });
const J4 = run({ stocks: true, options: true }, { time: '2026-10-23T20:01:00Z', closed: true, journalKey: 'test-pass', prevKey: 'old-pass', prevJournal: prevJ, reset: true });
check('journal: JOURNAL_RESET=1 starts a fresh encrypted journal under the new passphrase', () => { assert.ok(!J4.keptOld); assert.ok(J4.enc); assert.ok(Array.isArray(J4.acts)); });

{ const { redactText, bought } = await import(pathToFileURL(path.join(HERE, 'bot.mjs')).href);
  check('orders: a buy counts as ours when filled, or filled in part (still working, cancelled or expired) — never when nothing filled', () => { assert.ok(bought({ status: 'filled' })); assert.ok(bought({ status: 'canceled', filled_qty: '3' })); assert.ok(bought({ status: 'partially_filled', filled_qty: '1' })); assert.ok(!bought({ status: 'canceled', filled_qty: '0' })); assert.ok(!bought({ status: 'new' })); });
  check('privacy mode: log lines hide tickers, option symbols and amounts but keep plain words', () => {
    const t = redactText('bought 12 AAPL @ $187.20, STOP set; quotes for SPY261026C00580000; BRK.B sold; Market closed');
    for (const bad of ['AAPL', '187', 'SPY26', 'BRK', '12 ']) assert.ok(!t.includes(bad), bad + ' leaked: ' + t);
    assert.match(t, /STOP set/); assert.match(t, /Market closed/);
  }); }
const SL = run({ stocks: true, options: false, universe: 'scan', symbols: ['DIP', 'POP', 'FALL'] }, { slowAssets: 20000 });
check('market scan: a scan that takes minutes does not hold up the cycle; the bot trades its list meanwhile', () => { assert.ok(SL.cycleMs < 12000, 'cycle took ' + SL.cycleMs + ' ms'); assert.ok(SL.orders.some(o => o.symbol === 'DIP' && o.side === 'buy'), JSON.stringify(SL.acts)); assert.ok((SL.acts || []).some(m => /market scan started/.test(m))); });

// ---- Telegram: alerts to the owner's chat, commands answered only there, /pause blocks new entries but never sells ----
const TG = run({ stocks: true, options: false, symbols: ['DIP'] }, { tg: true, tgAfter: [[42, '/money'], [42, '/status'], [42, '/watch'], [999, '/money'], [42, '/help']] });
const tgTxt = TG.tgSent.map(m => m.text);
check('telegram: the buy alert arrives in the owner\'s chat with size and price', () => assert.ok(TG.tgSent.some(m => m.chat_id === '42' && /DIP RSI-2 dip buy .*\d+ shares @ \$/.test(m.text)), JSON.stringify(tgTxt)));
check('telegram: /money, /status, /watch and /help answer in the owner\'s chat', () => { assert.ok(tgTxt.some(t => /In trades now/.test(t) && /Free to trade/.test(t))); assert.ok(tgTxt.some(t => /Watching \d+ stocks/.test(t) && /Market check/.test(t))); assert.ok(tgTxt.some(t => /Buy: DIP/.test(t))); assert.ok(tgTxt.some(t => /\/pause/.test(t) && /never buy or sell/.test(t))); });
check('telegram: a message from any other chat is ignored and never answered', () => { assert.ok(TG.tgSent.every(m => m.chat_id === '42')); assert.equal(tgTxt.filter(t => /In trades now/.test(t)).length, 1); });
const TP = run({ stocks: true, options: true, symbols: ['DIP'] }, { tg: true, tgBefore: [[42, '/pause']], positions: [{ symbol: 'AAPL', qty: '5', avg_entry_price: '200', current_price: '198', market_value: '990', unrealized_pl: '-10', unrealized_plpc: '-0.01' }] });
check('telegram: handled commands are confirmed at once (a restart never answers them twice)', () => { assert.ok((TP.tgConfirms || []).includes(101), JSON.stringify(TP.tgConfirms)); });
check('telegram: /pause stops new entries (no buy on the dip stock) and confirms', () => { assert.ok(!TP.orders.some(o => o.side === 'buy'), JSON.stringify(TP.orders)); assert.ok(TP.tgSent.some(m => /Paused: no new entries/.test(m.text))); });
check('telegram: /pause never sells what is open (only protective stop orders may be placed)', () => assert.ok(TP.orders.filter(o => o.side === 'sell').every(o => o.type === 'stop'), JSON.stringify(TP.orders)));

// ---- money split: stocks, CALLs and PUTs each own a share of the stake (60/30/10 by default) and stop on their own loss limit ----
const XS = { stocks: true, options: true, puts: true, symbols: ['DIP', 'POP'], preset: 'custom', maxHeat: 15 };
const optSym = 'QUIET261113C00210000', putSym = 'QUIET261113P00210000';
const pos = (symbol, qty, avg, cur, last) => ({ symbol, qty: String(qty), avg_entry_price: String(avg), current_price: String(cur), lastday_price: String(last), market_value: String(qty * cur * (/\d{6}[CP]\d{8}$/.test(symbol) ? 100 : 1)), unrealized_pl: String(qty * (cur - avg) * (/\d{6}[CP]\d{8}$/.test(symbol) ? 100 : 1)), unrealized_plpc: String((cur - avg) / avg) });
const M1 = run(XS, { positions: [pos(optSym, 10, 1, 29.9, 29.9)] });
check('split 60/30/10: CALLs already use their $30,000 → the CALL is skipped; the stock buy and the PUT still go through', () => {
  assert.ok(M1.orders.some(o => o.symbol === 'DIP' && o.side === 'buy'), JSON.stringify(M1.acts)); assert.ok(!M1.options.some(o => /^DIP\d{6}C/.test(o.symbol)), JSON.stringify(M1.options));
  assert.ok(M1.options.some(o => /^POP\d{6}P/.test(o.symbol)), JSON.stringify(M1.acts));
  assert.ok((M1.acts || []).some(m => /CALL money \$30000, \$29900 already in use/.test(m)), JSON.stringify(M1.acts));
});
check('split: the journal publishes each part\'s money, use and today\'s result', () => { const S = M1.split; assert.ok(S && S.on); assert.deepEqual(S.shares, { call: 30, put: 10, spy: 5, stock: 55 }); assert.equal(S.stock.money, 55000); assert.equal(S.spy.money, 5000); assert.equal(S.call.money, 30000); assert.equal(S.put.money, 10000); assert.equal(S.call.used, 29900); assert.equal(S.call.today, 0); assert.equal(S.call.halted, null); });
const M1p = run(XS, { positions: [pos(putSym, 5, 19.9, 19.9, 19.9)] });
check('split: PUTs already use their $10,000 → the PUT is skipped while the CALL goes through', () => { assert.ok(!M1p.options.some(o => /^POP\d{6}P/.test(o.symbol)), JSON.stringify(M1p.options)); assert.ok(M1p.options.some(o => /^DIP\d{6}C/.test(o.symbol)), JSON.stringify(M1p.acts)); });
const M0 = run({ ...XS, split: false }, { positions: [pos(optSym, 10, 1, 29.9, 29.9)] });
check('split off: one shared pool → the same CALL is placed', () => assert.ok(M0.options.some(o => /^DIP\d{6}C/.test(o.symbol)), JSON.stringify(M0.acts)));
const M2 = run({ ...XS, callSharePct: 40 }, { positions: [pos(optSym, 10, 1, 29.9, 29.9)] });
check('split changed to 50/40/10: with $40,000 for CALLs there is room → the CALL is placed', () => assert.ok(M2.options.some(o => /^DIP\d{6}C/.test(o.symbol)), JSON.stringify(M2.acts)));
const optHist = [{ symbol: optSym, side: 'buy', status: 'filled', client_order_id: 'sd-q-' + optSym + '-20261022-25-ab', qty: '25', limit_price: '7', filled_at: '2026-10-22T15:00:00Z' }];
const M3 = run(XS, { positions: [pos(optSym, 25, 7, 5, 6.5)], hist: optHist, tg: true });
check('CALL loss limit: CALLs down $3,750 today (limit 10% of $30,000) → no new CALL, and the open CALL is closed', () => {
  assert.ok(!M3.orders.some(o => /^DIP\d{6}C/.test(o.symbol) && o.side === 'buy'), JSON.stringify(M3.orders));
  assert.ok(M3.orders.some(o => o.symbol === optSym && o.side === 'sell' && o.type === 'market'), JSON.stringify(M3.orders) + JSON.stringify(M3.acts));
  assert.ok(M3.split.call.halted && M3.split.call.today === -3750, JSON.stringify(M3.split));
});
check('CALL loss limit: stocks and PUTs carry on (the dip stock is bought, the PUT on the pop is placed)', () => { assert.ok(M3.orders.some(o => o.symbol === 'DIP' && o.side === 'buy'), JSON.stringify(M3.acts)); assert.ok(M3.options.some(o => /^POP\d{6}P/.test(o.symbol)), JSON.stringify(M3.acts)); });
check('CALL loss limit: one Telegram alert names the part that stopped and the ones that carry on', () => { const t = M3.tgSent.map(m => m.text).filter(x => /CALLs down \$3750/.test(x)); assert.equal(t.length, 1, JSON.stringify(M3.tgSent.map(m => m.text))); assert.match(t[0], /stocks and PUTs and SPY options carry on/); });
const putHist = [{ symbol: putSym, side: 'buy', status: 'filled', client_order_id: 'sd-p-' + putSym + '-20261022-10-ab', qty: '10', limit_price: '3', filled_at: '2026-10-22T15:00:00Z' }];
const M3p = run(XS, { positions: [pos(putSym, 10, 3, 2, 3)], hist: putHist });
check('PUT loss limit: PUTs down $1,000 today (limit 10% of $10,000) → no new PUT, the open PUT is closed, the CALL still goes through', () => {
  assert.ok(!M3p.orders.some(o => /^POP\d{6}P/.test(o.symbol) && o.side === 'buy'), JSON.stringify(M3p.orders)); assert.ok(M3p.orders.some(o => o.symbol === putSym && o.side === 'sell'), JSON.stringify(M3p.acts));
  assert.ok(M3p.options.some(o => /^DIP\d{6}C/.test(o.symbol)), JSON.stringify(M3p.acts)); assert.ok(M3p.split.put.halted && !M3p.split.call.halted);
});
const losers = [pos('QUIET', 100, 212, 200, 210), pos('FALL', 200, 92, 80, 92)];
const M4 = run(XS, { positions: losers });
check('stock loss limit: stocks down $3,400 today (limit 3% of $55,000) → no stock buy, but the CALL and the PUT still go through', () => {
  assert.ok(!M4.orders.some(o => o.symbol === 'DIP' && o.side === 'buy'), JSON.stringify(M4.orders)); assert.ok(M4.options.some(o => /^DIP\d{6}C/.test(o.symbol)) && M4.options.some(o => /^POP\d{6}P/.test(o.symbol)), JSON.stringify(M4.acts));
  assert.ok(M4.split.stock.halted && M4.split.stock.today === -3400, JSON.stringify(M4.split));
});
check('stock loss limit: held stocks are not sold because of it (only new buys stop)', () => assert.ok(!M4.orders.some(o => (o.symbol === 'QUIET' || o.symbol === 'FALL') && o.side === 'sell' && o.type === 'market'), JSON.stringify(M4.orders)));
const M5 = run({ ...XS, split: false }, { positions: losers });
check('split off: the same stock loss does not stop anything on its own (the old cap is measured on the whole account)', () => assert.ok(M5.orders.some(o => o.symbol === 'DIP' && o.side === 'buy'), JSON.stringify(M5.acts)));
const lossFills = [['QUIET', 'buy', 10, 210, '13:35'], ['QUIET', 'sell', 10, 205, '13:40'], ['QUIET', 'buy', 10, 210, '13:45'], ['QUIET', 'sell', 10, 205, '13:50'], ['QUIET', 'buy', 10, 210, '13:55'], ['QUIET', 'sell', 10, 205, '14:05']]
  .map(([symbol, side, qty, price, hm], i) => ({ symbol, side, qty: String(qty), price: String(price), order_id: 'f' + i, transaction_time: '2026-10-23T' + hm + ':00Z' }));
const M6 = run({ ...XS, streak: 3 }, { fills: lossFills, time: '2026-10-23T14:20:00Z' });
check('losing streak: three stock losses in a row stop only stocks; the CALL still goes through', () => {
  assert.ok(!M6.orders.some(o => o.symbol === 'DIP' && o.side === 'buy'), JSON.stringify(M6.orders)); assert.ok(M6.options.some(o => /^DIP\d{6}C/.test(o.symbol)), JSON.stringify(M6.acts));
  assert.match(M6.split.stock.halted || '', /3 losing stock trades in a row/);
});
const TM = run({ stocks: true, options: false, symbols: ['DIP'] }, { tg: true, tgAfter: [[42, '/money']] });
check('telegram: /money shows all four parts of the split', () => assert.ok(TM.tgSent.some(m => /Split 55\/30\/10\/5/.test(m.text) && /Stocks: .* of \$55,000 in use/.test(m.text) && /CALLs: .* of \$30,000 in use/.test(m.text) && /PUTs: .* of \$10,000 in use/.test(m.text) && /SPY options: .* of \$5,000 in use/.test(m.text)), JSON.stringify(TM.tgSent.map(m => m.text))));

// ---- quick exits: stocks sell at the take-profit % or the stop %, options at their own % ----
const QX = { stocks: true, options: true, symbols: ['DIP'], preset: 'custom', maxHeat: 15, stockTp: 10, holdFloor: 5, optTakeProfit: 20, optStop: 10 };
const qHist = [{ symbol: 'QUIET', side: 'buy', status: 'filled', client_order_id: 'sd-r-QUIET-500-20261022-ab', qty: '50', limit_price: '190', filled_at: '2026-10-22T15:00:00Z' }];
const qPos = avg => ({ symbol: 'QUIET', qty: '50', avg_entry_price: String(avg), current_price: '210.4', lastday_price: '210', market_value: '10520', unrealized_pl: String(50 * (210.4 - avg)), unrealized_plpc: String(210.4 / avg - 1) });
const Q1 = run(QX, { positions: [qPos(190)], hist: qHist });
check('quick exits: a stock up 10.7% is sold at 10:00 AM at the 10% take-profit (no waiting for the close)', () => assert.ok(Q1.orders.some(o => o.symbol === 'QUIET' && o.side === 'sell' && o.type === 'market') && (Q1.acts || []).some(m => /QUIET \+10\.\d% — take profit \(target 10%\)/.test(m)), JSON.stringify(Q1.orders) + JSON.stringify(Q1.acts)));
const Q2 = run({ ...QX, stockTp: 0 }, { positions: [qPos(190)], hist: qHist });
check('quick exits: with the take-profit off (0), the same stock is held for the RSI-2 exit at the close (only its protective stop is placed)', () => assert.ok(!Q2.orders.some(o => o.symbol === 'QUIET' && o.side === 'sell' && o.type !== 'stop'), JSON.stringify(Q2.orders)));
const Q2b = run(QX, { positions: [qPos(200)], hist: qHist });
check('quick exits: a stock up 5% (below the 10% target) is not sold', () => assert.ok(!Q2b.orders.some(o => o.symbol === 'QUIET' && o.side === 'sell' && o.type === 'market'), JSON.stringify(Q2b.orders)));
const oldLeg = stop => [{ id: 'leg-q', symbol: 'QUIET', side: 'sell', type: 'stop', stop_price: String(stop), qty: '50', status: 'new', client_order_id: 'sd-x-QUIET-zz' }];
const Q3 = run(QX, { positions: [qPos(200)], hist: qHist, open: oldLeg(150) });
check('quick exits: an older 25% broker stop is moved up to the new 5% stop (190 on a 200 buy)', () => assert.ok(Q3.patches.some(p => p.id === 'leg-q' && Math.abs(+p.stop_price - 190) < 0.01), JSON.stringify(Q3.patches) + JSON.stringify(Q3.acts)));
const Q4 = run(QX, { positions: [qPos(230)], hist: qHist, open: oldLeg(172.5) });
check('quick exits: a stock already 8.5% down under an older wide stop is sold (old stop cancelled first)', () => { assert.ok(Q4.deletes.includes('leg-q'), JSON.stringify(Q4.deletes)); assert.ok(Q4.orders.some(o => o.symbol === 'QUIET' && o.side === 'sell' && o.type === 'market'), JSON.stringify(Q4.orders)); });
const Q5 = run(QX, { positions: [qPos(230)], hist: qHist, open: oldLeg(218.5) });
check('quick exits: when the broker already holds the right stop, the bot does not sell too (no double sale)', () => { assert.ok(!Q5.orders.some(o => o.symbol === 'QUIET' && o.side === 'sell'), JSON.stringify(Q5.orders)); assert.ok(!Q5.patches.length && !Q5.deletes.includes('leg-q')); });
const Q6 = run(QX);
check('quick exits: new stock buys carry a broker stop 5% under the price', () => { const o = Q6.orders.find(x => x.symbol === 'DIP' && x.side === 'buy'); assert.ok(o && Math.abs(+o.stop_loss.stop_price / +o.limit_price - 0.95) < 0.002, JSON.stringify(o)); });
check('quick exits: a tight option market (2.4% spread) passes the spread rule for a 10% stop', () => assert.ok(Q6.options.some(o => /^DIP\d{6}C/.test(o.symbol)), JSON.stringify(Q6.acts)));
const Q7 = run(QX, { quote: { ap: 2.1, bp: 2.0 } }), Q7b = run({ ...QX, optStop: 5 }, { quote: { ap: 2.1, bp: 2.0 } });
check('quick exits: a 4.8% spread passes with a 10% stop, but is too wide for a 5% stop (must be under half the stop)', () => { assert.ok(Q7.options.length, JSON.stringify(Q7.acts)); assert.ok(!Q7b.options.length && (Q7b.acts || []).some(m => /spread too wide .*over 2\.5% for a 5% stop/.test(m)), JSON.stringify(Q7b.acts)); });
const oPos = cur => ({ symbol: optSym, qty: '2', avg_entry_price: '5', current_price: String(cur), lastday_price: '5', market_value: String(2 * cur * 100), unrealized_pl: String(2 * (cur - 5) * 100), unrealized_plpc: String(cur / 5 - 1) });
const oHist = [{ symbol: optSym, side: 'buy', status: 'filled', client_order_id: 'sd-q-' + optSym + '-20261022-2-ab', qty: '2', limit_price: '5', filled_at: '2026-10-22T15:00:00Z' }];
const Q8 = run(QX, { positions: [oPos(6.1)], hist: oHist }), Q9 = run(QX, { positions: [oPos(4.45)], hist: oHist }), Q10 = run(QX, { positions: [oPos(5.5)], hist: oHist });
check('quick exits: a CALL up 22% is sold at the 20% take-profit', () => assert.ok(Q8.orders.some(o => o.symbol === optSym && o.side === 'sell' && o.type === 'market') && (Q8.acts || []).some(m => /\+22% — take profit/.test(m)), JSON.stringify(Q8.acts)));
check('quick exits: a CALL down 11% is sold at the 10% stop', () => assert.ok(Q9.orders.some(o => o.symbol === optSym && o.side === 'sell' && o.type === 'market') && (Q9.acts || []).some(m => /-11% — option stop/.test(m)), JSON.stringify(Q9.acts)));
check('quick exits: a CALL up 10% is kept, with its take-profit order resting at +20% ($6.00)', () => { assert.ok(!Q10.orders.some(o => o.symbol === optSym && o.type === 'market')); const tp = Q10.orders.find(o => o.symbol === optSym && o.type === 'limit' && o.side === 'sell'); assert.ok(tp && +tp.limit_price === 6, JSON.stringify(Q10.orders)); });

// ---- leaders first: with room for one stock, the strongest 3-month performer among the dips is bought, not the deepest dip ----
const LF = { stocks: true, options: false, symbols: ['DIP', 'LAG'], preset: 'custom', maxPositions: 1, maxHeat: 15 };
const L1 = run(LF), L2 = run({ ...LF, pickBy: 'dip' });
check('leaders first (default): DIP is bought, LAG (deeper dip, weaker run) is left', () => { assert.ok(L1.orders.some(o => o.symbol === 'DIP' && o.side === 'buy'), JSON.stringify(L1.orders) + JSON.stringify(L1.acts)); assert.ok(!L1.orders.some(o => o.symbol === 'LAG')); assert.equal(L1.watch.pickBy, 'leaders'); });
check('leaders first: the watch list shows each stock\'s 3-month return vs the market, and the log names the order', () => { const d = L1.watch.rows.find(r => r.s === 'DIP'), l = L1.watch.rows.find(r => r.s === 'LAG'); assert.ok(d && l && d.lead > l.lead, JSON.stringify([d, l])); assert.ok((L1.acts || []).some(m => /leaders first/.test(m) && /vs market/.test(m)), JSON.stringify(L1.acts)); });
check('deepest dip (pickBy = dip): the order is by RSI-2 and leaders are not preferred (DIP, the stronger runner, is not favoured)', () => { assert.ok(!(L2.acts || []).some(m => /leaders first/.test(m))); assert.equal(L2.watch.pickBy, 'dip'); assert.equal(L2.orders.filter(o => o.side === 'buy').length, 1); });

// ---- SPY quick options sleeve: CALL on an upside break, PUT on a downside break, 5% of the stake, its own exits and brakes ----
const m5 = (hm, o, h, l, c, v) => ({ t: '2026-10-23T' + hm + ':00Z', o, h, l, c, v, n: 100, vw: c });
const spyUp = [m5('13:30', 500, 501, 499.5, 500.6, 2e6), m5('13:35', 500.6, 501.2, 500.4, 501, 2e6), m5('13:40', 501, 501.8, 500.9, 501.6, 2e6), m5('13:45', 501.6, 502, 501.4, 501.9, 2e6), m5('13:50', 501.9, 502.5, 501.8, 502.3, 2.5e6)];
const spyDn = spyUp.map(b => ({ ...b, o: 1000 - b.o, h: 1000 - b.l, l: 1000 - b.h, c: 1000 - b.c }));
const SO = { stocks: false, options: false, symbols: ['QUIET'], preset: 'custom' };
const Y1 = run(SO, { bars5: { SPY: spyUp }, live: { SPY: 502.7 } });
check('SPY sleeve (default on): SPY breaks the 15-minute high above its VWAP → one SPY CALL, id sd-yc-, sized from the $5,000 share', () => {
  const o = Y1.orders.find(x => /^SPY\d{6}C/.test(x.symbol) && x.side === 'buy'); assert.ok(o, JSON.stringify(Y1.orders) + JSON.stringify(Y1.acts)); assert.match(o.client_order_id, /^sd-yc-SPY/);
  assert.ok(+o.qty * +o.limit_price * 100 <= 5000 && +o.qty >= 1, 'spent ' + (+o.qty * +o.limit_price * 100)); assert.equal(o.time_in_force, 'day');
});
check('SPY sleeve: the journal carries the sleeve\'s money, use, window and rules', () => { const S = Y1.spy; assert.ok(S && S.on, JSON.stringify(S)); assert.equal(S.money, 5000); assert.equal(S.max, 6); assert.deepEqual(S.rules, { tp: 15, stop: 15, holdMin: 10, dte: 1, tradePct: 100, maxOpen: 3 }); assert.equal(S.market, 'up'); });
const Y2 = run(SO, { bars5: { SPY: spyDn }, live: { SPY: 497.3 }, spy: 'down' });
check('SPY sleeve: SPY breaks the 15-minute low below its VWAP → a SPY PUT (sd-yp-)', () => assert.ok(Y2.orders.some(x => /^SPY\d{6}P/.test(x.symbol) && /^sd-yp-/.test(x.client_order_id)), JSON.stringify(Y2.orders) + JSON.stringify(Y2.acts)));
const Y3 = run(SO, { bars5: { SPY: spyUp }, live: { SPY: 502.2 } });
check('SPY sleeve: no break of the 15-minute high → nothing bought, the journal says what it waits for', () => { assert.ok(!Y3.orders.some(x => /^SPY/.test(x.symbol))); assert.match(Y3.spy.idle || '', /waiting for a break above 502\.5/); });
const Y0 = run({ ...SO, spyOn: false }, { bars5: { SPY: spyUp }, live: { SPY: 502.7 } });
check('SPY sleeve switched off: the same break buys nothing, and the stock share grows back to 60%', () => { assert.ok(!Y0.orders.some(x => /^SPY/.test(x.symbol)), JSON.stringify(Y0.orders)); assert.equal(Y0.spy.on, false); assert.equal(Y0.split.stock.money, 60000); });
const spySym = 'SPY261024C00502000', spyPos = cur => ({ symbol: spySym, qty: '20', avg_entry_price: '2.05', current_price: String(cur), lastday_price: '2.05', market_value: String(20 * cur * 100), unrealized_pl: String(20 * (cur - 2.05) * 100), unrealized_plpc: String(cur / 2.05 - 1) });
const spyBuy = openMins => [{ symbol: spySym, side: 'buy', status: 'filled', client_order_id: `sd-yc-${spySym}-205-20261023-${openMins}-ab`, qty: '20', limit_price: '2.05', filled_at: '2026-10-23T13:55:00Z' }];
const Y4 = run(SO, { positions: [spyPos(2.4)], hist: spyBuy(595), bars5: { SPY: spyUp }, live: { SPY: 502.2 } });
check('SPY sleeve: an open CALL up 17% is sold at market (take-profit +15%)', () => assert.ok(Y4.orders.some(o => o.symbol === spySym && o.side === 'sell' && o.type === 'market') && (Y4.acts || []).some(m => /take profit/.test(m)), JSON.stringify(Y4.orders) + JSON.stringify(Y4.acts)));
const Y5 = run(SO, { positions: [spyPos(1.7)], hist: spyBuy(595), bars5: { SPY: spyUp }, live: { SPY: 502.2 } });
check('SPY sleeve: an open CALL down 17% is sold at market (stop −15%)', () => assert.ok(Y5.orders.some(o => o.symbol === spySym && o.side === 'sell' && o.type === 'market') && (Y5.acts || []).some(m => /stop \(limit/.test(m)), JSON.stringify(Y5.acts)));
const Y6 = run(SO, { positions: [spyPos(2.1)], hist: spyBuy(588), bars5: { SPY: spyUp }, live: { SPY: 502.2 } });   // opened 9:48, now 10:00 → 12 min
check('SPY sleeve: a CALL held 12 minutes is sold (time stop 10 min) whatever the price', () => assert.ok(Y6.orders.some(o => o.symbol === spySym && o.side === 'sell' && o.type === 'market') && (Y6.acts || []).some(m => /10 minutes are up/.test(m)), JSON.stringify(Y6.acts)));
const Y7 = run(SO, { positions: [spyPos(2.1)], hist: spyBuy(596), bars5: { SPY: spyUp }, live: { SPY: 502.7 } });   // opened 9:56, now 10:00 → 4 min, +2%
check('SPY sleeve: while a trade holds all its money (100% per trade) it rests a take-profit order at +15% ($2.36) and buys nothing more', () => {
  const sells = Y7.orders.filter(o => o.symbol === spySym && o.side === 'sell'); assert.equal(sells.length, 1, JSON.stringify(Y7.orders)); assert.equal(sells[0].type, 'limit'); assert.ok(Math.abs(+sells[0].limit_price - 2.36) < 0.011, sells[0].limit_price);
  assert.ok(!Y7.orders.some(o => o.side === 'buy' && /^SPY/.test(o.symbol))); assert.match(Y7.spy.idle, /all of the SPY money is in trades/); assert.equal(Y7.spy.open.length, 1);
});
// several at once (owner, 2026-10-25): 20% per trade, up to 3 open, each from a fresh break
const spyPos2 = (sym, cur) => ({ symbol: sym, qty: '2', avg_entry_price: '2.05', current_price: String(cur), lastday_price: '2.05', market_value: String(2 * cur * 100), unrealized_pl: String(2 * (cur - 2.05) * 100), unrealized_plpc: String(cur / 2.05 - 1) });
const spyBuy2 = (sym, m, k = 'c') => ({ symbol: sym, side: 'buy', status: 'filled', client_order_id: `sd-y${k}-${sym}-205-20261023-${m}-q${m}`, qty: '2', limit_price: '2.05', filled_at: '2026-10-23T13:55:00Z' });
const YM = run({ ...SO, spyTradePct: 20 }, { positions: [spyPos2(spySym, 2.1)], hist: [spyBuy2(spySym, 596)], bars5: { SPY: spyUp }, live: { SPY: 502.7 } });
check('SPY sleeve, several at once: with one CALL open and 20% per trade, a new break buys a second CALL with 20% of the SPY money', () => {
  const b = YM.orders.filter(o => o.side === 'buy' && /^SPY\d{6}C/.test(o.symbol)); assert.equal(b.length, 1, JSON.stringify(YM.orders) + JSON.stringify(YM.spy && YM.spy.idle));
  assert.ok(+b[0].qty * +b[0].limit_price * 100 <= 1000 + 1, JSON.stringify(b[0]));
});
{ const sameSym = (YM.orders.find(o => o.side === 'buy' && /^SPY\d{6}C/.test(o.symbol)) || {}).symbol;
  const YS = run({ ...SO, spyTradePct: 20 }, { positions: [spyPos2(sameSym, 2.1)], hist: [spyBuy2(sameSym, 596)], bars5: { SPY: spyUp }, live: { SPY: 502.7 } });
  const YH = run({ ...SO, spyTradePct: 20 }, { positions: [spyPos2(sameSym, 2.1)], hist: [], bars5: { SPY: spyUp }, live: { SPY: 502.7 } });
  check('SPY sleeve: never buys a SPY contract you hold by hand (it would merge with yours and later be sold with it)', () => { assert.ok(!YH.orders.some(o => o.side === 'buy'), JSON.stringify(YH.orders)); assert.ok(!YH.orders.some(o => o.symbol === sameSym), JSON.stringify(YH.orders)); });
  check('SPY sleeve, several at once: a new trade never buys the contract an open trade already holds (that would add to it)', () => { assert.ok(sameSym); assert.ok(!YS.orders.some(o => o.side === 'buy'), JSON.stringify(YS.orders)); assert.ok((YS.acts || []).some(m => /already one of its open trades/.test(m)), JSON.stringify(YS.acts)); }); }
const s2 = 'SPY261024C00503000', s3 = 'SPY261024P00500000';
const YX = run({ ...SO, spyTradePct: 20 }, { positions: [spyPos2(spySym, 2.1), spyPos2(s2, 2.1), spyPos2(s3, 2.1)], hist: [spyBuy2(spySym, 596), spyBuy2(s2, 597), spyBuy2(s3, 598, 'p')], bars5: { SPY: spyUp }, live: { SPY: 502.7 } });
check('SPY sleeve, several at once: with 3 open (the most at once) nothing more is bought', () => { assert.ok(!YX.orders.some(o => o.side === 'buy'), JSON.stringify(YX.orders)); assert.match(YX.spy.idle || '', /3 SPY trades open/); });
const YF = run({ ...SO, spyTradePct: 20 }, { positions: [spyPos2(spySym, 2.1)], hist: [spyBuy2(spySym, 596)], bars5: { SPY: spyUp }, live: { SPY: 502.7 }, prevJournal: { mem: { day: '20261023', spyLevels: { day: '20261023', call: 502.5, put: 0 } } } });
check('SPY sleeve, several at once: the same break never opens a second trade (needs a new, higher 15-minute high)', () => { assert.ok(!YF.orders.some(o => o.side === 'buy'), JSON.stringify(YF.orders)); assert.match(YF.spy.idle || '', /waiting for a new break/); });
const sixToday = Array.from({ length: 6 }, (_, i) => ({ symbol: spySym, side: 'buy', status: 'filled', client_order_id: `sd-yc-${spySym}-205-20261023-${580 + i}-z${i}`, qty: '1', limit_price: '2.05' }));
const Y8 = run(SO, { hist: sixToday, bars5: { SPY: spyUp }, live: { SPY: 502.7 } });
check('SPY sleeve: after 6 trades today the daily maximum stops new ones', () => { assert.ok(!Y8.orders.some(o => o.side === 'buy' && /^SPY/.test(o.symbol)), JSON.stringify(Y8.orders)); assert.match(Y8.spy.idle || '', /daily maximum/); });
const spyLoss = [['buy', 2.05, '13:35'], ['sell', 1.7, '13:40'], ['buy', 2.05, '13:45'], ['sell', 1.7, '13:50']].map(([side, price, hm], i) => ({ symbol: spySym, side, qty: '20', price: String(price), order_id: 'y' + i, transaction_time: '2026-10-23T' + hm + ':00Z' }));
const YP = run(SO, { positions: [spyPos(1.7)], hist: [{ ...spyBuy(595)[0], status: 'canceled', qty: '40', filled_qty: '20' }], bars5: { SPY: spyUp }, live: { SPY: 502.2 } });
check('partial fill: a SPY buy filled in part then cancelled is still the bot\'s trade — the position gets its stop (sold at −17%)', () => assert.ok(YP.orders.some(o => o.symbol === spySym && o.side === 'sell' && o.type === 'market'), JSON.stringify(YP.orders) + JSON.stringify(YP.acts)));
// early-close day (1:00 PM): every end-of-day exit moves up three hours
const YE = run(SO, { time: '2026-10-23T16:46:00Z', nextClose: '2026-10-23T13:00:00-04:00', positions: [spyPos(2.1)], hist: spyBuy(760), bars5: { SPY: spyUp }, live: { SPY: 502.2 } });   // 12:46 PM, close at 1:00
check('early close: a SPY option is flattened 15 minutes before a 1:00 PM close (not held to 3:45)', () => assert.ok(YE.orders.some(o => o.symbol === spySym && o.side === 'sell' && o.type === 'market') && (YE.acts || []).some(m => /flat before the close/.test(m)), JSON.stringify(YE.orders) + JSON.stringify(YE.acts)));
const YE3 = run(SO, { time: '2026-10-23T16:46:00Z', nextClose: '2026-10-26T16:00:00-04:00', calClose: '13:00', positions: [spyPos(2.1)], hist: spyBuy(760), bars5: { SPY: spyUp }, live: { SPY: 502.2 } });   // the clock says nothing about today's close: the calendar does
check('early close: the broker calendar alone (13:00 close) is enough to flatten SPY options before the bell', () => assert.ok(YE3.orders.some(o => o.symbol === spySym && o.side === 'sell' && o.type === 'market'), JSON.stringify(YE3.orders) + JSON.stringify(YE3.acts)));
const YE2 = run(SO, { time: '2026-10-23T16:35:00Z', nextClose: '2026-10-23T13:00:00-04:00', bars5: { SPY: spyUp }, live: { SPY: 502.7 } });   // 12:35 PM on an early-close day: inside the usual window, but 25 min from the bell
check('early close: no new SPY trade in the last 30 minutes before a 1:00 PM close', () => { assert.ok(!YE2.orders.some(o => o.side === 'buy'), JSON.stringify(YE2.orders)); assert.match(YE2.spy.idle || '', /window closed/); });
// resting orders that must not outlive their position / the day
const OR = run({ stocks: true, options: false, symbols: ['QUIET'] }, { positions: [], open: [{ id: 'leg9', symbol: 'GONE', side: 'sell', type: 'stop', stop_price: '90', qty: '10', client_order_id: 'auto-uuid', submitted_at: '2026-10-23T13:00:00Z' }] });
check('orphans: a stop sell order for a stock no longer held is cancelled (it would have opened a short)', () => assert.ok(OR.deletes.includes('leg9'), JSON.stringify(OR.deletes) + JSON.stringify(OR.acts)));
const OL = run({ stocks: true, options: false, symbols: ['QUIET'] }, { positions: [], open: [{ id: 'p1', symbol: 'DIP', side: 'buy', type: 'limit', limit_price: '100', qty: '10', client_order_id: 'sd-r-DIP-20261023-10-aa', order_class: 'oto', submitted_at: '2026-10-23T13:58:00Z' }, { id: 'leg1', symbol: 'DIP', side: 'sell', type: 'stop', status: 'held', stop_price: '75', qty: '10', client_order_id: 'auto-leg', order_class: 'oto', submitted_at: '2026-10-23T13:00:00Z' }] });
check('orphans: the protective stop leg of a dip-buy that has not filled yet is NOT cancelled', () => assert.ok(!OL.deletes.includes('leg1'), JSON.stringify(OL.deletes) + JSON.stringify(OL.acts)));
const EOD = run({ stocks: true, options: false, symbols: ['QUIET'] }, { time: '2026-10-23T19:56:00Z', open: [{ id: 'b7', symbol: 'DIP', side: 'buy', type: 'limit', limit_price: '100', qty: '10', client_order_id: 'sd-r-DIP-20261023-10-zz', submitted_at: '2026-10-23T19:40:00Z' }] });   // 3:56 PM
check('end of day: a resting dip-buy still unfilled at 3:55 is cancelled, never left to fill on tomorrow\'s open', () => assert.ok(EOD.deletes.includes('b7'), JSON.stringify(EOD.deletes) + JSON.stringify(EOD.acts)));
const spyLossSmall = spyLoss.map(f => ({ ...f, symbol: 'SPY261024C00501000', qty: '2' }));
const YK = run({ ...SO, spyTradePct: 20 }, { fills: spyLossSmall, positions: [spyPos2(spySym, 2.2)], hist: [spyBuy2(spySym, 596)], bars5: { SPY: spyUp }, live: { SPY: 502.7 } });
check('SPY sleeve: a losing streak stops new SPY trades but does not dump an open winning trade (the money limit would)', () => {
  assert.ok(YK.spy.halted && !/past the/.test(YK.spy.halted), JSON.stringify(YK.spy.halted)); assert.ok(!YK.orders.some(o => o.side === 'buy'), JSON.stringify(YK.orders));
  assert.ok(!YK.orders.some(o => o.symbol === spySym && o.type === 'market'), JSON.stringify(YK.orders));
});
const Y9 = run(SO, { fills: spyLoss, bars5: { SPY: spyUp }, live: { SPY: 502.7 }, tg: true });
check('SPY sleeve: two losses in a row ($1,400 = 28% of its $5,000) end its day; one Telegram alert; stocks are untouched', () => {
  assert.ok(!Y9.orders.some(o => o.side === 'buy' && /^SPY/.test(o.symbol)), JSON.stringify(Y9.orders)); assert.ok(Y9.spy.halted, JSON.stringify(Y9.spy));
  assert.equal(Y9.tgSent.filter(m => /SPY options down \$1400/.test(m.text)).length, 1, JSON.stringify(Y9.tgSent.map(m => m.text))); assert.ok(!Y9.split.stock.halted);
});

// ---- the SPY fast lane: 1-second exits while a trade is open, and the stream level that wakes an entry ----
const Y10 = run(SO, { positions: [spyPos(2.1)], hist: spyBuy(596), bars5: { SPY: spyUp }, live: { SPY: 502.2 }, fast: { positions: [spyPos(1.7)] } });
check('SPY fast lane: a cycle leaves the trade open (+2%); a second later the option is through the stop → the fast lane sells at market without waiting for the next cycle', () => {
  assert.ok(!Y10.orders.slice(0, Y10.orders.length - (Y10.fast ? Y10.fast.placed.length : 0)).some(o => o.symbol === spySym && o.type === 'market'), 'cycle itself must not have sold');
  assert.ok(Y10.fast && Y10.fast.placed.some(o => o.symbol === spySym && o.side === 'sell' && o.type === 'market'), JSON.stringify(Y10.fast));
});
const Y11 = run(SO, { positions: [spyPos(2.1)], hist: spyBuy(596), bars5: { SPY: spyUp }, live: { SPY: 502.2 }, fast: { positions: [spyPos(2.12)] } });
check('SPY fast lane: with the trade still fine, the fast check places nothing', () => assert.ok(Y11.fast && Y11.fast.placed.length === 0, JSON.stringify(Y11.fast)));
check('SPY fast lane: while watching, the sleeve publishes the level a SPY tick must cross (502.5, direction up) so the stream can wake a cycle at once', () => { assert.deepEqual(Y3.spyWatch, { level: 502.5, market: 'up' }); assert.equal(Y7.spyWatch, null, 'not while in a trade'); assert.equal(Y8.spyWatch, null, 'not after the daily maximum'); });

// ---- sub-second paths: a SPY tick places the order directly; an option quote through the stop sells directly ----
const Y12 = run(SO, { bars5: { SPY: spyUp }, live: { SPY: 502.2 }, tick: 502.7 });
check('SPY tick entry: the cycle leaves the sleeve watching 502.5; a streamed tick at 502.7 places the CALL at once, and a second tick does not place another', () => {
  assert.ok(Y12.tickEntry && Y12.tickEntry.ok, JSON.stringify(Y12.tickEntry)); assert.equal(Y12.tickEntry.again, false);
  assert.equal(Y12.tickEntry.placed.filter(o => o.side === 'buy').length, 1); assert.match(Y12.tickEntry.placed[0].client_order_id, /^sd-yc-SPY/); assert.match((Y12.acts || []).join(' | ') + ' ' + JSON.stringify(Y12.tickEntry), /live tick|sd-yc/);
});
const YT = run({ ...SO, spyTradePct: 20 }, { bars5: { SPY: spyUp }, live: { SPY: 502.2 }, tick: 502.7, cycleAfterTick: true });
check('SPY sleeve: a full cycle right after a tick entry never buys again on its older account picture, and keeps watching the new trade', () => {
  assert.equal(YT.tickEntry.placed.filter(o => o.side === 'buy').length, 1, JSON.stringify(YT.tickEntry.placed));
  assert.ok(!YT.tickEntry.after.placed.some(o => o.side === 'buy'), JSON.stringify(YT.tickEntry.after.placed)); assert.ok(YT.tickEntry.after.hasOpen);
});
const Y13 = run(SO, { bars5: { SPY: spyUp }, live: { SPY: 502.2 }, tick: 502.4 });
check('SPY tick entry: a tick that does not cross the level places nothing', () => assert.ok(Y13.tickEntry && !Y13.tickEntry.ok && Y13.tickEntry.placed.length === 0, JSON.stringify(Y13.tickEntry)));
const tpLeg = [{ id: 'leg-tp-spy', symbol: spySym, side: 'sell', type: 'limit', limit_price: '2.36', qty: '20', status: 'new', client_order_id: 'sd-x-' + spySym + '-zz' }];
const Y14 = run(SO, { positions: [spyPos(2.1)], hist: spyBuy(596), open: tpLeg, bars5: { SPY: spyUp }, live: { SPY: 502.2 }, quote2: { sym: spySym, bp: 1.70, ap: 1.74 } });
check('SPY quote exit: a streamed quote with the mid 16% under the entry sells at market once (the resting take-profit order is cancelled first), not twice', () => {
  const sells = Y14.quoteExit.placed.filter(o => o.symbol === spySym && o.side === 'sell' && o.type === 'market'); assert.equal(sells.length, 1, JSON.stringify(Y14.quoteExit));
  assert.ok(Y14.quoteExit.deletes.includes('leg-tp-spy'), 'take-profit order cancelled: ' + JSON.stringify(Y14.quoteExit.deletes)); assert.match(sells[0].client_order_id, /^sd-x-SPY/); assert.equal(sells[0].qty, '20');
});
const Y15 = run(SO, { positions: [spyPos(2.1)], hist: spyBuy(596), bars5: { SPY: spyUp }, live: { SPY: 502.2 }, quote2: { sym: spySym, bp: 2.30, ap: 2.34 } });
check('SPY quote exit: a quote at +10% (inside the limits) places nothing; a quote at the take-profit is left to the resting order', () => assert.equal(Y15.quoteExit.placed.length, 0, JSON.stringify(Y15.quoteExit)));

// ---- audit fixes: STOP, hosts, old day-trade ids, manual SPY options, same-contract re-entry ----
check('hosts: no request ever goes to the wrong Alpaca host (options contracts live on the trading API, bars and quotes on the data API)', () => { const bad = [A, B, D1, Y1, Y12].flatMap(r => r.unknown.filter(u => /^(DATA|TRADING) /.test(u))); assert.deepEqual(bad, []); });
const KS = run({ stocks: true, options: true, symbols: ['DIP'] }, { stop: true, positions: [{ symbol: 'AAPL', qty: '5', avg_entry_price: '200', current_price: '198', market_value: '990', unrealized_pl: '-10', unrealized_plpc: '-0.01' }], bars5: { SPY: spyUp }, live: { SPY: 502.2 }, tick2: 502.7 });
check('bot/STOP: cancels every order and closes every position, buys nothing, and a SPY tick afterwards places nothing', () => { assert.ok(KS.deletes.includes('all-orders') && KS.deletes.includes('all-positions'), JSON.stringify(KS.deletes)); assert.equal(KS.orders.length, 0, JSON.stringify(KS.orders)); assert.ok(KS.tickEntry && !KS.tickEntry.ok && KS.tickEntry.placed.length === 0, JSON.stringify(KS.tickEntry)); });
const oldDay = { symbol: 'QUIET', side: 'buy', status: 'filled', client_order_id: 'sd-d-QUIET-20500-20300-20900-20261001-590-zz', qty: '50', limit_price: '205' };
const swingBuy = { symbol: 'QUIET', side: 'buy', status: 'filled', client_order_id: 'sd-r-QUIET-500-20261022-ab', qty: '50', limit_price: '205', filled_at: '2026-10-22T15:00:00Z' };
const OD = run({ stocks: true, options: false, symbols: ['DIP'], dayTrade: true }, { time: '2026-10-23T19:52:00Z', positions: [qPos(205)], hist: [oldDay, swingBuy] });
check('an old day-trade id (Oct 1) must not capture today\'s swing position in QUIET: the day engine leaves it to the swing rules (no "day trade" sale)', () => { assert.ok(!(OD.acts || []).some(m => /QUIET day trade/.test(m)), JSON.stringify(OD.acts)); assert.ok(!OD.day || !(OD.day.open || []).some(o => o.s === 'QUIET'), 'day engine must not list QUIET as its position'); });
const manualSpy = { ...spyPos(1.5), symbol: 'SPY261024C00510000' };
const MS = run(SO, { positions: [manualSpy], hist: [{ symbol: 'SPY261024C00510000', side: 'buy', status: 'filled', client_order_id: 'hand-made', qty: '20', limit_price: '2.05' }], bars5: { SPY: spyUp }, live: { SPY: 502.2 } });
check('a SPY option bought by hand (no sd-y id) is left alone by the sleeve: no stop sale, no take-profit order', () => assert.ok(!MS.orders.some(o => o.symbol === 'SPY261024C00510000'), JSON.stringify(MS.orders)));
const RE = run(SO, { hist: [{ symbol: 'SPY261113C00502000', side: 'buy', status: 'filled', client_order_id: 'sd-yc-SPY261113C00502000-205-20261023-585-q1', qty: '20', limit_price: '2.05', filled_at: '2026-10-23T13:46:00Z' }], bars5: { SPY: spyUp }, live: { SPY: 502.7 } });
check('SPY re-entry: a second trade in the same contract later in the day is placed (the duplicate guard keys SPY buys by order id, not by symbol)', () => assert.ok(RE.orders.some(o => /^SPY\d{6}C/.test(o.symbol) && o.side === 'buy'), JSON.stringify(RE.orders) + JSON.stringify(RE.acts)));

// ---- SPY money per trade: one trade uses only its % of the SPY share (both the regular check and the instant tick path) ----
const spend = r => r.orders.filter(o => /^SPY\d{6}[CP]/.test(o.symbol) && o.side === 'buy').reduce((t, o) => t + +o.qty * +o.limit_price * 100, 0);
const P100 = run(SO, { bars5: { SPY: spyUp }, live: { SPY: 502.7 } }), P50 = run({ ...SO, spyTradePct: 50 }, { bars5: { SPY: spyUp }, live: { SPY: 502.7 } }), P20 = run({ ...SO, spyTradePct: 20 }, { bars5: { SPY: spyUp }, live: { SPY: 502.7 } });
check('SPY money per trade 100% (default): one trade spends up to the whole $5,000 share (24 contracts at $2.05)', () => { assert.ok(spend(P100) <= 5000 && spend(P100) > 4500, 'spent ' + spend(P100)); });
check('SPY money per trade 50%: one trade spends at most $2,500 (12 contracts)', () => { assert.ok(spend(P50) <= 2500 && spend(P50) > 2000, 'spent ' + spend(P50)); assert.equal(P50.spy.rules.tradePct, 50); });
check('SPY money per trade 20%: at most $1,000 (4 contracts)', () => assert.ok(spend(P20) <= 1000 && spend(P20) > 600, 'spent ' + spend(P20)));
const PT = run({ ...SO, spyTradePct: 50 }, { bars5: { SPY: spyUp }, live: { SPY: 502.2 }, tick: 502.7 });
check('SPY money per trade 50% on the instant tick path too: at most $2,500', () => { const sp = PT.tickEntry.placed.filter(o => o.side === 'buy').reduce((t, o) => t + +o.qty * +o.limit_price * 100, 0); assert.ok(PT.tickEntry.ok && sp <= 2500 && sp > 2000, 'spent ' + sp + ' ' + JSON.stringify(PT.tickEntry)); });
const PF = run({ ...SO, spyTradePct: 100 }, { positions: [{ ...spyPos(2.0), qty: '15', market_value: '3000' }], hist: spyBuy(596), bars5: { SPY: spyUp }, live: { SPY: 502.2 } });
check('SPY money per trade never exceeds what is free: with $3,000 already in a trade, the sleeve does not open a second one (one at a time)', () => assert.ok(!PF.orders.some(o => o.side === 'buy' && /^SPY/.test(o.symbol)), JSON.stringify(PF.orders)));

// ---- second audit: false halt after a sale, day-trade money, STOP before the clock, the fast lane and quote lane ----
const callA = { symbol: 'DIP261113C00111000', qty: '20', avg_entry_price: '2.5', current_price: '2.5', lastday_price: '2.5', market_value: '5000', unrealized_pl: '0', unrealized_plpc: '0' };
const callB = { ...callA, symbol: 'QUIET261113C00210000' };
const callHist = [callA, callB].map(c => ({ symbol: c.symbol, side: 'buy', status: 'filled', client_order_id: 'sd-q-' + c.symbol + '-20261023-20-ab', qty: '20', limit_price: '2.5', filled_at: '2026-10-23T13:40:00Z' }));
const boughtToday = [{ symbol: callA.symbol, side: 'buy', qty: '20', price: '2.5', order_id: 'b1', transaction_time: '2026-10-23T13:40:00Z' }];
const FH = run({ stocks: true, options: true, symbols: ['DIP'], preset: 'custom', maxHeat: 15 }, { positions: [callA, callB], hist: callHist, fills: boughtToday, positionsAfter: [callB], cycles: 2 });
const PFX = run({ stocks: true, options: true, symbols: ['DIP'], preset: 'custom', maxHeat: 15 }, { positions: [{ ...callA, current_price: '1.0', market_value: '2000', unrealized_pl: '-3000', unrealized_plpc: '-0.6' }], hist: [{ ...callHist[0], status: 'partially_filled', qty: '40', filled_qty: '20' }], fills: boughtToday });
check('partial fill: a swing CALL whose buy is still partly working is managed — down 60% it is sold (option stop)', () => assert.ok(PFX.orders.some(o => o.symbol === callA.symbol && o.side === 'sell' && o.type === 'market'), JSON.stringify(PFX.orders) + JSON.stringify(PFX.acts)));
const FH3 = run({ stocks: true, options: true, symbols: ['DIP'], preset: 'custom', maxHeat: 15 }, { positions: [callA, callB], hist: callHist, fills: boughtToday, positionsAfter: [callB], cycles: 4 });
check('journal: carries the real account since the first trade (start = the first fill’s date, account points, the five funds) for the “since the bot started” card', () => { const S = FH3.since; assert.ok(S && S.start === '2026-10-23', JSON.stringify(S)); assert.ok(S.base > 0 && S.pts.length >= 1); assert.ok(S.bench && typeof S.bench === 'object'); });
check('false halt: … and still not two or three checks later while the sell fill is missing (the guard is sticky, not one-cycle)', () => {
  assert.ok(!(FH3.split && FH3.split.call && FH3.split.call.halted), JSON.stringify(FH3.split && FH3.split.call));
  assert.ok(!FH3.orders.some(o => o.symbol === callB.symbol && o.side === 'sell' && o.type === 'market'), JSON.stringify(FH3.orders.filter(o => o.side === 'sell')));
});
check('false halt: a CALL sold at a profit whose sell fill is not listed yet does NOT stop the CALL part, and the other CALL is not sold', () => {
  assert.ok(!(FH.split && FH.split.call && FH.split.call.halted), JSON.stringify(FH.split && FH.split.call));
  assert.ok(!FH.orders.some(o => o.symbol === callB.symbol && o.side === 'sell' && o.type === 'market'), JSON.stringify(FH.orders.filter(o => o.side === 'sell')));
});
const DTM = run({ ...DT, symbols: ['ORB', 'ORB2'], preset: 'custom', callSharePct: 60, putSharePct: 30, spySharePct: 5, maxHeat: 15 });
check('day trading: two setups in one check share the stock money — together they never exceed the $5,000 stock share', () => { const spent = DTM.orders.filter(o => o.side === 'buy' && /^ORB2?$/.test(o.symbol)).reduce((t, o) => t + +o.qty * +o.limit_price, 0); assert.ok(spent > 0 && spent <= 5000 + 1, 'spent ' + spent + ' ' + JSON.stringify(DTM.orders.map(o => o.symbol + ' ' + o.qty))); });
const KS2 = run({ stocks: true, options: true, symbols: ['DIP'] }, { stop: true, clockFail: true, positions: [{ symbol: 'AAPL', qty: '5', avg_entry_price: '200', current_price: '198', market_value: '990', unrealized_pl: '-10', unrealized_plpc: '-0.01' }] });
check('bot/STOP works even when the broker clock is down (it is checked before any other call)', () => assert.ok(KS2.deletes.includes('all-orders') && KS2.deletes.includes('all-positions'), JSON.stringify(KS2.deletes)));
const manualSpy2 = { ...spyPos(1.5), symbol: 'SPY261024C00510000' };
const FL = run(SO, { positions: [spyPos(2.1), manualSpy2], hist: spyBuy(596).concat([{ symbol: manualSpy2.symbol, side: 'buy', status: 'filled', client_order_id: 'hand-made', qty: '20', limit_price: '2.05' }]), bars5: { SPY: spyUp }, live: { SPY: 502.2 }, fast: { positions: [spyPos(2.1), manualSpy2] } });
check('SPY fast lane: a SPY option bought by hand (down 27%) is left alone; only the sleeve\'s own trade is managed', () => assert.ok(!FL.orders.some(o => o.symbol === manualSpy2.symbol), JSON.stringify(FL.orders)));
const QG = run(SO, { positions: [spyPos(2.1)], hist: spyBuy(596), bars5: { SPY: spyUp }, live: { SPY: 502.2 }, quote2: { sym: spySym, bp: 1.70, ap: 1.74 }, quoteGone: true });
check('SPY quote exit: if the option is already gone (take-profit filled), a late stop quote sells nothing', () => assert.equal(QG.quoteExit.placed.length, 0, JSON.stringify(QG.quoteExit)));

console.log(`\n${passed} order checks passed` + (process.exitCode ? ' (some FAILED)' : ''));
