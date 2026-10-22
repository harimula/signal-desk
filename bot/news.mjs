// News & event guard: scheduled macro releases (events.json) + live headlines (Alpaca/Benzinga news).
// Pure rules here; bot.mjs feeds it the clock, headlines and SPY's move.
import fs from 'node:fs';

export const KEYWORDS = {
  war:    ['war', 'wars', 'warfare', 'missile', 'missiles', 'invasion', 'invade', 'invaded', 'airstrike', 'air strike', 'military strike', 'troops', 'nuclear', 'attack on', 'terror*', 'escalat*', 'blockade', 'ceasefire'],
  policy: ['white house', 'tariff*', 'executive order', 'trade war', 'export control*', 'sanction*', 'government shutdown', 'debt ceiling', 'impeach*'],
  fed:    ['fomc', 'federal reserve', 'fed chair', 'powell', 'rate hike', 'rate cut', 'emergency rate', 'fed minutes', 'fed holds', 'fed raises', 'fed cuts'],
  macro:  ['cpi', 'inflation', 'jobs report', 'payrolls', 'unemployment rate', 'gdp', 'recession', 'pce'],
  crisis: ['bank failure', 'bank run', 'market crash', 'flash crash', 'contagion', 'systemic risk', 'credit crisis', 'market-wide halt'],
  single: ['circuit breaker', 'trading halt', 'halted', 'bankrupt*', 'chapter 11', 'default*', 'delisted'],
};
const HIGH = ['war', 'policy', 'crisis'];                      // categories that pause new trades on their own
// 'single' is deliberately NOT high-impact: one company halting is news for that ticker
// (symbolRisk skips it), not a reason to stop trading everything else.

// Whole-word matching. Substring matching once made "Stewart" and "Software" look like war
// headlines, which paused the bot all day. A trailing * keeps a deliberate stem (terror*).
const RX = {};
const rxFor = w => RX[w] || (RX[w] = new RegExp(
  '\\b' + w.replace(/\*$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (w.endsWith('*') ? '' : '\\b'), 'i'));

export function classify(text) {
  const t = ' ' + (text || '') + ' ';
  const hits = [];
  for (const [cat, words] of Object.entries(KEYWORDS)) if (words.some(w => rxFor(w).test(t))) hits.push(cat);
  return hits;
}

export function loadEvents(path = 'events.json') {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')).events || []; } catch (e) { return []; }
}

const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// Decide today's trading mode from the calendar, the clock (minutes ET), live headlines and SPY.
// headlines: [{headline, created_at, source, url, symbols}]   spyPct: SPY % vs previous close
export function guard({ events, todayDash, mins, headlines = [], spyPct = null, nowMs = Date.now() }) {
  const today = events.filter(e => e.date === todayDash);
  const week = events.filter(e => e.date > todayDash).slice(0, 5);
  const out = { today, upcoming: week, block: false, noOptions: false, noLongs: false, noPuts: false, budget: 1, minStart: 585, closeOptionsAt: null, reasons: [], flagged: [] };
  for (const e of today) {
    const t = toMin(e.time);
    if (e.type === 'FOMC') {
      out.noOptions = true; out.budget = Math.min(out.budget, 0.5); out.closeOptionsAt = t - 10;
      if (mins >= t - 30 && mins < t + 60) { out.block = true; out.reasons.push(`${e.title} — no new trades ${fmtT(t - 30)}–${fmtT(t + 60)}`); }
      else out.reasons.push(`${e.title} today — half size, no new options`);
    } else if (e.type === 'MINUTES') {
      if (mins >= t - 15 && mins < t + 30) { out.block = true; out.reasons.push(`${e.title} — paused ${fmtT(t - 15)}–${fmtT(t + 30)}`); }
    } else {                                                    // CPI / JOBS / PPI at 8:30, before the open
      out.minStart = Math.max(out.minStart, 615);              // let the first 45 min of price discovery settle
      if (mins < 660) out.budget = Math.min(out.budget, 0.5);
      out.reasons.push(`${e.title} released ${e.time} — entries from 10:15, half size until 11:00`);
    }
  }
  // live headlines: anything high-impact in the last 30 minutes pauses new entries
  for (const h of headlines) {
    const cats = classify(h.headline + ' ' + (h.summary || ''));
    if (!cats.length) continue;
    const age = Math.max(0, (nowMs - Date.parse(h.created_at)) / 60000);
    if (age > 90) continue;
    out.flagged.push({ t: h.created_at, headline: h.headline, source: h.source, url: h.url, cats });
    if (age <= 30 && cats.some(c => HIGH.includes(c))) {
      out.block = true;
      out.reasons.push(`Breaking: “${h.headline.slice(0, 90)}” — paused until ${fmtT(mins + Math.ceil(30 - age))}`);
    }
  }
  // market tone: a big down day blocks new longs/CALLs, a big up day blocks new PUTs
  if (spyPct != null) {
    if (spyPct <= -1) out.reasons.push(`SPY ${spyPct.toFixed(2)}% today \u2014 a sell-off day; RSI-2 dip buys are built for days like this`);   // informational: RSI-2's tested edge comes from buying sell-offs
    if (spyPct >= 1) out.reasons.push(`SPY +${spyPct.toFixed(2)}% today \u2014 strong day; few RSI-2 dips expected`);
  }
  out.flagged = out.flagged.slice(0, 12);
  return out;
}
function fmtT(m) { const h = Math.floor(m / 60), mm = String(m % 60).padStart(2, '0'); return (h > 12 ? h - 12 : h) + ':' + mm + (h >= 12 ? 'pm' : 'am'); }

// Symbol-level: fresh company news (2h) or earnings talk (3 days) means skip it
export function symbolRisk(sym, articles, nowMs = Date.now()) {
  for (const a of articles) {
    if (!(a.symbols || []).includes(sym)) continue;
    const age = (nowMs - Date.parse(a.created_at)) / 3600000;
    const txt = (a.headline + ' ' + (a.summary || '')).toLowerCase();
    if (age <= 72 && /earnings|quarterly results|q[1-4] results|reports q[1-4]|guidance|to report/.test(txt)) return 'earnings news: ' + a.headline.slice(0, 70);
    if (age <= 2) return 'fresh news: ' + a.headline.slice(0, 70);
  }
  return null;
}
