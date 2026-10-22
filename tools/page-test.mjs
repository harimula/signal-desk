// Page tests in headless Chromium (runs in CI):
//   node tools/page-test.mjs
// Serves the site locally, stands in for the GitHub API, and checks: every tab renders without a script error or a
// CSP violation — also with the Screener sub-view remembered — and that Bot settings saves and surfaces failures.
// Needs playwright (CI installs it; locally: npm i --no-save playwright@1.49.1 && npx playwright install chromium).
import http from 'node:http';
import fs from 'node:fs';
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
  let sha = 'abc', puts = [];
  await page.route('https://api.github.com/**', async route => {
    const u = new URL(route.request().url()), m = route.request().method(), p = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    if (process.env.SLOW_MS) await new Promise(r => setTimeout(r, +process.env.SLOW_MS));
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '' || p === '/') return json(200, { private: false, full_name: 'x/y' });
    if (p === '/contents/bot/config.json' && m === 'GET') return json(200, { sha, content: Buffer.from(JSON.stringify(cfg)).toString('base64') });
    if (p === '/contents/bot/config.json' && m === 'PUT') { puts.push(JSON.parse(route.request().postData())); sha = 'new' + puts.length; return json(200, { content: { sha } }); }
    if (p === '/actions/secrets') return json(200, { secrets: [{ name: 'ALPACA_KEY' }, { name: 'ALPACA_SECRET' }] });
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
  return { page, errors, puts };
}

// 1. plain visitor
{ const { page } = await session('fresh visitor', () => localStorage.clear()); await page.close(); }

// 2. connected owner who last used the Screener sub-view (the state that once crashed every other tab's redraw)
{
  const { page, errors, puts } = await session('owner with Screener remembered', () => { localStorage.clear(); localStorage.setItem('sd-v2', JSON.stringify('screen')); localStorage.setItem('sd-ghtok', JSON.stringify('ghp_fake')); localStorage.setItem('sd-ghrepo', JSON.stringify('x/y')); });
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
  await page.close();
}
await browser.close(); srv.close();
console.log(failed ? `\n${failed} page check(s) FAILED` : '\nall page checks passed');
process.exit(failed ? 1 : 0);
