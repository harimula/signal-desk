// Cloudflare Worker: tiny read-only proxy for Yahoo Finance chart data.
// Usage: https://<your-worker>.workers.dev/?sym=AAPL                      (daily bars, one year — the board)
//        https://<your-worker>.workers.dev/?sym=SPY&range=max&interval=1mo (monthly bars — the Seasonality tab)
// Redeploy this file once for the Seasonality tab to use your proxy; the tab works without it (Yahoo directly, then relays).
export default {
  async fetch(req) {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'content-type': 'application/json'
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const u = new URL(req.url);
    const sym = u.searchParams.get('sym');
    if (!sym || !/^[A-Za-z0-9.\-^=&]{1,20}$/.test(sym)) {
      return new Response('{"error":"bad symbol"}', { status: 400, headers: cors });
    }
    const range = /^(1mo|3mo|6mo|1y|2y|5y|10y|max)$/.test(u.searchParams.get('range') || '') ? u.searchParams.get('range') : '1y';
    const interval = /^(1d|1wk|1mo)$/.test(u.searchParams.get('interval') || '') ? u.searchParams.get('interval') : '1d';
    const ttl = interval === '1d' ? 60 : 1800;
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) +
      '?range=' + range + '&interval=' + interval + '&includePrePost=false';
    const r = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0' },
      cf: { cacheTtl: ttl, cacheEverything: true }
    });
    return new Response(r.body, { status: r.status, headers: { ...cors, 'cache-control': 'public, max-age=' + ttl } });
  }
};
