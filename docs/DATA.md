# RoadTracker India — Road Data Specification (v1)

Every road on the site is a single JSON file:

```
public/data/roads/<id>.json
```

The build step (`npm run data`) validates every file, then derives:

- `public/data/index.json` — the search/browse index (one summary row per road)
- `public/data/network-lite.geojson` — simplified all-roads overview for the base map
- `public/data/shapes/<id>.json` — the display geometry for the selected-road animation

You never edit the derived files. **The road JSON is the single source of truth.**

## The `id`

- kebab-case, stable forever (it becomes the public URL `/road/<id>`)
- must equal the filename (`nh-44` ↔ `nh-44.json`)
- National Highways: `nh-<number>` using the **current (post-2010) numbering**
- Expressways: full name, e.g. `yamuna-expressway`, `mumbai-pune-expressway`
- State highways / other: descriptive, e.g. `east-coast-road`, `mc-road`

## Full field reference

```jsonc
{
  // ── REQUIRED ────────────────────────────────────────────────
  "id": "nh-44",
  "ref": "NH 44",                        // display designation: "NH 44", "Yamuna Expressway", "SH 49"
  "name": "Srinagar–Kanyakumari Highway",// common / descriptive name (use – en-dash between endpoints)
  "category": "nh",                      // "nh" | "expressway" | "sh" | "local"
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
    { "name": "Jewar toll plaza", "note": "near Jewar, Gautam Buddh Nagar" }
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
  "newsQuery": "\"Yamuna Expressway\""   // override for the news fetcher when ref+name alone would be ambiguous
}
```

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
