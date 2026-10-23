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
    POP: series(120, 80, [0.04, 0.04]),          // downtrend, two sharp up days  -> RSI-2 ~ 100, below 200-day
    FALL: series(80, 120, [0.001, 0.001]),       // uptrend, quiet at yesterday's close; the live price below drops it 10%
    SPY: series(400, 520, [0.001, 0.001]),
    QUIET: series(200, 210, [0.001, 0.001]),      // ordinary liquid stock, no signal
    ORB: series(95, 100.5, [0.001, 0.001]),        // day-trade stock: flat daily picture, action is intraday
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
  const BARS5 = { ORB: ORB5, BRK: BRK5, SPY: SPY5, ...(FAKE.bars5 || {}) };
  const LIVE = { ORB: 101.55, BRK: 99.45, SPY: (FAKE.spy || 'up') === 'up' ? 502.4 : 497.4, ...(FAKE.live || {}) };
  const orders = [], unknown = [], deletes = [], patches = [], tgSent = [];
  const tgMsg = (id, chat, text) => ({ update_id: id, message: { chat: { id: chat }, date: Math.floor(FIXED / 1000), text } });
  const tgQueue = [(FAKE.tgBefore || []).map((t, i) => tgMsg(100 + i, t[0], t[1])), (FAKE.tgAfter || []).map((t, i) => tgMsg(200 + i, t[0], t[1]))];
  const occ = (und, type, px) => und + '261113' + type[0].toUpperCase() + String(Math.round(px) * 1000).padStart(8, '0');

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const send = o => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      if (p === '/bottest-token/getUpdates') return send({ ok: true, result: tgQueue.shift() || [] });
      if (p === '/bottest-token/sendMessage') { tgSent.push(JSON.parse(body)); return send({ ok: true, result: { message_id: tgSent.length } }); }
      if (p === '/v2/clock') return send({ is_open: !FAKE.closed, timestamp: new REAL(FIXED).toISOString(), next_open: '2026-10-26T09:30:00-04:00', next_close: '2026-10-23T16:00:00-04:00' });
      if (p === '/v2/account') return send({ equity: '100000', last_equity: '100000', cash: '100000', buying_power: '400000', pattern_day_trader: false, daytrade_count: 0, status: 'ACTIVE', multiplier: '4' });
      if (p === '/v2/positions') return send(FAKE.positions || []);
      if (p === '/v2/assets' && FAKE.slowAssets) return setTimeout(() => send([]), FAKE.slowAssets);
      if (p === '/v2/assets') return send(Object.keys(BARS).map(s => ({ symbol: s, tradable: true, exchange: 'NASDAQ' })).concat([{ symbol: 'OTCX', tradable: true, exchange: 'OTC' }, { symbol: 'WARR.WS', tradable: true, exchange: 'NYSE' }]));
      if (p === '/v2/account/activities/FILL') return send([]);
      if (p === '/v2/account/portfolio/history') return send({ equity: [100000, 100000], timestamp: [1, 2], base_value: 100000 });
      if (p.startsWith('/v2/orders/') && req.method === 'DELETE') { deletes.push(p.split('/').pop()); return send(null); }
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
      if (p === '/v1beta1/options/quotes/latest') { const out = {}; for (const s of (u.searchParams.get('symbols') || '').split(',')) out[s] = { ap: 2.05, bp: 2.0 }; return send({ quotes: out }); }
      unknown.push(req.method + ' ' + p); send({});
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port;
  process.env.ALPACA_URL = url; process.env.ALPACA_DATA_URL = url;
  process.env.ALPACA_KEY = 'test'; process.env.ALPACA_SECRET = 'test';
  if (FAKE.journalKey) process.env.JOURNAL_KEY = FAKE.journalKey;
  if (FAKE.tg) { process.env.TELEGRAM_API = url; process.env.TELEGRAM_TOKEN = 'test-token'; process.env.TELEGRAM_CHAT = '42'; }                        // privacy mode: encrypted journal (must be set before the import)
  fs.mkdirSync('bot', { recursive: true });
  const bot = await import(pathToFileURL(path.join(HERE, 'bot.mjs')).href);
  if (FAKE.prevJournal) fs.writeFileSync('bot/journal.json', JSON.stringify(FAKE.journalKey ? await bot.encryptJournal(FAKE.prevJournal, FAKE.prevKey || FAKE.journalKey, 1000) : FAKE.prevJournal));   // what the previous run left behind
  bot.applyConfig({ symbols: ['DIP', 'POP', 'FALL'], mode: 'paper', newsGuard: false, eventGuard: false, ...cfg });
  if (FAKE.tg) await bot.tgPollCycle();
  const tc0 = REAL.now(); await bot.botCycle({ journal: !!FAKE.closed }); const cycleMs = REAL.now() - tc0;
  if (FAKE.tg) await bot.tgPollCycle();
  if (FAKE.cycles > 1) for (let k = 1; k < FAKE.cycles; k++) await bot.botCycle({ journal: true });   // a longer session: the journal is rewritten several times
  server.closeAllConnections && server.closeAllConnections(); server.close();
  let jj = null; try { jj = JSON.parse(fs.readFileSync('bot/journal.json', 'utf8')); if (jj.enc) jj = { ...jj, ...(await bot.decryptJournal(jj, FAKE.journalKey)) }; } catch (e) {}
  const watch = jj && jj.watch, day = jj && jj.day, env = jj && jj.env, acts = jj && jj.acts ? jj.acts.map(a => a.m) : null;
  console.log('RESULT ' + JSON.stringify({ cycleMs, tgSent, acts, watch, day, env, enc: !!(jj && jj.enc), deletes, patches, orders, unknown, options: orders.filter(o => /\d{6}[CP]\d{8}$/.test(o.symbol)).map(o => ({ symbol: o.symbol, id: o.client_order_id.split('-').slice(0, 2).join('-') })) }));
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
check('market scan: a penny stock is dropped even though it dipped and trades heavily', () => { assert.ok(!S.orders.some(o => o.symbol === 'JUNK')); assert.ok(!S.watch.rows.some(r => r.s === 'JUNK')); assert.equal(S.watch.scanned, 8); });
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
check('journal: a previous entry written under another passphrase is skipped, not a crash (fresh journal, still encrypted)', () => { assert.ok(J3.enc); assert.equal(J3.watch, null); assert.ok(Array.isArray(J3.acts)); });

