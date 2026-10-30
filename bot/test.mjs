// Unit tests for the bot's rules. Run: node bot/test.mjs  (also runs on every push via GitHub Actions)
import assert from 'node:assert/strict';
import { rsi2Signal, rsi2Exit, rsi2, sma, rsi2ShortSignal, rsi2ShortExit, rsi2Trigger, rsi2ExitLevel, profitExit, profitExitLevel, marketAbove200 } from './strategy.mjs';
import { encode as mpEncode, decode as mpDecode } from './msgpack.mjs';
import { spySignal, spyExit, spyFresh, encodeSpyId, decodeSpyId, isSpyOption } from './spyopt.mjs';
import { stockQty, optionQty, regimeOf, lossStreak, openRisk, sectorOf, sideDayPl } from './risk.mjs';
import { buildJournal, parseSym, optionEvents } from './journal.mjs';
import { guard, symbolRisk, classify } from './news.mjs';
import { keysFor, relevant, parseRss } from '../news.mjs';
import { normalize, summary } from './config.mjs';
import { isStockAsset } from './scan.mjs';
import http from 'node:http';
import { rankByLiquidity } from './scan.mjs';
import { collectSignals, evaluate } from './research-day.mjs';
import { vwap, atr, openingRange, relVolume, daySetup, marketMode, dayShares, dayExit, dayTrail, encodeDayId, decodeDayId } from './daytrade.mjs';

let passed = 0, failed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log('  ✓ ' + name); } catch (e) { failed++; console.log('  ✗ ' + name + '\n      ' + e.message); } };
const bars = (n, step, dipFrom = Infinity, dip = 0.975) => { const B = []; let p = 100; for (let i = 0; i < n; i++) { p *= i >= dipFrom ? dip : step; B.push({ o: p, h: p * 1.01, l: p * 0.99, c: p }); } return B; };

console.log('Strategy');
test('RSI-2 fires on a sharp dip in an uptrend', () => { const B = bars(233, 1.003, 230); const s = rsi2Signal(B, B.map(b => b.c)); assert.ok(s); assert.ok(s.r2 < 10); assert.ok(s.riskUnit > 0); });
test('RSI-2 silent in a steady uptrend', () => { const B = bars(233, 1.003); assert.equal(rsi2Signal(B, B.map(b => b.c)), null); });
test('RSI-2 silent below the 200-day average', () => { const B = bars(233, 0.998, 230); assert.equal(rsi2Signal(B, B.map(b => b.c)), null); });
test('RSI-2 needs 200+ sessions', () => { const B = bars(150, 1.003, 147); assert.equal(rsi2Signal(B, B.map(b => b.c)), null); });
test('exit when price closes above 5-day average', () => { assert.equal(rsi2Exit([100, 99, 98, 97], 101, 2).exit, true); });
test('hold while below 5-day average', () => { assert.equal(rsi2Exit([100, 99, 98, 97], 96, 2).exit, false); });
test('exit after 10 sessions regardless', () => { assert.equal(rsi2Exit([100, 99, 98, 97], 96, 10).exit, true); });
test('sma and rsi2 basics', () => { assert.equal(sma([1, 2, 3, 4], 2), 3.5); assert.equal(rsi2([1, 2, 3, 4]), 100); });

console.log('Risk engine');
test('stock size limited by risk at stop', () => { assert.equal(stockQty({ equity: 100000, riskPct: 0.5, entry: 100, stop: 95, budget: 1e9 }), 100); });
test('stock size limited by $ budget', () => { assert.equal(stockQty({ equity: 100000, riskPct: 0.5, entry: 100, stop: 99, budget: 10000 }), 100); });
test('no size when stop is above entry', () => { assert.equal(stockQty({ equity: 100000, riskPct: 0.5, entry: 100, stop: 101, budget: 1e9 }), 0); });
test('option size: -50% stop risks <= riskPct', () => { assert.equal(optionQty({ equity: 100000, riskPct: 0.5, price: 2, budget: 1e9 }), 5); });
test('option size: a wider stop buys fewer contracts for the same risk (90% stop → 2 instead of 5)', () => { assert.equal(optionQty({ equity: 100000, riskPct: 0.5, price: 2, budget: 1e9, stopPct: 90 }), 2); assert.equal(optionQty({ equity: 100000, riskPct: 0.5, price: 2, budget: 1e9, stopPct: 50 }), 5); });
test('open risk: an option counts what its own stop would lose', () => { const pos = [{ symbol: 'AAA261113C00100000', qty: '2', avg_entry_price: '3' }]; assert.equal(openRisk({ positions: pos, orders: [], stopFor: () => null }), 300); assert.equal(openRisk({ positions: pos, orders: [], stopFor: () => null, optStopFor: () => 0.9 }), 540); });
test('regime: bull / bear / unknown', () => {
  assert.equal(regimeOf(Array.from({ length: 250 }, (_, i) => 100 + i)).regime, 'bull');
  assert.equal(regimeOf(Array.from({ length: 250 }, (_, i) => 400 - i)).regime, 'bear');
  assert.equal(regimeOf([1, 2, 3]).regime, 'unknown');
});
test('loss streak counts back from latest trade', () => { assert.equal(lossStreak([{ outT: '1', pl: 5 }, { outT: '2', pl: -1 }, { outT: '3', pl: -2 }]), 2); });
test('open risk: stops, options at -50%, pending orders', () => {
  const r = openRisk({ positions: [{ symbol: 'AAA', qty: '10', avg_entry_price: '100' }, { symbol: 'AAA261030C00100000', qty: '1', avg_entry_price: '2' }], orders: [{ symbol: 'BBB', side: 'buy', qty: '5', limit_price: '50' }], stopFor: s => (s === 'AAA' ? 90 : s === 'BBB' ? 48 : null) });
  assert.equal(r, 10 * 10 + 100 + 5 * 2);
});
test('sector map', () => { assert.equal(sectorOf('NVDA'), 'Tech'); assert.equal(sectorOf('ZZZZ'), 'Other'); });

console.log('Trade journal');
test('FIFO pairing, options x100, partial exits', () => {
  const j = buildJournal([
    { order_id: 'a', symbol: 'AAPL', side: 'buy', qty: '3', price: '260', transaction_time: '2026-10-21T14:00:00Z' },
    { order_id: 'b', symbol: 'AAPL', side: 'sell', qty: '3', price: '263', transaction_time: '2026-10-21T17:00:00Z' },
    { order_id: 'c', symbol: 'MSFT261030C00525000', side: 'buy', qty: '2', price: '10', transaction_time: '2026-10-21T15:00:00Z' },
    { order_id: 'd', symbol: 'MSFT261030C00525000', side: 'sell', qty: '1', price: '15', transaction_time: '2026-10-21T18:00:00Z' }], []);
  assert.equal(j.closed.length, 2);
  assert.equal(j.closed.find(c => c.kind === 'Stock').pl, 9);
  assert.equal(j.closed.find(c => c.kind === 'Call').pl, 500);
});
test('option symbol parsing', () => { const s = parseSym('SPY261218P00600000'); assert.equal(s.kind, 'Put'); assert.equal(s.strike, 600); assert.equal(s.exp, '2026-12-18'); });
test('sold options (the wheel): a sale opens a sold lot, the buy-back closes it with sale − buy; an expiry closes it at 0 (premium kept)', () => {
  const P = 'KO261120P00065000', C = 'KO261218C00068000';
  const j = buildJournal([
    { order_id: 's1', symbol: P, side: 'sell', qty: '1', price: '0.90', transaction_time: '2026-10-19T15:00:00Z' },
    { order_id: 'b1', symbol: P, side: 'buy', qty: '1', price: '0.45', transaction_time: '2026-10-30T15:00:00Z' },
    { order_id: 's2', symbol: C, side: 'sell', qty: '1', price: '0.60', transaction_time: '2026-11-23T15:00:00Z' }], [], [{ sym: C, t: '2026-12-18T21:00:00Z', why: 'expired' }]);
  const tp = j.closed.find(c => c.sym === P), ex = j.closed.find(c => c.sym === C);
  assert.equal(tp.pl, 45); assert.equal(tp.short, true); assert.equal(tp.wheel, true); assert.equal(tp.inPx, 0.9); assert.equal(tp.outPx, 0.45); assert.equal(tp.plPct, 50);
  assert.equal(ex.pl, 60); assert.equal(ex.why, 'expired'); assert.equal(ex.outPx, 0);
  const o = buildJournal([{ order_id: 's1', symbol: P, side: 'sell', qty: '1', price: '0.90', transaction_time: '2026-10-19T15:00:00Z' }], [{ symbol: P, qty: '-1', avg_entry_price: '0.9', current_price: '0.5', unrealized_pl: '40', unrealized_plpc: '0.444' }]).open[0];
  assert.equal(o.short, true); assert.equal(o.since, '2026-10-19T15:00:00Z'); assert.equal(o.qty, -1);
  const st = buildJournal([{ order_id: 'x', symbol: 'AAPL', side: 'sell', qty: '3', price: '263', transaction_time: '2026-10-21T17:00:00Z' }], []);
  assert.equal(st.closed.length, 0, 'a stock sale with no buy in the fills is still a gap, never a short');
});
test('assignment: the put closes at 0 and its shares come in at the strike (OPTRD); called away later, they go at the call strike', () => {
  const P = 'KO261120P00065000', C = 'KO261218C00068000';
  const ev = optionEvents([
    { activity_type: 'OPASN', symbol: P, qty: '1', date: '2026-11-20', id: 'n1' }, { activity_type: 'OPTRD', symbol: 'KO', qty: '100', price: '90', net_amount: '-6500', date: '2026-11-20', id: 'n2' },
    { activity_type: 'OPASN', symbol: C, qty: '1', date: '2026-12-18', id: 'n3' }, { activity_type: 'OPTRD', symbol: 'KO', qty: '-100', price: '68', date: '2026-12-18', id: 'n4' }]);
  assert.equal(ev.fills.length, 2); assert.equal(ev.events.length, 2); assert.equal(ev.fills[0].side, 'buy'); assert.equal(ev.fills[1].side, 'sell');
  const j = buildJournal([
    { order_id: 's1', symbol: P, side: 'sell', qty: '1', price: '0.90', transaction_time: '2026-10-19T15:00:00Z' },
    { order_id: 's2', symbol: C, side: 'sell', qty: '1', price: '0.60', transaction_time: '2026-11-23T15:00:00Z' }].concat(ev.fills), [], ev.events);
  assert.equal(j.closed.find(c => c.sym === P).pl, 90); assert.equal(j.closed.find(c => c.sym === P).why, 'assigned');
  assert.equal(j.closed.find(c => c.sym === C).pl, 60);
  const sh = j.closed.find(c => c.sym === 'KO'); assert.equal(sh.pl, 300); assert.equal(sh.wheel, true); assert.equal(sh.inPx, 65); assert.equal(sh.outPx, 68);
});
test('sold options: a sale filled in pieces with its buy-back filling between them is still one sold lot (ordered by first fill)', () => {
  const C = 'KO261218C00068000';
  const j = buildJournal([
    { order_id: 's1', symbol: C, side: 'sell', qty: '1', price: '0.60', transaction_time: '2026-11-23T15:00:00Z' },
    { order_id: 'b1', symbol: C, side: 'buy', qty: '1', price: '0.30', transaction_time: '2026-11-23T15:05:00Z' },
    { order_id: 's1', symbol: C, side: 'sell', qty: '1', price: '0.60', transaction_time: '2026-11-23T15:10:00Z' }], [{ symbol: C, qty: '-1', avg_entry_price: '0.6', current_price: '0.5', unrealized_pl: '10', unrealized_plpc: '0.16' }]);
  assert.equal(j.closed.length, 1); assert.equal(j.closed[0].short, true); assert.equal(j.closed[0].pl, 30); assert.equal(j.closed[0].outT, '2026-11-23T15:05:00Z');
});
test('day P/L by part: the wheel\'s sold option and its buy-back count for the wheel, held from yesterday it is a negative holding', () => {
  const P = 'KO261120P00065000', w = s => s === P || s === 'KO';
  const d1 = sideDayPl({ positions: [{ symbol: P, qty: '-1', current_price: '0.70', lastday_price: '0.90' }], fills: [], wheel: w });
  assert.equal(d1.wheel, 20); assert.equal(d1.put, 0);
  const d2 = sideDayPl({ positions: [], fills: [{ symbol: P, side: 'buy', qty: '1', price: '0.45' }], lastDay: { [P]: 0.6 }, wheel: w });
  assert.equal(d2.wheel, 15, 'bought back at 0.45 after closing at 0.60 yesterday: +$15 today');
  const d3 = sideDayPl({ positions: [{ symbol: P, qty: '-1', current_price: '0.80' }], fills: [{ symbol: P, side: 'sell', qty: '1', price: '0.90' }], wheel: w });
  assert.equal(d3.wheel, 10, 'sold today at 0.90, worth 0.80 now');
  const d4 = sideDayPl({ positions: [{ symbol: 'AAPL', qty: '3', current_price: '10' }], fills: [{ symbol: 'AAPL', side: 'buy', qty: '5', price: '9' }] });
  assert.equal(d4.stock, -15, 'a gap in the fills (more bought than held) is still read as nothing held yesterday for other symbols');
});

