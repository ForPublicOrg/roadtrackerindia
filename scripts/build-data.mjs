#!/usr/bin/env node
/**
 * RoadTracker India — data build step.
 *
 * Reads   public/data/roads/<id>.json          (hand-authored, single source of truth)
 * Reads   public/data/geometry/<id>.json       (optional real OSM geometry override)
 * Writes  public/data/index.json               (search/browse index)
 * Writes  public/data/network-lite.geojson     (simplified all-roads overview)
 * Writes  public/data/shapes/<id>.json         (display geometry per road)
 *
 * Validates every road file against docs/DATA.md. Errors fail the build.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DATA_DIR = join(ROOT, 'public', 'data')
const ROADS_DIR = join(DATA_DIR, 'roads')
const GEOM_DIR = join(DATA_DIR, 'geometry')
const SHAPES_DIR = join(DATA_DIR, 'shapes')

const CATEGORIES = ['nh', 'expressway', 'sh', 'local']
const STATUSES = ['operational', 'under-construction', 'planned']
const BBOX = { minLng: 67.5, minLat: 6.0, maxLng: 97.6, maxLat: 37.5 }
const KNOWN_KEYS = new Set([
  'id', 'ref', 'name', 'category', 'status', 'lengthKm', 'route', 'waypoints', 'sources',
  'aka', 'completionPercent', 'lanes', 'agency', 'cost', 'contractor', 'tolls', 'timeline',
  'history', 'facts',
  'significance', 'engineering', 'interchanges', 'relatedRoads', 'travelNotes',
  'futureUpgrades', 'newsQuery',
])

// ── geometry helpers ────────────────────────────────────────────────

const R = 6371
function haversineKm([lng1, lat1], [lng2, lat2]) {
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

function polyLenKm(coords) {
  let len = 0
  for (let i = 1; i < coords.length; i++) len += haversineKm(coords[i - 1], coords[i])
  return len
}

/** Chaikin corner cutting. Open lines keep their endpoints; closed rings wrap. */
function chaikin(coords, iterations, closed) {
  let pts = coords
  for (let it = 0; it < iterations; it++) {
    const out = []
    if (!closed) out.push(pts[0])
    const n = closed ? pts.length : pts.length - 1
    for (let i = 0; i < n; i++) {
      const p = pts[i]
      const q = pts[(i + 1) % pts.length]
      out.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25])
      out.push([p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75])
    }
    if (!closed) out.push(pts[pts.length - 1])
    else out.push(out[0])
    pts = out
  }
  return pts
}

/** Douglas-Peucker simplification; tolerance in km. */
function simplify(coords, tolKm) {
  if (coords.length < 3) return coords
  const midLat = coords.reduce((s, c) => s + c[1], 0) / coords.length
  const kx = 111.32 * Math.cos((midLat * Math.PI) / 180)
  const ky = 110.574
  const px = (c) => [c[0] * kx, c[1] * ky]

  function segDist(p, a, b) {
    const [px1, py1] = px(p)
    const [ax, ay] = px(a)
    const [bx, by] = px(b)
    const dx = bx - ax
    const dy = by - ay
    if (dx === 0 && dy === 0) return Math.hypot(px1 - ax, py1 - ay)
    const t = Math.max(0, Math.min(1, ((px1 - ax) * dx + (py1 - ay) * dy) / (dx * dx + dy * dy)))
    return Math.hypot(px1 - (ax + t * dx), py1 - (ay + t * dy))
  }

  const keep = new Uint8Array(coords.length)
  keep[0] = keep[coords.length - 1] = 1
  const stack = [[0, coords.length - 1]]
  while (stack.length) {
    const [lo, hi] = stack.pop()
    let maxD = 0
    let idx = -1
    for (let i = lo + 1; i < hi; i++) {
      const d = segDist(coords[i], coords[lo], coords[hi])
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > tolKm && idx !== -1) {
      keep[idx] = 1
      stack.push([lo, idx], [idx, hi])
    }
  }
  return coords.filter((_, i) => keep[i])
}

