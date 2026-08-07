#!/usr/bin/env node
/**
 * Stage 1 of the corpus build: pull EVERY Indian road route from OpenStreetMap.
 *
 *   node scripts/fetch-osm-roads.mjs --list         # enumerate + group only (fast)
 *   node scripts/fetch-osm-roads.mjs                # + fetch geometry for each road
 *   node scripts/fetch-osm-roads.mjs --force        # refetch geometry already cached
 *   node scripts/fetch-osm-roads.mjs --limit 50     # stop after N roads (smoke test)
 *
 * Writes .cache/osm/relations.json (raw relation tags) and
 * .cache/osm/routes/<id>.json (one stitched alignment per designation).
 * Data © OpenStreetMap contributors, ODbL.
 */
import { existsSync, readdirSync } from 'node:fs'
import {
  BBOX, cachePath, haversineKm, lineLengthKm, overpass, readCache, round5, simplify, sleep,
  writeCache,
} from './lib/overpass.mjs'

const LIST_ONLY = process.argv.includes('--list')
const FORCE = process.argv.includes('--force')
const BULK = process.argv.includes('--bulk')
const numArg = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i > -1 ? Number(process.argv[i + 1]) : fallback
}
const LIMIT = numArg('--limit', Infinity)
// --from/--to slice the work list so two workers can run side by side:
//   node scripts/fetch-osm-roads.mjs --to 400
//   OVERPASS_START=1 node scripts/fetch-osm-roads.mjs --from 400
const FROM = numArg('--from', 0)
const TO = numArg('--to', Infinity)
// --category nh,expressway prioritises the roads people actually look up
const catArg = process.argv.indexOf('--category')
const CATEGORIES = catArg > -1 ? process.argv[catArg + 1].split(',').map((s) => s.trim()) : null

/** State/UT code → name, for IN:SH:<code> networks. */
const STATE_CODE = {
  AP: 'Andhra Pradesh', AR: 'Arunachal Pradesh', AS: 'Assam', BR: 'Bihar', BH: 'Bihar',
  CT: 'Chhattisgarh', CG: 'Chhattisgarh', GA: 'Goa', GJ: 'Gujarat', HR: 'Haryana',
  HP: 'Himachal Pradesh', JH: 'Jharkhand', JK: 'Jammu and Kashmir', KA: 'Karnataka',
  KL: 'Kerala', LA: 'Ladakh', MP: 'Madhya Pradesh', MH: 'Maharashtra', MN: 'Manipur',
  ML: 'Meghalaya', MZ: 'Mizoram', NL: 'Nagaland', OR: 'Odisha', OD: 'Odisha',
  PB: 'Punjab', PJ: 'Punjab', RJ: 'Rajasthan', SK: 'Sikkim', TN: 'Tamil Nadu',
  TG: 'Telangana', TS: 'Telangana', TR: 'Tripura', UP: 'Uttar Pradesh', UK: 'Uttarakhand',
  UT: 'Uttarakhand', WB: 'West Bengal', DL: 'Delhi', PY: 'Puducherry', CH: 'Chandigarh',
  AN: 'Andaman and Nicobar Islands', DN: 'Dadra and Nagar Haveli and Daman and Diu',
  LD: 'Lakshadweep',
}

// ── enumerate ────────────────────────────────────────────────────────

async function listRelations() {
  if (!FORCE && existsSync(cachePath('relations.json'))) {
    const cached = readCache('relations.json')
    if (cached?.length) return cached
  }
  console.log('Listing every route=road relation in India…')
  const json = await overpass(`
    relation["type"="route"]["route"="road"]["network"~"^IN:"]${BBOX};
    out tags;
  `)
  const els = (json.elements ?? []).map((e) => ({ id: e.id, tags: e.tags ?? {} }))
  writeCache(els, 'relations.json')
  return els
}

/**
 * Class-prefix aliases seen in the wild, longest first so "MDR" wins over "MD".
 * Anything left between the alias and the digits is a variant letter that is
 * part of the designation — Tamil Nadu's "SHU171" is State Highway (Urban) 171.
 */
const REF_ALIASES = {
  nh: ['NH', 'N'],
  ne: ['NE'],
  sh: ['MSH', 'SH', 'S'],
  mdr: ['MDR', 'MD', 'M'],
  odr: ['ODR', 'OD', 'O'],
  scr: ['SCR', 'SC'],
}