console.log('News & events guard');
const ev = [{ date: '2026-10-28', time: '14:00', type: 'FOMC', title: 'Fed' }, { date: '2026-11-10', time: '08:30', type: 'CPI', title: 'CPI' }];
test('FOMC: blocked 1:30-3:00pm, no options, half size', () => { const g = guard({ events: ev, todayDash: '2026-10-28', mins: 13 * 60 + 40 }); assert.equal(g.block, true); assert.equal(g.noOptions, true); assert.equal(g.budget, 0.5); });
test('FOMC morning: not blocked', () => { assert.equal(guard({ events: ev, todayDash: '2026-10-28', mins: 10 * 60 }).block, false); });
test('CPI: entries wait until 10:15', () => { assert.equal(guard({ events: ev, todayDash: '2026-11-10', mins: 600 }).minStart, 615); });
test('war headline pauses trading', () => { const now = Date.now(); assert.equal(guard({ events: [], todayDash: '2026-10-22', mins: 660, nowMs: now, headlines: [{ headline: 'Missile strikes escalate conflict', created_at: new Date(now - 5 * 60000).toISOString() }] }).block, true); });
test('ordinary headline does not pause', () => { const now = Date.now(); assert.equal(guard({ events: [], todayDash: '2026-10-22', mins: 660, nowMs: now, headlines: [{ headline: 'Apple unveils new MacBook', created_at: new Date(now - 5 * 60000).toISOString() }] }).block, false); });
test('earnings news makes a stock skip', () => { assert.match(symbolRisk('NVDA', [{ symbols: ['NVDA'], headline: 'Nvidia to report Q3 results', created_at: new Date(Date.now() - 3600e3).toISOString() }]), /earnings/); });
test('keyword classifier', () => { assert.deepEqual(classify('White House announces new tariffs'), ['policy']); });

console.log('Headline relevance');
test('drops unrelated stories', () => { assert.equal(relevant({ h: 'SpaceX shares soar' }, keysFor('MSFT', 'Microsoft Corporation')), false); });
test('keeps company stories and aliases', () => { assert.equal(relevant({ h: 'Microsoft cloud beats' }, keysFor('MSFT', 'Microsoft Corporation')), true); assert.equal(relevant({ h: 'Facebook parent fined' }, keysFor('META', 'Meta Platforms, Inc.')), true); });
test('drops industry-report spam', () => { assert.equal(relevant({ h: 'Global Market Report 2026-2030 | IBM, TCS' }, keysFor('TCS.NS', 'Tata Consultancy Services Limited')), false); });
test('RSS parsing decodes entities and tags', () => { const x = parseRss('<item><title>A &amp; B</title><link>u</link><pubDate>Wed, 21 Oct 2026 18:30:00 GMT</pubDate><description>&lt;p&gt;Hi&lt;/p&gt;</description></item>', 'S'); assert.equal(x[0].h, 'A & B'); assert.equal(x[0].sum, 'Hi'); });

console.log('News classifier');
test('a war mentioned only in the summary does not pause the market', () => {
  const g = guard({ events: [], todayDash: '2026-10-22', mins: 11 * 60 + 33, spyPct: -1.2,
    headlines: [{ headline: 'EIF Guarantee Enables EUR 143 Million in ProCredit Lending to Ukrainian SMEs', summary: 'supports small businesses hurt by the war in Ukraine', created_at: new Date().toISOString() }] });
  assert.equal(g.block, false);
  const g2 = guard({ events: [], todayDash: '2026-10-22', mins: 11 * 60 + 33, spyPct: -1.2,
    headlines: [{ headline: 'Russia launches missile attack on Kyiv', summary: '', created_at: new Date().toISOString() }] });
  assert.equal(g2.block, true);
});
test('defense contracts and power news are not war news', () => {
  assert.equal(classify("Denmark Plans Procurement of Kongsberg's Joint Strike Missile").length, 0);
  assert.equal(classify('Utility signs nuclear power plant supply deal').length, 0);
  assert.equal(classify('Troops training exercise contract awarded to Lockheed').length, 0);
  assert.ok(classify('Missile strike hits Kyiv overnight').includes('war'));
  assert.ok(classify('Missiles fired at tanker in the Red Sea').includes('war'));
  assert.ok(classify('Airstrikes reported near the border').includes('war'));
});
test('the defense department\'s name ("Department of War", since 2025) is not war news; war itself still is', () => {
  assert.equal(classify("Appian's Defense Cloud Achieves Impact Level 5 Provisional Authorization To Operate From U.S. Department Of War").length, 0);
  assert.equal(classify('War Department awards $2B radar contract to Raytheon').length, 0);
  assert.ok(classify('QatarEnergy CEO Says Two LNG Trains Damaged In Iranian Attacks; Iran war escalates').includes('war'));
  assert.ok(classify('Department of War confirms troops deployed after the invasion').includes('war'), 'other war words still count');
  const g = guard({ events: [], todayDash: '2026-10-29', mins: 11 * 60 + 3, headlines: [{ headline: "Appian's Defense Cloud Achieves Impact Level 5 Provisional Authorization To Operate From U.S. Department Of War", created_at: new Date().toISOString() }] });
  assert.equal(g.block, false);
});
test('PUT rule is the mirror of the dip rule', () => {
  const mk = (start, end, tail) => { const c = []; for (let i = 0; i < 298; i++) c.push(start + (end - start) * i / 297); for (const g of tail) c.push(c[c.length - 1] * (1 + g)); return c; };
  const bars = c => c.map(x => ({ o: x, h: x * 1.004, l: x * 0.996, c: x }));
  const pop = mk(120, 80, [0.04, 0.04]), dip = mk(80, 120, [-0.04, -0.04]);
  assert.ok(rsi2ShortSignal(bars(pop), pop, pop.length - 1, 10), 'downtrend + sharp pop = put candidate');
  assert.equal(rsi2ShortSignal(bars(dip), dip, dip.length - 1, 10), null, 'an uptrend dip is not a put');
  assert.equal(rsi2Signal(bars(pop), pop, pop.length - 1, 10), null, 'a pop is not a call');
  assert.ok(rsi2ShortSignal(bars(pop), pop, pop.length - 1, 1), 'a perfect pop (RSI-2 100) still passes a strict threshold of 1');
  assert.equal(rsi2ShortSignal(bars(pop), pop, pop.length - 1, 0), null, 'threshold 0 can never be met');
  assert.equal(rsi2ShortSignal(bars(pop.slice(0, 150)), pop.slice(0, 150), 149, 10), null, 'needs 200 days of history');
});
test('PUT exit: below the 5-day average, or after max hold', () => {
  assert.equal(rsi2ShortExit([100, 101, 102, 103], 90, 2, 10).exit, true);
  assert.equal(rsi2ShortExit([100, 101, 102, 103], 110, 2, 10).exit, false);
  assert.equal(rsi2ShortExit([100, 101, 102, 103], 110, 10, 10).exit, true);
});
test('puts switch is OFF unless explicitly ticked', () => {
  assert.equal(normalize(null).puts, false);
  assert.equal(normalize({}).puts, false);
  assert.equal(normalize({ puts: 'yes' }).puts, false);
  assert.equal(normalize({ puts: true }).puts, true);
});

test('keywords match whole words only', () => {
  assert.equal(classify('Stewart Information Servs Q3 Earnings Call Transcript').length, 0);
  assert.equal(classify('Upgrade Legacy Applications, Software Delivery').length, 0);
  assert.equal(classify('Warner Bros opens a warehouse').length, 0);
  assert.equal(classify("Agrees With Warning About 'Massive War Chest' for Democrats").length, 0);
  assert.equal(classify('Streaming wars heat up as bidding war for rights ends').length, 0);
  assert.ok(classify('Trade war tariffs hit stocks').includes('policy'));
  assert.ok(classify('Russia launches a missile attack on Kyiv').includes('war'));
  assert.ok(classify('Escalating airstrikes reported').includes('war'));
  assert.ok(classify('White House announces new tariffs').includes('policy'));
});
test('one stock halting is not a market crisis', () => {
  const c = classify('POMDOCTOR Shares Halted On Circuit Breaker To The Downside');
  assert.ok(c.includes('single'));
  assert.ok(!c.includes('crisis'));
  assert.ok(classify('Regional bank failure sparks contagion fears').includes('crisis'));
});
test('noise headlines do not pause the bot', () => {
  const g = guard({ events: [], todayDash: '2026-10-22', mins: 585,
    headlines: [{ headline: 'Stewart Information Servs Q3 2026 Earnings Call Transcript', created_at: new Date().toISOString() },
                { headline: 'Tech Mahindra Partners On Software Delivery', created_at: new Date().toISOString() }] });
  assert.equal(g.block, false);
});
test('a real war headline still pauses the bot', () => {
  const g = guard({ events: [], todayDash: '2026-10-22', mins: 585,
    headlines: [{ headline: 'Missile attack on Kyiv escalates', created_at: new Date().toISOString() }] });
  assert.equal(g.block, true);
});
test('money settings: defaults are % of account with no ceiling; units and caps are validated', () => {
  const d = normalize({});
  assert.equal(d.stockUnit, 'pct'); assert.equal(d.putUnit, 'pct'); assert.equal(d.stockCapUsd, 0); assert.equal(d.callCapPct, 0);
  const c = normalize({ stockUnit: 'usd', stockUsd: 2500, callUnit: 'bogus', putCapPct: 500, putCapUsd: -5 });
  assert.equal(c.stockUnit, 'usd'); assert.equal(c.stockUsd, 2500); assert.equal(c.callUnit, 'pct');
  assert.equal(c.putCapPct, 100); assert.equal(c.putCapUsd, 0);
});

