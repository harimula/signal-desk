// Shared trading rules — same family as the Signal Desk "Day trading" tab.
// Long-only pullback system: uptrend stock, washed-out short-term, buy the dip at S3,
// stop at S4, target at classic pivot R1. One bracket per entry.

export const sma = (a, n, i = a.length - 1) => { if (i + 1 < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; };

export function rsi2(closes, i = closes.length - 1) {
  // Connors RSI(2) ending at index i
  if (i < 3) return null;
  let g = 0, l = 0;
  for (let k = 1; k <= 2; k++) { const d = closes[i - 2 + k] - closes[i - 3 + k]; if (d >= 0) g += d; else l -= d; }
  g /= 2; l /= 2;
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

// bars: [{o,h,l,c,v}], signal computed from bar i (trade executes on bar i+1 / next session)
export function signalAt(bars, closes, i) {
  if (i < 21) return null;
  const H = bars[i].h, L = bars[i].l, C = closes[i];
  const rng = H - L;
  if (!(rng > 0) || !(C > 0)) return null;
  const s20 = sma(closes, 20, i);
  const r2 = rsi2(closes, i);
  if (s20 == null || r2 == null) return null;
  if (!(C > s20 && r2 <= 40)) return null;           // uptrend + short-term washout
  const atrPct = rng / C * 100;
  if (atrPct < 0.8 || atrPct > 9) return null;        // enough range, not gap-crazy
  const P = (H + L + C) / 3;
  const entry = C - rng * 1.1 / 4;                    // S3 (Camarilla)
  const stop = C - rng * 1.1 / 2;                     // S4
  const target = 2 * P - L;                           // R1
  if (!(target > entry && entry > stop)) return null;
  return { entry: r2d(entry), stop: r2d(stop), target: r2d(target), strong: r2 <= 15, r2: Math.round(r2) };
}

export const r2d = x => Math.round(x * 100) / 100;

// Replay one symbol's daily bars. Counts at most one round trip per day per symbol
// (daily bars cannot resolve intraday re-entries; the live bot can re-enter).
export function replay(bars, closes, startIdx = 22) {
  const trades = [];
  for (let i = startIdx; i < bars.length - 1; i++) {
    const sig = signalAt(bars, closes, i);
    if (!sig) continue;
    const nb = bars[i + 1];
    const fill = nb.o < sig.entry ? nb.o : (nb.l <= sig.entry ? sig.entry : null);
    if (fill == null) continue;
    let exit, how;
    if (fill <= sig.stop) { exit = nb.c; how = 'gap-through-stop'; }
    else if (nb.l <= sig.stop) { exit = sig.stop; how = 'stop'; }
    else if (nb.h >= sig.target) { exit = Math.max(sig.target, fill); how = 'target'; }
    else { exit = nb.c; how = 'close'; }
    trades.push({ i: i + 1, fill: r2d(fill), exit: r2d(exit), pl: (exit - fill) / fill * 100, how });
  }
  return trades;
}

// Mirror rule for PUTs: downtrend stock stretched up short-term — fade the bounce at R3.
export function signalShortAt(bars, closes, i) {
  if (i < 21) return null;
  const H = bars[i].h, L = bars[i].l, C = closes[i];
  const rng = H - L;
  if (!(rng > 0) || !(C > 0)) return null;
  const s20 = sma(closes, 20, i);
  const r2 = rsi2(closes, i);
  if (s20 == null || r2 == null) return null;
  if (!(C < s20 && r2 >= 60)) return null;
  const atrPct = rng / C * 100;
  if (atrPct < 0.8 || atrPct > 9) return null;
  const P = (H + L + C) / 3;
  const entry = C + rng * 1.1 / 4;                    // R3
  const stop = C + rng * 1.1 / 2;                     // R4
  const target = 2 * P - H;                           // S1
  if (!(target < entry && entry < stop)) return null;
  return { entry: r2d(entry), stop: r2d(stop), target: r2d(target), strong: r2 >= 85, r2: Math.round(r2) };
}

// ---- RSI-2 mean reversion (the strategy the 33-year research selected) ----
// Buy: completed close above its 200-day average AND RSI-2 below 10 (a sharp dip in an uptrend).
// Sell: at the close once price is above its 5-day average, or after 10 sessions.
export function rsi2Signal(bars, closes, i = closes.length - 1, threshold = 10) {
  if (i < 200) return null;
  const s200 = sma(closes, 200, i), r = rsi2(closes, i);
  if (s200 == null || r == null || !(closes[i] > s200 && r < threshold)) return null;
  let rg = 0; for (let k = i - 9; k <= i; k++) rg += bars[k].h - bars[k].l;
  return { r2: Math.round(r * 10) / 10, prevClose: closes[i], riskUnit: r2d(3 * rg / 10), s200: r2d(s200) };
}
// Exit check during the last minutes of the session: `price` stands in for today's close.
export function rsi2Exit(completedCloses, price, sessionsHeld, maxHold = 10) {
  const last4 = completedCloses.slice(-4);
  if (last4.length < 4) return { exit: sessionsHeld >= maxHold, why: 'max hold' };
  const s5 = (last4.reduce((a, b) => a + b, 0) + price) / 5;
  if (price > s5) return { exit: true, why: `closed above its 5-day average (${r2d(s5)})` };
  if (sessionsHeld >= maxHold) return { exit: true, why: `held ${sessionsHeld} sessions` };
  return { exit: false, s5: r2d(s5) };
}

// ---- RSI-2 mirror for PUTs (an experiment: the research chose the long side only) ----
// Put: completed close BELOW its 200-day average AND RSI-2 above 100 - threshold (a sharp pop in a downtrend).
// Exit: once price is below its 5-day average, or after maxHold sessions.
export function rsi2ShortSignal(bars, closes, i = closes.length - 1, threshold = 10) {
  if (i < 200) return null;
  const s200 = sma(closes, 200, i), r = rsi2(closes, i);
  if (s200 == null || r == null || !(closes[i] < s200 && r > 100 - threshold)) return null;
  return { r2: Math.round(r * 10) / 10, prevClose: closes[i], s200: r2d(s200) };
}
export function rsi2ShortExit(completedCloses, price, sessionsHeld, maxHold = 10) {
  const last4 = completedCloses.slice(-4);
  if (last4.length < 4) return { exit: sessionsHeld >= maxHold, why: 'max hold' };
  const s5 = (last4.reduce((a, b) => a + b, 0) + price) / 5;
  if (price < s5) return { exit: true, why: `closed below its 5-day average (${r2d(s5)})` };
  if (sessionsHeld >= maxHold) return { exit: true, why: `held ${sessionsHeld} sessions` };
  return { exit: false, s5: r2d(s5) };
}
