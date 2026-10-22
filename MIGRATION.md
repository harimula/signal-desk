# Moving Signal Desk to another GitHub account or repo name

The code no longer contains the repo name: the page works out which repo it belongs to from the
address it is served from, and the bot from the repo it runs in. So a move is: copy the repo,
switch the services back on, and re-point your devices. About 20 minutes, nothing is lost.

Throughout: **OLD** = `hmula-fbin/signal-desk`, **NEW** = `<new-account>/<new-repo>`.

---

## 1. Create the new account and repo (5 min)

1. Sign up at github.com if the account does not exist yet, and turn on 2FA (passkey or
   authenticator app, not SMS) before anything else.
2. github.com → **+** → **Import repository**.
   - *The URL for your source repository:* `https://github.com/hmula-fbin/signal-desk`
   - *Owner:* the new account · *Repository name:* whatever you want (`signal-desk` is fine)
   - *Public* — GitHub Pages is free only on public repos.
3. Click **Begin import** and wait about a minute.

The import brings every file and the full commit history, including `bot/journal.json`
(your trade record) and `user/settings.enc.json` (your synced settings). It does **not** bring
secrets, Actions settings, or the Pages site — those are the next two steps.

> If the old repo is private, Import asks for a username and token for the old account; a
> fine-grained token with *Contents: read* on the old repo is enough.
> Alternatively: old repo → **Code** → **Download ZIP**, then upload the files to a new empty
> repo. That loses the commit history but nothing else.

## 2. Turn the services back on in the new repo (5 min)

1. **Pages:** Settings → Pages → Source *Deploy from a branch* → `main` / `/ (root)` → Save.
   Your new site is `https://<new-account>.github.io/<new-repo>/` — live in a minute or two.
2. **Actions:** Settings → Actions → General → *Allow all actions and reusable workflows*;
   under **Workflow permissions** choose *Read and write permissions* → Save.
   Then the **Actions** tab → enable the workflows (`refresh-prices`, `paper-trade-bot`,
   `bot-tests`; `strategy-research` and `backtest` are manual).
3. **Secrets:** Settings → Secrets and variables → Actions → add:

   | Secret | Value |
   |---|---|
   | `ALPACA_KEY` / `ALPACA_SECRET` | **newly generated** paper keys (see §4) |
   | `JOURNAL_KEY` | the same passphrase as before, if you want the old journal and synced settings to open |
   | `NTFY_TOPIC` | your existing topic, or a new random one |
   | `ALPACA_LIVE_KEY` / `ALPACA_LIVE_SECRET` | only when you go live |

   You can also add them from the site itself once step 3 is done.

## 3. Re-point your devices (2 min each)

On each laptop or phone, open the **new** site → **Bot settings**:

1. **1. Connection** — paste a **new fine-grained token** made on the new account
   (Settings → Developer settings → Personal access tokens → Fine-grained; repository access:
   only the new repo; permissions Contents, Secrets, Actions: *Read and write*; expiry ≤ 90 days).
   The *Repository* field is already filled in with the new repo, because the page reads it from
   its own address.
2. **Sync across devices** — enter the same journal passphrase. Your Finnhub/FMP keys, watchlist,
   portfolios, tickers and calculator inputs come back by themselves.

Delete the old site from your bookmarks so you do not keep two copies open.

## 4. Rotate the keys (5 min, do not skip)

Anyone with access to the old account can still read its secrets and act as that repo.

1. **Alpaca** → regenerate the paper API keys (the old pair dies instantly) → put the new pair in
   the new repo's secrets.
2. **GitHub** → old account → Settings → Developer settings → revoke the old fine-grained token.
3. If you used the old `NTFY_TOPIC`, pick a new random one so old subscribers lose the feed.

## 5. Retire the old repo

Once the new site shows prices and the Bot tab looks right:

- Old repo → Settings → Actions → *Disable actions* (otherwise two bots trade the same account).
- Then either archive the old repo (Settings → Archive this repository) or delete it.
  Archiving keeps the history readable; deleting frees the name.

**Order matters:** turn the old bot off before or at the same time as switching the new one on.
Two live bots on one Alpaca account would double every position.

## 6. Tell Claude (optional)

The claude.ai copy of the page is not served from GitHub Pages, so it cannot work the repo out
from its address; it uses the `FALLBACK_REPO` constant near the top of the script. Ask for it to
be pointed at the new repo and the artifact republished, or edit that one line yourself.

---

## Checklist

- [ ] New account has 2FA
- [ ] Repo imported, history intact
- [ ] Pages serving the new site
- [ ] Actions allowed, workflow permissions read & write, workflows enabled
- [ ] Secrets added (`ALPACA_*`, `JOURNAL_KEY`, `NTFY_TOPIC`)
- [ ] New fine-grained token connected on each device
- [ ] Sync passphrase entered; settings and keys came back
- [ ] Alpaca keys regenerated; old token revoked
- [ ] Old repo's Actions disabled, then archived or deleted
- [ ] First `paper-trade-bot` run green on the new repo
