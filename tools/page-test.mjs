/* global syncPull, renderSyncBtn, jDecrypt */   // page functions called inside page.evaluate()
// Page tests in headless Chromium (runs in CI):
//   node tools/page-test.mjs
// Serves the site locally, stands in for the GitHub API, and checks: every tab renders without a script error or a
// CSP violation — also with the Screener sub-view remembered — and that Bot settings saves and surfaces failures.
// Needs playwright (CI installs it; locally: npm i --no-save playwright@1.49.1 && npx playwright install chromium).
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WHEEL_DEFAULTS } from '../bot/wheel.mjs';
const { chromium } = await import('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json' };
let journalFixture = null;                                                  // when set, served in place of the encrypted bot/journal.json
const srv = http.createServer((req, res) => {
  const pn = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (journalFixture && /\/bot\/journal\.json$/.test(pn)) { res.setHeader('content-type', 'application/json'); return res.end(fs.readFileSync(path.isAbsolute(journalFixture) ? journalFixture : path.join(ROOT, 'tools/fixtures', journalFixture))); }
  const p = path.join(ROOT, pn.replace(/\/$/, '/index.html'));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end('nf'); }
  res.setHeader('content-type', mime[path.extname(p)] || 'application/octet-stream'); res.end(fs.readFileSync(p));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
let failed = 0;
const check = (name, ok, detail = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : '  ' + detail)); if (!ok) failed++; };

