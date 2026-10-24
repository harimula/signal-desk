// Risk engine — pure functions (unit-tested in bot/test.mjs).

// Sector map for the default universe; anything else counts as "Other".
export const SECTOR = {
  AAPL: 'Tech', MSFT: 'Tech', NVDA: 'Tech', AMD: 'Tech', INTC: 'Tech', CSCO: 'Tech', QCOM: 'Tech', ORCL: 'Tech', CRM: 'Tech', ADBE: 'Tech', PLTR: 'Tech', SHOP: 'Tech',
  META: 'Comms', GOOGL: 'Comms', NFLX: 'Comms', DIS: 'Comms',
  AMZN: 'Consumer', TSLA: 'Consumer', HD: 'Consumer', UBER: 'Consumer', F: 'Consumer',
  JPM: 'Financials', BAC: 'Financials', COIN: 'Financials', SOFI: 'Financials',
  XOM: 'Energy', CVX: 'Energy', KO: 'Staples', PEP: 'Staples', WMT: 'Staples',
};
export const sectorOf = sym => SECTOR[sym] || 'Other';

// Shares so that hitting the stop loses at most riskPct% of equity — and never more than the $ budget.
export function stockQty({ equity, riskPct, entry, stop, budget }) {
  const perShare = entry - stop;
  if (!(perShare > 0) || !(entry > 0)) return 0;
  return Math.max(0, Math.min(Math.floor(budget / entry), Math.floor(equity * riskPct / 100 / perShare)));
}

// Contracts so that the -50% option stop loses at most riskPct% of equity — and never more than the budget.
export function optionQty({ equity, riskPct, price, budget }) {
  if (!(price > 0)) return 0;
  const perContract = price * 100;
  return Math.max(0, Math.min(Math.floor(budget / perContract), Math.floor(equity * riskPct / 100 / (perContract * 0.5))));
}

// Market regime from SPY daily closes (oldest -> newest, completed sessions only).
export function regimeOf(closes) {
  if (!closes || closes.length < 60) return { regime: 'unknown' };
  const avg = (n) => closes.slice(-n).reduce((a, b) => a + b, 0) / n;
  const last = closes[closes.length - 1], s50 = avg(50), s200 = closes.length >= 200 ? avg(200) : null;
  let regime = 'neutral';
  if (last > s50 && (s200 == null || s50 >= s200)) regime = 'bull';
  else if (last < s50 && s200 != null && s50 < s200) regime = 'bear';
  return { regime, last, s50, s200 };
}

// Losing trades in a row, counted back from the most recent closed trade.
export function lossStreak(closed) {
  const arr = [...closed].sort((a, b) => (a.outT < b.outT ? -1 : 1));
  let n = 0;
  for (let i = arr.length - 1; i >= 0; i--) { if (arr[i].pl < 0) n++; else break; }
  return n;
}

// Money at risk right now: distance to each stop (stocks) and the -50% stop (options), plus pending entries.
export function openRisk({ positions, orders, stopFor }) {
  let r = 0;
  for (const p of positions) {
    const q = Math.abs(+p.qty), avg = +p.avg_entry_price;
    if (/\d{6}[CP]\d{8}$/.test(p.symbol)) r += q * 100 * avg * 0.5;
    else { const st = stopFor(p.symbol); r += q * (st ? Math.max(0, avg - st) : avg * 0.05); }
  }
  for (const o of orders) {
    if (o.side !== 'buy' || !o.limit_price) continue;
    const q = +o.qty, lim = +o.limit_price;
    if (/\d{6}[CP]\d{8}$/.test(o.symbol)) r += q * 100 * lim * 0.5;
    else { const st = stopFor(o.symbol, o); r += q * (st ? Math.max(0, lim - st) : lim * 0.05); }
  }
  return r;
}

// Today's profit or loss for each part of the money split (stocks / CALLs / PUTs; `opt` = CALLs + PUTs), from the positions held now and today's fills:
// value now − value at yesterday's close + money from today's sells − money spent on today's buys, symbol by symbol.
// It counts swing positions bought before today as well as same-day round trips. `lastDay` holds yesterday's closing price for
// symbols that were sold out today (the bot remembers it from earlier checks); a missing one counts those shares at their sale price.
const OPT_SYM = /^[A-Z.]+\d{6}[CP]\d{8}$/, OPT_KIND = /^[A-Z.]+\d{6}([CP])\d{8}$/;
export function sideDayPl({ positions = [], fills = [], lastDay = {}, spy = null } = {}) {
  const per = {}, get = s => per[s] || (per[s] = { now: 0, qty: 0, last: null, buyQ: 0, sellQ: 0, cash: 0, sellAmt: 0, px: null });
  for (const p of positions) {
    const x = get(p.symbol), m = OPT_SYM.test(p.symbol) ? 100 : 1;
    x.qty = +p.qty || 0; x.now = x.qty * (+p.current_price || 0) * m; x.last = +p.lastday_price > 0 ? +p.lastday_price : null; x.px = +p.current_price || null;
  }
  for (const f of fills) {
    if (!f || !f.symbol) continue;
    const x = get(f.symbol), m = OPT_SYM.test(f.symbol) ? 100 : 1, q = Math.abs(+f.qty || 0), px = +f.price || 0;
    if (/^buy/.test(f.side)) { x.buyQ += q; x.cash -= q * px * m; } else { x.sellQ += q; x.cash += q * px * m; x.sellAmt += q * px; }
  }
  const out = { stock: 0, call: 0, put: 0, spy: 0 };
  for (const [sym, x] of Object.entries(per)) {
    const m = OPT_SYM.test(sym) ? 100 : 1, prevQ = Math.max(0, x.qty - x.buyQ + x.sellQ);
    let lp = x.last || (+lastDay[sym] > 0 ? +lastDay[sym] : null);
    if (prevQ > 1e-9 && !lp) lp = x.sellQ > 0 ? x.sellAmt / x.sellQ : x.px || 0;
    const kd = OPT_KIND.exec(sym); out[!kd ? 'stock' : spy && spy(sym) ? 'spy' : kd[1] === 'P' ? 'put' : 'call'] += x.now - prevQ * (lp || 0) * m + x.cash;
  }
  for (const k of ['stock', 'call', 'put', 'spy']) out[k] = Math.round(out[k] * 100) / 100;
  out.opt = Math.round((out.call + out.put) * 100) / 100;
  return out;
}
