#!/usr/bin/env node
/**
 * Add a road that the bulk corpus pass cannot find.
 *
 * The corpus is built by querying OpenStreetMap for highway *refs* — "NH 44",
 * "SH 27" — which is how you enumerate 7,700 numbered roads in a few hours. A
 * city's arterials have no ref: Bengaluru's Outer Ring Road is called "Outer
 * Ring Road", and so is Chennai's, and Hyderabad's. There is no query that
 * separates them, so they are named here one at a time, by relation id.
 *
 *   node scripts/add-named-road.mjs                 # every entry below
 *   node scripts/add-named-road.mjs --only bengaluru-outer-ring-road
 *   node scripts/add-named-road.mjs --geometry-only # existing roads, alignment only
 *
 * Writes .cache/osm/routes/<id>.json in the shape stage 1 produces, so
 * `node scripts/generate-roads.mjs` then builds the road file with its route,
 * waypoints and major cities derived the same way as every other road.
 * Data © OpenStreetMap contributors, ODbL.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ROOT, cachePath, dedupeWays, haversineKm, lineLengthKm, overpass, round5, simplify, sleep,
  writeCache,
} from './lib/overpass.mjs'

const ROADS_DIR = join(ROOT, 'public', 'data', 'roads')

/**
 * id → the OSM relation(s) that are this road, plus how it should be filed.
 * `class` is the badge a named road shows instead of a number.
 */
const NAMED_ROADS = [
  // ── ring roads: one name, a dozen cities ──────────────────────────
  { id: 'bengaluru-outer-ring-road', rel: [3303114], ref: 'Outer Ring Road', class: 'Ring road', category: 'local' },
  { id: 'bengaluru-inner-ring-road', rel: [16453014], ref: 'Inner Ring Road', class: 'Ring road', category: 'local' },
  { id: 'chennai-outer-ring-road', rel: [8428024], ref: 'Outer Ring Road', class: 'Ring road', category: 'local' },
  { id: 'chennai-inner-ring-road', rel: [11499574], ref: 'Inner Ring Road', class: 'Ring road', category: 'local' },
  { id: 'hyderabad-inner-ring-road', rel: [6424432], ref: 'Inner Ring Road', class: 'Ring road', category: 'local' },
  { id: 'delhi-inner-ring-road', rel: [1208531], ref: 'Ring Road', class: 'Ring road', category: 'local' },
  { id: 'lucknow-outer-ring-road', rel: [11597400], ref: 'Outer Ring Road', class: 'Ring road', category: 'local' },
  { id: 'nagpur-outer-ring-road', rel: [17152685], ref: 'Outer Ring Road', class: 'Ring road', category: 'local' },
  { id: 'thiruvananthapuram-outer-ring-road', rel: [15898323], ref: 'Outer Ring Road', class: 'Ring road', category: 'local' },
  { id: 'varanasi-ring-road', rel: [17162404], ref: 'Ring Road', class: 'Ring road', category: 'local' },
  { id: 'madurai-ring-road', rel: [10425276], ref: 'Ring Road', class: 'Ring road', category: 'local' },
  { id: 'tiruchirappalli-ring-road', rel: [13434976], ref: 'Ring Road', class: 'Ring road', category: 'local' },
  // OSM calls it the Mahatma Gandhi Inner Ring Road; it rings Guntur, not Vijayawada
  { id: 'guntur-inner-ring-road', rel: [17336284], ref: 'Inner Ring Road', class: 'Ring road', category: 'local' },

  // ── city arterials ────────────────────────────────────────────────
  { id: 'sion-panvel-highway', rel: [8292515], ref: 'Sion–Panvel Highway', class: 'City highway', category: 'local' },
  { id: 'lbs-marg-mumbai', rel: [13556254], ref: 'LBS Marg', class: 'City road', category: 'local' },
  { id: 'palm-beach-marg', rel: [8120638], ref: 'Palm Beach Marg', class: 'City road', category: 'local' },
  { id: 'kolkata-grand-trunk-road', rel: [14503339], ref: 'Grand Trunk Road', class: 'City road', category: 'local' },
  { id: 'chennai-200-feet-radial-road', rel: [21161738], ref: '200 Feet Radial Road', class: 'City road', category: 'local' },
  { id: 'hindon-elevated-road', rel: [8429969], ref: 'Hindon Elevated Road', class: 'City road', category: 'local' },

  // ── alignments for roads already in the catalogue ─────────────────
  { id: 'chennai-peripheral-ring-road', rel: [17140245], geometryOnly: true },
  { id: 'hyderabad-regional-ring-road', rel: [17154678], geometryOnly: true },
  { id: 'pune-ring-road', rel: [17154586], geometryOnly: true },
]

