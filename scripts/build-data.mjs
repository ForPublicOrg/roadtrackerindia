#!/usr/bin/env node
/**
 * RoadTracker India — data build step.
 *
 * Reads   public/data/roads/<id>.json          (hand-authored, single source of truth)
 * Reads   data/orgs/<id>.json                  (hand-authored organisation profiles)
 * Reads   public/data/geometry/<id>.json       (optional real OSM geometry override)
 * Writes  public/data/index.json               (search/browse index)
 * Writes  public/data/network-lite.geojson     (simplified all-roads overview)
 * Writes  public/data/places.json              (where every city and state is)
 * Writes  public/data/shapes/<id>.json         (display geometry per road)
 * Writes  public/data/orgs.json                (organisation index with rollups)
 * Writes  public/data/org/<id>.json            (profile + every road it touched)
 *
 * Validates every road file against docs/DATA.md and every organisation against
 * docs/ORGS.md. Errors fail the build.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DATA_DIR = join(ROOT, 'public', 'data')
const ROADS_DIR = join(DATA_DIR, 'roads')
// real alignments live outside public/ — they are a build input, not a download
const GEOM_DIR = join(ROOT, 'data', 'geometry')
const LEGACY_GEOM_DIR = join(DATA_DIR, 'geometry')
const SHAPES_DIR = join(DATA_DIR, 'shapes')
// organisations are authored outside public/ because what the browser downloads
// is the authored file *plus* the road list the build rolls up for it
const ORGS_SRC_DIR = join(ROOT, 'data', 'orgs')
const ORGS_OUT_DIR = join(DATA_DIR, 'org')
// ids that used to be their own road before the catalogue found they were
// another name for one it already had — /road/<old-id>/ has to keep working
const MERGED_FILE = join(ROOT, 'data', 'merged-roads.json')

const CATEGORIES = ['nh', 'expressway', 'sh', 'district', 'local']
const STATUSES = ['operational', 'under-construction', 'planned']
const BBOX = { minLng: 67.5, minLat: 6.0, maxLng: 97.6, maxLat: 37.5 }
const KNOWN_KEYS = new Set([
  'id', 'ref', 'name', 'category', 'status', 'lengthKm', 'route', 'waypoints', 'sources',
  'aka', 'completionPercent', 'lanes', 'agency', 'cost', 'contractor', 'tolls', 'timeline',
  'history', 'facts',
  'significance', 'engineering', 'interchanges', 'relatedRoads', 'travelNotes',
  'futureUpgrades', 'newsQuery', 'provenance',
  'authority', 'builtBy', 'operatedBy', 'helplines', 'tollInfo',
])

// ── organisations (docs/ORGS.md) ────────────────────────────────────

const ORG_TYPES = ['authority', 'pwd', 'psu', 'developer', 'contractor', 'operator']
const ORG_KNOWN_KEYS = new Set([
  'id', 'name', 'type', 'summary', 'sources',
  'shortName', 'aka', 'founded', 'headquarters', 'ownership', 'website', 'about',
  'facts', 'helplines', 'grievance',
])
const HELPLINE_KINDS = ['emergency', 'complaint', 'control-room', 'info']
/** Cheapest, most one-way ordering first — used for the transposition check. */
const VEHICLE_CLASSES = ['car', 'lcv', 'bus', 'axle3', 'hcm', 'oversized']
/** National short codes anyone may publish without their own source. */
const NATIONAL_NUMBERS = new Set(['112', '100', '101', '102', '108', '1033', '1073', '1091', '1098', '1099', '139'])

const PHONE_FORMATS = [
  /^\d{3,4}$/,                         // short code: 112, 108, 1033
  /^1800[- ]\d{2,4}[- ]\d{3,4}$/,      // toll-free
  /^0\d{2,4}-\d{6,8}$/,                // landline with STD code
  /^\+91-\d{10}$/,                     // mobile
]
const validPhone = (n) => typeof n === 'string' && PHONE_FORMATS.some((re) => re.test(n))

/**
 * Helplines are the one field where a mistake sends someone to the wrong number
 * in an emergency, so the format is checked rather than trusted.
 */
