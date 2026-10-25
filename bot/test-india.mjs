// India simulation tests: the rules, the fills, the bookkeeping, and one full run against a stand-in for Yahoo.
//   node bot/test-india.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { normalizeIn, newJournal, stepSleeve, processDays, applySplits, markKnownSplits, watchList, dayMessage, STRATS } from './india.mjs';
import { decryptJournal } from './jcrypt.mjs';

let passed = 0, failed = 0;
const test = async (name, fn) => { try { await fn(); console.log('  ✓', name); passed++; } catch (e) { console.log('  ✗', name, '\n   ', e.message); failed++; } };

// trading dates: weekdays from 2025-01-01
const dates = n => { const out = []; let t = Date.parse('2025-01-01T00:00:00Z'); while (out.length < n) { const d = new Date(t); if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10)); t += 864e5; } return out; };
const D = dates(320);
const mk = closes => { const B = closes.map((c, i) => ({ d: D[i], o: +(c * 0.998).toFixed(2), h: +(c * 1.006).toFixed(2), l: +(c * 0.994).toFixed(2), c })); return { B, C: B.map(b => b.c), idx: Object.fromEntries(B.map((b, i) => [b.d, i])) }; };
const upTrend = (n, from = 100, to = 160) => Array.from({ length: n }, (_, i) => +(from + (to - from) * i / (n - 1) + Math.sin(i / 3) * 0.8).toFixed(2));
const cut = (S, n) => { const B = S.B.slice(0, n); return { B, C: B.map(b => b.c), idx: Object.fromEntries(B.map((b, i) => [b.d, i])) }; };
const cfg = normalizeIn({});

