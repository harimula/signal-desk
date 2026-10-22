# Sharing Signal Desk with family — one copy each

Every person runs their **own** copy: own GitHub repo, own site, own bot, own broker account.
Nothing is shared except the code, so nobody can see or change anyone else's trades or keys.

## Owner (once)
1. Repo → Settings → General → tick **Template repository**.
2. Send family the repo link.

## Each family member (about 15 minutes, all free)
1. Create a GitHub account (turn on 2FA with an authenticator app or passkey).
2. Open the repo link → **Use this template** → **Create a new repository** → name it
   `signal-desk`, keep it **Public** (GitHub Pages is free only on public repos).
3. In the new repo: Settings → Pages → Source **Deploy from a branch** → `main` / root → Save.
   The site appears at `https://<username>.github.io/signal-desk/` in a minute or two.
4. Settings → Actions → General → **Allow all actions**, and Workflow permissions →
   **Read and write**. Then the Actions tab → enable the workflows.
5. Create a free account at https://alpaca.markets, switch to **Paper**, generate API keys.
6. On your site → **Bot settings**: connect with a fine-grained GitHub token (this repo only;
   Contents, Secrets, Actions: read & write; 90-day expiry), paste the Alpaca paper keys
   (they are sealed into your repo's secrets, never shown again), pick a risk profile, Save.
7. Optional: set a **Journal passphrase** so your trades are encrypted on the public site.

## Getting updates
When the owner improves the strategy: your repo → **Sync fork** (or Code → "This branch is
N commits behind" → **Update branch**). Your keys and settings are not touched.

## Ground rules
- Paper for 2–3 months before anyone considers live money; live keys go in that person's own
  repo only. Each account belongs to the person whose name is on it.
- Never share tokens or keys in family chats; never put another person's keys in your repo.
- Not financial advice. Each person is responsible for their own account.
