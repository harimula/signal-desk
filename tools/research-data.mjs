// Downloads the price history behind the win-rate study (tools/winrate-study.mjs) into research-data/*.json.gz.
// Run by .github/workflows/research-data.yml (manual), which pushes the files to the separate `research-data` branch —
// never to main, so the site and the bot never see them.
//   daily.json.gz  — daily bars, Yahoo Finance (split-adjusted), the same source as bot/research.mjs: the research list
//                    (39 large companies, ~33 years), the bot's current scan list (20 years), SPY, QQQ and the VIX
//   spy1m.json.gz  — SPY one-minute bars, regular hours, from the broker's market-data API (IEX, as the bot sees them)
//   spyopt.json.gz — a sample of real SPY option minute bars (next-day expiry, strikes around the open), to check the
//                    option-price model the study uses for older days
// Reads prices only: no account, order or position data.
import fs from 'node:fs';
import zlib from 'node:zlib';

const OUT = 'research-data';
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const p6 = x => +(+x).toPrecision(6);
const dayNum = s => Math.round(Date.parse(s + 'T00:00:00Z') / 864e5);
const save = (name, obj) => { const buf = zlib.gzipSync(JSON.stringify(obj), { level: 9 }); fs.writeFileSync(`${OUT}/${name}`, buf); console.log(`${name}: ${(buf.length / 1e6).toFixed(1)} MB`); };

