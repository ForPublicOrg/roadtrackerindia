/**
 * Where a road's stretches begin and end.
 *
 * A review belongs to a stretch of road between two of its main stops — "Delhi
 * → Agra" on NH 44 — because the whole of a 3,745 km highway is not one drive.
 * This file finds those stops on the line the map actually draws, at build
 * time, and says how far along the line each one is.
 *
 * Three things about the corpus shape everything here:
 *
 *   - a shape can run either way: about half the hand-written alignments run
 *     end → start (NH 44's began at Kanyakumari), so a line is turned round to
 *     match its waypoints before anything is measured along it;
 *   - waypoints are names with a point each, and a hand-written point can sit
 *     well off the real alignment, so every place is projected onto the line
 *     and the ones that land too far away are dropped;
 *   - some lines are simply wrong — they stop hundreds of km short of an end
 *     (the Delhi–Mumbai Expressway's starts 300 km from Delhi), jump a hole in
 *     the OSM stitching with one straight 78 km segment (NH 24), or go out
 *     along a road and come back down it (NH 744A). A road whose line fails
 *     the quality gate in `deriveStops` gets no stops at all, and keeps
 *     whole-road reviews, rather than stops in the wrong places.
 *
 * Every place that lands on the line gets a key (`slug`, made unique in road
 * order) whether or not it ends up as a stop. Reviews are stored against those
 * keys, so `marks` ships the km of the places that are not stops: a review of
 * "Sagar → Nagpur" still finds its stretch after a rule change stops making
 * Sagar a stop.
 *
 * Everything here is pure: no file system. `scripts/build-data.mjs` reads and
 * writes, and `stretches.test.mjs` pins the rules down.
 */

// ── measuring along a line ──────────────────────────────────────────

const R = 6371

export function haversineKm([lng1, lat1], [lng2, lat2]) {
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/** km from the start of the line to each of its points. */
export function cumulativeKm(coords) {
  const cum = [0]
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversineKm(coords[i - 1], coords[i]))
  return cum
}

/**
 * Where a point lands on a line: how far along it (km from its start), and how
 * far off it the point is. The same local flat projection as `segDistKm` in
 * src/geo.ts — exact enough over the few km that matter, and cheap.
 */
export function projectPoint(p, coords, cum) {
  if (coords.length < 2) return { km: 0, distKm: coords.length ? haversineKm(p, coords[0]) : Infinity }
  const kx = 111.32 * Math.cos((p[1] * Math.PI) / 180)
  const ky = 110.574
  const px = p[0] * kx
  const py = p[1] * ky
  let best = Infinity
  let km = 0
  for (let i = 1; i < coords.length; i++) {
    const ax = coords[i - 1][0] * kx
    const ay = coords[i - 1][1] * ky
    const bx = coords[i][0] * kx
    const by = coords[i][1] * ky
    // a segment whose box is further off than the best so far cannot beat it —
    // this is what keeps a 30,000-point alignment cheap
    if (px < Math.min(ax, bx) - best || px > Math.max(ax, bx) + best) continue
    if (py < Math.min(ay, by) - best || py > Math.max(ay, by) + best) continue
    const dx = bx - ax
    const dy = by - ay
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
    const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
    if (d < best) {
      best = d
      km = cum[i - 1] + t * (cum[i] - cum[i - 1])
    }
  }
  return { km, distKm: best }
}

// ── names ───────────────────────────────────────────────────────────

const SLUG_MAX = 40

/**
 * A place's key in a stored review range. Must stay byte-identical to `slug`
 * in src/stretches.ts — a key the two disagree on is a review that can never
 * be found again. `index` names a place whose name has no letters in it.
 */
