# Deploying roadtrackerindia.com

The site is 100% static: `npm run build` produces a self-contained `dist/` folder.
Any static host works. All options below have free tiers that fit this site.

In every case:

- **Build command:** `npm run build`
- **Output directory:** `dist`
- **Node version:** 24 (set `NODE_VERSION=24` env var where relevant)
- **If using Firestore:** add a `VITE_FIREBASE_CONFIG` environment variable in the
  host dashboard (marked secret) — never commit the config to the repo. See
  [docs/FIREBASE.md](FIREBASE.md) §5.

Every road already has a real page at `dist/road/<id>/index.html`, so deep links
work on any host with zero rewrite rules. `404.html` is generated as a safety net.

## Cloudflare Pages (recommended for India traffic)

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

## Vercel

1. Add New Project → import repo. Framework preset: **Vite** (or "Other").
2. Build `npm run build`, output `dist`.
3. Project → Settings → Domains → add `roadtrackerindia.com`.

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
