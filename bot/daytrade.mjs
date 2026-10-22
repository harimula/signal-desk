// Day-trading engine (experimental, OFF by default) — the rules are spelled out in docs/daytrading-rules.html.
// Pure functions over 5-minute bars: indicators, the two setups, sizing and exit decisions. bot.mjs does the broker calls.
//
// Bars: [{ t (ISO), o, h, l, c, v, m (minutes past midnight ET of the bar's start) }] for today's session, oldest first,
// completed bars only. SESSION_OPEN = 9:30 ET = 570 minutes.
export const SESSION_OPEN = 570, SESSION_CLOSE = 960;
const r2d = x => Math.round(x * 100) / 100;

// Session VWAP: cumulative (typical price × volume) / cumulative volume.
export function vwap(bars) {
  let pv = 0, vv = 0;
  for (const b of bars) { const tp = (b.h + b.l + b.c) / 3; pv += tp * (b.v || 0); vv += b.v || 0; }
  return vv > 0 ? pv / vv : (bars.length ? bars[bars.length - 1].c : null);
}
// VWAP as it stood at the close of each bar (what a trader watching the chart saw at the time).
export function runningVwap(bars) {
  const out = []; let pv = 0, vv = 0;
  for (const b of bars) { pv += (b.h + b.l + b.c) / 3 * (b.v || 0); vv += b.v || 0; out.push(vv > 0 ? pv / vv : b.c); }
  return out;
}
// Average true range over the last n bars (plain average: enough bars rarely exist for Wilder smoothing intraday).
export function atr(bars, n = 14) {
  if (bars.length < 2) return null;
  const w = bars.slice(-(n + 1)), tr = [];
  for (let i = 1; i < w.length; i++) tr.push(Math.max(w[i].h - w[i].l, Math.abs(w[i].h - w[i - 1].c), Math.abs(w[i].l - w[i - 1].c)));
  return tr.length ? tr.reduce((a, b) => a + b, 0) / tr.length : null;
}
// Opening range: high/low of the first `minutes` of the session (needs the bars that cover it to be complete).
export function openingRange(bars, minutes = 15) {
  const inRange = bars.filter(b => b.m >= SESSION_OPEN && b.m < SESSION_OPEN + minutes);
  if (!inRange.length) return null;
  const covered = Math.max(...inRange.map(b => b.m)) + 5 >= SESSION_OPEN + minutes;          // last 5-min bar of the range is in
  if (!covered) return null;
  return { high: Math.max(...inRange.map(b => b.h)), low: Math.min(...inRange.map(b => b.l)) };
}
// Relative volume: today's volume so far vs what an average day would have done by this time of the session.
export function relVolume(bars, avgDailyVol, mins) {
  if (!(avgDailyVol > 0)) return null;
  const elapsed = Math.max(5, Math.min(SESSION_CLOSE, mins) - SESSION_OPEN);
  const today = bars.reduce((t, b) => t + (b.v || 0), 0);
  // volume is front-loaded: the first hour carries roughly a quarter of the day — use a simple U-shape weight
  const frac = Math.min(1, 0.25 * Math.min(1, elapsed / 60) + 0.75 * Math.max(0, elapsed - 60) / 330);
  return frac > 0 ? today / (avgDailyVol * frac) : null;
}

// ---- the two setups ----
// Returns null or { side: 'long'|'short', setup: 'ORB'|'VWAP', entry, stop, target, r, why }.
// `market`: 'up' (SPY above its VWAP → longs only), 'down' (shorts only), 'flat' (neither).
export function daySetup({ bars, px, mins, avgDailyVol, market, cfg }) {
  const C = { orMin: 15, rvol: 1.2, target: 2, minRiskPct: 0.2, maxRiskPct: 2.5, start: 585, end: 930, ...cfg };
  if (!(px > 0) || bars.length < 4) return null;
  if (mins < C.start || mins >= C.end) return null;
  const a = atr(bars, 14); if (!(a > 0)) return null;
  const vw = vwap(bars); if (!(vw > 0)) return null;
  const rv = relVolume(bars, avgDailyVol, mins);
  if (rv != null && rv < C.rvol) return null;                                   // quiet stock today: no setup
  const last = bars[bars.length - 1], prev = bars[bars.length - 2];
  const or = openingRange(bars, C.orMin);
  const finish = (side, setup, entry, stop, why) => {
    const risk = Math.abs(entry - stop), riskPct = risk / entry * 100;
    if (!(risk > 0) || riskPct < C.minRiskPct || riskPct > C.maxRiskPct) return null;
    const target = side === 'long' ? entry + C.target * risk : entry - C.target * risk;
    return { side, setup, entry: r2d(entry), stop: r2d(stop), target: r2d(target), r: r2d(risk), rvol: rv == null ? null : Math.round(rv * 10) / 10, vwap: r2d(vw), why };
  };
  // 1) Opening-range breakout, with the market and VWAP on the same side; fresh = this bar crossed, the one before had not
  if (or && market === 'up' && last.c > or.high && prev.c <= or.high && last.c > vw && px > or.high)
    return finish('long', 'ORB', px, Math.max(or.low - 0.1 * a, px - 1.5 * a), `broke above the opening range ${r2d(or.high)} on volume, above VWAP ${r2d(vw)}`);
  if (or && market === 'down' && last.c < or.low && prev.c >= or.low && last.c < vw && px < or.low)
    return finish('short', 'ORB', px, Math.min(or.high + 0.1 * a, px + 1.5 * a), `broke below the opening range ${r2d(or.low)} on volume, below VWAP ${r2d(vw)}`);
  // 2) VWAP pullback: trend day (most closes on one side of VWAP), a touch of VWAP, then a close back on the trend side
  const rv2 = runningVwap(bars), n = bars.length, above = bars.filter((b, i) => b.c > rv2[i]).length / n;   // trend day = closes stayed on one side of the VWAP of the moment
  if (market === 'up' && above >= 0.7 && prev.l <= vw * 1.0015 && last.c > vw && last.c > prev.h && px > vw)
    return finish('long', 'VWAP', px, Math.min(prev.l, vw) - 0.25 * a, `pulled back to VWAP ${r2d(vw)} and turned up again`);
  if (market === 'down' && above <= 0.3 && prev.h >= vw * 0.9985 && last.c < vw && last.c < prev.l && px < vw)
    return finish('short', 'VWAP', px, Math.max(prev.h, vw) + 0.25 * a, `bounced to VWAP ${r2d(vw)} and turned down again`);
  return null;
}