const round5 = (n) => Math.round(n * 1e5) / 1e5

// ── validation ──────────────────────────────────────────────────────

function validateRoad(road, file) {
  const errors = []
  const warnings = []
  const err = (m) => errors.push(`${file}: ${m}`)
  const warn = (m) => warnings.push(`${file}: ${m}`)

  const id = file.replace(/\.json$/, '')
  if (road.id !== id) err(`"id" (${road.id}) must match filename (${id})`)
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(road.id ?? ''))) err(`"id" must be kebab-case`)

  for (const key of ['ref', 'name']) {
    if (typeof road[key] !== 'string' || !road[key].trim()) err(`"${key}" is required (non-empty string)`)
  }
  if (!CATEGORIES.includes(road.category)) err(`"category" must be one of ${CATEGORIES.join(', ')}`)
  if (!STATUSES.includes(road.status)) err(`"status" must be one of ${STATUSES.join(', ')}`)
  if (typeof road.lengthKm !== 'number' || road.lengthKm <= 0 || road.lengthKm > 5000)
    err(`"lengthKm" must be a number in (0, 5000]`)

  const r = road.route
  if (!r || typeof r !== 'object') err(`"route" object is required`)
  else {
    for (const key of ['start', 'end']) {
      if (typeof r[key] !== 'string' || !r[key].trim()) err(`"route.${key}" is required`)
    }
    if (!Array.isArray(r.states) || r.states.length === 0 || r.states.some((s) => typeof s !== 'string' || !s.trim()))
      err(`"route.states" must be a non-empty array of state names`)
    if (!Array.isArray(r.majorCities) || r.majorCities.length < 2)
      err(`"route.majorCities" must list at least 2 places`)
  }

  const wp = road.waypoints
  if (!Array.isArray(wp) || wp.length < 2) {
    err(`"waypoints" must be an array of at least 2 points`)
  } else {
    wp.forEach((w, i) => {
      if (!w || typeof w.name !== 'string' || !w.name.trim()) err(`waypoints[${i}] missing "name"`)
      const c = w?.coords
      if (!Array.isArray(c) || c.length !== 2 || c.some((n) => typeof n !== 'number')) {
        err(`waypoints[${i}] "coords" must be [lng, lat] numbers`)
      } else {
        const [lng, lat] = c
        if (lng < BBOX.minLng || lng > BBOX.maxLng || lat < BBOX.minLat || lat > BBOX.maxLat)
          err(`waypoints[${i}] (${w.name}) coords [${lng}, ${lat}] outside India bbox — check [lng, lat] order`)
      }
    })
    if (errors.length === 0) {
      const coords = wp.map((w) => w.coords)
      for (let i = 1; i < coords.length; i++) {
        const d = haversineKm(coords[i - 1], coords[i])
        if (d > 220) warn(`gap of ${Math.round(d)} km between "${wp[i - 1].name}" and "${wp[i].name}" — add intermediate waypoints`)
        if (d < 0.05) warn(`waypoints "${wp[i - 1].name}" and "${wp[i].name}" are nearly identical`)
      }
      const pl = polyLenKm(coords)
      const ratio = pl / road.lengthKm
      if (ratio < 0.5 || ratio > 1.45)
        warn(`waypoint polyline is ${Math.round(pl)} km but lengthKm is ${road.lengthKm} — route shape may be wrong`)
    }
  }

  if (!Array.isArray(road.sources) || road.sources.length === 0) {
    err(`"sources" must have at least one entry`)
  } else {
    road.sources.forEach((s, i) => {
      if (!s || typeof s.title !== 'string' || typeof s.url !== 'string' || !/^https:\/\//.test(s.url))
        err(`sources[${i}] needs "title" and an https "url"`)
    })
  }

  if (road.completionPercent !== undefined) {
    if (typeof road.completionPercent !== 'number' || road.completionPercent < 0 || road.completionPercent > 100)
      err(`"completionPercent" must be 0–100`)
  }
  if (road.facts !== undefined && (!Array.isArray(road.facts) || road.facts.some((f) => typeof f !== 'string')))
    err(`"facts" must be an array of strings`)
  if (road.aka !== undefined && (!Array.isArray(road.aka) || road.aka.some((f) => typeof f !== 'string')))
    err(`"aka" must be an array of strings`)
  if (road.tolls !== undefined && (!Array.isArray(road.tolls) || road.tolls.some((t) => !t || typeof t.name !== 'string')))
    err(`"tolls" must be an array of { name, note? }`)
  if (road.timeline !== undefined && (!Array.isArray(road.timeline) || road.timeline.some((t) => !t || typeof t.year !== 'string' || typeof t.event !== 'string')))
    err(`"timeline" must be an array of { year, event } (both strings)`)

  for (const key of ['significance', 'travelNotes', 'newsQuery']) {
    if (road[key] !== undefined && (typeof road[key] !== 'string' || !road[key].trim()))
      err(`"${key}" must be a non-empty string`)
  }
  if (road.futureUpgrades !== undefined && (!Array.isArray(road.futureUpgrades) || road.futureUpgrades.some((f) => typeof f !== 'string')))
    err(`"futureUpgrades" must be an array of strings`)
  for (const key of ['engineering', 'interchanges']) {
    if (road[key] !== undefined && (!Array.isArray(road[key]) || road[key].some((t) => !t || typeof t.name !== 'string' || (t.note !== undefined && typeof t.note !== 'string'))))
      err(`"${key}" must be an array of { name, note? }`)
  }
  if (road.relatedRoads !== undefined) {
    if (!Array.isArray(road.relatedRoads) || road.relatedRoads.some((r) => !r || typeof r.id !== 'string'))
      err(`"relatedRoads" must be an array of { id, label? }`)
  }

  for (const key of Object.keys(road)) {
    if (!KNOWN_KEYS.has(key)) warn(`unknown key "${key}" (ignored)`)
  }

  return { errors, warnings }
}

