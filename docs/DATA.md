# RoadTracker India — Road Data Specification (v1)

Every road on the site is a single JSON file:

```
public/data/roads/<id>.json
```

The build step (`npm run data`) validates every file, then derives:

- `public/data/index.json` — the search/browse index (one summary row per road)
- `public/data/network-lite.geojson` — the trunk network (expressways, NHs, city roads)
- `public/data/network-detail.geojson` — state + district roads, loaded only when the map zooms in
- `public/data/shapes/<id>.json` — the display geometry for the selected-road animation

You never edit the derived files. **The road JSON is the single source of truth.**

## Where roads come from

Two kinds of road file live side by side:

| | Hand-authored | Generated |
|---|---|---|
| Count | ~97 | thousands |
| Marker | no `provenance` | `"provenance": "osm"` |
| Has history, facts, timeline, tolls | yes | not yet |
| Produced by | a person | `scripts/fetch-osm-roads.mjs` → `scripts/generate-roads.mjs` |

The generator **never overwrites a hand-authored file.** Enriching a generated
road is simply a matter of adding the optional fields below and dropping the
`provenance` key — from then on it is hand-authored and stays untouched.

See [CORPUS.md](CORPUS.md) for the pipeline, for how to add a road that has no
highway number (a city's Outer Ring Road), and for what to do when two records
turn out to be the same road.

## Retired ids

`data/merged-roads.json` maps an id that is no longer its own road to the one
that absorbed it. Nothing else references it: the build ships the map inside
`index.json`, the app follows it so `/road/ne-4/` still opens the Delhi–Mumbai
Expressway, and the generator skips those ids so they cannot come back. Never
delete a road file without adding it here — a live URL would start 404ing.

## The `id`

- kebab-case, stable forever (it becomes the public URL `/road/<id>`)
- must equal the filename (`nh-44` ↔ `nh-44.json`)
- National Highways: `nh-<number>` using the **current (post-2010) numbering**
- Expressways: full name, e.g. `yamuna-expressway`, `mumbai-pune-expressway`
- National expressways: `ne-<number>`
- State highways: `sh-<state code>-<number>`, e.g. `sh-mh-27`
- District roads: `mdr-<state code>-<number>`, `odr-<state code>-<number>`
- Anything else: descriptive, e.g. `east-coast-road`, `mc-road`

## Full field reference

```jsonc
{
  // ── REQUIRED ────────────────────────────────────────────────
  "id": "nh-44",
  "ref": "NH 44",                        // display designation: "NH 44", "Yamuna Expressway", "SH 49"
  "name": "Srinagar–Kanyakumari Highway",// common / descriptive name (use – en-dash between endpoints)
  "category": "nh",                      // "nh" | "expressway" | "sh" | "district" | "local"
  "status": "operational",               // "operational" | "under-construction" | "planned"
  "lengthKm": 3745,                      // number, official length
  "route": {
    "start": "Srinagar, Jammu & Kashmir",
    "end": "Kanyakumari, Tamil Nadu",
    "states": ["Jammu and Kashmir", "Punjab", "..."],   // full state/UT names, in order of traversal
    "majorCities": ["Srinagar", "Jammu", "Delhi", "..."] // 4–12 well-known places, in order
  },
  "waypoints": [                         // ordered start → end, drives the map geometry (see rules below)
    { "name": "Srinagar", "coords": [74.797, 34.084] },
    { "name": "Qazigund", "coords": [75.157, 33.639] }
  ],
  "sources": [                           // 1–4 links, official government pages ONLY (see rules below)
    { "title": "NHAI", "url": "https://nhai.gov.in/" }
  ],

  // ── OPTIONAL (omit anything you are not confident about) ───
  "aka": ["National Highway 7 (old numbering)"],  // older/common alternative names
  "completionPercent": 62,               // only for under-construction, only if publicly reported
  "lanes": "6 lanes, access-controlled", // free text, plain language
  "agency": "NHAI",                      // maintaining agency: NHAI / NHIDCL / state PWD / development authority
  "cost": "₹12,839 crore (approx.)",     // free text with ₹ crore
  "contractor": "Jaypee Infratech",      // main concessionaire/contractor if well known
  "tolls": [                             // notable toll plazas, if well known
    { "name": "Jewar toll plaza", "note": "near Jewar, Gautam Buddh Nagar",
      "rates": { "car": 165, "lcv": 260, "bus": 545 } }   // ₹, one way — see "Toll charges" below
  ],

  // ── OPTIONAL: what it costs to drive (v1.2) ──
  "tollInfo": {
    "tolled": true,                      // set false to state plainly that the road is free
    "asOf": "2026-04-01",                // when these rates took effect — REQUIRED with any rate
    "endToEnd": { "car": 490, "bus": 1560 },  // ₹ for the whole road, one way
    "note": "FASTag only; cash lanes are charged double.",
    "passes": ["Monthly pass for local cars: ₹340 per plaza"],
    "source": { "title": "NHAI toll notification", "url": "https://…" }
  },

  // ── OPTIONAL: who is behind the road (v1.2) — see ORGS.md ──
  "authority": "nhai",                   // org id — who owns and administers it
  "builtBy": [                           // who physically created it
    { "org": "larsen-toubro", "note": "packages 3–7" },
    { "name": "Sher Shah Suri's administration", "note": "16th century" }  // or a plain name
  ],
  "operatedBy": [                        // who runs and tolls it today
    { "org": "irb-infrastructure", "note": "30-year concession to 2042" }
  ],
  "helplines": [                         // numbers specific to THIS road (never invent one)
    { "kind": "control-room", "label": "Expressway control room", "number": "0120-2345678" }
  ],
  "timeline": [                          // 2–6 milestones, chronological
    { "year": "2001", "event": "Construction begins" },
    { "year": "2012", "event": "Opened to traffic" }
  ],
  "history": "One paragraph (3–6 sentences) of history and context, plain language.",
  "facts": [                             // 4–8 crisp, interesting, verifiable facts
    "India's longest national highway.",
    "Part of the North–South Corridor of the NHDP."
  ],

  // ── OPTIONAL richness fields (v1.1) — omit anything not confidently known ──
  "significance": "1–3 sentences on why this road matters: economy, defence, pilgrimage, daily life.",
  "engineering": [                       // notable structures: tunnels, big bridges, ghat sections
    { "name": "Chenani–Nashri Tunnel", "note": "9.28 km — India's longest road tunnel when it opened in 2017" }
  ],
  "interchanges": [                      // well-known junctions/interchanges, in route order
    { "name": "Kherki Daula (Gurugram)", "note": "junction for the Dwarka Expressway" }
  ],
  "relatedRoads": [                      // links to OTHER roads in this catalogue — id must be an existing file
    { "id": "delhi-mumbai-expressway", "label": "The new expressway alternative for Delhi–Mumbai traffic" }
  ],
  "travelNotes": "Practical driver info: typical end-to-end driving time, when it gets crowded, food/fuel stop culture, best season. Only widely known facts.",
  "futureUpgrades": [                    // officially announced plans only
    "Widening to 8 lanes announced for the Hyderabad–Bengaluru section."
  ],
  "newsQuery": "\"Yamuna Expressway\"",  // override for the news fetcher when ref+name alone would be ambiguous
  "provenance": "osm"                    // set ONLY on generated files; remove it once a human has written the road up
}
```

## Real alignments

`data/geometry/<id>.json` holds the road's true shape, as an encoded polyline:

```json
{ "type": "Polyline", "precision": 5, "lengthKm": 3679.6, "data": "…" }
```

The build prefers it over the waypoint polyline automatically, so `waypoints`
matter only for roads with no alignment on file. This directory sits outside
`public/` on purpose — it is a build input, not something browsers download.
Plain `{"type":"LineString"}` files also work, and the legacy
`public/data/geometry/` location is still read.

## Waypoint rules (these drive the map — get them right)

1. `coords` are `[longitude, latitude]` (GeoJSON order), 3+ decimal places.
2. Ordered from `route.start` to `route.end`. Real towns/cities/junctions **on or very near
   the actual alignment** — the map draws a smoothed line through them in order.
3. Count: long highways (>800 km) 20–40 waypoints; medium (150–800 km) 10–25;
   short/urban (<150 km) 5–12. Target spacing 15–80 km (2–10 km for urban roads).
4. Everything must be inside greater-India bbox: lng 67.5–97.6, lat 6.0–37.5.
5. Ring roads / orbital roads: repeat the first waypoint as the last one to close the loop.
6. Never invent places. If unsure of an intermediate town, use fewer, well-known waypoints.

## Source rules

## Toll charges

Rates are **₹ for one trip, one way**, per vehicle, and use the six standard
Indian toll classes:

| key | class |
|---|---|
| `car` | Car, jeep, van, light motor vehicle |
| `lcv` | Light commercial vehicle, light goods vehicle, mini-bus |
| `bus` | Bus or truck (2 axles) |
| `axle3` | 3-axle commercial vehicle |
| `hcm` | Heavy construction machinery / earth-moving equipment / 4-to-6-axle vehicle |
| `oversized` | Oversized vehicle (7 or more axles) |

Two-wheelers travel free on national highways, so there is no key for them.

Rules:

- Indian toll rates are revised **every year on 1 April**. Any road carrying rates
  must set `tollInfo.asOf`, and the page shows that date next to the table — a
  stale number the reader can date is useful; an undated one is a lie waiting to
  happen.
- Omit a class you do not know rather than guessing it. A partial table is fine.
- `"tolled": false` is a genuinely useful statement — city roads, BRO mountain
  roads and most state highways are free, and readers want to know that.
- The canonical source is NHAI's Toll Information System. `npm run tolls` pulls
  it (see [CORPUS.md](CORPUS.md)) — it only resolves from inside India.

## Emergency and complaint numbers

Road pages always show the national numbers (112 and 108) plus whatever the
road's `authority` organisation publishes — so a road needs no contact fields of
its own to be useful. Add road-level `helplines` only for a number that belongs
to that one road. **Never invent a phone number**; the rules are in
[ORGS.md](ORGS.md).

## Source rules

- Official government / authority pages only: `nhai.gov.in`, `morth.nic.in`, `pib.gov.in`,
  `nhidcl.com`, state PWD / development-authority sites (e.g. `upeida.up.gov.in`, `msrdc.org`).
- **Never fabricate a deep URL.** If you don't know the exact page, link the portal root
  (e.g. `https://nhai.gov.in/`) with an honest title (e.g. "NHAI — National Highways Authority of India").
- No Wikipedia, no news sites, no blogs in `sources`.

## Quality bar

- Only state facts you are confident are true. **Omit optional fields rather than guess.**
- Old vs new NH numbering matters: `ref` uses the current numbering; put old numbers in `aka`.
- Plain language throughout — a 10-year-old should understand every sentence. No GIS jargon.
- `lengthKm` should be the official figure; the validator warns if the waypoint polyline
  disagrees wildly with it.

## Validate

```
npm run data
```

Errors fail the build and name the file and field. Warnings are printed but non-fatal.
