#!/usr/bin/env node
/**
 * Optional enhancement: pull REAL road alignments from OpenStreetMap via the
 * Overpass API and cache them in public/data/geometry/<id>.json. The data
 * build prefers these over waypoint polylines automatically.
 *
 *   node scripts/fetch-osm-geometry.mjs               # all roads it knows how to query
 *   node scripts/fetch-osm-geometry.mjs --only nh-44,nh-48
 *   node scripts/fetch-osm-geometry.mjs --force        # refetch existing
 *
 * Sequential + throttled (Overpass is a shared free service). Safe to re-run:
 * results are cached, failures are skipped with a note.
 * Data © OpenStreetMap contributors, ODbL.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dedupeWays, overpass } from './lib/overpass.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ROADS_DIR = join(ROOT, 'public', 'data', 'roads')
const GEOM_DIR = join(ROOT, 'public', 'data', 'geometry')
mkdirSync(GEOM_DIR, { recursive: true })

const BBOX = '(6.0,67.5,37.5,97.6)' // south,west,north,east — greater India
const FORCE = process.argv.includes('--force')
const onlyArg = process.argv.find((a) => a.startsWith('--only'))
const ONLY = onlyArg
  ? (onlyArg.includes('=') ? onlyArg.split('=')[1] : process.argv[process.argv.indexOf(onlyArg) + 1])
      .split(',')
      .map((s) => s.trim())
  : null

/** Overpass name-regex queries for expressways (NHs are queried by ref). */
const NAME_QUERIES = {
  'yamuna-expressway': 'Yamuna Expressway',
  'agra-lucknow-expressway': 'Agra.{0,3}Lucknow Expressway',
  'purvanchal-expressway': 'Purvanchal Expressway',
  'bundelkhand-expressway': 'Bundelkhand Expressway',
  'ganga-expressway': 'Ganga Expressway',
  'gorakhpur-link-expressway': 'Gorakhpur Link Expressway',
  'delhi-meerut-expressway': 'Delhi.{0,3}Meerut Expressway',
  'eastern-peripheral-expressway': 'Eastern Peripheral Expressway',
  'western-peripheral-expressway': 'Kundli.{0,3}Manesar.{0,3}Palwal|Western Peripheral Expressway',
  'mumbai-pune-expressway': 'Yashwantrao Chavan Expressway|Mumbai.{0,3}Pune Expressway',
  'samruddhi-mahamarg': 'Samruddhi Mahamarg|Nagpur.{0,3}Mumbai Super Communication Expressway',
  'delhi-mumbai-expressway': 'Delhi.{0,3}Mumbai Expressway',
  'noida-greater-noida-expressway': 'Noida.{0,3}Greater Noida Expressway',
  'ahmedabad-vadodara-expressway': 'National Expressway 1|Ahmedabad.{0,3}Vadodara Expressway',
  'atal-setu': 'Atal Setu|Mumbai Trans Harbour',
  'dwarka-expressway': 'Dwarka Expressway',
  'trans-haryana-expressway': 'Trans.{0,3}Haryana|Ambala.{0,3}Narnaul Expressway',
  'amritsar-katra-expressway': 'Delhi.{0,3}Amritsar.{0,3}Katra Expressway',
}

/**
 * Roads whose name is too generic to query — half a dozen Indian cities have a
 * relation called plainly "Outer Ring Road" — so the relation is named outright.
 * Each entry is a list of attempts, tried in order until one passes the length
 * and location checks below. An attempt naming several relations unions them,
 * which is how a corridor mapped one state at a time comes back whole.
 */
