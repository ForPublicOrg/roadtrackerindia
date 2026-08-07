# RoadTracker India

**roadtrackerindia.com — a map-first encyclopedia of Indian roads.**
National Highways, Expressways, State Highways and notable city roads on one fast,
fully static, interactive map. The map *is* the interface: search or tap a road,
the camera flies to it, the route draws itself, and an encyclopedia panel slides in.

## Features

- 🗺 **Map-first UI** — full-screen MapLibre GL map, category-coloured network
  (Expressway / NH / SH / city), dashed = under construction or planned, legend, hover tooltips
- 🔎 **Search** — understands road numbers ("NH 44"), names ("Yamuna Expressway"),
  old numbering ("old NH 7"), and cities ("roads through Nagpur"); keyboard-navigable
- 🧭 **Find my road** — one tap, browser GPS, snaps to the nearest catalogued road
  with graceful fallbacks (permission denied → search; nothing nearby → closest options)
- 📖 **Road panel** — progressive disclosure: summary chips first, then route, lanes,
  agency, cost, contractor, toll plazas, timeline, history, facts, official sources
- 🕳 **Community reports** — anyone can pin potholes / damaged stretches / waterlogging
  on a road and remove their own pins; others confirm "fixed" (3 confirmations hide a report)
- ⭐ **Road ratings** — 1–5 stars per road with community averages
- ☁️ **Firestore-backed** — reports & ratings live in Cloud Firestore (free tier,
  anonymous auth), configured via a `VITE_FIREBASE_CONFIG` env var at build time (or a
  gitignored `public/firebase-config.json` for local dev). Without a working config the
  community sections show an "unavailable" state. See [docs/FIREBASE.md](docs/FIREBASE.md)
- 🌗 **Light & dark map styles** with a toggle (dark style is derived programmatically)
- 🔗 **SEO & deep links** — every road gets a real static page at `/road/<id>` with its
  own meta tags + JSON-LD, plus sitemap.xml
- ♿ **Accessible** — keyboard navigation, ARIA combobox/dialog patterns, visible focus,
  `prefers-reduced-motion` disables every animation
- 📉 **Edge states** — tile-CDN failure banner with retry (roads still render on a plain
  background), sparse-data placeholders, offline-tolerant boot

## Quick start

```bash
npm install
npm run dev        # validate data + dev server on :5173
npm run build      # data build → vite build → per-road SEO pages + sitemap
npm run preview    # serve the production build
```

Deploy the `dist/` folder to any static host (Netlify, Vercel, Cloudflare Pages,
GitHub Pages). Details: [docs/DEPLOY.md](docs/DEPLOY.md).

## How the data works

Each road is **one JSON file** — the single source of truth:

```
public/data/roads/<id>.json     ← hand-editable encyclopedia entry + waypoints
public/data/geometry/<id>.json  ← optional cached real OSM alignment (auto-preferred)
```

`npm run data` (runs automatically before dev/build) validates every file against
[docs/DATA.md](docs/DATA.md) and derives everything the app loads:

```
public/data/index.json           search/browse index
public/data/network-lite.geojson simplified all-roads overview
public/data/shapes/<id>.json     per-road display geometry (lazy-loaded)
```

**Add a road** = drop one JSON file in `public/data/roads/` and rebuild. That's it —
it appears on the map, in search, in browse, and gets its own SEO page.

**Upgrade a road's geometry** from city-waypoint polylines to the real OSM alignment:

```bash
node scripts/fetch-osm-geometry.mjs --only nh-44,nh-48   # or no flag = all
npm run data
```

(Throttled, cached, resumable; data © OpenStreetMap contributors, ODbL.)

## Stack & architecture

- **Vite + TypeScript, zero UI framework** — the app is one small hand-rolled SPA
  (~30 KB of app code) around [MapLibre GL JS](https://maplibre.org/); smallest possible
  JS for mid-range phones, full control over the animation loop
- **OpenFreeMap** vector tiles (free, keyless, OSM-based); positron style for light mode,
  and the dark style is the same style transformed through an HSL inversion at runtime
- **Indian border depiction**: the base style is restyled at runtime so India's external
  boundary follows the Survey of India depiction — the whole of Jammu & Kashmir and
  Aksai Chin inside one solid boundary, drawn slightly darker and heavier than other
  countries' borders, with no LoC/LAC dashes. The boundary line itself is a committed
  static asset (`public/data/india-boundary.geojson`) assembled from OSM boundary
  relations by `scripts/fetch-india-boundary.mjs`
- **Static pages for SEO**: `scripts/gen-pages.mjs` stamps `dist/road/<id>/index.html`
  per road (own title/description/OG/JSON-LD) + `sitemap.xml` + `404.html` SPA fallback
- **Firestore adapter** is lazy-loaded only when configured, so the default bundle stays lean

```
src/
  main.ts        boot + selection flow wiring
  map.ts         MapLibre init, layers, hover/click, camera, theming
  mapstyle.ts    style fetch + programmatic dark transform + offline fallback
  animate.ts     route draw-on (line-gradient sweep), springs, reduced-motion
  panel.ts       detail panel / mobile bottom sheet (spring physics drag)
  search.ts      ranked autocomplete (roads, aka, cities, states)
  browse.ts      filter chips (category/status/state/city) + list
  locate.ts      GPS → nearest-road snapping with fallbacks
  reports.ts     community problem reports (pins, dialog, popups)
  ratings.ts     star ratings
  storage.ts     Firestore connection + config detection (env var or local file)
  firestore.ts   CloudStore (lazy) — anonymous auth, reports, ratings, aggregates
  router.ts      /road/<id> deep links + meta/canonical/OG sync
scripts/
  build-data.mjs           validate + derive (also `--lint`)
  gen-pages.mjs            per-road SEO pages + sitemap
  fetch-news.mjs           per-road news snapshots (Google News RSS, build time)
  fetch-osm-geometry.mjs   real OSM alignments via Overpass
  fetch-india-boundary.mjs India's external boundary (Survey of India depiction)
```

## Attribution

Base map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL) ·
Tiles by [OpenFreeMap](https://openfreemap.org) · Road encyclopedia data compiled from official
sources (NHAI, MoRTH, PIB, state authorities) — each road page links its sources.
