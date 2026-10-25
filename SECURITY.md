# Security — what protects what, and what you still have to do

## The short version
- **The page never holds a secret.** Broker keys are sealed in your browser with GitHub's public
  key and stored as repository secrets. Nobody — not the page, not the repo, not GitHub's UI —
  can read them back. Only the workflow run sees them, in memory, for the length of a session.
- **Paper and live are different keys.** `ALPACA_KEY`/`ALPACA_SECRET` are paper-only. Live needs
  `ALPACA_LIVE_KEY`/`ALPACA_LIVE_SECRET` *and* Mode = Live *and* the typed confirmation.
- **Your trades can be private.** Set a `JOURNAL_KEY` secret (a long passphrase) and the bot
  encrypts `bot/journal.json` (AES-256-GCM, key derived with PBKDF2-SHA256 × 600 000) and
  hides tickers, option symbols and every amount in the Actions logs. The page asks for the same passphrase once per
  device and decrypts locally; the passphrase never leaves your browser.
- **Scripts are integrity-pinned.** The third-party code the page loads (libsodium) is pinned by
  hash (SRI); a tampered CDN file is refused. GitHub Actions are pinned to exact commits. (The
  optional Firebase accounts feature is off — `FB_CONFIG = null` — and never receives the GitHub
  token or the passphrase even when switched on.)
- **Price proxies see your tickers.** When the free Yahoo proxies (allorigins, corsproxy) are used
  to fetch prices, they see which symbols you look up — nothing else.

## What the bot cannot do
- Withdraw or transfer money. Alpaca API keys trade; moving cash out needs the Alpaca
  dashboard with your login + 2FA (confirm this in your own account's settings — rules change).
- Trade live by accident. A paper key against the live URL is rejected by Alpaca; the bot also
  refuses live mode without live keys and without the typed phrase.
- Exceed the limits in the control panel: per-trade size, max heat, daily/weekly breakers,
  position caps. Lower them before you go live, not after.

## What is still public (GitHub Pages is a public site)
- The page itself, the stock list, the settings you choose (`bot/config.json`, except keys),
  `live.json` / `news.json`, and — unless `JOURNAL_KEY` is set — the journal with every trade.
- If that is more than you want visible, either set `JOURNAL_KEY` (recommended, 1 minute), or
  make the repo private and switch Pages to private (GitHub Enterprise) / self-host
  (a $4–6/month VPS or Cloudflare Pages behind Access).

## Your checklist (10 minutes, do it before any live key exists)
1. **GitHub:** passkey or authenticator 2FA; no SMS. Repo → Settings → Collaborators: only you.
   *Anyone with write access to this repo can change the bot and therefore trade with your keys.*
2. **Alpaca:** 2FA on; use a dedicated live account funded only with what the bot may risk;
   enable Alpaca's own email/SMS alerts for orders.
3. **Email:** the account that can reset GitHub and Alpaca passwords needs the strongest 2FA of all.
4. **Fine-grained token** (used by the Bot settings tab): scope to this one repo, permissions
   Contents + Secrets + Actions read/write only, expiry ≤ 90 days, and only on devices you own.
   Revoke it at github.com/settings/tokens if a laptop is lost.
5. **Alerts:** Telegram only, connected from Bot settings → 1 (the token and chat id are sealed
   as secrets; the bot answers only your chat and has no buy/sell command). Never share the bot token.
6. **Never paste a key into chat, an issue, a commit, or the page.** If one was ever exposed,
   regenerate it in Alpaca; the old one dies instantly.
7. Keep the repo on your personal account, not a shared org, so no one else inherits access.

## Rules that apply to real money
- **Pattern Day Trader rule:** under $25 000 equity, a 4th same-day round trip in 5 business
  days flags the account. The bot counts day trades and holds the 4th exit to the next day
  (emergency floor exits still fire). Over $25 000 the rule does not apply.
- **Fills are not free:** paper fills at the quote; real orders pay spread and slippage. Expect
  live results a little worse than paper — that is the point of the 2–3 month paper run.
- **Gaps:** a stop/floor executes at the next available price, which can be far below the floor
  after overnight news. Position caps are the real protection, not the floor.
- **Taxes:** short-term gains are ordinary income; wash-sale rules apply when a loss is
  re-bought within 30 days. Alpaca issues a 1099; keep the journal.

Not financial advice. The bot places orders only on an account whose keys you choose to give it.


## Passphrase = account password (since 2026-10-22)
The encrypted settings file in this repo now carries the GitHub token, so anyone who learns the passphrase can sign in as you from any device. Use a long, unique passphrase (a few random words), never reuse it, and sign out on shared computers.

**What that token can do:** it can change files in this repo (including the bot's code) and its
secrets — in the wrong hands, that is enough to make the bot trade with your keys. So the
passphrase protects more than your settings. Every version of `user/settings.enc.json` stays in
the repo's public history, so a passphrase that ever leaked stays leaked for the old files.

## If the passphrase or a device is compromised — in this order
1. **Revoke the GitHub token** at github.com/settings/tokens and make a new one (Bot settings → 1).
2. **Pause the bot** from the page (or delete the `ALPACA_*` secrets) until you are done.
3. **Pick a new passphrase.** On one device enter it, then press **Re-encrypt with this
   passphrase** in Sync; sign in again on the others with the new one.
4. **Change the `JOURNAL_KEY` secret** to the new passphrase. The bot will refuse to overwrite a
   journal it cannot open (it says so in Telegram); set the repository *variable*
   `JOURNAL_RESET` to `1` (Settings → Secrets and variables → Actions → Variables) for one session to start a fresh journal, then remove it.
5. **Regenerate the Alpaca keys** if there is any chance the repo was changed while exposed, and
   check the repo's recent commits for anything you did not make.

## If GitHub Actions is down and positions are open
Stock positions carry their stop at the broker, so they are protected without the bot. Option
positions (CALLs, PUTs, SPY quick options) are managed by the bot only — close them in the Alpaca
dashboard (Positions → Close) if the bot cannot run. The watchdog messages you on Telegram when
the bot stops reporting during market hours.
