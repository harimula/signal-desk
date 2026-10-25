// India: three ways a bot could beat the market, tested over the last 5 years with Indian tax applied trade by trade.
//   node bot/research-in-ideas.mjs   (GitHub Actions: research-in.yml) → bot/research-in-ideas.json + bot/research_in_ideas.md
//
//   A. Trend breakout on the Nifty Midcap 150 stocks — buy a close at a 50-day high above the 200-day, sell a close under the
//      20-day low; 10% of the money per stock, up to 10.
//   B. Momentum: on the first trading day of each month hold the 20 Nifty 200 stocks with the best 12-month return (skipping
//      the last month), equal weights; keep stocks that stay in the top 20, sell those that drop out.
//   C. Momentum with a safety switch: B, but when the Nifty 50 closed under its 200-day average on rebalance day, hold cash.
//
// Costs 0.15% per side (brokerage, STT, stamp, slippage). Tax (current rules, applied to every year for comparability):
// a sale within 12 months is short-term — 20%; after 12 months long-term — 12.5% on long-term gains above ₹1.25 lakh a year.
// Short-term losses offset either kind; long-term losses only long-term; net losses carry forward. Tax is paid from the account
// at each year end; at the end of the 5 years everything is sold and taxed ("cashed out"). Index funds: no tax while held,
// long-term on the gain when sold at the end. Calendar years stand in for Indian financial years. Survivorship: today's index
// members are used, which flatters every strategy — an upper bound.
import fs from 'node:fs';

