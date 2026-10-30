// Builds the trade journal (round trips + open positions) from Alpaca fills, plus the option events that have no fill:
// an option that expires, is assigned or is exercised (Alpaca's non-trade activities OPEXP / OPASN / OPEXC, and OPTRD for
// the shares that change hands at the strike). Options are bought to open (CALLs, PUTs, SPY) or, by the wheel, sold to
// open: a sale with nothing held opens a sold ("short") lot, and the buy-back — or the expiry / assignment, at 0 — closes it.
const OPT_RE = /^([A-Z.]+)(\d{6})([CP])(\d{8})$/;
export function parseSym(sym) {
  const m = OPT_RE.exec(sym);
  if (!m) return { und: sym, kind: 'Stock', mult: 1 };
  return { und: m[1], kind: m[3] === 'C' ? 'Call' : 'Put', exp: '20' + m[2].slice(0, 2) + '-' + m[2].slice(2, 4) + '-' + m[2].slice(4, 6), strike: +m[4] / 1000, mult: 100 };
}
const r2 = x => Math.round(x * 100) / 100;

// Non-trade activities → { fills, events }: OPTRD becomes a fill (shares bought or sold at the strike, marked as coming from
// an option event), OPEXP / OPASN / OPEXC an event that closes what is left of that contract at 0. Both are dated after the
// day's trades (the activities carry a date, not a time). An OPTRD's price per share is its cash amount ÷ its quantity (the
// strike): Alpaca's own example shows a "price" field unlike the strike.
export function optionEvents(nta) {
  const fills = [], events = [];
  for (const a of nta || []) {
    const day = String(a.date || a.transaction_time || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !a.symbol) continue;
    const t = day + 'T21:00:00Z';
    if (a.activity_type === 'OPTRD') { const q = +a.qty || 0, px = Math.abs(+a.net_amount || 0) > 0 && q ? Math.abs(+a.net_amount / q) : +a.price; if (q && px > 0) fills.push({ order_id: 'nta-' + (a.id || a.symbol + day), symbol: a.symbol, side: q > 0 ? 'buy' : 'sell', qty: String(Math.abs(q)), price: String(px), transaction_time: t, nta: true }); }
    else if (a.activity_type === 'OPEXP' || a.activity_type === 'OPASN' || a.activity_type === 'OPEXC') events.push({ sym: a.symbol, t, why: a.activity_type === 'OPEXP' ? 'expired' : a.activity_type === 'OPASN' ? 'assigned' : 'exercised' });
  }
  return { fills, events };
}

export function buildJournal(fills, positions, events = []) {
  // 1) merge partial fills per order
  const byOrder = new Map();
  for (const f of fills) {
    const k = f.order_id || f.id;
    const q = Math.abs(+f.qty), px = +f.price;
    const o = byOrder.get(k) || { sym: f.symbol, side: f.side, qty: 0, cost: 0, t: f.transaction_time, t0: f.transaction_time, nta: !!f.nta };
    o.qty += q; o.cost += q * px; if (f.transaction_time > o.t) o.t = f.transaction_time; if (f.transaction_time < o.t0) o.t0 = f.transaction_time;
    byOrder.set(k, o);
  }
  const orders = [...byOrder.values()].map(o => ({ ...o, px: o.cost / o.qty }))
    .concat((events || []).map(e => ({ sym: e.sym, flat: true, why: e.why, t: e.t })))
    .sort((a, b) => { const x = a.t0 || a.t, y = b.t0 || b.t; return x < y ? -1 : x > y ? 1 : (a.flat ? 1 : 0) - (b.flat ? 1 : 0); });   // in the order the orders began to fill (a sale filled in pieces opens before a buy-back between them); an event after the same moment's trades
  // 2) FIFO pairing per symbol: buys close sold lots first, sells close bought lots first; what is left opens a lot
  const lots = {}, closed = [];
  const longTrade = (sym, info, lot, q, px, t, extra = {}) => ({ sym, ...info, qty: r2(q), inPx: r2(lot.px), inT: lot.t, outPx: r2(px), outT: t, pl: r2((px - lot.px) * q * info.mult), plPct: lot.px > 0 ? r2((px - lot.px) / lot.px * 100) : 0, ...(lot.nta ? { wheel: true } : {}), ...extra });
  const shortTrade = (sym, info, lot, q, px, t, extra = {}) => ({ sym, ...info, qty: r2(q), inPx: r2(lot.px), inT: lot.t, outPx: r2(px), outT: t, pl: r2((lot.px - px) * q * info.mult), plPct: lot.px > 0 ? r2((lot.px - px) / lot.px * 100) : 0, short: true, wheel: true, ...extra });
  for (const o of orders) {
    const L = lots[o.sym] = lots[o.sym] || [], info = parseSym(o.sym);
    if (o.flat) {                                                         // expired / assigned / exercised: what is left of the contract closes at 0
      for (const lot of L) closed.push((lot.short ? shortTrade : longTrade)(o.sym, info, lot, lot.qty, 0, o.t, { why: o.why }));
      L.length = 0; continue;
    }
    let left = o.qty;
    const extra = o.nta ? { wheel: true, why: o.side === 'buy' ? 'assigned' : 'called away' } : {};
    if (o.side === 'buy') {
      while (left > 1e-9 && L.length && L[0].short) { const lot = L[0], q = Math.min(lot.qty, left); closed.push(shortTrade(o.sym, info, lot, q, o.px, o.t)); lot.qty -= q; left -= q; if (lot.qty <= 1e-9) L.shift(); }
      if (left > 1e-9) L.push({ qty: left, px: o.px, t: o.t, nta: o.nta });
      continue;
    }
    while (left > 1e-9 && L.length && !L[0].short) { const lot = L[0], q = Math.min(lot.qty, left); closed.push(longTrade(o.sym, info, lot, q, o.px, o.t, extra)); lot.qty -= q; left -= q; if (lot.qty <= 1e-9) L.shift(); }
    if (left > 1e-9 && info.kind !== 'Stock') L.push({ qty: left, px: o.px, t: o.t, short: true });   // an option sold to open (the wheel); a stock sale with no lot is a gap in the fills
  }
  // 3) open positions, with when they were bought (or sold, for a sold option)
  const open = (positions || []).map(p => {
    const info = parseSym(p.symbol), L = lots[p.symbol] || [];
    return { sym: p.symbol, ...info, qty: +p.qty, avg: r2(+p.avg_entry_price), now: r2(+p.current_price), pl: r2(+p.unrealized_pl), plPct: r2(+p.unrealized_plpc * 100), since: L.length ? L[0].t : null, ...(+p.qty < 0 ? { short: true } : {}) };
  });
  closed.sort((a, b) => a.outT < b.outT ? 1 : -1);
  return { closed, open };
}