await test('settings: defaults, clamps, and at least one strategy stays on', () => {
  assert.equal(cfg.stakeInr, 1000000); assert.equal(cfg.breakoutShare, 50); assert.equal(cfg.costPct, 0.15);
  const c = normalizeIn({ stakeInr: 5, posPct: 99, maxPos: 0, breakout: false, rsi2: false });
  assert.equal(c.stakeInr, 10000); assert.equal(c.posPct, 50); assert.equal(c.maxPos, 1); assert.equal(c.breakout, true);
});
await test('journal: ₹10 lakh split 50/50 between the two sleeves; one strategy off → the other gets everything', () => {
  const J = newJournal(cfg, D[0], 20000); assert.equal(J.sleeves.breakout.start, 500000); assert.equal(J.sleeves.rsi2.start, 500000);
  const J2 = newJournal(normalizeIn({ rsi2: false }), D[0], 20000); assert.equal(J2.sleeves.breakout.start, 1000000); assert.equal(J2.sleeves.rsi2.on, false);
});
await test('breakout: a close above the 50-day high (above the 200-day) is planned, fills next open in whole shares with costs', () => {
  const closes = upTrend(260); closes.push(closes[259] * 1.05);              // day 260: fresh 50-day high
  const data = { 'AAA.NS': mk(closes.concat([closes[260] * 1.01, closes[260] * 1.02])) };
  const S = { on: true, start: 500000, cash: 500000, open: [], pending: [], closed: [] };
  const e1 = stepSleeve('breakout', S, D[260], { 'AAA.NS': cut(data['AAA.NS'], 261) }, cfg, ['AAA.NS']);
  assert.deepEqual(e1.planned, ['AAA.NS']); assert.equal(S.pending[0].alloc, 50000);   // 10 % of the sleeve
  const e2 = stepSleeve('breakout', S, D[261], data, cfg, ['AAA.NS']);
  const p = e2.bought[0], open = data['AAA.NS'].B[261].o;
  assert.equal(p.entryPx, Math.round(open * 100) / 100); assert.equal(p.qty, Math.floor(50000 / (open * 1.0015)));
  assert.ok(Math.abs(S.cash - (500000 - p.qty * open * 1.0015)) < 0.01);
});
await test('breakout: sells at the close that falls below the 20-day low', () => {
  const closes = upTrend(260); closes.push(closes[259] * 1.05); closes.push(closes[260] * 1.01);
  for (let k = 0; k < 5; k++) closes.push(closes[closes.length - 1] * 0.97);          // slide below the 20-day low
  const data = { 'AAA.NS': mk(closes) };
  const S = { on: true, start: 500000, cash: 500000, open: [], pending: [{ sym: 'AAA.NS', plannedOn: D[260], alloc: 50000, why: 't' }], closed: [] };
  let sold = null;
  for (let i = 261; i < closes.length && !sold; i++) { const e = stepSleeve('breakout', S, D[i], data, cfg, []); if (e.sold.length) sold = { e, i }; }
  assert.ok(sold, 'never sold'); const c = sold.e.sold[0];
  assert.equal(c.outPx, Math.round(closes[sold.i] * 100) / 100); assert.match(c.why, /below its 20-day low/);
  assert.ok(c.pl < 0); assert.equal(S.open.length, 0);
});
await test('RSI-2: two sharp down days in an uptrend are planned; sells on a close above the 5-day average', () => {
  const closes = upTrend(250); closes.push(closes[249] * 0.96, closes[249] * 0.92);   // RSI-2 ~ 0, still above the 200-day
  closes.push(closes[251] * 1.005, closes[251] * 1.06);                               // bounce
  const data = { 'BBB.NS': mk(closes) };
  const S = { on: true, start: 500000, cash: 500000, open: [], pending: [], closed: [] };
  const e = stepSleeve('rsi2', S, D[251], { 'BBB.NS': cut(data['BBB.NS'], 252) }, cfg, ['BBB.NS']);
  assert.deepEqual(e.planned, ['BBB.NS']); assert.match(S.pending[0].why, /RSI-2/);
  stepSleeve('rsi2', S, D[252], data, cfg, ['BBB.NS']); assert.equal(S.open.length, 1);
  const e3 = stepSleeve('rsi2', S, D[253], data, cfg, ['BBB.NS']);
  assert.equal(e3.sold.length, 1); assert.match(e3.sold[0].why, /5-day average/); assert.ok(e3.sold[0].pl > 0);
});
await test('RSI-2: sells after the max hold when the bounce never comes', () => {
  const closes = upTrend(250); closes.push(closes[249] * 0.96, closes[249] * 0.92);
  for (let k = 0; k < 15; k++) closes.push(closes[closes.length - 1] * 0.995);
  const data = { 'BBB.NS': mk(closes) };
  const S = { on: true, start: 500000, cash: 500000, open: [], pending: [{ sym: 'BBB.NS', plannedOn: D[251], alloc: 50000, why: 't' }], closed: [] };
  let sold = null; for (let i = 252; i < closes.length && !sold; i++) { const e = stepSleeve('rsi2', S, D[i], data, normalizeIn({ maxHold: 4 }), []); if (e.sold.length) sold = e.sold[0]; }
  assert.ok(sold); assert.equal(sold.held, 4); assert.match(sold.why, /held 4 sessions/);
});
await test('limits: never more than the max positions, never more money than the sleeve has', () => {
  const data = {}, syms = [];
  for (let s = 0; s < 10; s++) { const c = upTrend(250, 100 + s, 160 + s); c.push(c[249] * 0.96, c[249] * 0.92); data['S' + s + '.NS'] = mk(c); syms.push('S' + s + '.NS'); }
  const S = { on: true, start: 500000, cash: 500000, open: [], pending: [], closed: [] };
  const e = stepSleeve('rsi2', S, D[251], data, normalizeIn({ maxPos: 4 }), syms);
  assert.equal(e.planned.length, 4);
  const S2 = { on: true, start: 500000, cash: 500000, open: [], pending: [], closed: [] };
  const e2 = stepSleeve('rsi2', S2, D[251], data, normalizeIn({ posPct: 40, maxPos: 10 }), syms);
  assert.equal(e2.planned.length, 2, '40 % each: only two fit');
});
await test('a planned stock that does not trade the next day is skipped, not bought at a stale price', () => {
  const closes = upTrend(250); closes.push(closes[249] * 0.96, closes[249] * 0.92);
  const data = { 'BBB.NS': mk(closes) };                                             // no bar after day 251
  const S = { on: true, start: 500000, cash: 500000, open: [], pending: [{ sym: 'BBB.NS', plannedOn: D[251], alloc: 50000, why: 't' }], closed: [] };
  const e = stepSleeve('rsi2', S, D[252], data, cfg, []);
  assert.equal(e.bought.length, 0); assert.match(e.skipped[0], /no trade/); assert.equal(S.cash, 500000);
});
await test('catch-up and idempotency: missed days are processed once each, a second run changes nothing', () => {
  const closes = upTrend(250); closes.push(closes[249] * 0.96, closes[249] * 0.92, closes[249] * 0.93, closes[249] * 0.99);
  const data = { 'BBB.NS': mk(closes) }, bench = mk(upTrend(254, 20000, 24000));
  const J = newJournal(normalizeIn({ breakout: false }), D[250], bench.C[250]);
  const ev = processDays(J, D.slice(0, 254), data, J.cfg || normalizeIn({ breakout: false }), ['BBB.NS'], bench);
  assert.deepEqual(ev.map(e => e.d), [D[251], D[252], D[253]]);
  const snap = JSON.stringify(J);
  assert.equal(processDays(J, D.slice(0, 254), data, normalizeIn({ breakout: false }), ['BBB.NS'], bench).length, 0);
  assert.equal(JSON.stringify(J), snap);
  assert.equal(J.equity.length, 4); assert.ok(J.acts.some(a => /bought/.test(a.m)));
});
await test('splits: a 1:2 split after buying doubles the shares and halves the entry price (value unchanged)', () => {
  const J = newJournal(cfg, D[0], 1); J.sleeves.rsi2.open.push({ sym: 'X.NS', qty: 10, entryPx: 200, entryDate: D[5], held: 1, paid: 2003 });
  applySplits(J, { 'X.NS': [{ d: D[3], num: 2, den: 1 }, { d: D[8], num: 2, den: 1 }] });
  const p = J.sleeves.rsi2.open[0]; assert.equal(p.qty, 20); assert.equal(p.entryPx, 100);
  applySplits(J, { 'X.NS': [{ d: D[8], num: 2, den: 1 }] }); assert.equal(p.qty, 20, 'same split applied twice');
});
await test('splits: a position bought during a catch-up (already split-adjusted prices) is not adjusted again next run', () => {
  const J = newJournal(cfg, D[0], 1); J.sleeves.rsi2.open.push({ sym: 'X.NS', qty: 20, entryPx: 100, entryDate: D[5], held: 1, paid: 2003 });
  const sp = { 'X.NS': [{ d: D[8], num: 2, den: 1 }] };
  markKnownSplits(J, sp); applySplits(J, sp);
  const p = J.sleeves.rsi2.open[0]; assert.equal(p.qty, 20, 'double split'); assert.equal(p.entryPx, 100);
});
await test('day message during a catch-up shows that day\'s value, not the latest', () => {
  const J = newJournal(cfg, D[0], 20000); J.equity.push({ d: D[1], total: 1010000, nifty: 20000 }, { d: D[2], total: 1050000, nifty: 20000 });
  const m = dayMessage(J, { d: D[1], evs: {} }, cfg); assert.match(m, /₹10,10,000/); assert.doesNotMatch(m, /10,50,000/);
});
await test('watch list and the day message', () => {
  const closes = upTrend(260); const data = { 'AAA.NS': mk(closes) };
  const W = watchList(data, D[259], cfg, ['AAA.NS']); assert.equal(W.breakout[0].s, 'AAA.NS'); assert.ok(W.rsi2[0].r2 >= 0);
  const J = newJournal(cfg, D[258], 20000); J.equity.push({ d: D[259], total: 1012345, nifty: 20200 });
  const m = dayMessage(J, { d: D[259], evs: { breakout: { bought: [], sold: [{ sym: 'AAA.NS', qty: 5, outPx: 150, pl: 812.5, plPct: 3.2 }], planned: ['BBB.NS'], skipped: [] } } }, cfg);
  assert.match(m, /🇮🇳/); assert.match(m, /sold 5 AAA.NS @ ₹150/); assert.match(m, /₹10,12,345/); assert.match(m, /Nifty 50 \+1\.00%/);
  assert.ok(STRATS.breakout.label && STRATS.rsi2.label);
});

