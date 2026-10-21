// Signal Desk paper-trading bot — runs every 5 minutes during US market hours
// via GitHub Actions. Trades an ALPACA PAPER account (fake money, real prices).
// Stateless: every run rebuilds its picture from the broker, so missed runs are safe.
//
// Safety: ALPACA_URL defaults to the paper endpoint. A file named bot/STOP in the
// repo flattens everything and halts. A daily loss cap halts for the day.
import fs from 'node:fs';
import { signalAt, r2d } from './strategy.mjs';

const KEY = process.env.ALPACA_KEY, SECRET = process.env.ALPACA_SECRET;
if (!KEY || !SECRET) { console.log('No Alpaca keys configured - nothing to do.'); process.exit(0); }
const BASE = process.env.ALPACA_URL || 'https://paper-api.alpaca.markets';
const DATA = 'https://data.alpaca.markets';
const BUDGET = +(process.env.BOT_PER_TRADE || 500);        // $ per trade
const MAX_POS = +(process.env.BOT_MAX_POSITIONS || 6);      // concurrent positions
const MAX_ENTRIES = +(process.env.BOT_MAX_ENTRIES_PER_SYM || 2); // re-entries per symbol per day
const LOSS_CAP = +(process.env.BOT_DAILY_LOSS_CAP || 3);    // % of equity, halt for the day
const UNIVERSE = (process.env.BOT_SYMBOLS || 'AAPL,MSFT,NVDA,AMZN,META,GOOGL,TSLA,AMD,JPM,BAC,XOM,CVX,KO,PEP,WMT,HD,DIS,INTC,CSCO,QCOM,ORCL,CRM,ADBE,NFLX,UBER,PLTR,SHOP,COIN,SOFI,F').split(',');
const DRY = process.env.BOT_DRY === '1';

const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET, 'content-type': 'application/json' };
const api = async (path, opt = {}) => {
  const r = await fetch((path.startsWith('/v2/stocks') ? DATA : BASE) + path, { headers: H, ...opt });
  if (!r.ok) throw new Error(path + ' HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
};

// ---- clock & kill switches ----
const clock = await api('/v2/clock');
if (!clock.is_open) { console.log('Market closed.'); process.exit(0); }
const acct = await api('/v2/account');
const equity = +acct.equity, dayStart = +acct.last_equity || equity;
const nowET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
const minsET = nowET.getHours() * 60 + nowET.getMinutes();
const stopAll = fs.existsSync('bot/STOP');
const dailyLossHit = dayStart > 0 && (equity - dayStart) / dayStart * 100 <= -LOSS_CAP;
const eod = minsET >= 15 * 60 + 45; // 3:45pm ET: flatten, stop entering

async function flattenAll(why) {
  console.log('FLATTEN:', why);
  if (DRY) return;
  await api('/v2/orders', { method: 'DELETE' });
  await api('/v2/positions?cancel_orders=true', { method: 'DELETE' });
}
if (stopAll) { await flattenAll('bot/STOP file present'); process.exit(0); }
if (dailyLossHit) { await flattenAll('daily loss cap ' + LOSS_CAP + '% hit'); process.exit(0); }
if (eod) { await flattenAll('end of day - day trades do not sleep overnight'); process.exit(0); }
if (minsET < 9 * 60 + 45) { console.log('First 15 min - standing aside.'); process.exit(0); }

// ---- current state ----
const positions = await api('/v2/positions');
const openOrders = await api('/v2/orders?status=open&limit=200');
const todayISO = nowET.toISOString().slice(0, 10);
const closed = await api('/v2/orders?status=closed&limit=200&after=' + todayISO + 'T00:00:00-04:00');
const entriesToday = {};
closed.concat(openOrders).forEach(o => { if (o.side === 'buy') entriesToday[o.symbol] = (entriesToday[o.symbol] || 0) + 1; });
const busy = new Set(positions.map(p => p.symbol).concat(openOrders.map(o => o.symbol)));
console.log(`Equity $${equity} | positions ${positions.length} | open orders ${openOrders.length}`);

// ---- signals from daily bars (free IEX feed) ----
const end = new Date().toISOString();
const bars = await api(`/v2/stocks/bars?symbols=${UNIVERSE.join(',')}&timeframe=1Day&limit=60&adjustment=split&feed=iex&end=${end}&start=2000-01-01T00:00:00Z&sort=asc`);
let room = MAX_POS - busy.size;
const plans = [];
for (const sym of UNIVERSE) {
  const bs = (bars.bars && bars.bars[sym]) || [];
  if (bs.length < 25) continue;
  const B = bs.map(b => ({ o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  // last completed session: drop today's partial bar if present
  const lastDay = bs[bs.length - 1].t.slice(0, 10);
  if (lastDay === todayISO) B.pop();
  const closes = B.map(b => b.c);
  const sig = signalAt(B, closes, B.length - 1);
  if (!sig) continue;
  if (busy.has(sym)) continue;
  if ((entriesToday[sym] || 0) >= MAX_ENTRIES) continue;
  plans.push({ sym, ...sig });
}
plans.sort((a, b) => (b.strong - a.strong) || (a.r2 - b.r2));
for (const pl of plans) {
  if (room <= 0) break;
  const qty = Math.floor(BUDGET / pl.entry);
  if (qty < 1) { console.log(pl.sym, 'skipped - 1 share above per-trade budget'); continue; }
  const order = {
    symbol: pl.sym, qty: String(qty), side: 'buy', type: 'limit', time_in_force: 'day',
    limit_price: String(pl.entry), order_class: 'bracket',
    take_profit: { limit_price: String(pl.target) },
    stop_loss: { stop_price: String(pl.stop) }
  };
  console.log('ORDER', JSON.stringify(order));
  if (!DRY) await api('/v2/orders', { method: 'POST', body: JSON.stringify(order) });
  room--;
}
if (!plans.length) console.log('No setups right now - that is a signal too.');
