#!/usr/bin/env node
/**
 * Builds India's full external land boundary as depicted on Survey of India
 * maps, and writes it to public/data/india-boundary.geojson (a committed
 * static asset drawn by src/mapstyle.ts as the country's border line).
 *
 * Why this exists: the base-map tiles follow OSM's de-facto borders, where
 * Jammu & Kashmir is cut by the Line of Control and Aksai Chin sits outside
 * India. The legal Indian depiction draws one solid external boundary around
 * the whole of J&K (including Azad Kashmir, Gilgit-Baltistan, the Shaksgam
 * valley) and Aksai Chin. The tiles don't carry enough tagging to restyle
 * that line into existence, so we assemble it from OSM source data:
 *
 *   1. The outer edge of legal J&K = ways used by exactly ONE of the four
 *      administrative areas {Indian J&K, Ladakh, Azad Kashmir,
 *      Gilgit-Baltistan} (ways used by two are internal — that includes the
 *      LoC and the Siachen AGPL, which is exactly what we want gone).
 *   2. Ways shared with Himachal Pradesh / Indian Punjab are the internal
 *      seam with the rest of India — dropped.
 *   3. The de-facto arcs around Aksai Chin (LAC) and Shaksgam (1963
 *      Sino-Pakistan line) are replaced by OSM's "Extent of Indian Claim"
 *      relations via ring surgery.
 *   4. The rest of India's land border = member ways of the India relation,
 *      minus coastline, minus disputed lines inside the J&K box.
 *
 *   node scripts/fetch-india-boundary.mjs
 *
 * Re-run only if OSM boundaries change materially. Sequential + throttled.
 * Data © OpenStreetMap contributors, ODbL.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'public', 'data', 'india-boundary.geojson')

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

const REL = {
  indiaJK: 1943188, // Jammu and Kashmir (UT)
  ladakh: 5515045, // Ladakh (UT)
  azadKashmir: 3780130, // آزاد کشمیر (PK-JK)
  gilgitBaltistan: 357995, // گلگت بلتستان (PK-GB)
  claimAksaiChin: 13559370, // "Extent of Indian Claim at Aksai Chin" (line)
  claimShaksgam: 13559372, // "Extent of Indian Claim at Shaksgam Valley" (line)
  india: 304716,
}

// ── geo helpers (self-contained on purpose) ───────────────────────

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

/** Greedy end-to-end stitching of unordered segments into one chain. */
function stitchOne(segments, maxGapKm) {
  segments.sort((a, b) => lineLen(b) - lineLen(a))
  let chain = segments.shift()
  let guard = segments.length * 2 + 5
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
    if (best.i === -1 || best.d > maxGapKm) break
    const seg = segments.splice(best.i, 1)[0]
    const oriented = best.rev ? [...seg].reverse() : seg
    chain = best.where === 'tail' ? chain.concat(oriented) : oriented.concat(chain)
  }
  return chain
}

function stitchAll(segments, maxGapKm = 1) {
  const chains = []
  const pool = segments.slice()
  while (pool.length) chains.push(stitchOne(pool, maxGapKm))
  chains.sort((a, b) => lineLen(b) - lineLen(a))
  return chains
}

// ── overpass ──────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function overpass(query, label) {
  let lastErr
  for (let round = 0; round < 5; round++) {
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'RoadTrackerIndia-data-build/1.0 (https://roadtrackerindia.com)',
            Accept: 'application/json',
          },
          body: `data=${encodeURIComponent(query)}`,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (!json.elements) throw new Error('malformed response')
        console.log(`  ✓ ${label}: ${json.elements.length} elements`)
        return json
      } catch (e) {
        lastErr = e
        console.log(`  ! ${label} via ${new URL(url).host}: ${e.message} — retrying`)
        await sleep(15000 + round * 15000)
      }
    }
  }
  throw lastErr
}

/** Member ways (id + [lng,lat][] + tags) of one relation. */
async function relationWays(relId, label) {
  const json = await overpass(`[out:json][timeout:120];rel(${relId});way(r);out tags geom;`, label)
  return json.elements
    .filter((e) => e.type === 'way' && Array.isArray(e.geometry) && e.geometry.length > 1)
    .map((w) => ({
      id: w.id,
      tags: w.tags ?? {},
      coords: w.geometry.map((g) => [g.lon, g.lat]),
    }))
}

// ── assembly ──────────────────────────────────────────────────────

console.log('Fetching OSM boundary data (7 queries, throttled)…')
const pieces = []
for (const key of ['indiaJK', 'ladakh', 'azadKashmir', 'gilgitBaltistan']) {
  pieces.push(await relationWays(REL[key], key))
  await sleep(1500)
}
const claimAksai = await relationWays(REL.claimAksaiChin, 'claimAksaiChin')
await sleep(1500)
const claimShaksgam = await relationWays(REL.claimShaksgam, 'claimShaksgam')
await sleep(1500)
const seamJson = await overpass(
  `[out:json][timeout:120];(rel["ISO3166-2"="IN-HP"]["admin_level"="4"];rel["ISO3166-2"="IN-PB"]["admin_level"="4"];)->.r;way(r.r);out ids;`,
  'HP+PB seam way ids',
)
const seamIds = new Set(seamJson.elements.filter((e) => e.type === 'way').map((e) => e.id))
await sleep(1500)
const indiaJson = await overpass(
  `[out:json][timeout:300];rel(${REL.india});way(r)["natural"!="coastline"]["maritime"!="yes"];out tags geom;`,
  'India land-border ways',
)

