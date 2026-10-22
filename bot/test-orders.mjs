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
  const cfg = JSON.parse(process.argv[3]);
  const REAL = Date, FIXED = REAL.parse('2026-10-23T14:00:00Z');          // Fri 10:00 ET, inside the entry window
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
    JUNK: series(2, 3, [-0.04, -0.04]),           // penny stock that also dipped: the scan must drop it (price < $5)
  };
  BARS.JUNK.forEach(b => b.v = 5e7); BARS.SPY.forEach(b => b.v = 5e6);
  const lastC = s => BARS[s][BARS[s].length - 1].c;
  const orders = [], unknown = [];
  const occ = (und, type, px) => und + '261113' + type[0].toUpperCase() + String(Math.round(px) * 1000).padStart(8, '0');

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const send = o => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
      if (p === '/v2/clock') return send({ is_open: true, timestamp: '2026-10-23T10:00:00-04:00', next_open: '2026-10-26T09:30:00-04:00', next_close: '2026-10-23T16:00:00-04:00' });
      if (p === '/v2/account') return send({ equity: '100000', last_equity: '100000', cash: '100000', buying_power: '400000', pattern_day_trader: false, daytrade_count: 0, status: 'ACTIVE', multiplier: '4' });
      if (p === '/v2/positions') return send([]);
      if (p === '/v2/assets') return send(Object.keys(BARS).map(s => ({ symbol: s, tradable: true, exchange: 'NASDAQ' })).concat([{ symbol: 'OTCX', tradable: true, exchange: 'OTC' }, { symbol: 'WARR.WS', tradable: true, exchange: 'NYSE' }]));
      if (p === '/v2/account/activities/FILL') return send([]);
      if (p === '/v2/account/portfolio/history') return send({ equity: [100000, 100000], timestamp: [1, 2], base_value: 100000 });
      if (p === '/v2/orders' && req.method === 'POST') { const o = JSON.parse(body); orders.push(o); return send({ id: 'o' + orders.length, status: 'accepted', ...o }); }
      if (p === '/v2/orders') return send([]);
      if (p === '/v2/stocks/bars') { const out = {}; for (const s of (u.searchParams.get('symbols') || '').split(',')) if (BARS[s]) out[s] = BARS[s]; return send({ bars: out }); }
      if (p === '/v2/stocks/trades/latest') { const out = {}; for (const s of (u.searchParams.get('symbols') || '').split(',')) if (BARS[s]) out[s] = { p: s === 'FALL' ? lastC(s) * 0.9 : lastC(s), t: '2026-10-23T14:00:00Z' }; return send({ trades: out }); }
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
  fs.mkdirSync('bot', { recursive: true });
  const bot = await import(pathToFileURL(path.join(HERE, 'bot.mjs')).href);
  bot.applyConfig({ symbols: ['DIP', 'POP', 'FALL'], mode: 'paper', newsGuard: false, eventGuard: false, ...cfg });
  await bot.botCycle();
  server.close();
  let watch = null; try { watch = JSON.parse(fs.readFileSync('bot/journal.json', 'utf8')).watch; } catch (e) {}
  let acts = null; try { acts = JSON.parse(fs.readFileSync('bot/journal.json', 'utf8')).acts.map(a => a.m); } catch (e) {}
  console.log('RESULT ' + JSON.stringify({ acts, watch, orders, unknown, options: orders.filter(o => /\d{6}[CP]\d{8}$/.test(o.symbol)).map(o => ({ symbol: o.symbol, id: o.client_order_id.split('-').slice(0, 2).join('-') })) }));
  process.exit(0);
}

function run(cfg) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-orders-'));
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'child', JSON.stringify(cfg)], { cwd: tmp, encoding: 'utf8', timeout: 90000 });
  const line = (r.stdout || '').split('\n').find(l => l.startsWith('RESULT '));
  if (!line) throw new Error('no result for ' + JSON.stringify(cfg) + '\n' + r.stdout + r.stderr);
  return JSON.parse(line.slice(7));
}

let passed = 0;
const check = (name, fn) => { try { fn(); console.log('  ✓', name); passed++; } catch (e) { console.log('  ✗', name, '\n   ', e.message); process.exitCode = 1; } };

const A = run({ stocks: true, options: true });                       // default: puts off
check('default: stock buy on the dip stock', () => assert.ok(A.orders.some(o => o.symbol === 'DIP' && o.side === 'buy')));
check('default: CALL on the dip stock (sd-q-)', () => { assert.equal(A.options.length, 1); assert.match(A.options[0].symbol, /^DIP\d{6}C/); assert.equal(A.options[0].id, 'sd-q'); });
check('alerts: a buy alert carries size and price', () => assert.ok((A.acts || []).some(m => /DIP RSI-2 dip buy .*\u00b7 \d+ shares @ \$[\d.]+ \(\$[\d,]+/.test(m)), JSON.stringify(A.acts)));
check('default: no PUT is ever placed', () => assert.ok(!A.orders.some(o => /^POP\d{6}P/.test(o.symbol))));

const B = run({ stocks: true, options: true, puts: true });
check('puts on: CALL still placed on the dip stock', () => assert.ok(B.options.some(o => /^DIP\d{6}C/.test(o.symbol) && o.id === 'sd-q')));
check('puts on: PUT placed on the pop stock (sd-p-)', () => assert.ok(B.options.some(o => /^POP\d{6}P/.test(o.symbol) && o.id === 'sd-p')));
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
check('market scan: a penny stock is dropped even though it dipped and trades heavily', () => { assert.ok(!S.orders.some(o => o.symbol === 'JUNK')); assert.ok(!S.watch.rows.some(r => r.s === 'JUNK')); assert.equal(S.watch.scanned, 6); });
check('market scan: the dip stock found by the scan is bought', () => assert.ok(S.orders.some(o => o.symbol === 'DIP' && o.side === 'buy')));

const F = run({ stocks: true, options: true, puts: true, stockUnit: 'usd', stockUsd: 5000, stockCapUsd: 50, callCapPct: 0.1, putUnit: 'usd', putUsd: 5000, putCapUsd: 100 });
check('ceilings: nothing bought when each sleeve ceiling is below one unit', () => assert.equal(F.orders.length, 0, JSON.stringify(F.orders.map(o => o.symbol))));

console.log(`\n${passed} order checks passed` + (process.exitCode ? ' (some FAILED)' : ''));