// ── main ────────────────────────────────────────────────────────────

if (!existsSync(ROADS_DIR)) {
  console.error(`No roads directory at ${ROADS_DIR}`)
  process.exit(1)
}

const files = readdirSync(ROADS_DIR).filter((f) => f.endsWith('.json')).sort()
if (files.length === 0) {
  console.error('No road files found.')
  process.exit(1)
}

const allErrors = []
const allWarnings = []
const roads = []
const allIds = new Set(files.map((f) => f.replace(/\.json$/, '')))

for (const file of files) {
  let road
  try {
    road = JSON.parse(readFileSync(join(ROADS_DIR, file), 'utf8'))
  } catch (e) {
    allErrors.push(`${file}: invalid JSON — ${e.message}`)
    continue
  }
  const { errors, warnings } = validateRoad(road, file)
  for (const rel of road?.relatedRoads ?? []) {
    if (rel?.id && !allIds.has(rel.id))
      warnings.push(`${file}: relatedRoads points at "${rel.id}" which is not in the catalogue`)
  }
  allErrors.push(...errors)
  allWarnings.push(...warnings)
  if (errors.length === 0) roads.push(road)
}

// --lint: validate only (safe to run concurrently — writes nothing)
if (process.argv.includes('--lint')) {
  for (const w of allWarnings) console.warn(`  warn  ${w}`)
  for (const e of allErrors) console.error(`  ERROR ${e}`)
  console.log(`${allErrors.length ? '✗' : '✓'} lint: ${files.length} file(s), ${allErrors.length} error(s), ${allWarnings.length} warning(s)`)
  process.exit(allErrors.length ? 1 : 0)
}