export function slug(name, index = 0) {
  let s = String(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (s.length > SLUG_MAX) s = s.slice(0, SLUG_MAX).replace(/-+$/, '')
  return s || `s${index}`
}

/**
 * A place name reduced to what tells it apart: accents, brackets, punctuation
 * and a trailing "area" go ("Bandikui area", "Delhi (DND Flyway)").
 */
export function placeKey(name) {
  return String(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/ area$/, '')
}

/** One name for two places: equal, or the shorter is whole words of the longer ("Kengeri Bengaluru" ↔ "Bengaluru"). */
export function placeMatch(a, b) {
  const x = placeKey(a)
  const y = placeKey(b)
  if (!x || !y) return false
  if (x === y) return true
  const [short, long] = x.length < y.length ? [x, y] : [y, x]
  return ` ${long} `.includes(` ${short} `)
}

/** The majorCities spelling a place goes by, or null. An exact match beats a partial one. */
function majorName(names, majors) {
  for (const m of majors) if (names.some((n) => isExactly(n, m))) return m
  for (const m of majors) if (names.some((n) => placeMatch(n, m))) return m
  return null
}

const isExactly = (name, major) => placeKey(name) !== '' && placeKey(name) === placeKey(major)

/** What a name says in brackets, as keys: "Kudrail (near Etawah)" → ["etawah"]. */
const bracketed = (name) =>
  [...String(name).matchAll(/\(([^)]*)\)/g)].map((m) => placeKey(m[1].replace(/^\s*near\s+/i, ''))).filter(Boolean)

/** "Srinagar, Jammu & Kashmir" → "Srinagar". */
const terminusName = (text) => String(text).split(',')[0].trim()

// ── which way the line runs ─────────────────────────────────────────

/** A place further off the line than this is not on the road. */
const OFF_LINE_KM = 15
/** How far a shape's end may sit from the terminus it claims to reach. */
const TERMINUS_KM = 25
/** Shape ends this close together make a loop. */
const RING_KM = 1
/** Closer than this, the termini cannot tell which way a line runs. */
const ORIENT_TIE_KM = 5

/**
 * A loop: the line's two ends meet, and the road itself says it goes round —
 * it ends where it starts, or its waypoints come back to the first one.
 *
 * The line alone is not enough. A 1 km lane in Kerala ends 900 m from where it
 * began, and the Delhi–Meerut line is out along one carriageway and back along
 * the other. Neither is a loop, and treating one as a loop excuses it from the
 * check that it reaches both of its ends. Nor is the name alone: a ring road
 * whose line is a broken arc has two ends like any other road, and cutting it
 * as a loop would draw a straight line across the gap. Both together still let
 * one through: NH 744A ends where it starts, and its line runs out to Vadipatti
 * and back down the same road. `deriveStops` turns that away by how much of
 * the line runs back over itself, loop or not.
 */
export function isRing(road, coords) {
  if (coords.length < 5) return false
  const L = cumulativeKm(coords)[coords.length - 1]
  const gap = haversineKm(coords[0], coords[coords.length - 1])
  if (gap >= RING_KM || gap > L / 10) return false
  const w = road.waypoints
  return (
    road.route.start === road.route.end ||
    haversineKm(w[0].coords, w[w.length - 1].coords) <= Math.min(TERMINUS_KM, L / 4)
  )
}

/**
 * The line turned round, if it runs against its waypoints (which are ordered
 * start → end). An open road goes by its termini: whichever pairing of line
 * ends and first/last waypoint is clearly closer wins. A loop has no ends, and
 * neither does a road whose termini sit close together, so those go by a vote
 * of each consecutive pair of waypoints: further along the line, or back.
 */
export function orient(coords, waypoints, ring) {
  const pts = waypoints.map((w) => (Array.isArray(w) ? w : w.coords))
  if (coords.length < 2 || pts.length < 2) return { coords, flipped: false }
  let flip = null
  if (!ring) {
    const c0 = coords[0]
    const cN = coords[coords.length - 1]
    const w0 = pts[0]
    const wN = pts[pts.length - 1]
    const keep = haversineKm(c0, w0) + haversineKm(cN, wN)
    const swap = haversineKm(c0, wN) + haversineKm(cN, w0)
    if (swap + ORIENT_TIE_KM < keep) flip = true
    else if (keep + ORIENT_TIE_KM < swap) flip = false
  }
  if (flip === null) flip = runsBackwards(coords, pts, ring)
  return { coords: flip ? coords.slice().reverse() : coords, flipped: flip }
}

