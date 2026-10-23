// Strategy research: same universe, costs and position sizing; proper portfolio simulator
// (cash + marked-to-market positions, max 6 at once, 10% of equity each). Every strategy is
// judged on out-of-sample years (last 30%) it was never tuned on.
import fs from 'node:fs';
import { signalAt, rsi2, sma } from './strategy.mjs';
import { regimeOf } from './risk.mjs';
import { NIFTY100 as NIFTY100_LIST } from './india.mjs';

// Market: US (default) or IN (NSE). India: Nifty 100 names (today's list — survivorship bias, as for the US), the Nifty 50 index as
// benchmark and regime filter, and 0.15% per side for costs (STT 0.1%, stamp duty, exchange/SEBI fees, GST, DP charge, slippage).
const MKT = (process.env.BT_MARKET || 'US').toUpperCase();
const NIFTY100 = NIFTY100_LIST.map(s => s + '.NS').join(',');                        // one list for the research and the India bot
const BENCH = MKT === 'IN' ? '^NSEI' : 'SPY', BENCH_NAME = MKT === 'IN' ? 'Nifty 50' : 'SPY';
const OUT = MKT === 'IN' ? { json: 'bot/research-in.json', md: 'bot/research_in_report.md' } : { json: 'bot/research.json', md: 'bot/research_report.md' };
const YEARS = +(process.env.BT_YEARS || 40), COST = +(process.env.BT_COST || (MKT === 'IN' ? 0.0015 : 0.0005)), POS = 0.10, MAXPOS = 6;
const UNIVERSE = (process.env.BT_SYMBOLS || (MKT === 'IN' ? NIFTY100 : null) || 'AAPL,MSFT,KO,JNJ,PG,XOM,CVX,JPM,WMT,MCD,DIS,IBM,GE,CAT,BA,MMM,HD,INTC,ORCL,T,VZ,PFE,MRK,PEP,NKE,AXP,GS,UNH,LOW,TXN,AMD,ADBE,COST,SBUX,CSCO,QCOM,AMGN,GD,LMT').split(',');
async function pull(sym) {
  if (process.env.BT_SOURCE === 'livejson') {
    const lj = JSON.parse(fs.readFileSync('live.json', 'utf8')), row = lj.rows[sym]; if (!row) throw new Error('no row');
    const cl = row[27], flat = row[28], nb = flat.length / 4, tail = cl.slice(-nb), ds = lj.dates.US || [];
    return Array.from({ length: nb }, (_, i) => ({ d: new Date(ds[i] * 1000).toISOString().slice(0, 10), o: flat[i * 4], h: flat[i * 4 + 1], l: flat[i * 4 + 2], c: tail[i] }));
  }
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${YEARS}y&interval=1d`, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const res = (await r.json()).chart.result[0], q = res.indicators.quote[0], out = [];
  res.timestamp.forEach((t, i) => { if (q.close[i] != null && q.high[i] != null && q.low[i] != null) out.push({ d: new Date(t * 1000).toISOString().slice(0, 10), o: q.open[i] ?? q.close[i], h: q.high[i], l: q.low[i], c: q.close[i] }); });
  return out;
}

// ---- strategies: each returns, for symbol bars, a map date -> entry plan (decided at the PREVIOUS close) ----
// kind 'intraday': fill + exit on that same day. kind 'swing': buy, then hold until exitRule says go.
const STRATS = {
  daytrade: { label: 'Current bot rules (intraday pullback, S3 → R1, stop S4)', kind: 'intraday',
    plan(B, C, i) { const s = signalAt(B, C, i); return s && { entry: s.entry, stop: s.stop, target: s.target, rank: s.r2 }; } },
  rsi2: { label: 'RSI-2 mean reversion (Connors): above 200-day, RSI-2 < 10, buy at next open, sell when close > 5-day avg (max 10 days)', kind: 'swing',
    plan(B, C, i) { const s200 = sma(C, 200, i), r = rsi2(C, i); return s200 && r != null && C[i] > s200 && r < 10 ? { rank: r } : null; },
    exit(B, C, j, held) { const s5 = sma(C, 5, j); return (s5 && C[j] > s5) || held >= 10; } },
  rsi2stop: { label: 'RSI-2 mean reversion + 3× range stop', kind: 'swing',
    plan(B, C, i) { const s200 = sma(C, 200, i), r = rsi2(C, i); if (!(s200 && r != null && C[i] > s200 && r < 10)) return null; let rg = 0; for (let k = i - 9; k <= i; k++) rg += B[k].h - B[k].l; return { rank: r, stopDist: 3 * rg / 10 }; },
    exit(B, C, j, held) { const s5 = sma(C, 5, j); return (s5 && C[j] > s5) || held >= 10; } },
  // Short side (stock short is the cleanest proxy for buying puts: same direction, no decay or option spread).
  rsi2short: { label: 'RSI-2 short (mirror of the bot): below 200-day, RSI-2 > 90, short at next open, cover when close < 5-day avg (max 10 days)', kind: 'swing', short: true,
    plan(B, C, i) { const s200 = sma(C, 200, i), r = rsi2(C, i); return s200 && r != null && C[i] < s200 && r > 90 ? { rank: -r } : null; },
    exit(B, C, j, held) { const s5 = sma(C, 5, j); return (s5 && C[j] < s5) || held >= 10; } },
  breakout: { label: 'Trend breakout: close at a 50-day high above the 200-day, exit on a 20-day low', kind: 'swing',
    plan(B, C, i) { const s200 = sma(C, 200, i); if (!s200 || C[i] <= s200) return null; let hi = -1; for (let k = i - 50; k < i; k++) hi = Math.max(hi, C[k]); return C[i] > hi ? { rank: -C[i] / s200 } : null; },
    exit(B, C, j) { let lo = 1e18; for (let k = j - 20; k < j; k++) lo = Math.min(lo, B[k].l); return C[j] < lo; } },
};

function simulate(key, data, calendar, regimeOn, useRegime) {
  const S = STRATS[key];
  let cash = 1, open = [];                       // open: {sym, sh, px (last mark), entryPx, held, stop}
  const days = [], trades = [];
  for (let t = 1; t < calendar.length; t++) {
    const d = calendar[t], prevD = calendar[t - 1];
    // 1) manage open swing positions at today's bar
    for (const p of open) {
      const D = data[p.sym], j = D.idx[d]; if (j == null) continue;
      const b = D.B[j];
      let exitPx = null;
      if (p.stop && b.l <= p.stop) exitPx = Math.min(b.o, p.stop);
      else { p.held++; if (S.exit(D.B, D.C, j, p.held)) exitPx = b.c; }
      if (exitPx != null) {
        if (S.short) { const r = (p.entryPx - exitPx) / p.entryPx - 2 * COST; cash += p.alloc * (1 + r); trades.push(r); }
        else { cash += p.sh * exitPx * (1 - COST); trades.push((exitPx * (1 - COST)) / (p.entryPx * (1 + COST)) - 1); }
        p.done = true;
      }
      else p.px = S.short ? 2 * p.entryPx - b.c : b.c;          // a short is marked as margin plus the gain or loss
    }
    open = open.filter(p => !p.done);
    // 2) new entries from plans made at yesterday's close
    const equityPrev = cash + open.reduce((s, p) => s + p.sh * p.px, 0);
    if (!useRegime || regimeOn[prevD] !== 'bear') {
      const cands = [];
      for (const sym in data) {
        const D = data[sym], i = D.idx[prevD]; if (i == null || i < 210 || open.some(p => p.sym === sym)) continue;
        if (D.idx[d] == null) continue;
        const pl = S.plan(D.B, D.C, i); if (pl) cands.push({ sym, pl, j: D.idx[d] });
      }
      cands.sort((a, b) => a.pl.rank - b.pl.rank);
      for (const c of cands) {
        if (open.length >= MAXPOS) break;
        const D = data[c.sym], b = D.B[c.j], alloc = equityPrev * POS;
        if (alloc > cash) break;
        if (S.kind === 'intraday') {
          const fill = b.o < c.pl.entry ? b.o : (b.l <= c.pl.entry ? c.pl.entry : null); if (fill == null) continue;
          let ex; if (fill <= c.pl.stop) ex = b.c; else if (b.l <= c.pl.stop) ex = c.pl.stop; else if (b.h >= c.pl.target) ex = Math.max(c.pl.target, fill); else ex = b.c;
          const r = (ex * (1 - COST)) / (fill * (1 + COST)) - 1; cash += alloc * r; trades.push(r);
        } else {
          const fill = b.o, sh = alloc / (fill * (1 + COST));
          cash -= alloc;
          const p = { sym: c.sym, sh, px: S.short ? 2 * fill - b.c : b.c, entryPx: fill, held: 0, alloc, stop: c.pl.stopDist ? fill - c.pl.stopDist : null };
          if (p.stop && b.l <= p.stop) { cash += sh * p.stop * (1 - COST); trades.push((p.stop * (1 - COST)) / (fill * (1 + COST)) - 1); }
          else open.push(p);
        }
      }
    }
    const eq = cash + open.reduce((s, p) => s + p.sh * p.px, 0);
    days.push({ d, eq });
  }
  return { days, trades };
}
function stats(days, trades, from, to) {
  const ds = days.filter(x => (!from || x.d >= from) && (!to || x.d < to)); if (ds.length < 2) return null;
  const rets = ds.slice(1).map((x, i) => x.eq / ds[i].eq - 1), mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
  let pk = ds[0].eq, mdd = 0; for (const x of ds) { pk = Math.max(pk, x.eq); mdd = Math.max(mdd, 1 - x.eq / pk); }
  const yrs = (Date.parse(ds[ds.length - 1].d) - Date.parse(ds[0].d)) / (365.25 * 864e5);
  const g = ds[ds.length - 1].eq / ds[0].eq;
  return { from: ds[0].d, to: ds[ds.length - 1].d, cagr: (g ** (1 / Math.max(yrs, 0.1)) - 1) * 100, sharpe: sd ? mean / sd * Math.sqrt(252) : 0, maxDD: mdd * 100 };
}
const tstats = tr => { const w = tr.filter(x => x > 0), l = tr.filter(x => x <= 0), gw = w.reduce((a, b) => a + b, 0), gl = -l.reduce((a, b) => a + b, 0); return { n: tr.length, win: tr.length ? w.length / tr.length * 100 : 0, exp: tr.length ? (gw - gl) / tr.length * 100 : 0, pf: gl > 0 ? gw / gl : null }; };

const spy = await pull(BENCH);
const calendar = spy.map(b => b.d), regimeOn = {};
spy.forEach((b, i) => { regimeOn[b.d] = regimeOf(spy.slice(Math.max(0, i - 299), i + 1).map(x => x.c)).regime; });
const data = {};
for (const s of UNIVERSE) {
  try { const B = await pull(s); data[s] = { B, C: B.map(b => b.c), idx: Object.fromEntries(B.map((b, i) => [b.d, i])) }; }
  catch (e) { console.log('skip', s, e.message); }
  if (process.env.BT_SOURCE !== 'livejson') await new Promise(r => setTimeout(r, 250));
}
const split = calendar[Math.floor(calendar.length * 0.7)];
const results = [];
for (const key of Object.keys(STRATS)) for (const rg of (STRATS[key].short ? [false] : [false, true])) {   // the bear-market block would defeat a short strategy
  const { days, trades } = simulate(key, data, calendar, regimeOn, rg);
  results.push({ key, regime: rg, label: STRATS[key].label, all: stats(days, trades), ins: stats(days, trades, null, split), oos: stats(days, trades, split), t: tstats(trades) });
  console.log(key, rg ? 'regime' : 'plain', JSON.stringify(results[results.length - 1].oos));
}
const spyDays = spy.map(b => ({ d: b.d, eq: b.c }));
const spyAll = stats(spyDays, [], null, null), spyOos = stats(spyDays, [], split);
const f = (x, d = 2) => x == null || !isFinite(x) ? 'n/a' : (+x).toFixed(d), pc = x => x == null ? 'n/a' : (x >= 0 ? '+' : '') + f(x) + '%';
let md = `# Strategy research${MKT === 'IN' ? ' — India (NSE)' : ''} — ${Object.keys(data).length} stocks, ${calendar[0]} → ${calendar[calendar.length - 1]}\n\nCosts ${(COST * 100).toFixed(2)}%/side · 10% of equity per position · max ${MAXPOS} positions · out-of-sample = ${split} onward (never used to choose anything).\n\n`;
md += `| Strategy | Regime filter | CAGR (all) | Sharpe (all) | Max DD | **OOS CAGR** | **OOS Sharpe** | OOS Max DD | Trades | Win % | Exp./trade | PF |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
for (const r of results) md += `| ${r.label} | ${r.regime ? 'on' : 'off'} | ${pc(r.all && r.all.cagr)} | ${f(r.all && r.all.sharpe)} | −${f(r.all && r.all.maxDD, 1)}% | **${pc(r.oos && r.oos.cagr)}** | **${f(r.oos && r.oos.sharpe)}** | −${f(r.oos && r.oos.maxDD, 1)}% | ${r.t.n} | ${f(r.t.win, 1)}% | ${pc(r.t.exp)} | ${f(r.t.pf)} |\n`;
md += `| ${BENCH_NAME} buy & hold | – | ${pc(spyAll.cagr)} | ${f(spyAll.sharpe)} | −${f(spyAll.maxDD, 1)}% | **${pc(spyOos.cagr)}** | **${f(spyOos.sharpe)}** | −${f(spyOos.maxDD, 1)}% | – | – | – | – |\n\n`;
md += `Survivorship bias (today’s big companies, looking back) flatters every strategy, so treat these as an upper bound. Not financial advice.\n`;
fs.writeFileSync(OUT.md, md);
fs.writeFileSync(OUT.json, JSON.stringify({ at: new Date().toISOString(), market: MKT, bench: BENCH_NAME, cost: COST, symbols: Object.keys(data), split, results, spy: { all: spyAll, oos: spyOos } }));
console.log(md);
