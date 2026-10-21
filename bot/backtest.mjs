// Professional-style backtest of the bot's stock rules on long daily history.
// - Trading costs: 0.05% per side (slippage + fees) on every trade.
// - Position sizing like the bot: 10% of equity per position, max 6 per day (strongest RSI-2 first).
// - Market-regime filter (SPY vs its 50/200-day averages), tested ON vs OFF.
// - In-sample (first 70% of years) vs out-of-sample (last 30%) — a strategy that only works
//   in-sample is curve-fit. SPY buy-and-hold shown for the same period.
// Honest limits: daily bars only (no 40-year minute data exists), one round trip per stock per
// day, options are not backtested (no free historical option prices), fixed symbol list =
// survivorship bias. Run: Actions → backtest → Run workflow (or node bot/backtest.mjs).
import fs from 'node:fs';
import { signalAt } from './strategy.mjs';
import { regimeOf } from './risk.mjs';

const YEARS = +(process.env.BT_YEARS || 40), COST = +(process.env.BT_COST_PCT || 0.05) / 100;
const POS = 0.10, MAXPOS = 6;
const UNIVERSE = (process.env.BT_SYMBOLS || 'AAPL,MSFT,KO,JNJ,PG,XOM,CVX,JPM,WMT,MCD,DIS,IBM,GE,CAT,BA,MMM,HD,INTC,ORCL,T,VZ,PFE,MRK,PEP,NKE,AXP,GS,UNH,LOW,TXN,AMD,ADBE,COST,SBUX,CSCO,QCOM,AMGN,GD,LMT').split(',');

