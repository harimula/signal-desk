// Weekly scorecard + drift alarm (owner asked for it 2026-11-04 and said build it 2026-11-06).
// Grades each lane the way trading desks grade a strategy — win rate, average win and loss, expectancy ($ per
// trade), profit factor ($ won per $ lost) — this week and across the journal's whole 60-day window, and flags a
// lane that has drifted below ITS OWN tested numbers (each lane against its own study, never another lane's).
// Pure functions only: bot.mjs feeds the journal's closed trades in and sends the texts out; test.mjs proves the rules.
const ETD = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const ETW = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
const ETM = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
export const etDay = ms => ETD.format(new Date(ms));                        // YYYY-MM-DD, New York
export const etWd = ms => WD[ETW.format(new Date(ms))] || 0;                // Monday = 1 … Sunday = 7
export const etMins = ms => { const [h, m] = ETM.format(new Date(ms)).split(':'); return (+h % 24) * 60 + +m; };
export const weekMonday = ms => etDay(ms - (etWd(ms) - 1) * 864e5);         // the Monday of that New-York week

// Which lane a closed journal trade belongs to. The wheel is everything sold-to-open or born from an option event
// (assignment / called away); SPY options bought long are the quick-options sleeve; the rest split by kind.
export const tradeLane = t => (t.wheel || t.short) ? 'wheel' : t.kind === 'Stock' ? 'stock' : t.und === 'SPY' ? 'spy' : t.kind === 'Call' ? 'call' : 'put';
export const LANE_LAB = { stock: 'Stocks', call: 'CALLs', put: 'PUTs', spy: 'SPY quick options', wheel: 'Wheel' };

// Each live rule's own tested numbers — the drift alarm's yardstick, with the study each number comes from.
export const EXPECT = {
  stock: { win: 82, src: 'winrate_report 2026-10-27: first close +0.5%, 15-day hold, market filter — 82.4% won over 33 years' },
  call: { win: 61, src: 'option-check 2026-11-06, REAL option prices (299 signals since 2024-03): tp +10% / stop −30% / 14d — 61.2% won, +1.48%/trade' },
  spy: { win: 80, src: 'spy0_report 2026-11-03: 94% won on 60 real-price days (36 trades); the long-run model sits lower — 80 is the alarm floor, not a promise' }
};
const DRIFT_N = 30, DRIFT_GAP = 8;                                          // judge only on 30+ closed trades, flag at 8+ points under the study AND losing money

const r2 = x => Math.round(x * 100) / 100;
function agg(list) {
  const w = list.filter(t => t.pl > 0), l = list.filter(t => t.pl <= 0);
  const gw = w.reduce((t, c) => t + c.pl, 0), gl = -l.reduce((t, c) => t + c.pl, 0);
  return { n: list.length, won: w.length, winPct: list.length ? r2(w.length / list.length * 100) : null,
    avgWin: w.length ? r2(gw / w.length) : null, avgLoss: l.length ? r2(-gl / l.length) : null,
    pl: r2(gw - gl), per: list.length ? r2((gw - gl) / list.length) : null,
    pf: gl > 0.005 ? r2(gw / gl) : null };                                  // profit factor; no losses yet → null, shown as “—”
}

