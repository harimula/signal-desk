// Market scan: build the day's watch list from EVERY tradable US stock instead of a fixed list.
//   1. ask the broker for all active, tradable US stocks on NYSE/Nasdaq/NYSE American (no OTC, warrants/units, ETFs or funds);
//   2. pull the last ~20 daily bars for all of them (a few paged requests);
//   3. rank by average daily dollar volume, drop anything under the minimum price, keep the top N.
// Volume comes from the free IEX feed, which is a slice of total market volume — the ranking is what matters,
// and it is stable: the same large, liquid names come out on top every day.
const EXCHANGES = new Set(['NYSE', 'NASDAQ', 'AMEX']);        // NYSE Arca and Cboe (BATS) list almost only ETFs/ETNs: left out
// Funds that list on NYSE/Nasdaq anyway (bond, sector, leveraged and inverse ETFs/ETNs) are recognised by name.
export const FUND_NAME = /\b(ETF|ETN|ETFs|Fund|Index|iShares|SPDR|ProShares|Direxion|Vanguard|Invesco QQQ|Select Sector|Ultra(Pro|Short)?|Leveraged|Inverse|2X|3X|-1X|Bull|Bear)\b/i;
export const isStockAsset = a => !!a && a.tradable && EXCHANGES.has(a.exchange) && SYM_OK.test(a.symbol) && !FUND_NAME.test(a.name || '');
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
  const syms = (assets || []).filter(isStockAsset).map(a => a.symbol).sort();     // stocks only: no ETFs, ETNs or funds
  log(`market scan: ${syms.length} tradable US stocks`);
  const start = new Date(Date.now() - 32 * 864e5).toISOString(), bars = {};
  // 100 symbols per request: bigger requests get "504 backend request timeout" from the data server. A chunk that still
  // fails (after the HTTP layer's retries) is skipped; the scan only fails when most of the market could not be read.
  const parts = chunk(syms, 100); let bad = 0, lastErr = null;
  for (const part of parts) {
    let token = '';
    try {
      for (let k = 0; k < 30; k++) {
        const j = await D(`/v2/stocks/bars?symbols=${part.join(',')}&timeframe=1Day&start=${start}&limit=10000&feed=iex&sort=asc${token ? '&page_token=' + token : ''}`, { timeoutMs: 60000 });
        for (const [s2, arr] of Object.entries(j.bars || {})) bars[s2] = (bars[s2] || []).concat(arr);
        token = j.next_page_token; if (!token) break;
      }
    } catch (e) { bad++; lastErr = e; for (const s2 of part) delete bars[s2]; }
  }
  if (bad > parts.length * 0.2) throw lastErr || new Error('too many failed chunks');
  if (bad) log(`market scan: ${bad} of ${parts.length} chunks could not be read and were skipped`);
  const top = rankByLiquidity(bars, { size, minPrice });
  log(`market scan: kept the ${top.length} most-traded (price ≥ $${minPrice}); top names ${top.slice(0, 8).map(r => r.sym).join(', ')}`);
  return { at: new Date().toISOString(), scanned: syms.length, symbols: top.map(r => r.sym), top };
}
