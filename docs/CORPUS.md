# Building the road corpus

RoadTracker aims to hold **every numbered road in India** — national highways,
national expressways, state highways, and the district roads that OpenStreetMap
has mapped. That is thousands of roads, so the catalogue is generated from OSM
and then enriched by hand, road by road.

```
fetch-osm-reference.mjs   state polygons + place names        ─┐
fetch-osm-roads.mjs       every route relation + its geometry ─┤
                                                              ├→ generate-roads.mjs
                                                              │      ↓
                                                              │  public/data/roads/<id>.json
                                                              │  data/geometry/<id>.json
                                                              │      ↓
                                                              │  fill-gaps.mjs (closes or marks stitch holes)
                                                              └→ build-data.mjs → index, network, shapes
```

Everything downloaded from Overpass lands in `.cache/` (gitignored). The two
generated outputs — road files and alignments — are committed.

## 1. Reference layers

```bash
node scripts/fetch-osm-reference.mjs
```

- `.cache/osm/states.json` — one entry per state/UT with simplified outer rings.
  Used to work out which states a road passes through, by sampling points along
  it and testing containment.
- `.cache/osm/places.json` — `place=city|town|suburb|village` nodes. Used for
  `route.start`, `route.end`, `route.majorCities` and waypoint names. The query
  is a bounding box, so it also holds towns in Pakistan, Nepal, Bhutan,
  Bangladesh and Myanmar; `generate-roads.mjs` drops every place outside an
  Indian state, or a road ending at a border crossing gets named after the town
  across it (NH 927 once ended at "Nepalgunj" rather than Rupaidiha).

Every state and every place band is cached separately, so a run that dies
partway costs only the piece it was on. Re-run it to fill the gaps; add
`--force` to refetch everything.

## 2. Route relations and alignments

```bash
node scripts/fetch-osm-roads.mjs --list     # enumerate and group only
node scripts/fetch-osm-roads.mjs            # + download geometry
```

The listing query pulls every `type=route, route=road` relation whose `network`
starts with `IN:`, then groups them into **designations** — one road per
`NH 44`, per `SH 27` in Maharashtra, and so on. Three things make this fiddly:

- **Refs are tagged a dozen ways.** `NH 44`, `nh44`, `MDR002`, `O6901` (Tamil
  Nadu ODR), `MD2112` (Madhya Pradesh MDR), `SHU171` (State Highway Urban).
  `parseRef()` handles the class prefix, the number, and any variant letter.
- **Historical alignments are tagged like current ones.** Anything whose name
  says "old" and which carries only a `ref:old` is dropped — the site uses the
  post-2010 numbering.
- **One road is many relations.** NH 44 is thirteen: per state, per stretch,
  plus a whole-route one, and divided highways appear as two parallel
  carriageways. Merging them naively doubled NH 44 from 3,745 km to 6,800 km.

That last one is what `collectWays()` fixes: deduplicate by OSM way id, then
**geometrically** — rasterise each way to ~275 m cells, take ways longest-first,
and drop any way already ≥75% covered by ways taken. The opposite carriageway
and the overlapping relations disappear; lengths land within a few percent of
the official figures.

Chunks are built from **whole roads** — every relation a road is made of has to
arrive in the same response, or its alignment comes back missing the stretches
those relations described. (An earlier version chunked by bounding box and
quietly shortened NH 44 from 3,680 km to 2,630 km.)

Interrupt it freely. Alignments are cached per road in `.cache/osm/routes/`, so
a re-run picks up where it stopped. `--bulk` skips a road that is already
cached, so the way to repair a suspect alignment is to delete its cache file
and run again, or to name it: `--only nh-709a,sh-up-93` refetches just those
roads, cached or not, and keeps the cached relation list (`--force` would query
every relation in India again). A query that times out or runs out of memory on the server still
comes back as HTTP 200, with an empty or partial answer and a `runtime error`
remark. The client treats that as a failure, so nothing from it is cached and
the next run fetches the road again.

### Gaps, bridges, and what `lengthKm` means

OSM maps many roads in disconnected pieces. `stitch()` joins them, and the
straight line it draws across a gap is a **bridge** — drawn so the road reads as
one road, but never counted:

```
lengthKm  = length of the assembled line − bridged
bridgedKm = how much of it was invented to close gaps
```

Counting bridges as road overstated 248 roads, one Kerala state highway by
164 km. How far a bridge may reach depends on whether the road has a number:

- **Numbered** (NH 44, SH 27, MDR 12) — up to 100 km. The designation is
  evidence that both pieces are the same road. Capping this tightly threw away
  a thousand kilometres of real NH 44.