function runsBackwards(coords, pts, ring) {
  const cum = cumulativeKm(coords)
  const L = cum[cum.length - 1] + (ring ? haversineKm(coords[coords.length - 1], coords[0]) : 0)
  const all = pts.map((p) => projectPoint(p, coords, cum))
  const on = all.filter((q) => q.distKm <= OFF_LINE_KM)
  const used = on.length >= 2 ? on : all
  let up = 0
  let down = 0
  for (let i = 1; i < used.length; i++) {
    let dk = used[i].km - used[i - 1].km
    // on a loop, the short way round is the way the road went
    if (ring && L > 0) dk -= L * Math.round(dk / L)
    if (dk > 0) up++
    else if (dk < 0) down++
  }
  return down > up
}

/**
 * The same loop, starting and ending at `km` along it. A loop whose ends are
 * not quite the same point gets the gap closed, so the cut can land anywhere.
 */
export function rotateRing(coords, km) {
  const n = coords.length
  const first = coords[0]
  const last = coords[n - 1]
  const ring = first[0] === last[0] && first[1] === last[1] ? coords : [...coords, first]
  const cum = cumulativeKm(ring)
  const L = cum[cum.length - 1]
  const at = Math.max(0, Math.min(L, km))
  let i = 1
  while (i < ring.length - 1 && cum[i] < at) i++
  const seg = cum[i] - cum[i - 1]
  const f = seg > 0 ? (at - cum[i - 1]) / seg : 0
  const a = ring[i - 1]
  const b = ring[i]
  const cut = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
  // ring[0] and ring[last] are the same point, so the walk round skips one of them
  const out = [cut, ...ring.slice(i), ...ring.slice(1, i), cut]
  return out.filter((p, j) => j === 0 || p[0] !== out[j - 1][0] || p[1] !== out[j - 1][1])
}

// ── stops ───────────────────────────────────────────────────────────

/** Stops closer than this are one stop. */
const MERGE_KM = 10
/** A stretch longer than this gets a waypoint stop in the middle, if there is one. */
const GAP_KM = 250
/** So at most 16 stretches a road. */
const MAX_STOPS = 17
const MIN_ROAD_KM = 25
const LENGTH_RATIO = [0.8, 1.25]
const ON_LINE_SHARE = 0.7
const IN_ORDER_SHARE = 0.8
/**
 * One straight segment longer than both of these is a hole the OSM stitching
 * jumped, not a road. A real alignment has a point every few hundred metres,
 * and the longest straights on file are the greenfield expressways' (24 km on
 * the Samruddhi Mahamarg, 3% of it); the holes are 20–90 km, 4–20% of the line.
 */
const JUMP_KM = 20
const JUMP_SHARE = 0.04
/** Two parts of a line this close are one road… */
const RETRACE_NEAR_KM = 0.15
/** …unless they are this close along it too: a hairpin bend is not a retrace. */
const RETRACE_APART_KM = 5
/**
 * A line driven out and back is most of it twice: NH 744A scores 83%. A real
 * road that only doubles back for a while — a short spur down a shared road
 * and out again — scores both sides of the shared part, which on the corpus is
 * 20–22%, and is still a road worth cutting. 40% sits well clear of both.
 */
const RETRACE_SHARE = 0.4

const round1 = (n) => Math.round(n * 10) / 10
const mod = (n, m) => ((n % m) + m) % m