/**
 * "NH 44" / "nh-44" / "SHU171" / "MDR002" → { number, variant }.
 * `kind` is the class implied by the network tag. Returns null if there is no
 * usable number, or if the prefix clearly belongs to a different class.
 */
function parseRef(ref, kind) {
  if (!ref) return null
  const cleaned = String(ref).split(';')[0].trim().replace(/[\s.\-–_]+/g, '').toUpperCase()
  const m = cleaned.match(/^([A-Z]*)(\d+)([A-Z]{0,2})$/)
  if (!m) return null
  let [, prefix, digits, suffix] = m
  const aliases = REF_ALIASES[kind] ?? []
  const alias = aliases.find((a) => prefix.startsWith(a))
  if (prefix && !alias) return null // e.g. an "MDR" ref inside an SH network
  const variant = alias ? prefix.slice(alias.length) : prefix
  if (variant.length > 2) return null
  const number = String(Number(digits)) + suffix // MDR002 → 2, NH 44A → 44A
  return { number, variant }
}

/** Designation strings for ids and display: ("44","") → "44" · ("171","U") → "u171". */
const refKey = (p) => `${p.variant.toLowerCase()}${p.number.toLowerCase()}`
const refLabel = (cls, p) => `${cls}${p.variant ? `-${p.variant}` : ''} ${p.number}`

/** Recover a designation from a route name when `ref` is missing or useless. */
function refFromName(name, kind) {
  const m = String(name ?? '').match(
    /(?:National Highway|State Highway(?:s)?(?:\s+(Urban))?|National Expressway|Major District Road|Other District Road|NH|SH|NE|MDR|ODR)[\s.\-–]*(\d+\s?[A-Za-z]{0,2})\b/i,
  )
  if (!m) return null
  const parsed = parseRef(m[2], kind)
  if (!parsed) return null
  if (m[1]) parsed.variant = 'U'
  return parsed
}

/** Carriageway halves and per-state slices share one road — strip the suffix. */
function baseName(name) {
  return String(name ?? '')
    .replace(/\s*[–—-]?\s*\b(north|south|east|west|northbound|southbound|eastbound|westbound)(bound)?\s*(carriageway|side|section)?\s*$/i, '')
    .replace(/\s*\b(carriageway|section|part)\s*[-–]?\s*[0-9IVX]*\s*$/i, '')
    .replace(/\s+in\s+[A-Z][a-z]+(\s[A-Z][a-z]+)?\s*$/i, '')
    .trim()
}

/** A name that describes a real road (used when there is no number at all). */
const NAMED_ROAD_RE = /\b(expressway|mahamarg|freeway|ring road|bypass|setu|marg|link road|corridor)\b/i

/**
 * Generic class words. A name made only of these ("Other District Road",
 * "State Highway") identifies no particular road, so it cannot become one —
 * a real name carries a proper noun ("Yamuna Expressway", "Mumbai Ring Road").
 */