const onlyArg = process.argv.indexOf('--only')
const ONLY = onlyArg === -1 ? null : process.argv[onlyArg + 1].split(',').map((s) => s.trim())
const GEOMETRY_ONLY = process.argv.includes('--geometry-only')

/** Greedy end-to-end stitch of unordered way segments. */
function stitch(segments) {
  if (!segments.length) return []
  const pool = [...segments].sort((a, b) => lineLengthKm(b) - lineLengthKm(a))
  let chain = pool.shift()
  let guard = pool.length + 5
  while (pool.length && guard-- > 0) {
    const head = chain[0]
    const tail = chain[chain.length - 1]
    let best = { d: Infinity, i: -1, atHead: false, rev: false }
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i]
      for (const o of [
        { d: haversineKm(tail, s[0]), atHead: false, rev: false },
        { d: haversineKm(tail, s[s.length - 1]), atHead: false, rev: true },
        { d: haversineKm(head, s[s.length - 1]), atHead: true, rev: false },
        { d: haversineKm(head, s[0]), atHead: true, rev: true },
      ]) if (o.d < best.d) best = { ...o, i }
    }
    if (best.i === -1 || best.d > 5) break // a city road has no 5 km gaps in it
    const seg = pool.splice(best.i, 1)[0]
    const oriented = best.rev ? [...seg].reverse() : seg
    chain = best.atHead ? oriented.concat(chain) : chain.concat(oriented)
  }
  return chain
}

let ok = 0
let failed = 0

for (const entry of NAMED_ROADS) {
  if (ONLY && !ONLY.includes(entry.id)) continue
  if (GEOMETRY_ONLY && !entry.geometryOnly) continue
  const exists = existsSync(join(ROADS_DIR, `${entry.id}.json`))
  if (entry.geometryOnly && !exists) {
    console.log(`  ! ${entry.id}: marked geometry-only but there is no road file to attach it to`)
    failed++
    continue
  }

  let json
  try {
    json = await overpass(`relation(id:${entry.rel.join(',')});out geom;`, { timeout: 180 })
  } catch (e) {
    console.log(`  ! ${entry.id}: ${e.message}`)
    failed++
    continue
  }

  const ways = (json.elements ?? [])
    .filter((e) => e.type === 'relation')
    .flatMap((r) => r.members ?? [])
    .filter((m) => m.type === 'way' && Array.isArray(m.geometry) && m.geometry.length > 1)
    .map((m) => m.geometry.map((g) => [g.lon, g.lat]))
  // dual carriageways come down as two parallel ways; stitching both end to
  // end would report a ring road at twice its circumference
  const line = stitch(dedupeWays(ways))
  if (line.length < 2) {
    console.log(`  ! ${entry.id}: relation has no usable geometry`)
    failed++
    continue
  }

  const coords = simplify(line, 0.02).map(([x, y]) => [round5(x), round5(y)])
  const km = Math.round(lineLengthKm(coords) * 10) / 10
  const existing = exists ? JSON.parse(readFileSync(join(ROADS_DIR, `${entry.id}.json`), 'utf8')) : null
  if (existing) {
    const ratio = km / existing.lengthKm
    if (ratio < 0.75 || ratio > 1.4) {
      console.log(`  ~ ${entry.id}: OSM says ${km} km, the catalogue says ${existing.lengthKm} km — leaving it alone`)
      failed++
      continue
    }
  }

  writeCache(
    {
      id: entry.id,
      ref: entry.ref ?? existing?.ref ?? entry.id,
      class: entry.class ?? 'Road',
      category: entry.category ?? existing?.category ?? 'local',
      authority: 'state',
      named: true,
      relationIds: entry.rel,
      lengthKm: km,
      bridgedKm: 0,
      coords,
    },
    'routes',
    `${entry.id}.json`,
  )
  console.log(`  ✓ ${entry.id}: ${km} km, ${coords.length} points${exists ? ' (alignment only — road file already exists)' : ''}`)
  ok++
  await sleep(1500)
}

console.log(`\n${ok} cached, ${failed} failed. Now run: node scripts/generate-roads.mjs`)