// ---- full run against a stand-in for Yahoo: journal written encrypted, alerts sent, rerun is a no-op ----
await test('full run: fetches bars, starts the simulation, writes an encrypted journal, sends the day alert; rerun adds nothing', async () => {
  const n = 300, allDates = dates(n + 1);
  const nifty = upTrend(n + 1, 20000, 25000), dip = upTrend(n + 1); dip[n - 2] = dip[n - 3] * 0.96; dip[n - 1] = dip[n - 3] * 0.92; dip[n] = dip[n - 1] * 1.01;
  let upto = n;                                                                         // how many days Yahoo "has" so far
  const series = {}, bars = closes => ({ get ts() { return allDates.slice(0, upto).map(d => Date.parse(d + 'T03:45:00Z') / 1000); }, get closes() { return closes.slice(0, upto); } });
  series['^NSEI'] = bars(nifty); series['RELIANCE.NS'] = bars(dip);
  const sent = [];
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); res.setHeader('content-type', 'application/json');
    if (u.pathname.startsWith('/bott/')) { let b = ''; req.on('data', c => b += c); req.on('end', () => { sent.push(JSON.parse(b)); res.end('{"ok":true,"result":{}}'); }); return; }
    const sym = decodeURIComponent(u.pathname.split('/').pop()), s = series[sym];
    if (!s) { res.statusCode = 404; return res.end('{}'); }
    res.end(JSON.stringify({ chart: { result: [{ timestamp: s.ts, indicators: { quote: [{ open: s.closes.map(c => c * 0.998), high: s.closes.map(c => c * 1.006), low: s.closes.map(c => c * 0.994), close: s.closes }] }, events: {} }] } }));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-india-')); fs.mkdirSync(path.join(tmp, 'bot'));
  const base = 'http://127.0.0.1:' + srv.address().port;
  Object.assign(process.env, { YAHOO_BASE: base, YAHOO_PAUSE_MS: '0', JOURNAL_KEY: 'india-test-pass', TELEGRAM_API: base, TELEGRAM_TOKEN: 't', TELEGRAM_CHAT: '7' });
  const { runIndia } = await import('./india.mjs');
  const file = path.join(tmp, 'bot/india-journal.json'), cfgFile = path.join(tmp, 'bot/config-in.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ stakeInr: 1000000 }));
  const r1 = await runIndia({ file, cfgFile, log: () => {} });
  upto = n + 1;                                                                         // the next trading day arrives
  const r2 = await runIndia({ file, cfgFile, log: () => {} });
  const r3 = await runIndia({ file, cfgFile, log: () => {} });                          // same day again
  srv.close();
  assert.equal(r2.events.length, 1); assert.equal(r3.events.length, 0, 'second run on the same day must change nothing');
  assert.ok(r2.J.sleeves.rsi2.open.some(p => p.sym === 'RELIANCE.NS' && p.entryDate === allDates[n]), 'not bought at the next open');
  assert.ok(sent.some(m => m.chat_id === '7' && /🇮🇳/.test(m.text) && /bought \d+ RELIANCE\.NS/.test(m.text)), 'no day alert: ' + JSON.stringify(sent));
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.enc, 1); assert.ok(!fs.readFileSync(file, 'utf8').includes('RELIANCE'), 'plaintext leaked');
  const J = await decryptJournal(raw, 'india-test-pass');
  assert.equal(J.stake, 1000000); assert.equal(J.lastDate, allDates[n]);
  assert.ok(J.acts.some(a => /will buy at the next open: RELIANCE/.test(a.m)), 'dip not planned: ' + JSON.stringify(J.acts));
  assert.equal(r1.events.length, 0, 'first run only plans');
  assert.ok(J.watch && J.watch.rsi2.length);
});