const SL = run({ stocks: true, options: false, universe: 'scan', symbols: ['DIP', 'POP', 'FALL'] }, { slowAssets: 20000 });
check('market scan: a scan that takes minutes does not hold up the cycle; the bot trades its list meanwhile', () => { assert.ok(SL.cycleMs < 12000, 'cycle took ' + SL.cycleMs + ' ms'); assert.ok(SL.orders.some(o => o.symbol === 'DIP' && o.side === 'buy'), JSON.stringify(SL.acts)); assert.ok((SL.acts || []).some(m => /market scan started/.test(m))); });

// ---- Telegram: alerts to the owner's chat, commands answered only there, /pause blocks new entries but never sells ----
const TG = run({ stocks: true, options: false, symbols: ['DIP'] }, { tg: true, tgAfter: [[42, '/money'], [42, '/status'], [42, '/watch'], [999, '/money'], [42, '/help']] });
const tgTxt = TG.tgSent.map(m => m.text);
check('telegram: the buy alert arrives in the owner\'s chat with size and price', () => assert.ok(TG.tgSent.some(m => m.chat_id === '42' && /DIP RSI-2 dip buy .*\d+ shares @ \$/.test(m.text)), JSON.stringify(tgTxt)));
check('telegram: /money, /status, /watch and /help answer in the owner\'s chat', () => { assert.ok(tgTxt.some(t => /In trades now/.test(t) && /Free to trade/.test(t))); assert.ok(tgTxt.some(t => /Watching \d+ stocks/.test(t) && /Market check/.test(t))); assert.ok(tgTxt.some(t => /Buy: DIP/.test(t))); assert.ok(tgTxt.some(t => /\/pause/.test(t) && /never buy or sell/.test(t))); });
check('telegram: a message from any other chat is ignored and never answered', () => { assert.ok(TG.tgSent.every(m => m.chat_id === '42')); assert.equal(tgTxt.filter(t => /In trades now/.test(t)).length, 1); });
const TP = run({ stocks: true, options: true, symbols: ['DIP'] }, { tg: true, tgBefore: [[42, '/pause']], positions: [{ symbol: 'AAPL', qty: '5', avg_entry_price: '200', current_price: '198', market_value: '990', unrealized_pl: '-10', unrealized_plpc: '-0.01' }] });
check('telegram: /pause stops new entries (no buy on the dip stock) and confirms', () => { assert.ok(!TP.orders.some(o => o.side === 'buy'), JSON.stringify(TP.orders)); assert.ok(TP.tgSent.some(m => /Paused: no new entries/.test(m.text))); });
check('telegram: /pause never sells what is open (only protective stop orders may be placed)', () => assert.ok(TP.orders.filter(o => o.side === 'sell').every(o => o.type === 'stop'), JSON.stringify(TP.orders)));

console.log(`\n${passed} order checks passed` + (process.exitCode ? ' (some FAILED)' : ''));
