# Setting up reports & ratings (Firestore behind the API)

Community reports (potholes / damage / flooding), star ratings and written reviews
live in Cloud Firestore, but **the browser never talks to Firestore.** Every read
and write goes through this site's own serverless API — `/api/ratings`,
`/api/reviews` and `/api/reports` — which uses the Firebase Admin SDK. The Admin SDK bypasses security rules, so
[`firestore.rules`](../firestore.rules) denies *everything*, and there is no way
for a visitor to read or write the database directly.

This is the same design as the RankYourPolitician site, and it is what makes the
next line possible.

## What is and isn't stored about people

There is **no account and no anonymous sign-in. The server identifies nobody.**

- A rating document holds `{road_id, entries, updated_at}`, plus — if that
  person found some reviews helpful — `liked` (random review ids). `entries` maps
  each stretch of the road they rated to `{stars}`, and to `review_id` (a random
  id) when they wrote about it. Nothing else.
- A review is `{id, text, stars, likes, at, range}` inside the road's aggregate
  document. Its id is random: nothing in it points back at its author, or at the
  same person's reviews on other roads.
- A report document holds `{road_id, type, lng, lat, note, created_at}`. Nothing else.
- "One rating (and one review) per person per range of a road" — a stretch, a
  run of stretches, or the whole road — is enforced by the *document id*, which
  is a salted SHA-256 of (coarsened IP + a small device fingerprint). Raw IPs and
  fingerprints are never stored, and the hash is never returned to any client.
- Your own stars, your own reviews and your own likes are remembered in **your
  browser's localStorage**, never on the server.

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

## 5. Migrate existing data (once — already done on the live database)

