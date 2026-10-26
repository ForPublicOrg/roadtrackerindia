/**
 * Stretches: a road cut at its main stops, so a review can say which part of
 * the road it is about. On 3,745 km NH 44 the Jammu mountain leg and the plains
 * south of Delhi are different drives, and one number for both says nothing.
 *
 * Where the stops are is decided at build time (scripts/lib/stretches.mjs) and
 * shipped on the road's shape — nothing here works out a key. A review stores
 * its range as two stop keys, so it has to keep finding its place after the
 * stop rules or the road's data change: a key that is no longer a stop is
 * placed by its km from the shape's marks instead, and lands on whichever
 * stretches now cover it.
 *
 * A range also says which way it was driven. On a divided highway "Delhi →
 * Agra" and "Agra → Delhi" are two carriageways, and even on one they are a
 * climb and a descent, a queue at the toll and none. `delhi>agra` is driven
 * from Delhi. `agra--delhi`, its two keys sorted, is the old spelling — every
 * review written before directions, and what an old page still posts — and it
 * is driven in road order, start to end: the only way those pages offered,
 * with "Rate Delhi → Agra" in road order over the stars. So a road's old
 * reviews keep their way only while `route.start` and `route.end` do.
 *
 * Kept free of the DOM and of everything but geo.ts, so the tests can import
 * this file straight into Node.
 */
import type { FeatureCollection, LineString, MultiLineString } from 'geojson'
import type { BBox, LngLat, RangeStats, ShapeFeature, StretchProps } from './types'
import { bboxOf, cumulativeKm, segProject, sliceLine } from './geo.ts'

/** The whole road — and what a review written before stretches is about. */
export const ALL = 'all'
/** Mirrors api/_lib/ratings-math.ts; scripts/contracts.test.mjs holds the two in step. */
export const RANGE_KEY = /^(?:all|[a-z0-9]+(?:-[a-z0-9]+)*(?:--|>)[a-z0-9]+(?:-[a-z0-9]+)*)$/
const KEY_MAX = 90

/** Which way a range is driven: the road's own order, start to end, or back. */
export type Way = 'fwd' | 'rev'

export const otherWay = (w: Way): Way => (w === 'fwd' ? 'rev' : 'fwd')

/** Less overlap than this between a review's range and a stretch is a stop that
 *  moved a little or km rounding, not a review of that stretch. Boundaries are
 *  at least 10 km apart, so it can never swallow a whole stretch. */
const EDGE_KM = 1

export interface Stretch {
  i: number
  fromKey: string
  toKey: string
  fromName: string
  toName: string
  /** Along the shape as measured here — what slicing and the bar use. */
  kmFrom: number
  kmTo: number
  coords: LngLat[]
  /** What the map draws of it: `coords` less any hole in the line. */
  pieces: LngLat[][]
  bbox: BBox
}

/** The line from kmA to kmB as it is drawn: cut wherever a hole (a km range) crosses it. */
export function drawnPieces(
  coords: LngLat[],
  cum: number[],
  kmA: number,
  kmB: number,
  holes: readonly (readonly [number, number])[],
): LngLat[][] {
  const runs: [number, number][] = [[kmA, kmB]]
  for (const [h0, h1] of holes) {
    for (let r = runs.length - 1; r >= 0; r--) {
      const [a, b] = runs[r]
      if (h1 <= a || h0 >= b) continue
      const keep: [number, number][] = []
      if (h0 > a) keep.push([a, h0])
      if (h1 < b) keep.push([h1, b])
      runs.splice(r, 1, ...keep)
    }
  }
  return runs.filter(([a, b]) => b - a > 1e-6).map(([a, b]) => sliceLine(coords, cum, a, b))
}

export interface StretchScore {
  mean: number
  votes: number
}

export interface RangeScore extends StretchScore {
  counts: Record<string, number>
}

type Marks = readonly (readonly [string, number])[]

/** How far the shipped km had to be stretched to fit the line as measured
 *  here, per buildStretches() result, so marks can be placed on the same scale
 *  as the stops. Missing (a hand-made list) means 1. */
const scaleOf = new WeakMap<readonly Stretch[], number>()

/**
 * A place name as a key: "Kengeri (Bengaluru)" → "kengeri". The build's copy in
 * scripts/lib/stretches.mjs is the one that assigns keys; this one must stay
 * byte-identical to it, and a test holds the two together. Cutting to 40 can
 * leave a trailing dash ("foo-"), and "foo---bar" is not a range key, so the
 * trim runs again after the cut.
 */
export function slug(name: string, index = 0): string {
  const s = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return s || `s${index}`
}

export function isRangeKey(key: string): boolean {
  return key.length <= KEY_MAX && RANGE_KEY.test(key)
}

