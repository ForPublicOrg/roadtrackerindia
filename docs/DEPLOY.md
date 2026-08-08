# Deploying roadtrackerindia.com

The **pages** are 100% static: `npm run build` produces a self-contained `dist/`
folder that any host can serve. But reports and ratings now run through
serverless functions in `api/`, so the site is no longer fully host-agnostic:

- **Vercel — the supported target.** Serves `dist/` and runs `api/*.ts` as Node
  functions (auto-detected from the `api/` directory — `vercel.json` stays
  rewrites-only, see below).
- **Any other static host** will serve every road page correctly, but `/api/*`
  will 404 and the reports and ratings sections will show their "unavailable"
  state. Everything else — map, search, browse, all 7,750 roads — works fine.

Moving to Cloudflare Pages would mean rewriting `api/` against the Firestore REST
API: Pages Functions run on the Workers runtime, which cannot load `firebase-admin`.

In every case:

- **Build command:** `npm run build`
- **Output directory:** `dist`
- **Node version:** 24. Cloudflare Pages and Netlify read a `NODE_VERSION=24`
  env var; **Vercel does not** — it takes the version from Project Settings →
  General → Node.js Version (`firebase-admin` needs at least 18)
- **Firestore + secrets (required for reports & ratings):** see
  [docs/FIREBASE.md](FIREBASE.md) §4. The service-account key is a real
  credential — host env vars only, never the repo.

## Deep links need a rewrite rule

This used to be free: every road had its own stamped page, so `/road/<id>/` was
always a real file. With 7,700 roads in the catalogue only the ~1,150 worth
their own SEO page are prerendered, and the rest are served by the app itself.

Without a rewrite those URLs fall to `404.html` and answer **HTTP 404** — the
page renders, but the status code tells search engines and link previews the
road does not exist. The build therefore emits rules for both conventions:

| Host | File | Provided by |
|---|---|---|
| Vercel | `vercel.json` (repo root) | committed |
| Cloudflare Pages, Netlify | `dist/_redirects` | `gen-pages.mjs` |

Both send `/road/*` and `/company/*` to `/index.html` with a 200. Static files
still win over rewrites on every one of these hosts, so a prerendered road keeps
its own title, description and JSON-LD. `404.html` remains the fallback for
hosts that read neither file.

## Vercel (the live host for roadtrackerindia.com)

1. Add New Project → import repo. Framework preset: **Vite** (or "Other").
2. Build `npm run build`, output `dist`. Set the Node version in Project →
   Settings → General → Node.js Version — a `NODE_VERSION` env var does nothing
   here, that is the Netlify and Cloudflare convention.
3. Project → Settings → Environment Variables → add the six from
   [docs/FIREBASE.md](FIREBASE.md) §4 **before** the first deploy.
   `VITE_TURNSTILE_SITE_KEY` is baked into the bundle by `vite build` rather
   than read at runtime, so adding it later changes nothing until you redeploy.
4. Project → Settings → Domains → add `roadtrackerindia.com`.

`vercel.json` is read from the repo root and only sets `rewrites`, so it does
not disturb build settings configured in the dashboard.

**The primary domain must be the apex, not `www`.** `gen-pages.mjs` stamps
`SITE = 'https://roadtrackerindia.com'` into every canonical link, `og:url`,
JSON-LD entry and sitemap URL. If Vercel makes `www` primary instead, all ~1,150
prerendered pages then declare a canonical host that immediately 308s somewhere
else, and every sitemap URL is a redirect — Search Console reports those as
"Page with redirect" rather than indexing them. Either keep the apex primary in
Settings → Domains, or change `SITE` and rebuild. The two must agree.

Two limits worth knowing at this catalogue size:

- **Files.** A build currently emits ~17,000 files. Vercel documents *no* upper
  limit on build output, so Git-connected deploys are fine — but a `vercel`
  **CLI** deploy uploads source files and caps at **15,000**, which this repo now
  exceeds. Deploy from Git, not the CLI.
- **Routes.** Every rewrite, redirect and header counts toward a 2,048-route
  limit. That is why the rules are two wildcards rather than one per road.

## Cloudflare Pages

1. Push this repo to GitHub.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → connect the repo.
3. Build command `npm run build`, output `dist`, env `NODE_VERSION=24`. Deploy.
4. Custom domain: add `roadtrackerindia.com` (Cloudflare guides the DNS records;
   if the domain's DNS is already on Cloudflare it's one click).

## Netlify

1. Add new site → Import from Git → pick the repo.
2. Build `npm run build`, publish directory `dist`, env `NODE_VERSION=24`.
3. Domain settings → add custom domain `roadtrackerindia.com` → follow the DNS
   instructions (CNAME `www` + ALIAS/A for apex). HTTPS is automatic.

## GitHub Pages

1. Repo → Settings → Pages → Source: **GitHub Actions**, then use the standard
   "Static HTML" workflow with:
   ```yaml
   - run: npm ci && npm run build
   - uses: actions/upload-pages-artifact@v3
     with: { path: dist }
   ```
2. Custom domain `roadtrackerindia.com` in Pages settings (creates a CNAME file);
   set the DNS A records GitHub documents.
3. `404.html` (already generated) keeps unknown URLs working as a SPA fallback.

## After the first deploy — checklist

- [ ] Visit `/road/nh-44` directly (hard refresh) — the page should load with
      an NH 44 title in the tab.
- [ ] `https://roadtrackerindia.com/sitemap.xml` responds → submit it in
      [Google Search Console](https://search.google.com/search-console).
- [ ] `curl -sL "https://roadtrackerindia.com/api/ratings?roadId=nh-44"`
      returns **JSON** (`-L` matters — whichever of apex and `www` is not
      primary answers 308). A host that serves the SPA's `index.html` and
      HTTP 200 parses to `{}` and makes every road claim "be the first to rate
      this road" — the client rejects non-JSON now, but this is the fastest way
      to see the routing is right.
- [ ] Post a rating and a report on a throwaway road, then check the Firestore
      console: the rating doc id must be `<roadId>__<hash>`, and neither
      collection may contain a `uid`. Nothing about Firebase **Authorized
      domains** applies any more — that was for the browser's anonymous
      sign-in, which no longer exists (docs/FIREBASE.md).
- [ ] Lighthouse (mobile) in Chrome DevTools — expect green performance;
      the map tile CDN (`tiles.openfreemap.org`) is preconnected already.

## Updating content

Adding/editing roads is just editing JSON in `public/data/roads/` and pushing —
the host rebuilds and the new road appears everywhere (map, search, browse,
sitemap, its own URL) automatically.