function validateHelplines(list, err, where) {
  if (list === undefined) return
  if (!Array.isArray(list)) return err(`"${where}" must be an array`)
  list.forEach((h, i) => {
    const at = `${where}[${i}]`
    if (!h || typeof h !== 'object') return err(`${at} must be an object`)
    if (!HELPLINE_KINDS.includes(h.kind)) err(`${at} "kind" must be one of ${HELPLINE_KINDS.join(', ')}`)
    if (typeof h.label !== 'string' || !h.label.trim()) err(`${at} needs a "label"`)
    if (!validPhone(h.number))
      err(`${at} "number" (${h.number}) is not a recognised format — use 1033, 0120-2345678, +91-9876543210 or 1800-XXX-XXXX`)
    if (h.note !== undefined && typeof h.note !== 'string') err(`${at} "note" must be a string`)
  })
}

function validateRates(rates, err, warn, where) {
  if (rates === undefined) return false
  if (!rates || typeof rates !== 'object' || Array.isArray(rates)) {
    err(`"${where}" must be an object of vehicle class → ₹`)
    return false
  }
  const keys = Object.keys(rates)
  if (keys.length === 0) err(`"${where}" is empty — omit it instead`)
  for (const k of keys) {
    if (!VEHICLE_CLASSES.includes(k)) err(`"${where}" has unknown vehicle class "${k}" (use ${VEHICLE_CLASSES.join(', ')})`)
    else if (typeof rates[k] !== 'number' || rates[k] <= 0 || rates[k] > 20000)
      err(`"${where}.${k}" must be a positive ₹ amount under 20000`)
  }
  // heavier vehicles always pay more — a dip means two columns got swapped
  const present = VEHICLE_CLASSES.filter((c) => typeof rates[c] === 'number')
  for (let i = 1; i < present.length; i++) {
    if (rates[present[i]] < rates[present[i - 1]])
      warn(`"${where}": ${present[i]} (₹${rates[present[i]]}) costs less than ${present[i - 1]} (₹${rates[present[i - 1]]}) — columns may be swapped`)
  }
  return keys.length > 0
}

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
const round4 = (n) => Math.round(n * 1e4) / 1e4
const round3 = (n) => Math.round(n * 1e3) / 1e3

/** Decode a Google-style encoded polyline into [lng, lat] pairs. */
function decodePolyline(str, precision = 5) {
  const factor = 10 ** precision
  const coords = []
  let i = 0
  let lat = 0
  let lng = 0
  while (i < str.length) {
    for (const axis of [0, 1]) {
      let result = 0
      let shift = 0
      let byte
      do {
        byte = str.charCodeAt(i++) - 63
        result |= (byte & 0x1f) << shift
        shift += 5
      } while (byte >= 0x20)
      const delta = result & 1 ? ~(result >> 1) : result >> 1
      if (axis === 0) lat += delta
      else lng += delta
    }
    coords.push([lng / factor, lat / factor])
  }
  return coords
}

const hasRealGeometry = (id) =>
  existsSync(join(GEOM_DIR, `${id}.json`)) || existsSync(join(LEGACY_GEOM_DIR, `${id}.json`))

/**
 * The real alignment for a road, if we have one: an encoded polyline in
 * data/geometry/, or a plain LineString in the legacy public/data/geometry/.
 */
