// Runs the bot continuously for the whole session: a cheap check every second,
// a full decision cycle every 15 seconds (or instantly when the check sees something).
// Started by GitHub Actions; each job lives up to ~5h50m and the next queued job takes over.
import { execSync } from 'node:child_process';
import { HAVE_KEYS, botCycle, fastCheck, setNow, clockInfo } from './bot.mjs';

if (!HAVE_KEYS) { console.log('No Alpaca keys configured - nothing to do.'); process.exit(0); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LIFE = (+process.env.RUN_MINUTES || 350) * 60000, born = Date.now();
const FULL_EVERY = 20000, MIN_GAP = 1200, JOURNAL_EVERY = 120000, COMMIT_EVERY = 10 * 60000;
let lastFull = 0, lastJournal = 0, lastCommit = Date.now(), errors = 0, pending = false;

function commit() {
  if (process.env.BOT_NO_COMMIT === '1') return;
  try {
    execSync('git add bot/journal.json && (git diff --cached --quiet || (git commit -q -m "Bot journal" && (git push -q || (git pull -q --rebase -X theirs origin main && git push -q))))', { stdio: 'inherit', shell: '/bin/bash' });
  } catch (e) { console.log('commit skipped:', e.message.split('\n')[0]); }
}

const m0 = setNow();
if (m0 < 9 * 60 + 20 || m0 >= 16 * 60 + 5) { console.log('Outside 9:20-16:05 ET - next scheduled run will take over.'); process.exit(0); }

while (Date.now() - born < LIFE) {
  const mins = setNow();
  if (mins >= 16 * 60 + 5) break;
  const now = Date.now();
  let why = pending || (now - lastFull >= FULL_EVERY ? 'scheduled' : false);
  if (!why) { try { why = await fastCheck(); errors = 0; } catch (e) { errors++; console.log('check error', e.message); if (errors > 20) await sleep(10000); } }
  if (why && now - lastFull < MIN_GAP) { pending = why; await sleep(250); continue; }   // too soon: keep the alert, act a moment later
  pending = false;
  if (why) {
    if (why !== 'scheduled') console.log('⚡', why);
    const r = await botCycle({ journal: now - lastJournal >= JOURNAL_EVERY });
    if (now - lastJournal >= JOURNAL_EVERY) lastJournal = now;
    lastFull = Date.now();
    const ck = clockInfo();
    if (!r.open && ck && !ck.is_open) { console.log('Market is closed - stopping.'); break; }
  }
  if (Date.now() - lastCommit >= COMMIT_EVERY) { commit(); lastCommit = Date.now(); }
  await sleep(1000);
}
await botCycle({ journal: true });
commit();
console.log('Session runner finished.');
