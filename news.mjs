// Collects market news into news.json (run by the refresh workflow; no key needed for RSS).
// Sources: Yahoo Finance market RSS, Federal Reserve press releases, and Alpaca/Benzinga news
// (with summaries) when ALPACA_KEY/ALPACA_SECRET secrets exist.
import fs from 'node:fs';

const ent = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d)).replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const decode = s => ent(ent((s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
export function parseRss(xml, src) {
  const out = [];
  for (const m of xml.matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const it = m[0], g = tag => { const r = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '>').exec(it); return r ? decode(r[1]) : ''; };
    const h = g('title'); if (!h) continue;
    const t = Date.parse(g('pubDate') || g('dc:date')) || Date.now();
    out.push({ t, h, u: g('link'), sum: g('description').slice(0, 400), s: src });
  }
  return out;
}
async function get(url, headers = {}) {
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 signal-desk', ...headers } });
  if (!r.ok) throw new Error(url.split('?')[0] + ' HTTP ' + r.status);
  return r;
}
async function collect() {
  const items = [], status = {};
  const jobs = [
    ['Yahoo Finance', async () => parseRss(await (await get('https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC,%5EDJI,%5EIXIC,SPY,QQQ&region=US&lang=en-US')).text(), 'Yahoo Finance')],
    ['Federal Reserve', async () => parseRss(await (await get('https://www.federalreserve.gov/feeds/press_all.xml')).text(), 'Federal Reserve')],
  ];
  if (process.env.ALPACA_KEY && process.env.ALPACA_SECRET) jobs.push(['Benzinga', async () => {
    const j = await (await get('https://data.alpaca.markets/v1beta1/news?limit=50&sort=desc', { 'APCA-API-KEY-ID': process.env.ALPACA_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET })).json();
    return (j.news || []).map(a => ({ t: Date.parse(a.created_at), h: a.headline, u: a.url, sum: decode(a.summary || '').slice(0, 400), s: a.source ? a.source[0].toUpperCase() + a.source.slice(1) : 'Benzinga', sy: a.symbols || [] }));
  }]);
  for (const [name, fn] of jobs) {
    try { const r = await fn(); items.push(...r); status[name] = r.length; }
    catch (e) { status[name] = 'error: ' + e.message.slice(0, 80); }
  }
  const seen = new Set(), clean = [];
  for (const it of items.sort((a, b) => b.t - a.t)) {
    const k = it.h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').slice(0, 70);
    if (seen.has(k) || Date.now() - it.t > 3 * 864e5) continue;
    seen.add(k); clean.push(it);
  }
  // per-stock headlines for every tracked symbol (Yahoo RSS per ticker, India .NS included)
  const bySym = {};
  try {
    const syms = JSON.parse(fs.readFileSync('symbols.json', 'utf8')).filter(s => !s.startsWith('^'));
    let i = 0, ok = 0, fail = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (i < syms.length) {
        const s = syms[i++];
        try {
          const r = parseRss(await (await get('https://feeds.finance.yahoo.com/rss/2.0/headline?s=' + encodeURIComponent(s) + '&region=US&lang=en-US')).text(), 'Yahoo Finance')
            .filter(x => Date.now() - x.t < 7 * 864e5).sort((a, b) => b.t - a.t).slice(0, 4)
            .map(x => ({ t: x.t, h: x.h, u: x.u, sum: x.sum.slice(0, 160), s: x.s }));
          if (r.length) bySym[s] = r;
          ok++;
        } catch (e) { fail++; }
      }
    }));
    status['Per-stock'] = ok + ' ok' + (fail ? ', ' + fail + ' failed' : '');
  } catch (e) { status['Per-stock'] = 'error: ' + e.message.slice(0, 60); }
  return { at: Date.now(), status, items: clean.slice(0, 120), bySym };
}
if (import.meta.url === 'file://' + process.argv[1]) {
  const out = await collect();
  if (!out.items.length && fs.existsSync('news.json')) { console.log('No news fetched - keeping old file', out.status); process.exit(0); }
  fs.writeFileSync('news.json', JSON.stringify(out));
  console.log('news.json:', out.items.length, 'items', JSON.stringify(out.status));
}
