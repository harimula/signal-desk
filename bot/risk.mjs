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