/** The longest segment of a line, and how far along the line it starts. */
function longestJump(coords) {
  let km = 0
  let at = 0
  let run = 0
  for (let i = 1; i < coords.length; i++) {
    const d = haversineKm(coords[i - 1], coords[i])
    if (d > km) {
      km = d
      at = run
    }
    run += d
  }
  return { km, at, total: run }
}

/**
 * How much of a line runs back over another part of itself: the share of
 * points every 500 m with the line within 150 m of them at a place more than
 * 5 km further on or back (on a loop, the short way round). A line out and
 * back down one road scores most of 1; a road that crosses itself, or loops
 * round a hill, scores the few hundred metres where it meets itself.
 */
function retracedShare(coords, ring) {
  const STEP_KM = 0.1
  const SAMPLE_EVERY = 5
  // about 220 m north–south, and over 170 m east–west anywhere in India, so
  // the cell around a point and its eight neighbours hold everything in 150 m
  const CELL = 0.002
  const cum = cumulativeKm(coords)
  const L = cum[cum.length - 1]
  const loop = L + (ring ? haversineKm(coords[coords.length - 1], coords[0]) : 0)
  // the line as a point every 100 m, filed by cell, so each point only looks
  // at the line around it — NH 44 is 36,000 of them
  const pts = []
  const cells = new Map()
  // a cell is one number: keyed by strings, this check took three times as long
  const cellOf = (p, dx = 0, dy = 0) => (Math.floor(p[0] / CELL) + dx + 1e5) * 2e5 + Math.floor(p[1] / CELL) + dy + 1e5
  for (let j = 0, i = 1; j * STEP_KM <= L; j++) {
    const km = j * STEP_KM
    while (i < coords.length - 1 && cum[i] < km) i++
    const seg = cum[i] - cum[i - 1]
    const f = seg > 0 ? Math.min(1, (km - cum[i - 1]) / seg) : 0
    const a = coords[i - 1]
    const b = coords[i]
    const q = { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], km }
    pts.push(q)
    const k = cellOf(q.p)
    const list = cells.get(k)
    if (list) list.push(q)
    else cells.set(k, [q])
  }
  const apart = (x, y) => {
    const d = Math.abs(x - y)
    return (ring ? Math.min(d, loop - d) : d) > RETRACE_APART_KM
  }
  const runsBack = (s) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const q of cells.get(cellOf(s.p, dx, dy)) ?? []) {
          if (apart(q.km, s.km) && haversineKm(q.p, s.p) <= RETRACE_NEAR_KM) return true
        }
      }
    }
    return false
  }
  let samples = 0
  let back = 0
  for (let j = 0; j < pts.length; j += SAMPLE_EVERY) {
    samples++
    if (runsBack(pts[j])) back++
  }
  return samples ? back / samples : 0
}

/**
 * Longest run of places in list order whose km keeps increasing. A waypoint
 * out of order along the line is a waypoint in the wrong place, and the stops
 * either side of it would make a stretch that runs backwards.
 */
function inOrder(items) {
  const len = items.map(() => 1)
  const prev = items.map(() => -1)
  for (let i = 0; i < items.length; i++) {
    for (let j = 0; j < i; j++) {
      if (items[j].km < items[i].km && len[j] + 1 > len[i]) {
        len[i] = len[j] + 1
        prev[i] = j
      }
    }
  }
  let end = -1
  for (let i = 0; i < items.length; i++) if (end === -1 || len[i] >= len[end]) end = i
  const out = []
  for (let i = end; i !== -1; i = prev[i]) out.push(items[i])
  return out.reverse()
}

/**
 * Unique keys in km order. A place's own slug is reserved for it, so a later
 * place's `-2` never takes a name that is somebody's natural key — and a key
 * never depends on which places end up as stops.
 */