// ---- broker HTTP wrapper: deadline, bounded retry, never retry an order ----
{
  process.env.HTTP_TIMEOUT_MS = '400';
  const { httpCall } = await import('./bot.mjs');
  let hits = {};
  const srv = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    if (req.url === '/flaky') { if (hits[req.url] < 3) { res.statusCode = 503; return res.end('busy'); } return res.end('{"ok":1}'); }
    if (req.url === '/hang') return;                                                          // never answers
    if (req.url === '/bad') { res.statusCode = 422; return res.end('nope'); }
    if (req.url === '/order') { res.statusCode = 500; return res.end('boom'); }
    res.end('{}');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const atest = async (name, fn) => { try { await fn(); console.log('  \u2713', name); passed++; } catch (e) { console.log('  \u2717', name, '\n   ', e.message); failed++; } };
  await atest('HTTP: a read that fails twice with 503 is retried and succeeds', async () => { assert.deepEqual(await httpCall(base, '/flaky'), { ok: 1 }); assert.equal(hits['/flaky'], 3); });
  await atest('HTTP: a request that never answers times out instead of hanging the bot', async () => { const t0 = Date.now(); await assert.rejects(httpCall(base, '/hang'), /timed out/); assert.ok(Date.now() - t0 < 20000); });
  await atest('HTTP: a 4xx is reported at once, not retried', async () => { await assert.rejects(httpCall(base, '/bad'), /HTTP 422/); assert.equal(hits['/bad'], 1); });
  await atest('HTTP: an order (POST) is never retried', async () => { await assert.rejects(httpCall(base, '/order', { method: 'POST', body: '{}' }), /HTTP 500/); assert.equal(hits['/order'], 1); });
  srv.close();
  // ---- journal encryption: what the bot writes, the bot (at its next start) and the page can read back ----
  const { encryptJournal, decryptJournal } = await import('./bot.mjs');
  const { parseCommand } = await import('./telegram.mjs');
  await atest('telegram: commands are parsed with or without the @botname, any case; plain text is not a command', async () => {
    assert.deepEqual(parseCommand('/money'), { cmd: 'money', args: [] }); assert.deepEqual(parseCommand(' /Status@SignalDeskBot now'), { cmd: 'status', args: ['now'] });
    assert.equal(parseCommand('buy AAPL'), null); assert.equal(parseCommand(''), null);
  });
  await atest('journal crypto: encrypt → decrypt round trip; the blob records its own round count; a wrong passphrase is rejected', async () => {
    const body = { at: '2026-10-22T20:03:31Z', watch: { rows: [{ s: 'AAPL', r2: 4.2 }], buy: ['AAPL'] }, acts: [{ t: 't1', m: 'hello' }] };
    const blob = await encryptJournal(body, 'correct horse', 1000);
    assert.equal(blob.enc, 1); assert.equal(blob.iter, 1000); assert.ok(!JSON.stringify(blob).includes('AAPL'), 'plaintext leaked into the blob');
    assert.deepEqual(await decryptJournal(blob, 'correct horse'), body);
    await assert.rejects(decryptJournal(blob, 'wrong'));
  });
}
test('market scan ranking: by average dollar volume, minimum price, top N', () => {
  const bar = (c, v) => Array.from({ length: 20 }, () => ({ c, v }));
  const top = rankByLiquidity({ BIG: bar(100, 1e6), MID: bar(50, 1e6), SMALL: bar(10, 1e6), PENNY: bar(2, 1e9), SHORT: [{ c: 100, v: 1e9 }] }, { size: 2, minPrice: 5 });
  assert.deepEqual(top.map(r => r.sym), ['BIG', 'MID']);
  assert.equal(normalize({ universe: 'scan', scanSize: 9999 }).scanSize, 400); assert.equal(normalize({ universe: 'nope' }).universe, 'list');
});
test('trigger prices: the close that makes RSI-2 cross the buy / put level, and the exit level', () => {
  const up = [100, 101, 102, 103, 104, 105, 106];
  const buyAt = rsi2Trigger(up, 10, 'long');
  assert.ok(buyAt < 106 && rsi2(up.concat([buyAt - 0.01])) < 10 && rsi2(up.concat([buyAt + 0.05])) >= 10, 'buy level ' + buyAt);
  const putAt = rsi2Trigger(up, 10, 'short');
  assert.ok(rsi2(up.concat([putAt + 0.01])) > 90 && rsi2(up.concat([putAt - 0.05])) <= 90, 'put level ' + putAt);
  assert.equal(rsi2Trigger([100, 120], 10, 'long'), null);                     // would need more than a 50% drop
  assert.equal(rsi2ExitLevel([1, 2, 3, 10, 20, 30, 40]), 25);                 // average of the last 4 closes
  const ex = rsi2Exit([10, 20, 30, 40], 25.01, 1); assert.equal(ex.exit, true); assert.equal(rsi2Exit([10, 20, 30, 40], 24.99, 1).exit, false);
});

// ---- day trading ----
{
  // 5-minute bars from 9:30: a flat opening range 100–101, then a breakout to 102 on heavy volume
  const bar = (m, o, h, l, c, v) => ({ t: 'x', m, o, h, l, c, v });
  const orb = [bar(570, 100.2, 101, 100, 100.6, 60000), bar(575, 100.6, 100.9, 100.1, 100.4, 50000), bar(580, 100.4, 100.8, 100.2, 100.7, 50000),
    bar(585, 100.7, 100.95, 100.5, 100.9, 55000), bar(590, 100.9, 101.6, 100.8, 101.5, 90000)];
  test('day trading: VWAP, ATR and the opening range come out right', () => {
    const or = openingRange(orb, 15); assert.deepEqual(or, { high: 101, low: 100 });
    assert.ok(Math.abs(vwap(orb) - 100.76) < 0.1, 'vwap ' + vwap(orb)); assert.ok(atr(orb) > 0.5 && atr(orb) < 1.2, 'atr ' + atr(orb));
    assert.equal(openingRange(orb.slice(0, 2), 15), null);                                 // range not complete yet
    assert.ok(relVolume(orb, 1e6, 595) > 1.5, 'rvol ' + relVolume(orb, 1e6, 595));
  });
  test('day trading: ORB long fires only with the market up and after 9:45; stop under the range, target 2R', () => {
    const sg = daySetup({ bars: orb, px: 101.55, mins: 595, avgDailyVol: 1e6, market: 'up', cfg: {} });
    assert.ok(sg && sg.side === 'long' && sg.setup === 'ORB', JSON.stringify(sg));
    assert.ok(sg.stop < 101 && sg.stop >= 99.5, 'stop ' + sg.stop); assert.ok(Math.abs((sg.target - sg.entry) - 2 * (sg.entry - sg.stop)) < 0.02, 'target is 2R');
    assert.equal(daySetup({ bars: orb, px: 101.55, mins: 595, avgDailyVol: 1e6, market: 'down', cfg: {} }), null);   // market down: no longs
    assert.equal(daySetup({ bars: orb, px: 101.55, mins: 580, avgDailyVol: 1e6, market: 'up', cfg: {} }), null);     // before 9:45
    assert.equal(daySetup({ bars: orb, px: 101.55, mins: 595, avgDailyVol: 5e7, market: 'up', cfg: {} }), null);     // volume too light for this stock
  });
  test('day trading: ORB short is the mirror and becomes a PUT candidate', () => {
    const brk = orb.map(b => ({ ...b, o: 201 - b.o + 100, h: 201 - b.l + 100, l: 201 - b.h + 100, c: 201 - b.c + 100 }));   // flip around 100.5 → breakdown
    const sg = daySetup({ bars: brk, px: 99.45, mins: 595, avgDailyVol: 1e6, market: 'down', cfg: {} });
    assert.ok(sg && sg.side === 'short' && sg.setup === 'ORB', JSON.stringify(sg)); assert.ok(sg.stop > 100 && sg.target < sg.entry);
  });
  test('day trading: VWAP pullback long after a trend day', () => {
    const b = [];
    for (let i = 0; i < 12; i++) b.push(bar(570 + i * 5, 100 + i * 0.3, 100.4 + i * 0.3, 99.9 + i * 0.3, 100.3 + i * 0.3, 40000));
    const vw = vwap(b);
    b.push(bar(630, 103.4, 103.5, vw - 0.02, vw + 0.05, 40000));                            // dips to VWAP
    b.push(bar(635, vw + 0.05, 103.8, vw, 103.7, 60000));                                    // turns back up, above the dip bar's high
    const sg = daySetup({ bars: b, px: 103.75, mins: 640, avgDailyVol: 1e6, market: 'up', cfg: {} });
    assert.ok(sg && sg.setup === 'VWAP' && sg.side === 'long', JSON.stringify(sg)); assert.ok(sg.stop < vw);
  });
  test('day trading: market mode from SPY vs its VWAP', () => {
    const spy = [bar(570, 500, 501, 499, 500.5, 1e6), bar(575, 500.5, 501, 500, 500.8, 1e6), bar(580, 500.8, 501.5, 500.5, 501.2, 1e6)];
    assert.equal(marketMode(spy, 502), 'up'); assert.equal(marketMode(spy, 499), 'down'); assert.equal(marketMode(spy, vwap(spy)), 'flat');
  });
  test('day trading: sizing by risk, exits by stop / target / time / flat, breakeven trail at 1R', () => {
    assert.equal(dayShares({ equity: 100000, riskPct: 0.5, entry: 101.5, stop: 100.5, budget: 10000 }), 98);       // $500 risk / $1 = 500, capped by $10k budget → 98
    const pos = { side: 'long', entry: 101.5, stop: 100.5, target: 103.5, openedMins: 600 };
    assert.equal(dayExit({ pos, px: 100.4, mins: 620, cfg: {} }).kind, 'stop');
    assert.equal(dayExit({ pos, px: 103.6, mins: 620, cfg: {} }).kind, 'target');
    assert.equal(dayExit({ pos, px: 101.6, mins: 670, cfg: {} }).kind, 'time');              // 70 min, up only 0.1R
    assert.equal(dayExit({ pos, px: 102.0, mins: 951, cfg: {} }).kind, 'flat');
    assert.equal(dayExit({ pos, px: 102.0, mins: 640, cfg: {} }), null);
    assert.equal(dayTrail({ pos, px: 102.4 }), null); assert.deepEqual(dayTrail({ pos, px: 102.5 }).stop, 101.5);
    const sh = { side: 'short', entry: 99.5, stop: 100.5, target: 97.5, openedMins: 600 };
    assert.equal(dayExit({ pos: sh, px: 100.6, mins: 620, cfg: {} }).kind, 'stop'); assert.equal(dayExit({ pos: sh, px: 97.4, mins: 620, cfg: {} }).kind, 'target');
  });
  test('day trading: the order id carries entry, stop, target, day and time', () => {
    const id = encodeDayId('sd-dp-', 'AAPL261024P00230000', 229.5, 231.2, 226.1, '20261022', 612, 'ab1');
    assert.deepEqual(decodeDayId(id), { kind: 'dp', sym: 'AAPL261024P00230000', entry: 229.5, stop: 231.2, target: 226.1, day8: '20261022', openMins: 612, side: 'short' });
    assert.equal(decodeDayId('sd-r-AAPL-100-20261022-xx'), null);
  });
}