/**
 * The road's stretches, in road order. Empty when the build gave it fewer than
 * three stops — two stops are one stretch, which is just the whole road.
 */
export function buildStretches(shape: ShapeFeature): Stretch[] {
  const stops = shape.properties.stops
  const coords = shape.geometry.coordinates
  if (!stops || stops.length < 3 || coords.length < 2) return []
  const cum = cumulativeKm(coords)
  const measured = cum[cum.length - 1]
  if (!(measured > 0)) return []
  // Stop km were measured along these same coordinates at build time, so this
  // is a rounding-sized correction; it is here so a change in how either side
  // measures can never push a stop off the end of the line.
  const shipped = shape.properties.km
  const scale = shipped && shipped > 0 ? measured / shipped : 1
  const last = stops.length - 1
  // The ends are pinned so the stretches cover the whole line between them.
  const km = stops.map((st, j) =>
    j === 0 ? 0 : j === last ? measured : Math.max(0, Math.min(measured, st.km * scale)),
  )
  for (let j = 1; j < km.length; j++) km[j] = Math.max(km[j], km[j - 1])

  const holes = (shape.properties.gaps ?? [])
    .filter((g) => g > 0 && g < coords.length)
    .map((g): [number, number] => [cum[g - 1], cum[g]])

  const out: Stretch[] = []
  for (let i = 0; i < last; i++) {
    const line = sliceLine(coords, cum, km[i], km[i + 1])
    out.push({
      i,
      fromKey: stops[i].k,
      toKey: stops[i + 1].k,
      fromName: stops[i].n,
      toName: stops[i + 1].n,
      kmFrom: km[i],
      kmTo: km[i + 1],
      coords: line,
      pieces: holes.some(([h0, h1]) => h1 > km[i] && h0 < km[i + 1])
        ? drawnPieces(coords, cum, km[i], km[i + 1], holes)
        : [line],
      bbox: bboxOf(line),
    })
  }
  scaleOf.set(out, scale)
  return out
}

/** Indices out of range or the wrong way round still name a run of stretches. */
function span(s: readonly Stretch[], i0: number, i1: number): [number, number] {
  const top = s.length - 1
  const lo = Math.max(0, Math.min(top, Math.min(i0, i1)))
  const hi = Math.max(0, Math.min(top, Math.max(i0, i1)))
  return [lo, hi]
}

/** The key a review of stretches i0..i1 is stored under. Driven one way, it is
 *  the stop it starts from and the stop it ends at, in that order — every
 *  stretch included, since "Srinagar → Kanyakumari" is a direction too. With
 *  no way, the old spelling a page from before directions posted: the two end
 *  stops sorted, and ALL when it is every stretch, the whole road under its
 *  usual name. */
export function rangeKey(s: readonly Stretch[], i0: number, i1: number, way?: Way): string {
  if (!s.length) return ALL
  const [lo, hi] = span(s, i0, i1)
  const ends = [s[lo].fromKey, s[hi].toKey]
  if (way) return (way === 'fwd' ? ends : ends.reverse()).join('>')
  if (lo === 0 && hi === s.length - 1) return ALL
  return ends.sort().join('--')
}

const directed = (key: string): boolean => key.includes('>')

/** The stretches a range covers, first and last. Placing it means a km for
 *  each end — a stop's, or failing that a mark's — then every stretch that
 *  overlaps the run between them by more than a rounding error. */
function covering(s: readonly Stretch[], a: number, b: number): [number, number] {
  let lo = -1
  let hi = -1
  s.forEach((st, i) => {
    if (Math.min(st.kmTo, b) - Math.max(st.kmFrom, a) > EDGE_KM) {
      if (lo < 0) lo = i
      hi = i
    }
  })
  if (lo >= 0) return [lo, hi]
  // a range shorter than the tolerance belongs to wherever its middle is
  const mid = (a + b) / 2
  const i = s.findIndex((st) => mid <= st.kmTo)
  return i < 0 ? [s.length - 1, s.length - 1] : [i, i]
}

/** Where a key lands: the stretches it covers, and which way it is driven —
 *  null only for ALL, the whole road's headline vote. */
interface Placed {
  span: [number, number]
  way: Way | null
}

