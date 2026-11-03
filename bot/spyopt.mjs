// SPY quick options ("SPY sleeve"): CALLs and PUTs on SPY alone, held minutes, each trade sized from its own share of the
// stake (default 5%). The rules are the bot's own — simple, inspectable, and NOT backtested: minute-level options history
// is a paid dataset the project does not have. Every number is a setting (bot/config.mjs, prefix spy*).
//
//   Direction  — SPY at least spyVwapGap % above its day's VWAP → CALLs only; below by the gap → PUTs only; between → nothing.
//   Trigger    — the live price breaks the high of the last 3 completed 5-minute bars (CALL) or their low (PUT), and the last
//                completed bar closed in that direction on at least average volume for the day so far ("armed"). With
//                spyBeyondPrev the break must also clear yesterday's high (CALL) or low (PUT) — the 2026-11-03 study. The
//                same test runs on every streamed tick (bot.mjs spyEnter), on bars read after the last 5-minute mark.
//   Contract   — nearest-the-money, expiring spyDte trading days out (default 1 = the next trading day; 0 = the same day,
//                allowed since 2026-10-30: fastest time decay, and the broker takes no orders on it after 3:30 PM ET, so
//                the bot neither buys after 3:20 nor holds past 3:20 — bot.mjs enforces both), spread ≤ 5%.
//   Exits      — take-profit +spyTp% (resting limit order at the broker), stop −spyStop%, time stop after spyHoldMin minutes,
//                flat by spyFlat (3:45 PM). Whichever comes first.
//   Size       — one trade uses spyTradePct % of the sleeve's money (default 100 = all of it), never more than is free.
//   At once    — up to spyMaxOpen trades (default 3), each from its own fresh break: a second CALL needs a new, higher
//                15-minute high than the last CALL's; a PUT may open beside a CALL when SPY turns. Never added to a losing trade.
//   Brakes     — spyMaxTrades a day, spyStreak losses in a row ends the day, spyDayCap % of the
//                sleeve lost today ends the day (bot.mjs applies it like the other money-split parts).
import { vwap } from './daytrade.mjs';

export const SPY_DEFAULTS = { spyOn: true, spySharePct: 5, spyTradePct: 100, spyTp: 15, spyStop: 15, spyHoldMin: 10, spyMaxTrades: 6, spyMaxOpen: 3, spyStreak: 2, spyDayCap: 25, spyDte: 1, spyFastFill: false, spyVwapGap: 0.05, spyBeyondPrev: false, spyStart: '09:50', spyEnd: '15:30', spyFlat: 945 };