await test('a journal that cannot be decrypted is never overwritten (JOURNAL_RESET=1 starts over)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-india-lock-')); fs.mkdirSync(path.join(tmp, 'bot'));
  const { encryptJournal } = await import('./jcrypt.mjs');
  const file = path.join(tmp, 'bot/india-journal.json'), cfgFile = path.join(tmp, 'bot/config-in.json');
  const before = JSON.stringify({ ...(await encryptJournal({ v: 1, stake: 5 }, 'other-pass', 1000)), at: 'x' });
  fs.writeFileSync(file, before); fs.writeFileSync(cfgFile, '{}');
  const srv = http.createServer((req, res) => { const n = 30, d0 = Date.parse('2026-01-01T03:45:00Z') / 1000; res.end(JSON.stringify({ chart: { result: [{ timestamp: Array.from({ length: n }, (_, i) => d0 + i * 86400), indicators: { quote: [{ open: Array(n).fill(10), high: Array(n).fill(10), low: Array(n).fill(10), close: Array(n).fill(10) }] }, events: {} }] } })); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); process.env.YAHOO_BASE = 'http://127.0.0.1:' + srv.address().port; process.env.JOURNAL_KEY = 'india-test-pass';
  const { runIndia } = await import('./india.mjs'); const logs = [];
  const r = await runIndia({ file, cfgFile, log: (...a) => logs.push(a.join(' ')) });
  assert.equal(r, null); assert.equal(fs.readFileSync(file, 'utf8'), before, 'journal was overwritten'); assert.ok(logs.some(l => /NOT updated/.test(l)));
  process.env.JOURNAL_RESET = '1'; const r2 = await runIndia({ file, cfgFile, log: () => {} }); delete process.env.JOURNAL_RESET; srv.close();
  assert.ok(r2 && r2.J, 'reset did not start over'); assert.notEqual(fs.readFileSync(file, 'utf8'), before);
});

console.log(`\n${passed} India checks passed, ${failed} failed`);
if (failed) process.exitCode = 1;
