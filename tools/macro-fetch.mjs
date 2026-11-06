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

const FRED_KEY = process.env.FRED_API_KEY || '';                           // the official, free FRED API key (GitHub secret) — the dependable route; without it the free ladder is tried
async function fredApi(id) {
  const u = 'https://api.stlouisfed.org/fred/series/observations?series_id=' + id + '&api_key=' + FRED_KEY + '&file_type=json&observation_start=1990-01-01';
  const j = JSON.parse(await get(u, undefined, 20000));
  const rows = [];
  for (const o of (j.observations || [])) { const n = +o.value; if (o.value !== '.' && Number.isFinite(n)) rows.push([o.date, n]); }
  if (rows.length < 15) throw new Error('api: too short');
  return rows;
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
  if (FRED_KEY) { try { const rows = await fredApi(id); win[k] = 'api'; return rows; } catch (e) { err = String((e && e.message) || e).slice(0, 80); } }
  for (let i = 0; i < routes.length; i++) {
    const [u, isDirect] = routes[i];
    if (isDirect && fredDirectDead) continue;
    try { const rows = parseFred(await get(u, undefined, isDirect ? 6000 : 10000)); win[k] = i; return rows; }
    catch (e) { err = String((e && e.message) || e).slice(0, 80); if (isDirect && /abort/i.test(err)) fredDirectDead = true; }
  }
  throw new Error(err);
}
const old = fs.existsSync('data/macro.json') ? JSON.parse(fs.readFileSync('data/macro.json', 'utf8')) : { series: {} };
const series = {}, fail = {};
let fredLeft = Object.entries(FRED);
for (let pass = 1; pass <= 2 && fredLeft.length; pass++) {                  // the relays refuse single requests at random (the sea-fetch lesson) — a second pass mops up;
  if (pass > 1) { console.log('pass ' + pass + ': retrying ' + fredLeft.length); await new Promise(r => setTimeout(r, 12000)); }   // three series at once, or hanging routes blow the step's time budget (the 2026-11-05 night-three lesson)
  const again = []; let qi = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (qi < fredLeft.length) {
      const ent = fredLeft[qi++]; const [k, [id, name, unit, freq, tr]] = ent;
      try { series[k] = { name, unit, freq, src: 'FRED ' + id, ...digest(await fredCsv(k, id), tr) }; delete fail[k]; }
      catch (e) { fail[k] = String((e && e.message) || e).slice(0, 100); again.push(ent); }
      await new Promise(r => setTimeout(r, 200));
    }
  }));
  fredLeft = again;
}
for (const [k] of fredLeft) if (old.series[k]) series[k] = old.series[k];   // still refused: keep the prior night's dial
auth = await getAuth();
// market-type dials have Yahoo twins — the one route proven to work from GitHub's servers (2026-11-05).
const YF_FALLBACK = { vix: '^VIX', y10: '^TNX', dxy: 'DX-Y.NYB', oil: 'CL=F' };
for (const [k, sym] of Object.entries(YF_FALLBACK)) {
  if (series[k] && !fail[k]) continue;
  try {
    let rows = await yahooDaily(sym);
    if (k === 'y10' && rows[rows.length - 1][1] > 20) rows = rows.map(x => [x[0], x[1] / 10]);   // ^TNX has quoted the 10-year yield both plain and times ten — take whichever this is
    series[k] = { name: k === 'dxy' ? 'US dollar index (DXY)' : FRED[k][1], unit: FRED[k][2], freq: 'D', src: 'Yahoo ' + sym, ...digest(rows, 'raw') };
    delete fail[k]; win[k] = 'yahoo';
  } catch (e) { void e; }
}
if (fail.curve && series.y10 && series.y2 && !fail.y2) {                    // the curve is just 10y minus 2y — compute it when both legs are fresh
  const h2 = new Map(series.y2.hist), hist = series.y10.hist.filter(x => h2.has(x[0])).map(x => [x[0], Math.round((x[1] - h2.get(x[0])) * 100) / 100]);
  if (hist.length > 1) { series.curve = { name: FRED.curve[1], unit: 'pp', freq: 'D', src: 'computed 10y − 2y', date: series.y10.date, val: Math.round((series.y10.val - series.y2.val) * 100) / 100, prev: Math.round((series.y10.prev - series.y2.prev) * 100) / 100, hist }; delete fail.curve; win.curve = 'computed'; }
}
for (const [k, [sym, name, unit]] of Object.entries(YAHOO)) {
  try { series[k] = { name, unit, freq: 'D', src: 'Yahoo ' + sym, ...digest(await yahooDaily(sym), 'raw') }; }
  catch (e) { fail[k] = String((e && e.message) || e).slice(0, 100); if (old.series[k]) series[k] = old.series[k]; }
}
const got = Object.keys(series).length;
console.log('ok', got, 'fail', Object.keys(fail).length, Object.keys(fail).join(' '));
if (!got) process.exit(1);                                                  // nothing at all (and nothing old to keep): leave the file alone
fs.writeFileSync('data/macro.json', JSON.stringify({ v: 1, at: Date.now(), series, fail, win }, null, 1));
