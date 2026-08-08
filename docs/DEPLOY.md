# Deploying roadtrackerindia.com

The site is 100% static: `npm run build` produces a self-contained `dist/` folder.
Any static host works. All options below have free tiers that fit this site.

In every case:

- **Build command:** `npm run build`
- **Output directory:** `dist`
- **Node version:** 24 (set `NODE_VERSION=24` env var where relevant)
- **Firestore (required for reports & ratings):** add a `VITE_FIREBASE_CONFIG`
  environment variable in the host dashboard (marked secret) — never commit the
  config to the repo. Without it those sections show "unavailable". See
  [docs/FIREBASE.md](FIREBASE.md) §5.

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
2. Build `npm run build`, output `dist`. Set `NODE_VERSION=24`.
3. Project → Settings → Domains → add `roadtrackerindia.com`.

`vercel.json` is read from the repo root and only sets `rewrites`, so it does
not disturb build settings configured in the dashboard.

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
- [ ] If using Firestore: add the production domain to Firebase
      **Authorized domains** (see docs/FIREBASE.md §6).
- [ ] Lighthouse (mobile) in Chrome DevTools — expect green performance;
      the map tile CDN (`tiles.openfreemap.org`) is preconnected already.

## Updating content

Adding/editing roads is just editing JSON in `public/data/roads/` and pushing —
the host rebuilds and the new road appears everywhere (map, search, browse,
sitemap, its own URL) automatically.
