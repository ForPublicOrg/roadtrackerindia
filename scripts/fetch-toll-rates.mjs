#!/usr/bin/env node
/**
 * Pull official toll rates from NHAI's Toll Information System and write them
 * into the road files.
 *
 *   node scripts/fetch-toll-rates.mjs --dry     # report what would change
 *   node scripts/fetch-toll-rates.mjs           # write
 *   node scripts/fetch-toll-rates.mjs --force   # also overwrite authored rates
 *
 * IMPORTANT: tis.nhai.gov.in only answers from inside India. From anywhere else
 * the request times out and this script exits without touching anything.
 *
 * A plaza is attached to a road only when BOTH agree: the NH number matches,
 * and the plaza's coordinates sit within MATCH_KM of that road's alignment.
 * NH numbers were reshuffled in 2010 and TIS still carries old ones in places,
 * so the number alone is not enough.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ROADS_DIR = join(ROOT, 'public', 'data', 'roads')
const SHAPES_DIR = join(ROOT, 'public', 'data', 'shapes')
const CACHE_DIR = join(ROOT, '.cache', 'nhai')
const CACHE_FILE = join(CACHE_DIR, 'toll-plazas.json')

const DRY = process.argv.includes('--dry')
const FORCE = process.argv.includes('--force')
const REFRESH = process.argv.includes('--refresh')
const MATCH_KM = 6

const SOURCE = {
  title: 'NHAI Toll Information System',
  url: 'https://tis.nhai.gov.in/',
}
const ENDPOINTS = [
  'https://tis.nhai.gov.in/TollPlazaService.asmx/GetTollPlazaInfoForMapOnPC',
  'http://tis.nhai.gov.in/TollPlazaService.asmx/GetTollPlazaInfoForMapOnPC',
]

// ── fetching ────────────────────────────────────────────────────────

async function download() {
  if (existsSync(CACHE_FILE) && !REFRESH) {
    console.log(`Using cached ${CACHE_FILE} (pass --refresh to refetch)`)
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
  }
  let lastError
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          // the portal 406s anonymous clients, same as Overpass
          'User-Agent': 'RoadTrackerIndia/1.0 (+https://roadtrackerindia.com)',
        },
        body: '{}',
        signal: AbortSignal.timeout(90_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      // the service wraps its payload in {"d": "<json string>"}
      let data = JSON.parse(text)
      if (typeof data?.d === 'string') data = JSON.parse(data.d)
      else if (data?.d) data = data.d
      const rows = Array.isArray(data) ? data : (data?.TollPlazas ?? data?.tollPlazas ?? [])
      if (!Array.isArray(rows) || rows.length === 0) throw new Error('no plaza rows in response')
      mkdirSync(CACHE_DIR, { recursive: true })
      writeFileSync(CACHE_FILE, JSON.stringify(rows))
      console.log(`Fetched ${rows.length} toll plazas from ${new URL(url).host}`)
      return rows
    } catch (e) {
      lastError = e
      console.warn(`  ${url} → ${e.message}`)
    }
  }
  console.error(
    `\n✗ Could not reach NHAI's Toll Information System (${lastError?.message}).\n` +
      `  It only answers from inside India. If you are in India and this still fails,\n` +
      `  open https://tis.nhai.gov.in/ in a browser to check the service is up.`,
  )
  process.exit(1)
}

// ── shaping ─────────────────────────────────────────────────────────

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** TIS spells its rate columns a dozen ways; match on the shape of the words. */
const CLASS_MATCHERS = [
  ['car', (k) => k.includes('car') || k.includes('jeep') || k.includes('lmv')],
  ['lcv', (k) => k.includes('lcv') || k.includes('lgv') || k.includes('minibus')],
  ['bus', (k) => (k.includes('bus') || k.includes('truck')) && !k.includes('mini')],
  ['axle3', (k) => k.includes('3axle') || k.includes('upto3axle') || k.includes('threeaxle')],
  ['hcm', (k) => k.includes('hcm') || k.includes('eme') || k.includes('4to6') || k.includes('multiaxle')],
  ['oversized', (k) => k.includes('7ormore') || k.includes('morethan7') || k.includes('oversize')],
]