const GENERIC_WORDS = new Set([
  'other', 'major', 'district', 'state', 'national', 'village', 'rural', 'main', 'link',
  'road', 'roads', 'highway', 'highways', 'expressway', 'freeway', 'corridor', 'ring',
  'bypass', 'marg', 'setu', 'mahamarg', 'the', 'of', 'in', 'and', 'to', 'new', 'old',
  'inner', 'outer', 'north', 'south', 'east', 'west', 'route', 'nh', 'sh', 'ne', 'mdr', 'odr',
])
const hasProperNoun = (name) =>
  name
    .split(/[\s,\-–—()]+/)
    .filter(Boolean)
    .some((w) => !GENERIC_WORDS.has(w.toLowerCase()) && /^[A-Za-z][A-Za-z'.]*$/.test(w))

// truncate first, then trim separators — the other order leaves ids like
// "kl-perumpuzhakkadavu-…-ala-" that fail the kebab-case check
const slug = (s) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '')

const EXPRESSWAY_RE = /expressway|mahamarg|samruddhi|freeway|trans harbour|atal setu|e-?way/i
const OLD_RE = /\bold\b|prior to 2010|former/i

/**
 * Turn raw relations into road designations: one entry per road, holding every
 * relation that makes it up (highways are commonly split per state).
 */
function group(relations) {
  const roads = new Map()
  const skipped = { old: 0, unparseable: 0, nonRoad: 0 }

  for (const rel of relations) {
    const t = rel.tags
    const network = t.network ?? ''
    const name = t['name:en'] ?? t.name ?? ''

    // historical alignments are explicitly kept out of the catalogue
    if (!t.ref && (t['ref:old'] || OLD_RE.test(name))) {
      skipped.old++
      continue
    }
    if (OLD_RE.test(name) && !t.ref) {
      skipped.old++
      continue
    }

    // which class of road the network tag says this is, and whose road it is
    let kind = null
    let stateCode = ''
    if (/^IN:NH(:|$)/.test(network)) kind = 'nh'
    else if (network === 'IN:NE' || network === 'IN:EC') kind = 'ne'
    else if (/^IN:SH(:|$)/.test(network) || /^IN:[A-Z]{2}:SH$/.test(network)) kind = 'sh'
    else if (/^IN:MDR(:|$)/.test(network) || /^IN:[A-Z]{2}:MDR$/.test(network)) kind = 'mdr'
    else if (/^IN:ODR(:|$)/.test(network)) kind = 'odr'
    else if (/^IN:SCR(:|$)/.test(network)) kind = 'scr'
    else {
      skipped.nonRoad++
      continue
    }
    if (kind !== 'nh' && kind !== 'ne') {
      const parts = network.split(':')
      stateCode = (STATE_CODE[(parts[2] ?? '').toUpperCase()] ? parts[2] : parts[1] ?? '').toUpperCase()
    }
    const stateName = STATE_CODE[stateCode]
    if (kind !== 'nh' && kind !== 'ne' && !stateName) {
      skipped.unparseable++
      continue
    }

    const CLASS = { nh: 'NH', ne: 'NE', sh: 'SH', mdr: 'MDR', odr: 'ODR', scr: 'SCR' }
    const CATEGORY = { nh: 'nh', ne: 'expressway', sh: 'sh', mdr: 'district', odr: 'district', scr: 'district' }
    const parsed = parseRef(t.ref ?? t.nat_ref, kind) ?? refFromName(name, kind)

    let key = null
    let entry = null
    if (parsed) {
      const scope = kind === 'nh' || kind === 'ne' ? '' : `${stateCode.toLowerCase()}-`
      key = `${kind}-${scope}${refKey(parsed)}`
      entry = {
        id: key,
        ref: refLabel(CLASS[kind], parsed),
        class: CLASS[kind],
        category: CATEGORY[kind],
        authority: stateName ?? 'national',
      }
    } else {
      // no number anywhere: keep it if the name identifies a particular road
      // (named expressways, ring roads, and Kerala's named district roads)
      const base = baseName(name)
      const namedOk = base.length > 5 && hasProperNoun(base) && (NAMED_ROAD_RE.test(base) || (kind !== 'nh' && /\broad\b/i.test(base)))
      if (!namedOk || !slug(base)) {
        skipped.unparseable++
        continue
      }
      const scope = stateCode ? `${stateCode.toLowerCase()}-` : ''
      key = `${scope}${slug(base)}`
      entry = {
        id: key,
        ref: base,
        class: CLASS[kind],
        category: EXPRESSWAY_RE.test(base) ? 'expressway' : CATEGORY[kind] === 'nh' ? 'nh' : CATEGORY[kind],
        authority: stateName ?? 'national',
        named: true,
      }
    }

    // a name that says "Expressway" outranks the network's category
    if (EXPRESSWAY_RE.test(name) && entry.category === 'nh') entry.expresswayName = baseName(name)

    const existing = roads.get(key)
    if (existing) {
      existing.relationIds.push(rel.id)
      if (!existing.name && name) existing.name = name
      for (const k of ['wikidata', 'wikipedia']) if (t[k] && !existing[k]) existing[k] = t[k]
    } else {
      roads.set(key, {
        ...entry,
        name: name || '',
        relationIds: [rel.id],
        wikidata: t.wikidata,
        wikipedia: t.wikipedia,
      })
    }
  }
  return { roads, skipped }
}

// ── stitching ────────────────────────────────────────────────────────

/**
 * Greedy end-to-end assembly. Segments that cannot be joined within `maxGapKm`
 * start a new chain; the chains are then joined nearest-first, so a road with
 * real gaps in OSM still comes out as one drawable line.
 */
function stitch(segments, maxGapKm = 12) {
  const segs = segments.filter((s) => s.length > 1).sort((a, b) => lineLengthKm(b) - lineLengthKm(a))
  const chains = []
  while (segs.length) {
    let chain = segs.shift()
    let grew = true
    while (grew && segs.length) {
      grew = false
      const head = chain[0]
      const tail = chain[chain.length - 1]
      let best = { d: Infinity, i: -1, where: 'tail', rev: false }
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i]
        const opts = [
          { d: haversineKm(tail, s[0]), where: 'tail', rev: false },
          { d: haversineKm(tail, s[s.length - 1]), where: 'tail', rev: true },
          { d: haversineKm(head, s[s.length - 1]), where: 'head', rev: false },
          { d: haversineKm(head, s[0]), where: 'head', rev: true },
        ]
        for (const o of opts) if (o.d < best.d) best = { ...o, i }
      }
      if (best.i === -1 || best.d > maxGapKm) break
      const seg = segs.splice(best.i, 1)[0]
      const oriented = best.rev ? [...seg].reverse() : seg
      chain = best.where === 'tail' ? chain.concat(oriented) : oriented.concat(chain)
      grew = true
    }
    chains.push(chain)
  }

  // join the leftover chains nearest-first, tracking how much is bridged
  chains.sort((a, b) => lineLengthKm(b) - lineLengthKm(a))
  let line = chains.shift() ?? []
  let bridged = 0
  while (chains.length) {
    const head = line[0]
    const tail = line[line.length - 1]
    let best = { d: Infinity, i: -1, where: 'tail', rev: false }
    for (let i = 0; i < chains.length; i++) {
      const s = chains[i]
      const opts = [
        { d: haversineKm(tail, s[0]), where: 'tail', rev: false },
        { d: haversineKm(tail, s[s.length - 1]), where: 'tail', rev: true },
        { d: haversineKm(head, s[s.length - 1]), where: 'head', rev: false },
        { d: haversineKm(head, s[0]), where: 'head', rev: true },
      ]
      for (const o of opts) if (o.d < best.d) best = { ...o, i }
    }
    if (best.i === -1) break
    const seg = chains.splice(best.i, 1)[0]
    // a tiny stray chain across a huge gap is noise, not road — drop it
    if (best.d > 40 && lineLengthKm(seg) < best.d) continue
    bridged += best.d
    const oriented = best.rev ? [...seg].reverse() : seg
    line = best.where === 'tail' ? line.concat(oriented) : oriented.concat(line)
  }
  return { line, bridged }
}

