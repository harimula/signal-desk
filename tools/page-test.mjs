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
const srv = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/\/$/, '/index.html')));
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
  let sha = 'abc', puts = [], secretPuts = [];
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
  return { page, errors, puts, secretPuts };
}

// 1. plain visitor
{ const { page } = await session('fresh visitor', () => localStorage.clear()); await page.close(); }

// 2. connected owner who last used the Screener sub-view (the state that once crashed every other tab's redraw)
{
  const { page, errors, puts, secretPuts } = await session('owner with Screener remembered', () => { localStorage.clear(); localStorage.setItem('sd-v2', JSON.stringify('screen')); localStorage.setItem('sd-ghtok', JSON.stringify('ghp_fake')); localStorage.setItem('sd-ghrepo', JSON.stringify('x/y')); });
  await page.evaluate(() => document.querySelector('#tabs [data-t="SET"]').click());
  await page.waitForTimeout(1200);
  await page.fill('#st-rsiThreshold', '12');
  await page.evaluate(() => document.querySelector('#st-rsiThreshold').dispatchEvent(new Event('change', { bubbles: true })));
  await page.focus('#st-maxHold'); await page.keyboard.type('1');
  await page.evaluate(() => document.querySelector('#st-maxHold').dispatchEvent(new Event('change', { bubbles: true })));
  check('settings: typing does not move the cursor', (await page.evaluate(() => document.activeElement.id)) === 'st-maxHold');
  await page.evaluate(() => document.querySelector('[data-st="save"]').click());
  let msg = '';
  for (let i = 0; i < 80; i++) { await page.waitForTimeout(250); msg = await page.evaluate(() => (document.querySelector('[data-st="save"]').parentElement.textContent || '').replace(/\s+/g, ' ')); if (/Saved|failed/.test(msg)) break; }
  check('settings: Save reaches GitHub with the typed value', puts.length === 1 && JSON.parse(Buffer.from(puts[0].content, 'base64')).rsiThreshold === 12, msg.slice(0, 120));
  check('settings: Save bar reports success', /Saved /.test(msg), msg.slice(0, 120));
  check('settings: no script error during save', errors.length === 0, errors.join(' | '));
  // phone alerts: the test button sends to the typed topic from the browser (stand-in for ntfy.sh)
  let ntfyUrl = null; await page.route('https://ntfy.sh/**', r => { ntfyUrl = r.request().url(); return r.fulfill({ status: 200, body: '{}' }); });
  await page.evaluate(() => document.querySelector('[data-st="ntfytest"]').click());
  const m0 = await page.textContent('#ntfyMsg');
  await page.fill('#st-ntfy', 'https://ntfy.sh/my-topic-123'); await page.evaluate(() => document.querySelector('[data-st="ntfytest"]').click());
  let m1 = ''; for (let i = 0; i < 20 && !/Sent to/.test(m1); i++) { await page.waitForTimeout(200); m1 = await page.textContent('#ntfyMsg'); }
  check('alerts: "Send test alert" asks for the topic when the box is empty, then posts to ntfy.sh/<topic>', /Type your alert topic/.test(m0) && /Sent to topic/.test(m1) && /ntfy\.sh\/my-topic-123$/.test(ntfyUrl || ''), m0 + ' | ' + m1 + ' | ' + ntfyUrl);
  // Save keys: the alert topic is sealed in the browser (libsodium) and sent as a GitHub secret
  await page.evaluate(() => document.querySelector('[data-st="keys"]').click());
  let km = ''; for (let i = 0; i < 60 && !secretPuts.length && !/failed/i.test(km); i++) { await page.waitForTimeout(250); km = await page.evaluate(() => document.body.innerText.match(/Saving keys failed[^\n]*|Saved[^\n]*secret[^\n]*/i)?.[0] || ''); }
  check('keys: Save keys seals the alert topic in the browser and stores it as the NTFY_TOPIC secret', secretPuts.some(x => x.name === 'NTFY_TOPIC' && x.key_id === 'kid1' && Buffer.from(x.encrypted_value, 'base64').length === 48 + 'my-topic-123'.length), km + ' ' + JSON.stringify(secretPuts.map(x => x.name)) + ' ' + errors.join(' | '));
  check('alerts: no CSP violation sending the test alert', (await page.evaluate(() => window.__csp)).length === 0, JSON.stringify(await page.evaluate(() => window.__csp)));
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
  check('sign-in: no script errors on either device', errA.length + errB.length === 0, errA.concat(errB).join(' | '));
  await A.close(); await B.close();
}
await browser.close(); srv.close();
console.log(failed ? `\n${failed} page check(s) FAILED` : '\nall page checks passed');
process.exit(failed ? 1 : 0);