test('day-trading research: replays the live rules over synthetic sessions and scores them', () => {
  // 30 sessions of a stock that breaks out of a flat 15-minute range at 9:50 and runs to the target; SPY trends up all day
  const mk = (d, run) => { const out = []; let px = 100; for (let m = 570; m < 960; m += 5) { const i = (m - 570) / 5; let o = px, c; if (i < 3) c = 100.5 + (i % 2 ? -0.3 : 0.3); else c = 100.5 + run * (i - 2) * 0.12; out.push({ m, o, h: Math.max(o, c) + 0.1, l: Math.min(o, c) - 0.1, c, v: 60000 }); px = c; } return out; };
  const sessions = new Map(), spy = new Map();
  for (let k = 1; k <= 30; k++) { const d = '2025-01-' + String(k).padStart(2, '0'); sessions.set(d, mk(d, k % 5 === 0 ? -1 : 1)); spy.set(d, mk(d, k % 5 === 0 ? -1 : 1).map(b => ({ ...b, o: b.o * 5, h: b.h * 5, l: b.l * 5, c: b.c * 5, v: 1e6 }))); }
  const sig = collectSignals('TST', sessions, spy);
  assert.ok(sig.some(x => x.setup === 'ORB' && x.side === 'long'), 'ORB longs recorded');
  const S = evaluate(sig, new Map([['TST', sessions]]), { orMin: 15, rvol: 0.5, target: 2, timeStop: 60, start: 585, end: 930, maxTrades: 3, streak: 2, filter: true, setups: 'both', sides: 'both' });
  assert.ok(S.n >= 20 && S.n <= 30, 'one trade per day: ' + S.n);
  assert.ok(S.winRate > 60 && S.avgR > 0.5, JSON.stringify({ n: S.n, win: S.winRate, avgR: S.avgR, exits: S.byExit }));
  assert.ok(S.years['2025'] && S.years['2025'].n === S.n);
});
test('swing entry window: any end time from 10:00 to 15:45 ET is kept (15:30 used to fall back to 11:00 silently)', () => {
  assert.equal(normalize({ entryEnd: '15:30' }).entryEnd, '15:30'); assert.equal(normalize({ entryEnd: '15:45' }).entryEnd, '15:45');
  assert.equal(normalize({ entryEnd: '16:00' }).entryEnd, '11:00'); assert.equal(normalize({ entryEnd: '09:50' }).entryEnd, '11:00');
});
test('stake setting: validated, 0 means the whole account', () => { assert.equal(normalize({ stakeUsd: 5000 }).stakeUsd, 5000); assert.equal(normalize({ stakeUsd: -3 }).stakeUsd, 0); assert.equal(normalize({}).stakeUsd, 0); });

test('money split: settings default to 60/30/10 (stocks/CALLs/PUTs) with their own loss limits, and are validated', () => {
  const c = normalize({}); assert.equal(c.split, true); assert.equal(c.callSharePct, 30); assert.equal(c.putSharePct, 10); assert.equal(c.optDayCap, 10);
  const d = normalize({ preset: 'custom', split: false, callSharePct: 150, putSharePct: 5, optDayCap: 0 }); assert.equal(d.split, false); assert.equal(d.callSharePct, 100); assert.equal(d.putSharePct, 0, 'shares capped at the whole stake'); assert.equal(d.optDayCap, 1);
  const e = normalize({ callSharePct: 70, putSharePct: 50 }); assert.equal(e.callSharePct + e.putSharePct, 100);
  assert.equal(normalize({ split: 'yes' }).split, true, 'a non-boolean is ignored');
});
test('money split: today\'s P/L per side counts overnight holdings from yesterday\'s close', () => {
  const r = sideDayPl({ positions: [{ symbol: 'AAA', qty: '10', current_price: '105', lastday_price: '100' }] });
  assert.equal(r.stock, 50); assert.equal(r.opt, 0);
});
test('money split: a buy made today counts from its fill price, not from yesterday', () => {
  const r = sideDayPl({ positions: [{ symbol: 'AAA', qty: '10', current_price: '103', lastday_price: '99' }], fills: [{ symbol: 'AAA', side: 'buy', qty: '10', price: '100' }] });
  assert.equal(r.stock, 30);
});
test('money split: a position sold out today counts against yesterday\'s close the bot remembered', () => {
  assert.equal(sideDayPl({ fills: [{ symbol: 'AAA', side: 'sell', qty: '10', price: '95' }], lastDay: { AAA: 100 } }).stock, -50);
  assert.equal(sideDayPl({ fills: [{ symbol: 'AAA', side: 'sell', qty: '10', price: '95' }] }).stock, 0, 'unknown close: counted at the sale price, not as a $950 gain');
});
test('money split: CALLs and PUTs land on their own parts, priced per contract (x100)', () => {
  const r = sideDayPl({ positions: [{ symbol: 'AAA261113C00100000', qty: '2', current_price: '3', lastday_price: '4' }, { symbol: 'BBB', qty: '1', current_price: '50', lastday_price: '50' }],
    fills: [{ symbol: 'CCC261113P00050000', side: 'buy', qty: '1', price: '2' }, { symbol: 'CCC261113P00050000', side: 'sell', qty: '1', price: '2.5' }] });
  assert.equal(r.call, -200); assert.equal(r.put, 50); assert.equal(r.opt, -150); assert.equal(r.stock, 0);
});
test('money split: a partial sale of an overnight holding', () => {
  const r = sideDayPl({ positions: [{ symbol: 'AAA', qty: '6', current_price: '110', lastday_price: '100' }], fills: [{ symbol: 'AAA', side: 'sell', qty: '4', price: '105' }] });
  assert.equal(r.stock, 6 * 10 + 4 * 5);
});

test('quick exits: the tighter exit settings are accepted and validated', () => {
  const c = normalize({ preset: 'custom', stockTp: 10, holdFloor: 5, optTakeProfit: 20, optStop: 10 }); assert.deepEqual([c.stockTp, c.holdFloor, c.optTakeProfit, c.optStop], [10, 5, 20, 10]);
  const d = normalize({ preset: 'custom', stockTp: -1, holdFloor: 0.5, optTakeProfit: 1, optStop: 1 }); assert.deepEqual([d.stockTp, d.holdFloor, d.optTakeProfit, d.optStop], [0, 2, 5, 5]);
  assert.equal(normalize({}).stockTp, 10, 'the research-backed default'); assert.equal(normalize({ stockTp: 0 }).stockTp, 0, '0 turns it off');
});
test('leaders first: the setting defaults to leaders and accepts only leaders or dip', () => { assert.equal(normalize({}).pickBy, 'leaders'); assert.equal(normalize({ pickBy: 'dip' }).pickBy, 'dip'); assert.equal(normalize({ pickBy: 'x' }).pickBy, 'leaders'); });
test('SPY sleeve: settings default to on, 5%, +15/−15, 10 min, 6 trades, 2 losses, 25% day cap, next-day expiry — and are validated', () => {
  const c = normalize({}); assert.deepEqual([c.spyOn, c.spySharePct, c.spyTp, c.spyStop, c.spyHoldMin, c.spyMaxTrades, c.spyStreak, c.spyDayCap, c.spyDte], [true, 5, 15, 15, 10, 6, 2, 25, 1]);
  const d = normalize({ preset: 'custom', spySharePct: 80, spyDte: 0, spyHoldMin: 1, spyStart: '09:30', spyEnd: '15:59' }); assert.equal(d.spySharePct, 50); assert.equal(d.spyDte, 0, 'same-day allowed since 2026-10-30'); assert.equal(d.spyHoldMin, 2); assert.equal(d.spyStart, '09:50'); assert.equal(d.spyEnd, '15:30');
  const e = normalize({ preset: 'custom', callSharePct: 60, putSharePct: 35, spySharePct: 20 }); assert.equal(e.spySharePct, 5, 'the SPY share is cut so the four shares fit the stake');
});
const b5 = (m, o, h, l, c, v = 1e6) => ({ m, o, h, l, c, v });
const up = [b5(570, 500, 501, 499.5, 500.6), b5(575, 500.6, 501.2, 500.4, 501), b5(580, 501, 501.8, 500.9, 501.6), b5(585, 501.6, 502, 501.4, 501.9), b5(590, 501.9, 502.5, 501.8, 502.3, 1.2e6)];
test('SPY sleeve: a break above the 15-minute high with SPY above VWAP is a CALL signal; no break = waiting; flat on VWAP = nothing', () => {
  const s = spySignal({ bars: up, px: 502.7, mins: 600 }); assert.equal(s.side, 'call'); assert.equal(s.market, 'up'); assert.equal(s.level, 502.5);
  assert.match(spySignal({ bars: up, px: 502.2, mins: 600 }).idle, /waiting for a break above 502\.5/);
  assert.match(spySignal({ bars: up, px: 501.25, mins: 600 }).idle, /VWAP/);
});
test('SPY sleeve: the mirror is a PUT; a quiet last bar (below-average volume) does not trigger', () => {
  const dn = up.map(b => ({ ...b, o: 1000 - b.o, h: 1000 - b.l, l: 1000 - b.h, c: 1000 - b.c })); assert.equal(spySignal({ bars: dn, px: 497.3, mins: 600 }).side, 'put');
  const quiet = up.map((b, i) => i === 4 ? { ...b, v: 5e5 } : b); assert.equal(spySignal({ bars: quiet, px: 502.7, mins: 600 }).side, undefined);
});
test('SPY sleeve: outside the window it stays out; bars still forming are not used', () => {
  assert.match(spySignal({ bars: up, px: 502.7, mins: 585 }).idle, /before the window/); assert.match(spySignal({ bars: up, px: 502.7, mins: 931 }).idle, /closed/);
  const early = spySignal({ bars: up, px: 502.7, mins: 592 }); assert.equal(early.level, 502, 'the 9:50 bar is not complete at 9:52, so the level is the earlier 15-minute high'); assert.equal(early.side, 'call');
});
test('SPY sleeve: exits — +15% take-profit, −15% stop, 10-minute time stop, flat at 3:45, otherwise hold', () => {
  assert.equal(spyExit({ entryPx: 2, optPx: 2.3, openedMins: 600, mins: 603 }).kind, 'tp'); assert.equal(spyExit({ entryPx: 2, optPx: 1.7, openedMins: 600, mins: 603 }).kind, 'stop');
  assert.equal(spyExit({ entryPx: 2, optPx: 2.05, openedMins: 600, mins: 610 }).kind, 'time'); assert.equal(spyExit({ entryPx: 2, optPx: 2.05, openedMins: 940, mins: 945 }).kind, 'flat');
  assert.equal(spyExit({ entryPx: 2, optPx: 2.05, openedMins: 600, mins: 605 }), null); assert.equal(spyExit({ entryPx: 2, optPx: 2.5, openedMins: 600, mins: 603, cfg: { spyTp: 30 } }), null);
});
test('SPY sleeve: order ids round-trip and SPY options are recognised', () => {
  const id = encodeSpyId('put', 'SPY261024P00502000', 2.05, '20261023', 600, 'abc'); const d = decodeSpyId(id); assert.deepEqual(d, { kind: 'put', sym: 'SPY261024P00502000', entry: 2.05, day8: '20261023', openMins: 600 });
  assert.ok(isSpyOption('SPY261024C00502000')); assert.ok(!isSpyOption('AAPL261024C00200000')); assert.ok(!isSpyOption('SPY'));
});

