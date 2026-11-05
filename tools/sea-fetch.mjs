// Writes data/sea/<SYM>.json — the Seasonality tab's own nightly copy of Yahoo's monthly bars (run by GitHub Actions,
// .github/workflows/sea-data.yml, after the close). The page draws these instantly — they come from the same place as
// the page itself, so no network can refuse them — and then upgrades to a live read when Yahoo answers.
// Symbols: the four benchmarks + QQQ + everything on the board (symbols.json). A failed symbol keeps yesterday's file.
import fs from 'node:fs';
const bench = ['^GSPC', '^IXIC', 'SPY', 'VGT', 'QQQ'];
const syms = [...new Set(bench.concat(JSON.parse(fs.readFileSync('symbols.json', 'utf8'))))].slice(0, 300);
const fname = s => 'data/sea/' + s.replace(/[^A-Za-z0-9.\-]/g, '_') + '.json';
const routes = s => {
  const p = '/v8/finance/chart/' + encodeURIComponent(s) + '?range=max&interval=1mo&includePrePost=false';
  const u1 = 'https://query1.finance.yahoo.com' + p, u2 = 'https://query2.finance.yahoo.com' + p;
  return [u1, u2, 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u1), 'https://corsproxy.io/?url=' + encodeURIComponent(u2)];
};
async function pull(s) {
  let err = '';
  for (const u of routes(s)) {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
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
let ok = 0, fail = 0, i = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (i < syms.length) {
    const s = syms[i++];
    try { fs.writeFileSync(fname(s), JSON.stringify(await pull(s))); ok++; } catch (e) { fail++; console.log('fail', s, e.message); }
  }
}));
console.log('ok', ok, 'fail', fail);
if (!ok) process.exit(1);                                                   // nothing fetched at all: fail loudly and keep yesterday's files