// ---- daily bars (Yahoo) ----
const BASE = 'AAPL,MSFT,KO,JNJ,PG,XOM,CVX,JPM,WMT,MCD,DIS,IBM,GE,CAT,BA,MMM,HD,INTC,ORCL,T,VZ,PFE,MRK,PEP,NKE,AXP,GS,UNH,LOW,TXN,AMD,ADBE,COST,SBUX,CSCO,QCOM,AMGN,GD,LMT'.split(',');
let scan = []; try { scan = JSON.parse(fs.readFileSync('bot/scan.json', 'utf8')).symbols || []; } catch (e) {}
async function yahoo(sym, range) {
  for (let a = 0; a < 6; a++) {
    let r; try { r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=1d`, { headers: { 'user-agent': 'Mozilla/5.0' } }); }
    catch (e) { await sleep(2000 * (a + 1)); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(4000 * (a + 1)); continue; }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const res = (await r.json()).chart.result[0], q = res.indicators.quote[0];
    const o = { d: [], o: [], h: [], l: [], c: [], v: [] }; let prev = 0;
    res.timestamp.forEach((t, i) => {
      if (q.close[i] == null || q.high[i] == null || q.low[i] == null || !(q.close[i] > 0)) return;
      const dn = dayNum(new Date(t * 1000).toISOString().slice(0, 10)); if (dn <= prev) return;
      o.d.push(dn - prev); prev = dn;                                       // dates as day numbers, delta-encoded
      o.o.push(p6(q.open[i] ?? q.close[i])); o.h.push(p6(q.high[i])); o.l.push(p6(q.low[i])); o.c.push(p6(q.close[i])); o.v.push(Math.round((q.volume[i] || 0) / 100));
    });
    return o;
  }
  throw new Error('rate limited');
}
const daily = {}, want = [...new Set(['SPY', 'QQQ', '^VIX', ...BASE, ...scan])];
for (const s of want) {
  try { daily[s] = await yahoo(s, BASE.includes(s) || ['SPY', 'QQQ', '^VIX'].includes(s) ? '40y' : '20y'); }
  catch (e) { console.log('skip', s, e.message); }
  await sleep(300);
}
console.log('daily symbols', Object.keys(daily).length, 'of', want.length);
save('daily.json.gz', { at: new Date().toISOString(), base: BASE, scan, bars: daily });

// ---- SPY minute bars and a sample of SPY option bars (broker market data, paper keys) ----
const KEY = process.env.ALPACA_KEY, SECRET = process.env.ALPACA_SECRET;
if (!KEY || !SECRET) { console.log('no market-data keys — SPY minute bars skipped'); process.exit(0); }
const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET };
async function data(url) {
  for (let a = 0; a < 6; a++) {
    let r; try { r = await fetch('https://data.alpaca.markets' + url, { headers: H }); } catch (e) { await sleep(2000 * (a + 1)); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(3000 * (a + 1)); continue; }
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 120));
    return r.json();
  }
  throw new Error('rate limited');
}
const offCache = {};
const etMins = ms => {                                                       // minutes past midnight, New York time
  const day = new Date(ms).toISOString().slice(0, 10);
  if (offCache[day] == null) { const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(day + 'T16:00:00Z')).map(x => [x.type, x.value])); offCache[day] = (+p.hour % 24) * 60 + +p.minute - 16 * 60; }
  const u = new Date(ms); return ((u.getUTCHours() * 60 + u.getUTCMinutes() + offCache[day]) % 1440 + 1440) % 1440;
};
const startM = process.env.SPY_FROM || '2023-01-01', endM = new Date(Date.now() - 20 * 60000).toISOString();
const m1 = { t: [], o: [], h: [], l: [], c: [], v: [] }; let token = null, pages = 0, lastT = 0;
do {
  const j = await data(`/v2/stocks/bars?symbols=SPY&timeframe=1Min&start=${startM}T00:00:00Z&end=${endM}&limit=10000&feed=iex&adjustment=raw&sort=asc${token ? '&page_token=' + token : ''}`);
  for (const b of (j.bars && j.bars.SPY) || []) {
    const ms = Date.parse(b.t), m = etMins(ms); if (m < 570 || m >= 960) continue;   // regular hours only
    const t = Math.round(ms / 60000); m1.t.push(t - lastT); lastT = t;                // minute numbers, delta-encoded
    m1.o.push(+b.o.toFixed(2)); m1.h.push(+b.h.toFixed(2)); m1.l.push(+b.l.toFixed(2)); m1.c.push(+b.c.toFixed(2)); m1.v.push(b.v);
  }
  token = j.next_page_token; pages++;
} while (token && pages < 400);
console.log('SPY minute bars', m1.t.length, 'pages', pages);
save('spy1m.json.gz', { at: new Date().toISOString(), feed: 'iex', bars: m1 });

// a sample of real option bars: the last OPT_DAYS trading days, next-day expiry, 7 strikes around the open, calls and puts
const days = []; { let t = 0; const seen = new Set(); for (let i = 0; i < m1.t.length; i++) { t += m1.t[i]; const d = new Date(t * 60000).toISOString().slice(0, 10); if (!seen.has(d)) { seen.add(d); days.push({ d, open: m1.o[i] }); } } }
const N = +(process.env.OPT_DAYS || 60), opt = {}, occ = (exp, cp, k) => `SPY${exp.slice(2, 4)}${exp.slice(5, 7)}${exp.slice(8, 10)}${cp}${String(Math.round(k * 1000)).padStart(8, '0')}`;
let got = 0, tried = 0;
for (let i = Math.max(0, days.length - N - 1); i < days.length - 1; i++) {
  const { d, open } = days[i], exp = days[i + 1].d, k0 = Math.round(open), syms = [];
  for (let k = k0 - 3; k <= k0 + 3; k++) for (const cp of ['C', 'P']) syms.push(occ(exp, cp, k));
  let tok = null, pg = 0; tried++;
  try {
    do {
      const j = await data(`/v1beta1/options/bars?symbols=${syms.join(',')}&timeframe=1Min&start=${d}T13:00:00Z&end=${d}T21:00:00Z&limit=10000${tok ? '&page_token=' + tok : ''}`);
      for (const [s, bars] of Object.entries(j.bars || {})) { const o = opt[s] || (opt[s] = { day: d, t: [], o: [], h: [], l: [], c: [], v: [] }); for (const b of bars) { o.t.push(Math.round(Date.parse(b.t) / 60000)); o.o.push(b.o); o.h.push(b.h); o.l.push(b.l); o.c.push(b.c); o.v.push(b.v); } }
      tok = j.next_page_token; pg++;
    } while (tok && pg < 20);
    got++;
  } catch (e) { console.log('option bars', d, e.message); if (tried > 3 && !got) break; }
  await sleep(150);
}
console.log('option days', got, 'of', tried, 'contracts', Object.keys(opt).length);
save('spyopt.json.gz', { at: new Date().toISOString(), days: got, bars: opt });