const STAKE = 1000000, COST = 0.0015, ST = 0.20, LT = 0.125, LT_FREE = 125000;
const MID150 = '360ONE,AIAENG,APLAPOLLO,AUBANK,ABBOTINDIA,ATGL,ABCAPITAL,AJANTPHARM,ALKEM,ANTHEM,APARINDS,ASHOKLEY,ASTERDM,ASTRAL,AUROPHARMA,AIIL,BAJAJHFL,BALKRISIND,BANKINDIA,MAHABANK,BERGEPAINT,BDL,BHARATFORG,BHEL,BHARTIHEXA,GROWW,BIOCON,BLUESTARCO,CRISIL,COCHINSHIP,COFORGE,COLPAL,CONCOR,COROMANDEL,DABUR,DALBHARAT,DIXON,EMBASSY,ENDURANCE,ESCORTS,EXIDEIND,NYKAA,FEDERALBNK,FACT,FORTIS,GVT&D,GMRAIRPORT,GICRE,GLAXO,GLENMARK,MEDANTA,GODFRYPHLP,GODREJIND,GODREJPROP,FLUOROCHEM,HDBFS,HAVELLS,HEROMOTOCO,HEXT,HINDCOPPER,HINDPETRO,HUDCO,ICICILIFE,ICICIGI,ICICIAMC,IDFCFIRSTB,ITCHOTELS,INDIANB,INDHOTEL,IOB,IRCTC,IREDA,INDUSTOWER,INDUSINDBK,NAUKRI,IPCALAB,JKCEMENT,JSWENERGY,JSWINFRA,JSL,JUBLFOOD,KPRMILL,KEI,KALYANKJIL,LTF,LTTS,LGEINDIA,LICHSGFIN,LAURUSLABS,LENSKART,LICI,LINDEINDIA,LLOYDSME,LODHA,LUPIN,MRF,M&MFIN,MANKIND,MARICO,MFSL,MEESHO,MOTILALOFS,MPHASIS,MCX,NHPC,NLCINDIA,NMDC,NTPCGREEN,NH,NATIONALUM,NAM-INDIA,OBEROIRLTY,OIL,PAYTM,OFSS,POLICYBZR,PIIND,PAGEIND,PATANJALI,PERSISTENT,PETRONET,PHOENIXLTD,PIRAMALFIN,PREMIERENE,PRESTIGE,RECLTD,RADICO,RVNL,SBICARD,SRF,SCHAEFFLER,SHREECEM,SAIL,SUNDARMFIN,SUPREMEIND,SUZLON,SWIGGY,TATACOMM,TATAINVEST,THERMAX,TORNTPOWER,TIINDIA,UNOMINDA,UPL,UBL,UNITDSPR,VMM,VOLTAS,WAAREEENER,YESBANK'.split(',');
const N200 = '360ONE,ABB,APLAPOLLO,AUBANK,ADANIENSOL,ADANIENT,ADANIGREEN,ADANIPORTS,ADANIPOWER,ATGL,ABCAPITAL,AMBUJACEM,APARINDS,APOLLOHOSP,ASHOKLEY,ASIANPAINT,ASTRAL,AUROPHARMA,DMART,AXISBANK,BSE,BAJAJ-AUTO,BAJFINANCE,BAJAJFINSV,BAJAJHLDNG,BANKBARODA,BANKINDIA,MAHABANK,BDL,BEL,BHARATFORG,BHEL,BPCL,BHARTIARTL,GROWW,BIOCON,BLUESTARCO,BOSCHLTD,BRITANNIA,CGPOWER,CANBK,CHOLAFIN,CIPLA,COALINDIA,COCHINSHIP,COFORGE,COLPAL,CONCOR,CUMMINSIND,DLF,DABUR,DIVISLAB,DIXON,DRREDDY,EICHERMOT,ETERNAL,EXIDEIND,NYKAA,FEDERALBNK,FORTIS,GAIL,GVT&D,GMRAIRPORT,GLENMARK,GODFRYPHLP,GODREJCP,GODREJPROP,GRASIM,HCLTECH,HDFCAMC,HDFCBANK,HDFCLIFE,HAVELLS,HEROMOTOCO,HINDALCO,HAL,HINDCOPPER,HINDPETRO,HINDUNILVR,HINDZINC,POWERINDIA,HYUNDAI,ICICIBANK,ICICIGI,ICICIAMC,IDFCFIRSTB,ITC,INDIANB,INDHOTEL,IOC,IRCTC,IRFC,IREDA,INDUSTOWER,INDUSINDBK,NAUKRI,INFY,INDIGO,JSWENERGY,JSWSTEEL,JINDALSTEL,JIOFIN,JUBLFOOD,KEI,KALYANKJIL,KOTAKBANK,LTF,LGEINDIA,LICHSGFIN,LTM,LT,LAURUSLABS,LENSKART,LICI,LODHA,LUPIN,MRF,M&MFIN,M&M,MANKIND,MARICO,MARUTI,MFSL,MAXHEALTH,MAZDOCK,MEESHO,MOTILALOFS,MPHASIS,MCX,MUTHOOTFIN,NHPC,NLCINDIA,NMDC,NTPC,NATIONALUM,NESTLEIND,OBEROIRLTY,ONGC,OIL,PAYTM,OFSS,POLICYBZR,PIIND,PAGEIND,PATANJALI,PERSISTENT,PHOENIXLTD,PIDILITIND,POLYCAB,PFC,POWERGRID,PREMIERENE,PRESTIGE,PNB,RECLTD,RADICO,RVNL,RELIANCE,SBICARD,SBILIFE,SRF,MOTHERSON,SHRIRAMFIN,ENRIN,SIEMENS,SOLARINDS,SBIN,SAIL,SUNPHARMA,SUPREMEIND,SUZLON,SWIGGY,TVSMOTOR,TATACAP,TATACOMM,TCS,TATACONSUM,TMCV,TMPV,TATAPOWER,TATASTEEL,TECHM,TITAN,TORNTPHARM,TRENT,TIINDIA,UPL,ULTRACEMCO,UNIONBANK,UNITDSPR,VBL,VAML,VEDL,VMM,IDEA,VOLTAS,WAAREEENER,WIPRO,YESBANK,ZYDUSLIFE'.split(',');
const FUNDS = [['nifty50', 'Nifty 50 index fund', 118482], ['mid150', 'Nifty Midcap 150 index fund', 147622], ['mom30', 'Nifty 200 Momentum 30 index fund (UTI)', 148703]];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function pull(sym) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=7y&interval=1d`, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const res = (await r.json()).chart.result[0], q = res.indicators.quote[0], out = [];
  res.timestamp.forEach((t, i) => { if (q.close[i] != null && q.low[i] != null && q.open[i] != null) out.push({ d: new Date(t * 1000 + 5.5 * 3600e3).toISOString().slice(0, 10), o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i] }); });
  return out;
}
async function pullMf(code) {
  const r = await fetch(`https://api.mfapi.in/mf/${code}`); if (!r.ok) throw new Error('HTTP ' + r.status);
  return ((await r.json()).data || []).map(x => { const [dd, mm, yy] = x.date.split('-'); return { d: `${yy}-${mm}-${dd}`, c: +x.nav }; }).filter(x => x.c > 0).sort((a, b) => a.d < b.d ? -1 : 1);
}
const sma = (C, n, i) => { if (i < n - 1) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += C[k]; return s / n; };