// Market filter from SPY's own 5-minute bars.
export function marketMode(spyBars, spyPx) {
  if (!spyBars || spyBars.length < 3 || !(spyPx > 0)) return 'flat';
  const vw = vwap(spyBars); if (!(vw > 0)) return 'flat';
  const d = spyPx / vw - 1;
  return d > 0.0005 ? 'up' : d < -0.0005 ? 'down' : 'flat';
}

// Shares so that the stop loses at most riskPct% of equity, never more than the money budget.
export function dayShares({ equity, riskPct, entry, stop, budget }) {
  const perShare = Math.abs(entry - stop);
  if (!(perShare > 0) || !(entry > 0)) return 0;
  return Math.max(0, Math.min(Math.floor(budget / entry), Math.floor(equity * riskPct / 100 / perShare)));
}

// Exit decision for an open day trade. `pos`: { side, entry, stop, target, openedMins, beAt }; returns null or { why, kind }.
export function dayExit({ pos, px, mins, cfg }) {
  const C = { flat: 950, timeStop: 60, timeStopR: 0.3, ...cfg };
  if (!(px > 0)) return null;
  const long = pos.side === 'long', r = Math.abs(pos.entry - pos.stop) || 1e-9;
  const gainR = (long ? px - pos.entry : pos.entry - px) / r;
  if (mins >= C.flat) return { why: 'flat before the close', kind: 'flat' };
  if (long ? px <= pos.stop : px >= pos.stop) return { why: `stop ${pos.stop}`, kind: 'stop' };
  if (long ? px >= pos.target : px <= pos.target) return { why: `target ${pos.target}`, kind: 'target' };
  if (pos.openedMins != null && mins - pos.openedMins >= C.timeStop && gainR < C.timeStopR) return { why: `no follow-through after ${C.timeStop} min`, kind: 'time' };
  return null;
}
// Breakeven rule: once the trade is 1R in profit, the stop moves to the entry price.
export function dayTrail({ pos, px }) {
  const long = pos.side === 'long', r = Math.abs(pos.entry - pos.stop);
  const gainR = (long ? px - pos.entry : pos.entry - px) / (r || 1e-9);
  if (gainR >= 1 && (long ? pos.stop < pos.entry : pos.stop > pos.entry)) return { stop: pos.entry, why: 'up 1R — stop moved to breakeven' };
  return null;
}

// Client-order-id codec: everything the bot needs to manage the trade after a restart lives in the id.
//   sd-d-<SYM>-<entry¢>-<stop¢>-<target¢>-<yyyymmdd>-<openMins>-<rid>        stock day trade
//   sd-dc-/sd-dp-<OCC>-<entry¢>-<stop¢>-<target¢>-<yyyymmdd>-<openMins>-<rid>  CALL / PUT day trade (levels are on the underlying)
export function encodeDayId(prefix, sym, entry, stop, target, day8, openMins, rid) {
  return `${prefix}${sym}-${Math.round(entry * 100)}-${Math.round(stop * 100)}-${Math.round(target * 100)}-${day8}-${openMins}-${rid}`;
}
export function decodeDayId(id) {
  const m = /^sd-(d|dc|dp)-([A-Z.0-9]+)-(\d+)-(\d+)-(\d+)-(\d{8})-(\d+)-/.exec(id || '');
  if (!m) return null;
  return { kind: m[1], sym: m[2], entry: +m[3] / 100, stop: +m[4] / 100, target: +m[5] / 100, day8: m[6], openMins: +m[7], side: m[1] === 'dp' ? 'short' : 'long' };
}