async function pullYahoo(sym) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${YEARS}y&interval=1d&includePrePost=false`;
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const res = (await r.json()).chart.result[0], q = res.indicators.quote[0], out = [];
  res.timestamp.forEach((t, i) => { if (q.close[i] != null && q.high[i] != null && q.low[i] != null) out.push({ d: new Date(t * 1000).toISOString().slice(0, 10), o: q.open[i] ?? q.close[i], h: q.high[i], l: q.low[i], c: q.close[i] }); });
  return out;
}
function pullLiveJson(sym) {            // offline test path: uses the site's live.json (60 bars)
  const lj = JSON.parse(fs.readFileSync('live.json', 'utf8')), row = lj.rows[sym]; if (!row) throw new Error('no row');
  const cl = row[27], flat = row[28], nb = flat.length / 4, tail = cl.slice(-nb), dates = lj.dates[sym.endsWith('.NS') ? 'IN' : 'US'] || [];
  return Array.from({ length: nb }, (_, i) => ({ d: dates[i] ? new Date(dates[i] * 1000).toISOString().slice(0, 10) : 'd' + String(i).padStart(4, '0'), o: flat[i * 4], h: flat[i * 4 + 1], l: flat[i * 4 + 2], c: tail[i] }));
}
const pull = async s => process.env.BT_SOURCE === 'livejson' ? pullLiveJson(s) : pullYahoo(s);

// trades for one symbol: {d (trade date), sig date, pl (net of costs), r2}
function tradesOf(bars) {
  const closes = bars.map(b => b.c), out = [];
  for (let i = 22; i < bars.length - 1; i++) {
    const sig = signalAt(bars, closes, i); if (!sig) continue;
    const nb = bars[i + 1];
    const fill = nb.o < sig.entry ? nb.o : (nb.l <= sig.entry ? sig.entry : null); if (fill == null) continue;
    let exit;
    if (fill <= sig.stop) exit = nb.c; else if (nb.l <= sig.stop) exit = sig.stop; else if (nb.h >= sig.target) exit = Math.max(sig.target, fill); else exit = nb.c;
    out.push({ d: nb.d, sigD: bars[i].d, pl: (exit - fill) / fill - 2 * COST, r2: sig.r2 });
  }
  return out;
}

function metrics(days, label) {            // days: [{d, ret}] sorted
  if (!days.length) return { label, years: 0 };
  let eq = 1, peak = 1, mdd = 0;
  for (const x of days) { eq *= 1 + x.ret; peak = Math.max(peak, eq); mdd = Math.max(mdd, 1 - eq / peak); }
  const y0 = +days[0].d.slice(0, 4), y1 = +days[days.length - 1].d.slice(0, 4), years = Math.max(1, (Date.parse(days[days.length - 1].d) - Date.parse(days[0].d)) / (365.25 * 864e5));
  const rs = days.map(x => x.ret), mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  const sd = Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / rs.length), dsd = Math.sqrt(rs.reduce((a, b) => a + Math.min(0, b) ** 2, 0) / rs.length);
  return { label, from: days[0].d, to: days[days.length - 1].d, years: +years.toFixed(1), cagr: (eq ** (1 / years) - 1) * 100, sharpe: sd ? mean / sd * Math.sqrt(252) : 0, sortino: dsd ? mean / dsd * Math.sqrt(252) : 0, maxDD: mdd * 100, total: (eq - 1) * 100 };
}
function portfolio(trades, calendar, allow) {   // calendar: all SPY dates; allow(date) => regime ok
  const byDay = {};
  for (const t of trades) if (allow(t.sigD)) (byDay[t.d] = byDay[t.d] || []).push(t);
  const days = [], list = [];
  for (const d of calendar) {
    const arr = (byDay[d] || []).sort((a, b) => a.r2 - b.r2).slice(0, MAXPOS);
    arr.forEach(t => list.push(t));
    days.push({ d, ret: arr.reduce((s, t) => s + t.pl * POS, 0) });
  }
  return { days, list };
}
function tradeStats(list) {
  const w = list.filter(t => t.pl > 0), l = list.filter(t => t.pl <= 0);
  const gw = w.reduce((s, t) => s + t.pl, 0), gl = -l.reduce((s, t) => s + t.pl, 0);
  return { n: list.length, win: list.length ? w.length / list.length * 100 : 0, avgWin: w.length ? gw / w.length * 100 : 0, avgLoss: l.length ? -gl / l.length * 100 : 0, expectancy: list.length ? (gw - gl) / list.length * 100 : 0, pf: gl > 0 ? gw / gl : null };
}

const spyBars = await pull('SPY');
const calendar = spyBars.map(b => b.d), spyClose = spyBars.map(b => b.c);
const regimeOn = {};                       // regime known at the close of each date
spyBars.forEach((b, i) => { regimeOn[b.d] = regimeOf(spyClose.slice(Math.max(0, i - 299), i + 1)).regime; });
let trades = [], perSym = [];
for (const sym of UNIVERSE) {
  try { const t = tradesOf(await pull(sym)); trades = trades.concat(t.map(x => ({ ...x, sym }))); perSym.push({ sym, ...tradeStats(t) }); console.log(sym, t.length); }
  catch (e) { console.log('skip', sym, e.message); }
  if (process.env.BT_SOURCE !== 'livejson') await new Promise(r => setTimeout(r, 300));
}
const split = calendar[Math.floor(calendar.length * 0.7)];
const runs = {
  on: portfolio(trades, calendar, d => regimeOn[d] !== 'bear'),
  off: portfolio(trades, calendar, () => true),
};
const spyDays = spyBars.slice(1).map((b, i) => ({ d: b.d, ret: b.c / spyBars[i].c - 1 }));
const M = {
  full: metrics(runs.on.days, 'Bot rules (regime filter ON)'), fullOff: metrics(runs.off.days, 'Same rules, filter OFF'), spy: metrics(spyDays, 'SPY buy & hold'),
  ins: metrics(runs.on.days.filter(x => x.d < split), 'In-sample (first 70%)'), oos: metrics(runs.on.days.filter(x => x.d >= split), 'Out-of-sample (last 30%)'),
  spyOos: metrics(spyDays.filter(x => x.d >= split), 'SPY, out-of-sample period'),
};
const TS = tradeStats(runs.on.list), TSo = tradeStats(runs.on.list.filter(t => t.d >= split));
const byYear = {};
for (const x of runs.on.days) { const y = x.d.slice(0, 4); byYear[y] = (byYear[y] || 1) * (1 + x.ret); }
const f = (x, d = 2) => x == null || !isFinite(x) ? 'n/a' : x.toFixed(d), pc = x => (x >= 0 ? '+' : '') + f(x) + '%';
const row = m => `| ${m.label} | ${m.from || ''} → ${m.to || ''} | ${pc(m.cagr)} | ${f(m.sharpe)} | ${f(m.sortino)} | −${f(m.maxDD, 1)}% | ${pc(m.total)} |`;
let md = `# Backtest — Signal Desk bot rules\n\nGenerated ${new Date().toISOString().slice(0, 10)} · ${perSym.length} stocks · ${YEARS} years requested · costs ${(COST * 100).toFixed(2)}% per side · 10% of equity per position, max ${MAXPOS} a day\n\n`;
md += `## Headline numbers\n\n| Strategy | Period | CAGR | Sharpe | Sortino | Max drawdown | Total |\n|---|---|---|---|---|---|---|\n${[M.full, M.fullOff, M.spy].map(row).join('\n')}\n\n`;
md += `## Is it real or curve-fit? In-sample vs out-of-sample\n\n| Strategy | Period | CAGR | Sharpe | Sortino | Max drawdown | Total |\n|---|---|---|---|---|---|---|\n${[M.ins, M.oos, M.spyOos].map(row).join('\n')}\n\n`;
md += `If the out-of-sample Sharpe is far below in-sample, the edge is fading or was luck.\n\n`;
md += `## Per-trade statistics (filter ON)\n\n| | All years | Out-of-sample |\n|---|---|---|\n| Trades | ${TS.n} | ${TSo.n} |\n| Win rate | ${f(TS.win, 1)}% | ${f(TSo.win, 1)}% |\n| Average win | ${pc(TS.avgWin)} | ${pc(TSo.avgWin)} |\n| Average loss | ${pc(TS.avgLoss)} | ${pc(TSo.avgLoss)} |\n| Expectancy per trade | ${pc(TS.expectancy)} | ${pc(TSo.expectancy)} |\n| Profit factor | ${f(TS.pf)} | ${f(TSo.pf)} |\n\n`;
md += `## Year by year (filter ON)\n\n| Year | Return |\n|---|---|\n${Object.keys(byYear).sort().map(y => `| ${y} | ${pc((byYear[y] - 1) * 100)} |`).join('\n')}\n\n`;
md += `## Per stock\n\n| Stock | Trades | Win rate | Expectancy | Profit factor |\n|---|---|---|---|---|\n${perSym.sort((a, b) => b.expectancy - a.expectancy).map(s => `| ${s.sym} | ${s.n} | ${f(s.win, 0)}% | ${pc(s.expectancy)} | ${f(s.pf)} |`).join('\n')}\n\n`;
md += `**Limits:** daily bars (no 40-year intraday data exists), one round trip per stock per day, options not backtested, fixed symbol list (survivorship bias), costs are an estimate. Past results do not predict future results. Not financial advice.\n`;
fs.writeFileSync('bot/backtest_report.md', md);
fs.writeFileSync('bot/backtest.json', JSON.stringify({ at: new Date().toISOString(), stocks: perSym.length, cost: COST * 100, metrics: M, trades: TS, tradesOos: TSo, byYear: Object.fromEntries(Object.entries(byYear).map(([y, v]) => [y, (v - 1) * 100])) }));
console.log(JSON.stringify({ full: M.full, oos: M.oos, spy: M.spy }, null, 1));
