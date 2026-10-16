// Cloudflare Worker: tiny read-only proxy for Yahoo Finance chart data.
// Usage: https://<your-worker>.workers.dev/?sym=AAPL
export default {
  async fetch(req) {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'content-type': 'application/json'
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const sym = new URL(req.url).searchParams.get('sym');
    if (!sym || !/^[A-Za-z0-9.\-^=&]{1,20}$/.test(sym)) {
      return new Response('{"error":"bad symbol"}', { status: 400, headers: cors });
    }
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) +
      '?range=1y&interval=1d&includePrePost=false';
    const r = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0' },
      cf: { cacheTtl: 60, cacheEverything: true }
    });
    return new Response(r.body, { status: r.status, headers: { ...cors, 'cache-control': 'public, max-age=60' } });
  }
};