- **Named, no number** ("Temple Road") — 4 km, and anything further is emitted
  as its own road (`-2`, `-3`). Two Kerala relations both called "Temple Road"
  are two roads 31 km apart; welding them produced a 32.4 km "road" that was
  97% straight line across empty ground.

Every gap counts, whichever pass of `stitch()` closes it, and a piece split off
as its own road has its own bridges subtracted. An earlier version counted only
gaps over 12 km, so a 10 km gap came out as 20 km of road and named roads were
welded across gaps of up to 12 km.

**A straight road must not look like a bridge.** The line is simplified twice,
to 20 m here and to 30 m by `generate-roads.mjs`, and tolerance alone leaves a
dead-straight road (Rajasthan and Punjab have plenty over 20 km) as one
segment. That is exactly what a bridge looks like to the `gap` gate in
docs/DATA.md. So both passes also keep a real vertex at least every 5 km
(`MAX_SEGMENT_KM` in `lib/overpass.mjs`). A bridge has no vertices between its
ends to keep, so it still comes out as one segment and the gate still sees it.
Alignments cached before 2026-10-21 were simplified without this rule; fetch
one again with `--only` if the gate reads a straight road as a hole.

`lengthKm` is therefore the road we can actually see, not the ministry's
published figure. For most national highways the two agree within 1–3%. Where
OSM's route relations only cover part of a road they diverge sharply: NH 6 and
NH 7 come out around 37% of official, because that is how much of them is
mapped. Writing the official figure in is enrichment work, and doing so makes
the road hand-authored.

### Repaired alignments

Fetching again does not fix every bad line. Sometimes the relation itself runs
on along another road (NH 31 into Malda on NH 131A), leaves out a section OSM
maps only as tagged ways (all of NH 39 in Jharkhand), or dedupe drops the one
way that closes a ring (Pune Ring Road). Those lines are rebuilt by hand,
written straight to `data/geometry/<id>.json`, and listed in
`data/curated-geometry.json` with the reason:

```json
{ "nh-31": { "why": "Corpus line cut at Samsi. …", "date": "2026-10-21" } }
```

`generate-roads.mjs` never writes the alignment of a listed road, whatever the
cache holds, and its summary says how many it kept. A listed road with no
`data/geometry` file is named in the log. To give a road back to the generator,
delete its entry. If the cached line is the broken one, delete its cache file
as well and fetch it again.

### Holes: closed, or left undrawn

A bridge is right for measuring a road and wrong for drawing one. Drawn, it is a
dead-straight highway across fields: NH 148B ran 58 km straight from Kotputli to
Baroda Meo, where the real road is the Paniyala–Barodameo expressway, still
being built and only mapped at its two ends. So after every generator run:

```bash
node scripts/fill-gaps.mjs                 # every line in data/geometry
node scripts/fill-gaps.mjs --only nh-148b  # just these
node scripts/fill-gaps.mjs --dry           # report only
```

For every segment over 5 km it asks a router (the OSRM demo server, OSM data,
one request a second) for the road between the segment's two ends. A router
keeps to one-way carriageways, so when the first answer is not the segment
itself it asks again: the other way round, then with both ends held to a
direction of travel (`bearings`) — a to b within 90°, b to a within 30°, a to b
within 30° — stopping at the first answer that runs along the segment. The held
routes are for a line whose two pieces lie on opposite carriageways, as the
Samruddhi Mahamarg's did all along its length: from either end the plain route
runs on to an interchange and back, 70 km for 23.7 km of expressway, and the
hole was left undrawn. The narrow ones are for an interchange, where 90° takes
the slip road beside the carriageway. Of the answers, the shortest one
`judge()` takes wins:

- **The road is the segment itself** — a straight road from a line cached before
  the 5 km vertex rule. Points go in along it, so the gate stops reading it as
  a hole.
