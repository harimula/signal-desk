// India earnings calendar for the Earnings tab (shown when the page's market switch is on India). No keys needed.
//   · Dates: NSE's event calendar — the board meetings that approve quarterly results, from two weeks back to three weeks
//     ahead, in one request (after NSE's home page has set its cookies). When NSE does not answer: BSE's list of
//     forthcoming results (future dates only; the past two weeks are kept from the previous file).
//   · Numbers, for the big companies only (the Nifty 100 and the page's own India list): Yahoo Finance's EPS and revenue
//     estimates for the next report, and the last quarters' reported EPS against the estimate.
//   · Written to earnings-in.json, which index.html reads (same origin). Run hourly by .github/workflows/earnings-in.yml.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { NIFTY100 } from './bot/india.mjs';

export const FILE = 'earnings-in.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12, january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const pad = n => String(n).padStart(2, '0');
const ymd = (y, m, d) => (y > 1990 && m >= 1 && m <= 12 && d >= 1 && d <= 31) ? `${y}-${pad(m)}-${pad(d)}` : '';
export const istDay = (ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(ms));
export const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dmy = d => d.slice(8, 10) + '-' + d.slice(5, 7) + '-' + d.slice(0, 4);     // NSE wants dd-mm-yyyy

// "30-Oct-2026" (NSE) and "30 Oct 2026" (BSE) → 2026-10-30
export function parseDay(s) {
  const m = /^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s-]+(\d{4})/.exec(String(s || '').trim());
  return m && MON[m[2].toLowerCase()] ? ymd(+m[3], MON[m[2].toLowerCase()], +m[1]) : '';
}
const titleCase = s => String(s || '').toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).trim();
const isQuarterEnd = d => /-(03-31|06-30|09-30|12-31)$/.test(d || '');
// the latest quarter end before a day: a meeting on 2026-10-30 approves the quarter to 2026-09-30
export function quarterEndBefore(d) {
  const y = +d.slice(0, 4);
  return [`${y}-12-31`, `${y}-09-30`, `${y}-06-30`, `${y}-03-31`, `${y - 1}-12-31`].find(q => q < d) || '';
}
// the quarter a results meeting is about: the date after "ended" in NSE's description ("for the period ended September 30,
// 2026", "quarter ended 30th September, 2026", "half year ended 30.09.2026"); otherwise the quarter end before the meeting
export function periodEnd(desc, meeting) {
  const t = String(desc || '').toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, '$1');
  const at = t.search(/\bend(ed|ing)\b/), s = at < 0 ? t : t.slice(at);
  let iso = '';
  for (const m of s.matchAll(/([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/g)) if (MON[m[1]]) { iso = ymd(+m[3], MON[m[1]], +m[2]); break; }
  if (!iso) for (const m of s.matchAll(/(\d{1,2})[\s-]+([a-z]+)\.?[,\s-]+(\d{4})/g)) if (MON[m[2]]) { iso = ymd(+m[3], MON[m[2]], +m[1]); break; }
  if (!iso) { const m = /(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(s); if (m) iso = ymd(+m[3], +m[2], +m[1]); }
  return isQuarterEnd(iso) && iso < meeting ? iso : quarterEndBefore(meeting);
}
// NSE event calendar rows → {s symbol, n company, d meeting day, p quarter end}; results meetings only, one per company and day
export function fromNse(list) {
  const out = new Map();
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || !/financial results?/i.test(`${e.purpose || ''} ${e.bm_desc || ''}`)) continue;
    const s = String(e.symbol || '').trim().toUpperCase(), d = parseDay(e.date);
    if (!/^[A-Z0-9&-]{1,20}$/.test(s) || !d) continue;
    const n = String(e.company || '').trim();
    out.set(s + '|' + d, { s, n: (/[a-z]/.test(n) ? n : titleCase(n)).slice(0, 80), d, p: periodEnd(e.bm_desc, d) });   // a few names come in capitals
  }
  return [...out.values()];
}
// BSE forthcoming results → the same shape (BSE's short name is the NSE symbol for nearly every large company)
export function fromBse(list) {
  const out = new Map();
  for (const e of Array.isArray(list) ? list : []) {
    const s = String((e && e.short_name) || '').trim().toUpperCase(), d = parseDay(e && e.meeting_date);
    if (!/^[A-Z0-9&-]{1,20}$/.test(s) || !d) continue;
    out.set(s + '|' + d, { s, n: titleCase(e.Long_Name).slice(0, 80), d, p: quarterEndBefore(d) });
  }
  return [...out.values()];
}
// big companies: the Nifty 100 in index order (1–50 ≈ the Nifty 50), then the page's own India stocks
export function bigList(pageSyms = []) {
  const extra = pageSyms.map(s => String(s).toUpperCase().replace(/\.(NS|BO)$/, '')).filter(s => /^[A-Z0-9&-]{1,20}$/.test(s) && !NIFTY100.includes(s));
  return [...NIFTY100, ...new Set(extra)];
}
export const bigRank = (s, list) => { const i = list.indexOf(s); return i < 0 ? 0 : i + 1; };
// Yahoo's quoteSummary (calendarEvents + earningsHistory) → {d next report day, eE, rE estimates, h [[quarter end, actual, estimate]]}
export function parseYahoo(j) {
  const r = j && j.quoteSummary && Array.isArray(j.quoteSummary.result) && j.quoteSummary.result[0]; if (!r) return null;
  const raw = x => (x && typeof x.raw === 'number' && Number.isFinite(x.raw)) ? x.raw : null;
  const e = (r.calendarEvents && r.calendarEvents.earnings) || {};
  const h = ((r.earningsHistory && r.earningsHistory.history) || []).map(x => [x && x.quarter && x.quarter.fmt, raw(x && x.epsActual), raw(x && x.epsEstimate)]).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x[0] || ''));
  return { d: ((e.earningsDate || []).map(x => x && x.fmt).find(x => /^\d{4}-\d{2}-\d{2}$/.test(x || ''))) || null, eE: raw(e.earningsAverage), rE: raw(e.revenueAverage), h };
}
const days = (a, b) => Math.round((Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 864e5);
// numbers for the big companies: reported EPS against its estimate for the quarter (Yahoo's history), else — for a report
// still to come and matching Yahoo's next date (±20 days) — today's estimates; estimates seen before a report are kept
export function withNumbers(rows, Y, prevRows, today) {
  const prev = new Map((prevRows || []).map(r => [r.s + '|' + r.d, r]));
  return rows.map(r => {
    const x = { s: r.s, n: r.n, d: r.d, p: r.p, k: r.k };
    if (!r.k) return x;
    const y = Y[r.s], o = prev.get(r.s + '|' + r.d) || {}, hit = y && (y.h || []).find(h => h[0] === r.p);
    if (hit && hit[1] != null) { x.eA = hit[1]; x.eE = hit[2] != null ? hit[2] : o.eE; }
    else if (y && r.d >= today && y.d && Math.abs(days(y.d, r.d)) <= 20) { x.eE = y.eE != null ? y.eE : o.eE; x.rE = y.rE != null ? y.rE : o.rE; }
    else { x.eE = o.eE; if (hit && hit[2] != null) x.eE = hit[2]; }
    if (x.rE == null && o.rE != null) x.rE = o.rE;
    for (const k of ['eE', 'eA', 'rE']) if (x[k] == null) delete x[k];
    return x;
  });
}

// one meeting per company and quarter: a moved meeting stays listed on its old day too. Reported (EPS in) → the last
// meeting held; not yet → the latest date (the new one)
export function onePerQuarter(rows, today) {
  const G = new Map();
  for (const r of rows) { const k = r.s + '|' + r.p; if (!G.has(k)) G.set(k, []); G.get(k).push(r); }
  const out = [];
  for (const g of G.values()) {
    if (g.length === 1) { out.push(g[0]); continue; }
    g.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
    const held = g.filter(r => r.d <= today);
    out.push(g.some(r => r.eA != null) && held.length ? held[held.length - 1] : g[g.length - 1]);
  }
  return out;
}

// ---- network ----
async function get(url, headers = {}, ms = 25000) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: ctl.signal }); return { status: r.status, txt: await r.text(), headers: r.headers }; }
  finally { clearTimeout(t); }
}
const cookies = r => (r.headers && r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
async function nseEvents(from, to) {
  const home = await get('https://www.nseindia.com/', { accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' });
  if (home.status !== 200) throw new Error('home page HTTP ' + home.status);
  const r = await get(`https://www.nseindia.com/api/event-calendar?index=equities&from_date=${dmy(from)}&to_date=${dmy(to)}`,
    { accept: 'application/json, text/plain, */*', 'accept-language': 'en-US,en;q=0.9', referer: 'https://www.nseindia.com/companies-listing/corporate-filings-event-calendar', cookie: cookies(home) });
  if (r.status !== 200) throw new Error('event calendar HTTP ' + r.status);
  const j = JSON.parse(r.txt); if (!Array.isArray(j)) throw new Error('event calendar: not a list');
  return j;
}
async function bseResults(from, to) {
  const r = await get(`https://api.bseindia.com/BseIndiaAPI/api/Corpforthresults/w?fromdate=${from.replace(/-/g, '')}&todate=${to.replace(/-/g, '')}`,
    { accept: 'application/json, text/plain, */*', origin: 'https://www.bseindia.com', referer: 'https://www.bseindia.com/' });
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  const j = JSON.parse(r.txt); if (!Array.isArray(j)) throw new Error('not a list');
  return j;
}
async function yahooSession() {
  const a = await get('https://fc.yahoo.com', {}, 15000).catch(() => null);
  const ck = a ? cookies(a) : '';
  const c = await get('https://query1.finance.yahoo.com/v1/test/getcrumb', ck ? { cookie: ck } : {}, 15000);
  return c.status === 200 && c.txt && !/[<{\s]/.test(c.txt.trim()) ? { ck, crumb: c.txt.trim() } : null;
}
async function yahooOne(sess, sym) {
  const r = await get(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym + '.NS')}?modules=calendarEvents,earningsHistory&crumb=${encodeURIComponent(sess.crumb)}`, sess.ck ? { cookie: sess.ck } : {}, 15000);
  if (r.status !== 200) throw new Error('HTTP ' + r.status);
  return parseYahoo(JSON.parse(r.txt));
}

export async function main() {
  const now = Date.now(), today = istDay(now), from = addDays(today, -14), to = addDays(today, 21);
  let prev = null; try { prev = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {}
  let rows = [], src = '';
  try { rows = fromNse(await nseEvents(from, to)); src = 'NSE'; } catch (e) { console.log('NSE: ' + e.message); }
  if (!rows.length) {
    try {
      const b = fromBse(await bseResults(today, to));
      if (b.length) { rows = ((prev && prev.rows) || []).filter(r => r.d >= from && r.d < today).concat(b); src = 'BSE'; }
    } catch (e) { console.log('BSE: ' + e.message); }
  }
  if (!rows.length) { console.log('Neither NSE nor BSE answered: the previous file stays'); return; }
  let pageSyms = []; try { pageSyms = JSON.parse(fs.readFileSync('symbols.json', 'utf8')).filter(s => /\.NS$/.test(s)); } catch (e) {}
  const BIG = bigList(pageSyms);
  rows = rows.filter(r => r.d >= from && r.d <= to).map(r => ({ ...r, k: bigRank(r.s, BIG) }));
  // Yahoo: each big company at most every 6 hours, hourly around its report day (2 days either side)
  const Y = {}, oldY = (prev && prev.y) || {};
  for (const s of BIG) if (oldY[s]) Y[s] = oldY[s];
  const near = new Set(rows.filter(r => r.k && Math.abs(days(r.d, today)) <= 2).map(r => r.s));
  const need = BIG.filter(s => !Y[s] || now - Y[s].at > 6 * 3600e3 || (near.has(s) && now - Y[s].at > 50 * 60e3));
  let asked = 0, got = 0;
  if (need.length) {
    const sess = await yahooSession().catch(e => { console.log('Yahoo session: ' + e.message); return null; });
    if (sess) {
      let i = 0;
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (i < need.length) {
          const s = need[i++]; asked++;
          try { const y = await yahooOne(sess, s); if (y) { Y[s] = { ...y, at: Date.now() }; got++; } } catch (e) { if (asked <= 3) console.log(`Yahoo ${s}: ${e.message}`); }
        }
      }));
    }
  }
  rows = onePerQuarter(withNumbers(rows, Y, prev && prev.rows, today), today).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0) || (a.k || 999) - (b.k || 999) || (a.s < b.s ? -1 : 1));
  const same = prev && prev.src === src && JSON.stringify(prev.rows) === JSON.stringify(rows) && now - (prev.at || 0) < 6 * 3600e3;
  console.log(`${rows.length} results meetings ${from} → ${to} from ${src}; ${rows.filter(r => r.k).length} big; Yahoo ${got}/${asked} (${need.length} due)`);
  if (same) { console.log('No change: file left as it is'); return; }
  fs.writeFileSync(FILE, JSON.stringify({ at: now, src, from, to, rows, y: Y }));
  console.log('Wrote ' + FILE);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('India earnings failed:', e.message); process.exit(1); });
}