// ---- the portfolio engine with lot-level Indian tax ----
function run(o) { const pre = runOnce({ ...o, noTax: true }), post = runOnce(o);
  // before-tax figures from an identical run with no tax; after-tax from the taxed run
  for (const y of Object.keys(post.years)) post.years[y].pre = pre.years[y] ? pre.years[y].after : null;
  return { ...post, preTaxEnd: pre.afterEnd, maxDDPre: pre.maxDD };
}
function runOnce({ data, cal, from, kind, pos = 0.10, maxPos = 10, top = 20, safe = false, nifty, noTax = false }) {
  const days = cal.filter(d => d >= from);
  let cash = STAKE; const lots = {};                                      // sym -> [{ sh, cost (per share, incl. buying cost), d }]
  const yr = {}, Y = d => d.slice(0, 4); let carrySt = 0, carryLt = 0, trades = 0, wins = 0;   // carried-forward losses, kept apart: an LT loss may only offset LT gains
  const book = (d, gain, held) => { const y = Y(d); const b = yr[y] = yr[y] || { st: 0, lt: 0, tax: 0 }; if (held > 365) b.lt += gain; else b.st += gain; trades++; if (gain > 0) wins++; };
  const sell = (sym, px, d) => { for (const l of lots[sym] || []) { const pr = l.sh * px * (1 - COST); cash += pr; book(d, pr - l.sh * l.cost, (Date.parse(d) - Date.parse(l.d)) / 864e5); } delete lots[sym]; };
  const buy = (sym, px, d, money) => { const sh = Math.floor(money / (px * (1 + COST))); if (sh < 1) return false; cash -= sh * px * (1 + COST); (lots[sym] = lots[sym] || []).push({ sh, cost: px * (1 + COST), d }); return true; };
  const value = (i, field = 'c') => cash + Object.entries(lots).reduce((t, [s, L]) => { const D = data[s], j = D.idx[days[i]] ?? D.lastIdx(days[i]); return t + L.reduce((u, l) => u + l.sh * (j != null ? D.B[j][field] : l.cost), 0); }, 0);
  const taxYear = y => {                                                   // Indian set-off: ST loss vs ST then LT; LT loss vs LT only; carry the rest
    const b = yr[y] || { st: 0, lt: 0 }; let st = b.st, lt = b.lt;
    if (carrySt < 0) { const u = Math.min(-carrySt, Math.max(0, st)); st -= u; carrySt += u; const u2 = Math.min(-carrySt, Math.max(0, lt)); lt -= u2; carrySt += u2; }   // ST losses: against ST, then LT
    if (carryLt < 0) { const u = Math.min(-carryLt, Math.max(0, lt)); lt -= u; carryLt += u; }                                                                  // LT losses: against LT only
    if (st < 0) { const u = Math.min(-st, Math.max(0, lt)); lt -= u; st += u; }                                                                                  // this year's ST loss vs this year's LT gain
    const tax = noTax ? 0 : ST * Math.max(0, st) + LT * Math.max(0, lt - LT_FREE);
    carrySt += Math.min(0, st); carryLt += Math.min(0, lt);
    (yr[y] = yr[y] || { st: 0, lt: 0 }).tax = tax; cash -= tax; return tax;
  };
  const curve = [], yearEnd = {}; let peak = STAKE, maxDD = 0;
  for (let t = 1; t < days.length; t++) {
    const d = days[t], prev = days[t - 1];
    if (Y(d) !== Y(prev)) { taxYear(Y(prev)); yearEnd[Y(prev)] = value(t - 1); }
    const month = d.slice(0, 7) !== prev.slice(0, 7);
    if (kind === 'breakout') {
      for (const sym of Object.keys(lots)) { const D = data[sym], j = D.idx[d]; if (j == null || j < 21) continue; let lo = 1e18; for (let k = j - 20; k < j; k++) lo = Math.min(lo, D.B[k].l); if (D.B[j].c < lo) sell(sym, D.B[j].c, d); }
      const eq = value(t - 1), cands = [];
      for (const [sym, D] of Object.entries(data)) { if (lots[sym]) continue; const i = D.idx[prev], j = D.idx[d]; if (i == null || j == null || i < 210) continue; const C = D.C, s200 = sma(C, 200, i); let hi = -1; for (let k = i - 50; k < i; k++) hi = Math.max(hi, C[k]); if (s200 && C[i] > s200 && C[i] > hi) cands.push({ sym, j, rank: C[i] / s200 }); }
      cands.sort((a, b) => b.rank - a.rank);
      for (const c of cands) { if (Object.keys(lots).length >= maxPos) break; const money = Math.min(eq * pos, cash); if (money < eq * pos * 0.5) break; buy(c.sym, data[c.sym].B[c.j].o, d, money); }
    } else if (month) {
      // monthly momentum rebalance at the open, decided on the previous close
      const ni = nifty.idx[prev], off = safe && ni != null && ni >= 199 && nifty.C[ni] < sma(nifty.C, 200, ni);
      const ranked = off ? [] : Object.entries(data).map(([sym, D]) => { const i = D.idx[prev]; if (i == null || i < 260 || D.idx[d] == null) return null; return { sym, s: D.C[i - 21] / D.C[i - 252] - 1 }; }).filter(Boolean).sort((a, b) => b.s - a.s).slice(0, top);
      const want = new Set(ranked.map(x => x.sym));
      for (const sym of Object.keys(lots)) if (!want.has(sym)) { const D = data[sym], j = D.idx[d] ?? D.lastIdx(d); if (j != null) sell(sym, D.B[j].o, d); }
      const eq = value(t - 1, 'c'), slot = eq / Math.max(1, top);
      for (const x of ranked) if (!lots[x.sym]) { const D = data[x.sym]; buy(x.sym, D.B[D.idx[d]].o, d, Math.min(slot, cash)); }
    }
    const v = value(t); curve.push([d, v]); peak = Math.max(peak, v); maxDD = Math.max(maxDD, 1 - v / peak);
  }
  const last = days[days.length - 1], ly = Y(last);
  const preTaxEnd = value(days.length - 1);
  for (const sym of Object.keys(lots)) { const D = data[sym], j = D.idx[last] ?? D.lastIdx(last); if (j != null) sell(sym, D.B[j].c, last); }    // cash out at the end
  taxYear(ly); yearEnd[ly] = cash;
  return report({ curve, yearEnd, yr, preTaxEnd, afterEnd: cash, maxDD, trades, wins, from: days[0], to: last });
}
function report({ curve, yearEnd, yr, preTaxEnd, afterEnd, maxDD, trades, wins, from, to }) {
  // per calendar year: before tax (mark-to-market) and after tax (what the account kept, tax paid at year end)
  const years = {}; let prevAfter = STAKE;
  const preAtYearEnd = {}; for (const [d, v] of curve) preAtYearEnd[d.slice(0, 4)] = v;
  const ys = Object.keys(yearEnd).sort();
  for (const y of ys) {
    const b = yr[y] || { tax: 0 }, endAfter = yearEnd[y], endPre = endAfter + (b.tax || 0);
    years[y] = { pre: Math.round((endPre / prevAfter - 1) * 1000) / 10, after: Math.round((endAfter / prevAfter - 1) * 1000) / 10, tax: Math.round(b.tax || 0) };
    prevAfter = endAfter;
  }
  return { from, to, preTaxEnd: Math.round(preTaxEnd), afterEnd: Math.round(afterEnd), maxDD: Math.round(maxDD * 1000) / 10, trades, winRate: trades ? Math.round(wins / trades * 1000) / 10 : 0, years, taxPaid: Math.round(Object.values(yr).reduce((t, b) => t + (b.tax || 0), 0)) };
}

