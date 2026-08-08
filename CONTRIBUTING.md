# Contributing

The most valuable contribution is not code. It's a road that's wrong.

## A road is wrong, missing, or out of date

Open an issue with the road's URL (`roadtrackerindia.com/road/<id>`) and what's
off. If you can point at an official source — an NHAI or MoRTH page, a PIB
release, a state authority notification — that's what turns it into a fix.

If the road's **alignment** is wrong on the map rather than its facts, the fix
belongs upstream in [OpenStreetMap](https://www.openstreetmap.org). Correct it
there and it flows through the next time the corpus is regenerated.

## Running it

Node 24 or newer.

```bash
npm install
npm run dev          # validates the data, then serves on :5173
npm run typecheck    # strict TS, app + api
npm run data -- --lint   # validate the corpus without rewriting anything
```

Reports and ratings need Firestore credentials, which you won't have. Everything
else — the map, search, browse, road pages, locate — works without them.

## Adding or editing a road

One road is one JSON file in `public/data/roads/<id>.json`. Drop it in, run
`npm run data`, and it appears on the map, in search, in browse, and gets its own
page. The full field spec is [docs/DATA.md](docs/DATA.md); how the corpus was
generated from OSM is [docs/CORPUS.md](docs/CORPUS.md); authorities, builders and
operators are [docs/ORGS.md](docs/ORGS.md).

Four things that will get a change sent back:

- **Never invent a phone number.** Helplines are real published numbers or they
  don't go in. 1033 is NHAI's, so it belongs on national highways — not on a
  state expressway. 112, 108 and 1073 are hardcoded and data can't remove them.
- **Watch the 2010 renumbering.** Current NH 10 is Sevoke–Gangtok, not the old
  Delhi–Fazilka NH 10. Old numbers go in `aka`, never in `ref`.
- **Cite it.** Anything factual — length, cost, opening date, who built it —
  needs a source in the road's `sources`.
- **Don't reserialise road files.** Scripts that rewrite JSON must splice the
  text they're changing. `JSON.stringify(road, null, 2)` explodes every
  `"coords": [77.5, 28.4]` onto three lines and buries the real change.

Derived files (`index.json`, `network-*.geojson`, `shapes/`, `places.json`,
`orgs.json`, `org/`) are built by `npm run data` and are gitignored. Never edit
or commit them.

## Code

No UI framework, and that's deliberate — the whole app is about 30 KB of JS so it
opens fast on a mid-range Android. Please don't add React, or a component
library, or a state manager.

- Strict TypeScript, no `any`.
- Every animation must survive `prefers-reduced-motion`, and must fall back to
  instant when `document.visibilityState === 'hidden'`.
- Never gate boot on MapLibre's `load` event. Layers self-attach; everything else
  wires immediately.
- Keyboard and screen-reader paths are part of the feature, not a follow-up.

## Licensing your contribution

Code contributions are under [MIT](LICENSE). Road data contributions are under
ODbL, because the catalogue is derived from OpenStreetMap — see
[DATA-LICENSE.md](DATA-LICENSE.md). By opening a PR you're agreeing to that.

## Reporting a security problem

Please don't open a public issue for anything involving the API, the rate
limiting, or the vote-hashing. Use GitHub's private
[security advisory](https://github.com/ForPublicOrg/roadtrackerindia/security/advisories/new)
form instead.
