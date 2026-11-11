// Writes data/earnings-us.json — each US symbol's next scheduled earnings date, from Yahoo's calendar (run nightly by
// GitHub Actions, .github/workflows/earnings-us.yml). The bot reads it at each check: with the news guard on, a new stock
// buy steps aside when the company reports within 7 days, a new CALL within its own expiry window (optDays), and the
// wheel sells no new put within 7 days of a report — a scheduled date is firmer than hoping a headline shows up.
// Symbols: the sector map (everything the market scan usually picks), the bot's default list, the owner's configured
// list, and the board (symbols.json). A failed symbol keeps yesterday's date; the report is committed for diagnosis.
import fs from 'node:fs';
import { SECTOR } from '../bot/risk.mjs';
import { DEFAULT_SYMBOLS } from '../bot/config.mjs';

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { void e; return fb; } };
const cfgSyms = readJson('bot/config.json', {}).symbols || [];
const boardSyms = readJson('symbols.json', []);
const scanSyms = readJson('bot/scan.json', {}).symbols || [];                   // the market scan's own 200 most-active (audit 2026-11-11: 24 of them were in no other list — the guard must cover what the bot actually buys)
// Funds and one delisted stock have no earnings and 404 every night — asking anyway wastes the rate budget and buries a
// real failure in a 25-deep noise floor (audit 2026-11-11). India's .NS symbols belong to earnings-in.mjs, not here.
const SKIP = new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'VOO', 'VTI', 'TLT', 'GLD', 'IAU', 'SLV', 'USO', 'UNG', 'GDX', 'SMH', 'IGV', 'TQQQ', 'SOXL', 'XLC', 'XLE', 'XLF', 'XLI', 'XLP', 'XLV', 'XLY', 'X']);
const syms = [...new Set([...Object.keys(SECTOR), ...DEFAULT_SYMBOLS, ...cfgSyms, ...boardSyms, ...scanSyms])]
  .filter(s => /^[A-Z.]{1,6}$/.test(s) && !/\.(NS|BO)$/.test(s) && !SKIP.has(s)).sort().slice(0, 600);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
let auth = null;                                                            // Yahoo's cookie+crumb, same dance as tools/sea-fetch.mjs (quoteSummary 401s without it)
async function getAuth() {                                                  // two tries, 8s cap per request: one blackholed request must not forfeit the night (audit 2026-11-11)
  for (let a = 0; a < 2; a++) {
    const t8 = () => AbortSignal.timeout(8000);
    try {
      const r1 = await fetch('https://fc.yahoo.com/', { headers: { 'user-agent': UA }, redirect: 'manual', signal: t8() });
      const cookie = String(r1.headers.get('set-cookie') || '').split(';')[0];
      if (!cookie) continue;
      const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { 'user-agent': UA, cookie }, signal: t8() });
      const crumb = (await r2.text()).trim();
      if (r2.ok && crumb && crumb.length <= 32 && !crumb.includes('<')) return { cookie, crumb };
    } catch (e) { void e; }
    await new Promise(r => setTimeout(r, 3000));
  }
  return null;
}
async function pull(s) {
  const e = encodeURIComponent(s), cr = auth ? '&crumb=' + encodeURIComponent(auth.crumb) : '';
  let err = '';
  for (const host of ['query1', 'query2']) {
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v10/finance/quoteSummary/${e}?modules=calendarEvents${cr}`,
        { headers: auth ? { 'user-agent': UA, cookie: auth.cookie } : { 'user-agent': UA }, signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const x = (await r.json()).quoteSummary.result[0];
      const ed = (((x || {}).calendarEvents || {}).earnings || {}).earningsDate || [];
      // The earliest date that is not already past: right after a report Yahoo can list [the past actual, the next
      // scheduled] — the past one must not shadow the real risk (audit 2026-11-11). Past-only = nothing scheduled.
      const days = ed.map(d => d && d.raw > 0 ? new Date(d.raw * 1000).toISOString().slice(0, 10) : '').filter(Boolean).sort();
      return days.find(d => d >= new Date().toISOString().slice(0, 10)) || '';   // '' = answered, nothing scheduled ahead
    } catch (e2) { err = String((e2 && e2.message) || e2); } finally { clearTimeout(tm); }
  }
  throw new Error(err || 'no data');
}

const OUT = 'data/earnings-us.json';
const prev = (() => { try { return JSON.parse(fs.readFileSync(OUT, 'utf8')).dates || {}; } catch (e) { void e; return {}; } })();
auth = await getAuth();
console.log('crumb:', auth ? 'yes' : 'no');
const today = new Date().toISOString().slice(0, 10);
const dates = {}; const why = {};
for (const [s, d] of Object.entries(prev)) if (d >= today) dates[s] = d;    // yesterday's answers stand until replaced; past dates drop off
let left = syms.slice(), got = 0;
for (let pass = 1; pass <= 3 && left.length; pass++) {
  if (pass > 1) { console.log('pass ' + pass + ': retrying ' + left.length); await new Promise(r => setTimeout(r, 15000)); }
  const fails = []; let i = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (i < left.length) {
      const s = left[i++];
      try { const d = await pull(s); got++; delete why[s]; if (d && d >= today) dates[s] = d; else delete dates[s]; }
      catch (e) { fails.push(s); why[s] = String((e && e.message) || e).slice(0, 80); }
      await new Promise(r => setTimeout(r, 220));
    }
  }));
  left = fails;
  if (got) write();                                                         // publish after every pass: a timed-out night keeps what it got (audit 2026-11-11)
}
console.log('answered', got, 'of', syms.length, '· with a date', Object.keys(dates).length, '· fail', left.length);
function write() {
  // Mass-empty guard: if a Yahoo regression answers 200-with-nothing for everything, do not blank a healthy calendar on a
  // green run — keep the previous future dates and say so in the report (audit 2026-11-11).
  const prevFuture = Object.entries(prev).filter(([, d]) => d >= today), kept = [];
  if (prevFuture.length >= 40 && Object.keys(dates).length < prevFuture.length / 2) {
    for (const [s, d] of prevFuture) if (!dates[s]) { dates[s] = d; kept.push(s); }
  }
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), dates, report: { asked: syms.length, answered: got, fail: left.length, crumb: !!auth, kept: kept.length || undefined, why } }, null, 1));
}
if (!got) { console.log('nothing answered at all — keeping yesterday\'s file untouched'); process.exit(1); }   // truly nothing: no write, the bot's staleness warning can see the file age
write();
