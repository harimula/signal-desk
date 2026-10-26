// Pre-flight check, safe to run any time (also on weekends): connects to everything the trading session needs and
// reports OK / FAIL for each, without placing, changing or cancelling anything. Run by .github/workflows/stream-check.yml.
//   1. broker account and clock (trading host)          4. live stock prices stream (sign-in)
//   2. SPY option contracts for the next trading day     5. options price stream (MessagePack sign-in)
//   3. trade-updates stream (sign-in)                    6. the page's Pause file is readable through the GitHub API
// Prints statuses only — never keys, balances or account numbers.
import { encode, decode } from '../bot/msgpack.mjs';
const KEY = process.env.ALPACA_KEY, SECRET = process.env.ALPACA_SECRET;
const TRADING = 'https://paper-api.alpaca.markets', H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET };
const results = [];
const report = (name, ok, note = '') => { results.push(ok); console.log(`${ok ? 'OK  ' : 'FAIL'}  ${name}${note ? ' — ' + note : ''}`); };
const get = async url => { const r = await fetch(url, { headers: H }); return { status: r.status, j: await r.json().catch(() => null) }; };

if (!KEY || !SECRET) { console.log('FAIL  no paper keys in the secrets'); process.exit(1); }
console.log('Node', process.version, '· WebSocket', typeof WebSocket === 'undefined' ? 'MISSING' : 'available');
report('Node has a built-in WebSocket (needs 22+)', typeof WebSocket !== 'undefined');

try { const a = await get(TRADING + '/v2/account'); report('broker account (paper)', a.status === 200 && a.j && a.j.status === 'ACTIVE', 'HTTP ' + a.status + (a.j && a.j.status ? ', ' + a.j.status : '')); } catch (e) { report('broker account (paper)', false, e.message); }
try { const c = await get(TRADING + '/v2/clock'); report('market clock', c.status === 200 && c.j && 'is_open' in c.j, c.j ? 'market ' + (c.j.is_open ? 'open' : 'closed') + ', next open ' + c.j.next_open : 'HTTP ' + c.status); } catch (e) { report('market clock', false, e.message); }
try {
  const from = new Date(Date.now() + 864e5).toISOString().slice(0, 10), to = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
  const o = await get(`${TRADING}/v2/options/contracts?underlying_symbols=SPY&expiration_date_gte=${from}&expiration_date_lte=${to}&limit=100`);
  const n = (o.j && o.j.option_contracts || []).length;
  report('SPY option contracts, next days', o.status === 200 && n > 0, `HTTP ${o.status}, ${n} contracts listed`);
} catch (e) { report('SPY option contracts, next days', false, e.message); }

function wsCheck(name, url, { msgpack = false } = {}) {
  return new Promise(resolve => {
    if (typeof WebSocket === 'undefined') { report(name, false, 'no WebSocket'); return resolve(); }
    let done = false, ws;
    const finish = (ok, note) => { if (done) return; done = true; report(name, ok, note); try { ws.close(); } catch (e) {} resolve(); };
    const t = setTimeout(() => finish(false, 'no sign-in answer within 15 s'), 15000);
    try { ws = msgpack ? new WebSocket(url, { headers: { 'Content-Type': 'application/msgpack' } }) : new WebSocket(url); } catch (e) { clearTimeout(t); return finish(false, 'cannot open: ' + e.message); }
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { const auth = { action: 'auth', key: KEY, secret: SECRET }; ws.send(msgpack ? encode(auth) : JSON.stringify(auth)); };
    ws.onmessage = ev => {
      let m; try { const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data); m = msgpack ? decode(raw) : JSON.parse(typeof raw === 'string' ? raw : raw.toString()); } catch (e) { return; }
      for (const x of Array.isArray(m) ? m : [m]) {
        if (x && x.stream === 'authorization') { clearTimeout(t); return finish(x.data && x.data.status === 'authorized', 'sign-in ' + (x.data && x.data.status)); }
        if (x && x.T === 'success' && x.msg === 'authenticated') { clearTimeout(t); return finish(true, 'signed in'); }
        if (x && x.T === 'error') { clearTimeout(t); return finish(false, `error ${x.code} ${x.msg}`); }
      }
    };
    ws.onerror = e => { clearTimeout(t); finish(false, 'error ' + ((e && e.message) || '')); };
  });
}
await wsCheck('trade-updates stream (fills arrive instantly)', TRADING.replace(/^http/, 'ws') + '/stream');
await wsCheck('stock prices stream (IEX)', 'wss://stream.data.alpaca.markets/v2/iex');
// how many symbols the plan's stock stream accepts (the bot asks for at most 30; more is refused outright)
const syms = ['SPY','AAPL','MSFT','NVDA','AMZN','META','GOOGL','TSLA','AMD','INTC','KO','PEP','WMT','JPM','BAC','XOM','CVX','DIS','NFLX','ORCL','CSCO','QCOM','ADBE','CRM','PLTR','UBER','F','GM','T','VZ','PFE','MRK','ABBV','LLY','UNH','HD','LOW','COST','MCD','NKE'];
const tryN = n => new Promise(res => { const ws = new WebSocket('wss://stream.data.alpaca.markets/v2/iex'); let out = 'no answer'; const t = setTimeout(() => { ws.close(); res(out); }, 8000);
  ws.onopen = () => ws.send(JSON.stringify({ action: 'auth', key: KEY, secret: SECRET }));
  ws.onmessage = ev => { for (const m of JSON.parse(ev.data)) { if (m.T === 'success' && m.msg === 'authenticated') ws.send(JSON.stringify({ action: 'subscribe', trades: syms.slice(0, n) })); else if (m.T === 'subscription') { out = 'accepted ' + (m.trades || []).length; clearTimeout(t); ws.close(); res(out); } else if (m.T === 'error') { out = `error ${m.code} ${m.msg}`; clearTimeout(t); ws.close(); res(out); } } }; });
const r30 = await tryN(30); await new Promise(r => setTimeout(r, 1500)); const r40 = await tryN(40);
console.log(`::notice title=stream-limit::30 symbols → ${r30} | 40 symbols → ${r40}`);
if (/406/.test(r30)) console.log('skip  symbol-limit probe — a trading session holds the plan\'s one stream connection'); else report('stock prices stream accepts the 30 symbols the bot asks for', /^accepted/.test(r30), r30 + ' (40 → ' + r40 + ')');

await wsCheck('options prices stream (SPY exits)', 'wss://stream.data.alpaca.markets/v1beta1/indicative', { msgpack: true });

const repo = process.env.GITHUB_REPOSITORY, tok = process.env.GITHUB_TOKEN;
if (repo && tok) {
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/contents/bot/STOP?ref=main`, { headers: { authorization: 'Bearer ' + tok, accept: 'application/vnd.github+json' } });
    report('Pause switch readable by a running session', r.status === 404 || r.status === 200, r.status === 404 ? 'not paused' : r.status === 200 ? 'PAUSED (bot/STOP is set)' : 'HTTP ' + r.status);
  } catch (e) { report('Pause switch readable by a running session', false, e.message); }
} else console.log('skip  Pause switch check (runs only on GitHub)');

const bad = results.filter(x => !x).length;
console.log(bad ? `\n${bad} check(s) FAILED` : '\nall pre-flight checks passed');
process.exit(bad ? 1 : 0);
