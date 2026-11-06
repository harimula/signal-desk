// Writes data/macro.json — the Macro tab's nightly data (run by GitHub Actions with sea-data.yml, after the close).
// Sources: FRED (the St. Louis Fed's public database — the standard source for US macro series; keyless CSV
// endpoint) and Yahoo for gold and bitcoin (the exact-window spelling + cookie/crumb, as tools/sea-fetch.mjs).
// Each series carries: latest value, the one before it, the date, and up to 24 month-end points for a sparkline.
// A series that fails tonight keeps its entry from the existing file; only what was fetched is replaced.
import fs from 'node:fs';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// key → [FRED id, display name, unit, frequency, transform]
// transforms: raw = as published; yoy = % change vs 12 months earlier; momk = month-over-month change in thousands
const FRED = {
  ff: ['DFF', 'Fed funds rate', '%', 'D', 'raw'],
  y2: ['DGS2', '2-year Treasury', '%', 'D', 'raw'],
  y10: ['DGS10', '10-year Treasury', '%', 'D', 'raw'],
  curve: ['T10Y2Y', 'Yield curve (10y − 2y)', 'pp', 'D', 'raw'],
  mort: ['MORTGAGE30US', '30-year mortgage', '%', 'W', 'raw'],
  cpi: ['CPIAUCSL', 'Inflation (CPI, yearly)', '%', 'M', 'yoy'],
  core: ['CPILFESL', 'Core inflation (yearly)', '%', 'M', 'yoy'],
  pce: ['PCEPI', 'PCE inflation (yearly)', '%', 'M', 'yoy'],
  bei: ['T10YIE', '10-year inflation expected', '%', 'D', 'raw'],
  unemp: ['UNRATE', 'Unemployment rate', '%', 'M', 'raw'],
  jobs: ['PAYEMS', 'New jobs (payrolls, monthly)', 'k', 'M', 'momk'],
  claims: ['ICSA', 'Jobless claims (weekly)', 'k', 'W', 'rawk'],
  gdp: ['A191RL1Q225SBEA', 'GDP growth (quarter, yearly pace)', '%', 'Q', 'raw'],
  sent: ['UMCSENT', 'Consumer sentiment', '', 'M', 'raw'],
  sahm: ['SAHMREALTIME', 'Sahm rule (recession signal)', 'pp', 'M', 'raw'],
  vix: ['VIXCLS', 'VIX (fear gauge)', '', 'D', 'raw'],
  hy: ['BAMLH0A0HYM2', 'Junk-bond spread', '%', 'D', 'raw'],
  dxy: ['DTWEXBGS', 'US dollar index (broad)', '', 'D', 'raw'],
  oil: ['DCOILWTICO', 'Oil (WTI)', '$', 'D', 'raw']
};
const YAHOO = { gold: ['GC=F', 'Gold', '$'], btc: ['BTC-USD', 'Bitcoin', '$'] };

async function get(u, headers, ms = 15000) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(u, { headers: { 'user-agent': UA, ...headers }, signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.text(); }
  finally { clearTimeout(tm); }
}
const ym = d => d.slice(0, 7);
const r2 = x => Math.round(x * 100) / 100;

// FRED CSV → [[date, value]] with missing days ('.') dropped
function parseFred(csv) {
  const rows = [];
  for (const line of csv.trim().split('\n').slice(1)) {
    const [d, v] = line.split(','); const n = +v;
    if (d && v !== '.' && Number.isFinite(n)) rows.push([d.trim(), n]);
  }
  if (rows.length < 15) throw new Error('too short');
  return rows;
}
// keep each month's last observation, return the last n
const monthEnds = (rows, n) => { const m = new Map(); for (const [d, v] of rows) m.set(ym(d), [d, v]); return [...m.values()].slice(-n); };

function digest(rows, tr) {
  if (tr === 'yoy') {
    const m = new Map(); for (const [d, v] of rows) m.set(ym(d), [d, v]);
    const ks = [...m.keys()], out = [];
    for (let i = 12; i < ks.length; i++) { const a = m.get(ks[i - 12])[1], b = m.get(ks[i]); if (a > 0) out.push([b[0], r2((b[1] / a - 1) * 100)]); }
    rows = out;
  } else if (tr === 'momk') {
    const me = monthEnds(rows, 40), out = [];
    for (let i = 1; i < me.length; i++) out.push([me[i][0], Math.round(me[i][1] - me[i - 1][1])]);
    rows = out;
  } else if (tr === 'rawk') { rows = rows.map(([d, v]) => [d, Math.round(v / 1000)]); }
  const hist = monthEnds(rows, 24).map(([d, v]) => [ym(d), r2(v)]);
  const [ld, lv] = rows[rows.length - 1], pv = rows[rows.length - 2][1];
  return { date: ld, val: r2(lv), prev: r2(pv), hist };
}

