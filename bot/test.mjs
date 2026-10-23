// Unit tests for the bot's rules. Run: node bot/test.mjs  (also runs on every push via GitHub Actions)
import assert from 'node:assert/strict';
import { rsi2Signal, rsi2Exit, rsi2, sma, rsi2ShortSignal, rsi2ShortExit, rsi2Trigger, rsi2ExitLevel } from './strategy.mjs';
import { stockQty, optionQty, regimeOf, lossStreak, openRisk, sectorOf, sideDayPl } from './risk.mjs';
import { buildJournal, parseSym } from './journal.mjs';
import { guard, symbolRisk, classify } from './news.mjs';
import { keysFor, relevant, parseRss } from '../news.mjs';
import { normalize } from './config.mjs';
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
  assert.equal(normalize({}).stockTp, 0, 'off unless set');
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