function realGeometry(id) {
  // Legacy first: public/data/geometry/ is the hand-placed override, and
  // data/geometry/ is bulk-generated. The other order made a curated alignment
  // (and `npm run fetch-geometry`) a silent no-op.
  for (const dir of [LEGACY_GEOM_DIR, GEOM_DIR]) {
    const file = join(dir, `${id}.json`)
    if (!existsSync(file)) continue
    try {
      const g = JSON.parse(readFileSync(file, 'utf8'))
      if (g?.type === 'Polyline' && typeof g.data === 'string') {
        const coords = decodePolyline(g.data, g.precision ?? 5)
        if (coords.length > 1) return coords
      }
      const geom = g?.type === 'Feature' ? g.geometry : g
      if (geom?.type === 'LineString' && Array.isArray(geom.coordinates) && geom.coordinates.length > 1) {
        return geom.coordinates
      }
      return { error: 'geometry override is not a LineString or Polyline' }
    } catch {
      return { error: 'unreadable geometry override' }
    }
  }
  return null
}

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
      // waypoints only drive the map when there is no real alignment, so the
      // shape check is noise for roads whose geometry comes from OSM
      const pl = polyLenKm(coords)
      const ratio = pl / road.lengthKm
      if ((ratio < 0.5 || ratio > 1.45) && !hasRealGeometry(road.id))
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
    err(`"tolls" must be an array of { name, note?, rates? }`)
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

  // ── who is behind the road, what it costs, who to ring ──
  if (road.authority !== undefined && (typeof road.authority !== 'string' || !road.authority.trim()))
    err(`"authority" must be an organisation id`)
  for (const key of ['builtBy', 'operatedBy']) {
    if (road[key] === undefined) continue
    if (!Array.isArray(road[key])) {
      err(`"${key}" must be an array of { org | name, note? }`)
      continue
    }
    road[key].forEach((o, i) => {
      if (!o || typeof o !== 'object') err(`"${key}[${i}]" must be an object`)
      else if (!o.org && !o.name) err(`"${key}[${i}]" needs either "org" (an organisation id) or "name"`)
    })
  }
  validateHelplines(road.helplines, err, 'helplines')

  let hasRates = false
  ;(Array.isArray(road.tolls) ? road.tolls : []).forEach((t, i) => {
    if (t && validateRates(t.rates, err, warn, `tolls[${i}].rates`)) hasRates = true
  })
  const ti = road.tollInfo
  if (ti !== undefined) {
    if (!ti || typeof ti !== 'object' || Array.isArray(ti)) {
      err(`"tollInfo" must be an object`)
    } else {
      if (ti.tolled !== undefined && typeof ti.tolled !== 'boolean') err(`"tollInfo.tolled" must be true or false`)
      if (validateRates(ti.endToEnd, err, warn, 'tollInfo.endToEnd')) hasRates = true
      if (ti.asOf !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(ti.asOf))
        err(`"tollInfo.asOf" must be a YYYY-MM-DD date`)
      if (ti.note !== undefined && typeof ti.note !== 'string') err(`"tollInfo.note" must be a string`)
      if (ti.passes !== undefined && (!Array.isArray(ti.passes) || ti.passes.some((p) => typeof p !== 'string')))
        err(`"tollInfo.passes" must be an array of strings`)
      if (ti.source !== undefined && (!ti.source || typeof ti.source.title !== 'string' || !/^https:\/\//.test(String(ti.source.url))))
        err(`"tollInfo.source" needs "title" and an https "url"`)
      if (ti.tolled === false && hasRates) err(`"tollInfo.tolled" is false but toll rates are listed`)
    }
  }
  // an undated rate is a lie waiting to happen — Indian tolls change every April
  if (hasRates && !ti?.asOf) err(`toll rates are listed but "tollInfo.asOf" is missing — say when they took effect`)

  for (const key of Object.keys(road)) {
    if (!KNOWN_KEYS.has(key)) warn(`unknown key "${key}" (ignored)`)
  }

  return { errors, warnings }
}

function validateOrg(org, file) {
  const errors = []
  const warnings = []
  const err = (m) => errors.push(`orgs/${file}: ${m}`)

  const id = file.replace(/\.json$/, '')
  if (org.id !== id) err(`"id" (${org.id}) must match filename (${id})`)
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(org.id ?? ''))) err(`"id" must be kebab-case`)
  for (const key of ['name', 'summary']) {
    if (typeof org[key] !== 'string' || !org[key].trim()) err(`"${key}" is required (non-empty string)`)
  }
  if (!ORG_TYPES.includes(org.type)) err(`"type" must be one of ${ORG_TYPES.join(', ')}`)
  if (!Array.isArray(org.sources) || org.sources.length === 0) {
    err(`"sources" must have at least one entry`)
  } else {
    org.sources.forEach((s, i) => {
      if (!s || typeof s.title !== 'string' || !/^https:\/\//.test(String(s.url)))
        err(`sources[${i}] needs "title" and an https "url"`)
    })
  }
  for (const key of ['shortName', 'founded', 'headquarters', 'ownership', 'about']) {
    if (org[key] !== undefined && (typeof org[key] !== 'string' || !org[key].trim()))
      err(`"${key}" must be a non-empty string`)
  }
  if (org.website !== undefined && !/^https:\/\//.test(String(org.website))) err(`"website" must be an https URL`)
  for (const key of ['facts', 'aka']) {
    if (org[key] !== undefined && (!Array.isArray(org[key]) || org[key].some((f) => typeof f !== 'string')))
      err(`"${key}" must be an array of strings`)
  }
  validateHelplines(org.helplines, err, 'helplines')
  // publishing a number nobody else publishes means owning it — say where it came from
  for (const h of org.helplines ?? []) {
    if (validPhone(h?.number) && !NATIONAL_NUMBERS.has(h.number) && !org.website && !(org.sources ?? []).length)
      err(`helpline ${h.number} is not a national short code — link the page that publishes it`)
  }
  if (org.grievance !== undefined) {
    const g = org.grievance
    if (!g || typeof g !== 'object' || Array.isArray(g)) err(`"grievance" must be an object`)
    else {
      if (g.url !== undefined && !/^https:\/\//.test(String(g.url))) err(`"grievance.url" must be an https URL`)
      for (const key of ['app', 'email', 'note']) {
        if (g[key] !== undefined && typeof g[key] !== 'string') err(`"grievance.${key}" must be a string`)
      }
    }
  }
  for (const key of Object.keys(org)) {
    if (!ORG_KNOWN_KEYS.has(key)) warnings.push(`orgs/${file}: unknown key "${key}" (ignored)`)
  }
  return { errors, warnings }
}

/** "About ₹1,00,000 crore (approx.)" → 100000. Null when there is no figure. */
function parseCrore(cost) {
  if (typeof cost !== 'string') return null
  const m = cost.replace(/,/g, '').match(/([\d.]+)\s*(lakh\s+)?crore/i)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  return m[2] ? n * 100000 : n
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

// ── merged roads ────────────────────────────────────────────────────
const aliases = {}
if (existsSync(MERGED_FILE)) {
  let map = {}
  try {
    map = JSON.parse(readFileSync(MERGED_FILE, 'utf8')).aliases ?? {}
  } catch (e) {
    allErrors.push(`merged-roads.json: invalid JSON — ${e.message}`)
  }
  for (const [from, to] of Object.entries(map)) {
    // a merged id that still has a file is a half-done merge: the old road is
    // live *and* claims to be the new one, and the two pages disagree
    if (allIds.has(from)) allErrors.push(`merged-roads.json: "${from}" is merged into "${to}" but public/data/roads/${from}.json still exists`)
    else if (!allIds.has(to)) allErrors.push(`merged-roads.json: "${from}" points at "${to}", which is not in the catalogue`)
    else aliases[from] = to
  }
}

// ── organisations ───────────────────────────────────────────────────
const orgs = new Map()
for (const file of existsSync(ORGS_SRC_DIR)
  ? readdirSync(ORGS_SRC_DIR).filter((f) => f.endsWith('.json')).sort()
  : []) {
  let org
  try {
    org = JSON.parse(readFileSync(join(ORGS_SRC_DIR, file), 'utf8'))
  } catch (e) {
    allErrors.push(`orgs/${file}: invalid JSON — ${e.message}`)
    continue
  }
  const { errors, warnings } = validateOrg(org, file)
  allErrors.push(...errors)
  allWarnings.push(...warnings)
  if (errors.length === 0) orgs.set(org.id, org)
}

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
  // a dangling org id would silently drop the road off that company's profile
  for (const ref of [
    ...(road?.authority ? [{ org: road.authority, from: 'authority' }] : []),
    ...(road?.builtBy ?? []).map((o) => ({ org: o?.org, from: 'builtBy' })),
    ...(road?.operatedBy ?? []).map((o) => ({ org: o?.org, from: 'operatedBy' })),
  ]) {
    if (ref.org && !orgs.has(ref.org))
      errors.push(`${file}: ${ref.from} points at organisation "${ref.org}" — no data/orgs/${ref.org}.json`)
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

// Derive outputs. Shapes are overwritten in place and stale ones swept at the
// end rather than wiping the directory first — a second build (or a dev server
// rebuilding on watch) must never find the folder momentarily empty.
mkdirSync(SHAPES_DIR, { recursive: true })
const staleShapes = new Set(readdirSync(SHAPES_DIR).filter((f) => f.endsWith('.json')))

const CATEGORY_ORDER = { expressway: 0, nh: 1, sh: 2, district: 3, local: 4 }
roads.sort(
  (a, b) => (CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]) || b.lengthKm - a.lengthKm
)

/**
 * The overview map is split in two. Expressways, national highways and city
 * roads are the trunk network — a few hundred lines, loaded at startup. State
 * and district roads are thousands of lines that only matter once you zoom in,
 * so they ship separately and the map fetches them on demand.
 */
const isTrunk = (road) => road.category !== 'sh' && road.category !== 'district'

const indexRows = []
const liteFeatures = []
const detailFeatures = []
let realGeomCount = 0

for (const road of roads) {
  let base = road.waypoints.map((w) => w.coords)
  let real = false
  const geom = realGeometry(road.id)
  if (Array.isArray(geom)) {
    base = geom
    real = true
    realGeomCount++
  } else if (geom?.error) {
    allWarnings.push(`${road.id}: ${geom.error} — using waypoints`)
  }

  const closed = base.length > 4 && haversineKm(base[0], base[base.length - 1]) < 1
  // Overview tolerance, scaled to the road: short urban roads need a tight one
  // or they collapse to chords, while a 3,000 km highway drawn at 1 m fidelity
  // would cost megabytes to say something the screen renders as a few pixels.
  // The full-fidelity shape is fetched anyway the moment a road is selected.
  // The detail tier only appears from zoom 7 (≈300 m per pixel), and any road
  // the user actually opens is redrawn from its full-fidelity shape, so it can
  // be far coarser than the trunk network that is on screen at every zoom.
  const liteTol = isTrunk(road)
    ? road.lengthKm < 30 ? 0.05 : road.lengthKm < 120 ? 0.15 : road.lengthKm < 400 ? 0.35 : 0.7
    : Math.max(0.08, Math.min(0.3, road.lengthKm / 400))
  const shape = real
    ? simplify(base, 0.04)
    : simplify(chaikin(base, 3, closed), 0.06)
  const lite = real
    ? simplify(base, liteTol)
    : simplify(chaikin(base, 2, closed), liteTol)

  // spread-based Math.min blows the stack on a 30,000-point alignment
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of shape) {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  // only ever used to frame the camera, so ~100 m precision is plenty
  const bbox = [round3(minX), round3(minY), round3(maxX), round3(maxY)]

  staleShapes.delete(`${road.id}.json`)
  writeFileSync(
    join(SHAPES_DIR, `${road.id}.json`),
    JSON.stringify({
      type: 'Feature',
      properties: { id: road.id, real },
      geometry: { type: 'LineString', coordinates: shape.map((c) => [round5(c[0]), round5(c[1])]) },
    })
  )

  ;(isTrunk(road) ? liteFeatures : detailFeatures).push({
    type: 'Feature',
    properties: {
      id: road.id,
      ref: road.ref,
      name: road.name,
      category: road.category,
      status: road.status,
      lengthKm: road.lengthKm,
    },
    // 4 decimals is ~11 m — finer than the overview can draw, and 15% smaller
    geometry: { type: 'LineString', coordinates: lite.map((c) => [round4(c[0]), round4(c[1])]) },
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
  JSON.stringify({
    generated: new Date().toISOString(),
    count: indexRows.length,
    roads: indexRows,
    aliases,
  })
)
writeFileSync(
  join(DATA_DIR, 'network-lite.geojson'),
  JSON.stringify({ type: 'FeatureCollection', features: liteFeatures })
)
writeFileSync(
  join(DATA_DIR, 'network-detail.geojson'),
  JSON.stringify({ type: 'FeatureCollection', features: detailFeatures })
)
// shapes for roads that no longer exist
for (const f of staleShapes) rmSync(join(SHAPES_DIR, f), { force: true })

// ── place extents ───────────────────────────────────────────────────
// Nothing in the corpus records a coordinate for a town — only roads have
// geometry. But every road both names the places it passes through and carries
// a waypoint for each, so a place sits at the knot where those waypoints agree.
// India reuses its place names freely (two Srinagars, eleven Ramgarhs), so only
// the densest cluster survives, weighted towards the bigger roads: the Srinagar
// on NH 44 is the one somebody typing "Srinagar" means.

const placeNorm = (s) =>
  s.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[–—-]/g, ' ').replace(/\s+/g, ' ').trim()

const PLACE_WEIGHT = { expressway: 5, nh: 4, sh: 2, district: 1, local: 1 }
const placeWeight = (road) => (PLACE_WEIGHT[road.category] ?? 1) + Math.min(6, road.lengthKm / 300)

/** normalised place name → weighted points, and the spellings the index uses. */
const placePoints = new Map()
const placeNames = new Map()
/** normalised place name → the roads that claim to run through it. */
const placeRoads = new Map()

function notePlace(name, coords, weight, indexed) {
  const key = placeNorm(name)
  if (!key) return
  if (!placePoints.has(key)) placePoints.set(key, [])
  placePoints.get(key).push({ coords, weight })
  if (!indexed) return
  if (!placeNames.has(key)) placeNames.set(key, new Set())
  placeNames.get(key).add(name)
}

for (const road of roads) {
  const w = placeWeight(road)
  const byName = new Map()
  for (const p of road.waypoints) {
    const key = placeNorm(p.name)
    if (!byName.has(key)) byName.set(key, p.coords)
  }
  // only majorCities reach the search index, so only they need a display name
  for (const city of road.route.majorCities) {
    const key = placeNorm(city)
    if (!placeRoads.has(key)) placeRoads.set(key, [])
    placeRoads.get(key).push(road)
    const hit = byName.get(key)
    if (hit) notePlace(city, hit, w, true)
    else notePlace(city, null, 0, true) // known to the index, position unknown
  }
  // the terminus names are the first and last point of the alignment by
  // construction, which pins places that never appear as a waypoint of their own
  const first = road.waypoints[0].coords
  const last = road.waypoints[road.waypoints.length - 1].coords
  notePlace(road.route.start.split(',')[0], first, w, false)
  notePlace(road.route.end.split(',')[0], last, w, false)
}

const degKm = (dx, dy) => Math.hypot(dx * 100, dy * 111)
const CLUSTER_KM = 45

/** The heaviest knot of same-name points, with the other towns of that name dropped. */
function densestCluster(points) {
  if (points.length < 3) return points
  const cells = new Map()
  for (const p of points) {
    const key = `${Math.round(p.coords[0] * 2)}|${Math.round(p.coords[1] * 2)}`
    if (!cells.has(key)) cells.set(key, [])
    cells.get(key).push(p)
  }
  let best = null
  for (const key of cells.keys()) {
    const [cx, cy] = key.split('|').map(Number)
    let weight = 0
    let members = []
    // count the neighbouring cells too, or a knot straddling a cell edge loses
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const near = cells.get(`${cx + dx}|${cy + dy}`)
        if (!near) continue
        for (const p of near) weight += p.weight
        members = members.concat(near)
      }
    if (!best || weight > best.weight) best = { weight, members }
  }
  let seed = centroid(best.members)
  for (let i = 0; i < 2; i++) {
    const near = points.filter((p) => degKm(p.coords[0] - seed[0], p.coords[1] - seed[1]) <= CLUSTER_KM)
    if (!near.length) break
    seed = centroid(near)
  }
  const kept = points.filter((p) => degKm(p.coords[0] - seed[0], p.coords[1] - seed[1]) <= CLUSTER_KM)
  // two equally-heavy towns of the same name can leave the centroid in open
  // country between them, further than the radius from either — never return
  // nothing, or the place ends up with no extent at all
  return kept.length ? kept : best.members
}

function centroid(points) {
  let sx = 0, sy = 0, sw = 0
  for (const p of points) {
    const w = p.weight || 0.01
    sx += p.coords[0] * w
    sy += p.coords[1] * w
    sw += w
  }
  return [sx / sw, sy / sw]
}

/** Grow a point cloud into a box the camera can fly to. */
function extentOf(points, { pad = 0.03, minSpan = 0.14 } = {}) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity
  for (const p of points) {
    const [x, y] = p.coords ?? p
    a = Math.min(a, x); c = Math.max(c, x)
    b = Math.min(b, y); d = Math.max(d, y)
  }
  if (a === Infinity) return null
  a -= pad; b -= pad; c += pad; d += pad
  const gapX = minSpan - (c - a)
  if (gapX > 0) { a -= gapX / 2; c += gapX / 2 }
  const gapY = minSpan - (d - b)
  if (gapY > 0) { b -= gapY / 2; d += gapY / 2 }
  return [round3(a), round3(b), round3(c), round3(d)]
}

const bboxById = new Map(indexRows.map((r) => [r.id, r.bbox]))

// A waypoint is a pinprick, and a city is not. What tells Mumbai apart from a
// village of the same importance to the catalogue is the roads that belong to
// it alone — a short road naming a place is a road *of* that place, so it gets
// to stretch the extent. Everything is still held inside a radius no town
// outgrows, or one long district road would swallow the district.
const CITY_LOCAL_KM = 40
const CITY_NEAR_KM = 20
const CITY_MAX_KM = 22

const clampAround = (box, seed, maxKm) => [
  round3(Math.max(box[0], seed[0] - maxKm / 100)),
  round3(Math.max(box[1], seed[1] - maxKm / 111)),
  round3(Math.min(box[2], seed[0] + maxKm / 100)),
  round3(Math.min(box[3], seed[1] + maxKm / 111)),
]

const cityRows = []
let unplacedCities = 0
for (const [key, spellings] of placeNames) {
  const points = (placePoints.get(key) ?? []).filter((p) => p.coords)
  if (!points.length) {
    unplacedCities++
    continue
  }
  const knot = densestCluster(points)
  const seed = centroid(knot)
  const corners = knot.map((p) => p.coords)
  for (const road of placeRoads.get(key) ?? []) {
    const box = bboxById.get(road.id)
    if (!box || road.lengthKm > CITY_LOCAL_KM) continue
    const middle = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]
    if (degKm(middle[0] - seed[0], middle[1] - seed[1]) > CITY_NEAR_KM) continue
    corners.push([box[0], box[1]], [box[2], box[3]])
  }
  const box = clampAround(extentOf(corners), seed, CITY_MAX_KM)
  for (const name of spellings) cityRows.push([name, ...box])
}
cityRows.sort((a, b) => a[0].localeCompare(b[0]))

// A state is framed by the roads that never leave it — their combined extent is
// the state, minus whatever corner no road reaches. Roads that cross a border
// still contribute the terminus that names the state they end in.
const stateBoxes = new Map()
const stretch = (box, x, y) =>
  box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y]