test('msgpack: an Alpaca option quote frame decodes (reference bytes from the Python msgpack library)', () => {
  const ref = Buffer.from('918aa154a171a153b2535059323631303237433030363834303030a26278a143a26270cb4000666666666666a2627378a26178a14ea26170cb40008f5c28f5c28fa2617350a163a141a174d7ff1d6f345468fb4e20', 'hex');
  const q = mpDecode(ref)[0]; assert.equal(q.T, 'q'); assert.equal(q.S, 'SPY261027C00684000'); assert.equal(q.bp, 2.05); assert.equal(q.ap, 2.07); assert.equal(q.bs, 120); assert.equal(q.as, 80); assert.match(q.t, /^2025-10-24T10:00:00/);
});
test('msgpack: every type round-trips (ints of all sizes, negatives, floats, long strings, arrays, maps, nil, booleans)', () => {
  const v = { nil: null, t: true, f: false, small: 5, neg: -3, u8: 200, u16: 60000, u32: 4000000000, i8: -100, i16: -30000, i32: -2000000000, big: 2 ** 40, flt: 3.25, str: 'héllo', long: 'x'.repeat(300), arr: Array.from({ length: 20 }, (_, i) => i), nested: { a: [1, { b: 'c' }] } };
  assert.deepEqual(mpDecode(mpEncode(v)), v);
  assert.deepEqual(mpDecode(mpEncode({ action: 'subscribe', quotes: ['SPY261027C00684000'] })), { action: 'subscribe', quotes: ['SPY261027C00684000'] });
});

test('SPY money per trade: defaults to 100% and is kept between 10% and 100%', () => { assert.equal(normalize({}).spyTradePct, 100); assert.equal(normalize({ preset: 'custom', spyTradePct: 50 }).spyTradePct, 50); assert.equal(normalize({ preset: 'custom', spyTradePct: 5 }).spyTradePct, 10); assert.equal(normalize({ preset: 'custom', spyTradePct: 150 }).spyTradePct, 100); });
test('news: short or word-like tickers need $AI or (AI); company words match whole words only', () => {
  const ai = keysFor('AI', 'C3.ai, Inc.'), f = keysFor('F', 'Ford Motor Company');
  assert.equal(relevant({ h: 'AI stocks rally on chip news' }, ai), false); assert.equal(relevant({ h: 'C3.ai jumps after earnings' }, ai), true);
  assert.equal(relevant({ h: 'How to afford a home in 2026' }, f), false); assert.equal(relevant({ h: 'Ford recalls trucks' }, f), true);
});
test('scan: ETFs, leveraged funds and Arca listings are not stocks', () => {
  const a = (name, exchange = 'NYSE', symbol = 'ABC') => isStockAsset({ tradable: true, exchange, symbol, name });
  assert.equal(a('Apple Inc. Common Stock', 'NASDAQ', 'AAPL'), true); assert.equal(a('Northern Trust Corporation', 'NASDAQ', 'NTRS'), true);
  assert.equal(a('SPDR S&P 500 ETF Trust', 'ARCA', 'SPY'), false); assert.equal(a('ProShares UltraPro QQQ', 'NASDAQ', 'TQQQ'), false); assert.equal(a('Direxion Daily Semiconductor Bull 3X Shares', 'NYSE', 'SOXL'), false);
});
test('sectors: the large scanned names have a sector (the per-sector limit covers them)', () => { for (const x of ['MU', 'AVGO', 'LLY', 'CAT', 'NEE', 'GS']) assert.notEqual(sectorOf(x), 'Other', x); });
test('SPY fresh break: first trade of the day goes; another in the same direction needs a level beyond the last', () => { assert.equal(spyFresh('call', 502.5, 0), true); assert.equal(spyFresh('call', 502.5, 502.5), false); assert.equal(spyFresh('call', 503.1, 502.5), true); assert.equal(spyFresh('put', 499, 499.5), true); assert.equal(spyFresh('put', 499.5, 499.5), false); assert.equal(normalize({}).spyMaxOpen, 3); assert.equal(normalize({ preset: 'custom', spyMaxOpen: 9 }).spyMaxOpen, 5); });
test('profit exit: sells at the close once the price is at least the set % above the buy price', () => {
  assert.equal(profitExitLevel(200, 0.5), 201); assert.equal(profitExitLevel(0, 0.5), null);
  assert.equal(profitExit(200, 201, 1, 15, 0.5).exit, true, '+0.5% exactly sells');
  assert.equal(profitExit(200, 200.9, 3, 15, 0.5).exit, false, '+0.45% holds');
  assert.equal(profitExit(200, 200.9, 3, 15, 0.5).level, 201);
  assert.equal(profitExit(200, 180, 3, 15, 0.5).exit, false, 'a loss is held — no 5-day-average exit under this rule');
  assert.equal(profitExit(200, 202, 1, 15, 1).exit, true); assert.equal(profitExit(200, 201.5, 1, 15, 1).exit, false, 'the % is a setting');
});
test('profit exit: after the max hold it sells whatever the price', () => { const x = profitExit(200, 150, 15, 15, 0.5); assert.equal(x.exit, true); assert.match(x.why, /held 15 sessions/); assert.equal(profitExit(200, 150, 14, 15, 0.5).exit, false); });
test('market filter: SPY above / below its 200-day average, unknown with too little history', () => {
  const up = Array.from({ length: 250 }, (_, i) => 400 + i), down = Array.from({ length: 250 }, (_, i) => 650 - i);
  assert.equal(marketAbove200(up).above, true); assert.equal(marketAbove200(down).above, false);
  assert.equal(marketAbove200(up.slice(0, 150)), null); assert.equal(marketAbove200(null), null);
  const m = marketAbove200(down); assert.ok(m.s200 > m.last);
});
test('settings: option sell rule and expiry are validated', () => {
  const d = normalize({}); assert.equal(d.optExit, 'bounce'); assert.equal(d.optDays, 14);
  const c = normalize({ optExit: 'target', optDays: 30 }); assert.equal(c.optExit, 'target'); assert.equal(c.optDays, 30);
  assert.equal(normalize({ optExit: 'moon' }).optExit, 'bounce'); assert.equal(normalize({ optDays: 500 }).optDays, 60); assert.equal(normalize({ optDays: 1 }).optDays, 7);
});
test('settings: sell rule, its profit % and the market filter are validated', () => {
  const d = normalize({}); assert.equal(d.exitRule, 'bounce'); assert.equal(d.exitProfitPct, 0.5); assert.equal(d.marketFilter, false);
  const c = normalize({ exitRule: 'profit', exitProfitPct: 1.5, marketFilter: true }); assert.equal(c.exitRule, 'profit'); assert.equal(c.exitProfitPct, 1.5); assert.equal(c.marketFilter, true);
  assert.equal(normalize({ exitRule: 'moon' }).exitRule, 'bounce', 'an unknown rule falls back to the default');
  assert.equal(normalize({ exitProfitPct: 50 }).exitProfitPct, 5); assert.equal(normalize({ exitProfitPct: 0 }).exitProfitPct, 0.1);
  assert.equal(normalize({ marketFilter: 'yes' }).marketFilter, false, 'a non-boolean is ignored');
});

