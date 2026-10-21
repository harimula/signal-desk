// Long-history backtest of the Signal Desk day-trade rules on daily bars.
// Run by the "backtest" GitHub Actions workflow (or locally: node bot/backtest.mjs).
// Honest limits, stated in the report: daily bars only (no 40-year minute data exists),
// one trade per symbol per day, no fees/slippage, survivorship bias in the fixed universe.
import fs from 'node:fs';
import { replay } from './strategy.mjs';

const YEARS = +(process.env.BT_YEARS || 40);
const UNIVERSE = (process.env.BT_SYMBOLS || 'AAPL,MSFT,KO,JNJ,PG,XOM,CVX,JPM,WMT,MCD,DIS,IBM,GE,CAT,BA,MMM,HD,INTC,ORCL,T,VZ,PFE,MRK,PEP,NKE,AXP,GS,UNH,LOW,TXN,AMD,ADBE,COST,SBUX,CSCO,QCOM,AMGN,GD,LMT,SPY').split(',');

async function pull(sym) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${YEARS}y&interval=1d&includePrePost=false`;
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const res = (await r.json()).chart.result[0], q = res.indicators.quote[0], ts = res.timestamp, bars = [], dates = [];
  ts.forEach((t, i) => { if (q.close[i] != null && q.high[i] != null) { bars.push({ o: q.open[i] ?? q.close[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }); dates.push(t); } });
  return { bars, closes: bars.map(b => b.c), dates };
}

const fmtPct = x => (x >= 0 ? '+' : '') + x.toFixed(2) + '%';
const byYear = {};
let all = [], perSym = [];
for (const sym of UNIVERSE) {
  try {
    const { bars, closes, dates } = await pull(sym);
    const tr = replay(bars, closes);
    tr.forEach(t => { t.sym = sym; t.y = new Date(dates[t.i] * 1000).getUTCFullYear(); (byYear[t.y] = byYear[t.y] || []).push(t.pl); });
    all = all.concat(tr);
    const tot = tr.reduce((s, t) => s + t.pl, 0);
    perSym.push({ sym, n: tr.length, tot, win: tr.filter(t => t.pl > 0).length, from: new Date(dates[0] * 1000).getUTCFullYear() });
    console.log(sym, tr.length, 'trades', fmtPct(tot));
  } catch (e) { console.log('skip', sym, e.message); }
  await new Promise(r => setTimeout(r, 400));
}
const wins = all.filter(t => t.pl > 0), losses = all.filter(t => t.pl <= 0);
const gw = wins.reduce((s, t) => s + t.pl, 0), gl = -losses.reduce((s, t) => s + t.pl, 0);
const years = Object.keys(byYear).sort();
let md = `# Backtest — Signal Desk day-trade rules\n\nGenerated ${new Date().toISOString().slice(0, 10)} · ${UNIVERSE.length} symbols · up to ${YEARS} years of daily bars (Yahoo Finance)\n\n`;
md += `**What this is.** Every day, for every symbol: if the stock closed above its 20-day average with RSI-2 ≤ 40, place a buy limit at S3 for the next session; stop S4, target R1; out at the close if neither hits. One trade per symbol per day, equal-weighted. No fees or slippage counted. The fixed symbol list means survivorship bias — treat results as the rules' character, not a promise.\n\n`;
md += `## Overall\n\n| Metric | Value |\n|---|---|\n| Trades | ${all.length} |\n| Win rate | ${(wins.length / Math.max(1, all.length) * 100).toFixed(1)}% |\n| Average trade | ${fmtPct(all.reduce((s, t) => s + t.pl, 0) / Math.max(1, all.length))} |\n| Profit factor | ${gl > 0 ? (gw / gl).toFixed(2) : 'n/a'} |\n| Sum of per-trade % | ${fmtPct(all.reduce((s, t) => s + t.pl, 0))} |\n\n`;
md += `## Year by year (average trade, trade count)\n\n| Year | Avg trade | Trades | Win rate |\n|---|---|---|---|\n`;
for (const y of years) { const a = byYear[y]; const w = a.filter(x => x > 0).length; md += `| ${y} | ${fmtPct(a.reduce((s, x) => s + x, 0) / a.length)} | ${a.length} | ${(w / a.length * 100).toFixed(0)}% |\n`; }
md += `\n## Per symbol\n\n| Symbol | Since | Trades | Win rate | Sum of trade % |\n|---|---|---|---|---|\n`;
perSym.sort((a, b) => b.tot - a.tot).forEach(s => { md += `| ${s.sym} | ${s.from} | ${s.n} | ${(s.win / Math.max(1, s.n) * 100).toFixed(0)}% | ${fmtPct(s.tot)} |\n`; });
md += `\n*Not financial advice. Past results do not predict future results.*\n`;
fs.writeFileSync('bot/backtest_report.md', md);
console.log('report written: bot/backtest_report.md');