> `scripts/migrate-firestore.mjs` (`npm run migrate`) was a one-off for the
> move off the browser SDK. On a database it has already migrated, the old
> `ratings` collection is empty and it changes nothing. If it ever does find
> old documents there, it adds their stars to the road's whole-road votes
> (`counts/total/sum`, and `ranges.all` when the aggregate has `ranges`) as
> votes no rater document backs, and leaves the road's reviews and other
> ranges as they are. Pre-stretch *rating* documents in `road_ratings` need no
> script at all: the API upgrades them on their next write (see "How ratings
> are stored").

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

The first deploy with stretches cannot be rolled back without restoring the
database (see "The upgrade is one-way" under "How ratings are stored"): take a
Firestore export first (`gcloud firestore export gs://<bucket>`), and keep
previews off the production database until it is live.

Push and let Vercel build. Check the browser console on a road page:

- `[storage] community features ready`, and a "Reviews" section opening on
  "4.2 ★★★★★ from 12 ratings", one row of stars to rate with, and the reviews
  under it — on a long road such as NH 44, also "· N of 16 stretches rated",
  the coloured stretch bar and "All 16 stretches".
- `/api/ratings?roadId=nh-44` in a browser tab should return JSON.

## Collections

| Collection | Document id | Purpose |
| --- | --- | --- |
| `road_ratings` | `<roadId>__<raterHash>` | one person's `entries` on one road (stars per range, and the id of the review on each), the ids they liked |
| `road_rating_aggregates` | `<roadId>` | the headline counts/total/sum, per-range `ranges`, **and the road's reviews** (`reviews[]`, capped at 100), written in the same transaction as the rating, review or like |
| `reports` | auto | one problem report; `deleted: true` hides it |

The aggregate is maintained transactionally alongside every rating, so the score
shown can never drift from the ratings behind it — and reading a road's score (or
100 roads' scores for a list) is one cheap document fetch rather than a live
aggregation query.

Reviews deliberately live *inside* that document rather than in a collection of
their own: the panel already reads it to show the stars, so showing the reviews
too costs zero additional reads, and there is no per-road query to index. A road
that fills its 100 slots drops the least-liked, oldest review for a new one. The
trade-off is that every write on a road — rating, review, like — lands on one
document, which Firestore rates at about one sustained write per second; for a
road atlas that is ample, but it is the ceiling to know about.

## How ratings are stored

A road with enough main stops is split into **stretches** — the road between two
consecutive stops, "Delhi → Agra" — and people rate and review stretches rather
than the whole road. The rules live in
[`api/_lib/ratings-math.ts`](../api/_lib/ratings-math.ts), pure functions with no
Firestore in them, and
[`scripts/ratings-math.test.mjs`](../scripts/ratings-math.test.mjs) checks them
over thousands of random writes against a recount of every vote.

**Range keys.** A range is either `all` (the whole road) or two stop slugs joined
by `--`, sorted as plain strings: `agra--delhi`, never `delhi--agra`, so one
stretch can never split its votes between two spellings. A review can span
several consecutive stretches (start stop → end stop), and choosing every stretch
is `all`. Keys are at most 90 characters and must match `RANGE_KEY`; the server
cannot check a slug against the road's stops, which is one reason for the caps
below. Roads too short or too oddly mapped for stretches only ever use `all`.

**Entries.** `road_ratings/<roadId>__<raterHash>` is

```js
{ road_id, updated_at, entries: { [range]: { stars, review_id? } }, liked? }
```

One entry per person per range: stars are required (`null` only for an old
whole-road review whose author never rated), the review is optional. `review_id`
points into the aggregate's `reviews`; a pointer to a review that has since been
evicted is dropped the next time that person writes anything on the road.

**Aggregate.** `road_rating_aggregates/<roadId>` is

```js
{ road_id, updated_at, counts, total, sum,      // the headline: one vote per PERSON
  ranges: { [range]: { counts, total, sum } }, // one vote per ENTRY
  reviews: [{ id, text, stars, likes, at, range, edited? }] }
```

- **The headline counts each person once.** Their vote is their `all` stars if
  they gave some, otherwise the rounded mean of their stretch stars. Rating six
  stretches of a road does not weigh six times in its score.
- **`ranges` counts entries**, which is what colours each stretch on the map. A
  whole-road vote sits under `ranges.all` and says nothing about any particular
  stretch. A range whose last vote goes is deleted, and a bucket in `counts` that
  reaches zero is removed rather than kept at 0.
- A review's `stars` is a copy of its entry's stars, kept in step on every re-rate.

**Caps.** A cap that is hit writes nothing and answers `400` with the error shown:

| Cap | Limit | Answer | Why |
| --- | --- | --- | --- |
| entries per person per road | 20 | `too-many` | more than any real trip; one person cannot bloat a road |
| written reviews per person per road | 5 live | `too-many` | the 100 review slots are shared by everybody |
| range keys per road | 200 (`all` is exempt) | `road-full` | made-up keys cannot grow the aggregate without bound, and the whole road stays rateable |
| reviews per road | 100 | — | at the limit, the least-liked, oldest review makes way (no error) |

`too-many` is the person's own doing, and they can edit or delete one of theirs.
`road-full` is not: whoever meets it may never have rated the road. A new
entry on a key the road already holds, or on `all`, still saves. One build's 17
stops make at most 136 keys, so a full road means keys left by many rebuilds'
stops, or made-up ones (the server cannot tell a real slug from an invented
one). A person at their own 20 hears `too-many` even on a full road, since that
is the cap they can do something about.

**Writes.** Every write sets *both* documents whole, never merged, from what the
rules return. Firestore Admin rejects `undefined` field values, so the rules
never produce one.

**Documents from before stretches** need no migration. A rater doc shaped
`{road_id, stars, review_id?, liked?}` is read as `entries.all`; an aggregate with
no `ranges` is read as having every vote under `ranges.all` (every vote before
this change was whole-road), and reviews without a `range` are whole-road. A
person's next write on a road rewrites their own rater doc and the road's
aggregate in the new shape, and the old fields go; everyone else's docs wait for
their own next write, and read the same in the meantime. Old pages that still
post `{roadId, text}` to `/api/reviews` save a
whole-road review and keep the stars the person already gave; a `DELETE` with no
`range` removes only the text of their whole-road review.

**The upgrade is one-way.** An old page talking to this API is safe; old *API code*
writing to documents this code has written is not. The code from before
stretches reads only the top-level `stars` and `review_id`, which a new-shape
rater doc no longer has, so it takes everyone who has written since as a new
rater: their rating adds a second headline vote, and their review becomes a
second review they can neither edit nor delete. The new code ignores the fields
it merged in, so nothing ever takes those back out — the headline keeps votes no
rater doc backs, and `ranges.all` stops agreeing with it. So, once this ships:

- **Do not Instant Rollback past it** (or redeploy an older commit) unless you
  also restore a Firestore export taken just before it went out. Fix forward.
- **Keep preview deployments off the production database** while production
  still runs the old code: a preview of this branch would write new-shape docs
  that production then miscounts. Scope `FIREBASE_SERVICE_ACCOUNT_JSON` to the
  Production environment in Vercel, or give Preview a throwaway Firebase project.

If it happens anyway, the API says so: a write that finds a rater doc with both
`entries` and a top-level `stars` or `review_id` logs `[ratings] <roadId>: a
rater doc was written by code from before stretches`. That road's counts need
restoring from the export; there is no recount script.

## Costs & abuse notes

- Spark tier: 50k reads + 20k writes/day free. Rating reads hit one aggregate doc
  per road and are edge-cached for 5 minutes; a batch of 100 roads is one request.
  Reviews ride inside that same read. A review or a like is one transaction over
  two documents (2 reads, 2 writes) — the same price as a rating.
- Rate limits are per coarse IP (a /24, or a /48 for IPv6) per hour, across
  every road: 100 star-only ratings (shared by `/api/reviews` and
  `/api/ratings`), 20 review writes (anything with text, and deletes), 20 likes
  and 20 report writes. Ratings get the most because each stretch is a write of
  its own, and on mobile CGNAT one prefix is many people. No limit is keyed on the
  device fingerprint, which the client sends: a fresh one per request would be
  a fresh budget.
- Nobody can delete someone else's review, unlike reports: an open delete would
  be the obvious way to bury criticism of a road. A review can be removed from
  the console by editing the aggregate's `reviews` array; its author's pointer to
  it is dropped on their next write. Do not edit stars, counts or `ranges` by
  hand — the headline, every range and the rater docs must all agree, and the
  write rules assume they do.
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
| `400 too-many` from `/api/reviews` or `/api/ratings` | the person hit one of their own caps (see "How ratings are stored") | working as intended: they can edit or delete one of theirs |
| `400 road-full` from `/api/reviews` | the road's `ranges` holds 200 keys, none of them the one asked for — not the person's doing | they can still rate the whole road, or a stretch someone already rated. Clearing keys means taking each one's entries out of their rater docs and its votes out of `ranges` and the headline together; never edit `ranges` alone |
| `[ratings] … written by code from before stretches` in a function log | an older deployment wrote to this database after the new code did: a rollback, or a preview | restore the road from the pre-deploy export (see "The upgrade is one-way") |
| Reports vanished after the first deploy | step 5 never ran on this database | run it once (§5) |
| `PERMISSION_DENIED` in a *function* log | the service account lacks Datastore access | grant it "Cloud Datastore User" in Google Cloud IAM |

A `PERMISSION_DENIED` in the **browser** now means something is still using the
client SDK — there shouldn't be one; `firebase` is no longer a dependency.