console.log('Fourth audit (2026-10-27)');
const { tick, tickUp, ownQty, withOpenings } = await import('./bot.mjs');           // pure helpers; imported here, after the HTTP tests set their short deadline
test('take-profit prices round UP to a valid price; ordinary prices round to the nearest', () => {
  const nickel = 'QUIET261113C00105000', dime = 'QUIET261113C00210000', spy = 'SPY261024C00502000';
  assert.equal(tickUp(1.071, nickel), 1.1); assert.equal(tick(1.071, nickel), 1.05);
  assert.equal(tickUp(1.05, nickel), 1.05, 'a price already on the grid stays'); assert.equal(tickUp(6.0000000001, dime), 6, 'float noise does not add a step');
  assert.equal(tickUp(6.01, dime), 6.1); assert.equal(tickUp(2.3575, spy), 2.36); assert.equal(tickUp(100.001), 100.01);
  assert.equal(tickUp(2.99, nickel), 3, 'crossing $3 lands on a price valid in both steps');
});
test('own quantity: the bot\'s buy less every later sale; a later hand position is not the bot\'s; never more than held; never a short', () => {
  const buy = { symbol: 'X', side: 'buy', status: 'filled', qty: '50', filled_at: '2026-10-20T15:00:00Z' };
  const p = q => ({ symbol: 'X', qty: String(q) });
  assert.equal(ownQty(p(50), buy, [buy]), 50);
  const soldAll = { symbol: 'X', side: 'sell', status: 'filled', qty: '50', filled_qty: '50', filled_at: '2026-10-21T19:55:00Z' };
  assert.equal(ownQty(p(30), buy, [soldAll, buy]), 0, 'bought back by hand after the bot sold');
  assert.equal(ownQty(p(70), buy, [buy]), 50, 'the owner added 20');
  const earlier = { ...soldAll, filled_at: '2026-10-19T19:55:00Z' };
  assert.equal(ownQty(p(50), buy, [buy, earlier]), 50, 'a sale before the buy belongs to an older position');
  assert.equal(ownQty(p(20), { ...buy, status: 'canceled', qty: '40', filled_qty: '20' }, []), 20, 'filled in part, then cancelled');
  assert.equal(ownQty(p(-10), buy, [buy]), 0, 'short'); assert.equal(ownQty(p(10), null, []), 0, 'no buy of ours');
  const pieces = { ...buy, submitted_at: '2026-10-20T14:00:00Z', filled_at: '2026-10-20T14:05:00Z' }, early = { ...soldAll, qty: '3', filled_qty: '3', filled_at: '2026-10-20T14:03:00Z' };
  assert.equal(ownQty(p(47), pieces, [pieces, early]), 47, 'a sale while the buy was still filling (from its submission) counts');
});
test('swing trades sold today get their opening buy from the order history (for the streak brake and the day summary)', () => {
  const fills = [{ symbol: 'A', side: 'sell', qty: '10', price: '90', order_id: 's1', transaction_time: '2026-10-23T14:00:00Z' }, { symbol: 'B', side: 'buy', qty: '5', price: '20', order_id: 'b1', transaction_time: '2026-10-23T14:05:00Z' }, { symbol: 'B', side: 'sell', qty: '5', price: '21', order_id: 's2', transaction_time: '2026-10-23T14:10:00Z' }];
  const hist = [{ symbol: 'A', side: 'buy', status: 'filled', qty: '10', filled_qty: '10', filled_avg_price: '100', filled_at: '2026-10-20T15:00:00Z', id: 'o1' }, { symbol: 'A', side: 'buy', status: 'filled', qty: '10', filled_avg_price: '80', filled_at: '2026-10-01T15:00:00Z', id: 'o0' }];
  const all = withOpenings(fills, hist, '2026-10-23'), J = buildJournal(all, []).closed;
  assert.equal(all.length, 4, 'one opening buy added, for A only (B was bought today)');
  const a = J.find(c => c.sym === 'A'); assert.ok(a && a.pl === -100 && a.inPx === 100, JSON.stringify(J));
  assert.equal(lossStreak(J.filter(c => c.sym === 'A')), 1);
  assert.equal(withOpenings(fills, [], '2026-10-23').length, 3, 'no buy on record: nothing invented');
  const partBuy = [{ symbol: 'A', side: 'buy', status: 'canceled', qty: '20', filled_qty: '10', filled_at: null, submitted_at: '2026-10-22T14:00:00Z', updated_at: '2026-10-22T14:30:00Z', filled_avg_price: '100' }];
  const o2 = withOpenings(fills, partBuy, '2026-10-23').find(f => /^open:/.test(f.order_id)); assert.ok(o2 && o2.transaction_time.slice(0, 10) === '2026-10-22', 'a buy filled in part keeps its own day, not today: ' + JSON.stringify(o2));
  const mixed = [{ symbol: 'C', side: 'sell', qty: '10', price: '9', order_id: 'x1', transaction_time: '2026-10-23T14:00:00Z' }, { symbol: 'C', side: 'buy', qty: '5', price: '9', order_id: 'x2', transaction_time: '2026-10-23T14:01:00Z' }, { symbol: 'C', side: 'sell', qty: '5', price: '9.5', order_id: 'x3', transaction_time: '2026-10-23T14:02:00Z' }];
  const op = withOpenings(mixed, [{ symbol: 'C', side: 'buy', status: 'filled', qty: '10', filled_avg_price: '10', filled_at: '2026-10-22T15:00:00Z' }], '2026-10-23').filter(f => /^open:/.test(f.order_id));
  assert.equal(op.length, 1); assert.equal(op[0].qty, '10', 'only the 10 carried from yesterday');
});
test('SPY sleeve: "armed" — a break counts only after a 5-minute bar closed in its direction on at least average volume (the tick path waits for it too)', () => {
  assert.equal(spySignal({ bars: up, px: 502.2, mins: 600 }).armed, true);
  const down = up.map((b, i) => i === 4 ? { ...b, o: 502.4, c: 502.0 } : b), w = spySignal({ bars: down, px: 502.7, mins: 600 });
  assert.equal(w.armed, false); assert.equal(w.side, undefined, 'the same break is not a signal'); assert.match(w.idle, /waiting for a 5-minute bar to close up/);
  const quiet = up.map((b, i) => i === 4 ? { ...b, v: 5e5 } : b); assert.equal(spySignal({ bars: quiet, px: 502.2, mins: 600 }).armed, false);
});

test('wheel settings: off by default; switched on, the shares never pass 100% (the wheel gives way last), a stop under 1.5× is raised, min ≤ max price', () => {
  const d = normalize({}); assert.equal(d.wheelOn, false); assert.equal(d.wheelOtmPct, 5); assert.equal(d.wheelTp, 50); assert.equal(d.wheelStop, 0); assert.equal(d.wheelTrend, true);
  const c = normalize({ preset: 'custom', callSharePct: 40, putSharePct: 10, spyOn: true, spySharePct: 20, wheelOn: true, wheelSharePct: 45, wheelStop: 1.2, wheelMinPrice: 200, wheelMaxPrice: 100 });
  assert.equal(c.wheelSharePct, 30); assert.equal(c.wheelStop, 1.5); assert.equal(c.wheelMaxPrice, 200);
  assert.equal(normalize({ wheelOn: false, wheelSharePct: 45, callSharePct: 40, putSharePct: 10, spySharePct: 20 }).wheelSharePct, 45, 'switched off it takes nothing, so it is left as typed');
  assert.match(summary(c), /split 0\/40\/10\/20\/30 stocks\/CALLs\/PUTs\/SPY\/wheel/);
});

console.log('Session hand-off (2026-10-29)');
const { sessionEndFor, HANDOVER_MIN } = await import('./bot.mjs');
test('a session born before the open hands over at 9:25 ET, so the next one\'s life ends after the SPY window; others run their whole life', () => {
  const LIFE = 345 * 60000, et = iso => Date.parse(iso);                       // 2026-10-29 is EDT (UTC-4); 2026-11-02 is EST (UTC-5)
  assert.equal(HANDOVER_MIN, 9 * 60 + 25);
  assert.equal(sessionEndFor(et('2026-10-29T10:20:51Z'), LIFE), et('2026-10-29T13:25:00Z'), 'born 6:20:51 AM → ends 9:25:00 AM');
  assert.equal(sessionEndFor(et('2026-10-29T13:24:30Z'), LIFE), et('2026-10-29T13:25:00Z'), 'born 9:24:30 AM → ends 9:25:00 AM');
  assert.equal(sessionEndFor(et('2026-11-02T11:00:00Z'), LIFE), et('2026-11-02T14:25:00Z'), 'winter time: born 6:00 AM EST → ends 9:25 AM EST');
  const b2 = et('2026-10-29T13:26:10Z'); assert.equal(sessionEndFor(b2, LIFE), b2 + LIFE, 'born 9:26 AM → full life, to 3:11 PM');
  assert.ok(new Date(b2 + LIFE).toISOString() > '2026-10-29T19:00:00Z', 'the hand-off starts after 3:00 PM, when the SPY window has closed');
  const b3 = et('2026-10-29T16:06:07Z'); assert.equal(sessionEndFor(b3, LIFE), b3 + LIFE, 'a mid-day successor runs its whole life');
  const b4 = et('2026-10-29T09:30:00Z'); assert.equal(sessionEndFor(b4, LIFE), b4 + LIFE, 'born 5:30 AM (exits at once: before 6:00) → unchanged');
});