for (const road of roads) {
  const box = bboxById.get(road.id)
  if (!box) continue
  if (road.route.states.length === 1) {
    const st = road.route.states[0]
    stateBoxes.set(st, stretch(stretch(stateBoxes.get(st), box[0], box[1]), box[2], box[3]))
    continue
  }
  for (const [text, point] of [
    [road.route.start, road.waypoints[0].coords],
    [road.route.end, road.waypoints[road.waypoints.length - 1].coords],
  ]) {
    const tail = text.split(',').pop().trim()
    if (road.route.states.includes(tail))
      stateBoxes.set(tail, stretch(stateBoxes.get(tail), point[0], point[1]))
  }
}

// A state the catalogue barely reaches has nothing to triangulate from — fall
// back to the whole extent of its roads, which at least points the map at it.
const everyState = new Set()
for (const road of roads) road.route.states.forEach((s) => everyState.add(s))
const looseStates = []
for (const st of everyState) {
  if (stateBoxes.has(st)) continue
  looseStates.push(st)
  let box = null
  for (const road of roads) {
    if (!road.route.states.includes(st)) continue
    const b = bboxById.get(road.id)
    if (b) box = stretch(stretch(box, b[0], b[1]), b[2], b[3])
  }
  if (box) stateBoxes.set(st, box)
}