function ratesOf(row) {
  const out = {}
  for (const [key, value] of Object.entries(row)) {
    const k = norm(key)
    if (!/(fee|rate|charge|singl|oneway|amount)/.test(k) && !CLASS_MATCHERS.some(([, m]) => m(k))) continue
    const n = Number(String(value).replace(/[^\d.]/g, ''))
    if (!Number.isFinite(n) || n <= 0 || n > 20000) continue
    const hit = CLASS_MATCHERS.find(([, m]) => m(k))
    if (hit && out[hit[0]] === undefined) out[hit[0]] = Math.round(n)
  }
  return out
}

const pick = (row, ...names) => {
  for (const [key, value] of Object.entries(row)) {
    if (names.some((n) => norm(key) === norm(n)) && value != null && value !== '') return value
  }
  return undefined
}

/** "NH-44", "NH 44 (Old NH-7)", "44" → "44" */
function nhNumber(row) {
  const raw = String(pick(row, 'NHNo', 'NH_No', 'NationalHighwayNumber', 'NH', 'HighwayNumber') ?? '')
  const m = raw.match(/(\d+[A-Za-z]?)/)
  return m ? m[1].toLowerCase() : null
}

// ── geometry ────────────────────────────────────────────────────────

const R = 6371
function haversineKm([lng1, lat1], [lng2, lat2]) {
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/** Closest approach of a point to a road's drawn alignment, in km. */
function distanceToShape(point, coords) {
  let best = Infinity
  for (const c of coords) {
    const d = haversineKm(point, c)
    if (d < best) best = d
    if (best < 0.4) break
  }
  return best
}

// ── editing road files without reformatting them ────────────────────
// JSON.stringify would put every `"coords": [77.5, 28.4]` on three lines and
// bury the actual change, so top-level keys are spliced in as text.

const TOP_KEY = (key) => new RegExp(`^ {2}"${key}":`)

/** The line range a top-level key occupies, including any multi-line value. */
function keyRange(lines, key) {
  const start = lines.findIndex((l) => TOP_KEY(key).test(l))
  if (start === -1) return null
  const open = lines[start].trimEnd().slice(-1)
  if (open !== '[' && open !== '{') return { start, end: start }
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[\]}],?$/.test(lines[i])) return { start, end: i }
  }
  return null
}

const ANCHORS = ['authority', 'agency', 'lanes', 'lengthKm']

/** Replace `key` if it is there, otherwise insert it below a sensible anchor. */
function spliceKey(text, key, render) {
  const lines = text.split('\n')
  const range = keyRange(lines, key)
  if (range) {
    const hadComma = lines[range.end].trimEnd().endsWith(',')
    lines.splice(range.start, range.end - range.start + 1, ...render(hadComma).split('\n'))
    return lines.join('\n')
  }
  for (const anchor of ANCHORS) {
    const r = keyRange(lines, anchor)
    if (!r || !lines[r.end].trimEnd().endsWith(',')) continue
    lines.splice(r.end + 1, 0, ...render(true).split('\n'))
    return lines.join('\n')
  }
  return null
}

const renderRates = (rates) =>
  `{ ${Object.entries(rates)
    .map(([k, v]) => `"${k}": ${v}`)
    .join(', ')} }`

const renderTolls = (plazas) => (comma) =>
  `  "tolls": [\n` +
  plazas
    .map((p) => `    { "name": ${JSON.stringify(p.name)}, "rates": ${renderRates(p.rates)} }`)
    .join(',\n') +
  `\n  ]${comma ? ',' : ''}`

const renderTollInfo = (asOf) => (comma) =>
  `  "tollInfo": {\n` +
  `    "tolled": true,\n` +
  `    "asOf": ${JSON.stringify(asOf)},\n` +
  `    "source": { "title": ${JSON.stringify(SOURCE.title)}, "url": ${JSON.stringify(SOURCE.url)} }\n` +
  `  }${comma ? ',' : ''}`