function assignKeys(cands) {
  const natural = cands.map((c) => slug(c.name, c.i))
  const reserved = new Set(natural)
  const used = new Set()
  const next = (base) => {
    let n = 2
    while (used.has(`${base}-${n}`) || reserved.has(`${base}-${n}`)) n++
    return `${base}-${n}`
  }
  cands.forEach((c, j) => {
    c.k = used.has(natural[j]) ? next(natural[j]) : natural[j]
    used.add(c.k)
  })
  return next
}

/** Rank for which of two too-close stops stays: an end of the road, then a main stop, then a gap-filler. */
const RANK = { end: 2, main: 1, fill: 0 }

/** Drop stops closer than MERGE_KM to the next one, closest pair first. The first and last never go. */
function mergeClose(bs) {
  while (bs.length > 2) {
    let j = -1
    let gap = MERGE_KM
    for (let i = 0; i + 1 < bs.length; i++) {
      const g = bs[i + 1].km - bs[i].km
      if (g < gap) {
        gap = g
        j = i
      }
    }
    if (j === -1) return bs
    const pinnedA = j === 0
    const pinnedB = j + 1 === bs.length - 1
    let drop
    if (pinnedA) drop = j + 1
    else if (pinnedB) drop = j
    else if (RANK[bs[j].kind] !== RANK[bs[j + 1].kind]) drop = RANK[bs[j].kind] < RANK[bs[j + 1].kind] ? j : j + 1
    else {
      // keep whichever leaves the shorter stretch behind
      const withoutA = bs[j + 1].km - bs[j - 1].km
      const withoutB = bs[j + 2].km - bs[j].km
      drop = withoutA < withoutB ? j : j + 1
    }
    bs.splice(drop, 1)
  }
  return bs
}

/** Split the longest stretches over GAP_KM at the waypoint nearest their middle (`pool` is measured by `rel`). */
function fillGaps(bs, pool) {
  while (bs.length < MAX_STOPS) {
    const gaps = []
    for (let i = 0; i + 1 < bs.length; i++) {
      if (bs[i + 1].km - bs[i].km > GAP_KM) gaps.push(i)
    }
    gaps.sort((x, y) => bs[y + 1].km - bs[y].km - (bs[x + 1].km - bs[x].km) || x - y)
    let placed = false
    for (const i of gaps) {
      const lo = bs[i].km + MERGE_KM
      const hi = bs[i + 1].km - MERGE_KM
      const mid = (bs[i].km + bs[i + 1].km) / 2
      let best = null
      for (const c of pool) {
        if (c.rel < lo || c.rel > hi) continue
        if (!best || Math.abs(c.rel - mid) < Math.abs(best.rel - mid)) best = c
      }
      if (best) {
        pool.splice(pool.indexOf(best), 1)
        bs.splice(i + 1, 0, { c: best, km: best.rel, kind: 'fill' })
        placed = true
        break
      }
    }
    if (!placed) return bs
  }
  return bs
}

/** Down to MAX_STOPS, each time dropping the stop whose loss leaves the shortest stretch. */
function thin(bs) {
  while (bs.length > MAX_STOPS) {
    let drop = -1
    let best = Infinity
    for (let i = 1; i < bs.length - 1; i++) {
      const g = bs[i + 1].km - bs[i - 1].km
      if (g < best) {
        best = g
        drop = i
      }
    }
    bs.splice(drop, 1)
  }
  return bs
}

/**
 * Names each stop (`n`), no two alike. A stop's name is all a reader has to
 * tell stretches apart by, and "Diu → Diu" says nothing. Generated waypoint
 * lists come back to a place ("Una | Diu | Una | Diu"), and a city can be whole
 * words of a place that is not it ("East Kolkata Wetlands"). Where two clash:
 *
 *   - a place that only went by the city because its own name holds the city's
 *     goes by its own name again;
 *   - failing that, the one that is not an end of the road stops being a stop
 *     (and stays a mark, so its key still finds its km): the lower-ranked one,
 *     or the one whose loss leaves the shorter stretch behind.
 *
 * A loop's closing stop is its first stop again by design, and has no place
 * of its own to clash. Returns the name it cannot settle — both ends of an
 * open road called one thing — or null.
 */
