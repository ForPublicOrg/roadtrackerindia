# Data licence

This repository is licensed in two parts, because the code and the road
catalogue come from different places.

| What | Where | Licence |
| --- | --- | --- |
| Software | `src/`, `api/`, `scripts/`, `docs/` | MIT — see [LICENSE](LICENSE) |
| Road catalogue | `public/data/` | ODbL 1.0 — see below |

## Why the data is not MIT

Every road in `public/data/roads/` was generated from OpenStreetMap route
relations, and `public/data/geometry/` and `public/data/india-boundary.geojson`
are alignments taken straight from OSM ways. That makes the catalogue a
**Derived Database** under the [Open Database License 1.0][odbl], which is
share-alike: it can be used, changed and redistributed by anyone, including
commercially, but a database derived from it has to stay under ODbL and has to
credit OpenStreetMap.

Relicensing that data as MIT is not something this project is able to do.

**Full ODbL text:** https://opendatacommons.org/licenses/odbl/1-0/

## Attributing it

Anywhere the map or the catalogue is shown:

> Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL ·
> Road catalogue © RoadTracker India contributors, ODbL

The site does this in the map's attribution control, and every road page links
the official sources — NHAI, MoRTH, PIB and state authorities — that its written
sections were compiled from.

## The written entries

The editorial text on each road — history, why it matters, engineering
highlights, good to know — is original writing rather than OSM-derived, and is
released under [CC BY 4.0][ccby]: reuse it anywhere with credit.

## Everything else on the page

- Vector tiles: [OpenFreeMap](https://openfreemap.org), from OpenStreetMap data.
- Fonts: Inter and Fraunces, both SIL Open Font License 1.1.
- Per-road news snapshots in `public/data/news/`: headlines, publishers and links
  only, from Google News RSS. Those headlines belong to their publishers and are
  not covered by any licence here.

[odbl]: https://opendatacommons.org/licenses/odbl/1-0/
[ccby]: https://creativecommons.org/licenses/by/4.0/