console.log('Wheel: cash-secured puts and covered calls (wheel.mjs)');
const W = await import('./wheel.mjs');
const tdays = (() => { const hol = new Set(['2026-09-07', '2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2026-06-19']), out = []; for (let t = Date.parse('2026-05-01'); t <= Date.parse('2027-02-26'); t += 864e5) { const d = new Date(t), s = d.toISOString().slice(0, 10); if (d.getUTCDay() % 6 && !hol.has(s)) out.push(s); } return out; })();
test('wheel: monthly expirations — the third Friday, or the trading day before it on a holiday (Juneteenth 2026)', () => {
  assert.equal(W.thirdFriday(2026, 9), '2026-10-16'); assert.equal(W.thirdFriday(2026, 10), '2026-11-20');
  const isT = d => tdays.includes(d); assert.equal(W.monthlyExpiry(2026, 5, isT), '2026-06-18'); assert.equal(W.monthlyExpiry(2026, 11, isT), '2026-12-18');
});
test('wheel: the sale window is the first three trading days after a monthly expiration; outside it the next one is named', () => {
  const a = W.wheelCycle('2026-10-19', tdays); assert.equal(a.last, '2026-10-16'); assert.equal(a.next, '2026-11-20'); assert.equal(a.day, 1); assert.equal(a.window, true); assert.equal(a.expiry, '2026-11-20'); assert.deepEqual(a.windowDays, ['2026-10-19', '2026-10-20', '2026-10-21']);
  const b = W.wheelCycle('2026-10-22', tdays); assert.equal(b.day, 4); assert.equal(b.window, false); assert.deepEqual(b.windowDays, ['2026-11-23', '2026-11-24', '2026-11-25']); assert.equal(b.expiry, '2026-12-18');
  const c = W.wheelCycle('2026-11-20', tdays); assert.equal(c.window, false, 'expiration day itself is not in the window'); assert.equal(c.next, '2026-11-20');
  const d = W.wheelCycle('2026-10-24', tdays); assert.equal(d.day, 0, 'a weekend day is never a sale day'); assert.equal(d.window, false);
});
test('wheel: strikes — puts at the highest strike at least X% under, calls at the lowest at or above the cost and X% over', () => {
  assert.equal(W.putStrike([90, 92.5, 95, 97.5, 100], 100, 5), 95); assert.equal(W.putStrike([90, 92.5, 96], 100, 5), 92.5); assert.equal(W.putStrike([99, 100], 100, 5), null);
  assert.equal(W.callStrike([100, 102.5, 105, 107.5], 100, 5), 105); assert.equal(W.callStrike([100, 102.5, 105, 107.5], 100, 5, 106), 107.5, 'never under the cost'); assert.equal(W.callStrike([100, 102.5], 100, 5), null);
  assert.equal(W.wheelTpPrice(1.5, 50), 0.75); assert.equal(W.wheelTpPrice(0, 50), null);
  assert.deepEqual(W.parseOcc('KO261120P00065000'), { und: 'KO', exp: '2026-11-20', kind: 'put', K: 65 });
  assert.equal(W.wheelId('put', 'KO261120P00065000', '20261019', 'ab1'), 'sd-wp-KO261120P00065000-20261019-ab1'); assert.ok(W.isWheelSell('sd-wc-X-1') && W.isWheelBuy('sd-wb-X-1') && !W.isWheelId('sd-q-X'));
});
test('wheel bookkeeping: a sold put is remembered; then bought back, expired or assigned (shares at the strike, cost = strike − premium)', () => {
  const P = 'KO261120P00065000', sale = { symbol: P, side: 'sell', client_order_id: 'sd-wp-' + P + '-20261019-a', filled_qty: '1', filled_avg_price: '0.9', filled_at: '2026-10-19T15:00:00Z', status: 'filled' };
  const r1 = W.wheelReconcile({ mem: null, positions: [{ symbol: P, qty: '-1', avg_entry_price: '0.9' }], hist: [sale], today: '2026-10-19', now: '2026-10-19T15:00:20Z' });
  assert.deepEqual(r1.mem.opts[P], { und: 'KO', kind: 'put', K: 65, exp: '2026-11-20', qty: 1, prem: 0.9, since: '2026-10-19', seen: '2026-10-19T15:00:20Z', base: 0 }); assert.equal(r1.events.length, 0);
  const tp = W.wheelReconcile({ mem: r1.mem, positions: [], hist: [sale, { symbol: P, side: 'buy', client_order_id: 'sd-wb-' + P + '-b', filled_qty: '1', filled_at: '2026-10-30T15:00:00Z' }], today: '2026-10-30' });
  assert.equal(tp.events[0].type, 'bought back'); assert.deepEqual(tp.mem.opts, {});
  const ex = W.wheelReconcile({ mem: r1.mem, positions: [], hist: [sale], today: '2026-11-23' }); assert.equal(ex.events[0].type, 'expired'); assert.deepEqual(ex.mem.shares, {});
  const early = W.wheelReconcile({ mem: r1.mem, positions: [], hist: [sale], today: '2026-10-30' }); assert.equal(early.events.length, 0, 'gone before its day with no trade: kept'); assert.ok(early.mem.opts[P]);
  const as = W.wheelReconcile({ mem: r1.mem, positions: [{ symbol: 'KO', qty: '100', avg_entry_price: '65' }], hist: [sale], today: '2026-11-23' });
  assert.equal(as.events[0].type, 'assigned'); assert.deepEqual(as.mem.shares.KO, { qty: 100, cost: 64.1, since: '2026-11-23' });
});
test('wheel bookkeeping: a covered call that ends in the money takes the shares away; shares sold by hand shrink the part; others are never touched', () => {
  const C = 'KO261218C00068000', sale = { symbol: C, side: 'sell', client_order_id: 'sd-wc-' + C + '-20261123-a', filled_qty: '1', filled_avg_price: '0.6', filled_at: '2026-11-23T15:00:00Z' };
  const mem0 = { opts: {}, shares: { KO: { qty: 100, cost: 64.1 } } };
  const r1 = W.wheelReconcile({ mem: mem0, positions: [{ symbol: 'KO', qty: '100', avg_entry_price: '65' }, { symbol: C, qty: '-1', avg_entry_price: '0.6' }], hist: [sale], today: '2026-11-23' });
  assert.equal(r1.mem.opts[C].base, 0, 'the part\'s own shares are not counted as held outside it');
  const away = W.wheelReconcile({ mem: r1.mem, positions: [], hist: [sale], today: '2026-12-21' }); assert.equal(away.events[0].type, 'called away'); assert.deepEqual(away.mem.shares, {});
  const kept = W.wheelReconcile({ mem: r1.mem, positions: [{ symbol: 'KO', qty: '100', avg_entry_price: '65' }], hist: [sale], today: '2026-12-21' }); assert.equal(kept.events[0].type, 'expired'); assert.equal(kept.mem.shares.KO.qty, 100);
  const hand = W.wheelReconcile({ mem: mem0, positions: [{ symbol: 'KO', qty: '40', avg_entry_price: '65' }], hist: [], today: '2026-11-24' }); assert.equal(hand.mem.shares.KO.qty, 40);
  const manual = W.wheelReconcile({ mem: null, positions: [{ symbol: 'PEP261120P00140000', qty: '-1', avg_entry_price: '2' }], hist: [], today: '2026-10-20' }); assert.deepEqual(manual.mem.opts, {}, 'a put sold by hand is not the part\'s');
});
test('wheel bookkeeping: without a memory, shares bought at the strike of a sold put that is gone are adopted; a stock another part bought is not', () => {
  const P = 'KO261120P00065000', sale = { symbol: P, side: 'sell', client_order_id: 'sd-wp-' + P + '-20261019-a', filled_qty: '1', filled_avg_price: '0.9', filled_at: '2026-10-19T15:00:00Z' };
  const r = W.wheelReconcile({ mem: null, positions: [{ symbol: 'KO', qty: '100', avg_entry_price: '65' }], hist: [sale], today: '2026-11-23' });
  assert.deepEqual(r.mem.shares.KO, { qty: 100, cost: 64.1, since: '2026-11-23' }); assert.equal(r.events[0].adopted, true);
  const other = W.wheelReconcile({ mem: null, positions: [{ symbol: 'KO', qty: '100', avg_entry_price: '65' }], hist: [sale, { symbol: 'KO', side: 'buy', client_order_id: 'sd-r-KO-1', filled_qty: '100', filled_at: '2026-11-02T15:00:00Z' }], today: '2026-11-23' });
  assert.deepEqual(other.mem.shares, {});
});
test('wheel trend filter: the close before each window day so far must be above its 200-day average; one under ends the window', () => {
  const days = [], closes = []; for (let i = 0; i < 240; i++) { days.push(new Date(Date.parse('2026-01-01') + i * 864e5).toISOString().slice(0, 10)); closes.push(100 + i * 0.1); }
  const first = days[230], second = days[231];
  assert.equal(W.aboveTrendAt(days, closes, first), true); assert.equal(W.aboveTrendAt(days.slice(0, 150), closes.slice(0, 150), days[149]), null, 'under 200 closes: unknown');
  assert.deepEqual(W.trendThrough(days, closes, [first, second, days[232]], second), { ok: true, under: null });
  const c2 = closes.slice(); c2[229] = 50;                                    // the close before the window's first day fell under
  assert.deepEqual(W.trendThrough(days, c2, [first, second, days[232]], second), { ok: false, under: days[229] }, 'it stays off for the rest of the window');
  const c3 = closes.slice(); c3[230] = 50;                                    // above before day 1, under before day 2
  assert.equal(W.trendThrough(days, c3, [first, second, days[232]], first).ok, true); assert.equal(W.trendThrough(days, c3, [first, second, days[232]], second).ok, false);
});
test('wheel: one sale per stock per cycle — filled sales of the window\'s expiry are counted by stock and kind', () => {
  const s = (sym, q, cid = 'sd-wp-' + sym + '-20261019-a', side = 'sell') => ({ symbol: sym, side, client_order_id: cid, filled_qty: String(q) });
  const h = [s('KO261120P00065000', 1), s('KO261120P00062500', 0), s('PEP261218P00140000', 1), s('KO261120C00070000', 2, 'sd-wc-KO261120C00070000-20261019-b'), s('KO261120P00065000', 1, 'sd-wb-KO261120P00065000-c', 'buy'), s('MO261120P00050000', 1, 'manual-1')];
  assert.deepEqual([...W.soldFor(h, '2026-11-20', 'put')], [['KO', 1]], 'unfilled, other expiry, buy-backs and orders placed by hand do not count');
  assert.deepEqual([...W.soldFor(h, '2026-11-20', 'call')], [['KO', 2]]);
});
test('wheel bookkeeping (review): shares another part or the owner bought are never taken for an assignment, nor adopted while the memory is intact', () => {
  const P = 'KO261120P00065000', sale = { symbol: P, side: 'sell', client_order_id: 'sd-wp-' + P + '-20261019-a', filled_qty: '1', filled_avg_price: '0.9', filled_at: '2026-10-19T15:00:00Z' };
  const mem = W.wheelReconcile({ mem: null, positions: [{ symbol: P, qty: '-1', avg_entry_price: '0.9' }], hist: [sale], today: '2026-10-19', now: '2026-10-19T15:00:20Z' }).mem;
  const dipBuy = { symbol: 'KO', side: 'buy', client_order_id: 'sd-r-KO-1', filled_qty: '100', filled_at: '2026-11-02T15:00:00Z' };
  const r = W.wheelReconcile({ mem, positions: [{ symbol: 'KO', qty: '100', avg_entry_price: '65.3' }], hist: [sale, dipBuy], today: '2026-11-23', now: '2026-11-23T14:00:00Z' });
  assert.equal(r.events[0].type, 'expired', 'the dip part\'s 100 shares are not the put\'s'); assert.deepEqual(r.mem.shares, {}); assert.equal(r.mem.done[P], '2026-11-23');
  const hand = { symbol: 'KO', side: 'buy', client_order_id: 'web-1', filled_qty: '100', filled_at: '2026-11-24T15:00:00Z' };
  const r2 = W.wheelReconcile({ mem: r.mem, positions: [{ symbol: 'KO', qty: '100', avg_entry_price: '65.2' }], hist: [sale, hand], today: '2026-11-24', now: '2026-11-24T16:00:00Z' });
  assert.deepEqual(r2.mem.shares, {}, 'shares bought by hand at the old strike are not adopted'); assert.equal(r2.events.length, 0);
  const real = W.wheelReconcile({ mem, positions: [{ symbol: 'KO', qty: '150', avg_entry_price: '65' }], hist: [sale, { ...dipBuy, filled_qty: '50' }], today: '2026-11-23', now: '2026-11-23T14:00:00Z' });
  assert.equal(real.events[0].type, 'assigned', 'an assignment beside 50 shares the dip part bought'); assert.equal(real.mem.shares.KO.qty, 100);
});
test('wheel bookkeeping (review): a contract the owner sells by hand after the wheel bought it back is not the wheel\'s', () => {
  const P = 'KO261120P00065000', sale = { symbol: P, side: 'sell', client_order_id: 'sd-wp-' + P + '-20261019-a', filled_qty: '1', filled_avg_price: '0.9', filled_at: '2026-10-19T15:00:00Z' };
  const back = { symbol: P, side: 'buy', client_order_id: 'sd-wb-' + P + '-b', filled_qty: '1', filled_at: '2026-10-22T15:00:00Z' }, hand = { symbol: P, side: 'sell', client_order_id: 'web-2', filled_qty: '1', filled_at: '2026-10-26T15:00:00Z' };
  const r = W.wheelReconcile({ mem: { opts: {}, shares: {}, done: { [P]: '2026-10-22' } }, positions: [{ symbol: P, qty: '-1', avg_entry_price: '1.1' }], hist: [sale, back, hand], today: '2026-10-26' });
  assert.deepEqual(r.mem.opts, {});
  const lost = W.wheelReconcile({ mem: null, positions: [{ symbol: P, qty: '-1', avg_entry_price: '1.1' }], hist: [sale, back, hand], today: '2026-10-26' });
  assert.deepEqual(lost.mem.opts, {}, 'even with the memory lost');
});
test('wheel bookkeeping (review 2): a lost memory rebuilds the shares before an open covered call is measured against them', () => {
  const P = 'KO261120P00065000', C = 'KO261218C00070000';
  const putSale = { symbol: P, side: 'sell', client_order_id: 'sd-wp-' + P + '-20261019-a', filled_qty: '1', filled_avg_price: '0.9', filled_at: '2026-10-19T15:00:00Z' };
  const callSale = { symbol: C, side: 'sell', client_order_id: 'sd-wc-' + C + '-20261123-b', filled_qty: '1', filled_avg_price: '0.5', filled_at: '2026-11-23T15:00:00Z' };
  const ko = { symbol: 'KO', qty: '100', avg_entry_price: '65' }, callPos = { symbol: C, qty: '-1', avg_entry_price: '0.5' };
  const a = W.wheelReconcile({ mem: null, positions: [ko, callPos], hist: [putSale, callSale], today: '2026-11-24', now: '2026-11-24T15:00:00Z' });
  assert.equal(a.mem.opts[C].base, 0, 'its own 100 shares are not "held outside the wheel"'); assert.equal(a.mem.shares.KO.qty, 100);
  const b = W.wheelReconcile({ mem: a.mem, positions: [ko], hist: [putSale, callSale], today: '2026-12-21', now: '2026-12-21T15:00:00Z' });
  assert.deepEqual(b.events.map(e => e.type), ['expired'], 'the call expired worthless: not "called away"'); assert.equal(b.mem.shares.KO.qty, 100);
  const onlyCall = W.wheelReconcile({ mem: null, positions: [{ ...ko, avg_entry_price: '63.2' }, callPos], hist: [callSale], today: '2026-11-24', now: '2026-11-24T15:00:00Z' });
  assert.deepEqual(onlyCall.mem.shares.KO, { qty: 100, cost: 63.2, since: '2026-11-24' }, 'the put is older than the order history: the shares under its call are its, at the account\'s price');
  const tpPart = { symbol: C, side: 'buy', client_order_id: 'sd-wb-' + C + '-t', status: 'partially_filled', qty: '2', filled_qty: '1', updated_at: '2026-11-30T15:00:00Z' };
  const n4 = W.wheelReconcile({ mem: null, positions: [{ symbol: 'KO', qty: '200', avg_entry_price: '65' }, callPos], hist: [{ ...putSale, qty: '2', filled_qty: '2' }, { ...callSale, qty: '2', filled_qty: '2' }, tpPart], today: '2026-12-01' });
  assert.ok(n4.mem.opts[C], 'its own call, partly bought back, is still its own');
});
test('wheel bookkeeping (review 2): a memory without "seen" (older) measures from the sale, so earlier stock orders are not netted', () => {
  const P = 'KO261120P00065000', putSale = { symbol: P, side: 'sell', client_order_id: 'sd-wp-' + P + '-20261019-a', filled_qty: '1', filled_avg_price: '0.9', filled_at: '2026-10-19T15:00:00Z' };
  const old = { opts: { [P]: { und: 'KO', kind: 'put', K: 65, exp: '2026-11-20', qty: 1, prem: 0.9, since: '2026-10-19', base: 0 } }, shares: {} };
  const sellKO = { symbol: 'KO', side: 'sell', client_order_id: 'sd-x-KO-a', filled_qty: '100', filled_at: '2026-10-19T14:00:00Z' };
  assert.deepEqual(W.wheelReconcile({ mem: old, positions: [], hist: [putSale, sellKO], today: '2026-11-23' }).events.map(e => e.type), ['expired']);
  const up = W.wheelReconcile({ mem: old, positions: [{ symbol: P, qty: '-1', avg_entry_price: '0.9' }], hist: [putSale], today: '2026-10-30', now: '2026-10-30T15:00:00Z' });
  assert.equal(up.mem.opts[P].seen, '2026-10-19T15:00:00Z');
});
test('war words that double as business words need a conflict word next to them (2026-10-30 audit)', () => {
  assert.deepEqual(classify('Boeing strike escalates as union rejects offer'), []);
  assert.deepEqual(classify("Short seller's attack on Palantir intensifies"), []);
  assert.deepEqual(classify('Chip rivalry between Nvidia and AMD escalates'), []);
  assert.ok(classify('Russia escalates attacks on Kyiv power grid').includes('war'));
  assert.ok(classify('Attack on Saudi oil tanker closes shipping lane').includes('war'));
  assert.ok(classify('Israel-Iran conflict escalates after missile barrage').includes('war'));
  assert.ok(classify('Ceasefire talks collapse').includes('war'), 'a real war word still stands on its own');
});
test('SPY same-day expiry setting (2026-10-30): 0 allowed and clamped into 0–5', () => {
  assert.equal(normalize({ preset: 'custom', spyDte: 0 }).spyDte, 0);
  assert.equal(normalize({ preset: 'custom', spyDte: -1 }).spyDte, 0);
  assert.equal(normalize({ preset: 'custom', spyDte: 7 }).spyDte, 5);
});