// ---- data ----
const nB = await pull('^NSEI'), cal = nB.map(b => b.d), nifty = { C: nB.map(b => b.c), idx: Object.fromEntries(nB.map((b, i) => [b.d, i])) };
const last = cal[cal.length - 1], from = new Date(Date.parse(last) - 5 * 365.25 * 864e5).toISOString().slice(0, 10);
async function load(list) {
  const data = {}; let skipped = 0;
  for (const s of list) {
    try { const B = await pull(s + '.NS'); if (B.length < 60) { skipped++; continue; } const D = { B, C: B.map(b => b.c), idx: Object.fromEntries(B.map((b, i) => [b.d, i])) }; D.lastIdx = d => { let lo = 0, hi = B.length - 1, r = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (B[m].d <= d) { r = m; lo = m + 1; } else hi = m - 1; } return r; }; data[s] = D; }
    catch (e) { skipped++; }
    await sleep(200);
  }
  return { data, skipped };
}
const mid = await load(MID150);
const n200extra = await load(N200.filter(s => !mid.data[s]));
const n200 = { data: Object.fromEntries(N200.map(s => [s, mid.data[s] || n200extra.data[s]]).filter(([, D]) => D)) };
console.log('loaded', Object.keys(mid.data).length, 'midcaps,', Object.keys(n200.data).length, 'Nifty 200 stocks');