export const monthOf = ms => etDay(ms).slice(0, 7);                         // YYYY-MM, New York
export const prevMonthOf = ms => { const [y, m] = monthOf(ms).split('-').map(Number); return (m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0')); };
export const monthLabel = ym => new Date(ym + '-15T12:00:00Z').toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
export function computeScore(closed, nowMs) {
  const monday = weekMonday(nowMs), mo = monthOf(nowMs), lanes = ['stock', 'call', 'put', 'spy', 'wheel'];
  const rows = (closed || []).map(t => ({ pl: +t.pl || 0, lane: tradeLane(t), day: etDay(Date.parse(t.outT) || nowMs) }));
  const out = { at: new Date(nowMs).toISOString(), weekOf: monday, weekKey: monday, monthOf: mo, lanes: {}, total: null, drift: [] };
  for (const ln of lanes) {
    const all = rows.filter(t => t.lane === ln);
    out.lanes[ln] = { week: agg(all.filter(t => t.day >= monday)), month: agg(all.filter(t => t.day.startsWith(mo))), all: agg(all) };
  }
  out.total = { week: agg(rows.filter(t => t.day >= monday)), month: agg(rows.filter(t => t.day.startsWith(mo))), all: agg(rows) };
  for (const ln of ['stock', 'call', 'spy']) {                              // the wheel never sells at a loss by the owner's setting — its red is paper until assignment, so it is never drift-flagged
    const last = rows.filter(t => t.lane === ln).slice(0, DRIFT_N);         // the journal's closed list is newest-first
    if (last.length < DRIFT_N) continue;
    const a = agg(last), e = EXPECT[ln];
    if (a.winPct <= e.win - DRIFT_GAP && a.pf != null && a.pf < 1) out.drift.push({ lane: ln, n: a.n, winPct: a.winPct, expWin: e.win, pf: a.pf, per: a.per });
  }
  return out;
}

// The Friday send: once per week, from 3:50 PM New York on (the session's journal writes catch it before the close).
export const scoreDue = (nowMs, sentWk) => etWd(nowMs) === 5 && etMins(nowMs) >= 950 && weekMonday(nowMs) !== sentWk;
// The monthly send: the finished month's summary goes out on the next month's first session write (like a statement).
export const monthDue = (nowMs, sentMo) => monthOf(nowMs) !== sentMo;
export function monthScore(closed, ym, nowMs) {
  const rows = (closed || []).map(t => ({ pl: +t.pl || 0, lane: tradeLane(t), day: etDay(Date.parse(t.outT) || nowMs || Date.now()) })).filter(t => t.day.startsWith(ym));
  const out = { ym, lanes: {}, total: agg(rows) };
  for (const ln of ['stock', 'call', 'put', 'spy', 'wheel']) out.lanes[ln] = agg(rows.filter(t => t.lane === ln));
  return out;
}

const usd = v => (v < 0 ? '−$' : '+$') + Math.abs(v).toFixed(Math.abs(v) >= 100 ? 0 : 2);
const laneLine = (ln, a) => a.n
  ? `${LANE_LAB[ln]}: ${a.n} closed, ${a.won} won (${Math.round(a.winPct)}%) · avg win ${a.avgWin == null ? '—' : usd(a.avgWin)} / loss ${a.avgLoss == null ? '—' : usd(a.avgLoss)} · ${usd(a.pl)}${ln === 'wheel' ? ' (the wheel never sells at a loss by your setting — its open red is paper until assignment)' : ''}`
  : `${LANE_LAB[ln]}: no closed trades`;
export const driftText = d => `⚠️ ${LANE_LAB[d.lane]} drift: the last ${d.n} closed trades won ${Math.round(d.winPct)}% against about ${d.expWin}% in this rule's own study, and lost more than they made (profit factor ${d.pf.toFixed(2)}). One bad week is noise — a drift this size held over ${d.n} trades is how a changed market shows itself. Settings stay judged by study, not by this message.`;
export function monthText(ms) {
  const L = [`🗓️ Monthly scorecard — ${monthLabel(ms.ym)}`];
  for (const ln of ['stock', 'call', 'put', 'spy', 'wheel']) { const a = ms.lanes[ln]; if (a.n || ln === 'stock' || ln === 'spy' || ln === 'wheel') L.push(laneLine(ln, a)); }
  const T = ms.total;
  L.push(T.n ? `The month in one line: ${usd(T.pl)} over ${T.n} closed trades, ${T.won} won (${Math.round(T.winPct)}%)${T.pf != null ? ', profit factor ' + T.pf.toFixed(2) : ''}.` : 'No closed trades that month.');
  return L.join('\n');
}
export function scoreText(sc) {
  const L = [`📊 Weekly scorecard — week of ${sc.weekOf}`];
  for (const ln of ['stock', 'call', 'put', 'spy', 'wheel']) {
    const a = sc.lanes[ln].week;
    if (a.n || ln === 'stock' || ln === 'spy' || ln === 'wheel') L.push(laneLine(ln, a));
  }
  const T = sc.total;
  L.push(`All lanes this week: ${usd(T.week.pl)} over ${T.week.n} closed · last 60 days: ${usd(T.all.pl)}, ${T.all.won} of ${T.all.n} won${T.all.pf != null ? ', profit factor ' + T.all.pf.toFixed(2) : ''}`);
  L.push(sc.drift.length ? sc.drift.map(driftText).join('\n') : '✅ Drift: every lane with 30+ recent trades is inside its tested range.');
  return L.join('\n');
}