console.log('India earnings calendar (earnings-in.mjs)');
const EI = await import('../earnings-in.mjs');
test('India results: NSE and BSE dates, and the quarter a meeting is about (from the description, else the quarter end before it)', () => {
  assert.equal(EI.parseDay('30-Oct-2026'), '2026-10-30'); assert.equal(EI.parseDay('02 Nov 2026'), '2026-11-02'); assert.equal(EI.parseDay('soon'), '');
  assert.equal(EI.quarterEndBefore('2026-10-30'), '2026-09-30'); assert.equal(EI.quarterEndBefore('2027-01-15'), '2026-12-31'); assert.equal(EI.quarterEndBefore('2026-05-20'), '2026-03-31');
  assert.equal(EI.periodEnd('To consider and approve the financial results for the period ended September 30, 2026', '2026-10-30'), '2026-09-30');
  assert.equal(EI.periodEnd('Results for the quarter and half year ended 30th September, 2026', '2026-11-05'), '2026-09-30');
  assert.equal(EI.periodEnd('audited results for the year ended 31.03.2026', '2026-05-12'), '2026-03-31');
  assert.equal(EI.periodEnd('Financial Results', '2027-02-04'), '2026-12-31', 'no date in the text: the quarter end before the meeting');
  assert.equal(EI.periodEnd('results for the period ended September 15, 2026', '2026-10-30'), '2026-09-30', 'not a quarter end: falls back');
});
test('India results: only results meetings are kept, one per company and day; BSE names are title-cased', () => {
  const nse = EI.fromNse([
    { symbol: 'RELIANCE', company: 'Reliance Industries Limited', purpose: 'Financial Results/Fund Raising', bm_desc: 'To consider and approve the financial results for the period ended September 30, 2026', date: '30-Oct-2026' },
    { symbol: 'RELIANCE', company: 'Reliance Industries Limited', purpose: 'Financial Results', bm_desc: '', date: '30-Oct-2026' },
    { symbol: 'ABC', company: 'Abc Ltd', purpose: 'Fund Raising', bm_desc: 'To consider raising funds', date: '31-Oct-2026' },
    { symbol: 'M&M', company: 'Mahindra & Mahindra Limited', purpose: 'Financial Results', bm_desc: '', date: '04-Nov-2026' }]);
  assert.deepEqual(nse.map(r => r.s + ' ' + r.d + ' ' + r.p), ['RELIANCE 2026-10-30 2026-09-30', 'M&M 2026-11-04 2026-09-30']);
  const bse = EI.fromBse([{ scrip_Code: '500325', short_name: 'RELIANCE', Long_Name: 'RELIANCE INDUSTRIES LTD.', meeting_date: '30 Oct 2026' }, { short_name: '', meeting_date: '30 Oct 2026' }]);
  assert.deepEqual(bse, [{ s: 'RELIANCE', n: 'Reliance Industries Ltd.', d: '2026-10-30', p: '2026-09-30' }]);
});
test('India results: big = the Nifty 100 in index order (1–50 get tiles), then the page’s own India stocks', () => {
  const B = EI.bigList(['TCS.NS', 'TMPV.NS', 'TMPV.NS']);
  assert.equal(EI.bigRank('RELIANCE', B), 1); assert.ok(EI.bigRank('TCS', B) <= 50); assert.equal(EI.bigRank('TMPV', B), 101); assert.equal(EI.bigRank('TINYCO', B), 0);
  assert.equal(B.filter(s => s === 'TMPV').length, 1);
});
test('India results: Yahoo numbers — reported EPS against its estimate by quarter, today’s estimates for the next report, estimates kept after it', () => {
  const y = EI.parseYahoo({ quoteSummary: { result: [{ calendarEvents: { earnings: { earningsDate: [{ raw: 1, fmt: '2026-10-30' }], earningsAverage: { raw: 17.31 }, revenueAverage: { raw: 3.2e12 } } }, earningsHistory: { history: [{ quarter: { fmt: '2026-06-30' }, epsActual: { raw: 15.48 }, epsEstimate: { raw: 14.97 } }] } }] } });
  assert.deepEqual(y, { d: '2026-10-30', eE: 17.31, rE: 3.2e12, h: [['2026-06-30', 15.48, 14.97]] });
  assert.equal(EI.parseYahoo({ quoteSummary: { result: [] } }), null);
  const rows = [{ s: 'RELIANCE', n: 'Reliance', d: '2026-10-30', p: '2026-09-30', k: 1 }, { s: 'TCS', n: 'TCS', d: '2026-10-08', p: '2026-09-30', k: 2 }, { s: 'HDFCBANK', n: 'HDFC Bank', d: '2026-10-17', p: '2026-09-30', k: 3 }, { s: 'TINY', n: 'Tiny', d: '2026-10-30', p: '2026-09-30', k: 0 }];
  const Y = { RELIANCE: y, TCS: { d: '2027-01-12', eE: 40, rE: 7.5e11, h: [['2026-09-30', 38.37, 38.07]] }, HDFCBANK: { d: '2027-01-16', eE: 13, rE: 5e11, h: [['2026-06-30', 12.35, 12.5]] } };
  const prev = [{ s: 'HDFCBANK', d: '2026-10-17', eE: 12.49, rE: 4.9e11 }];
  const out = EI.withNumbers(rows, Y, prev, '2026-10-28');
  assert.deepEqual(out[0], { s: 'RELIANCE', n: 'Reliance', d: '2026-10-30', p: '2026-09-30', k: 1, eE: 17.31, rE: 3.2e12 }, 'still to report: the next report’s estimates');
  assert.deepEqual([out[1].eA, out[1].eE, out[1].rE], [38.37, 38.07, undefined], 'reported: the actual against its own estimate (not next quarter’s)');
  assert.deepEqual([out[2].eA, out[2].eE, out[2].rE], [undefined, 12.49, 4.9e11], 'reported, not yet in Yahoo’s history: the estimates from before are kept');
  assert.deepEqual(Object.keys(out[3]), ['s', 'n', 'd', 'p', 'k'], 'a company that is not big carries no numbers');
});
test('India results: a moved meeting shows once — the new date until the EPS is in, the meeting held once it is; capitals become a name', () => {
  const moved = [{ s: 'TATASTEEL', d: '2026-10-27', p: '2026-09-30', k: 26 }, { s: 'TATASTEEL', d: '2026-11-07', p: '2026-09-30', k: 26, eE: 2.78 }, { s: 'OTHER', d: '2026-10-27', p: '2026-09-30', k: 0 }];
  assert.deepEqual(EI.onePerQuarter(moved, '2026-10-29').map(r => r.s + ' ' + r.d), ['TATASTEEL 2026-11-07', 'OTHER 2026-10-27']);
  const held = [{ s: 'X', d: '2026-10-20', p: '2026-09-30', k: 5, eA: 1, eE: 0.9 }, { s: 'X', d: '2026-11-04', p: '2026-09-30', k: 5, eA: 1, eE: 0.9 }];
  assert.deepEqual(EI.onePerQuarter(held, '2026-10-29').map(r => r.d), ['2026-10-20']);
  assert.equal(EI.fromNse([{ symbol: 'TATACONSUM', company: 'TATA CONSUMER PRODUCTS LIMITED', purpose: 'Financial Results', date: '26-Oct-2026' }])[0].n, 'Tata Consumer Products Limited');
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