/** One lookup table per call, rather than one per range key. */
function resolver(s: readonly Stretch[], marks?: Marks): (key: string) => Placed | null {
  /** stop key → boundary index: 0 is the start of stretch 0, s.length the end. */
  const boundary = new Map<string, number>()
  s.forEach((st, i) => {
    if (!boundary.has(st.fromKey)) boundary.set(st.fromKey, i)
    boundary.set(st.toKey, i + 1)
  })
  const scale = scaleOf.get(s) ?? 1
  const markKm = new Map<string, number>()
  for (const m of marks ?? []) {
    if (typeof m[0] === 'string' && Number.isFinite(m[1])) markKm.set(m[0], m[1] * scale)
  }
  const kmOf = (k: string): number | null => {
    const j = boundary.get(k)
    if (j !== undefined) return j < s.length ? s[j].kmFrom : s[s.length - 1].kmTo
    return markKm.get(k) ?? null
  }

  return (key) => {
    if (!s.length) return null
    if (key === ALL) return { span: [0, s.length - 1], way: null }
    if (!isRangeKey(key)) return null
    const one = directed(key)
    const [a, b] = key.split(one ? '>' : '--')
    if (a === b) return null
    // Driven from a to b: forward when a comes first along the road. The old
    // spelling is sorted, so its order says nothing — it was forward.
    const way = (first: boolean): Way => (!one || first ? 'fwd' : 'rev')
    const ja = boundary.get(a)
    const jb = boundary.get(b)
    if (ja !== undefined && jb !== undefined) {
      const lo = Math.min(ja, jb)
      const hi = Math.max(ja, jb)
      return lo < hi ? { span: [lo, hi - 1], way: way(ja < jb) } : null
    }
    const ka = kmOf(a)
    const kb = kmOf(b)
    if (ka === null || kb === null) return null
    return { span: covering(s, Math.min(ka, kb), Math.max(ka, kb)), way: way(ka < kb) }
  }
}

const whole = (s: readonly Stretch[], sp: readonly [number, number]): boolean => sp[0] === 0 && sp[1] === s.length - 1

/** The first and last stretch a stored range covers, in road order whichever
 *  way it is driven. null when it can't be placed on this road any more. */
export function expandRange(s: readonly Stretch[], key: string, marks?: Marks): [number, number] | null {
  return resolver(s, marks)(key)?.span ?? null
}

/** Which way a stored range is driven along this road — forward for the old
 *  spelling — or null for ALL and for a key that can't be placed. */
export function rangeWay(s: readonly Stretch[], key: string, marks?: Marks): Way | null {
  return resolver(s, marks)(key)?.way ?? null
}

/** Whether a loop's own order runs clockwise, by the sign of its area. */
const clockwise = new WeakMap<readonly Stretch[], boolean>()
function runsClockwise(s: readonly Stretch[]): boolean {
  let known = clockwise.get(s)
  if (known === undefined) {
    let area = 0
    for (const st of s) {
      for (let j = 1; j < st.coords.length; j++) {
        const [x0, y0] = st.coords[j - 1]
        const [x1, y1] = st.coords[j]
        area += x0 * y1 - x1 * y0
      }
    }
    known = area < 0
    clockwise.set(s, known)
  }
  return known
}

/**
 * "Delhi → Agra" for a range driven from Delhi — an old-spelling one reads in
 * road order, as it did when it was written. A loop driven all the way round
 * starts and ends at one place, and "Gachibowli → Gachibowli" says nothing, so
 * it says which way round instead.
 */
export function rangeLabel(s: readonly Stretch[], key: string, marks?: Marks): string {
  if (key === ALL) return 'Whole road'
  const p = resolver(s, marks)(key)
  if (!p?.way) return 'Part of the road'
  const [lo, hi] = p.span
  const [from, to] = p.way === 'fwd' ? [s[lo].fromName, s[hi].toName] : [s[hi].toName, s[lo].fromName]
  if (from === to && whole(s, p.span)) {
    return `Whole road, ${runsClockwise(s) === (p.way === 'fwd') ? 'clockwise' : 'anticlockwise'}`
  }
  return `${from} → ${to}`
}

/** How long stretches i0..i1 are, in the road's published km rather than the
 *  simplified line's, so the parts add up to the length the panel states. */
export function displayKm(s: readonly Stretch[], i0: number, i1: number, lengthKm: number): number {
  if (!s.length) return 0
  const [lo, hi] = span(s, i0, i1)
  const total = s[s.length - 1].kmTo
  return total > 0 ? Math.round(((s[hi].kmTo - s[lo].kmFrom) * lengthKm) / total) : 0
}

/**
 * Each stretch's score, from the reviews that name it. Given a way, only
 * what was said driving that way: the two sides of a divided road are two
 * roads, and a broken northbound carriageway must not be averaged away by a
 * smooth southbound one. Every review from before directions was driven in
 * road order, and counts that way only. A whole-road vote says nothing about any
 * one stretch, so ALL never colours one, and neither does a range over every
 * stretch (the whole road, one way): they only feed the headline. A review of
 * several stretches is a vote on each of them. A range that can no longer be
 * placed is left out: there is no saying where it was.
 */