const stateRows = [...stateBoxes]
  .map(([name, box]) => [name, ...extentOf([[box[0], box[1]], [box[2], box[3]]], { pad: 0.06, minSpan: 0.3 })])
  .sort((a, b) => a[0].localeCompare(b[0]))

writeFileSync(
  join(DATA_DIR, 'places.json'),
  JSON.stringify({ generated: new Date().toISOString(), cities: cityRows, states: stateRows })
)
if (unplacedCities)
  allWarnings.push(`${unplacedCities} city name(s) have no waypoint to place them — search will list them without zooming`)
if (looseStates.length)
  allWarnings.push(`no road stays inside ${looseStates.join(', ')} — their map extent is only as tight as the roads that cross them`)

// ── organisation profiles ───────────────────────────────────────────
// Every "how many roads has this company built" figure is counted here, from
// the road files. Nothing about scale or spend is ever authored by hand.

/** orgId → roadId → { roles, notes } — notes are per role, since a company can
 *  have built a road for one reason and run it for another. */
const orgRoads = new Map()
for (const org of orgs.keys()) orgRoads.set(org, new Map())

function attach(orgId, road, role, note) {
  const bucket = orgRoads.get(orgId)
  if (!bucket) return // unknown ids already failed validation
  const entry = bucket.get(road.id) ?? { roles: [], notes: {} }
  if (!entry.roles.includes(role)) entry.roles.push(role)
  if (note && !entry.notes[role]) entry.notes[role] = note
  bucket.set(road.id, entry)
}