const out = { at: new Date().toISOString(), from, to: last, stake: STAKE, rules: { cost: COST, stcg: ST, ltcg: LT, ltFree: LT_FREE }, loaded: { mid150: Object.keys(mid.data).length, nifty200: Object.keys(n200.data).length }, results: [] };
out.results.push({ key: 'breakoutMid', label: 'A · Trend breakout on Midcap 150 stocks', ...run({ data: mid.data, cal, from, kind: 'breakout', nifty }) });
out.results.push({ key: 'momentum', label: 'B · Monthly momentum, top 20 of Nifty 200', ...run({ data: n200.data, cal, from, kind: 'momentum', nifty }) });
out.results.push({ key: 'momentumSafe', label: 'C · Momentum + safety switch (cash when Nifty < 200-day)', ...run({ data: n200.data, cal, from, kind: 'momentum', safe: true, nifty }) });
// the current India bot (from research-in.json): short holds → every year's net gain taxed short-term at 20%
try {
  const h = JSON.parse(fs.readFileSync('bot/research-in.json', 'utf8')).history5, b = h && h.series.find(x => x.key === 'bot');
  if (b) { let v = STAKE, carry = 0; const years = {}; for (const y of Object.keys(b.years).sort()) { const g = v * b.years[y] / 100, n = g + carry; let tax = 0; if (n > 0) { tax = n * ST; carry = 0; } else carry = n; const nv = v + g - tax; years[y] = { pre: b.years[y], after: Math.round((nv / v - 1) * 1000) / 10, tax: Math.round(tax) }; v = nv; }
    out.results.push({ key: 'currentBot', label: 'Current India bot (breakout + RSI-2 on Nifty 100, 50/50)', preTaxEnd: Math.round(STAKE * (1 + b.total / 100)), afterEnd: Math.round(v), maxDD: b.maxDD, trades: b.trades, years, approx: true }); }
} catch (e) { console.log('current bot skipped', e.message); }
// index funds: no tax while held; long-term tax on the gain when sold at the end
for (const [key, label, code] of FUNDS) {
  try {
    const B = await pullMf(code), at = d => { let r = null; for (const x of B) { if (x.d <= d) r = x; else break; } return r; };
    const s0 = at(from), e = at(last); if (!s0 || s0.d < new Date(Date.parse(from) - 10 * 864e5).toISOString().slice(0, 10)) throw new Error('history starts too late');
    const years = {}; let pv = s0.c; const ys = [...new Set(cal.filter(d => d >= from).map(d => d.slice(0, 4)))];
    for (const y of ys) { const ye = at(y === last.slice(0, 4) ? last : y + '-12-31'); years[y] = { pre: Math.round((ye.c / pv - 1) * 1000) / 10 }; pv = ye.c; }
    const pre = STAKE * e.c / s0.c, tax = LT * Math.max(0, pre - STAKE - LT_FREE);
    years[last.slice(0, 4)].after = Math.round(((pre - tax) / (pre / (1 + years[last.slice(0, 4)].pre / 100)) - 1) * 1000) / 10;
    for (const y of ys) if (years[y].after == null) years[y].after = years[y].pre;
    years[last.slice(0, 4)].tax = Math.round(tax);
    let peak = 0, dd = 0; for (const x of B) if (x.d >= from) { peak = Math.max(peak, x.c); dd = Math.max(dd, 1 - x.c / peak); }
    out.results.push({ key, label, fund: true, preTaxEnd: Math.round(pre), afterEnd: Math.round(pre - tax), maxDD: Math.round(dd * 1000) / 10, years });
  } catch (e) { console.log('fund skipped', key, e.message); }
}
fs.writeFileSync('bot/research-in-ideas.json', JSON.stringify(out, null, 1));
const inr = v => '₹' + Math.round(v).toLocaleString('en-IN');
const ys = [...new Set(out.results.flatMap(r => Object.keys(r.years)))].sort();
let md = `# India — three bot ideas vs the funds, after tax (${from} → ${last})\n\n₹10 lakh at the start. Costs 0.15%/side. Tax: short-term 20% (held ≤ 12 months), long-term 12.5% above ₹1.25 lakh a year; funds taxed only when sold at the end. Today's index members (flatters the strategies).\n\n| Strategy | Before tax | After tax (cashed out) | Worst fall | Trades | ${ys.map(y => y + ' before / after').join(' | ')} |\n|---|---|---|---|---|${ys.map(() => '---').join('|')}|\n`;
for (const r of out.results) md += `| ${r.label} | ${inr(r.preTaxEnd)} | **${inr(r.afterEnd)}** | −${r.maxDD}% | ${r.trades ?? '–'} | ${ys.map(y => r.years[y] ? `${r.years[y].pre}% / ${r.years[y].after}%` : '–').join(' | ')} |\n`;
fs.writeFileSync('bot/research_in_ideas.md', md);
console.log(md);
