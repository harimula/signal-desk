// The wheel (the "Wheel" part): cash-secured puts, and covered calls on the shares a put delivers. The rules are the ones
// tools/wheel-study.mjs replayed on real option prices since February 2024 (bot/wheel_report.md); this module holds the
// pure parts, bot.mjs (wheelLane) runs them against the broker. Every number is a setting (bot/config.mjs, prefix wheel*).
//   Cycle       — monthly. In the first three trading days after a monthly expiration (the third Friday, or the trading day
//                 before it when that Friday is a holiday) the part sells a put that expires at the next monthly expiration
//                 (~33 days), at the highest strike at least wheelOtmPct % under the price: one contract per stock, fully
//                 cash-secured (strike × 100 set aside) inside the part's own share of the money, at most wheelMaxPositions
//                 stocks, stocks priced wheelMinPrice–wheelMaxPrice, the most traded first.
//   Take-profit — a resting buy-back order at (100 − wheelTp) % of the premium (default 50: bought back at half). Optional
//                 stop on a put (wheelStop × the premium, off by default: in the study it cut the yearly result to 1–6 %).
//   Expiry      — a put that ends under its strike is assigned: the shares are bought at the strike. From the next window a
//                 call is sold each month at the lowest strike at or above both the cost (strike − premium) and wheelOtmPct %
//                 above the price, until the shares are called away; then puts again.
//   Filter      — new puts only while SPY and the stock closed above their 200-day averages before each day of the window
//                 so far (wheelTrend, on by default): one close under it ends new puts until the next window, as in the study.
//   Once        — one sale per stock per cycle: a put or call bought back early is not sold again until the next window.
//   Anytime     — with wheelAnytime (off by default: the study measured the windows only), free money and uncovered shares
//                 are put to work between windows too, at the nearest monthly expiration at least 7 days out; one sale per
//                 stock per expiry still holds, so nothing is sold twice for the same month.
export const WHEEL_DEFAULTS = { wheelOn: false, wheelSharePct: 10, wheelOtmPct: 5, wheelTp: 50, wheelStop: 0, wheelTrend: true, wheelMinPrice: 15, wheelMaxPrice: 150, wheelMaxPositions: 3, wheelAnytime: false };
export const WHEEL_WINDOW_DAYS = 3;