const RELATION_IDS = {
  'delhi-outer-ring-road': [[1208532]],
  'urban-extension-road-2': [[2723963]],
  'east-coast-road': [[3305033]],
  'nice-road': [[8430045]],
  'eastern-express-highway': [[8550034]],
  'western-express-highway': [[13552614]],
  'dwarka-expressway': [[9240778]],
  'trans-haryana-expressway': [[11566238]],
  // the parent relation holds the three state sections as members, not ways
  'raipur-visakhapatnam-expressway': [[11634998, 11637504, 11638457]],
  'jaipur-ring-road': [[11794355]],
  'bengaluru-satellite-town-ring-road': [[15647226]],
  'delhi-dehradun-expressway': [[17144676]],
  'dnd-flyway': [[6796612]],
  'mumbai-pune-expressway': [[1247233]],
  'hyderabad-outer-ring-road': [[5634923], [3303114], [8428024]],
  'mumbai-coastal-road': [[17381878]],
}

// ── small geo helpers (self-contained on purpose) ─────────────────

const R = 6371
function haversineKm(a, b) {
  const t = (d) => (d * Math.PI) / 180
  const h =
    Math.sin(t(b[1] - a[1]) / 2) ** 2 +
    Math.cos(t(a[1])) * Math.cos(t(b[1])) * Math.sin(t(b[0] - a[0]) / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}
const lineLen = (c) => c.slice(1).reduce((s, p, i) => s + haversineKm(c[i], p), 0)

function simplify(coords, tolKm) {
  if (coords.length < 3) return coords
  const midLat = coords[Math.floor(coords.length / 2)][1]
  const kx = 111.32 * Math.cos((midLat * Math.PI) / 180)
  const ky = 110.574
  const keep = new Uint8Array(coords.length)
  keep[0] = keep[coords.length - 1] = 1
  const stack = [[0, coords.length - 1]]
  while (stack.length) {
    const [lo, hi] = stack.pop()
    let maxD = 0
    let idx = -1
    const [ax, ay] = [coords[lo][0] * kx, coords[lo][1] * ky]
    const [bx, by] = [coords[hi][0] * kx, coords[hi][1] * ky]
    const dx = bx - ax
    const dy = by - ay
    const dd = dx * dx + dy * dy
    for (let i = lo + 1; i < hi; i++) {
      const px = coords[i][0] * kx
      const py = coords[i][1] * ky
      const t = dd ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / dd)) : 0
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
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

/** Greedy end-to-end stitching of unordered way segments into one line. */
function stitch(segments) {
  if (!segments.length) return []
  segments.sort((a, b) => lineLen(b) - lineLen(a))
  let chain = segments.shift()
  let guard = segments.length + 5
  while (segments.length && guard-- > 0) {
    const head = chain[0]
    const tail = chain[chain.length - 1]
    let best = { d: Infinity, i: -1, where: 'tail', rev: false }
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]
      const options = [
        { d: haversineKm(tail, s[0]), where: 'tail', rev: false },
        { d: haversineKm(tail, s[s.length - 1]), where: 'tail', rev: true },
        { d: haversineKm(head, s[s.length - 1]), where: 'head', rev: false },
        { d: haversineKm(head, s[0]), where: 'head', rev: true },
      ]
      for (const o of options) if (o.d < best.d) best = { ...o, i }
    }
    if (best.i === -1 || best.d > 30) break // don't leap over huge gaps
    const seg = segments.splice(best.i, 1)[0]
    const oriented = best.rev ? [...seg].reverse() : seg
    chain = best.where === 'tail' ? chain.concat(oriented) : oriented.concat(chain)
  }
  return chain
}

// ── overpass ──────────────────────────────────────────────────────

/** The shared client rotates mirrors and backs off — Overpass 504s a lot. */
const fetchRelations = (query) => overpass(`${query}out geom;`, { timeout: 180 })

