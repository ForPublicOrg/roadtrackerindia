#!/usr/bin/env node
/**
 * Close the holes stitch() bridged with straight lines, along OSM's own roads.
 *
 *   node scripts/fill-gaps.mjs                      # every line in data/geometry
 *   node scripts/fill-gaps.mjs --only nh-148b,sh-hr-20
 *   node scripts/fill-gaps.mjs --dry                # report, write nothing
 *
 * Run it after generate-roads.mjs, which writes data/geometry afresh from the
 * stage-1 cache. Every route is cached in .cache/osm/gaps/, so running it again
 * after a regeneration asks the router nothing.
 *
 * For every segment over MAX_SEGMENT_KM it asks a router for the road between
 * the segment's ends (lib/gaps.mjs says why that is the question):
 *
 * - the road is the segment → a straight road: points are added along it, so
 *   the line keeps a vertex every MAX_SEGMENT_KM like a freshly fetched one;
 * - otherwise it is a hole, and the road route goes in when judge() takes it
 *   for this road;
 * - a hole no route can stand in for stays, and its index goes in the file's
 *   `holes` list, which tells the build to leave that segment undrawn.
 *
 * A road whose `lengthKm` is the measured length of its line (every generated
 * road, and the enriched ones nobody gave an official figure) gains the
 * kilometres filled in, up to the length of the line less its holes, and never
 * loses any.
 *
 * Routes come from the OSRM demo server (OpenStreetMap data, ODbL), whose terms
 * are one request a second and an identifying User-Agent. It was used instead
 * of routing over Overpass downloads because Overpass, the day this was
 * written, took over a minute a query.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_SEGMENT_KM, ROOT, decodePolyline, encodePolyline, haversineKm, lineLengthKm, readCache, round5,
  simplify, sleep, writeCache,
} from './lib/overpass.mjs'
import { bearing, between, choose, identity, isStraightRoad, longSegments, segKey, summarise } from './lib/gaps.mjs'

const DRY = process.argv.includes('--dry')
const onlyArg = process.argv.indexOf('--only')
const ONLY = onlyArg > -1 ? new Set(process.argv[onlyArg + 1].split(',').map((s) => s.trim())) : null

const GEOM_DIR = join(ROOT, 'data', 'geometry')
const LEGACY_GEOM_DIR = join(ROOT, 'public', 'data', 'geometry')
const ROADS_DIR = join(ROOT, 'public', 'data', 'roads')
const OSRM = 'https://router.project-osrm.org/route/v1/driving'
const UA = 'RoadTrackerIndia-data-build/1.0 (https://roadtrackerindia.com)'

// a road merged into another is still how OSM numbers it ("ne-1" → NE 1)
const mergedInto = new Map()
for (const [from, to] of Object.entries(JSON.parse(readFileSync(join(ROOT, 'data', 'merged-roads.json'), 'utf8')).aliases ?? {})) {
  mergedInto.set(to, [...(mergedInto.get(to) ?? []), from])
}

// ── read every line ──────────────────────────────────────────────────

// The early hand-fetched lines in the legacy directory are plain LineStrings,
// simplified far harder than the corpus's; a few roads are still drawn from them.
const lines = []
for (const dir of [GEOM_DIR, LEGACY_GEOM_DIR]) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const id = file.slice(0, -5)
    if (ONLY && !ONLY.has(id)) continue
    const geo = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    let coords
    if (geo.type === 'Polyline') coords = decodePolyline(geo.data, geo.precision ?? 5)
    else if (geo.type === 'LineString') coords = geo.coordinates
    else continue
    const roadFile = join(ROADS_DIR, file)
    const road = existsSync(roadFile) ? JSON.parse(readFileSync(roadFile, 'utf8')) : null
    const long = longSegments(coords, MAX_SEGMENT_KM)
    if (long.length) lines.push({ id, file: join(dir, file), geo, road, coords, long })
  }
}
console.log(`${lines.length} lines have segments over ${MAX_SEGMENT_KM} km`)

// ── 1. the road between each long segment's ends ─────────────────────

const routes = readCache('gaps', 'routes.json') ?? {}
const todo = new Map()
for (const { long } of lines) for (const s of long) if (!(segKey(s.a, s.b) in routes)) todo.set(segKey(s.a, s.b), s)
console.log(`routing ${todo.size} segments (${Object.keys(routes).length} cached)`)

async function route(s, query) {
  const url = `${OSRM}/${s.a[0]},${s.a[1]};${s.b[0]},${s.b[1]}?overview=full&geometries=geojson&steps=true${query}`
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } })
      // NoRoute is an answer; anything else that is not JSON is the server
      const body = await res.json()
      if (body.code === 'NoRoute' || body.code === 'NoSegment') return null
      if (body.code !== 'Ok') throw new Error(body.code ?? `HTTP ${res.status}`)
      return body
    } catch (e) {
      if (attempt >= 5) throw e
      const wait = 5000 * 2 ** attempt
      process.stderr.write(`    osrm ${e.message} — retry in ${wait / 1000}s\n`)
      await sleep(wait)
    }
  }
}

/** Route every segment in `queue`, from its a to its b, into `cache` (saved as `name`). */
async function routeAll(queue, cache, name, query = () => '') {
  let n = 0
  for (const [key, s] of queue) {
    const started = Date.now()
    const osrm = await route(s, query(s))
    const r = osrm && summarise(osrm, s)
    // only the line is cut down: the verdict already has what the full one says
    cache[key] = r && { ...r, coords: simplify(r.coords, 0.03, { maxSegKm: MAX_SEGMENT_KM }).map(([x, y]) => [round5(x), round5(y)]) }
    if (++n % 25 === 0 || n === queue.size) {
      writeCache(cache, 'gaps', name)
      console.log(`  ${n}/${queue.size}`)
    }
    await sleep(Math.max(0, 1100 - (Date.now() - started)))
  }
}
await routeAll(todo, routes, 'routes.json')

