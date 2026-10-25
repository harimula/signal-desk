// Telegram: alerts to your private chat, and a few read-only commands back (plus pause/resume of NEW entries).
// Needs two GitHub secrets, saved by Bot settings → 1. Connection → "Connect Telegram":
//   TELEGRAM_TOKEN  the bot token from @BotFather            TELEGRAM_CHAT  your chat id (only this chat is ever answered)
// Never trades from chat: a lost phone or a hijacked chat must not be able to buy or sell. The strongest command is /pause.
const API = () => (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '');
const TOKEN = () => String(process.env.TELEGRAM_TOKEN || '').trim();
const CHAT = () => String(process.env.TELEGRAM_CHAT || '').trim();
export const tgOn = () => !!(TOKEN() && CHAT());

// One Telegram API call. Errors never carry the URL (it contains the token).
async function tg(method, body, timeoutMs = 10000) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${API()}/bot${TOKEN()}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: ac.signal });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description || 'HTTP ' + r.status}`);
    return j.result;
  } catch (e) { throw new Error(String(e.name === 'AbortError' ? `telegram ${method}: timed out` : e.message).split(TOKEN()).join('•')); }
  finally { clearTimeout(t); }
}

// Telegram caps a message at 4096 characters: long reports go out in pieces.
export async function tgSend(text) {
  if (!tgOn() || !text) return;
  const parts = []; let s = String(text);
  while (s.length > 3900) { let cut = s.lastIndexOf('\n', 3900); if (cut < 1000) cut = 3900; parts.push(s.slice(0, cut)); s = s.slice(cut); }
  parts.push(s);
  for (const p of parts) await tg('sendMessage', { chat_id: CHAT(), text: p, disable_web_page_preview: true });
}

// Parse "/money", "/money@MyBot", " /Status extra" → { cmd: 'money', args: [] }
export function parseCommand(text) {
  const m = /^\s*\/([a-z_]+)(?:@\w+)?(?:\s+(.*))?$/i.exec(String(text || ''));
  return m ? { cmd: m[1].toLowerCase(), args: (m[2] || '').trim().split(/\s+/).filter(Boolean) } : null;
}

// Read new messages and answer commands from the owner's chat only. `handle(cmd, args)` returns the reply text.
// Messages older than 30 minutes are skipped (a /pause typed last night is not acted on at 9:20 the next morning).
let offset = 0;
export async function tgPoll(handle) {
  if (!tgOn()) return 0;
  const ups = await tg('getUpdates', { offset, timeout: 0, allowed_updates: ['message'] });
  let n = 0;
  for (const u of ups || []) {
    offset = Math.max(offset, u.update_id + 1);
    const m = u.message; if (!m || !m.chat || String(m.chat.id) !== CHAT()) continue;         // anyone else: ignored, never answered
    if (m.date && Date.now() / 1000 - m.date > 30 * 60) continue;
    const c = parseCommand(m.text); if (!c) { await tgSend('Type /help to see what I can tell you.'); continue; }
    let reply;
    try { reply = await handle(c.cmd, c.args); } catch (e) { reply = 'Sorry, that failed: ' + String(e.message || e).slice(0, 160); }
    await tgSend(reply || 'Unknown command. Type /help.'); n++;
  }
  if ((ups || []).length) try { await tg('getUpdates', { offset, limit: 1, timeout: 0, allowed_updates: ['message'] }); } catch (e) {}   // confirm them now, so a restart never answers the same command twice
  return n;
}
export const _resetTg = () => { offset = 0; };          // tests only