// Fail BEFORE touching derived outputs — a bad run must not destroy good ones.
if (allErrors.length) {
  for (const w of allWarnings) console.warn(`  warn  ${w}`)
  for (const e of allErrors) console.error(`  ERROR ${e}`)
  console.error(`\n✗ ${allErrors.length} error(s) across ${files.length} road file(s). Fix them and re-run.`)
  process.exit(1)
}

// Derive outputs
rmSync(SHAPES_DIR, { recursive: true, force: true })
mkdirSync(SHAPES_DIR, { recursive: true })

const CATEGORY_ORDER = { expressway: 0, nh: 1, sh: 2, local: 3 }
roads.sort(
  (a, b) => (CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]) || b.lengthKm - a.lengthKm
)

const indexRows = []
const liteFeatures = []
let realGeomCount = 0

for (const road of roads) {
  let base = road.waypoints.map((w) => w.coords)
  let real = false
  const geomFile = join(GEOM_DIR, `${road.id}.json`)
  if (existsSync(geomFile)) {
    try {
      const g = JSON.parse(readFileSync(geomFile, 'utf8'))
      const geom = g.type === 'Feature' ? g.geometry : g
      if (geom?.type === 'LineString' && Array.isArray(geom.coordinates) && geom.coordinates.length > 1) {
        base = geom.coordinates
        real = true
        realGeomCount++
      } else {
        allWarnings.push(`${road.id}: geometry override is not a LineString — using waypoints`)
      }
    } catch {
      allWarnings.push(`${road.id}: unreadable geometry override — using waypoints`)
    }
  }

  const closed = base.length > 4 && haversineKm(base[0], base[base.length - 1]) < 1
  // short urban roads need a much tighter overview tolerance or they collapse to chords
  const liteTol = road.lengthKm < 30 ? 0.05 : road.lengthKm < 120 ? 0.15 : 0.35
  const shape = real
    ? simplify(base, 0.04)
    : simplify(chaikin(base, 3, closed), 0.06)
  const lite = real
    ? simplify(base, liteTol)
    : simplify(chaikin(base, 2, closed), liteTol)

  const lngs = shape.map((c) => c[0])
  const lats = shape.map((c) => c[1])
  const bbox = [
    round5(Math.min(...lngs)), round5(Math.min(...lats)),
    round5(Math.max(...lngs)), round5(Math.max(...lats)),
  ]

  writeFileSync(
    join(SHAPES_DIR, `${road.id}.json`),
    JSON.stringify({
      type: 'Feature',
      properties: { id: road.id, real },
      geometry: { type: 'LineString', coordinates: shape.map((c) => [round5(c[0]), round5(c[1])]) },
    })
  )

  liteFeatures.push({
    type: 'Feature',
    properties: {
      id: road.id,
      ref: road.ref,
      name: road.name,
      category: road.category,
      status: road.status,
      lengthKm: road.lengthKm,
    },
    geometry: { type: 'LineString', coordinates: lite.map((c) => [round5(c[0]), round5(c[1])]) },
  })

  const row = {
    id: road.id,
    ref: road.ref,
    name: road.name,
    category: road.category,
    status: road.status,
    lengthKm: road.lengthKm,
    start: road.route.start,
    end: road.route.end,
    states: road.route.states,
    cities: road.route.majorCities,
    bbox,
  }
  if (road.aka) row.aka = road.aka
  if (road.completionPercent !== undefined) row.completionPercent = road.completionPercent
  indexRows.push(row)
}

writeFileSync(
  join(DATA_DIR, 'index.json'),
  JSON.stringify({ generated: new Date().toISOString(), count: indexRows.length, roads: indexRows })
)
writeFileSync(
  join(DATA_DIR, 'network-lite.geojson'),
  JSON.stringify({ type: 'FeatureCollection', features: liteFeatures })
)

for (const w of allWarnings) console.warn(`  warn  ${w}`)
console.log(
  `✓ ${roads.length} roads validated (${realGeomCount} with real OSM geometry, ${allWarnings.length} warnings)` +
    ` → index.json, network-lite.geojson, shapes/`
)