// A route that is not the segment itself is asked for again the other way
// round: on a dual carriageway one of the two keeps to the right side.
const backs = readCache('gaps', 'routes-back.json') ?? {}
const backTodo = new Map()
for (const { long } of lines) {
  for (const s of long) {
    const key = segKey(s.a, s.b)
    if (!isStraightRoad(s, routes[key]) && !(key in backs)) backTodo.set(key, { ...s, a: s.b, b: s.a })
  }
}
console.log(`routing ${backTodo.size} of them the other way (${Object.keys(backs).length} cached)`)
await routeAll(backTodo, backs, 'routes-back.json')

// Then with both ends held to a direction of travel, for a line whose two
// pieces lie on opposite carriageways: from either end, the plain route runs on
// to a U-turn. Each pass asks only for segments no route so far runs along.
// 90° either side keeps a winding road's ends in reach, but at an interchange
// it also takes the slip road beside the carriageway (the Samruddhi Mahamarg
// near Mehkar: 57.5 km through the town for 10.4 km of expressway); 30° does
// not, and asked from the other end it settled every expressway the 90° pass
// left.
const HELD = [
  { name: 'routes-bearing.json', range: 90 },
  { name: 'routes-bearing-back.json', range: 30, back: true },
  { name: 'routes-bearing-30.json', range: 30 },
]
const held = []
/** Every route asked for between a segment's ends so far, each turned to run a to b. */
const candidates = (s, key) => [routes[key], backs[key], ...held.map((c) => c[key])].map((r) => along(s, r))
for (const { name, range, back } of HELD) {
  const cache = readCache('gaps', name) ?? {}
  const queue = new Map()
  for (const { long } of lines) {
    for (const s of long) {
      const key = segKey(s.a, s.b)
      if (key in cache || candidates(s, key).some((r) => isStraightRoad(s, r))) continue
      queue.set(key, back ? { ...s, a: s.b, b: s.a } : s)
    }
  }
  console.log(`routing ${queue.size} of them held to their direction${back ? ' the other way' : ''}, ±${range}° (${Object.keys(cache).length} cached)`)
  await routeAll(queue, cache, name, (q) => {
    const deg = bearing(q.a, q.b)
    return `&bearings=${deg},${range};${deg},${range}`
  })
  held.push(cache)
}

/** A cached route, turned to run from the segment's a to its b. */
function along(s, r) {
  if (!r || haversineKm(r.coords[0], s.a) <= haversineKm(r.coords[0], s.b)) return r
  return { ...r, coords: [...r.coords].reverse(), legs: [...r.legs].reverse() }
}

// ── 2. rewrite the lines ─────────────────────────────────────────────