// 1. Outer edge of legal J&K: ways used by exactly one of the four areas.
//    (Ways used by two are internal seams — LoC, AGPL, GB/AJK line, etc.)
const useCount = new Map()
for (const ways of pieces) for (const w of ways) useCount.set(w.id, (useCount.get(w.id) ?? 0) + 1)
const outer = []
const seen = new Set()
for (const ways of pieces) {
  for (const w of ways) {
    if (useCount.get(w.id) !== 1 || seen.has(w.id) || seamIds.has(w.id)) continue
    seen.add(w.id)
    outer.push(w.coords)
  }
}
console.log(`legal J&K outer edge: ${outer.length} ways`)

// The outer ways stitch into one open chain (open where the HP/PB seam was).
const jkChains = stitchAll(outer)
let jkRing = jkChains[0]
if (jkChains.length > 1)
  console.log(`  note: ${jkChains.length - 1} extra J&K fragment(s) — keeping the main chain + fragments`)

// 2. Ring surgery: replace the de-facto arc between each claim line's
//    endpoints (the shorter way around) with the claim line itself.
function spliceClaim(chain, claimWays, label) {
  const line = stitchAll(claimWays.map((w) => w.coords))[0]
  const nearestIdx = (pt) => {
    let bi = 0
    let bd = Infinity
    for (let i = 0; i < chain.length; i++) {
      const d = haversineKm(chain[i], pt)
      if (d < bd) {
        bd = d
        bi = i
      }
    }
    return [bi, bd]
  }
  let [ia, da] = nearestIdx(line[0])
  let [ib, db] = nearestIdx(line[line.length - 1])
  if (da > 5 || db > 5) throw new Error(`${label}: claim line does not touch the ring (${da.toFixed(1)} / ${db.toFixed(1)} km)`)
  let oriented = line
  if (ia > ib) {
    ;[ia, ib] = [ib, ia]
    oriented = [...line].reverse()
  }
  const inner = chain.slice(ia, ib + 1)
  const innerKm = lineLen(inner)
  // chain is open (not a closed ring object), so the arc between the two
  // indices is the de-facto arc; sanity-check it is the short local one
  if (innerKm > lineLen(oriented) * 4 + 500)
    throw new Error(`${label}: refusing to replace a ${Math.round(innerKm)} km arc`)
  console.log(`  splice ${label}: +${Math.round(lineLen(oriented))} km claim, −${Math.round(innerKm)} km de-facto arc`)
  return chain.slice(0, ia + 1).concat(oriented.slice(1, -1), chain.slice(ib))
}
jkRing = spliceClaim(jkRing, claimAksai, 'Aksai Chin')
jkRing = spliceClaim(jkRing, claimShaksgam, 'Shaksgam')

// 3. India's de-facto land border, minus disputed lines inside the J&K box
//    (LoC / AGPL / LAC — all replaced by the ring above).
const inJKBox = (coords) => coords.some(([lon, lat]) => lat > 32.15 && lon < 80.7)
const isDisputed = (t) =>
  t.disputed === 'yes' ||
  !!t.disputed_name ||
  !!t.claimed_by ||
  t.boundary === 'disputed' ||
  t.boundary === 'claim' ||
  t.border_status === 'dispute'
const landWays = []
let droppedCount = 0
for (const e of indiaJson.elements) {
  if (e.type !== 'way' || !Array.isArray(e.geometry) || e.geometry.length < 2) continue
  const coords = e.geometry.map((g) => [g.lon, g.lat])
  if (isDisputed(e.tags ?? {}) && inJKBox(coords)) {
    droppedCount++
    continue
  }
  landWays.push(coords)
}
console.log(`india land ways: kept ${landWays.length}, dropped ${droppedCount} disputed in J&K box`)

// 4. Stitch, drop stray fragments (open chains under 15 km are artifacts;
//    short CLOSED chains are real — e.g. the Dahagram–Angarpota enclave).
const isClosedChain = (c) => haversineKm(c[0], c[c.length - 1]) < 0.5
const chains = stitchAll([jkRing, ...jkChains.slice(1), ...landWays])
  .filter((c) => lineLen(c) > 15 || (isClosedChain(c) && lineLen(c) > 2))
  .map((c) => simplify(c, 0.05).map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]))

const totalKm = Math.round(chains.reduce((s, c) => s + lineLen(c), 0))
const points = chains.reduce((s, c) => s + c.length, 0)

writeFileSync(
  OUT,
  JSON.stringify({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          name: 'India external land boundary (Survey of India depiction)',
          source: '© OpenStreetMap contributors, ODbL',
        },
        geometry: { type: 'MultiLineString', coordinates: chains },
      },
    ],
  }),
)
console.log(`✓ wrote public/data/india-boundary.geojson — ${chains.length} line(s), ${points} points, ~${totalKm} km`)
for (const c of chains.slice(0, 8))
  console.log(`   ${Math.round(lineLen(c))} km  [${c[0]}] … [${c[c.length - 1]}]${isClosedChain(c) ? ' (closed)' : ''}`)
