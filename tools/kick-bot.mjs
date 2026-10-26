// Makes sure a trading session is running or queued on a weekday market morning/day, without relying on GitHub's
// schedule (which can skip or delay runs by an hour or more). Called from refresh.yml and watchdog.yml.
//   node tools/kick-bot.mjs            → starts paper-trade-bot if none is running/queued and the US market day is not over
// Needs GITHUB_TOKEN (actions: write) and GITHUB_REPOSITORY. Starting a session never trades by itself: the session
// follows the bot's own rules, settings and Pause switch.
const repo = process.env.GITHUB_REPOSITORY, tok = process.env.GITHUB_TOKEN;
if (!repo || !tok) { console.log('kick-bot: no repository token — skipped'); process.exit(0); }
const et = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).map(p => [p.type, p.value]));
const mins = (+et.hour % 24) * 60 + +et.minute;
if (['Sat', 'Sun'].includes(et.weekday) || mins < 6 * 60 || mins >= 15 * 60 + 50) { console.log(`kick-bot: ${et.weekday} ${et.hour}:${et.minute} ET — outside the window, nothing to do`); process.exit(0); }
const gh = async (path, opt = {}) => {
  const r = await fetch('https://api.github.com/repos/' + repo + path, { ...opt, headers: { authorization: 'Bearer ' + tok, accept: 'application/vnd.github+json', 'content-type': 'application/json' } });
  if (!r.ok && r.status !== 204) throw new Error(path.split('?')[0] + ' HTTP ' + r.status);
  return r.status === 204 ? null : r.json();
};
// a holiday? ask the broker's calendar when paper keys are available; otherwise the session itself exits on a closed day
if (process.env.ALPACA_KEY && process.env.ALPACA_SECRET) {
  try {
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    const cal = await (await fetch(`https://paper-api.alpaca.markets/v2/calendar?start=${d}&end=${d}`, { headers: { 'APCA-API-KEY-ID': process.env.ALPACA_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET } })).json();
    if (Array.isArray(cal) && !cal.some(c => c.date === d)) { console.log('kick-bot: market closed today (holiday) — nothing to do'); process.exit(0); }
    const c = Array.isArray(cal) && cal[0]; if (c && c.close) { const [h, m] = c.close.split(':').map(Number); if (mins >= h * 60 + m - 10) { console.log('kick-bot: the session is over for today'); process.exit(0); } }
  } catch (e) { console.log('kick-bot: calendar check failed (' + e.message + ') — continuing'); }
}
const busy = async status => ((await gh(`/actions/workflows/trade.yml/runs?status=${status}&per_page=5`)).workflow_runs || []).length;
const running = await busy('in_progress'), queued = await busy('queued') + await busy('waiting') + await busy('pending');
if (running || queued) { console.log(`kick-bot: a session is already ${running ? 'running' : 'queued'} — nothing to do`); process.exit(0); }
await gh('/actions/workflows/trade.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
console.log(`kick-bot: no session was running at ${et.hour}:${et.minute} ET — started paper-trade-bot`);
