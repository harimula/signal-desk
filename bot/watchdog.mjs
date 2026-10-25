// Dead-man's switch, run by GitHub Actions every 15 minutes during US market hours (watchdog.yml).
// Reads the public journal (its timestamp is readable even when the journal is encrypted) and alerts the phone
// when the bot has not checked in for too long while the market is open. Needs TELEGRAM_TOKEN + TELEGRAM_CHAT.
const SITE = process.env.SITE_URL || (process.env.GITHUB_REPOSITORY ? `https://${process.env.GITHUB_REPOSITORY.split('/')[0].toLowerCase()}.github.io/${process.env.GITHUB_REPOSITORY.split('/')[1]}/` : '');
const MAX_MIN = +(process.env.WATCHDOG_MAX_MIN || 25);
const KEY = process.env.ALPACA_KEY, SECRET = process.env.ALPACA_SECRET;
const et = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).map(p => [p.type, p.value]));
const mins = (+et.hour % 24) * 60 + +et.minute;
if (['Sat', 'Sun'].includes(et.weekday) || mins < 9 * 60 + 40 || mins > 16 * 60) { console.log('outside market hours — nothing to check'); process.exit(0); }
// market holiday? ask the broker's clock (paper keys are enough); if that fails, assume open
if (KEY && SECRET) { try { const c = await (await fetch('https://paper-api.alpaca.markets/v2/clock', { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SECRET } })).json(); if (c && c.is_open === false) { console.log('market closed today — nothing to check'); process.exit(0); } } catch (e) {} }
// the workflow checks out the latest commit, so the journal on disk is newer than the published site (Pages lags minutes)
let j = null;
try { j = JSON.parse((await import('node:fs')).readFileSync('bot/journal.json', 'utf8')); } catch (e) {}
if (!j || !j.at) { const r = await fetch(SITE + 'bot/journal.json?t=' + Date.now(), { cache: 'no-store' }); j = r.ok ? await r.json() : null; }
const ageMin = j && j.at ? (Date.now() - Date.parse(j.at)) / 60000 : Infinity;
console.log(`journal age ${isFinite(ageMin) ? Math.round(ageMin) + ' min' : 'unknown'}`);
// a holiday: the bot exits at once ("Market closed") and never writes — tolerate a journal from before today's open
if (ageMin <= MAX_MIN) process.exit(0);
if (isFinite(ageMin) && (ageMin - MAX_MIN) % 60 >= 15) { console.log('already alerted this hour'); process.exit(0); }   // one alert per hour while it stays down
const msg = isFinite(ageMin) ? `⚠️ Bot has not checked in for ${Math.round(ageMin)} minutes during market hours. Open the Actions tab on GitHub: paper-trade-bot may have stopped. Protective stops are at the broker.` : '⚠️ Bot journal unreadable — check the site and the Actions tab.';
console.log(msg);
  if (process.env.TELEGRAM_TOKEN && process.env.TELEGRAM_CHAT) await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_TOKEN.trim()}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT.trim(), text: '\ud83d\udea8 Signal Desk watchdog\n' + msg }) }).catch(() => {});
process.exit(0);