function distinctNames(bs) {
  for (const b of bs) if (b.c) b.n = b.c.major ?? b.c.name
  for (;;) {
    const seen = new Map()
    let clash = null
    for (let i = 0; i < bs.length && !clash; i++) {
      if (!bs[i].c) continue
      const key = placeKey(bs[i].n)
      if (seen.has(key)) clash = [seen.get(key), i]
      else seen.set(key, i)
    }
    if (!clash) return null
    const own = clash.find((j) => bs[j].c.partial && placeKey(bs[j].c.name) !== placeKey(bs[j].n))
    if (own !== undefined) {
      bs[own].n = bs[own].c.name
      continue
    }
    const [a, b] = clash
    const inner = clash.filter((j) => bs[j].kind !== 'end')
    if (!inner.length) return bs[a].n
    let drop
    if (inner.length === 1) drop = inner[0]
    else if (RANK[bs[a].kind] !== RANK[bs[b].kind]) drop = RANK[bs[a].kind] < RANK[bs[b].kind] ? a : b
    else drop = bs[a + 1].km - bs[a - 1].km < bs[b + 1].km - bs[b - 1].km ? a : b
    bs.splice(drop, 1)
  }
}

const fmt = (km) => Math.round(km).toLocaleString('en-IN')

/**
 * The stops a road's reviews are tied to, placed on `coords` (the line as it
 * is written to shapes/, already oriented start → end).
 *
 * Returns { stops: [{ n, k, km }], marks: [[k, km], …], coords, gate }:
 * `stops` in road order, from km 0 to the end of the line; `marks` every other
 * place on the line; `coords` the line to write — a loop comes back cut at its
 * first stop, anything else as it came in; `gate` null, or { reason, detail }
 * saying why the road has no stops (and then `stops` and `marks` are empty).
 *
 * `raw` is the line as it came from data/geometry, before it was simplified,
 * when the road has one. A long straight segment in `coords` may be a straight
 * road that simplifying left as one; only the full line tells that from a hole
 * the stitching jumped. A line drawn from waypoints has no full line to ask.
 */