const ymd = d => d.toISOString().slice(0, 10);
// The third Friday of a month (UTC dates, 'YYYY-MM-DD'); m is 0-based.
export function thirdFriday(y, m) { const first = new Date(Date.UTC(y, m, 1)), off = (5 - first.getUTCDay() + 7) % 7; return ymd(new Date(Date.UTC(y, m, 1 + off + 14))); }
// The monthly expiration of a month: its third Friday, or the trading day before it when that Friday is a holiday.
export function monthlyExpiry(y, m, isTradingDay) {
  let d = new Date(thirdFriday(y, m) + 'T12:00:00Z');
  for (let k = 0; k < 4 && !isTradingDay(ymd(d)); k++) d = new Date(d.getTime() - 864e5);
  return ymd(d);
}
// Where today sits in the monthly cycle. tradingDays: sorted 'YYYY-MM-DD' trading days covering ~45 days back and ~75 ahead.
// day = 1 on the first trading day after the last monthly expiration; window = day 1..WHEEL_WINDOW_DAYS.
export function wheelCycle(today, tradingDays) {
  const set = new Set(tradingDays), isT = d => set.has(d), y = +today.slice(0, 4), m = +today.slice(5, 7) - 1;
  const exps = [-2, -1, 0, 1, 2, 3].map(k => { const dt = new Date(Date.UTC(y, m + k, 1)); return monthlyExpiry(dt.getUTCFullYear(), dt.getUTCMonth(), isT); });
  const last = exps.filter(e => e < today).pop() || null, next = exps.find(e => e >= today) || null, after = exps.find(e => e > next) || null;
  const since = last ? tradingDays.filter(d => d > last && d <= today) : [];
  const day = set.has(today) ? since.length : 0, window = day >= 1 && day <= WHEEL_WINDOW_DAYS;
  const nextStarts = tradingDays.filter(d => d > (next || today)).slice(0, WHEEL_WINDOW_DAYS);   // the window after the coming expiration
  const curWin = last ? tradingDays.filter(d => d > last).slice(0, WHEEL_WINDOW_DAYS) : [];
  return { last, next, after, day, window, windowDays: window ? curWin : nextStarts, expiry: window ? next : after };   // expiry: what a sale in that window would sell
}
// Strikes: the highest at least otm % under the price (puts); the lowest at or above both the cost and otm % above (calls).
export function putStrike(strikes, px, otmPct) { const t = px * (1 - otmPct / 100), s = strikes.filter(k => k <= t + 1e-9); return s.length ? Math.max(...s) : null; }
export function callStrike(strikes, px, otmPct, cost = 0) { const t = Math.max(px * (1 + otmPct / 100), cost || 0), s = strikes.filter(k => k >= t - 1e-9); return s.length ? Math.min(...s) : null; }
// The trend filter, decided once per window as the study did: the last close before the window's first day above its
// 200-day average (days / closes: completed daily bars, oldest first). null when fewer than 200 closes come before it.
export function aboveTrendAt(days, closes, firstDay) {
  let k = -1; for (let i = (days || []).length - 1; i >= 0; i--) if (days[i] < firstDay) { k = i; break; }
  if (k < 199 || !(closes && closes.length > k)) return null;
  let s = 0; for (let i = k - 199; i <= k; i++) s += +closes[i];
  return +closes[k] > s / 200;
}
// The filter as the study applied it: the close before each day of the window so far above the 200-day average — one
// close under it ends new puts until the next window. { ok: true | false | null (not enough history), under: that day }.
export function trendThrough(days, closes, windowDays, today) {
  let ok = true;
  for (const d of (windowDays || []).filter(x => x <= today)) {
    const a = aboveTrendAt(days, closes, d);
    if (a === false) return { ok: false, under: (days || []).filter(x => x < d).pop() || null };
    if (a !== true) ok = null;
  }
  return { ok, under: null };
}
// One sale per stock per cycle, as tested: the contracts the part has sold (filled) of one kind for one expiry, by stock —
// a put or call bought back early is not sold again until the next window.
export function soldFor(hist, expiry, kind) {
  const out = new Map();
  for (const o of hist || []) {
    if (o.side !== 'sell' || !isWheelSell(o.client_order_id) || !(+o.filled_qty > 0)) continue;
    const q = parseOcc(o.symbol); if (!q || q.exp !== expiry || q.kind !== kind) continue;
    out.set(q.und, (out.get(q.und) || 0) + +o.filled_qty);
  }
  return out;
}
// Buy-back price for the take-profit: (100 − tp) % of the premium, never above it (rounding happens in bot.mjs).
export const wheelTpPrice = (premium, tpPct) => premium > 0 && tpPct > 0 ? premium * (1 - Math.min(95, tpPct) / 100) : null;
// Order ids: sd-wp-<OCC>-<yyyymmdd>-<rid> (put sold), sd-wc-… (call sold), sd-wb-<OCC>-<rid> (bought back).
export const wheelId = (kind, occ, day8, rid) => kind === 'buy' ? `sd-wb-${occ}-${rid}` : `sd-w${kind === 'put' ? 'p' : 'c'}-${occ}-${day8}-${rid}`;
export const isWheelSell = cid => /^sd-w[pc]-/.test(cid || ''), isWheelBuy = cid => /^sd-wb-/.test(cid || ''), isWheelId = cid => /^sd-w[pcb]-/.test(cid || '');
const OCC = /^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
export function parseOcc(sym) { const m = OCC.exec(sym || ''); return m ? { und: m[1], exp: `20${m[2]}-${m[3]}-${m[4]}`, kind: m[5] === 'P' ? 'put' : 'call', K: +m[6] / 1000 } : null; }

