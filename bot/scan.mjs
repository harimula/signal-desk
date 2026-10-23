// Market scan: build the day's watch list from EVERY tradable US stock instead of a fixed list.
//   1. ask the broker for all active, tradable US equities on the main exchanges (no OTC, no warrants/units);
//   2. pull the last ~20 daily bars for all of them (a few paged requests);
//   3. rank by average daily dollar volume, drop anything under the minimum price, keep the top N.
// Volume comes from the free IEX feed, which is a slice of total market volume — the ranking is what matters,
// and it is stable: the same large, liquid names come out on top every day.
const EXCHANGES = new Set(['NYSE', 'NASDAQ', 'ARCA', 'AMEX', 'BATS']);
const SYM_OK = /^[A-Z]{1,5}$/;
const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export function rankByLiquidity(bars, { size = 200, minPrice = 5, minDays = 10 } = {}) {
  const rows = [];
  for (const [sym, arr] of Object.entries(bars || {})) {
    if (!Array.isArray(arr) || arr.length < minDays) continue;
    const last = arr[arr.length - 1];
    if (!(last && last.c >= minPrice)) continue;
    const dv = arr.reduce((t, b) => t + (b.c || 0) * (b.v || 0), 0) / arr.length;
    if (dv > 0) rows.push({ sym, px: last.c, dollarVol: Math.round(dv) });
  }
  rows.sort((a, b) => b.dollarVol - a.dollarVol);
  return rows.slice(0, size);
}

export async function scanUniverse({ T, D, size = 200, minPrice = 5, log = () => {} }) {
  const assets = await T('/v2/assets?status=active&asset_class=us_equity', { timeoutMs: 60000 });   // ~12,000 assets: a large answer
  const syms = (assets || []).filter(a => a.tradable && EXCHANGES.has(a.exchange) && SYM_OK.test(a.symbol)).map(a => a.symbol).sort();
  log(`market scan: ${syms.length} tradable US stocks`);
  const start = new Date(Date.now() - 32 * 864e5).toISOString(), bars = {};
  for (const part of chunk(syms, 500)) {                      // 500 symbols × ~22 bars per request: big, so each gets a 60 s limit
    let token = '';
    for (let k = 0; k < 30; k++) {
      const j = await D(`/v2/stocks/bars?symbols=${part.join(',')}&timeframe=1Day&start=${start}&limit=10000&feed=iex&sort=asc${token ? '&page_token=' + token : ''}`, { timeoutMs: 60000 });
      for (const [s, arr] of Object.entries(j.bars || {})) bars[s] = (bars[s] || []).concat(arr);
      token = j.next_page_token; if (!token) break;
    }
  }
  const top = rankByLiquidity(bars, { size, minPrice });
  log(`market scan: kept the ${top.length} most-traded (price ≥ $${minPrice}); top names ${top.slice(0, 8).map(r => r.sym).join(', ')}`);
  return { at: new Date().toISOString(), scanned: syms.length, symbols: top.map(r => r.sym), top };
}
