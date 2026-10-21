# Switching on accounts (one-time, ~10 minutes)

Accounts let each user sign in with email + password and keep their own private
portfolios, tickers and P/L history, synced across their devices. Every user sees
ONLY their own data — enforced by the security rules below, not by trust.

## 1. Create the Firebase project (free)
1. Go to https://console.firebase.google.com → **Add project** → name it `signal-desk` → Analytics **off** → Create.

## 2. Turn on email sign-in
2. Left menu **Build → Authentication** → Get started → **Sign-in method** → **Email/Password** → Enable → Save.

## 3. Create the database
3. **Build → Firestore Database** → Create database → **Start in production mode** → pick a location → Enable.

## 4. Lock it down (important)
4. In Firestore, open the **Rules** tab, replace everything with this, press **Publish**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

This is what guarantees users cannot read each other's data.

## 5. Register the website
5. Project overview → gear icon → **Project settings** → Your apps → **</>** (Web) → nickname `signal-desk` → Register. Copy the `firebaseConfig` object it shows.

## 6. Allow your domain
6. **Authentication → Settings → Authorized domains** → Add domain → `hmula-fbin.github.io`.

## 7. Wire the config into the site
Open `index.html` and replace `const FB_CONFIG = null;` with your config, e.g.:

```js
const FB_CONFIG = {apiKey: "...", authDomain: "signal-desk-xxxx.firebaseapp.com", projectId: "signal-desk-xxxx", appId: "..."};
```

(Or paste the config to Claude and it will wire and push it.) The Firebase web
config is public by design — it identifies the project; the Rules in step 4 are
what protect the data.

## What syncs
All dashboard data (portfolios, holdings, custom tickers, watchlist, day-trade and
option P/L history, amounts, preferences). NOT synced: Finnhub/FMP/proxy keys —
those stay on each device.