function extractSegments(json, explicitIds) {
  // pick the relation with the most way members (dual-carriageway roads often
  // have several relations; the biggest one is the main route)
  const relations = (json.elements ?? []).filter((e) => e.type === 'relation')
  if (!relations.length) return []
  relations.sort((a, b) => (b.members?.length ?? 0) - (a.members?.length ?? 0))
  // A named query can land on unrelated roads, so it only trusts the biggest
  // relation. A query that named its relation ids meant all of them.
  const chosenRels = explicitIds ? relations : relations.slice(0, 1)
  const members = chosenRels
    .flatMap((r) => r.members ?? [])
    .filter((m) => m.type === 'way' && Array.isArray(m.geometry) && m.geometry.length > 1)
  // Roles would tell us which carriageway is which, but Indian divided highways
  // are usually mapped as two untagged parallel ways. Stitching both end to end
  // reports the road at twice its length, so drop whatever is already covered.
  const oneSide = members.filter((m) => m.role === 'forward')
  const chosen = oneSide.length >= members.length * 0.3 && oneSide.length > 0 ? oneSide : members
  return dedupeWays(chosen.map((m) => m.geometry.map((g) => [g.lon, g.lat])))
}

function queriesFor(road) {
  const attempts = RELATION_IDS[road.id]
  if (attempts) return attempts.map((ids) => `relation(id:${ids.join(',')});`)
  const m = road.id.match(/^nh-(\d+[a-z]*)$/)
  if (m) {
    const n = m[1].toUpperCase()
    return [
      `relation["route"="road"]["network"="IN:NH"]["ref"="NH ${n}"];`,
      `relation["route"="road"]["network"="IN:NH"]["ref"="${n}"];`,
      `relation["route"="road"]["ref"="NH ${n}"]${BBOX};`,
    ]
  }
  const nameRe = NAME_QUERIES[road.id]
  if (nameRe) return [`relation["route"="road"]["name"~"${nameRe}",i]${BBOX};`]
  return []
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const roads = readdirSync(ROADS_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(ROADS_DIR, f), 'utf8')))
  .filter((r) => (ONLY ? ONLY.includes(r.id) : true))

let ok = 0
let skipped = 0
let failed = 0

for (const road of roads) {
  const out = join(GEOM_DIR, `${road.id}.json`)
  if (existsSync(out) && !FORCE) {
    skipped++
    continue
  }
  const queries = queriesFor(road)
  if (!queries.length) {
    skipped++
    continue
  }
  let done = false
  for (const q of queries) {
    let json = null
    try {
      json = await fetchRelations(q)
    } catch (e) {
      console.log(`  ! ${road.id}: ${e.message} — giving up on this query`)
    }
    if (!json) continue
    try {
      const segs = extractSegments(json, Boolean(RELATION_IDS[road.id]))
      if (!segs.length) continue
      const line = stitch(segs)
      const km = lineLen(line)
      const ratio = km / road.lengthKm
      // partial matches are worse than full-length waypoint lines — they
      // truncate the road on the map, so demand near-complete coverage
      if (ratio < 0.8 || ratio > 1.5) {
        console.log(`  ~ ${road.id}: OSM match is ${Math.round(km)} km vs official ${road.lengthKm} km — skipping (partial/contaminated)`)
        continue
      }
      // Half a dozen cities have a road called "Outer Ring Road". A match of the
      // right length in the wrong city would silently move the road across India.
      const mid = (pts) => {
        const c = pts.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0])
        return [c[0] / pts.length, c[1] / pts.length]
      }
      const drift = haversineKm(mid(line), mid(road.waypoints.map((w) => w.coords)))
      if (drift > Math.max(60, road.lengthKm / 3)) {
        console.log(`  ~ ${road.id}: OSM match sits ${Math.round(drift)} km from where the road is — wrong road, skipping`)
        continue
      }
      const coords = simplify(line, 0.03).map(([x, y]) => [
        Math.round(x * 1e5) / 1e5,
        Math.round(y * 1e5) / 1e5,
      ])
      writeFileSync(out, JSON.stringify({ type: 'LineString', coordinates: coords }))
      console.log(`  ✓ ${road.id}: ${Math.round(km)} km, ${coords.length} points`)
      ok++
      done = true
      break
    } catch (e) {
      console.log(`  ! ${road.id}: ${e.message}`)
    }
  }
  if (!done && queries.length) failed++
  await sleep(1800)
}

console.log(`\nReal geometry: ${ok} fetched, ${skipped} skipped/cached, ${failed} no match.`)
console.log('Now run: npm run data  (the build prefers real geometry automatically)')
