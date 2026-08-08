# Setting up reports & ratings (Firestore behind the API)

Community reports (potholes / damage / flooding) and star ratings live in Cloud
Firestore, but **the browser never talks to Firestore.** Every read and write goes
through this site's own serverless API — `/api/ratings` and `/api/reports` — which
uses the Firebase Admin SDK. The Admin SDK bypasses security rules, so
[`firestore.rules`](../firestore.rules) denies *everything*, and there is no way
for a visitor to read or write the database directly.

This is the same design as the RankYourPolitician site, and it is what makes the
next line possible.

## What is and isn't stored about people

There is **no account and no anonymous sign-in. The server identifies nobody.**

- A rating document holds `{road_id, stars, updated_at}`. Nothing else.
- A report document holds `{road_id, type, lng, lat, note, created_at}`. Nothing else.
- "One rating per road per person" is enforced by the *document id*, which is a
  salted SHA-256 of (coarsened IP + a small device fingerprint). Raw IPs and
  fingerprints are never stored, and the hash is never returned to any client.
- Your own stars and your own pins are remembered in **your browser's
  localStorage**, never on the server.

The salt is the only thing that makes those hashes un-recomputable, so
`VOTE_HASH_SALT` below is a real secret.

## 1. Firebase project and database

1. <https://console.firebase.google.com/> → **Add project**. Analytics optional.
2. Build → **Firestore Database** → Create database → **Production mode** →
   a region close to India (`asia-south1`, Mumbai).

You do **not** need to register a web app, and you do **not** need to enable
Anonymous sign-in or manage Authorized domains any more. Those were requirements
of the old browser-direct design and are now dead steps.

## 2. Publish the rules

Firestore Database → **Rules** → replace everything with the contents of
[`firestore.rules`](../firestore.rules) → **Publish**.

They deny all direct access. That is correct and deliberate — read the comment in
the file before "fixing" it.

## 3. Create a service account

Project settings (gear) → **Service accounts** → **Generate new private key**.
A JSON file downloads. This is a **real credential** — unlike the old web config,
it grants full database access. Never commit it.

## 4. Environment variables on Vercel

Project → Settings → Environment Variables. Mark every one of these secret:

| Variable | Required | What it is |
| --- | --- | --- |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | **yes** | the whole service-account JSON from step 3, on one line |
| `VOTE_HASH_SALT` | **yes in production** | a long random string. Without it the dedupe hashes are effectively unsalted — the API logs a loud error at startup |
| `TURNSTILE_SECRET_KEY` | recommended | Cloudflare Turnstile secret. **If unset, bot protection is disabled** and the API allows writes unverified (`dev: true` in responses) |
| `VITE_TURNSTILE_SITE_KEY` | recommended | the matching Turnstile *site* key. Public, baked into the bundle at build time |
| `UPSTASH_REDIS_REST_URL` | recommended | Upstash Redis for rate limiting |
| `UPSTASH_REDIS_REST_TOKEN` | recommended | " |

Without Upstash, rate limiting falls back to per-instance memory, which on
serverless is close to useless — each cold start gets a fresh, empty counter.
Since **anyone can delete any report**, the rate limit is the main thing standing
between the map and a wipe script. Configure Upstash before launch.

Get Turnstile keys at Cloudflare dashboard → Turnstile → Add site. The widget
renders in `interaction-only` mode, so visitors normally never see it.

## 5. Migrate existing data

The old browser-written documents use a different shape (`roadId` rather than
`road_id`) and carry the anonymous `uid` this redesign removes. Existing reports
would be invisible to the API until migrated.

Dry run first — it changes nothing and prints what it would do:

```bash
node scripts/migrate-firestore.mjs
```

Then commit it:

```bash
node scripts/migrate-firestore.mjs --apply
```

It renames the report fields, strips every `uid`/`fixedBy`, preserves reports
already hidden by three "fixed" votes, folds any old ratings into the new
per-road aggregates, and deletes the uid-keyed rating documents. Per-person
dedupe cannot carry across — the old keys were anonymous uids and the new ones
are salted IP+device hashes, so those historical ratings survive as counts only.

## 6. Running it locally

`npm run dev` starts vite only. It does **not** run `api/` — those are Vercel
functions, and vite knows nothing about them — so `/api/*` deliberately answers
404 and the community sections show "not available on this deployment". Every
other part of the site works normally.

To exercise the real endpoints locally:

```bash
npx vercel dev
```

Put the same variables from §4 in a local `.env` (gitignored). Point it at a
throwaway Firebase project rather than production — writes are real.

## 7. Deploy

Push and let Vercel build. Check the browser console on a road page:

- `[storage] community features ready` and a rating row showing
  "Community: 4.2 ★ from 12 ratings" with a distribution bar chart.
- `/api/ratings?roadId=nh-44` in a browser tab should return JSON.

## Collections

| Collection | Document id | Purpose |
| --- | --- | --- |
| `road_ratings` | `<roadId>__<raterHash>` | one person's stars for one road |
| `road_rating_aggregates` | `<roadId>` | counts/total/sum, written in the same transaction as the rating |
| `reports` | auto | one problem report; `deleted: true` hides it |

The aggregate is maintained transactionally alongside every rating, so the score
shown can never drift from the ratings behind it — and reading a road's score (or
100 roads' scores for a list) is one cheap document fetch rather than a live
aggregation query.

## Costs & abuse notes

- Spark tier: 50k reads + 20k writes/day free. Rating reads hit one aggregate doc
  per road and are edge-cached for 5 minutes; a batch of 100 roads is one request.
- **Deletion is open to anyone**, by design: stale reports outlive the pothole and
  their author rarely returns to clear them. Deletes are *soft* (`deleted: true`),
  so anything removed maliciously is recoverable in the console.
- Rules deny direct access entirely, so a leaked project id buys an attacker
  nothing — there is no public read surface to enumerate.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `503 unavailable` from `/api/*` | `FIREBASE_SERVICE_ACCOUNT_JSON` unset or malformed | check the var; the function logs the init error |
| `403 captcha` | Turnstile secret set but the site key isn't (or vice versa) | set both, or neither |
| `429 rate-limited` | working as intended, or Upstash unset and a cold instance | configure Upstash |
| Reports vanished after deploy | step 5 not run | run the migration |
| `PERMISSION_DENIED` in a *function* log | the service account lacks Datastore access | grant it "Cloud Datastore User" in Google Cloud IAM |

A `PERMISSION_DENIED` in the **browser** now means something is still using the
client SDK — there shouldn't be one; `firebase` is no longer a dependency.
