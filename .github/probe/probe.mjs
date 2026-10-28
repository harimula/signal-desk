// One-off probe 2 (temporary branch): NSE date-range parameters for past board meetings and recent filings.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const out = (k, v) => console.log(k.padEnd(30), typeof v === 'string' ? v : JSON.stringify(v).slice(0, 700));
async function get(url, headers = {}, ms = 25000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: ctl.signal }); return { status: r.status, txt: await r.text(), headers: r.headers }; }
  catch (e) { return { status: 0, txt: String((e && e.message) || e) }; } finally { clearTimeout(t); }
}
const dmy = d => { const x = new Date(d); return String(x.getUTCDate()).padStart(2, '0') + '-' + String(x.getUTCMonth() + 1).padStart(2, '0') + '-' + x.getUTCFullYear(); };
const home = await get('https://www.nseindia.com/', { accept: 'text/html,*/*', 'accept-language': 'en-US,en;q=0.9' });
const ck = home.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
const H = { accept: 'application/json, text/plain, */*', 'accept-language': 'en-US,en;q=0.9', referer: 'https://www.nseindia.com/companies-listing/corporate-filings-event-calendar', cookie: ck };
const now = Date.now(), from = dmy(now - 14 * 864e5), to = dmy(now + 21 * 864e5), today = dmy(now);
for (const [lab, u] of [
  ['events range', `https://www.nseindia.com/api/event-calendar?index=equities&from_date=${from}&to_date=${to}`],
  ['events default', 'https://www.nseindia.com/api/event-calendar'],
  ['results range', `https://www.nseindia.com/api/corporates-financial-results?index=equities&from_date=${dmy(now - 14 * 864e5)}&to_date=${today}&period=Quarterly`],
  ['board-meetings range', `https://www.nseindia.com/api/corporate-board-meetings?index=equities&from_date=${from}&to_date=${today}`]]) {
  const r = await get(u, H);
  out(lab, r.status + ' · ' + r.txt.length + ' bytes');
  try {
    const j = JSON.parse(r.txt), a = Array.isArray(j) ? j : (j.data || []);
    const dk = a.length ? (a[0].date ? 'date' : a[0].broadCastDate ? 'broadCastDate' : a[0].bm_date ? 'bm_date' : Object.keys(a[0])[0]) : '';
    const ds = a.map(x => String(x[dk] || '').slice(0, 11)).filter(Boolean);
    const P = s => { const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})/.exec(s); return m ? Date.parse(`${m[1]} ${m[2]} ${m[3]} UTC`) : NaN; };
    const ts = ds.map(P).filter(x => !isNaN(x)).sort((x, y) => x - y);
    out(lab + ' n / span', `${a.length} rows · ${dk}: ${ts.length ? new Date(ts[0]).toISOString().slice(0, 10) + ' → ' + new Date(ts[ts.length - 1]).toISOString().slice(0, 10) : '-'}`);
    out(lab + ' keys', a.length ? Object.keys(a[0]) : j);
    const nf = a.filter(x => ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'MARUTI', 'AXISBANK', 'KOTAKBANK', 'WIPRO', 'HCLTECH'].includes(String(x.symbol || x.bm_symbol || '').toUpperCase()));
    out(lab + ' nifty', nf.slice(0, 10).map(x => [x.symbol || x.bm_symbol, x.date || x.broadCastDate || x.bm_date, String(x.purpose || x.bm_purpose || x.relatingTo || '').slice(0, 30), x.consolidated || '', x.toDate || '']));
  } catch (e) { out(lab + ' body', r.txt.slice(0, 200)); }
}