// What happened since the last check, from the broker's picture (so a lost memory rebuilds itself):
//   mem       — { opts: { OCC: { und, kind, K, exp, qty, prem, since, seen, base } }, shares: { UND: { qty, cost, since } },
//                 done: { OCC: day it ended } } from before
//   positions — the broker's positions; hist — recent orders (client_order_id, side, status, filled_qty, filled_at, …)
//   today     — 'YYYY-MM-DD' (New York); now — ISO time of this check
// A sold option the part placed (the latest sale of that contract in hist is an sd-wp / sd-wc sale) and still holds is
// remembered with its premium and the shares of its stock held outside the part at that moment (base, seen). One that is
// gone was bought back (a filled buy after the sale), assigned (a put: the stock's shares rose by 100 per contract, not
// counting shares that orders bought or sold since — an assignment has no order; a call: they fell by as much) or expired
// worthless (its expiry has come and nothing else explains it). Only when the memory is lost (nothing remembered at all)
// are shares adopted: those a put delivered (a sold put on that stock in hist, gone now, not bought back, shares at its
// strike ± 1 %, no buy order of the stock after the sale), and the 100 shares under each of its covered calls still open.
// The part's shares are capped by what the account holds. Options that ended are remembered 60 days (done), so they are
// never adopted again. Returns { mem, events } — one event per change.
export function wheelReconcile({ mem, positions, hist, today, now = today + 'T12:00:00Z' }) {
  const prev = mem || { opts: {}, shares: {} }, out = { opts: {}, shares: JSON.parse(JSON.stringify(prev.shares || {})), done: {} }, events = [];
  const keep = new Date(Date.parse(today + 'T12:00:00Z') - 60 * 864e5).toISOString().slice(0, 10);
  for (const [k, d] of Object.entries(prev.done || {})) if (d >= keep) out.done[k] = d;
  const lost = !Object.keys(prev.opts || {}).length && !Object.keys(prev.shares || {}).length && !Object.keys(prev.done || {}).length;
  const pos = new Map((positions || []).map(p => [p.symbol, p]));
  const stockQty = und => Math.max(0, +((pos.get(und) || {}).qty) || 0);
  const tF = o => o.filled_at || o.updated_at || o.submitted_at || '';
  const latest = list => list.sort((a, b) => tF(a) < tF(b) ? 1 : -1)[0] || null;
  const sales = (hist || []).filter(o => o.side === 'sell' && isWheelSell(o.client_order_id) && +o.filled_qty > 0);
  const sale = sym => latest(sales.filter(o => o.symbol === sym));
  const lastSell = sym => latest((hist || []).filter(o => o.symbol === sym && o.side === 'sell' && +o.filled_qty > 0));
  const lastBuy = sym => (hist || []).filter(o => o.symbol === sym && o.side === 'buy' && +o.filled_qty > 0).map(tF).sort().pop() || '';
  const netOrders = (und, after) => (hist || []).reduce((t, o) => o.symbol === und && +o.filled_qty > 0 && tF(o) > after ? t + (o.side === 'buy' ? 1 : -1) * +o.filled_qty : t, 0);
  const end = (sym, ev) => { out.done[sym] = today; events.push(ev); };
  // 1) sold options still held: the part's when it remembers them, or when the latest sale of that contract was its own
  //    (never one sold by hand, also not one sold by hand after the part bought it back)
  const held = [];
  for (const p of positions || []) {
    const q = +p.qty || 0, o = parseOcc(p.symbol); if (!(q < 0) || !o) continue;
    const was = (prev.opts || {})[p.symbol], s = was ? null : sale(p.symbol);
    if (!was && (!s || lastSell(p.symbol) !== s)) continue;
    held.push({ p, o, was, s });
  }
  // 2) a lost memory (nothing remembered at all): the shares are rebuilt from the broker's picture before anything is measured
  //    against them — shares a put delivered (a sold put on that stock in hist, gone now, not bought back, shares at its strike
  //    ± 1 %, no buy order of the stock after the sale), then the 100 shares under each covered call still open
  if (lost) {
    for (const p of positions || []) {
      const q = +p.qty || 0; if (parseOcc(p.symbol) || !(q >= 100) || out.shares[p.symbol]) continue;
      const put = latest(sales.filter(o => { const c = parseOcc(o.symbol) || {}; return c.und === p.symbol && c.kind === 'put' && !pos.has(o.symbol) && !out.done[o.symbol] && lastBuy(o.symbol) <= tF(o); }));
      if (!put) continue;
      const K = parseOcc(put.symbol).K, avg = +p.avg_entry_price;
      const boughtSince = (hist || []).some(o => o.symbol === p.symbol && o.side === 'buy' && +o.filled_qty > 0 && tF(o) > tF(put));
      if (boughtSince || !(avg > 0) || Math.abs(avg - K) > K * 0.01) continue;   // bought by an order (another part, or by hand), or not at the strike: not the part's
      const n = Math.floor(q / 100) * 100;
      out.shares[p.symbol] = { qty: n, cost: Math.round((K - (+put.filled_avg_price || 0)) * 100) / 100, since: today }; out.done[put.symbol] = today;
      events.push({ type: 'assigned', sym: put.symbol, und: p.symbol, kind: 'put', K, qty: n / 100, prem: +put.filled_avg_price || 0, shares: n, adopted: true });
    }
    for (const { o, p } of held) if (o.kind === 'call' && !out.shares[o.und]) {
      const n = Math.min(100 * -(+p.qty), Math.floor(stockQty(o.und) / 100) * 100), sp = pos.get(o.und);
      if (n >= 100 && sp) out.shares[o.und] = { qty: n, cost: Math.round(+sp.avg_entry_price * 100) / 100, since: today };   // cost unknown: the account's average price
    }
  }
  for (const { p, o, was, s } of held) {
    out.opts[p.symbol] = { und: o.und, kind: o.kind, K: o.K, exp: o.exp, qty: -(+p.qty), prem: +p.avg_entry_price || (was && was.prem) || +(s && s.filled_avg_price) || 0,
      since: (was && was.since) || (s && s.filled_at ? s.filled_at.slice(0, 10) : today), seen: (was && was.seen) || (was && sale(p.symbol) ? tF(sale(p.symbol)) : now),
      base: was && was.base != null ? was.base : Math.max(0, stockQty(o.und) - ((out.shares[o.und] || {}).qty || 0)) };
  }
  // 3) sold options that are gone
  for (const [sym, x] of Object.entries(prev.opts || {})) {
    if (out.opts[sym]) continue;
    const bought = (hist || []).some(o => o.symbol === sym && o.side === 'buy' && +o.filled_qty > 0 && tF(o).slice(0, 10) >= (x.since || '0000'));
    const seen = x.seen || (sale(sym) ? tF(sale(sym)) : x.since + 'T00:00:00Z');
    const mine = stockQty(x.und) - (x.base || 0) - netOrders(x.und, seen), had = (prev.shares[x.und] || {}).qty || 0, n = 100 * x.qty;
    if (bought) { end(sym, { type: 'bought back', sym, ...x }); continue; }
    if (x.kind === 'put' && mine >= had + n - 1e-9) {                       // assigned: the shares came in at the strike
      const cost = (had * ((prev.shares[x.und] || {}).cost || 0) + n * (x.K - x.prem)) / (had + n);
      out.shares[x.und] = { qty: had + n, cost: Math.round(cost * 100) / 100, since: today }; end(sym, { type: 'assigned', sym, ...x, shares: had + n }); continue;
    }
    if (x.kind === 'call' && had >= n && mine <= had - n + 1e-9) {          // called away: the shares went at the strike
      const left = had - n; if (left > 0) out.shares[x.und] = { ...out.shares[x.und], qty: left }; else delete out.shares[x.und];
      end(sym, { type: 'called away', sym, ...x }); continue;
    }
    if (today >= x.exp) { end(sym, { type: 'expired', sym, ...x }); continue; }
    out.opts[sym] = { ...x, missing: (x.missing || 0) + 1 };                // gone before its day without a trade: kept a while (a broker hiccup)
    if (out.opts[sym].missing > 30) { delete out.opts[sym]; end(sym, { type: 'gone', sym, ...x }); }
  }
  // 4) the part's shares: never more than the account holds (sold by hand)
  for (const [und, s] of Object.entries(out.shares)) { const have = stockQty(und); if (have < s.qty) { if (have <= 0) delete out.shares[und]; else out.shares[und] = { ...s, qty: have }; } }
  return { mem: out, events };
}
