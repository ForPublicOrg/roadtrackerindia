#!/usr/bin/env node
/**
 * Stage 2 of the corpus build: turn every cached OSM alignment into a road file.
 *
 *   node scripts/generate-roads.mjs              # write everything missing
 *   node scripts/generate-roads.mjs --dry        # report only
 *   node scripts/generate-roads.mjs --overwrite  # also rewrite generated files
 *
 * Reads  .cache/osm/routes/<id>.json   (stage 1: fetch-osm-roads.mjs)
 * Reads  .cache/osm/states.json        (reference layer)
 * Reads  .cache/osm/places.json        (reference layer)
 * Writes public/data/roads/<id>.json   (only where no hand-authored file exists)
 * Writes data/geometry/<id>.json       (encoded polyline, the build's real alignment)
 *
 * Hand-authored roads are never overwritten — they carry history, facts and
 * sources that no automatic pass can produce. Data © OpenStreetMap contributors.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ROOT, cachePath, encodePolyline, haversineKm, lineLengthKm, readCache, round5, simplify,
} from './lib/overpass.mjs'

const DRY = process.argv.includes('--dry')
const OVERWRITE = process.argv.includes('--overwrite')

const ROADS_DIR = join(ROOT, 'public', 'data', 'roads')
const GEOM_DIR = join(ROOT, 'data', 'geometry')
const LEGACY_GEOM_DIR = join(ROOT, 'public', 'data', 'geometry')
mkdirSync(GEOM_DIR, { recursive: true })

// ── reference layers ─────────────────────────────────────────────────

const states = readCache('states.json') ?? []
const places = readCache('places.json') ?? []
if (!states.length || !places.length) {
  console.error('Missing reference layers — run: node scripts/fetch-osm-reference.mjs')
  process.exit(1)
}

/** Ray-casting point-in-ring. */
function inRing(pt, ring) {
  const [x, y] = pt
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function stateAt(pt) {
  for (const st of states) {
    const [minX, minY, maxX, maxY] = st.bbox
    if (pt[0] < minX || pt[0] > maxX || pt[1] < minY || pt[1] > maxY) continue
    for (const ring of st.rings) if (inRing(pt, ring)) return st.name
  }
  return null
}

// place lookup grid — ~5.5 km cells
const PCELL = 0.05
const placeGrid = new Map()
places.forEach((p, i) => {
  const key = `${Math.floor(p.c[0] / PCELL)}:${Math.floor(p.c[1] / PCELL)}`
  const bucket = placeGrid.get(key)
  if (bucket) bucket.push(i)
  else placeGrid.set(key, [i])
})

const KIND_RANK = { city: 4, town: 3, suburb: 2, village: 1 }
const importance = (p) => (KIND_RANK[p.k] ?? 0) * 1e7 + (p.p || 0)

// ── route geometry helpers ───────────────────────────────────────────

/** Walk the alignment, emitting a point roughly every `stepKm`. */
function sampleAlong(coords, stepKm) {
  const out = [{ pt: coords[0], km: 0 }]
  let acc = 0
  let carried = 0
  for (let i = 1; i < coords.length; i++) {
    const d = haversineKm(coords[i - 1], coords[i])
    acc += d
    carried += d
    if (carried >= stepKm) {
      out.push({ pt: coords[i], km: acc })
      carried = 0
    }
  }
  const last = coords[coords.length - 1]
  if (out[out.length - 1].pt !== last) out.push({ pt: last, km: acc })
  return out
}

/** Places within `radiusKm` of the alignment, with their distance along it. */
function placesAlong(samples, radiusKm) {
  const found = new Map() // place index → { km, dist }
  const halo = Math.max(1, Math.ceil(radiusKm / 5.5))
  for (const s of samples) {
    const cx = Math.floor(s.pt[0] / PCELL)
    const cy = Math.floor(s.pt[1] / PCELL)
    for (let dx = -halo; dx <= halo; dx++) {
      for (let dy = -halo; dy <= halo; dy++) {
        const bucket = placeGrid.get(`${cx + dx}:${cy + dy}`)
        if (!bucket) continue
        for (const idx of bucket) {
          const dist = haversineKm(s.pt, places[idx].c)
          if (dist > radiusKm) continue
          const prev = found.get(idx)
          if (!prev || dist < prev.dist) found.set(idx, { km: s.km, dist })
        }
      }
    }
  }
  return [...found.entries()]
    .map(([idx, v]) => ({ ...places[idx], ...v }))
    .sort((a, b) => a.km - b.km)
}

/** Best place in each of `n` equal stretches of the route, in route order. */
function pickAlong(along, n, totalKm) {
  if (!along.length) return []
  const bins = new Map()
  for (const p of along) {
    const bin = Math.min(n - 1, Math.floor((p.km / Math.max(totalKm, 0.001)) * n))
    const best = bins.get(bin)
    // prefer the important place, then the one closest to the road
    const score = importance(p) - p.dist * 1000
    if (!best || score > best.score) bins.set(bin, { p, score })
  }
  const seen = new Set()
  return [...bins.keys()]
    .sort((a, b) => a - b)
    .map((k) => bins.get(k).p)
    .filter((p) => {
      const key = p.n.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

const nearestPlace = (pt, { radiusKm = 60, exclude = null } = {}) => {
  let best = null
  const halo = Math.ceil(radiusKm / 5.5)
  const cx = Math.floor(pt[0] / PCELL)
  const cy = Math.floor(pt[1] / PCELL)
  for (let dx = -halo; dx <= halo; dx++) {
    for (let dy = -halo; dy <= halo; dy++) {
      for (const idx of placeGrid.get(`${cx + dx}:${cy + dy}`) ?? []) {
        const p = places[idx]
        if (exclude && p.n.toLowerCase() === exclude.toLowerCase()) continue
        const d = haversineKm(pt, p.c)
        // radiusKm sized the search box; it has to bound the answer too, or a
        // road's endpoint gets named after a town in the next state
        if (d > radiusKm) continue
        if (!best || d < best.d) best = { d, p }
      }
    }
  }
  return best?.p ?? null
}

/**
 * "Place, State" for an endpoint. The state is taken from where the *place*
 * is, not from where the road ends — otherwise a town just over a border gets
 * labelled with the neighbouring state's name.
 */
function endpointLabel(place, fallbackState) {
  return `${place.n}, ${stateAt(place.c) ?? fallbackState}`
}

// ── road file assembly ───────────────────────────────────────────────

const SOURCES = {
  national: [
    { title: 'NHAI — National Highways Authority of India', url: 'https://nhai.gov.in/' },
    { title: 'Ministry of Road Transport & Highways', url: 'https://morth.nic.in/' },
  ],
  state: [{ title: 'Ministry of Road Transport & Highways', url: 'https://morth.nic.in/' }],
}

const CLASS_LABEL = {
  nh: 'National Highway',
  expressway: 'Expressway',
  sh: 'State Highway',
  district: 'District road',
}

/** Fallback for alignments cached before stage 1 recorded the road class. */
const classOf = (route) =>
  ({ nh: 'NH', expressway: 'Expressway', sh: 'SH', district: 'MDR' })[route.category] ?? 'Road'

function targetCityCount(km) {
  if (km < 40) return 3
  if (km < 150) return 5
  if (km < 400) return 7
  if (km < 900) return 9
  return 12
}

function waypointCount(km) {
  if (km < 150) return 8
  if (km < 800) return 18
  return 34
}

function build(route) {
  const coords = route.coords
  const km = route.lengthKm
  const samples = sampleAlong(coords, Math.max(0.5, Math.min(5, km / 400)))

  // states, in the order the road first enters them
  const seenStates = new Map()
  for (const s of samples) {
    const st = stateAt(s.pt)
    if (!st) continue
    const hit = seenStates.get(st)
    if (hit) hit.count++
    else seenStates.set(st, { first: s.km, count: 1 })
  }
  const stateList = [...seenStates.entries()]
    .filter(([, v]) => v.count >= 2 || seenStates.size === 1)
    .sort((a, b) => a[1].first - b[1].first)
    .map(([k]) => k)
  if (!stateList.length) {
    const fallback = stateAt(coords[0]) ?? stateAt(coords[coords.length - 1])
    if (!fallback) return null
    stateList.push(fallback)
  }

  // places near the route
  const radius = km < 50 ? 4 : km < 300 ? 7 : 10
  const along = placesAlong(samples, radius)
  const cities = pickAlong(along, targetCityCount(km), km).map((p) => p.n)

  const last = coords[coords.length - 1]
  // A ring road ends where it starts. Forcing a second, different town onto
  // that same point would claim the road runs between two places when it runs
  // between one and itself.
  const isRing = coords.length > 4 && km >= 5 && haversineKm(coords[0], last) < 1

  const startPlace = nearestPlace(coords[0], { radiusKm: 45 }) ?? along[0]
  // A short road often has the same town nearest to both ends. Naming it twice
  // says nothing, so the far end falls back to the nearest *different* place.
  let endPlace = nearestPlace(last, { radiusKm: 45 }) ?? along[along.length - 1]
  if (!isRing && startPlace && endPlace && endPlace.n === startPlace.n) {
    endPlace = nearestPlace(last, { radiusKm: 90, exclude: startPlace.n }) ?? endPlace
  }
  if (!startPlace || !endPlace) return null
  const start = endpointLabel(startPlace, stateAt(coords[0]) ?? stateList[0])
  const end = isRing
    ? start
    : endpointLabel(endPlace, stateAt(last) ?? stateList[stateList.length - 1])

  const majorCities = [...new Set([startPlace.n, ...cities, endPlace.n])]
  if (majorCities.length < 2) {
    // a ring, or a road whose whole length sits beside one town — name the
    // next nearest place from its midpoint so there is something to steer by
    const mid = coords[Math.floor(coords.length / 2)]
    const other = nearestPlace(mid, { radiusKm: 60, exclude: startPlace.n })
    if (other) majorCities.push(other.n)
  }
  if (majorCities.length < 2) return null

  // waypoints: real places along the route, endpoints always included
  const wpPlaces = pickAlong(along, waypointCount(km), km)
  const waypoints = []
  const pushWp = (name, pt) => {
    const last = waypoints[waypoints.length - 1]
    if (last && (last.name === name || haversineKm(last.coords, pt) < 0.05)) return
    waypoints.push({ name, coords: [round5(pt[0]), round5(pt[1])] })
  }
  pushWp(startPlace.n, coords[0])
  for (const p of wpPlaces) {
    // place the waypoint on the road, not at the town centre
    const idx = samples.reduce(
      (best, s, i) => (Math.abs(s.km - p.km) < Math.abs(samples[best].km - p.km) ? i : best),
      0,
    )
    pushWp(p.n, samples[idx].pt)
  }
  pushWp(endPlace.n, coords[coords.length - 1])
  if (waypoints.length < 2) return null

  // A named road ("Iritty - Nedumpoil Road") has no designation number, so its
  // badge shows the road class and its title shows the name. A numbered road
  // shows "SH 27" on the badge and gets a descriptive title instead.
  const named = route.named === true
  const ref = named ? (route.class ?? classOf(route)) : route.ref
  const name = named
    ? route.ref
    : isRing
      ? `${startPlace.n} ring road`
      : `${startPlace.n}–${endPlace.n} ${CLASS_LABEL[route.category] ?? 'road'}`

  const road = {
    id: route.id,
    ref,
    name,
    category: route.category,
    status: 'operational',
    lengthKm: Math.round(km * 10) / 10,
    route: { start, end, states: stateList, majorCities },
    waypoints,
    sources: route.authority === 'national' ? SOURCES.national : SOURCES.state,
    provenance: 'osm',
  }
  // Who owns, built, operates and tolls a road is modelled properly by the
  // organisation profiles (docs/ORGS.md) — guessing "<State> PWD" here would
  // just put a second, weaker answer in the way. Left blank on purpose.
  return road
}

// ── main ─────────────────────────────────────────────────────────────

const routeFiles = existsSync(cachePath('routes')) ? readdirSync(cachePath('routes')) : []
if (!routeFiles.length) {
  console.error('No cached alignments — run: node scripts/fetch-osm-roads.mjs')
  process.exit(1)
}

/** Exactly the keys this script produces. Anything else is human work. */
const GENERATED_KEYS = new Set([
  'id', 'ref', 'name', 'category', 'status', 'lengthKm', 'route', 'waypoints', 'sources',
  'provenance',
  // an earlier version guessed "<State> PWD" here; listed so those files stay
  // rewritable and lose it on the next pass
  'agency',
])

/**
 * A road is off limits if it was written by hand, or if anyone has since added
 * something the generator cannot produce — history, tolls, an authority. That
 * check is what makes `--overwrite` safe to run at any time.
 */
const authored = new Set()
for (const f of readdirSync(ROADS_DIR)) {
  if (!f.endsWith('.json')) continue
  const id = f.replace(/\.json$/, '')
  try {
    const existing = JSON.parse(readFileSync(join(ROADS_DIR, f), 'utf8'))
    const enriched = Object.keys(existing).some((k) => !GENERATED_KEYS.has(k))
    if (existing.provenance !== 'osm' || enriched) authored.add(id)
  } catch {
    authored.add(id)
  }
}
console.log(`${authored.size} hand-authored or enriched roads will be preserved.`)

const stats = {
  written: 0, geometry: 0, skippedAuthored: 0, tooShort: 0, empty: 0, noPlace: 0, unreadable: 0,
}

let pointTotal = 0

for (const file of routeFiles) {
  if (!file.endsWith('.json')) continue
  let route
  try {
    route = JSON.parse(readFileSync(cachePath('routes', file), 'utf8'))
  } catch (e) {
    // one truncated cache file must not abort a 7,700-road run
    console.log(`  ! ${file}: unreadable cache entry (${e.code ?? e.name}) — re-fetch this road`)
    stats.unreadable++
    continue
  }
  if (!route.coords?.length || route.lengthKm <= 0) {
    stats.empty++
    continue
  }
  if (route.lengthKm < 1) {
    stats.tooShort++
    continue
  }

  // The alignment is written even for hand-authored roads — a real OSM shape
  // beats a waypoint polyline for them too — but never over a curated one in
  // the legacy directory, which build-data reads first for exactly that reason.
  if (!existsSync(join(LEGACY_GEOM_DIR, `${route.id}.json`))) {
    // the display alignment: ~30 m fidelity is far more than the map can show
    const line = simplify(route.coords, 0.03)
    pointTotal += line.length
    if (!DRY) {
      writeFileSync(
        join(GEOM_DIR, `${route.id}.json`),
        JSON.stringify({ type: 'Polyline', precision: 5, lengthKm: route.lengthKm, data: encodePolyline(line) }),
      )
    }
    stats.geometry++
  }

  const target = join(ROADS_DIR, `${route.id}.json`)
  if (authored.has(route.id)) {
    stats.skippedAuthored++
    continue
  }
  if (existsSync(target) && !OVERWRITE) continue

  const road = build(route)
  if (!road) {
    stats.noPlace++
    continue
  }
  if (!DRY) writeFileSync(target, `${JSON.stringify(road, null, 2)}\n`)
  stats.written++
  if (stats.written % 500 === 0) console.log(`  … ${stats.written} road files written`)
}

console.log(
  `\n${DRY ? '(dry run) ' : ''}✓ ${stats.written} road files, ${stats.geometry} alignments ` +
    `(${(pointTotal / 1e6).toFixed(2)}M points)\n` +
    `  preserved ${stats.skippedAuthored} hand-authored · skipped ${stats.empty} empty, ` +
    `${stats.tooShort} under 1 km, ${stats.noPlace} with no nearby place`,
)
console.log(`  legacy geometry dir still read from: ${LEGACY_GEOM_DIR}`)