let auth = null;
async function getAuth() {
  try {
    const r1 = await fetch('https://fc.yahoo.com/', { headers: { 'user-agent': UA }, redirect: 'manual' });
    const cookie = String(r1.headers.get('set-cookie') || '').split(';')[0];
    if (!cookie) return null;
    const crumb = (await get('https://query1.finance.yahoo.com/v1/test/getcrumb', { cookie })).trim();
    return crumb && crumb.length <= 32 && !crumb.includes('<') ? { cookie, crumb } : null;
  } catch (e) { void e; return null; }
}
async function yahooDaily(sym) {
  const now = Math.floor(Date.now() / 1000);
  const p = '/v8/finance/chart/' + encodeURIComponent(sym) + `?period1=${now - 3 * 366 * 86400}&period2=${now}&interval=1d&includePrePost=false` + (auth ? '&crumb=' + encodeURIComponent(auth.crumb) : '');
  let err = '';
  for (const [host, hdr] of [['https://query1.finance.yahoo.com', auth ? { cookie: auth.cookie } : {}], ['https://query2.finance.yahoo.com', auth ? { cookie: auth.cookie } : {}],
    ['https://api.allorigins.win/raw?url=' + encodeURIComponent('https://query1.finance.yahoo.com' + p), null]]) {
    try {
      const x = JSON.parse(hdr === null ? await get(host) : await get(host + p, hdr)).chart.result[0];
      const q = x.indicators.quote[0], rows = [];
      x.timestamp.forEach((t, i) => { const c = q.close[i]; if (c > 0) rows.push([new Date(t * 1000).toISOString().slice(0, 10), c]); });
      if (rows.length < 30) throw new Error('too short');
      return rows;
    } catch (e) { err = String((e && e.message) || e).slice(0, 80); }
  }
  throw new Error(err || 'no data');
}

let fredDirectDead = false;                                                 // FRED hangs for GitHub's addresses (seen 2026-11-05: every direct request aborted) — after one dead direct try, go straight to the relays
const win = {};                                                             // which route served each series tonight — committed, for diagnosing from the repo
async function fredCsv(k, id) {
  const g = 'https://fred.stlouisfed.org/graph/fredgraph.csv?cosd=1990-01-01&id=' + id;   // trimmed: daily series since 1954 are half a megabyte untrimmed
  const d = 'https://fred.stlouisfed.org/series/' + id + '/downloaddata/' + id + '.csv';  // the classic download endpoint — a different path, in case one is refused
  const routes = [[g, true], [d, true],
    ['https://api.allorigins.win/raw?url=' + encodeURIComponent(g), false],
    ['https://api.allorigins.win/raw?url=' + encodeURIComponent(d), false],
    ['https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(g), false],
    ['https://corsproxy.io/?url=' + encodeURIComponent(g), false]];
  let err = '';
  for (let i = 0; i < routes.length; i++) {
    const [u, isDirect] = routes[i];
    if (isDirect && fredDirectDead) continue;
    try { const rows = parseFred(await get(u, undefined, isDirect ? 8000 : 15000)); win[k] = i; return rows; }
    catch (e) { err = String((e && e.message) || e).slice(0, 80); if (isDirect && /abort/i.test(err)) fredDirectDead = true; }
  }
  throw new Error(err);
}
const old = fs.existsSync('data/macro.json') ? JSON.parse(fs.readFileSync('data/macro.json', 'utf8')) : { series: {} };
const series = {}, fail = {};
let fredLeft = Object.entries(FRED);
for (let pass = 1; pass <= 3 && fredLeft.length; pass++) {                  // the relays refuse single requests at random (the sea-fetch lesson) — passes mop them up
  if (pass > 1) { console.log('pass ' + pass + ': retrying ' + fredLeft.length); await new Promise(r => setTimeout(r, 15000)); }
  const again = [];
  for (const ent of fredLeft) {
    const [k, [id, name, unit, freq, tr]] = ent;
    try { series[k] = { name, unit, freq, src: 'FRED ' + id, ...digest(await fredCsv(k, id), tr) }; delete fail[k]; }
    catch (e) { fail[k] = String((e && e.message) || e).slice(0, 100); again.push(ent); }
    await new Promise(r => setTimeout(r, 300));
  }
  fredLeft = again;
}
for (const [k] of fredLeft) if (old.series[k]) series[k] = old.series[k];   // still refused: keep the prior night's dial
auth = await getAuth();
for (const [k, [sym, name, unit]] of Object.entries(YAHOO)) {
  try { series[k] = { name, unit, freq: 'D', src: 'Yahoo ' + sym, ...digest(await yahooDaily(sym), 'raw') }; }
  catch (e) { fail[k] = String((e && e.message) || e).slice(0, 100); if (old.series[k]) series[k] = old.series[k]; }
}
const got = Object.keys(series).length;
console.log('ok', got, 'fail', Object.keys(fail).length, Object.keys(fail).join(' '));
if (!got) process.exit(1);                                                  // nothing at all (and nothing old to keep): leave the file alone
fs.writeFileSync('data/macro.json', JSON.stringify({ v: 1, at: Date.now(), series, fail, win }, null, 1));
