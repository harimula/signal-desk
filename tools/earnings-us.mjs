// Writes data/earnings-us.json — each US symbol's next scheduled earnings date, from Yahoo's calendar (run nightly by
// GitHub Actions, .github/workflows/earnings-us.yml). The bot reads it at each check: with the news guard on, a new stock
// buy steps aside when the company reports within 7 days, a new CALL within its own expiry window (optDays), and the
// wheel sells no new put within 7 days of a report — a scheduled date is firmer than hoping a headline shows up.
// Symbols: the sector map (everything the market scan usually picks), the bot's default list, the owner's configured
// list, and the board (symbols.json). A failed symbol keeps yesterday's date; the report is committed for diagnosis.
import fs from 'node:fs';
import { SECTOR } from '../bot/risk.mjs';
import { DEFAULT_SYMBOLS } from '../bot/config.mjs';

const cfgSyms = (() => { try { return JSON.parse(fs.readFileSync('bot/config.json', 'utf8')).symbols || []; } catch (e) { void e; return []; } })();
const boardSyms = (() => { try { return JSON.parse(fs.readFileSync('symbols.json', 'utf8')); } catch (e) { void e; return []; } })();
const syms = [...new Set([...Object.keys(SECTOR), ...DEFAULT_SYMBOLS, ...cfgSyms, ...boardSyms])]
  .filter(s => /^[A-Z.]{1,6}$/.test(s)).sort().slice(0, 600);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
let auth = null;                                                            // Yahoo's cookie+crumb, same dance as tools/sea-fetch.mjs (quoteSummary 401s without it)
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
      const raw = ed.map(d => d && d.raw).filter(v => v > 0).sort()[0];     // a range of dates: the earliest is the risk
      return raw ? new Date(raw * 1000).toISOString().slice(0, 10) : '';    // '' = answered, but no date scheduled
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
}
console.log('answered', got, 'of', syms.length, '· with a date', Object.keys(dates).length, '· fail', left.length);
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), dates, report: { asked: syms.length, answered: got, fail: left.length, crumb: !!auth, why } }, null, 1));
if (!got) process.exit(1);                                                  // nothing answered at all: fail loudly, keep yesterday's file
