// Builds the trade journal (round trips + open positions) from Alpaca fills.
const OPT_RE = /^([A-Z.]+)(\d{6})([CP])(\d{8})$/;
export function parseSym(sym) {
  const m = OPT_RE.exec(sym);
  if (!m) return { und: sym, kind: 'Stock', mult: 1 };
  return { und: m[1], kind: m[3] === 'C' ? 'Call' : 'Put', exp: '20' + m[2].slice(0, 2) + '-' + m[2].slice(2, 4) + '-' + m[2].slice(4, 6), strike: +m[4] / 1000, mult: 100 };
}
const r2 = x => Math.round(x * 100) / 100;

export function buildJournal(fills, positions) {
  // 1) merge partial fills per order
  const byOrder = new Map();
  for (const f of fills) {
    const k = f.order_id || f.id;
    const q = Math.abs(+f.qty), px = +f.price;
    const o = byOrder.get(k) || { sym: f.symbol, side: f.side, qty: 0, cost: 0, t: f.transaction_time };
    o.qty += q; o.cost += q * px; if (f.transaction_time > o.t) o.t = f.transaction_time;
    byOrder.set(k, o);
  }
  const orders = [...byOrder.values()].map(o => ({ ...o, px: o.cost / o.qty })).sort((a, b) => a.t < b.t ? -1 : 1);
  // 2) FIFO pairing per symbol
  const lots = {}, closed = [];
  for (const o of orders) {
    const L = lots[o.sym] = lots[o.sym] || [];
    if (o.side === 'buy') { L.push({ qty: o.qty, px: o.px, t: o.t }); continue; }
    let left = o.qty;
    const info = parseSym(o.sym);
    while (left > 1e-9 && L.length) {
      const lot = L[0], q = Math.min(lot.qty, left);
      const pl = (o.px - lot.px) * q * info.mult;
      closed.push({ sym: o.sym, ...info, qty: r2(q), inPx: r2(lot.px), inT: lot.t, outPx: r2(o.px), outT: o.t, pl: r2(pl), plPct: r2((o.px - lot.px) / lot.px * 100) });
      lot.qty -= q; left -= q;
      if (lot.qty <= 1e-9) L.shift();
    }
  }
  // 3) open positions, with when they were bought
  const open = (positions || []).map(p => {
    const info = parseSym(p.symbol), L = lots[p.symbol] || [];
    return { sym: p.symbol, ...info, qty: +p.qty, avg: r2(+p.avg_entry_price), now: r2(+p.current_price), pl: r2(+p.unrealized_pl), plPct: r2(+p.unrealized_plpc * 100), since: L.length ? L[0].t : null };
  });
  closed.sort((a, b) => a.outT < b.outT ? 1 : -1);
  return { closed, open };
}
