# Setting up reports & ratings (Firestore)

Community reports (potholes / damage / flooding) and star ratings are stored in
Cloud Firestore — there is no local fallback. Until a working Firebase config is
provided, those sections of the site show "unavailable right now". The site stays
100% static — visitors talk to Firestore directly from the browser, no server needed.

Takes about 10 minutes. The free (Spark) tier is far more than enough to start.

## 1. Create the Firebase project

1. Go to <https://console.firebase.google.com/> and **Add project**
   (e.g. `roadtracker-india`). Google Analytics is optional — off is fine.
2. In the project, click the **Web** icon (`</>`) to register a web app
   (nickname "roadtracker", no hosting needed).
3. You'll be shown an `const firebaseConfig = { ... }` object. Keep it handy.

## 2. Enable Anonymous sign-in

Build → **Authentication** → Get started → Sign-in method → **Anonymous** → Enable.

(Visitors never see a login — this just gives each device a stable anonymous ID so
people can delete *their own* reports and rate each road once.)

## 3. Create the Firestore database

Build → **Firestore Database** → Create database → **Production mode** →
pick a region close to India (e.g. `asia-south1`, Mumbai).

## 4. Paste the security rules

Firestore Database → **Rules** → replace everything with the contents of
[`firestore.rules`](../firestore.rules) from this repo → **Publish**.

These rules enforce:
- anyone can read; only signed-in (anonymous) users can write
- reports must be well-formed (valid type, note ≤ 280 chars, coordinates inside India)
- only the reporter can delete their report
- others can only append their ID to `fixedBy` ("mark fixed" votes) — 3 votes hide a report
- one rating per road per device, stars 1–5

## 5. Add the config to the site

**Recommended — environment variable (config never enters the repo):**

In your host's dashboard (Vercel / Netlify / Cloudflare Pages → project →
Settings → Environment Variables), add one variable, marked secret/encrypted:

- **Name:** `VITE_FIREBASE_CONFIG`
- **Value:** the whole config object from step 1 on one line:

```
{"apiKey":"AIza...","authDomain":"roadtracker-india.firebaseapp.com","projectId":"roadtracker-india","storageBucket":"roadtracker-india.appspot.com","messagingSenderId":"1234567890","appId":"1:1234567890:web:abc123"}
```

Redeploy — Vite injects it at build time and the app switches to shared mode.

**Local testing alternative:** copy `public/firebase-config.example.json` to
`public/firebase-config.json` and paste your values. That file is **gitignored**
so it cannot be committed; don't remove it from `.gitignore`.

> Honesty note: whatever the delivery mechanism, a browser app must hand the
> config to the browser, so it is always discoverable in the shipped bundle.
> That is by design and Google documents it as safe: the web `apiKey` only
> *identifies* the project. What actually protects your data is the security
> rules (step 4), the authorized-domains list (step 6), and App Check. The env
> var's job is keeping the config out of your public git history — good hygiene,
> not secrecy.

## 6. Restrict where it works (recommended)

Firebase console → Authentication → Settings → **Authorized domains**: keep
`localhost` and add `roadtrackerindia.com` (and your host's preview domain if you
use one). Requests from other origins will be refused.

## 7. Deploy

Rebuild/redeploy the site. The app detects the config automatically:

- the browser console logs `[storage] Firestore connected — project "…"`
  (or a precise one-line reason when something is still missing)
- the rating row shows "Be the first to rate this road" / "Community: 4.2 ★ from 12 ratings"

## Costs & abuse notes

- Spark tier: 50k reads + 20k writes per day free — plenty for a young site.
  Reports are only fetched per selected road (capped at 150), ratings use
  server-side aggregate queries, so reads stay tiny.
- The rules cap note length and coordinates; deleting spam is possible from the
  Firebase console (Firestore Database → Data → `reports`).
- If the site grows, add App Check (reCAPTCHA v3) in the Firebase console for
  bot protection — no code changes needed here beyond enabling enforcement.

## Known limitations to be aware of

These are inherent to a serverless/anonymous design and are fine at small scale,
but worth knowing:

- **Anonymous IDs are public.** Every report stores its author's anonymous `uid`
  (the rules need it so people can delete their own reports). Someone reading the
  raw collection could group reports by `uid` and infer where one device travels.
  Mitigate by periodically purging old reports, or move reads behind a Cloud
  Function later if this becomes a concern.
- **"Mark fixed" can be gamed.** Clearing site data gives a fresh anonymous ID, so
  a determined person could self-vote a report hidden with 3 fake confirmations.
  App Check raises the cost of doing this at scale; true one-person-one-vote needs
  real accounts.
- **Coordinates aren't verified server-side.** The app only files a report when the
  tapped point is within ~4 km of the named road, but someone calling the API
  directly could attach wrong coordinates (rules only constrain them to India's
  bounding box). Spot-check the `reports` collection occasionally.
- **Volume caps.** The app fetches at most 150 reports per road; a spam flood could
  push real reports out of view until you delete the spam in the console.

Practical posture: enable App Check early, glance at the `reports` collection now
and then, and delete junk from the console — that covers a young site well.