/**
 * One road is described by many overlapping relations (per state, per stretch,
 * plus a whole-route one) and divided highways are mapped as two parallel
 * carriageways. Both inflate a naive merge, so ways are deduplicated twice:
 * by OSM way id, then geometrically — a way whose path is already covered by
 * longer ways already taken is a duplicate or the opposite carriageway.
 */
const CELL = 0.0025 // ~275 m — wider than any carriageway separation

function cellsOf(coords) {
  const cells = new Set()
  const add = (x, y) => cells.add(`${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`)
  for (let i = 0; i < coords.length; i++) {
    const [x, y] = coords[i]
    add(x, y)
    if (i === 0) continue
    const [px, py] = coords[i - 1]
    const steps = Math.ceil(Math.max(Math.abs(x - px), Math.abs(y - py)) / CELL)
    for (let k = 1; k < steps; k++) add(px + ((x - px) * k) / steps, py + ((y - py) * k) / steps)
  }
  return cells
}

function collectWays(rels) {
  const byWay = new Map()
  for (const rel of rels) {
    for (const m of rel.members ?? []) {
      if (m.type !== 'way' || !Array.isArray(m.geometry) || m.geometry.length < 2) continue
      if (!byWay.has(m.ref)) byWay.set(m.ref, m.geometry.map((g) => [g.lon, g.lat]))
    }
  }
  return dedupeWays([...byWay.values()])
}

/** Drop ways whose path is already covered — duplicates and opposite carriageways. */
function dedupeWays(input) {
  const ways = [...input].sort((a, b) => lineLengthKm(b) - lineLengthKm(a))

  const covered = new Set()
  const kept = []
  for (const way of ways) {
    const cells = cellsOf(way)
    let hits = 0
    for (const c of cells) {
      const [cx, cy] = c.split(':').map(Number)
      // a one-cell halo absorbs carriageways that straddle a cell boundary
      if (
        covered.has(c) ||
        covered.has(`${cx + 1}:${cy}`) || covered.has(`${cx - 1}:${cy}`) ||
        covered.has(`${cx}:${cy + 1}`) || covered.has(`${cx}:${cy - 1}`)
      ) hits++
    }
    if (cells.size && hits / cells.size >= 0.75) continue // already on the map
    for (const c of cells) covered.add(c)
    kept.push(way)
  }
  return kept
}