async function session(label, prep, cfgPatch = {}) {                        // cfgPatch: what the stubbed bot/config.json says instead of the owner's file
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message.slice(0, 160)));
  page.on('console', m => { if (m.type() === 'error' && !/net::|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text().slice(0, 160)); });
  await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'bot/config.json'), 'utf8'));
  for (const k of ['dayOrMin', 'dayMaxTrades', 'dayTarget', 'dayOptDteMax']) delete cfg[k];          // like the real file: older saves lack these
  cfg.dayTrade = true;                                                                                 // the checks below need the day-trading fields drawn, whatever the owner's saved switch says
  Object.assign(cfg, cfgPatch);
  let sha = 'abc', puts = [], secretPuts = [], inPuts = [];
  // the encryption library the page loads from jsDelivr, served from the locally installed package (same bytes, same SRI hash)
  await page.route('https://cdn.jsdelivr.net/npm/**', route => { const m2 = /npm\/(libsodium(?:-wrappers)?)@[^/]+\/(.*)$/.exec(route.request().url()); const f = m2 && path.join(ROOT, 'node_modules', m2[1], m2[2]); return f && fs.existsSync(f) ? route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(f), headers: { 'access-control-allow-origin': '*' } }) : route.abort(); });
  await page.route('https://api.github.com/**', async route => {
    const u = new URL(route.request().url()), m = route.request().method(), p = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    if (process.env.SLOW_MS) await new Promise(r => setTimeout(r, +process.env.SLOW_MS));
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '' || p === '/') return json(200, { private: false, full_name: 'x/y' });
    if (p === '/contents/bot/config.json' && m === 'GET') return json(200, { sha, content: Buffer.from(JSON.stringify(cfg)).toString('base64') });
    if (p === '/contents/bot/config.json' && m === 'PUT') { puts.push(JSON.parse(route.request().postData())); sha = 'new' + puts.length; return json(200, { content: { sha } }); }
    if (p === '/actions/secrets') return json(200, { secrets: [{ name: 'ALPACA_KEY' }, { name: 'ALPACA_SECRET' }] });
    if (p === '/contents/bot/config-in.json' && m === 'GET') return json(200, { sha: 'in1', content: Buffer.from(JSON.stringify({ stakeInr: 1000000, breakout: true, rsi2: true })).toString('base64') });
    if (p === '/contents/bot/config-in.json' && m === 'PUT') { inPuts.push(JSON.parse(route.request().postData())); return json(200, { content: { sha: 'in2' } }); }
    if (p === '/actions/secrets/public-key') return json(200, { key_id: 'kid1', key: Buffer.from(crypto.generateKeyPairSync('x25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)).toString('base64') });
    if (p.startsWith('/actions/secrets/') && m === 'PUT') { secretPuts.push({ name: p.split('/').pop(), ...JSON.parse(route.request().postData()) }); return route.fulfill({ status: 201, body: '' }); }
    return json(404, { message: 'Not Found' });
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(prep);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  // walk every tab
  const n = await page.$$eval('#appbar [role=tab], #tabs [role=tab]', els => els.length);
  for (let i = 0; i < n; i++) { await page.evaluate(i => document.querySelectorAll('#appbar [role=tab], #tabs [role=tab]')[i].click(), i); await page.waitForTimeout(400); }
  await page.evaluate(() => document.querySelector('#appbar [role=tab]').click());
  await page.waitForTimeout(300);
  const csp = await page.evaluate(() => window.__csp);
  check(`${label}: every tab renders without a script error`, errors.length === 0, errors.join(' | '));
  check(`${label}: no Content-Security-Policy violations`, csp.length === 0, csp.join(' | '));
  return { page, errors, puts, secretPuts, inPuts };
}

// 1. plain visitor
{ const { page } = await session('fresh visitor', () => localStorage.clear()); await page.close(); }

// 2. connected owner who last used the Screener sub-view (the state that once crashed every other tab's redraw)
{
  const { page, errors, puts, secretPuts, inPuts } = await session('owner with Screener remembered', () => { localStorage.clear(); localStorage.setItem('sd-v2', JSON.stringify('screen')); localStorage.setItem('sd-ghtok', JSON.stringify('ghp_fake')); localStorage.setItem('sd-ghrepo', JSON.stringify('x/y')); });
  await page.evaluate(() => document.querySelector('#tabs [data-t="SET"]').click());
  await page.waitForTimeout(1200);
  await page.fill('#st-rsiThreshold', '12');
  await page.evaluate(() => document.querySelector('#st-rsiThreshold').dispatchEvent(new Event('change', { bubbles: true })));
  await page.fill('#st-maxHold', '1'); await page.focus('#st-maxHold'); await page.keyboard.type('1');   // → 11, inside the 1–30 range
  await page.evaluate(() => document.querySelector('#st-maxHold').dispatchEvent(new Event('change', { bubbles: true })));
  check('settings: a setting missing from config.json shows its default instead of an empty box', await page.evaluate(() => ['dayOrMin', 'dayMaxTrades', 'dayTarget', 'dayOptDteMax'].every(k => { const el = document.getElementById('st-' + k); return el && el.value !== ''; })), await page.evaluate(() => ['dayOrMin', 'dayMaxTrades', 'dayTarget'].map(k => k + '=' + (document.getElementById('st-' + k) || {}).value).join(' ')));
  check('settings: typing does not move the cursor', (await page.evaluate(() => document.activeElement.id)) === 'st-maxHold');
  // hover help (tips.js): explained labels on the settings page, a card on hover, the help survives redraws
  const nTips = await page.$$eval('[data-tip]', e => e.length);
  const tipLab = await page.$('label[data-tip]:has-text("Opening range") b'); if (tipLab) { await tipLab.scrollIntoViewIfNeeded(); await page.waitForTimeout(400); await tipLab.hover(); await page.waitForTimeout(450); }
  const tipOn = await page.$eval('#sd-tip', e => e.classList.contains('on') && /breakout/.test(e.textContent)).catch(() => false);
  await page.mouse.move(2, 2); await page.evaluate(() => window.renderAll()); await page.waitForTimeout(200);
  check('hover help: settings labels are explained, the card shows on hover, and a redraw keeps it', nTips >= 40 && tipOn && (await page.$$eval('[data-tip]', e => e.length)) >= nTips, `${nTips} labels, card ${tipOn}`);
  await page.waitForTimeout(300);
  { const noTip = await page.evaluate(() => { const part = el => { for (const q of [':scope > b', ':scope > span > b', ':scope > .lab', ':scope > span:not(.mut):not(.hint)', ':scope > span.mut:first-child']) { const x = el.querySelector(q); if (x) return x; } return null; };   // the words tips.js looks up
      return [...document.querySelectorAll('main label, main [data-tipkey]')].filter(el => el.offsetParent && !el.hasAttribute('data-tip')).map(el => (el.dataset.tipkey || (part(el) || el).textContent).replace(/\s+/g, ' ').trim()).filter(t => t && t.length <= 80); });
    check('hover help: every label on Bot settings has an explanation, the sell-rule choices included', noTip.length === 0, noTip.join(' | ')); }
  // the owner's saved shares vary; set CALLs 30 / PUTs 10 / SPY 5 first so the checks below do not depend on config.json
  await page.evaluate(() => { const r = document.querySelector('#st-wheelOn'); if (r && r.checked) { r.checked = false; r.dispatchEvent(new Event('change', { bubbles: true })); } }); await page.waitForTimeout(200);   // the saved settings may have the wheel on: this check reads the four classic shares
  for (const [id, v] of [['st-callSharePct', '30'], ['st-putSharePct', '10'], ['st-spySharePct', '5']]) { await page.fill('#' + id, v); await page.evaluate(id => document.getElementById(id).dispatchEvent(new Event('change', { bubbles: true })), id); await page.waitForTimeout(150); }
  await page.evaluate(() => { const r = document.querySelector('#st-spyOn'); if (r && !r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } }); await page.waitForTimeout(200);
  const note0 = await page.evaluate(() => (document.querySelector('#stSplitNote') || {}).textContent || '');
  await page.fill('#st-callSharePct', '25');
  await page.evaluate(() => document.querySelector('#st-callSharePct').dispatchEvent(new Event('change', { bubbles: true }))); await page.waitForTimeout(200);
  const note1 = await page.evaluate(() => (document.querySelector('#st-split') || {}).checked === true && (document.querySelector('#stSplitNote') || {}).textContent || '');
  check('money split: with CALLs 30 / PUTs 10 / SPY 5 the note reads 55/30/10/5, and a share typed in updates it', /Stocks 55%.*CALLs 30%.*PUTs 10%.*SPY quick options 5%/.test(note0) && /Stocks 60%.*CALLs 25%.*PUTs 10%/.test(note1), note0 + ' → ' + note1);
  check('SPY sleeve: section 4c shows, on by default, with its nine settings and the time window', await page.evaluate(() => (document.querySelector('#st-spyOn') || {}).checked === true && ['spySharePct', 'spyTp', 'spyStop', 'spyHoldMin', 'spyMaxTrades', 'spyMaxOpen', 'spyStreak', 'spyDayCap', 'spyDte', 'spyStart', 'spyEnd'].every(k => document.getElementById('st-' + k)) && document.getElementById('st-spySharePct').value === '5'));
  // the wheel (4d): switched on with a 10% share it takes its part of the stake (stocks 60% → 50%) and shows its seven settings
  await page.evaluate(() => { const r = document.querySelector('#st-wheelOn'); if (r && !r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } }); await page.waitForTimeout(250);
  await page.evaluate(() => { const el = document.getElementById('st-wheelSharePct'); el.value = '10'; el.dispatchEvent(new Event('change', { bubbles: true })); }); await page.waitForTimeout(250);   // one step: a re-render between fill and dispatch would reset the box to the saved value
  { const w = await page.evaluate(() => ({ note: (document.querySelector('#stSplitNote') || {}).textContent || '', sec: !!document.getElementById('sec-4d-cash-secured-puts-covered-calls'), f: ['wheelSharePct', 'wheelOtmPct', 'wheelTp', 'wheelStop', 'wheelMinPrice', 'wheelMaxPrice', 'wheelMaxPositions', 'wheelTrend'].every(k => document.getElementById('st-' + k)), read: (() => { const c = window.stRead(); return [c.wheelOn, c.wheelSharePct]; })() }));
    check('wheel: section 4d shows its settings; switched on at 10% it takes its share (Stocks 60% → 50%) and is read for saving', w.sec && w.f && /Stocks 50%.*Wheel 10%/.test(w.note) && w.read[0] === true && w.read[1] === 10, JSON.stringify(w)); }
  await page.fill('#st-callSharePct', '80'); await page.evaluate(() => document.querySelector('#st-callSharePct').dispatchEvent(new Event('change', { bubbles: true }))); await page.waitForTimeout(250);
  check('wheel: its share counts toward 100% (CALLs 80 + PUTs 10 + SPY 5 + wheel 10 = 105% is refused)', await page.evaluate(() => /\+ wheel 10% = 105%/.test([...document.querySelectorAll('[role="status"]')].map(e => e.textContent).join(' ')) && document.querySelector('[data-st="save"]').disabled));
  await page.evaluate(() => { const r = document.querySelector('#st-wheelOn'); if (r && r.checked) { r.checked = false; r.dispatchEvent(new Event('change', { bubbles: true })); } }); await page.waitForTimeout(250);
  await page.fill('#st-callSharePct', '90'); await page.evaluate(() => document.querySelector('#st-callSharePct').dispatchEvent(new Event('change', { bubbles: true }))); await page.waitForTimeout(300);
  const overErr = await page.evaluate(() => ({ n: document.querySelectorAll('[role="status"]').length, txt: [...document.querySelectorAll('[role="status"]')].map(e => e.textContent).join(' | '), dis: document.querySelector('[data-st="save"]').disabled }));
  check('money shares over 100% (CALLs 90 + PUTs 10 + SPY 5): an error shows in sections 3 and 4c and on the save bar, and Save is disabled', overErr.n >= 3 && overErr.dis && /= 105% — 5% more than the whole stake/.test(overErr.txt), JSON.stringify(overErr));
  await page.fill('#st-callSharePct', '25'); await page.evaluate(() => document.querySelector('#st-callSharePct').dispatchEvent(new Event('change', { bubbles: true }))); await page.waitForTimeout(300);
  check('money shares back under 100%: the error clears and Save is enabled again', await page.evaluate(() => document.querySelectorAll('[role="status"]').length === 0 && !document.querySelector('[data-st="save"]').disabled));
  // a stock list with a ticker the bot would drop is refused
  await page.evaluate(() => { const r = document.querySelector('input[name="st-universe"][value="list"]'); if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } }); await page.waitForTimeout(300);
  const symEl = await page.$('#st-symbols');
  if (symEl) {
    const before = await page.$eval('#st-symbols', e => e.value);
    await page.fill('#st-symbols', 'AAPL, BRK-B'); await page.evaluate(() => document.querySelector('[data-st="save"]').click()); await page.waitForTimeout(500);
    const m = await page.evaluate(() => (document.querySelector('[data-st="save"]').parentElement.textContent || '').replace(/\s+/g, ' '));
    check('settings: a ticker the bot would drop (BRK-B) is refused with a hint (use BRK.B), and nothing is saved', /BRK-B/.test(m) && /BRK\.B/.test(m) && puts.length === 0, m.slice(0, 200));
    await page.fill('#st-symbols', before);
  }
  await page.evaluate(() => { const r = document.querySelector('input[name="st-universe"][value="scan"]'); if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } }); await page.waitForTimeout(300);
  // out-of-range values are refused, not silently changed by the bot
  await page.fill('#st-spyEnd', '15:45'); await page.evaluate(() => document.querySelector('#st-spyEnd').dispatchEvent(new Event('change', { bubbles: true })));
  await page.fill('#st-stockPct', '50'); await page.evaluate(() => document.querySelector('#st-stockPct').dispatchEvent(new Event('change', { bubbles: true })));
  await page.evaluate(() => document.querySelector('[data-st="save"]').click()); await page.waitForTimeout(600);
  const badMsg = await page.evaluate(() => (document.querySelector('[data-st="save"]').parentElement.textContent || '').replace(/\s+/g, ' '));
  check('settings: a value the bot would clamp (per-trade 50%, SPY until 15:45) is refused with a message naming both, and nothing is saved', /Not saved/.test(badMsg) && /50/.test(badMsg) && /SPY trades until/.test(badMsg) && puts.length === 0, badMsg.slice(0, 200) + ' puts=' + puts.length);
  await page.fill('#st-spyEnd', '14:00'); await page.evaluate(() => document.querySelector('#st-spyEnd').dispatchEvent(new Event('change', { bubbles: true })));
  await page.fill('#st-stockPct', '12'); await page.evaluate(() => document.querySelector('#st-stockPct').dispatchEvent(new Event('change', { bubbles: true })));
  // a window that ends before it starts, an empty box and a nonsense stake are refused too (the bot would silently never trade / keep the old value)
  { const setv = async (id, v) => { await page.fill(id, v); await page.evaluate(i => document.querySelector(i).dispatchEvent(new Event('change', { bubbles: true })), id); };
    await setv('#st-spyStart', '11:30'); await setv('#st-spyEnd', '10:30'); await setv('#st-maxHold', ''); if (await page.$('#st-stakeUsd')) await setv('#st-stakeUsd', '-5');
    await page.evaluate(() => document.querySelector('[data-st="save"]').click()); await page.waitForTimeout(600);
    const m2 = await page.evaluate(() => (document.querySelector('[data-st="save"]').parentElement.textContent || '').replace(/\s+/g, ' '));
    check('settings: an inverted SPY window, an empty box and a negative stake are refused with plain messages, nothing saved', /Not saved/.test(m2) && /must be at least/.test(m2) && /empty/.test(m2) && puts.length === 0, m2.slice(0, 300));
    await setv('#st-spyStart', '09:50'); await setv('#st-spyEnd', '14:00'); await setv('#st-maxHold', '10'); if (await page.$('#st-stakeUsd')) await setv('#st-stakeUsd', ''); }
  check('SPY money per trade: the field sits in 3 · Capital allocation beside the SPY share and shows the saved value (default 100)', await page.evaluate(want => { const el = document.getElementById('st-spyTradePct'); return !!el && el.value === want && !!el.closest('#sec-3-capital-allocation') && !!document.getElementById('st-spySharePct').closest('#sec-3-capital-allocation'); }, String((JSON.parse(fs.readFileSync(path.join(ROOT, 'bot/config.json'), 'utf8')).spyTradePct) ?? 100)));   // never assume the owner's saved value
  await page.fill('#st-spyTradePct', '50'); await page.evaluate(() => document.querySelector('#st-spyTradePct').dispatchEvent(new Event('change', { bubbles: true }))); await page.waitForTimeout(200);
  check('SPY money per trade: the allocation note shows the per-trade amount (dollars when the account size is known, otherwise %)', /up to (\$2,500|50% of it) per trade/.test(await page.evaluate(() => (document.querySelector('#stSplitNote') || {}).textContent || '')), await page.evaluate(() => (document.querySelector('#stSplitNote') || {}).textContent || ''));
  await page.fill('#st-spyTp', '20'); await page.evaluate(() => document.querySelector('#st-spyTp').dispatchEvent(new Event('change', { bubbles: true })));
  check('leaders first: the strategy section offers the choice, with Leaders first selected by default', await page.evaluate(() => { const r = document.querySelector('input[name="st-pickBy"]:checked'); return !!r && r.value === 'leaders' && document.querySelectorAll('input[name="st-pickBy"]').length === 2; }));
  await page.evaluate(() => { const r = document.querySelector('input[name="st-pickBy"][value="dip"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }); await page.waitForTimeout(300);
  // win-rate settings (2026-10-27): both sell rules, the profit %, the market filter
  check('sell rule: Strategy offers “First profitable close” and “On the bounce”, the profit % and the market filter', await page.evaluate(() => !!document.querySelector('input[name="st-exitRule"][value="profit"]') && !!document.querySelector('input[name="st-exitRule"][value="bounce"]') && !!document.getElementById('st-exitProfitPct') && !!document.getElementById('st-marketFilter')));
  await page.evaluate(() => { for (const v of ['bounce', 'profit']) { const r = document.querySelector(`input[name="st-exitRule"][value="${v}"]`); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } const m = document.getElementById('st-marketFilter'); m.checked = true; m.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.fill('#st-exitProfitPct', '0.7'); await page.evaluate(() => document.querySelector('#st-exitProfitPct').dispatchEvent(new Event('change', { bubbles: true }))); await page.waitForTimeout(300);
  check('option sell rule: Strategy offers “Only at its take-profit, stop or time limit” / “Also when the stock bounces back” and the expiry field', await page.evaluate(() => !!document.querySelector('input[name="st-optExit"][value="target"]') && !!document.querySelector('input[name="st-optExit"][value="bounce"]') && !!document.getElementById('st-optDays')));
  await page.evaluate(() => { const r = document.querySelector('input[name="st-optExit"][value="target"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.fill('#st-optDays', '30'); await page.evaluate(() => document.querySelector('#st-optDays').dispatchEvent(new Event('change', { bubbles: true })));
  check('sell rule: the label follows the profit % typed in', /once it is 0\.7%\+ above the buy price/.test(await page.evaluate(() => document.querySelector('input[name="st-exitRule"][value="profit"]').parentElement.textContent)));
  await page.evaluate(() => document.querySelector('[data-st="save"]').click());
  let msg = '';
  for (let i = 0; i < 80; i++) { await page.waitForTimeout(250); msg = await page.evaluate(() => (document.querySelector('[data-st="save"]').parentElement.textContent || '').replace(/\s+/g, ' ')); if (/Saved|failed/.test(msg)) break; }
  check('settings: Save reaches GitHub with the typed value', puts.length === 1 && JSON.parse(Buffer.from(puts[0].content, 'base64')).rsiThreshold === 12, msg.slice(0, 120));
  check('money split: Save writes the split and the CALL / PUT shares to config.json', puts.length === 1 && (c => c.split === true && c.callSharePct === 25 && c.putSharePct === 10 && c.optDayCap === 10 && c.pickBy === 'dip' && c.spyOn === true && c.spySharePct === 5 && c.spyTp === 20 && c.spyStart === '09:50' && c.spyTradePct === 50)(JSON.parse(Buffer.from(puts[0].content, 'base64'))), puts.length ? Buffer.from(puts[0].content, 'base64').toString().slice(0, 0) : 'no save');
  check('sell rule: Save writes the sell rule, its % and the market filter to config.json', puts.length === 1 && (c => c.exitRule === 'profit' && c.exitProfitPct === 0.7 && c.marketFilter === true)(JSON.parse(Buffer.from(puts[0].content, 'base64'))));
  check('option sell rule: Save writes the option sell rule and the expiry', puts.length === 1 && (c => c.optExit === 'target' && c.optDays === 30)(JSON.parse(Buffer.from(puts[0].content, 'base64'))));
  check('settings: Save bar reports success', /Saved /.test(msg), msg.slice(0, 120));
  check('settings: no script error during save', errors.length === 0, errors.join(' | '));
  // Telegram connect: token check → finds the chat from the owner's /start → test message → both values sealed as secrets
  const tgSent = []; let tgUpd = [];
  await page.route('https://api.telegram.org/**', r => { const m3 = r.request().url().split('/').pop(); const ok = res => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: res }) });
    if (m3 === 'getMe') return ok({ username: 'lithvik_sd_bot' }); if (m3 === 'getUpdates') return ok(tgUpd); if (m3 === 'sendMessage') { tgSent.push(JSON.parse(r.request().postData())); return ok({ message_id: 1 }); } return r.abort(); });
  await page.fill('#st-tgtok', '123456789:AAHxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'); await page.evaluate(() => document.querySelector('[data-st="tgconnect"]').click());
  let tm = ''; for (let i = 0; i < 20 && !/Almost there/.test(tm); i++) { await page.waitForTimeout(150); tm = await page.textContent('#tgMsg'); }
  check('telegram: Connect asks the owner to press Start in the bot when no message has arrived yet', /Almost there/.test(tm) && /lithvik_sd_bot/.test(tm), tm);
  const code = (/code (\d{6})/.exec(tm) || [])[1];
  check('telegram: Connect shows a one-time code (only the chat that sends it is connected)', !!code, tm);
  tgUpd = [{ update_id: 1, message: { chat: { id: 9999, type: 'private', first_name: 'Stranger' }, text: '/start', date: 1 } }];   // someone else messaging the public bot first
  await page.evaluate(() => document.querySelector('[data-st="tgconnect"]').click());
  tm = ''; for (let i = 0; i < 20 && !/Almost there/.test(tm); i++) { await page.waitForTimeout(150); tm = await page.textContent('#tgMsg'); }
  check('telegram: a stranger\'s message without the code is not connected', /Almost there/.test(tm) && !tgSent.some(x => x.chat_id === 9999), tm);
  tgUpd = [tgUpd[0], { update_id: 2, message: { chat: { id: 4242, type: 'private', first_name: 'Hari' }, text: '/start ' + code, date: 1 } }];
  await page.evaluate(() => document.querySelector('[data-st="tgconnect"]').click());
  for (let i = 0; i < 60 && !(secretPuts.some(x => x.name === 'TELEGRAM_CHAT')); i++) await page.waitForTimeout(250);
  check('telegram: Connect sends a test message to the chat and stores TELEGRAM_TOKEN + TELEGRAM_CHAT as sealed secrets', tgSent.some(x => x.chat_id === 4242 && /Connected to Signal Desk/.test(x.text)) && ['TELEGRAM_TOKEN', 'TELEGRAM_CHAT'].every(n => secretPuts.some(x => x.name === n && x.encrypted_value)), JSON.stringify(secretPuts.map(x => x.name)) + ' ' + (await page.textContent('#tgMsg').catch(() => '')) + ' ' + errors.join(' | '));
  secretPuts.length = 0;
  // Save keys: a key is sealed in the browser (libsodium) and sent as a GitHub secret
  await page.fill('#st-akey', 'PKTESTKEY1234567890');
  await page.evaluate(() => document.querySelector('[data-st="keys"]').click());
  let km = ''; for (let i = 0; i < 60 && !secretPuts.length && !/failed/i.test(km); i++) { await page.waitForTimeout(250); km = await page.evaluate(() => document.body.innerText.match(/Saving keys failed[^\n]*|Saved[^\n]*secret[^\n]*/i)?.[0] || ''); }
  check('keys: Save keys seals the Alpaca key in the browser and stores it as the ALPACA_KEY secret', secretPuts.some(x => x.name === 'ALPACA_KEY' && x.key_id === 'kid1' && Buffer.from(x.encrypted_value, 'base64').length === 48 + 'PKTESTKEY1234567890'.length), km + ' ' + JSON.stringify(secretPuts.map(x => x.name)) + ' ' + errors.join(' | '));
  // India bot settings: own section, own file
  await page.evaluate(() => document.querySelector('#mkSw [data-mkt="IN"]').click()); await page.waitForTimeout(800);   // India's settings sit behind the market switch
  await page.fill('#in-stakeInr', '500000'); await page.evaluate(() => document.querySelector('[data-st="insave"]').click());
  for (let i = 0; i < 40 && !inPuts.length; i++) await page.waitForTimeout(150);
  const inSaved = inPuts[0] && JSON.parse(Buffer.from(inPuts[0].content, 'base64').toString());
  check('India settings: Save writes bot/config-in.json with the typed stake and leaves config.json alone', !!inSaved && inSaved.stakeInr === 500000 && inSaved.breakout === true && !inSaved.resetAt, JSON.stringify(inSaved));
  await page.evaluate(() => document.querySelector('[data-st="inreset"]').click()); await page.waitForTimeout(200);
  const armed = inPuts.length === 1; await page.evaluate(() => document.querySelector('[data-st="inreset"]').click());
  for (let i = 0; i < 40 && inPuts.length < 2; i++) await page.waitForTimeout(150);
  const rs = inPuts[1] && JSON.parse(Buffer.from(inPuts[1].content, 'base64').toString());
  check('India settings: Restart needs a second press, then saves a reset time', armed && !!rs && !!rs.resetAt, JSON.stringify(rs));
  check('settings: no CSP violation connecting Telegram or saving keys', (await page.evaluate(() => window.__csp)).length === 0, JSON.stringify(await page.evaluate(() => window.__csp)));
  await page.close();
}
// 2c. the opposite of the owner's sell rules saved: they load, a radio changed by a click marks the form unsaved and survives a
//     trip to another tab, Save works on the first click after typing, and a day-trading window hidden while it is off is kept
{
  const { page, errors, puts } = await session('settings with the opposite sell rules saved', () => { localStorage.clear(); localStorage.setItem('sd-ghtok', JSON.stringify('ghp_fake')); localStorage.setItem('sd-ghrepo', JSON.stringify('x/y')); },
    { exitRule: 'bounce', optExit: 'bounce', marketFilter: false, exitProfitPct: 1.5, optDays: 30, pickBy: 'dip', dayTrade: false, dayStart: '10:05', dayEnd: '14:10' });
  const saved = () => puts.map(p => JSON.parse(Buffer.from(p.content, 'base64').toString()));
  const bar = () => page.evaluate(() => (document.querySelector('[data-st="save"]').parentElement.textContent || '').replace(/\s+/g, ' '));
  const form = () => page.evaluate(() => { const r = n => (document.querySelector(`input[name="${n}"]:checked`) || {}).value || null;
    return { exitRule: r('st-exitRule'), optExit: r('st-optExit'), pickBy: r('st-pickBy'), universe: r('st-universe'), marketFilter: document.getElementById('st-marketFilter').checked, exitProfitPct: document.getElementById('st-exitProfitPct').value, optDays: document.getElementById('st-optDays').value }; });
  const unsaved = () => page.evaluate(() => { const d = document.getElementById('stDirty'); return !!d && d.style.display !== 'none'; });
  await page.evaluate(() => document.querySelector('#tabs [data-t="SET"]').click()); await page.waitForTimeout(1200);
  const f0 = await form();
  check('sell rules: a saved “On the bounce”, “Also when the stock bounces back”, “Deepest dip first”, market filter off, 1.5% and 30 days load into the form', f0.exitRule === 'bounce' && f0.optExit === 'bounce' && f0.pickBy === 'dip' && f0.marketFilter === false && f0.exitProfitPct === '1.5' && f0.optDays === '30', JSON.stringify(f0));
  await page.click('input[name="st-optExit"][value="target"]'); await page.waitForTimeout(300);
  const dirty1 = await unsaved();
  await page.click('input[name="st-exitRule"][value="profit"]'); await page.click('input[name="st-pickBy"][value="leaders"]'); await page.click('input[name="st-universe"][value="list"]'); await page.click('#st-marketFilter'); await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('#tabs [data-t="BOT"]').click()); await page.waitForTimeout(600);
  await page.evaluate(() => document.querySelector('#tabs [data-t="SET"]').click()); await page.waitForTimeout(800);
  const f1 = await form();
  check('settings radios: a click marks the form “unsaved changes” and the choice survives a trip to another tab', dirty1 && await unsaved() && f1.optExit === 'target' && f1.exitRule === 'profit' && f1.pickBy === 'leaders' && f1.universe === 'list' && f1.marketFilter === true, JSON.stringify({ dirty1, f1 }));
  // out of range: refused with both names, nothing sent
  for (const [id, v] of [['#st-exitProfitPct', '6'], ['#st-optDays', '61']]) { await page.fill(id, v); await page.evaluate(i => document.querySelector(i).dispatchEvent(new Event('change', { bubbles: true })), id); }
  await page.waitForTimeout(200); await page.evaluate(() => document.querySelector('[data-st="save"]').click()); await page.waitForTimeout(500);
  const m0 = await bar();
  check('sell rules: a profit % or option expiry the bot would clamp (6%, 61 days) is refused with both named, nothing saved', /Not saved/.test(m0) && /Profit needed to sell must be between 0\.1 and 5/.test(m0) && /Option expiry, at least must be between 7 and 60/.test(m0) && puts.length === 0, m0.slice(0, 300));
  await page.fill('#st-optDays', '21'); await page.evaluate(() => document.querySelector('#st-optDays').dispatchEvent(new Event('change', { bubbles: true })));
  // type a value and press Save straight away: leaving the box redraws the form, which used to swallow that first click
  await page.click('#st-exitProfitPct', { clickCount: 3 }); await page.keyboard.type('0.8');
  await page.click('[data-st="save"]');
  for (let i = 0; i < 60 && !puts.length; i++) await page.waitForTimeout(150);
  const s1 = saved()[0] || {};
  check('settings: typing “Profit needed to sell” and pressing Save once saves it (the first click is no longer swallowed)', puts.length === 1 && s1.exitProfitPct === 0.8, `puts=${puts.length} ` + (await bar()).slice(0, 160));
  check('sell rules: the clicked choices are saved — profit / target / leaders first / my list / market filter on, expiry 21 days', s1.exitRule === 'profit' && s1.optExit === 'target' && s1.pickBy === 'leaders' && s1.universe === 'list' && s1.marketFilter === true && s1.optDays === 21, JSON.stringify(s1).slice(0, 200));
  check('day trading off: Save keeps the hidden day-trading window (10:05–14:10) instead of resetting it to 9:45–3:30', s1.dayTrade === false && s1.dayStart === '10:05' && s1.dayEnd === '14:10', `${s1.dayStart}–${s1.dayEnd}`);
  for (let i = 0; i < 40 && !/Saved /.test(await bar()); i++) await page.waitForTimeout(150);
  // the same for a profile number: the profile flips to Custom (a redraw) and the first click still saves
  await page.click('#st-riskPct', { clickCount: 3 }); await page.keyboard.type('0.8');
  await page.click('[data-st="save"]');
  for (let i = 0; i < 60 && puts.length < 2; i++) await page.waitForTimeout(150);
  const s2 = saved()[1] || {};
  check('settings: typing a risk number and pressing Save once saves it as a Custom profile', puts.length === 2 && s2.riskPct === 0.8 && s2.preset === 'custom', `puts=${puts.length} ${s2.preset} ${s2.riskPct}`);
  check('settings (opposite values): no script errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
// 2b. the header's market switch: every market tab follows it, shared tabs stay
{
  const { page, errors } = await session('market switch', () => { localStorage.clear(); localStorage.setItem('sd-tab', JSON.stringify('US')); });
  const h2 = async t => { await page.evaluate(t => document.querySelector(`#tabs [data-t="${t}"]`).click(), t); await page.waitForTimeout(500); return page.evaluate(() => (document.querySelector('#view h2') || {}).textContent || ''); };
  await page.evaluate(() => document.querySelector('#mkSw [data-mkt="IN"]').click()); await page.waitForTimeout(400);
  const inDt = await h2('DT'), inOp = await h2('OP'), inSet = await h2('SET'), inBot = await h2('BOT');
  const stocksIsIndia = await page.evaluate(() => { document.querySelector('#tabs [data-t="STK"]').click(); return JSON.parse(localStorage.getItem('sd-tab')) === 'IN'; });
  check('market switch: India drives Stocks, Day trading, Option trading, Bot trades and Bot settings', stocksIsIndia && /India/.test(inDt) && /India/.test(inOp) && /India bot/.test(inSet) && /India bot/.test(inBot), [inDt, inOp, inSet, inBot].join(' | '));
  await page.evaluate(() => document.querySelector('#mkSw [data-mkt="US"]').click()); await page.waitForTimeout(400);
  const usDt = await h2('DT'), usSet = await h2('SET');
  check('market switch: back to USA, one Stocks tab, the choice is remembered, no in-tab switches left', /USA/.test(usDt) && /USA bot/.test(usSet) && (await page.$$('#tabs [data-t="IN"], [data-dtm], [data-opm], [data-botmk]')).length === 0 && JSON.parse(await page.evaluate(() => localStorage.getItem('sd-mkt'))) === 'US', usDt + ' | ' + usSet);
  check('market switch: no script errors', errors.length === 0, errors.join(' | '));
  await page.close();
}
// 3. sign in anywhere: device A syncs (token + holdings inside the encrypted blob), device B signs in with the passphrase only
{
  let blob = null, sha = null;
  const gh = async route => { const u = new URL(route.request().url()), m = route.request().method(), p = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    const json = (st, b) => route.fulfill({ status: st, contentType: 'application/json', body: JSON.stringify(b) });
    if (p === '/contents/user/settings.enc.json' && m === 'PUT') { blob = Buffer.from(JSON.parse(route.request().postData()).content, 'base64').toString(); sha = 's' + Date.now(); return json(200, { content: { sha } }); }
    if (p === '/contents/user/settings.enc.json') return blob ? json(200, { sha, content: Buffer.from(blob).toString('base64') }) : json(404, { message: 'Not Found' });
    return json(404, { message: 'nf' }); };
  const A = await browser.newContext(), a = await A.newPage(); const errA = []; a.on('pageerror', e => errA.push(e.message));
  await a.route('https://api.github.com/**', gh); await a.goto(base, { waitUntil: 'networkidle' });
  await a.evaluate(() => { localStorage.setItem('sd-ghtok', JSON.stringify('github_pat_TEST')); localStorage.setItem('sd-ghrepo', JSON.stringify('x/y')); localStorage.setItem('sd-jkey', JSON.stringify('correct horse battery')); localStorage.setItem('sd-pf', JSON.stringify({ A: { sym: 'AAPL', market: 'US', qty: 7, cost: 100, pfid: 'p1' } })); });
  await a.reload({ waitUntil: 'networkidle' }); await a.waitForTimeout(2500);
  check('sign-in: the first device saves an encrypted blob to the repo', !!blob && !/github_pat_TEST|AAPL/.test(blob), 'blob missing or not encrypted');
  const B = await browser.newContext(), b = await B.newPage(); const errB = []; b.on('pageerror', e => errB.push(e.message));
  await b.route('https://api.github.com/**', gh); await b.route(/https:\/\/[a-z0-9-]+\.github\.io\/.*settings\.enc\.json/, r => blob ? r.fulfill({ status: 200, contentType: 'application/json', body: blob }) : r.fulfill({ status: 404, body: 'nf' }));
  await b.goto(base, { waitUntil: 'networkidle' }); await b.click('#acctBtn'); await b.waitForTimeout(300);
  await b.fill('#signPass', 'wrong passphrase here'); await b.click('#signGo'); await b.waitForTimeout(1500);
  check('sign-in: a wrong passphrase is refused with a clear message', /does not open/.test(await b.$eval('#signStat', e => e.textContent)));
  await b.fill('#signPass', 'correct horse battery'); await b.click('#signGo'); await b.waitForTimeout(2500);
  check('sign-in: the passphrase alone installs the token and the holdings on a new device', (await b.evaluate(() => localStorage.getItem('sd-ghtok'))) === JSON.stringify('github_pat_TEST') && /AAPL/.test(await b.evaluate(() => localStorage.getItem('sd-pf') || '')));
  await b.click('#acctBtn'); await b.waitForTimeout(200); await b.click('#signLeave'); await b.click('#signLeave'); await b.waitForTimeout(1200);
  check('sign-in: sign out wipes the device', (await b.evaluate(() => localStorage.getItem('sd-ghtok'))) === null && (await b.evaluate(() => localStorage.getItem('sd-pf'))) === null);
  // passphrase changed on purpose: the saved file is re-encrypted only after an explicit, confirmed press — then the new passphrase opens it and the old one does not
  { const before = blob; a.on('dialog', d => d.accept());
    await a.evaluate(async () => { localStorage.setItem('sd-jkey', JSON.stringify('a brand new passphrase')); if (!document.getElementById('syStat')) { const d = document.createElement('div'); d.id = 'syStat'; document.body.appendChild(d); } await syncPull(true); renderSyncBtn(); });
    const hasBtn = !!(await a.$('#syReenc'));
    check('sync: after a passphrase change the page offers “Re-encrypt with this passphrase” (it does not overwrite silently)', hasBtn && blob === before);
    if (hasBtn) { await a.click('#syReenc'); for (let i = 0; i < 40 && blob === before; i++) await a.waitForTimeout(250); }
    const opens = await a.evaluate(async b => { const j = JSON.parse(b); let n = false, o = false; try { await jDecrypt(j, 'a brand new passphrase'); n = true; } catch (e) {} try { await jDecrypt(j, 'correct horse battery'); o = true; } catch (e) {} return { n, o }; }, blob);
    check('sync: re-encrypted — the new passphrase opens the saved file, the old one no longer does', blob !== before && opens.n && !opens.o, JSON.stringify(opens)); }
  check('sign-in: no script errors on either device', errA.length + errB.length === 0, errA.concat(errB).join(' | '));
  await A.close(); await B.close();
}
// 4. Bot trades rendered with real-looking data (the live journal is encrypted, so without this the cards are never executed)
const profitFx = path.join(os.tmpdir(), 'sd-journal-profit.json');            // the full journal under the win-rate settings: profit sell rule, market filter blocking
{ const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/fixtures/journal-full.json'), 'utf8'));
  // the owner's settings of 2026-10-27 \u2014 CALLs only at take-profit / stop / time, PUTs 0% and switched off \u2014 plus a stock take-profit
  // of 0 (off) and a 21-day option window, to show those texts follow the settings; a SPY quick trade among the holdings
  j.settings = { ...j.settings, exitRule: 'profit', exitProfitPct: 0.5, marketFilter: true, maxHold: 15, optExit: 'target', optTakeProfit: 5, optStop: 90, optDays: 21, stockTp: 0, puts: false, callSharePct: 20, putSharePct: 0, spySharePct: 10, spyTp: 5, spyStop: 35, spyHoldMin: 60 };
  j.split = { ...j.split, shares: { call: 20, put: 0, spy: 10, stock: 70 }, stock: { ...j.split.stock, money: 70000 }, call: { ...j.split.call, money: 20000 }, put: { ...j.split.put, money: 0, today: 0 }, spy: { ...j.split.spy, money: 10000 } };
  j.spy = { ...j.spy, rules: { tp: 5, stop: 35, holdMin: 60, dte: 1, tradePct: 20, maxOpen: 3 } };
  j.env = { ...j.env, reasons: ['Market filter: SPY closed at 540, below its 200-day average 552 \u2014 no new dip buys (stocks and CALLs); open positions are managed as usual'] };
  j.open = j.open.filter(o => o.kind !== 'Put');
  j.watch = { ...j.watch, exitRule: 'profit', exitPct: 0.5, mktFilter: true, maxHold: 15, on: { stocks: true, calls: true, puts: false }, put: [], idle: 'market filter: SPY closed at 540, below its 200-day average 552 \u2014 no new dip buys',
    held: (j.watch.held || []).map(h => h.kind === 'stock' ? { ...h, exitBy: 'profit', exitLevel: 412.05 } : { ...h, exitBy: 'target', exitLevel: null, tp: 430.5, stop: 41 })
      .concat([{ s: 'SPY261024C00502000', und: 'SPY', kind: 'call', qty: 20, avg: 205, cur: 210, pl: 100, plpc: 2.4, undPx: 502.7, exitLevel: null, exitSide: 'above', exitBy: 'spy', tp: 215.25, stop: 133.25, holdMin: 60 }]) };
  fs.writeFileSync(profitFx, JSON.stringify(j)); }
// the wheel (2026-10-29): a sold KO put with its buy-back order, PEP shares a put delivered, a put bought back earlier, its money part
const wheelFx = path.join(os.tmpdir(), 'sd-journal-wheel.json');
{ const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/fixtures/journal-full.json'), 'utf8'));
  j.settings = { ...j.settings, wheelOn: true, wheelSharePct: 10, callSharePct: 20, putSharePct: 0, spySharePct: 10 };
  j.split = { ...j.split, shares: { call: 20, put: 0, spy: 10, wheel: 10, stock: 60 }, wheel: { money: 10000, used: 20620, today: 12, limitPct: 100, halted: null } };
  j.wheel = { at: j.at, on: true, share: 10, money: 10000, used: 20620, free: -10620, idle: null, window: { open: false, days: ['2026-11-23', '2026-11-24', '2026-11-25'], expiry: '2026-12-18' },
    opts: [{ s: 'KO261120P00065000', und: 'KO', kind: 'put', K: 65, exp: '2026-11-20', qty: 1, prem: 90, cur: 60, pl: 30, tp: 45, since: '2026-10-19' }],
    shares: [{ und: 'PEP', qty: 100, cost: 138.5, px: 141.2, pl: 270, since: '2026-10-19' }], working: [], rules: { otm: 5, tp: 50, stop: 0, trend: true, minPx: 15, maxPx: 150, maxPos: 3 } };
  j.open = j.open.concat([{ sym: 'KO261120P00065000', und: 'KO', kind: 'Put', exp: '2026-11-20', strike: 65, mult: 100, qty: -1, avg: 0.9, now: 0.6, pl: 30, plPct: 33.33, since: '2026-10-19T14:05:00Z', short: true, wheel: true },
    { sym: 'PEP', und: 'PEP', kind: 'Stock', mult: 1, qty: 100, avg: 140, now: 141.2, pl: 120, plPct: 0.86, since: '2026-10-17T20:00:00Z', wheel: true }]);
  j.closed = [{ sym: 'KO261016P00064000', und: 'KO', kind: 'Put', exp: '2026-10-16', strike: 64, mult: 100, qty: 1, inPx: 0.85, inT: '2026-09-21T14:05:00Z', outPx: 0.42, outT: '2026-10-02T15:00:00Z', pl: 43, plPct: 50.59, short: true, wheel: true }].concat(j.closed);
  fs.writeFileSync(wheelFx, JSON.stringify(j)); }
for (const [fx, label] of [['journal-full.json', 'full journal (stock, CALL, PUT, SPY and day-trade rows)'], ['journal-old.json', 'older journal shape (no watch rows, no split, no spy, no day block)'], [profitFx, 'profit sell rule and market filter'], [wheelFx, 'the wheel (sold put, delivered shares)']]) {
  journalFixture = fx;
  const { page, errors } = await session('bot trades · ' + label, () => { localStorage.clear(); localStorage.setItem('sd-mkt', JSON.stringify('US')); });
  await page.evaluate(() => document.querySelector('#tabs [data-t="BOT"]').click()); await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelectorAll('main details').forEach(d => { d.open = true; }));
  const txt = await page.evaluate(() => document.querySelector('main').innerText.replace(/\s+/g, ' '));
  if (fx === wheelFx) {
    check('wheel: its card lists the sold put (buy-back at $45.00 a contract, expiry) and the delivered shares (cost $138.50)', /Wheel — cash-secured puts & covered calls/.test(txt) && /KO PUT sold 65\.00 · 11-20/.test(txt) && /bought back at \$45\.00, else expires Fri, Nov 20 · \$6,500 set aside/.test(txt) && /PEP shares 100 \$138\.50/.test(txt) && /Next sale window: Mon, Nov 23, Tue, Nov 24, Wed, Nov 25/.test(txt), (txt.match(/Wheel — cash.{0,700}/) || [''])[0]);
    check('wheel: Open now names a sold option and its shares as the wheel\'s, and money in trades counts what it set aside', /Option sold/.test(txt) && /Wheel — cash-secured put sold: a resting order buys it back at \$45\.00/.test(txt) && /Stock \(wheel\)/.test(txt) && /Wheel — shares a put delivered \(cost \$138\.50/.test(txt) && /wheel \$20,620 set aside/.test(txt), (txt.match(/Money in trades now.{0,300}/) || [''])[0]);
    check('wheel: a put bought back shows when it was sold and bought back, at what prices, +$43.00', /KO PUT sold 64 · 10-16/.test(txt) && /bought back Oct 2/.test(txt) && /sold first Sep 21/.test(txt) && /\+\$43\.00/.test(txt), (txt.match(/KO PUT sold 64.{0,200}/) || [''])[0]);
    check('wheel: the money split has a Wheel card with its $10,000 and no daily loss limit', /Wheel › .{0,40}\$10,000/.test(txt) && /No daily loss limit: its puts run for weeks/.test(txt), (txt.match(/Wheel ›.{0,200}/) || [''])[0]);
    await page.evaluate(() => document.querySelector('main [data-drill="part"][data-arg="wheel"]').click()); await page.waitForTimeout(150);
    const wd = await page.evaluate(() => (document.getElementById('drill') || {}).innerText.replace(/\s+/g, ' ') || ''); await page.keyboard.press('Escape'); await page.waitForTimeout(80);
    check('wheel: its detail sheet shows what is set aside, the next window and its trades', /Wheel \(cash-secured puts & covered calls\)/.test(wd) && /Set aside now \$20,620\.00/.test(wd) && /Next sale window Mon, Nov 23/.test(wd) && /Daily loss limit none/.test(wd), wd.slice(0, 400));
    { const thNoTip = await page.evaluate(() => [...document.querySelectorAll('main th')].filter(el => el.offsetParent && !el.hasAttribute('data-tip')).map(el => el.textContent.trim()));
      check('wheel: every table heading of its card has an explanation', thNoTip.length === 0, thNoTip.join(' | ')); }
  }
  if (fx === 'journal-full.json') {
    check('bot trades: the money-split cards show all four parts with their money', /Stocks.*\$55,000/.test(txt) && /CALLs.*\$30,000/.test(txt) && /PUTs.*\$10,000/.test(txt) && /SPY quick options.*\$5,000/.test(txt), txt.slice(0, 300));
    check('bot trades: the SPY card shows the open trade with its exits and the 3-mo-vs-market column exists', /SPY quick options/.test(txt) && /in a trade/.test(txt) && /\$235\.75/.test(txt) && /3-mo vs market/.test(txt), txt.slice(0, 200));
    check('bot trades: Open now describes each kind correctly (swing stock, CALL, PUT, SPY quick trade, day trade) from the settings', /RSI-2 swing — sells at \+10%/.test(txt) && /CALL — sells at \+50% or −50%, when the stock closes above its 5-day average/.test(txt) && /PUT — sells at \+50% or −50%, when the stock closes below its 5-day average/.test(txt) && /SPY quick trade — out at \+15%/.test(txt) && /day trade — stop and target at the broker/.test(txt), txt.match(/Open now.{0,900}/)?.[0]);
    check('bot trades: option prices are shown per contract (×100) in the held table and per share in Open now, both labelled', /\$440\.00/.test(txt) && /\$4\.40/.test(txt), '');
    check('bot trades: the rules line reads the cancel time from settings', /cancelled after 45 min/.test(txt));
    { const thNoTip = await page.evaluate(() => [...document.querySelectorAll('main th')].filter(el => el.offsetParent && !el.hasAttribute('data-tip')).map(el => el.textContent.trim()));
      check('hover help: every table heading on Bot trades has an explanation', thNoTip.length === 0, thNoTip.join(' | ')); }
    // drill-down: every clickable label opens a detail sheet built from the journal; ✕ and Escape close it; links inside open further sheets
    { const keys = await page.$$eval('main [data-drill]', els => [...new Set(els.map(e => e.dataset.drill + '|' + (e.dataset.arg || '')))]);
      const bad = [];
      for (const k of keys) { const [d, a] = k.split('|');
        await page.evaluate(([d2, a2]) => document.querySelector(`main [data-drill="${d2}"]${a2 ? `[data-arg="${a2}"]` : ''}`).click(), [d, a]); await page.waitForTimeout(150);
        const t = await page.evaluate(() => { const x = document.getElementById('drill'); return x ? x.innerText : ''; }); if (!t || t.length < 40) bad.push(k);
        await page.keyboard.press('Escape'); await page.waitForTimeout(80); if (await page.$('#drill')) bad.push(k + ' (did not close)'); }
      check(`drill-down: all ${keys.length} clickable labels open a detail sheet and close with Escape`, keys.length >= 14 && !bad.length, bad.join(', ') + ' / ' + keys.join(','));
      await page.evaluate(() => document.querySelector('main [data-drill="realAll"]').click()); await page.waitForTimeout(150);
      await page.evaluate(() => document.querySelector('#drill [data-drill="sym"]').click()); await page.waitForTimeout(150);
      const t2 = await page.evaluate(() => (document.getElementById('drill') || {}).innerText || '');
      await page.click('#drill [data-drillclose="1"].btn'); await page.waitForTimeout(100);
      check('drill-down: a symbol inside a sheet opens that symbol’s own history; ✕ closes it', /— every trade/.test(t2) && !(await page.$('#drill')), t2.slice(0, 120)); }
    // the results row (owner, 2026-10-29): won and lost trades and where the bot stands, in dollars and % of the account before
    // its trades (equity $100,000 − closed +$260 − open +$348.80 = $99,391.20); the day card names the journal's session
    { const res = await page.evaluate(() => [...document.querySelectorAll('.lv.lvres > div')].map(d => d.innerText.replace(/\s+/g, ' ').trim()));
      check('bot trades: a results row — won +$360.00 (+0.36%, 2 trades), lost −$100.00 (−0.10%, 1 trade), so far +$608.80 (+0.61%, in profit)', res.length === 3 && /^Won trades.*\+\$360\.00 \+0\.36% · 2 trades$/.test(res[0]) && /^Lost trades.*−\$100\.00 −0\.10% · 1 trade$/.test(res[1]) && /^Overall so far.*\+\$608\.80 \+0\.61% · in profit$/.test(res[2]), res.join(' | '));
      check('bot trades: the day card shows its % and profit or loss, and before the open names the journal’s day (Sat 24 Oct) — realized that day too', /Sat 24 Oct › \+\$500\.00 \+0\.50% · profit/.test(txt) && /Realized Sat 24 Oct › \+\$300\.00/.test(txt), txt.slice(txt.indexOf('Sat 24 Oct') - 20, txt.indexOf('Sat 24 Oct') + 160));
      await page.evaluate(() => document.querySelector('main [data-drill="won"]').click()); await page.waitForTimeout(150);
      const tw = await page.evaluate(() => (document.getElementById('drill') || {}).innerText.replace(/\s+/g, ' ') || '');
      await page.keyboard.press('Escape'); await page.waitForTimeout(80);
      check('bot trades: the won sheet adds what the winners made on the money they used (+$360 on $5,000 = +7.20%) and lists them', /Won trades — what the winners made/.test(tw) && /\+7\.20% of \$5,000\.00/.test(tw) && /KO/.test(tw) && /SPY/.test(tw) && !/AAPL/.test(tw.replace(/By part.*?(Every winning trade)/, '$1')), tw.slice(0, 400)); }
    // real results since the first trade: the whole account (all four parts) scaled to $100k vs $100k in each fund
    { const sc = await page.evaluate(() => { const c = [...document.querySelectorAll('.card')].find(x => /Since the bot started trading/.test(x.textContent)); return c ? c.innerText.replace(/\s+/g, ' ') : ''; });
      check('since-start card: the real account (+0.60% → $100,600) against SPY, IJH, IWM, VGT and QQQ, each from $100,000, with a per-part breakdown', /\$100,600/.test(sc) && /SPY/.test(sc) && /VGT/.test(sc) && /QQQ/.test(sc) && /\$101,000/.test(sc) && /stocks/.test(sc) && /SPY quick options/.test(sc) && /far too short to judge/.test(sc), sc.slice(0, 400)); }
    // the US 5-year replay card was removed at the owner's request (2026-10-25); the real-results card carries the tax switch and rates
    { const gone = await page.evaluate(() => ![...document.querySelectorAll('.card')].some(x => /The last 5 years/.test(x.textContent)));
      await page.click('[data-h5tax="before"]'); await page.waitForTimeout(300);
      const b = await page.evaluate(() => { const c = [...document.querySelectorAll('.card')].find(x => /Since the bot started trading/.test(x.textContent)); return c ? c.innerText.replace(/\s+/g, ' ') : ''; });
      await page.click('[data-h5tax="after"]'); await page.waitForTimeout(300);
      const a = await page.evaluate(() => { const c = [...document.querySelectorAll('.card')].find(x => /Since the bot started trading/.test(x.textContent)); return c ? c.innerText.replace(/\s+/g, ' ') : ''; });
      check('bot trades: the 5-year card is gone; the real-results card switches before/after tax and has its own tax-rate boxes', gone && !/after tax \(if cashed out today\)/.test(b) && /after tax \(if cashed out today\)/.test(a) && !!(await page.$('#h5st')) && !!(await page.$('#h5lt')), a.slice(0, 200)); }
  } else if (fx === profitFx) {
    check('bot trades: with the profit rule a held stock sells at its profit level (0.5% above the buy price), Open now says so, and the market filter shows as the reason for not entering', /MSFT closes at or above \$412\.05 \(0\.5% above the buy price/.test(txt) && /RSI-2 swing — sells at the first close 0\.5%\+ above the buy price \(max 15 sessions\)/.test(txt) && /not entering now: market filter: SPY closed at 540/.test(txt) && /CALL — sells at \+5% or −90%, after 15 sessions, or 3 days before expiry/.test(txt), txt.match(/Open now.{0,600}/)?.[0]);
    check('bot trades: a stock take-profit of 0 (off) is left out of Open now, not shown as “+0%”', !/sells at \+0%/.test(txt));
    check('bot trades: the holdings table shows a CALL under “take-profit, stop or time limit” and a SPY quick trade with its own exits', /its take-profit or stop \(next column\), or after 15 sessions/.test(txt) && /SPY quick trade: its take-profit or stop \(next column\), or after 60 minutes/.test(txt) && /take-profit at \$215\.25\/contract · stop at \$133\.25\/contract · flat by 3:45 PM/.test(txt), txt.match(/What it holds and when it sells.{0,900}/)?.[0]);
    check('bot trades: PUTs at 0% and switched off say “switched off” (not “no money set” with a $0 loss limit)', /PUTs › switched off/.test(txt) && /Switched off in Bot settings — no new PUTs\./.test(txt) && !/loses 10% of its money \(\$0\)/.test(txt), txt.match(/PUTs ›.{0,200}/)?.[0]);
    check('bot trades: the market check names the market filter, and the option note follows the 21-day expiry setting', /No new dip buys — the market filter holds back new stocks and CALLs/.test(txt) && /options at the nearest strike 21–42 days out/.test(txt), txt.match(/market check.{0,200}/)?.[0]);
    { await page.evaluate(() => document.querySelector('main [data-drill="part"][data-arg="put"]').click()); await page.waitForTimeout(150);
      const t = await page.evaluate(() => (document.getElementById('drill') || {}).innerText || ''); await page.keyboard.press('Escape');
      check('drill-down: the PUTs sheet says switched off and shows no daily loss limit', /switched off in Bot settings — no new PUTs/.test(t) && !/Stops for the day at/.test(t), t.slice(0, 200)); }
  } else if (fx === 'journal-old.json') {
    check('bot trades: an older journal without watch rows / split / spy renders without a blank page', /Bot trades|Your bot/.test(txt) && txt.length > 500, txt.slice(0, 200));
    check('bot trades: an older journal shows its partial engine and risk figures without NaN (no “every NaN s”, no “undefined%”)', /engine/.test(txt) && /each stock trade risks at most 0\.5%/.test(txt) && /RSI-2 fell below 10/.test(txt), txt.match(/engine.{0,120}/)?.[0]);
  }
  check(`bot trades (${label}): no “undefined”, “NaN” or “null” on the page`, !/\b(undefined|NaN|null)\b/.test(txt), (txt.match(/.{0,70}\b(undefined|NaN|null)\b.{0,30}/) || [''])[0]);
  check(`bot trades (${fx}): no script errors`, errors.length === 0, errors.join(' | '));
  await page.close();
}
journalFixture = null;
// a #setup= link must not silently replace a saved GitHub connection (a crafted link could re-point the device)
{
  const C = await browser.newContext(), c = await C.newPage();
  await c.goto(base, { waitUntil: 'domcontentloaded' }); await c.evaluate(() => localStorage.setItem('sd-ghtok', JSON.stringify('OLD')));
  const link = base + '#setup=' + encodeURIComponent(Buffer.from(JSON.stringify({ tok: 'NEW', fh: 'k' })).toString('base64'));
  let asked = 0; c.on('dialog', d => { asked++; d.dismiss(); });
  await c.goto('about:blank'); await c.goto(link, { waitUntil: 'domcontentloaded' }); await c.waitForTimeout(300);
  const t1 = await c.evaluate(() => JSON.parse(localStorage.getItem('sd-ghtok')));
  check('setup link: replacing a saved GitHub token asks first; saying no keeps the old one', asked === 1 && t1 === 'OLD', asked + ' ' + t1);
  c.removeAllListeners('dialog'); c.on('dialog', d => d.accept());
  await c.goto('about:blank'); await c.goto(link, { waitUntil: 'domcontentloaded' }); await c.waitForTimeout(300);
  check('setup link: saying yes installs the new token', (await c.evaluate(() => JSON.parse(localStorage.getItem('sd-ghtok')))) === 'NEW');
  await C.close();
}
// Earnings tab: a Finnhub stand-in (eight reports a week, relative to the week asked for — four Monday to Thursday, and four
// on Friday for the big-company rules), company profiles, the bot's most-traded list, a portfolio holding and a watchlist
// star; the Big companies board (the default view) and the Full calendar with its chips, search and hover help; no key
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message.slice(0, 160)));
  page.on('console', m => { if (m.type() === 'error' && !/net::|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text().slice(0, 160)); });
  await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
  let calls = 0; const prof = [];
  const PROF = { AAPL: { name: 'Apple Inc', estimateCurrency: 'USD' }, NVDA: { name: 'NVIDIA Corp', estimateCurrency: 'USD' }, MSFT: { name: 'Microsoft Corp', estimateCurrency: 'USD' },
    MIDCO: { name: 'Midco Holdings', estimateCurrency: 'USD' }, PLTR: { name: 'Palantir Technologies', estimateCurrency: 'USD' }, NIOX: { name: 'Niox Motors', estimateCurrency: 'CNY' } };
  // the bot's most-traded list (never the owner's live file): PLTR is the second most traded, so it counts as big despite its sales
  await page.route('**/bot/scan.json*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ day: '20260101', key: '200:50', symbols: ['NVDA', 'PLTR', 'AAPL', 'MSFT'] }) }));
  // India: the server's file (earnings-in.json) — last week's reports (TCS beat, HDFCBANK reported, numbers not in yet) and
  // next week's (RELIANCE and INFY full tiles, HAL and TMPV chips, SMALLCO not big); written 30 hours ago (stale banner)
  const istMon = (() => { const t = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()), w = new Date(t + 'T12:00:00Z').getUTCDay(); return new Date(Date.parse(t + 'T12:00:00Z') - ((w + 6) % 7) * 864e5); })();
  const inDay = n => new Date(istMon.getTime() + n * 864e5).toISOString().slice(0, 10);
  const IN_ROWS = [{ s: 'TCS', n: 'Tata Consultancy Services Limited', d: inDay(-6), p: '2026-09-30', k: 2, eE: 38.07, eA: 38.37 }, { s: 'HDFCBANK', n: 'HDFC Bank Limited', d: inDay(-4), p: '2026-09-30', k: 3 },
    { s: 'RELIANCE', n: 'Reliance Industries Limited', d: inDay(8), p: '2026-09-30', k: 1, eE: 17.31, rE: 3.2e12 }, { s: 'INFY', n: 'Infosys Limited', d: inDay(9), p: '2026-09-30', k: 5, eE: 18.2, rE: 4.7e11 },
    { s: 'HAL', n: 'Hindustan Aeronautics Limited', d: inDay(9), p: '2026-09-30', k: 51, eE: 30.1, rE: 7.3048e11 }, { s: 'TMPV', n: 'Tata Motors Passenger Vehicles Limited', d: inDay(10), p: '2026-09-30', k: 101 },
    { s: 'SMALLCO', n: 'Small Company Limited', d: inDay(10), p: '2026-09-30', k: 0 }];
  await page.route('**/earnings-in.json*', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ at: Date.now() - 30 * 3600e3, src: 'NSE', rows: IN_ROWS }) }));
  await page.route('https://finnhub.io/**', route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/api/v1/stock/profile2') { const sy = u.searchParams.get('symbol'); prof.push(sy); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PROF[sy] || {}) }); }
    if (u.pathname !== '/api/v1/calendar/earnings') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    calls++;
    const from = u.searchParams.get('from'), y = +from.slice(0, 4), day = n => new Date(Date.parse(from + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ earningsCalendar: [
      { date: day(0), symbol: 'AAPL', hour: 'amc', quarter: 4, year: y, epsEstimate: 1.6, epsActual: null, revenueEstimate: 95e9, revenueActual: null },
      { date: day(1), symbol: 'NVDA', hour: 'bmo', quarter: 3, year: y, epsEstimate: 0.8, epsActual: 0.9, revenueEstimate: 33e9, revenueActual: 35e9 },
      { date: day(2), symbol: 'TINYCO', hour: '', quarter: 2, year: y, epsEstimate: -0.05, epsActual: null, revenueEstimate: 2.5e6, revenueActual: null },
      { date: day(3), symbol: 'MSFT', hour: 'amc', quarter: 1, year: y, epsEstimate: 3.0, epsActual: 2.7, revenueEstimate: 64e9, revenueActual: 63e9 },
      { date: day(4), symbol: 'MIDCO', hour: 'bmo', quarter: 3, year: y, epsEstimate: 1.0, epsActual: null, revenueEstimate: 6e9, revenueActual: null },        // big ($5B+), not a full tile
      { date: day(4), symbol: 'PLTR', hour: 'bmo', quarter: 3, year: y, epsEstimate: 0.1, epsActual: 0.12, revenueEstimate: 1.2e9, revenueActual: 1.3e9 },   // big by trading: a full tile
      { date: day(4), symbol: 'TM', hour: 'amc', quarter: 2, year: y, epsEstimate: 80, epsActual: null, revenueEstimate: 1.2e13, revenueActual: null },        // yen-sized: not dollars, not big
      { date: day(4), symbol: 'NIOX', hour: 'amc', quarter: 3, year: y, epsEstimate: -1.2, epsActual: null, revenueEstimate: 2e10, revenueActual: null }] }) });   // in yuan (its profile says): not big
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem('sd-pf', JSON.stringify({ h1: { sym: 'AAPL', market: 'US', qty: 10, cost: 150, at: Date.now(), pfid: 'p1' }, h2: { sym: 'TCS.NS', market: 'IN', qty: 5, cost: 3000, at: Date.now(), pfid: 'p1' } })); localStorage.setItem('sd-wl', JSON.stringify(['NVDA', 'INFY.NS'])); });
  await page.reload({ waitUntil: 'networkidle' });
  await page.evaluate(() => document.querySelector('#tabs [data-t="ERN"]').click()); await page.waitForTimeout(400);
  check('earnings: without a Finnhub key the tab explains the one free key, and its button opens ⚡ Live prices', /One free key/.test(await page.textContent('#view')) && await page.evaluate(() => { document.querySelector('[data-ernsetup]').click(); return document.querySelector('#pxBox').open === true; }));
  await page.evaluate("ERN_CO_MS = 20; fhKey = 'test-key'; renderAll();");   // a key on this device (set directly, so no live stream opens in a test); profiles quickly
  for (let i = 0; i < 40 && prof.length < 6; i++) await page.waitForTimeout(100);
  await page.waitForTimeout(500);
  const chip = async sel => { await page.evaluate(s => document.querySelector(s).click(), sel); await page.waitForTimeout(250); };
  const tiles = async () => page.$$eval('#ernBoard .ebt', els => els.map(e => e.querySelector('.ebt1 b').textContent));
  const chips = async () => page.$$eval('#ernBoard .ebc', els => els.map(e => e.querySelector('[aria-hidden]').textContent));
  const days = await page.$$eval('#ernBoard .ebday', els => els.length), t1 = await tiles(), c1 = await chips();
  check('earnings: the Big companies board is the first view — one column per weekday', await page.evaluate(() => !!document.querySelector('#ernBoard') && document.querySelector('[data-ernv="big"]').getAttribute('aria-selected') === 'true') && days === 5, `${days} days`);
  check('earnings: big = $5B+ sales or among the 100 most traded; the largest ($20B+, the 25 most traded) get full tiles, the others a ticker chip; small, yen-sized and yuan figures stay off', t1.join(',') === 'AAPL,NVDA,MSFT,PLTR' && c1.join(',') === 'MIDCO', `tiles ${t1.join(',')} · chips ${c1.join(',')}`);
  const tileOf = async sy => page.evaluate(s => { const t = [...document.querySelectorAll('#ernBoard .ebt')].find(e => e.querySelector('.ebt1 b').textContent === s); return t ? t.className + ' | ' + t.textContent.replace(/\s+/g, ' ') : ''; }, sy);
  const [ta, tn, tm, tp] = [await tileOf('AAPL'), await tileOf('NVDA'), await tileOf('MSFT'), await tileOf('PLTR')];
  check('earnings: gold tiles still to report (estimates), green beat, red missed — with the reported figures and surprises', /\bsoon\b/.test(ta) && /est \$1\.60/.test(ta) && /est \$95B/.test(ta) && !/Beat|Missed/.test(ta)
    && /\bbeat\b/.test(tn) && /Beat/.test(tn) && /\$0\.90 \+12\.5%/.test(tn) && /\$35B \+6\.1%/.test(tn) && /\bmiss\b/.test(tm) && /Missed/.test(tm) && /\$2\.70 −10\.0%/.test(tm) && /\bbeat\b/.test(tp) && /\+20\.0%/.test(tp), [ta, tn, tm, tp].join(' ## '));
  check('earnings: tiles carry the company name (the page’s own, else Finnhub’s profile) and your tags; a chip gives its numbers on hover or tap', /Apple Inc/.test(ta) && /You hold/.test(ta) && /Watchlist/.test(tn) && /Palantir Technologies/.test(tp)
    && await page.evaluate(() => /MIDCO Midco Holdings, still to report, EPS expected \$1\.00, sales expected \$6B/.test(document.querySelector('#ernBoard .ebc').getAttribute('data-tip') || '')), tp);
  const todayWd = await page.evaluate('wdOf(etDay())'), nowCols = await page.$$eval('#ernBoard .ebday.now', els => els.map(e => e.textContent));
  check('earnings: today’s column is marked (on a weekday)', todayWd >= 1 && todayWd <= 5 ? nowCols.length === 1 && /Today/.test(nowCols[0]) : nowCols.length === 0, `weekday ${todayWd}, ${nowCols.length} marked`);
  check('earnings: company names are looked up once each and kept on this device, never synced; the yuan company shows in yuan', prof.length === 6 && new Set(prof).size === 6 && await page.evaluate("(() => { const c = JSON.parse(localStorage.getItem('ern-co-v1') || '{}'); return !!(c.NIOX && c.NIOX[1] === 'CNY') && !syncKey('ern-co-v1') && !syncKey('sd-ernv') && !syncKey('sd-ernbw') && !syncKey('sd-ernr') && !syncKey('sd-ernf'); })()"), prof.join(','));
  await chip('[data-ernbw="nextweek"]'); const tNext = await tiles(), selNext = await page.evaluate(() => document.querySelector('[data-ernbw="nextweek"]').getAttribute('aria-selected'));
  await chip('[data-ernbw="lastweek"]'); const tLast = await tiles(), lastPast = await page.$$eval('#ernBoard .ebday.past', els => els.length);
  check('earnings: the week tabs move the board (next week, last week — all days past)', selNext === 'true' && tNext.join(',') === 'AAPL,NVDA,MSFT,PLTR' && tLast.join(',') === 'AAPL,NVDA,MSFT,PLTR' && lastPast === 5, `${selNext} ${tNext.join(',')} · ${tLast.join(',')} · past ${lastPast}`);
  await chip('[data-ernbw="week"]');
  const opened = await page.evaluate(() => { const t = [...document.querySelectorAll('#ernBoard .ebt[data-s]')].find(e => e.dataset.s === 'AAPL'); if (!t) return 'no tile'; t.click(); const d = document.querySelector('#dlg'); const ok = d && d.open; if (ok) d.close(); return ok; });
  check('earnings: tapping the tile of a stock the page follows opens its chart', opened === true, String(opened));
  const noTipB = await page.evaluate(() => { const els = [...document.querySelectorAll('#ernBoard .ebsl, [data-ernv]')]; return els.length < 6 ? ['only ' + els.length] : els.filter(e => !e.hasAttribute('data-tip')).map(e => e.textContent.trim()); });
  check('earnings: hover help on the session labels and the view tabs', noTipB.length === 0, noTipB.join(' | '));
  await chip('[data-ernv="list"]');
  const rows = async () => page.$$eval('#ernList tbody tr', trs => trs.filter(tr => tr.cells.length > 1).map(tr => tr.cells[1].textContent.replace(/\s+/g, ' ').trim().split(' ')[0]));
  await chip('[data-ernr="week"]'); await chip('[data-ernf="all"]');
  const all = await rows(), txt = (await page.textContent('#ernList')).replace(/\s+/g, ' ');
  check('earnings: this week, all companies — eight reports read from three weekly pieces, grouped by day in report order', calls === 3 && all.join(',') === 'AAPL,NVDA,TINYCO,MSFT,MIDCO,PLTR,TM,NIOX', `${calls} calls, rows ${all.join(',')}`);
  check('earnings: the session, quarter and numbers show (after the close, before the open, EPS $0.90 vs $0.80 = +12.5%, revenue $63B vs $64B = −1.6%)', /After the close/.test(txt) && /Before the open/.test(txt) && /Not announced/.test(txt) && /Q3 20\d\d/.test(txt) && /\$0\.90/.test(txt) && /\+12\.5%/.test(txt) && /−10\.0%/.test(txt) && /\$63B/.test(txt) && /\$95B/.test(txt) && /\$2\.5M/.test(txt) && /−1\.6%/.test(txt) && /−\$0\.05/.test(txt), txt.slice(0, 900));
  const band = await page.$$eval('#ernList tbody tr.ernbig', trs => trs.map(tr => tr.cells[1].textContent.trim().split(/\s+/)[0]));
  check('earnings: in the full calendar big companies sit on a gold band with a “Big” label; figures in another currency show its code, not $', band.join(',') === 'AAPL,NVDA,MSFT,MIDCO,PLTR' && /PLTR Palantir[^|]*?Big/.test(txt) && /CNY 20B/.test(txt) && /−CNY 1\.20/.test(txt) && /80\.00/.test(txt) && /\b12T\b/.test(txt) && !/\$12T|\$80\.00|\$20B/.test(txt), `${band.join(',')} · ${txt.slice(txt.indexOf('MIDCO'), txt.indexOf('MIDCO') + 400)}`);
  await chip('[data-ernf="big"]'); const big = await rows(), bandBig = await page.$$eval('#ernList tbody tr.ernbig', trs => trs.length);
  await chip('[data-ernf="mine"]'); const mine = await rows(), mineTxt = (await page.textContent('#ernList')).replace(/\s+/g, ' ');
  check('earnings: “Big companies” keeps the big ones (no gold band needed there); “Yours & the bot’s” keeps your holding (AAPL, tagged You hold) and your watchlist star (NVDA)', big.join(',') === 'AAPL,NVDA,MSFT,MIDCO,PLTR' && bandBig === 0 && mine.join(',') === 'AAPL,NVDA' && /AAPL Apple.*You hold/.test(mineTxt) && /Watchlist/.test(mineTxt), `big ${big.join(',')} (band ${bandBig}) · mine ${mine.join(',')} · ${mineTxt.slice(0, 200)}`);
  const card = (await page.textContent('#view')).replace(/\s+/g, ' ');
  check('earnings: “Coming up for your stocks” lists your stocks’ next reports with the session', /Coming up for your stocks.*after the close — AAPL Apple.*You hold/.test(card) && /before the open — NVDA.*Watchlist/.test(card), card.slice(0, 900));
  await chip('[data-ernf="all"]'); await page.focus('#ernQ'); await page.keyboard.type('msf'); await page.waitForTimeout(250);
  check('earnings: the search box narrows the list as you type and keeps its focus', (await rows()).join(',') === 'MSFT' && await page.evaluate(() => document.activeElement && document.activeElement.id === 'ernQ'), (await rows()).join(','));
  await page.fill('#ernQ', ''); await page.waitForTimeout(250);
  const noTip = await page.$$eval('#ernList th', ths => ths.filter(th => !th.hasAttribute('data-tip')).map(th => th.textContent.trim()));
  check('earnings: hover help explains every column', noTip.length === 0, noTip.join(' | '));
  await chip('[data-ernr="lastweek"]'); const last = await rows();
  check('earnings: last week shows that week’s reports too', last.join(',') === 'AAPL,NVDA,TINYCO,MSFT,MIDCO,PLTR,TM,NIOX', last.join(','));
  await page.reload({ waitUntil: 'networkidle' }); await page.evaluate("ERN_CO_MS = 20; fhKey = 'test-key'; document.querySelector('#tabs [data-t=\"ERN\"]').click();"); await page.waitForTimeout(900);   // a reload opens on the stocks tab
  const kept = await page.evaluate(() => { const b = document.querySelector('[data-ernv="list"]'); return b ? b.getAttribute('aria-selected') + ' ' + !!document.querySelector('#ernList') : 'no tabs: ' + document.querySelector('#view').textContent.replace(/\s+/g, ' ').slice(0, 300); });
  check('earnings: the chosen view stays chosen on this device; names come from the device cache (no new lookups)', kept === 'true true' && prof.length === 6, `${kept} · ${prof.length} lookups`);
  // India: the market switch changes the calendar — no Finnhub calls, no key needed
  const callsUS = calls; await page.evaluate("fhKey = ''; document.querySelector('[data-mkt=IN]').click();"); await page.waitForTimeout(700);
  const inHead = (await page.textContent('#view')).replace(/\s+/g, ' ');
  check('earnings, India: the switch shows the India calendar — no Finnhub key needed and no Finnhub call', /Earnings — India/.test(inHead) && !/One free key/.test(inHead) && calls === callsUS && /last updated 30 h ago/.test(inHead), `${calls - callsUS} calls · ${inHead.slice(0, 300)}`);
  await chip('[data-ernv="big"]'); await chip('[data-ernbw="nextweek"]');
  const inT = await tiles(), inC = await chips(), rel = await tileOf('RELIANCE'), inf = await tileOf('INFY');
  check('earnings, India: the Nifty 50 get full tiles (index order), the rest of the Nifty 100 and the page’s own India stocks are chips, small companies stay off', inT.join(',') === 'RELIANCE,INFY' && inC.join(',') === 'HAL,TMPV', `tiles ${inT.join(',')} · chips ${inC.join(',')}`);
  check('earnings, India: rupees and crores — EPS estimate ₹17.31, sales estimate ₹3.20 lakh cr, ₹73,048 cr; your watchlist star tagged', /Reliance Industries Limited/.test(rel) && /est ₹17\.31/.test(rel) && /est ₹3\.20 lakh cr/.test(rel) && /Watchlist/.test(inf)
    && await page.evaluate(() => /HAL Hindustan Aeronautics Limited, still to report, EPS expected ₹30\.10, sales expected ₹73,048 cr/.test(document.querySelector('#ernBoard .ebc').getAttribute('data-tip') || '')), rel + ' ## ' + inf);
  await chip('[data-ernbw="lastweek"]');
  const tcs = await tileOf('TCS'), hdfc = await tileOf('HDFCBANK');
  check('earnings, India: last week — TCS beat (₹38.37 vs ₹38.07) and is tagged You hold; HDFCBANK met but its numbers are not in yet: Reported', /\bbeat\b/.test(tcs) && /₹38\.37 \+0\.8%/.test(tcs) && /You hold/.test(tcs) && /\bdone\b/.test(hdfc) && /Reported/.test(hdfc), tcs + ' ## ' + hdfc);
  const inCard = (await page.textContent('#view')).replace(/\s+/g, ' ');
  check('earnings, India: “Coming up for your stocks” lists your Indian stocks’ next results meeting', /Coming up for your stocks.*board meeting, results that day — INFY Infosys Limited.*Watchlist/.test(inCard), inCard.slice(0, 600));
  await chip('[data-ernv="list"]'); await chip('[data-ernr="nextweek"]'); await chip('[data-ernf="all"]');
  const inRows = await rows(), inTxt = (await page.textContent('#ernList')).replace(/\s+/g, ' '), inHdr = await page.$$eval('#ernList th', ths => ths.map(t => t.textContent.trim()));
  const inBand = await page.$$eval('#ernList tbody tr.ernbig', trs => trs.map(tr => tr.cells[1].textContent.trim().split(/\s+/)[0]));
  check('earnings, India: the full calendar — board meetings by day, quarter by its months, EPS in rupees, big companies on the gold band, no revenue-actual columns', inRows.join(',') === 'RELIANCE,INFY,HAL,TMPV,SMALLCO' && inHdr.join('|') === 'Meeting|Company|Quarter|EPS estimate|EPS actual|EPS surprise|Revenue estimate'
    && /Board meeting/.test(inTxt) && /Jul–Sep 2026/.test(inTxt) && /₹17\.31/.test(inTxt) && inBand.join(',') === 'RELIANCE,INFY,HAL,TMPV' && await page.evaluate(() => [...document.querySelectorAll('#ernList th')].every(th => th.hasAttribute('data-tip'))), `${inRows.join(',')} · ${inHdr.join('|')} · band ${inBand.join(',')}`);
  await chip('[data-ernf="mine"]'); const inMine = await rows();
  await page.evaluate(() => document.querySelector('[data-mkt="US"]').click()); await page.waitForTimeout(500);
  check('earnings, India: “Yours” keeps your Indian watchlist star; switching back to USA shows the US calendar again', inMine.join(',') === 'INFY' && /Earnings — USA/.test(await page.textContent('#view')), inMine.join(','));
  await page.evaluate("fhKey = 'test-key'; renderAll();"); await page.waitForTimeout(500);
  await page.setViewportSize({ width: 390, height: 844 }); await chip('[data-ernv="big"]'); await page.waitForTimeout(300);
  const phone = await page.evaluate(() => ({ over: document.documentElement.scrollWidth - window.innerWidth, cols: window.getComputedStyle(document.querySelector('#ernBoard .ebrd')).gridTemplateColumns.split(' ').length }));
  check('earnings: on a phone the board stacks the days in one column, with no sideways scrolling', phone.over <= 1 && phone.cols === 1, JSON.stringify(phone));
  const csp = await page.evaluate(() => window.__csp);
  check('earnings: no script errors and no Content-Security-Policy violations', errors.length === 0 && csp.length === 0, errors.concat(csp).join(' | '));
  await page.close();
}
await browser.close(); srv.close();
// 5. documentation pages: a way back to the app, opened in the same window (the site runs as a home-screen app)
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check('docs links open inside the app (no target=_blank on docs/ links)', !/href="docs\/[^"]*"[^>]*target="_blank"/.test(html));
  for (const f of ['docs/index.html', 'docs/settings.html', 'docs/daytrading-rules.html']) { const d = fs.readFileSync(path.join(ROOT, f), 'utf8'); check(`${f}: has the sticky “Back to Signal Desk” button`, /class="backbar"><a class="back" href="\.\.\/">/.test(d)); }
}
// 6. the settings guide's "yours:" values against bot/config.json. Printed as a warning, never a failure: the owner saves settings
//    from the page (that push runs these tests) and the guide is brought up to date afterwards.
{
  const C = JSON.parse(fs.readFileSync(path.join(ROOT, 'bot/config.json'), 'utf8')), doc = fs.readFileSync(path.join(ROOT, 'docs/settings.html'), 'utf8'), W = { ...WHEEL_DEFAULTS, ...C };
  const t12 = s => { const [h, m] = String(s).split(':').map(Number); return `${(h + 11) % 12 + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const onOff = v => v ? 'on' : 'off', cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  const meta = h3 => { const m = new RegExp('<h3>' + h3.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '</h3><div class="meta">(.*?)</div>').exec(doc); return m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ') : null; };
  const want = [
    ['Preset: Conservative / Balanced / Aggressive', `yours: ${cap(C.preset)}`], ['Risk per stock trade', `yours: ${C.riskPct}%`], ['Risk per option trade', `yours: ${C.optRiskPct}%`],
    ['Total risk cap', `yours: ${C.maxHeat}%`], ['Max positions per sector', `yours: ${C.perSector}`], ['Daily loss limit', `yours: ${C.dayCap}%`], ['Weekly loss limit', `yours: ${C.weekCap}%`], ['Losing streak limit', `yours: ${C.streak}`],
    ['Trade stocks / Trade CALL options / Trade PUT options', `yours: ${onOff(C.stocks)} / ${onOff(C.options)} / ${onOff(C.puts)}`],
    ['Where the money goes (the five shares)', `yours: stocks ${100 - C.callSharePct - C.putSharePct - (C.spyOn ? C.spySharePct : 0) - (W.wheelOn ? W.wheelSharePct : 0)}% · CALLs ${C.callSharePct}% · PUTs ${C.putSharePct}% · SPY ${C.spyOn ? C.spySharePct : 0}% · wheel ${W.wheelOn ? W.wheelSharePct : 0}%`],
    ['CALLs share / PUTs share', `yours: ${C.callSharePct} / ${C.putSharePct}%`], ['SPY quick-options share', `yours: ${C.spySharePct}%`], ['SPY money per trade', `yours: ${C.spyTradePct}%`], ['Options daily loss limit', `yours: ${C.optDayCap}%`],
    ['Per trade — stocks / CALLs / PUTs', `yours: ${C.stockPct}% / ${C.optPct}% / ${C.putPct}%`], ['Max stock positions / Max option positions', `yours: ${C.maxPositions} / ${C.maxOptions}`],
    ['When to sell a stock', `yours: ${C.exitRule === 'profit' ? 'First profitable close' : 'On the bounce'}`], ['Profit needed to sell', `yours: ${C.exitProfitPct}%`], ['Market filter', `yours: ${onOff(C.marketFilter)}`], ['Intraday signals', `yours: ${onOff(C.intraday)}`],
    ['RSI-2 buy level', `yours: ${C.rsiThreshold}`], ['Max hold', `yours: ${C.maxHold}`], ['Stock take-profit', `yours: +${C.stockTp}%`], ['Stock stop (hard floor)', `yours: ${C.holdFloor}%`],
    ['Option take-profit / Option stop', `yours: +${C.optTakeProfit}% / −${C.optStop}%`], ['When to sell a CALL or PUT', `yours: ${C.optExit === 'target' ? 'Only at its take-profit, stop or time limit' : 'Also when the stock bounces back'}`], ['Option expiry, at least', `yours: ${C.optDays}`],
    ['Entry window closes at', `yours: ${t12(C.entryEnd)}`], ['Day-trade (on/off)', `yours: ${onOff(C.dayTrade)}`],
    ['SPY quick options (on/off)', `yours: ${onOff(C.spyOn)}`], ['SPY take-profit / SPY stop', `yours: +${C.spyTp}% / −${C.spyStop}%`], ['SPY time stop', `yours: ${C.spyHoldMin} min`], ['SPY trades open at once', `yours: ${C.spyMaxOpen}`],
    ['SPY max trades per day · SPY losses in a row · SPY daily loss limit', `yours: ${C.spyMaxTrades} · ${C.spyStreak} · ${C.spyDayCap}%`], ['Trades from / until', `yours: ${t12(C.spyStart)} – ${t12(C.spyEnd)}`],
    ['SPY expiry, max days out', `yours: ${C.spyDte}`],
    ['Pay up to get in quickly', `yours: ${onOff(C.spyFastFill)}`],
    ['Message only when an order fills', `yours: ${onOff(C.alertOnFill)}`],
    ['Wheel share', `yours: ${W.wheelSharePct}%`], ['The wheel (on/off)', `yours: ${onOff(W.wheelOn)}`], ['Trend filter', `yours: ${onOff(W.wheelTrend)}`], ['Strike distance', `yours: ${W.wheelOtmPct}%`], ['Buy back at', `yours: ${W.wheelTp}%`],
    ['Sell between windows', `yours: ${onOff(W.wheelAnytime)}`], ['Wheel stop', `yours: ${W.wheelStop > 0 ? W.wheelStop + '×' : 'off'}`], ['Lowest share price / Highest share price', `yours: $${W.wheelMinPrice} / $${W.wheelMaxPrice}`], ['Stocks at once', `yours: ${W.wheelMaxPositions}`],
    ['Scan the whole market / Only my list', `yours: ${C.universe === 'scan' ? 'scan' : 'my list'}`], ['How many stocks to watch', `yours: ${C.scanSize}`], ['Minimum share price', `yours: $${C.scanMinPrice}`], ['Practice (paper) / Real money (live)', `yours: ${C.mode}`],
  ];
  const off = want.filter(([h3, w]) => !(meta(h3) || '').includes(w)).map(([h3, w]) => `${h3}: config.json says “${w}”, the guide says “${(meta(h3) || 'no such entry').slice(0, 100)}”`);
  console.log(off.length ? `  ⚠ docs/settings.html “yours:” differs from bot/config.json in ${off.length} place(s) — update the guide (warning only):\n      ${off.join('\n      ')}` : `  ✓ docs/settings.html “yours:” values match bot/config.json (${want.length} settings)`);
}
console.log(failed ? `\n${failed} page check(s) FAILED` : '\nall page checks passed');
process.exit(failed ? 1 : 0);