for (const road of roads) {
  if (road.authority) attach(road.authority, road, 'authority')
  for (const o of road.builtBy ?? []) if (o?.org) attach(o.org, road, 'built', o.note)
  for (const o of road.operatedBy ?? []) if (o?.org) attach(o.org, road, 'operates', o.note)
}

rmSync(ORGS_OUT_DIR, { recursive: true, force: true })
mkdirSync(ORGS_OUT_DIR, { recursive: true })

const roadById = new Map(roads.map((r) => [r.id, r]))
const orgRows = []
for (const [id, org] of orgs) {
  const bucket = orgRoads.get(id)
  const list = [...bucket.entries()]
    .map(([roadId, e]) => ({
      id: roadId,
      roles: e.roles,
      ...(Object.keys(e.notes).length ? { notes: e.notes } : {}),
    }))
    .sort((a, b) => roadById.get(b.id).lengthKm - roadById.get(a.id).lengthKm)

  const states = new Set()
  let lengthKm = 0
  let costCrore = 0
  let costedRoads = 0
  let underConstruction = 0
  for (const entry of list) {
    const road = roadById.get(entry.id)
    lengthKm += road.lengthKm
    road.route.states.forEach((s) => states.add(s))
    if (road.status === 'under-construction') underConstruction++
    const crore = parseCrore(road.cost)
    if (crore !== null) {
      costCrore += crore
      costedRoads++
    }
  }
  const stats = {
    roadCount: list.length,
    authorityCount: list.filter((e) => e.roles.includes('authority')).length,
    builtCount: list.filter((e) => e.roles.includes('built')).length,
    operatesCount: list.filter((e) => e.roles.includes('operates')).length,
    lengthKm: Math.round(lengthKm),
    costCrore: Math.round(costCrore),
    costedRoads,
    underConstruction,
    states: [...states].sort(),
  }

  if (list.length === 0) allWarnings.push(`orgs/${id}.json: no road links to this organisation yet`)

  writeFileSync(join(ORGS_OUT_DIR, `${id}.json`), JSON.stringify({ ...org, stats, roads: list }))
  orgRows.push({
    id,
    name: org.name,
    ...(org.shortName ? { shortName: org.shortName } : {}),
    type: org.type,
    summary: org.summary,
    stats,
  })
}