const stats = { straight: 0, filled: 0, filledKm: 0, holes: 0, holesKm: 0, files: 0, lengths: 0 }
const left = []
const filled = []
for (const { id, file, geo, road, coords, long } of lines) {
  const at = new Map(long.map((s) => [s.i, s]))
  const out = [coords[0]]
  const holes = []
  // the line's other long segments that no route runs along: holes or fills,
  // neither of them road already drawn where the straight line runs
  const undrawn = new Set(long.filter((s) => !candidates(s, segKey(s.a, s.b)).some((r) => isStraightRoad(s, r))).map((s) => s.i))
  const ctx = { own: identity(road, mergedInto.get(id)), category: road?.category, status: road?.status, line: coords, undrawn }
  let addedKm = 0
  for (let i = 1; i < coords.length; i++) {
    const s = at.get(i)
    // each was asked for one way or the other, whichever way a line ran then
    const verdict = s && choose(s, candidates(s, segKey(s.a, s.b)), ctx)
    const path = verdict?.route
    if (verdict?.straight) {
      out.push(...between(s.a, s.b, MAX_SEGMENT_KM))
      stats.straight++
    } else if (s) {
      if (verdict.ok) {
        // the route starts and ends where it met a road; the line's own ends stay
        const inner = path.coords.slice(haversineKm(path.coords[0], s.a) < 0.001 ? 1 : 0)
        if (inner.length && haversineKm(inner[inner.length - 1], s.b) < 0.001) inner.pop()
        // a new road can be mapped with few nodes; it is road all the same, so
        // it gets the points a straight road does rather than looking like a hole
        for (const p of inner) {
          if (haversineKm(out[out.length - 1], p) > MAX_SEGMENT_KM) out.push(...between(out[out.length - 1], p, MAX_SEGMENT_KM))
          out.push(p)
        }
        if (haversineKm(out[out.length - 1], s.b) > MAX_SEGMENT_KM) out.push(...between(out[out.length - 1], s.b, MAX_SEGMENT_KM))
        addedKm += lineLengthKm([s.a, ...inner, s.b])
        stats.filled++
        stats.filledKm += s.km
        filled.push({ id, km: s.km, why: verdict.why, a: s.a, b: s.b })
      } else {
        holes.push(out.length)
        stats.holes++
        stats.holesKm += s.km
        left.push({ id, km: s.km, why: verdict.why, a: s.a, b: s.b })
      }
    }
    out.push(coords[i])
  }

  // What was measured grows by what was filled in, but never past what is
  // drawn: lines cached before the bridge-accounting fix (2026-10-16) counted
  // some bridges as road, and NH 147's 46.9 km would have become 67.1 km of a
  // 50.5 km line. Nor does it shrink: those old figures are what the road
  // files say, and correcting them is not this script's job.
  const drawnKm = lineLengthKm(out) - holes.reduce((sum, h) => sum + haversineKm(out[h - 1], out[h]), 0)
  const was = geo.lengthKm ?? Infinity
  const lengthKm = Math.round(Math.min(was + addedKm, Math.max(drawnKm, was)) * 10) / 10
  const tail = holes.length ? { holes } : {}
  const next =
    geo.type === 'Polyline'
      ? { type: 'Polyline', precision: 5, lengthKm, ...tail, data: encodePolyline(out) }
      : { type: 'LineString', coordinates: out, ...tail }
  if (JSON.stringify(next) === JSON.stringify(geo)) continue
  stats.files++
  if (!DRY) writeFileSync(file, JSON.stringify(next))

  // a measured length follows the line; an official figure stays
  if (road && geo.lengthKm != null && Math.abs(road.lengthKm - geo.lengthKm) < 0.05 && Math.abs(lengthKm - road.lengthKm) >= 0.1) {
    const roadPath = join(ROADS_DIR, `${id}.json`)
    const text = readFileSync(roadPath, 'utf8')
    const spliced = text.replace(/("lengthKm": )[\d.]+/, `$1${lengthKm}`)
    if (spliced !== text) {
      stats.lengths++
      if (!DRY) writeFileSync(roadPath, spliced)
    }
  }
}

left.sort((x, y) => y.km - x.km)
filled.sort((x, y) => y.km - x.km)
writeCache({ left, filled }, 'gaps', 'report.json')
console.log(
  `\n${DRY ? '(dry run) ' : ''}✓ ${stats.files} lines rewritten: ${stats.straight} straight roads given vertices, ` +
    `${stats.filled} holes filled (${Math.round(stats.filledKm)} km of straight line), ` +
    `${stats.holes} left undrawn (${Math.round(stats.holesKm)} km), ${stats.lengths} road lengths updated` +
    `\n  every verdict: .cache/osm/gaps/report.json`,
)
for (const h of left.slice(0, 15)) console.log(`  ${h.id}: ${h.km.toFixed(1)} km — ${h.why}`)
