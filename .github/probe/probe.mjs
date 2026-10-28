// One-off probe (temporary branch, deleted after): which Indian results-calendar sources answer from a GitHub runner?
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const out = (k, v) => console.log(k.padEnd(26), typeof v === 'string' ? v : JSON.stringify(v).slice(0, 900));
async function get(url, headers = {}, ms = 20000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: ctl.signal, redirect: 'follow' }); return { status: r.status, txt: await r.text(), headers: r.headers }; }
  catch (e) { return { status: 0, txt: String((e && e.message) || e) }; } finally { clearTimeout(t); }
}
const cookies = r => (r.headers && r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const NIFTY = ['RELIANCE', 'TCS', 'HDFCBANK', 'ICICIBANK', 'INFY', 'BHARTIARTL', 'ITC', 'SBIN', 'LT', 'HINDUNILVR', 'MARUTI', 'BAJFINANCE', 'AXISBANK', 'KOTAKBANK', 'SUNPHARMA'];
// 1. BSE forthcoming results
for (const [lab, q] of [['BSE next 21d', `?fromdate=${ymd(new Date())}&todate=${ymd(new Date(Date.now() + 21 * 864e5))}`], ['BSE past 10d', `?fromdate=${ymd(new Date(Date.now() - 10 * 864e5))}&todate=${ymd(new Date())}`], ['BSE no dates', '']]) {
  const r = await get('https://api.bseindia.com/BseIndiaAPI/api/Corpforthresults/w' + q, { accept: 'application/json, text/plain, */*', origin: 'https://www.bseindia.com', referer: 'https://www.bseindia.com/', 'sec-fetch-site': 'same-site' });
  out(lab, r.status + ' · ' + r.txt.length + ' bytes');
  try { const j = JSON.parse(r.txt); const a = Array.isArray(j) ? j : (j.Table || []); out(lab + ' n', a.length); out(lab + ' sample', a.slice(0, 2)); out(lab + ' nifty', a.filter(x => NIFTY.includes(String(x.short_name || '').toUpperCase())).map(x => x.short_name + ' ' + x.meeting_date)); } catch (e) { out(lab + ' body', r.txt.slice(0, 300)); }
}
// 2. NSE event calendar, recent results, results comparison (cookies from the home page first)
{
  const home = await get('https://www.nseindia.com/', { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' });
  let ck = cookies(home);
  out('NSE home', home.status + ' · cookies ' + ck.split('; ').filter(Boolean).length);
  const H = { accept: 'application/json, text/plain, */*', 'accept-language': 'en-US,en;q=0.9', referer: 'https://www.nseindia.com/companies-listing/corporate-filings-event-calendar', cookie: ck };
  for (const [lab, u] of [['NSE event-calendar', 'https://www.nseindia.com/api/event-calendar'], ['NSE fin-results', 'https://www.nseindia.com/api/corporates-financial-results?index=equities&period=Quarterly'], ['NSE results-comp', 'https://www.nseindia.com/api/results-comparision?symbol=RELIANCE']]) {
    const r = await get(u, H);
    out(lab, r.status + ' · ' + r.txt.length + ' bytes');
    try { const j = JSON.parse(r.txt); const a = Array.isArray(j) ? j : (j.data || j.resCmpData || Object.keys(j)); out(lab + ' n', Array.isArray(a) ? a.length : a); out(lab + ' sample', Array.isArray(a) ? a.slice(0, 2) : j); if (Array.isArray(a)) out(lab + ' nifty', a.filter(x => NIFTY.includes(String(x.symbol || '').toUpperCase())).slice(0, 8).map(x => [x.symbol, x.date || x.bm_date || x.filingDate || x.re_from_dt || '', String(x.purpose || x.bm_purpose || x.relatingTo || '').slice(0, 40)])); } catch (e) { out(lab + ' body', r.txt.slice(0, 200)); }
  }
}
// 3. Yahoo quoteSummary with a crumb (earnings date, EPS estimate, last quarters)
{
  const a = await get('https://fc.yahoo.com', {});
  const ck = cookies(a);
  const c = await get('https://query1.finance.yahoo.com/v1/test/getcrumb', { cookie: ck });
  out('Yahoo crumb', c.status + ' · ' + (c.status === 200 ? 'got one' : c.txt.slice(0, 80)));
  for (const s of ['RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'MARUTI.NS']) {
    const q = await get(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${s}?modules=calendarEvents,earningsHistory&crumb=${encodeURIComponent(c.txt)}`, { cookie: ck });
    out('Yahoo ' + s, q.status + ' · ' + q.txt.length + ' bytes');
    try { const r = JSON.parse(q.txt).quoteSummary.result[0]; const e = r.calendarEvents && r.calendarEvents.earnings; out('  calendar', e ? { dates: (e.earningsDate || []).map(x => x.fmt), epsAvg: e.earningsAverage && e.earningsAverage.raw, revAvg: e.revenueAverage && e.revenueAverage.raw, call: (e.earningsCallDate || []).map(x => x.fmt) } : 'none'); const h = r.earningsHistory && r.earningsHistory.history; out('  history', (h || []).map(x => [x.quarter && x.quarter.fmt, x.epsActual && x.epsActual.raw, x.epsEstimate && x.epsEstimate.raw])); } catch (e) { out('  body', q.txt.slice(0, 200)); }
  }
}