// ── bulk mode ────────────────────────────────────────────────────────

/**
 * Asking for one road at a time re-downloads every way that two relations
 * share, and a national highway's ways are shared a lot. Bulk mode instead
 * pulls a whole network in one query — relations without geometry, then their
 * ways *once* — and joins them by way id locally. Kerala's 2,332 district
 * roads come down in a handful of requests instead of two hundred.
 */
async function fetchChunk(relationIds) {
  const json = await overpass(
    `relation(id:${relationIds.join(',')});out;way(r);out geom;`,
    { timeout: 600, retries: 2 },
  )
  const ways = new Map()
  const rels = new Map()
  for (const el of json.elements ?? []) {
    if (el.type === 'way' && Array.isArray(el.geometry)) {
      ways.set(el.id, el.geometry.map((g) => [g.lon, g.lat]))
    } else if (el.type === 'relation') {
      rels.set(el.id, el)
    }
  }
  return { ways, rels }
}

/**
 * How many relations to ask for at once. A national highway is thousands of
 * dense ways; a district road is a handful.
 */
const CHUNK_RELATIONS = { nh: 40, expressway: 40, sh: 120, district: 300 }

async function runBulk(all) {
  const todo = all
    .filter((r) => (CATEGORIES ? CATEGORIES.includes(r.category) : true))
    .filter((r) => FORCE || !existsSync(cachePath('routes', `${r.id}.json`)))
  console.log(`\nBulk mode: ${todo.length} roads to fetch\n`)

  let ok = 0
  let empty = 0
  let failed = 0
  let done = 0

  const write = (road, ways) => {
    const segments = dedupeWays(ways)
    const { line, bridged } = segments.length ? stitch(segments) : { line: [], bridged: 0 }
    const lengthKm = line.length > 1 ? lineLengthKm(line) : 0
    if (lengthKm < 0.5) {
      empty++
      writeCache({ ...road, coords: [], lengthKm: 0, empty: true }, 'routes', `${road.id}.json`)
      return
    }
    const coords = simplify(line, 0.02).map(([x, y]) => [round5(x), round5(y)])
    writeCache(
      { ...road, coords, lengthKm: Math.round(lengthKm * 10) / 10, bridgedKm: Math.round(bridged * 10) / 10 },
      'routes',
      `${road.id}.json`,
    )
    ok++
  }

  // Chunks are built from whole roads, never split mid-road: every relation a
  // road is made of has to land in the same response, or its alignment comes
  // back missing the stretches described by the relations that didn't.
  const byCategory = new Map()
  for (const road of todo) {
    if (!byCategory.has(road.category)) byCategory.set(road.category, [])
    byCategory.get(road.category).push(road)
  }

  for (const [category, roads] of byCategory) {
    const limit = CHUNK_RELATIONS[category] ?? 100
    let chunk = []
    let chunkRels = 0
    const flush = async () => {
      if (!chunk.length) return
      const batch = chunk
      chunk = []
      chunkRels = 0
      const ids = [...new Set(batch.flatMap((r) => r.relationIds))]
      let res = null
      try {
        res = await fetchChunk(ids)
      } catch (e) {
        console.log(`  ! ${category} chunk of ${batch.length}: ${e.message}`)
        failed += batch.length
        done += batch.length
        return
      }
      for (const road of batch) {
        done++
        const ways = new Map()
        for (const relId of road.relationIds) {
          for (const m of res.rels.get(relId)?.members ?? []) {
            if (m.type !== 'way' || ways.has(m.ref)) continue
            const geom = res.ways.get(m.ref)
            if (geom && geom.length > 1) ways.set(m.ref, geom)
          }
        }
        write(road, [...ways.values()])
      }
      console.log(`  [${done}/${todo.length}] ${category} — ok ${ok}, empty ${empty}, failed ${failed}`)
      await sleep(900)
    }
    for (const road of roads) {
      if (chunkRels && chunkRels + road.relationIds.length > limit) await flush()
      chunk.push(road)
      chunkRels += road.relationIds.length
    }
    await flush()
  }

  console.log(`\n✓ bulk: ${ok} alignments cached, ${empty} empty, ${failed} failed.`)
}

// ── main ─────────────────────────────────────────────────────────────

const relations = await listRelations()
const { roads, skipped } = group(relations)
const all = [...roads.values()].sort((a, b) => b.relationIds.length - a.relationIds.length)