export function deriveStops(road, coords, ring, { raw } = {}) {
  const fail = (reason, detail) => ({ stops: [], marks: [], coords, gate: { reason, detail } })
  const cum = cumulativeKm(coords)
  const L = cum[cum.length - 1]
  const wps = road.waypoints

  if (!(road.lengthKm >= MIN_ROAD_KM)) return fail('short', `under ${MIN_ROAD_KM} km`)
  const ratio = L / road.lengthKm
  if (ratio < LENGTH_RATIO[0] || ratio > LENGTH_RATIO[1])
    return fail('length', `the line is ${fmt(L)} km against an official ${fmt(road.lengthKm)} km`)

  const start = terminusName(road.route.start)
  const end = terminusName(road.route.end)
  if (!ring) {
    const offStart = haversineKm(coords[0], wps[0].coords)
    const offEnd = haversineKm(coords[coords.length - 1], wps[wps.length - 1].coords)
    if (offStart > TERMINUS_KM) return fail('ends', `the line starts ${fmt(offStart)} km from ${wps[0].name}`)
    if (offEnd > TERMINUS_KM) return fail('ends', `the line ends ${fmt(offEnd)} km from ${wps[wps.length - 1].name}`)
  }

  const onLine = wps.filter((w) => projectPoint(w.coords, coords, cum).distKm <= OFF_LINE_KM).length
  if (onLine < ON_LINE_SHARE * wps.length)
    return fail('off-line', `${onLine} of ${wps.length} waypoints are within ${OFF_LINE_KM} km of the line`)

  // A length that adds up can still be the wrong line: the length on file for
  // a generated road was measured off the same OSM ways, so neither a jump
  // across a hole nor a road driven twice shows in it.
  if (raw) {
    const jump = longestJump(raw)
    if (jump.km > JUMP_KM && jump.km > JUMP_SHARE * jump.total)
      return fail('gap', `the line jumps ${fmt(jump.km)} km in a straight line at km ${fmt(jump.at)}`)
  }
  const back = retracedShare(coords, ring)
  if (back > RETRACE_SHARE) return fail('retrace', `${Math.round(back * 100)}% of the line runs back over another part of it`)

  // 1. every place the road names: its waypoints, and an open road's termini
  //    as route.start/end call them (at the first and last waypoint). A
  //    terminus that is the first/last waypoint under another spelling is one
  //    place. A loop has no termini: its route.start names the city it goes
  //    round ("Lucknow"), which is no one point on it. Nor does a road that
  //    starts and ends in one city with a line that is not a loop (a ring road
  //    drawn as a broken arc): that city is neither end, so the ends go by
  //    their waypoints, as a loop's places do.
  let list = wps
  // a loop's last waypoint repeats its first (docs/DATA.md)
  if (ring && list.length > 2 && placeKey(list[list.length - 1].name) === placeKey(list[0].name)) list = list.slice(0, -1)
  const cands = []
  const add = (name, at, terminus, alias) =>
    cands.push({ i: cands.length, name, names: alias && alias !== name ? [name, alias] : [name], at, terminus })
  if (ring) for (const w of list) add(w.name, w.coords, null)
  else {
    const first = list[0]
    const last = list[list.length - 1]
    const [from, to] = placeKey(start) === placeKey(end) ? [first.name, last.name] : [start, end]
    if (placeMatch(from, first.name)) add(from, first.coords, 'start', first.name)
    else {
      add(from, first.coords, 'start')
      add(first.name, first.coords, null)
    }
    for (let j = 1; j < list.length - 1; j++) add(list[j].name, list[j].coords, null)
    if (placeMatch(to, last.name)) add(to, last.coords, 'end', last.name)
    else {
      add(last.name, last.coords, null)
      add(to, last.coords, 'end')
    }
  }

  for (const c of cands) Object.assign(c, projectPoint(c.at, coords, cum))
  // an open road's ends are its termini, wherever the waypoint for them sits
  // (the gate above has already checked the line reaches them)
  if (!ring) {
    for (const c of cands) {
      if (c.terminus === 'start') c.km = 0
      if (c.terminus === 'end') c.km = L
      if (c.terminus) c.distKm = 0
    }
  }
  const on = cands.filter((c) => c.distKm <= OFF_LINE_KM)
  if (!on.length) return fail('stops', `fewer than 3 stops on the line`)

  // a loop is measured from its first place, so where the line happens to
  // start does not decide which place comes first
  const loopKm = L + (ring ? haversineKm(coords[coords.length - 1], coords[0]) : 0)
  for (const c of on) c.rel = ring ? mod(c.km - on[0].km, loopKm) : c.km

  // 2. keys, once, over every place, in road order
  const byKm = on.slice().sort((a, b) => a.rel - b.rel || a.i - b.i)
  const nextKey = assignKeys(byKm)

  // 3. main stops are the road's majorCities, under that spelling
  const majors = road.route.majorCities
  for (const c of on) {
    c.major = majorName(c.names, majors)
    // the city is only whole words of its name, so it can give the city back
    c.partial = c.major !== null && !c.names.some((n) => isExactly(n, c.major))
  }
  // The hand-written roads put a town's city in brackets, which matching
  // ignores: "Bijauli (Meerut)", "Duhai (Ghaziabad)". A majorCities entry that
  // no place goes by is the first place, in road order, whose brackets name it
  // exactly — one place, and never by whole words, which would find a Delhi in
  // "Bajghera (Delhi–Haryana border)" and a second Surat beside the first.
  const claimed = new Set(on.filter((c) => c.major).map((c) => placeKey(c.major)))
  for (const c of byKm) {
    if (c.major) continue
    const said = c.names.flatMap(bracketed)
    const m = majors.find((m) => !claimed.has(placeKey(m)) && said.includes(placeKey(m)))
    if (m) {
      c.major = m
      claimed.add(placeKey(m))
    }
  }
  const matched = on.filter((c) => c.major)
  const main = new Set(matched.length >= 2 ? matched : on)

  // 4. main stops in road order along the line
  const pinned = ring ? [] : on.filter((c) => c.terminus)
  const interior = on.filter((c) => main.has(c) && !pinned.includes(c))
  const kept = inOrder(interior.map((c) => ({ c, km: c.rel }))).map((x) => x.c)
  const mainCount = main.size
  const keptCount = kept.length + pinned.filter((c) => main.has(c)).length
  if (keptCount < IN_ORDER_SHARE * mainCount)
    return fail('order', `only ${keptCount} of ${mainCount} main stops run in order along the line`)

  // 5. the boundaries: an open road from terminus to terminus, a loop from its
  //    first main stop round to the same place again
  let bs
  let k0 = 0
  if (ring) {
    if (!kept.length) return fail('stops', `fewer than 3 stops on the line`)
    k0 = kept[0].rel
    for (const c of on) c.rel = mod(c.rel - k0, loopKm)
    bs = kept.map((c) => ({ c, km: c.rel, kind: 'main' }))
    bs[0].kind = 'end'
    bs.push({ c: null, km: loopKm, kind: 'end' })
  } else {
    const first = pinned.find((c) => c.terminus === 'start')
    const last = pinned.find((c) => c.terminus === 'end')
    bs = [
      { c: first, km: 0, kind: 'end' },
      ...kept.map((c) => ({ c, km: c.rel, kind: 'main' })),
      { c: last, km: L, kind: 'end' },
    ]
  }

  // 6–8. merge near neighbours, split long gaps, cap the count
  mergeClose(bs)
  const used = new Set(bs.map((b) => b.c))
  fillGaps(bs, on.filter((c) => !main.has(c) && !used.has(c)))
  thin(bs)

  // 9. one name to a stop. An open road whose two ends go by one name is a
  //    loop whose line does not close, and "Una → Una" names no stretch.
  const both = distinctNames(bs)
  if (both !== null) {
    const apart = haversineKm(coords[0], coords[coords.length - 1])
    return fail('ends', `the line's ends are ${fmt(apart)} km apart, but both are ${both}`)
  }
  if (bs.length < 3) return fail('stops', `fewer than 3 stops on the line`)

  // 10. a loop is cut at its first stop, so km 0 is a place a reader knows.
  //    Always, even when the line already starts there: the cut also closes
  //    the loop's last few hundred metres, which the km above counted.
  let out = coords
  let total = L
  if (ring) {
    out = rotateRing(coords, mod(on[0].km + k0, loopKm))
    total = cumulativeKm(out)[out.length - 1]
  }
  const at = (c) => round1(Math.max(0, Math.min(total, c.rel)))

  const stopSet = new Set(bs.map((b) => b.c).filter(Boolean))
  const stops = bs.map((b, j) => {
    if (j === 0) return { n: b.n, k: b.c.k, km: 0 }
    if (j === bs.length - 1) {
      // a loop closes on its first stop again, under a key of its own
      if (b.c) return { n: b.n, k: b.c.k, km: round1(total) }
      const c = bs[0].c
      return { n: bs[0].n, k: nextKey(slug(c.name, c.i)), km: round1(total) }
    }
    return { n: b.n, k: b.c.k, km: at(b.c) }
  })
  const marks = byKm
    .filter((c) => !stopSet.has(c))
    .map((c) => [c.k, at(c)])
    .sort((a, b) => a[1] - b[1])
  return { stops, marks, coords: out, gate: null }
}
