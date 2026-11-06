// Writes data/sea/<SYM>.json — the Seasonality tab's own nightly copy of Yahoo's monthly bars (run by GitHub Actions,
// .github/workflows/sea-data.yml, after the close). The page draws these instantly — they come from the same place as
// the page itself, so no network can refuse them — and then upgrades to a live read when Yahoo answers.
// Symbols: the four benchmarks + QQQ + everything on the board (symbols.json). A failed symbol keeps yesterday's file.
import fs from 'node:fs';
const bench = ['^GSPC', '^IXIC', 'SPY', 'VGT', 'QQQ'];
const syms = [...new Set(bench.concat(JSON.parse(fs.readFileSync('symbols.json', 'utf8'))))].slice(0, 300);
const fname = s => 'data/sea/' + s.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
let auth = null;                                                            // Yahoo's cookie+crumb: max-range monthly history 401s without it for many symbols (seen 2026-11-05: the same 68 of 172 on every run)
async function getAuth() {
  try {
    const r1 = await fetch('https://fc.yahoo.com/', { headers: { 'user-agent': UA }, redirect: 'manual' });
    const cookie = String(r1.headers.get('set-cookie') || '').split(';')[0];
    if (!cookie) return null;
    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'user-agent': UA, cookie } });
    const crumb = (await r2.text()).trim();
    return r2.ok && crumb && crumb.length <= 32 && !crumb.includes('<') ? { cookie, crumb } : null;
  } catch (e) { void e; return null; }
}
const routes = s => {
  const e = encodeURIComponent(s), now = Math.floor(Date.now() / 1000);
  const p = '/v8/finance/chart/' + e + '?range=max&interval=1mo&includePrePost=false';
  const cr = auth ? '&crumb=' + encodeURIComponent(auth.crumb) : '';
  const u1 = 'https://query1.finance.yahoo.com' + p, u2 = 'https://query2.finance.yahoo.com' + p;
  return [{ u: u1 + cr, direct: true }, { u: u2 + cr, direct: true },
    { u: 'https://query1.finance.yahoo.com/v8/finance/chart/' + e + '?period1=0&period2=' + now + '&interval=1mo&includePrePost=false' + cr, direct: true },   // same ask, spelled as an exact window — some symbols 401 only the range=max spelling
    { u: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u1) }, { u: 'https://corsproxy.io/?url=' + encodeURIComponent(u2) },
    { u: 'https://query2.finance.yahoo.com/v8/finance/chart/' + e + '?range=10y&interval=1mo&includePrePost=false' + cr, direct: true }];   // last resort: ten years beats nothing
};
async function pull(s) {
  let err = '';
  for (const { u, direct } of routes(s)) {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await fetch(u, { headers: direct && auth ? { 'user-agent': UA, cookie: auth.cookie } : { 'user-agent': UA }, signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).replace(/\s+/g, ' ').slice(0, 160));
      const x = (await r.json()).chart.result[0], m = x.meta || {};
      if (!x.timestamp || (m.dataGranularity || '1mo') !== '1mo') throw new Error('not monthly bars');
      const q = x.indicators.quote[0], ts = [], cl = [];
      x.timestamp.forEach((t, i) => { const c = q.close[i]; if (c > 0) { ts.push(t); cl.push(Math.round(c * 10000) / 10000); } });
      if (ts.length < 14) throw new Error('not enough monthly history');
      // stored in Yahoo's own shape so the page digests it with the very same code as a live read
      return { chart: { result: [{ meta: { exchangeTimezoneName: m.exchangeTimezoneName || '', regularMarketPrice: m.regularMarketPrice, longName: m.longName || m.shortName || s, dataGranularity: '1mo', builtAt: Date.now() }, timestamp: ts, indicators: { quote: [{ close: cl }] } }] } };
    } catch (e) { err = String((e && e.message) || e); } finally { clearTimeout(tm); }
  }
  throw new Error(err || 'no data');
}
fs.mkdirSync('data/sea', { recursive: true });
auth = await getAuth();
console.log('crumb:', auth ? 'yes' : 'no — unauthenticated routes only');
// Yahoo refuses single requests at random from datacenter addresses (the first run lost 68 of 172 that way, scattered,
// not rate-limit-shaped) — so: two at a time, a breath between requests, and up to three passes over the failures.
let left = syms.slice(); const why = {};
for (let pass = 1; pass <= 4 && left.length; pass++) {
  if (pass > 1) { console.log('pass ' + pass + ': retrying ' + left.length + ' after a pause'); await new Promise(r => setTimeout(r, 20000)); }
  const fails = []; let i = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (i < left.length) {
      const s = left[i++];
      try { fs.writeFileSync(fname(s), JSON.stringify(await pull(s))); delete why[s]; } catch (e) { fails.push(s); why[s] = String((e && e.message) || e).slice(0, 120); if (pass === 4) console.log('fail', s, e.message); }
      await new Promise(r => setTimeout(r, 250));
    }
  }));
  left = fails;
}
console.log('ok', syms.length - left.length, 'fail', left.length);
fs.writeFileSync('data/sea/_report.json', JSON.stringify({ at: Date.now(), crumb: !!auth, ok: syms.length - left.length, fail: left.length, why }, null, 1));   // committed, so a failing night can be diagnosed from the repo itself
if (left.length === syms.length) process.exit(1);                           // nothing fetched at all: fail loudly and keep yesterday's files
