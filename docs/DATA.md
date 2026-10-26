# RoadTracker India — Road Data Specification (v1)

Every road on the site is a single JSON file:

```
public/data/roads/<id>.json
```

The build step (`npm run data`) validates every file, then derives:

- `public/data/index.json` — the search/browse index (one summary row per road)
- `public/data/network-lite.geojson` — the trunk network (expressways, NHs, city roads)
- `public/data/network-detail.geojson` — state + district roads, loaded only when the map zooms in
- `public/data/shapes/<id>.json` — the display geometry for the selected-road animation, and
  the stops its reviews are tied to (see [Stretches](#stretches))

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
  "newsQuery": "\"Atal Setu\" Mumbai",   // first Google News query; quoted = names, the rest = places that disambiguate them (docs/NEWS.md)
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

A line can carry `"holes": [13, …]`: segments with no road under them, each
named by the index of the point that ends it (so `13` is the segment from point
12 to point 13). They are straight lines the OSM stitching drew across ground
OSM maps no road on, written by `scripts/fill-gaps.mjs` when it could not close
them (docs/CORPUS.md). A hole stays in the line, because stops and review
ranges are measured along it, but it is never drawn: the overview networks
carry the road as a `MultiLineString` of the pieces between its holes, and its
shape lists them as `gaps` (the same, as indices into the shape) for the
browser to leave out of the selected road and its stretches.

## Stretches

A review belongs to a **stretch** of road between two of its main stops —
"Delhi → Agra" on NH 44 — because 3,745 km is not one drive. `npm run data`
works out each road's stops and writes them into its shape:

```jsonc
{
  "type": "Feature",
  "properties": {
    "id": "nh-44",
    "real": true,
    "km": 3658,                          // length of the coordinates below
    "stops": [                           // road order, from km 0 to "km"
      { "n": "Srinagar", "k": "srinagar", "km": 0 },
      { "n": "Jammu", "k": "jammu", "km": 232.6 },
      { "n": "Kanyakumari", "k": "kanyakumari", "km": 3658 }
    ],
    "marks": [["qazigund", 56.4], ["banihal", 81.4]]   // every other place on the line
  },
  "geometry": { "type": "LineString", "coordinates": [[74.8601, 34.03571], …] }
}
```

- `n` is the name shown, `k` the **key** a review is stored under (a range is
  two keys: `delhi>agra` driven from Delhi, or the old `agra--delhi`, road order — see
  [FIREBASE.md](FIREBASE.md#how-ratings-are-stored)), `km` how far along the
  line the stop is.
- A key is the place name folded to `a-z`, `0-9` and single dashes, with accents
  and anything in brackets dropped, cut at 40 characters, and made unique with
  `-2`, `-3`… in km order. Every place on the line gets one, stop or not, so a
  key never depends on which places end up as stops — and `marks` ships the km
  of the ones that are not, so a stored review still finds its stretch after a
  rule change (or a new `majorCities` entry) moves the stops.
- A road with no stretches has no `stops` or `marks`, and its reviews are for
  the whole road. `km` is always there.

**Which way the line runs.** Every shape runs from `route.start` to
`route.end`. A line drawn the other way (about half the hand-written ones, NH 44
among them) is turned round before it is simplified, so the shape and the
network files agree. An open road is judged by its ends: whichever pairing of
line ends and first/last waypoint is closer by more than 5 km wins. If neither
is, it goes by a vote of consecutive waypoints — further along the line, or
back. A **loop** goes by the vote too, and is cut at its first stop so km 0 is
a place. A loop is a line whose ends are under 1 km apart *and* a road that
says it goes round (`route.start` equals `route.end`, or its first and last
waypoints are close); a ring road whose line is a broken arc is an open road.

**Which places become stops.**

1. Every waypoint, plus an open road's termini as `route.start`/`route.end`
   name them (the text before the first comma, placed at the first and last
   waypoint — one place, if the names match). An open road that starts and ends
   in one city — a ring road drawn as an arc — is named at its ends after its
   first and last waypoints instead, since the city is neither end. A loop's
   places are its waypoints. A place more than 15 km off the line is dropped.
2. The main stops are the places whose name matches a `majorCities` entry —
   equal, or the entry is whole words of it ("Kengeri Bengaluru" is Bengaluru)
   — shown under that entry's spelling. Matching ignores case, accents,
   punctuation, a trailing "area" and anything in brackets. A brackets-only
   city still counts once: an entry that no place matches by name goes to the
   first place, in road order, whose brackets name it exactly, with a leading
   "near" ignored — "Duhai (Ghaziabad)" is Ghaziabad, "Kudrail (near Etawah)"
   is Etawah, but "Bajghera (Delhi–Haryana border)" is not Delhi. Its key stays
   its own (`duhai`). The order of `majorCities` does not matter. With fewer
   than two places matched, every place is a main stop.
3. A main stop out of order along the line is dropped — its waypoint is in the
   wrong place.
4. An open road's termini are its first and last stop, at km 0 and the end of
   the line. A loop starts and ends at its first main stop.
5. Stops under 10 km apart are one stop (an end always stays).
6. A stretch over 250 km is split at the waypoint nearest its middle (one that
   is not a main stop, and at least 10 km from both ends), longest first, while
   there are fewer than 17 stops.
7. Over 17, the stop whose loss leaves the shortest stretch goes, until 17.
8. No two stops go by one name (compared as in step 2), because a stretch
   called "Diu → Diu" tells a reader nothing. The one repeat is a loop's last
   stop, which is its first again. When two clash, a place that went by a city
   only because the city is whole words of its name goes back to its own
   ("East Kolkata Wetlands", not a second Kolkata); otherwise the one that is
   not an end of the road stops being a stop and stays a mark.

**The quality gate.** Stops in the wrong place would be worse than none, so a
road whose line fails any of these gets no stops at all, and whole-road reviews
only. The build counts each by the reason it prints:

| reason | the road fails when |
|---|---|
| `short` | it is under 25 km |
| `length` | its line is not 0.8–1.25× `lengthKm` |
| `ends` | an open road's line starts or ends over 25 km from its first or last waypoint, or both its ends go by one name (a loop whose line does not close) |
| `off-line` | fewer than 70% of its waypoints are within 15 km of the line |
| `gap` | its `data/geometry` line, before it is simplified, has one straight segment over 20 km that is also over 4% of the line: a hole the OSM stitching jumped. The corpus keeps a real vertex at least every 5 km of a straight road (docs/CORPUS.md), so only a bridge is that long. A line drawn from waypoints is not checked, and neither is a greenfield straight that is a sliver of a long road (the Samruddhi Mahamarg's 24 km of 700) |
| `retrace` | over 40% of the line, sampled every 500 m, lies within 150 m of another part of it more than 5 km further on or back: out along a road and back down it (NH 744A). Loops are checked too, so a road that ends where it starts is not cut as a loop when its line only goes there and back |
| `order` | fewer than 80% of its main stops are in order along the line |
| `stops` | fewer than 3 stops are left |

The summary line reads `stretches: N roads, M flipped, K gated out (short …,
stops …, gap …)`. It names every hand-written road that missed, and warns for
every reason but `short` and `stops`: the rest mean the line or its waypoints
are wrong, which is worth fixing.

To give a hand-written road stretches:

- Stops come from waypoints, not from `majorCities`. Each town you want as a
  stop must be a waypoint, in road order, whose name is a `majorCities` entry,
  holds it as whole words, or names it in brackets.
- At least two waypoints must match, or every waypoint is a main stop. If only
  the two termini match, the road gets a middle stop only where a stretch would
  be over 250 km.
- Keep the first and last waypoints where the road really ends.
- Stops under 10 km apart merge, so a short city road with its places close
  together can end up with too few. That is `stops`, and it is fine.
- Any other reason means the line or the waypoints are wrong: fetch the line
  again with `npm run fetch-geometry`, or fix the waypoints.
- A line you rebuild by hand goes in `data/geometry/<id>.json`, and its id goes
  in `data/curated-geometry.json` with the reason. Otherwise the next corpus
  regeneration writes the old line back from the cache (docs/CORPUS.md,
  "Repaired alignments"). Once `npm run data` runs, the road should be gone
  from the hand-written gated list.

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