const byCat = {}
for (const r of all) byCat[r.category] = (byCat[r.category] ?? 0) + 1
console.log(`\n${relations.length} relations → ${all.length} distinct roads`)
console.log(`  by category: ${Object.entries(byCat).map(([k, v]) => `${k} ${v}`).join(', ')}`)
console.log(`  skipped: ${skipped.old} historical, ${skipped.unparseable} unparseable ref, ${skipped.nonRoad} other networks`)
writeCache(all, 'roads-list.json')

if (LIST_ONLY) {
  console.log('\nSample:')
  for (const r of all.slice(0, 12)) console.log(`  ${r.id.padEnd(14)} ${r.ref.padEnd(9)} ${r.relationIds.length} rel  ${r.name}`)
  process.exit(0)
}

if (BULK) {
  await runBulk(all)
  process.exit(0)
}

// ── geometry ─────────────────────────────────────────────────────────

const existing = new Set(
  existsSync(cachePath('routes')) ? readdirSync(cachePath('routes')).map((f) => f.replace(/\.json$/, '')) : [],
)
const todo = all
  .slice(FROM, TO === Infinity ? undefined : TO)
  .filter((r) => (CATEGORIES ? CATEGORIES.includes(r.category) : true))
  .filter((r) => FORCE || !existing.has(r.id))
  .slice(0, LIMIT)
console.log(`\nGeometry: ${todo.length} to fetch (of ${all.length} roads, slice ${FROM}–${TO})\n`)

let ok = 0
let empty = 0
let failed = 0
let done = 0

async function fetchBatch(batch, depth = 0) {
  const ids = [...new Set(batch.flatMap((r) => r.relationIds))]
  const byId = new Map()
  try {
    const json = await overpass(`relation(id:${ids.join(',')});out geom;`, { timeout: 300, retries: depth < 2 ? 1 : 3 })
    for (const el of json.elements ?? []) if (el.type === 'relation') byId.set(el.id, el)
  } catch (e) {
    if (batch.length > 1) {
      // the response was too big or too slow — halve it and try each side
      const mid = Math.ceil(batch.length / 2)
      await fetchBatch(batch.slice(0, mid), depth + 1)
      await sleep(500)
      await fetchBatch(batch.slice(mid), depth + 1)
      return
    }
    console.log(`  ! ${batch[0].id}: ${e.message}`)
    failed++
    done++
    return
  }

  for (const road of batch) {
    done++
    const segments = collectWays(road.relationIds.filter((id) => byId.has(id)).map((id) => byId.get(id)))
    const { line, bridged } = segments.length ? stitch(segments) : { line: [], bridged: 0 }
    const lengthKm = line.length > 1 ? lineLengthKm(line) : 0
    if (lengthKm < 0.5) {
      empty++
      writeCache({ ...road, coords: [], lengthKm: 0, empty: true }, 'routes', `${road.id}.json`)
      continue
    }
    const coords = simplify(line, 0.02).map(([x, y]) => [round5(x), round5(y)])
    writeCache(
      { ...road, coords, lengthKm: Math.round(lengthKm * 10) / 10, bridgedKm: Math.round(bridged * 10) / 10 },
      'routes',
      `${road.id}.json`,
    )
    ok++
  }
}

/**
 * Batch by how much geometry a road is likely to carry, not by road count.
 * A national highway is hundreds of kilometres of dense nodes and earns a 504
 * if you ask for several at once; a district road is a few kilometres, so sixty
 * of them fit comfortably in one response. This is the difference between the
 * tail taking twenty hours and twenty minutes.
 */
const weightOf = (road) =>
  (road.category === 'nh' || road.category === 'expressway' ? 12 : road.category === 'sh' ? 6 : 1) *
  road.relationIds.length
const BATCH_WEIGHT = 60

let batch = []
let batchWeight = 0
const flush = async () => {
  if (!batch.length) return
  const b = batch
  batch = []
  batchWeight = 0
  await fetchBatch(b)
  console.log(`  [${done}/${todo.length}] ok ${ok}, empty ${empty}, failed ${failed}`)
  await sleep(900)
}
for (const road of todo) {
  if (batchWeight && batchWeight + weightOf(road) > BATCH_WEIGHT) await flush()
  batch.push(road)
  batchWeight += weightOf(road)
}
await flush()

console.log(`\n✓ ${ok} alignments cached, ${empty} empty, ${failed} failed.`)