// biggest first — that is the order both the browse list and search want
orgRows.sort((a, b) => b.stats.lengthKm - a.stats.lengthKm || a.name.localeCompare(b.name))
writeFileSync(
  join(DATA_DIR, 'orgs.json'),
  JSON.stringify({ generated: new Date().toISOString(), count: orgRows.length, orgs: orgRows })
)

const kb = (n) => `${Math.round(n / 1024).toLocaleString('en-IN')} KB`
const sizeOf = (f) => statSync(join(DATA_DIR, f)).size
for (const w of allWarnings) console.warn(`  warn  ${w}`)
console.log(
  `✓ ${roads.length} roads validated (${realGeomCount} with real OSM geometry, ${allWarnings.length} warnings)\n` +
    `  index.json ${kb(sizeOf('index.json'))} · network-lite ${kb(sizeOf('network-lite.geojson'))} ` +
    `(${liteFeatures.length} trunk roads) · network-detail ${kb(sizeOf('network-detail.geojson'))} ` +
    `(${detailFeatures.length} state & district roads)\n` +
    `  places.json ${kb(sizeOf('places.json'))} (${cityRows.length} cities, ${stateRows.length} states & UTs)\n` +
    `  orgs.json ${kb(sizeOf('orgs.json'))} (${orgRows.length} organisations, ` +
    `${orgRows.filter((o) => o.stats.roadCount > 0).length} with roads on file)`
)
