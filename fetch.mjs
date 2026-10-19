// Pulls daily data from Yahoo Finance and writes live.json (run by GitHub Actions).
import fs from 'node:fs';
const syms = JSON.parse(fs.readFileSync('symbols.json', 'utf8'));
const r2 = x => Math.round(x * 100) / 100;
const ema = (c, n) => { const o = new Array(c.length).fill(null); if (c.length < n) return o; const k = 2 / (n + 1); let e = c.slice(0, n).reduce((a, b) => a + b, 0) / n; o[n - 1] = e; for (let i = n; i < c.length; i++) { e = c[i] * k + e * (1 - k); o[i] = e; } return o; };
const sma = (a, k) => { const w = a.slice(-k); return w.reduce((s, x) => s + x, 0) / w.length; };
const rsi = (c, n = 14) => { let g = 0, l = 0; for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d >= 0) g += d; else l -= d; } g /= n; l /= n; for (let i = n + 1; i < c.length; i++) { const d = c[i] - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; } return l === 0 ? 100 : 100 - 100 / (1 + g / l); };
const atr = (b, n = 14) => { const tr = []; for (let i = 1; i < b.length; i++) tr.push(Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c))); let a = tr.slice(0, n).reduce((s, x) => s + x, 0) / n; for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n; return a; };
async function pull(sym) {
  const u = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=1y&interval=1d&includePrePost=false';
  const resp = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const res = (await resp.json()).chart.result[0], m = res.meta, q = res.indicators.quote[0], ts = res.timestamp, b = [];
  ts.forEach((t, i) => { if (q.close[i] != null && q.high[i] != null) b.push({ t, o: q.open[i] != null ? q.open[i] : q.close[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }); });
  if (b.length < 60) throw new Error('not enough history');
  const now = Date.now() / 1000, reg = m.currentTradingPeriod && m.currentTradingPeriod.regular; let partial = 0;
  if (reg && now < reg.end && b[b.length - 1].t >= reg.start) { partial = b[b.length - 1].v; b.pop(); }
  const c = b.map(x => x.c), n = c.length, e12 = ema(c, 12), e26 = ema(c, 26);
  const mv = c.map((_, i) => e26[i] == null ? null : e12[i] - e26[i]).filter(x => x != null), sg = ema(mv, 9);
  const macd = mv.at(-1), sig = sg.at(-1), hist = macd - sig, hp = mv.at(-2) - sg.at(-2);
  const last = c[n - 1], prev = c[n - 2], vol = b.map(x => x.v), w = (a, k) => a.slice(-k), ret = k => n > k ? (last / c[n - 1 - k] - 1) * 100 : 0;
  const rec = [m.longName || m.shortName || sym, m.regularMarketPrice, last, prev, sma(c, 20), sma(c, 50), sma(c, 100), sma(c, 200), macd, sig, hist, hp, rsi(c), atr(b),
    Math.max(...b.map(x => x.h)), Math.min(...b.map(x => x.l)), Math.max(...w(b, 20).map(x => x.h)), Math.min(...w(b, 20).map(x => x.l)), Math.max(...w(b, 10).map(x => x.h)), Math.min(...w(b, 10).map(x => x.l)),
    sma(vol, 20), vol[n - 1], partial, ret(5), ret(20), ret(60), ret(120)].map(x => typeof x === 'number' ? r2(x) : x);
  const w60 = b.slice(-60);
  const bars = [].concat(...w60.map(x => [r2(x.o), r2(x.h), r2(x.l), Math.round(x.v / 1000)]));
  return { row: rec.concat([c.slice(-130).map(r2), bars]), liveAt: m.regularMarketTime, tss: w60.map(x => x.t) };
}
const mk = k => (k.endsWith('.NS') || k.startsWith('^N') || k.startsWith('^C')) ? 'IN' : 'US';
const rows = {}, liveAt = { US: 0, IN: 0 }, dates = {}; let fail = 0, i = 0;
await Promise.all(Array.from({ length: 5 }, async () => { while (i < syms.length) { const s = syms[i++]; try { const r = await pull(s); rows[s] = r.row; liveAt[mk(s)] = Math.max(liveAt[mk(s)], r.liveAt || 0); if (s === 'SPY') dates.US = r.tss; if (s === '^NSEI') dates.IN = r.tss; } catch (e) { fail++; console.log('fail', s, e.message); } } }));
if (Object.keys(rows).length < syms.length * 0.8) { console.log('too many failures, keeping old file'); process.exit(1); }
fs.writeFileSync('live.json', JSON.stringify({ at: Date.now(), liveAt, dates, rows }));
console.log('ok', Object.keys(rows).length, 'fail', fail);
