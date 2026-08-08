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
  `route.start`, `route.end`, `route.majorCities` and waypoint names.

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
and run again.

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

`lengthKm` is therefore the road we can actually see, not the ministry's
published figure. For most national highways the two agree within 1–3%. Where
OSM's route relations only cover part of a road they diverge sharply: NH 6 and
NH 7 come out around 37% of official, because that is how much of them is
mapped. Writing the official figure in is enrichment work, and doing so makes
the road hand-authored.

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
touched again.

## 4. Toll rates

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

Hand-authored rates win. A road that already has `tollInfo.asOf` is left alone
unless you pass `--force`, and a road marked `"tolled": false` is never
silently contradicted — the script warns and moves on.

## Attribution

Route geometry, road names and place names come from OpenStreetMap contributors
and are used under the ODbL. Every generated road page says so.