// Entry signal from completed 5-minute SPY bars (each {o,h,l,c,v,m}) and the live price. mins = minutes past midnight ET.
// prev = yesterday's { hi, lo } (its daily bar) — needed only while spyBeyondPrev is on.
export function spySignal({ bars, px, mins, cfg = {}, prev = null }) {
  const C = { ...SPY_DEFAULTS, ...cfg }, start = hhmm(C.spyStart), end = hhmm(C.spyEnd);
  if (!(px > 0) || !bars || bars.length < 4) return null;
  if (mins < start) return { idle: 'before the window' };
  if (mins >= end) return { idle: 'window closed for today' };
  const done = bars.filter(b => b.m + 5 <= mins);                              // completed bars only
  if (done.length < 4) return { idle: 'waiting for the first bars' };
  const vw = vwap(done); if (!(vw > 0)) return null;
  const gap = Math.max(0.0001, (C.spyVwapGap ?? 0.05) / 100);                  // the least distance from the VWAP (the 2026-11-03 study measured 0.15% beating the old 0.05%)
  const d = px / vw - 1, market = d > gap ? 'up' : d < -gap ? 'down' : 'flat';
  if (market === 'flat') return { idle: `SPY within ${(gap * 100).toFixed(2).replace(/0$/, '').replace(/\.$/, '')}% of its VWAP — no clear direction`, market, vwap: r2(vw) };
  const last3 = done.slice(-3), lastBar = done[done.length - 1];
  const hi = Math.max(...last3.map(b => b.h)), lo = Math.min(...last3.map(b => b.l));
  const avgV = done.reduce((t, b) => t + (b.v || 0), 0) / done.length, busy = (lastBar.v || 0) >= avgV;
  // armed: the last completed bar closed in the market's direction on at least average volume — a break of the level now
  // would be a signal. The live tick path (bot.mjs spyWatch / spyEnter) only listens while armed, like this check.
  const armed = (market === 'up' ? lastBar.c > lastBar.o : lastBar.c < lastBar.o) && busy;
  // beyond yesterday's range (2026-11-03 study): the break must also clear yesterday's high (CALLs) or low (PUTs) \u2014
  // a push into new ground, not a wiggle inside yesterday's range. Until yesterday's bar is loaded, the sleeve waits.
  if (C.spyBeyondPrev && !(prev && prev.hi > 0 && prev.lo > 0)) return { idle: 'yesterday\u2019s high and low are not loaded yet \u2014 no trade until they are (\u201cOnly beyond yesterday\u2019s range\u201d is on)', market, vwap: r2(vw) };
  const beyond = side => !C.spyBeyondPrev || (side === 'call' ? px > prev.hi : px < prev.lo);
  if (market === 'up' && px > hi && armed && beyond('call')) return { side: 'call', market, vwap: r2(vw), level: r2(hi), armed, why: `SPY ${px} broke above the 15-minute high ${r2(hi)} with SPY ${(d * 100).toFixed(2)}% above its VWAP ${r2(vw)}${C.spyBeyondPrev ? ` and above yesterday's high ${r2(prev.hi)}` : ''}` };
  if (market === 'down' && px < lo && armed && beyond('put')) return { side: 'put', market, vwap: r2(vw), level: r2(lo), armed, why: `SPY ${px} broke below the 15-minute low ${r2(lo)} with SPY ${(-d * 100).toFixed(2)}% below its VWAP ${r2(vw)}${C.spyBeyondPrev ? ` and below yesterday's low ${r2(prev.lo)}` : ''}` };
  const up = market === 'up', dir = up ? 'above' : 'below';
  const lvl = up ? r2(C.spyBeyondPrev ? Math.max(hi, prev.hi) : hi) : r2(C.spyBeyondPrev ? Math.min(lo, prev.lo) : lo);
  const past = C.spyBeyondPrev && (up ? prev.hi > hi : prev.lo < lo) ? ` (that is past yesterday's ${up ? 'high' : 'low'})` : '';
  return { idle: armed ? `SPY ${dir} VWAP ${r2(vw)} \u2014 waiting for a break ${dir} ${lvl}${past}` : `SPY ${dir} VWAP ${r2(vw)} \u2014 waiting for a 5-minute bar to close ${market} on busy volume, then a break ${dir} ${lvl}${past}`, market, vwap: r2(vw), level: up ? r2(hi) : r2(lo), armed };
}

// Exit decision on an open SPY option. optPx = the option's own price now, entryPx = its fill price.
// A fresh break: the first trade of the day in a direction, or a level beyond the one the previous trade in that
// direction was taken at (higher for CALLs, lower for PUTs). Stops the same break from opening several trades.
export const spyFresh = (side, level, last) => !(last > 0) || (side === 'call' ? level > last : level < last);

export function spyExit({ entryPx, optPx, openedMins, mins, cfg = {} }) {
  const C = { ...SPY_DEFAULTS, ...cfg };
  if (!(optPx > 0) || !(entryPx > 0)) return null;
  const pl = Math.round((optPx / entryPx - 1) * 10000) / 100;                 // rounded, so +15.00% is a take-profit and not 14.999%
  if (mins >= C.spyFlat) return { kind: 'flat', why: 'flat before the close', pl };
  if (pl >= C.spyTp) return { kind: 'tp', why: `+${pl.toFixed(0)}% — take profit (target +${C.spyTp}%)`, pl };
  if (pl <= -C.spyStop) return { kind: 'stop', why: `${pl.toFixed(0)}% — stop (limit −${C.spyStop}%)`, pl };
  if (openedMins != null && mins - openedMins >= C.spyHoldMin) return { kind: 'time', why: `${C.spyHoldMin} minutes are up (${pl >= 0 ? '+' : ''}${pl.toFixed(0)}%)`, pl };
  return null;
}

// Order id: sd-yc-/sd-yp-<OCC>-<entry¢>-<yyyymmdd>-<openMins>-<rid>
export function encodeSpyId(kind, sym, entry, day8, openMins, rid) { return `sd-y${kind === 'put' ? 'p' : 'c'}-${sym}-${Math.round(entry * 100)}-${day8}-${openMins}-${rid}`; }
export function decodeSpyId(id) {
  const m = /^sd-y([cp])-([A-Z.0-9]+)-(\d+)-(\d{8})-(\d+)-/.exec(id || '');
  return m ? { kind: m[1] === 'p' ? 'put' : 'call', sym: m[2], entry: +m[3] / 100, day8: m[4], openMins: +m[5] } : null;
}
export const isSpyOption = sym => /^SPY\d{6}[CP]\d{8}$/.test(sym || '');
const hhmm = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m; };
const r2 = x => Math.round(x * 100) / 100;
