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
import { fileURLToPath } from 'node:url';
const { chromium } = await import('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json' };
let journalFixture = null;                                                  // when set, served in place of the encrypted bot/journal.json
const srv = http.createServer((req, res) => {
  const pn = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (journalFixture && /\/bot\/journal\.json$/.test(pn)) { res.setHeader('content-type', 'application/json'); return res.end(fs.readFileSync(path.join(ROOT, 'tools/fixtures', journalFixture))); }
  const p = path.join(ROOT, pn.replace(/\/$/, '/index.html'));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.statusCode = 404; return res.end('nf'); }
  res.setHeader('content-type', mime[path.extname(p)] || 'application/octet-stream'); res.end(fs.readFileSync(p));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}/`;
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
let failed = 0;
const check = (name, ok, detail = '') => { console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : '  ' + detail)); if (!ok) failed++; };

async function session(label, prep) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message.slice(0, 160)));
  page.on('console', m => { if (m.type() === 'error' && !/net::|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text().slice(0, 160)); });
  await page.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'bot/config.json'), 'utf8'));
  for (const k of ['dayOrMin', 'dayMaxTrades', 'dayTarget', 'dayOptDteMax']) delete cfg[k];          // like the real file: older saves lack these
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
  // the owner's saved shares vary; set CALLs 30 / PUTs 10 / SPY 5 first so the checks below do not depend on config.json
  for (const [id, v] of [['st-callSharePct', '30'], ['st-putSharePct', '10'], ['st-spySharePct', '5']]) { await page.fill('#' + id, v); await page.evaluate(id => document.getElementById(id).dispatchEvent(new Event('change', { bubbles: true })), id); await page.waitForTimeout(150); }
  await page.evaluate(() => { const r = document.querySelector('#st-spyOn'); if (r && !r.checked) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } }); await page.waitForTimeout(200);
  const note0 = await page.evaluate(() => (document.querySelector('#stSplitNote') || {}).textContent || '');
  await page.fill('#st-callSharePct', '25');
  await page.evaluate(() => document.querySelector('#st-callSharePct').dispatchEvent(new Event('change', { bubbles: true }))); await page.waitForTimeout(200);
  const note1 = await page.evaluate(() => (document.querySelector('#st-split') || {}).checked === true && (document.querySelector('#stSplitNote') || {}).textContent || '');
  check('money split: with CALLs 30 / PUTs 10 / SPY 5 the note reads 55/30/10/5, and a share typed in updates it', /Stocks 55%.*CALLs 30%.*PUTs 10%.*SPY quick options 5%/.test(note0) && /Stocks 60%.*CALLs 25%.*PUTs 10%/.test(note1), note0 + ' → ' + note1);
  check('SPY sleeve: section 4c shows, on by default, with its nine settings and the time window', await page.evaluate(() => (document.querySelector('#st-spyOn') || {}).checked === true && ['spySharePct', 'spyTp', 'spyStop', 'spyHoldMin', 'spyMaxTrades', 'spyMaxOpen', 'spyStreak', 'spyDayCap', 'spyDte', 'spyStart', 'spyEnd'].every(k => document.getElementById('st-' + k)) && document.getElementById('st-spySharePct').value === '5'));
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
  await page.evaluate(() => document.querySelector('[data-st="save"]').click());
  let msg = '';
  for (let i = 0; i < 80; i++) { await page.waitForTimeout(250); msg = await page.evaluate(() => (document.querySelector('[data-st="save"]').parentElement.textContent || '').replace(/\s+/g, ' ')); if (/Saved|failed/.test(msg)) break; }
  check('settings: Save reaches GitHub with the typed value', puts.length === 1 && JSON.parse(Buffer.from(puts[0].content, 'base64')).rsiThreshold === 12, msg.slice(0, 120));
  check('money split: Save writes the split and the CALL / PUT shares to config.json', puts.length === 1 && (c => c.split === true && c.callSharePct === 25 && c.putSharePct === 10 && c.optDayCap === 10 && c.pickBy === 'dip' && c.spyOn === true && c.spySharePct === 5 && c.spyTp === 20 && c.spyStart === '09:50' && c.spyTradePct === 50)(JSON.parse(Buffer.from(puts[0].content, 'base64'))), puts.length ? Buffer.from(puts[0].content, 'base64').toString().slice(0, 0) : 'no save');
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
for (const [fx, label] of [['journal-full.json', 'full journal (stock, CALL, PUT, SPY and day-trade rows)'], ['journal-old.json', 'older journal shape (no watch rows, no split, no spy, no day block)']]) {
  journalFixture = fx;
  const { page, errors } = await session('bot trades · ' + label, () => { localStorage.clear(); localStorage.setItem('sd-mkt', JSON.stringify('US')); });
  await page.evaluate(() => document.querySelector('#tabs [data-t="BOT"]').click()); await page.waitForTimeout(1500);
  await page.evaluate(() => document.querySelectorAll('main details').forEach(d => { d.open = true; }));
  const txt = await page.evaluate(() => document.querySelector('main').innerText.replace(/\s+/g, ' '));
  if (fx === 'journal-full.json') {
    check('bot trades: the money-split cards show all four parts with their money', /Stocks.*\$55,000/.test(txt) && /CALLs.*\$30,000/.test(txt) && /PUTs.*\$10,000/.test(txt) && /SPY quick options.*\$5,000/.test(txt), txt.slice(0, 300));
    check('bot trades: the SPY card shows the open trade with its exits and the 3-mo-vs-market column exists', /SPY quick options/.test(txt) && /in a trade/.test(txt) && /\$235\.75/.test(txt) && /3-mo vs market/.test(txt), txt.slice(0, 200));
    check('bot trades: Open now describes each kind correctly (swing stock, CALL, PUT, SPY quick trade, day trade) from the settings', /RSI-2 swing — sells at \+10%/.test(txt) && /CALL — sells with the stock/.test(txt) && /PUT — sells with the stock/.test(txt) && /SPY quick trade — out at \+15%/.test(txt) && /day trade — stop and target at the broker/.test(txt), txt.match(/Open now.{0,900}/)?.[0]);
    check('bot trades: option prices are shown per contract (×100) in the held table and per share in Open now, both labelled', /\$440\.00/.test(txt) && /\$4\.40/.test(txt), '');
    check('bot trades: the rules line reads the cancel time from settings', /cancelled after 45 min/.test(txt));
    // real results since the first trade: the whole account (all four parts) scaled to $100k vs $100k in each fund
    { const sc = await page.evaluate(() => { const c = [...document.querySelectorAll('.card')].find(x => /Since the bot started trading/.test(x.textContent)); return c ? c.innerText.replace(/\s+/g, ' ') : ''; });
      check('since-start card: the real account (+0.60% → $100,600) against SPY, IJH, IWM, VGT and QQQ, each from $100,000, with a per-part breakdown', /\$100,600/.test(sc) && /SPY/.test(sc) && /VGT/.test(sc) && /QQQ/.test(sc) && /\$101,000/.test(sc) && /stocks/.test(sc) && /SPY quick options/.test(sc) && /far too short to judge/.test(sc), sc.slice(0, 400)); }
    // 5-year card: mode buttons and the tax switch (served research.json carries the modes)
    const h5 = async () => page.evaluate(() => { const c = [...document.querySelectorAll('.card')].find(x => /The last 5 years/.test(x.textContent)); return c ? c.innerText.replace(/\s+/g, ' ') : ''; });
    const hasModes = await page.$('[data-h5mode="aggressive"]');
    if (hasModes) {
      await page.click('[data-h5tax="after"]'); await page.waitForTimeout(300); const a1 = await h5();
      await page.click('[data-h5mode="conservative"]'); await page.waitForTimeout(300); const a2 = await h5();
      await page.click('[data-h5tax="before"]'); await page.waitForTimeout(300); const a3 = await h5();
      check('5-year card: the mode buttons change the bot line, the tax switch changes the view, both before and after amounts show', /USA bot — My settings|USA bot — /.test(a1) && /USA bot — Conservative/.test(a2) && /after tax/.test(a1) && !/· after tax/.test(a3) && /short-term/.test(a1) && /long-term/.test(a1), [a1.slice(0, 160), a2.slice(0, 120)].join(' || '));
    } else check('5-year card: research.json has no modes yet (skipped)', true);
  } else {
    check('bot trades: an older journal without watch rows / split / spy renders without a blank page', /Bot trades|Your bot/.test(txt) && txt.length > 500, txt.slice(0, 200));
  }
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
await browser.close(); srv.close();
// 5. documentation pages: a way back to the app, opened in the same window (the site runs as a home-screen app)
{
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  check('docs links open inside the app (no target=_blank on docs/ links)', !/href="docs\/[^"]*"[^>]*target="_blank"/.test(html));
  for (const f of ['docs/index.html', 'docs/settings.html', 'docs/daytrading-rules.html']) { const d = fs.readFileSync(path.join(ROOT, f), 'utf8'); check(`${f}: has the sticky “Back to Signal Desk” button`, /class="backbar"><a class="back" href="\.\.\/">/.test(d)); }
}
console.log(failed ? `\n${failed} page check(s) FAILED` : '\nall page checks passed');
process.exit(failed ? 1 : 0);