const shapeCache = new Map()
function shapeOf(id) {
  if (shapeCache.has(id)) return shapeCache.get(id)
  let coords = null
  try {
    coords = JSON.parse(readFileSync(join(SHAPES_DIR, `${id}.json`), 'utf8')).geometry.coordinates
  } catch {
    /* no shape built yet — run npm run data first */
  }
  shapeCache.set(id, coords)
  return coords
}

// ── main ────────────────────────────────────────────────────────────

const rows = await download()

const roads = readdirSync(ROADS_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ file: f, road: JSON.parse(readFileSync(join(ROADS_DIR, f), 'utf8')) }))

/** "44" → the nh-44 road file, when we have one */
const byNh = new Map()
for (const entry of roads) {
  const m = entry.road.id.match(/^nh-(\d+[a-z]?)$/)
  if (m) byNh.set(m[1], entry)
}

const matched = new Map() // roadId → plaza[]
let unmatched = 0
let noRates = 0
let effective = null

for (const row of rows) {
  const nh = nhNumber(row)
  const entry = nh ? byNh.get(nh) : null
  if (!entry) {
    unmatched++
    continue
  }
  const lat = Number(pick(row, 'Latitude', 'lat', 'Lat'))
  const lng = Number(pick(row, 'Longitude', 'lng', 'Lon', 'Long'))
  const shape = shapeOf(entry.road.id)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !shape) {
    unmatched++
    continue
  }
  if (distanceToShape([lng, lat], shape) > MATCH_KM) {
    unmatched++ // right number, wrong road — almost always the pre-2010 numbering
    continue
  }
  const rates = ratesOf(row)
  if (!Object.keys(rates).length) {
    noRates++
    continue
  }
  const name = String(pick(row, 'TollName', 'TollPlazaName', 'PlazaName', 'Name') ?? '').trim()
  if (!name) continue
  const from = pick(row, 'FeeEffectiveDate', 'EffectiveDate', 'FeeEffectiveFrom')
  if (from && !effective) {
    const d = new Date(from)
    if (!Number.isNaN(d.getTime())) effective = d.toISOString().slice(0, 10)
  }
  if (!matched.has(entry.road.id)) matched.set(entry.road.id, [])
  matched.get(entry.road.id).push({ name, note: undefined, rates })
}

const asOf = effective ?? new Date().toISOString().slice(0, 10)

let written = 0
let skipped = 0
for (const [id, plazas] of matched) {
  const entry = roads.find((r) => r.road.id === id)
  const road = entry.road
  if (road.tollInfo?.asOf && !FORCE) {
    skipped++
    continue
  }
  if (road.tollInfo?.tolled === false && !FORCE) {
    console.warn(`  ! ${id} is marked toll-free but TIS lists ${plazas.length} plaza(s) — left alone`)
    skipped++
    continue
  }
  const path = join(ROADS_DIR, entry.file)
  let text = readFileSync(path, 'utf8')
  const withTolls = spliceKey(text, 'tolls', renderTolls(plazas))
  const withInfo = withTolls && spliceKey(withTolls, 'tollInfo', renderTollInfo(asOf))
  if (!withInfo) {
    console.warn(`  ! ${id}: no safe place to write toll rates — left alone`)
    skipped++
    continue
  }
  try {
    JSON.parse(withInfo) // never write a file we just broke
  } catch (e) {
    console.warn(`  ! ${id}: edit would produce invalid JSON (${e.message}) — left alone`)
    skipped++
    continue
  }
  written++
  if (!DRY) writeFileSync(path, withInfo)
}

console.log(
  `${DRY ? 'Would update' : 'Updated'} ${written} road(s) with ${[...matched.values()].reduce(
    (n, p) => n + p.length,
    0,
  )} toll plazas (rates effective ${asOf}).`,
)
console.log(
  `  ${skipped} road(s) left alone (already have authored rates — pass --force to replace), ` +
    `${unmatched} plaza(s) matched no road in the catalogue, ${noRates} with no readable rates.`,
)
if (!DRY && written) console.log('  Run `npm run data` to revalidate.')
