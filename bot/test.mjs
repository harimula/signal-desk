// Unit tests for the bot's rules. Run: node bot/test.mjs  (also runs on every push via GitHub Actions)
import assert from 'node:assert/strict';
import { rsi2Signal, rsi2Exit, rsi2, sma } from './strategy.mjs';
import { stockQty, optionQty, regimeOf, lossStreak, openRisk, sectorOf } from './risk.mjs';
import { buildJournal, parseSym } from './journal.mjs';
import { guard, symbolRisk, classify } from './news.mjs';
import { keysFor, relevant, parseRss } from '../news.mjs';

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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