export function scoreStretches(
  s: readonly Stretch[],
  ranges: Record<string, RangeStats> | undefined,
  marks?: Marks,
  way?: Way,
): (StretchScore | null)[] {
  const sum = s.map(() => 0)
  const votes = s.map(() => 0)
  const resolve = resolver(s, marks)
  for (const [key, st] of Object.entries(ranges ?? {})) {
    if (key === ALL || !st || !(st.total > 0)) continue
    const r = resolve(key)
    if (!r || whole(s, r.span) || (way && r.way !== way)) continue
    for (let i = r.span[0]; i <= r.span[1]; i++) {
      sum[i] += st.sum
      votes[i] += st.total
    }
  }
  return s.map((_, i) => (votes[i] ? { mean: sum[i] / votes[i], votes: votes[i] } : null))
}

/** The votes of every range that touches stretches i0..i1 — what the rating
 *  card shows for a selection. Same exclusions as scoreStretches. Given a way,
 *  ranges driven the other way are left out. */
export function scoreRange(
  s: readonly Stretch[],
  ranges: Record<string, RangeStats> | undefined,
  i0: number,
  i1: number,
  marks?: Marks,
  way?: Way,
): RangeScore | null {
  if (!s.length) return null
  const [lo, hi] = span(s, i0, i1)
  const resolve = resolver(s, marks)
  let sum = 0
  let votes = 0
  const counts: Record<string, number> = {}
  for (const [key, st] of Object.entries(ranges ?? {})) {
    if (key === ALL || !st || !(st.total > 0)) continue
    const r = resolve(key)
    if (!r || r.span[1] < lo || r.span[0] > hi || whole(s, r.span)) continue
    if (way && r.way !== way) continue
    sum += st.sum
    votes += st.total
    for (const [n, c] of Object.entries(st.counts ?? {})) counts[n] = (counts[n] ?? 0) + c
  }
  return votes ? { mean: sum / votes, votes, counts } : null
}

/** Whether a review belongs in a list filtered to stretches i0..i1. Whole-road
 *  reviews, and ones that can't be placed, are about every part of the road. */
export function intersects(s: readonly Stretch[], key: string, i0: number, i1: number, marks?: Marks): boolean {
  if (key === ALL) return true
  const r = expandRange(s, key, marks)
  if (!r) return true
  const [lo, hi] = span(s, i0, i1)
  return r[0] <= hi && r[1] >= lo
}

/** The stretch under a tap or a located position, if it is near enough to any. */
export function nearestStretch(s: readonly Stretch[], p: LngLat, maxKm = 15): number | null {
  let best = -1
  let bestKm = Infinity
  s.forEach((st, i) => {
    for (let j = 1; j < st.coords.length; j++) {
      const d = segProject(p, st.coords[j - 1], st.coords[j]).distKm
      if (d < bestKm) {
        bestKm = d
        best = i
      }
    }
  })
  return best >= 0 && bestKm <= maxKm ? best : null
}

/** "Agra → Gwalior", or driven back, "Gwalior → Agra". */
export function stretchName(st: Stretch, way: Way = 'fwd'): string {
  return way === 'fwd' ? `${st.fromName} → ${st.toName}` : `${st.toName} → ${st.fromName}`
}

/** Which way the road is being looked at, as a few words that fit after "Rate
 *  a stretch": the end it heads for, or, on a loop, which way round. */
export function wayLabel(s: readonly Stretch[], way: Way): string {
  if (!s.length) return ''
  const start = s[0].fromName
  const end = s[s.length - 1].toName
  if (start === end) return `going ${runsClockwise(s) === (way === 'fwd') ? 'clockwise' : 'anticlockwise'}`
  return `towards ${way === 'fwd' ? end : start}`
}

function tip(st: Stretch, sc: StretchScore | null, way: Way): string {
  const name = stretchName(st, way)
  return sc
    ? `${name} · ★ ${sc.mean.toFixed(1)} · ${sc.votes} rating${sc.votes === 1 ? '' : 's'}`
    : `${name} · not rated yet`
}

/** The map's stretch source: one line per stretch, its colour picked by the
 *  score it has driven this way, and named that way round. */
export function stretchesFC(
  s: readonly Stretch[],
  scores: readonly (StretchScore | null)[],
  way: Way = 'fwd',
): FeatureCollection<LineString | MultiLineString, StretchProps> {
  return {
    type: 'FeatureCollection',
    features: s.map((st, i) => {
      const sc = scores[i] ?? null
      const score = sc ? Math.max(1, Math.min(5, Math.round(sc.mean))) : 0
      return {
        type: 'Feature',
        properties: { i: st.i, score, tip: tip(st, sc, way) },
        geometry:
          st.pieces.length === 1
            ? { type: 'LineString', coordinates: st.pieces[0] }
            : { type: 'MultiLineString', coordinates: st.pieces },
      }
    }),
  }
}