- **A route `judge()` takes for this road** replaces the bridge, and a measured
  `lengthKm` grows by the road filled in — never past the drawn line, because
  August's lines counted some bridges as road already, and never down, since
  correcting those old figures is a separate job. It must be at most 1.3× the bridge
  plus 2 km, or 2× plus 5 km when half of it is the road itself (mountain roads
  wind). The road itself is any leg whose number or name is one the road goes
  by: its `ref`, `name`, `aka`, and the ids merged into it (`ne-1`), because OSM
  numbers the Samruddhi Mahamarg ME-2 and the road file calls it by name. A
  state or district road may not run more than 10 km mostly on another number:
  SH 20 Jhajjar–Sonipat has 9 km left in OSM, and the road between its pieces
  is NH 334B now, not SH 20. A national highway may run on another national or
  state highway's number, since it shares tarmac with another for miles or was
  declared over a state highway OSM still numbers the old way — but not on a
  district road. Where the line's own road already reaches an end of the hole,
  the hole is a stitch jumping back, and a route mostly on other roads between
  them is the corridor drawn twice or a loop closed (NH 179B's Harur–Salem
  corridor, SH 128 round the Ballari bypass). Such a refusal holds for every
  longer route along the same roads, since how a router splits its steps
  decides how much of a route carries a number. An expressway hole is filled
  only by the expressway (the demo server reports no road classes, so in
  practice by its number or name). A road being built is filled only along its
  own mapped road, and a planned one by nothing at all — which is why
  `data/road-status.json` exists: OSM maps a greenfield highway's alignment
  years before it opens, the generator calls every road operational, and NH
  544G's unbuilt stretches came out drawn along village roads. The generator
  takes a road's status from that file. A ferry, a route back along the line
  (NH 709B's stitch jumped back to a stub of road it had already drawn), or one
  out to a U-turn and back down the other carriageway is refused. A route that
  sets off the wrong way and turns round is judged, and drawn, from where it
  last passes the hole's start to where it first reaches its end.
- **Anything else stays a hole.** Its index goes in the line's `holes` list, and
  the build keeps it in the line for measuring but never draws it
  (docs/DATA.md). A road with holes shows as pieces, which is what OSM knows.

Every route is cached in `.cache/osm/gaps/`, so the run after a regeneration
asks the router nothing, and `.cache/osm/gaps/report.json` lists every hole
filled or left, with the reason. Curated lines go through it too: the script
only adds points or marks holes, it never redraws what is already road.

## 3. Generate the road files

```bash
node scripts/generate-roads.mjs --dry   # report what would change
node scripts/generate-roads.mjs
```

For each cached alignment this derives states traversed, start and end towns,
major cities along the way, and waypoints — then writes the road file **only if
no hand-authored one exists**. Generated files carry `"provenance": "osm"`,
which is also how the generator recognises its own output on the next run.

To promote a generated road to a hand-authored one: fill in `history`, `facts`,
`timeline`, real `sources`, and delete the `provenance` key. It will never be
touched again. In practice the generator already leaves alone any file carrying
a key it does not produce, so adding `history` is enough to protect a road.

## 4. Roads the ref query cannot find

The corpus is enumerated by highway **ref** — "NH 44", "SH 27" — which is the
only way to pull thousands of roads in an afternoon. A city's arterials have no
ref. Bengaluru's Outer Ring Road is called "Outer Ring Road", and so is
Chennai's, and Hyderabad's; no query separates them. Those are named one at a
time, by OSM relation id:

```bash
node scripts/add-named-road.mjs                 # everything in its table
node scripts/add-named-road.mjs --only bengaluru-outer-ring-road
node scripts/add-named-road.mjs --geometry-only # existing roads, alignment only
```

It writes a stage-1 cache entry, so `generate-roads.mjs` then derives the route,
waypoints and major cities exactly as it does for every other road. Add an entry
to the `NAMED_ROADS` table at the top of the script to catalogue a new one.

## 5. Roads that turn out to be the same road

OpenStreetMap often carries one road twice: once under its expressway number and
once under its common name. `data/merged-roads.json` records which id won, e.g.
`"ne-4": "delhi-mumbai-expressway"`. That one file does three things — the
generator skips the merged ids so an `--overwrite` run cannot bring them back,
the build ships the map in `index.json` so `/road/ne-4/` still resolves, and
`gen-pages.mjs` stamps a page for the old id whose canonical tag points at the
new one.

Before merging, check the claim against the geometry rather than the name: two
records are the same road when one alignment is almost entirely inside the
other's, not when their numbers look related.

## 6. Toll rates

```bash
node scripts/fetch-toll-rates.mjs --dry   # report what would change
npm run tolls                             # write
```

Pulls the official rate card for every plaza from NHAI's Toll Information
System and writes it into the road files. **It only answers from inside
India** — from anywhere else the request times out and the script exits without
touching anything.

A plaza is attached to a road only when the NH number matches *and* the plaza's
coordinates sit within 6 km of that road's alignment. The number alone is not
enough: highways were renumbered in 2010 and TIS still carries old numbers in
places, which would otherwise staple Delhi plazas onto a Tamil Nadu highway.
The number is matched in full, so a plaza on NH 348BB goes to that spur and
never to NH 348B, which it starts from. Distance is measured to the drawn line,
not to its vertices, which can be tens of kilometres apart on a straight stretch.

Hand-authored rates win. A road that already has `tollInfo.asOf` is left alone
unless you pass `--force`, and a road marked `"tolled": false` is never
silently contradicted — the script warns and moves on. A plaza already listed by
hand keeps its name and note and only gains the TIS rates. One that TIS does not
list stays in the file, without rates.

## Attribution

Route geometry, road names and place names come from OpenStreetMap contributors
and are used under the ODbL. Every generated road page says so.
