/**
 * Holes in a stitched road line, and the real roads that close them.
 *
 * stitch() joins the pieces of a road that OSM maps apart with a straight line,
 * and the map drew that line as if it were road: NH 148B ran dead straight for
 * 58 km from Kotputli to Baroda Meo, across country with no road on it. A long
 * straight segment is one of two things — a road that really is straight (lines
 * cached before 2026-10-21 were simplified with no vertex rule), or such a hole.
 * OSM's road network tells them apart: the road between a straight road's two
 * ends is the segment itself.
 *
 * A hole is closed with the road route between its ends, kept only when it is
 * plausibly this road. Otherwise the hole stays open, and the build leaves it
 * out of the drawn line instead of drawing a road nobody can drive.
 * Data © OpenStreetMap contributors, ODbL.
 */
import { haversineKm } from './overpass.mjs'

/** "NH 148B", "NH-148B", "nh148b" → "NH148B"; "MDR002" → "MDR2". */
export const normRef = (s) =>
  String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/([A-Z])0+(?=\d)/g, '$1')

/** Segments longer than `minKm`: { i, a, b, km }, where i is the index of b. */
export function longSegments(coords, minKm) {
  const out = []
  for (let i = 1; i < coords.length; i++) {
    const km = haversineKm(coords[i - 1], coords[i])
    if (km > minKm) out.push({ i, a: coords[i - 1], b: coords[i], km })
  }
  return out
}

/** One key for a segment, whichever way the line runs over it. */
export const segKey = (a, b) => {
  const p = `${a[0]},${a[1]}`
  const q = `${b[0]},${b[1]}`
  return p < q ? `${p}|${q}` : `${q}|${p}`
}

/** Points along a straight segment so no piece is over `maxKm` (both ends excluded). */
export function between(a, b, maxKm) {
  const n = Math.ceil(haversineKm(a, b) / maxKm)
  const pts = []
  for (let k = 1; k < n; k++) {
    pts.push([
      Math.round((a[0] + ((b[0] - a[0]) * k) / n) * 1e5) / 1e5,
      Math.round((a[1] + ((b[1] - a[1]) * k) / n) * 1e5) / 1e5,
    ])
  }
  return pts
}

/** How far p is from the segment a–b, in km (flat projection, fine at road scale). */
export function offSegmentKm(p, a, b) {
  const kx = 111.32 * Math.cos((((a[1] + b[1]) / 2) * Math.PI) / 180)
  const ky = 110.574
  const [ax, ay, bx, by, px, py] = [a[0] * kx, a[1] * ky, b[0] * kx, b[1] * ky, p[0] * kx, p[1] * ky]
  const dx = bx - ax
  const dy = by - ay
  const dd = dx * dx + dy * dy
  const t = dd ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / dd)) : 0
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/**
 * What the verdict needs of an OSRM /route answer (with steps) for `seg`: its
 * length, how far its ends had to snap to reach a road, how far it strays from
 * the straight segment, its line, and its legs as [km, ref, kind], kind being
 * 'motorway', 'ferry' or ''.
 */
export function summarise(osrm, seg) {
  const route = osrm.routes?.[0]
  if (osrm.code !== 'Ok' || !route) return null
  const legs = []
  for (const leg of route.legs) {
    for (const st of leg.steps) {
      if (!st.distance) continue
      const classes = st.intersections?.flatMap((x) => x.classes ?? []) ?? []
      const kind = st.mode === 'ferry' || classes.includes('ferry') ? 'ferry' : classes.includes('motorway') ? 'motorway' : ''
      legs.push([Math.round(st.distance) / 1000, st.ref ?? '', kind])
    }
  }
  const coords = route.geometry.coordinates
  return {
    km: route.distance / 1000,
    snapKm: Math.max(...osrm.waypoints.map((w) => w.distance / 1000)),
    devKm: Math.max(0, ...coords.map((p) => offSegmentKm(p, seg.a, seg.b))),
    coords,
    legs,
  }
}

/** The road route runs along the segment itself: a straight road, not a hole. */
export function isStraightRoad(seg, route) {
  if (!route || route.snapKm > 0.1) return false
  return route.km <= seg.km * 1.02 + 0.2 && route.devKm < 0.15
}

/**
 * The better of a segment's two routes, a to b and b to a (`back`, already
 * turned to run a to b). A router keeps to one-way carriageways, and a line
 * drawn down a dual carriageway against its traffic gets a route that runs on
 * to a U-turn and back — NH 148B's 11 km near Satnali came back as 21 km. The
 * other way round follows the carriageway.
 */
export function bestRoute(seg, route, back) {
  if (!back || isStraightRoad(seg, route)) return route
  if (!route || isStraightRoad(seg, back)) return back
  return back.km < route.km ? back : route
}

/** How a route's kilometres split: on the road's own number, another, none; motorway; ferry. */
export function split(route, ref) {
  const own = normRef(ref)
  const out = { own: 0, other: 0, none: 0, motorway: 0, ferry: 0, mainOther: null }
  const others = new Map()
  for (const [km, legRef, kind] of route.legs) {
    const refs = String(legRef).split(';').map(normRef).filter(Boolean)
    if (own && refs.includes(own)) out.own += km
    else if (refs.length) {
      out.other += km
      others.set(legRef, (others.get(legRef) ?? 0) + km)
    } else out.none += km
    if (kind === 'motorway') out.motorway += km
    if (kind === 'ferry') out.ferry += km
  }
  out.mainOther = [...others].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null
  return out
}

// ── whether a route is this road ──────────────────────────────────────

/** A route may be this much longer than the straight hole, plus SLACK_KM. */
export const DETOUR = 1.3
export const SLACK_KM = 2
/** …or, when at least half of it carries the road's own number, this much. */
export const OWN_DETOUR = 2
/** A route this short may run on another numbered road (two numbers often share a road). */
export const SHARED_KM = 10
/** A route that starts or ends further than this from the hole's end is not from it. */
export const SNAP_KM = 0.5

/**
 * Whether `route` can stand in for the hole `seg`, and if not, why.
 *
 * - Too long a detour is another road, or the hole is a road not built yet
 *   (NH 148B's Paniyala–Barodameo section: the only road round is 85 km via
 *   Alwar for a 58 km hole). A route that mostly carries the road's own number
 *   is the road, however it winds — mountain roads do.
 * - A long route along another numbered road is that road. When OSM has only
 *   remnants of a number left (SH 20 Jhajjar–Sonipat: 9 km mapped, the road
 *   between them now NH 334B), drawing it along the other number would put two
 *   roads on one line.
 * - An expressway is its own road: a hole in one is an unbuilt or unmapped
 *   stretch, never the old road beside it.
 * - A ferry is not road, and a route back along the road's own line is the
 *   stitch gone wrong.
 */
export function judge(seg, route, { ref, category, line }) {
  if (!route) return { ok: false, why: 'no road joins the two ends' }
  if (route.snapKm > SNAP_KM) return { ok: false, why: `an end is ${route.snapKm.toFixed(1)} km from any road` }
  const s = split(route, ref)
  const ownShare = route.km ? s.own / route.km : 0
  const limit = ownShare >= 0.5 ? OWN_DETOUR * seg.km + 5 : DETOUR * seg.km + SLACK_KM
  if (route.km > limit) {
    return { ok: false, why: `the nearest road round is ${route.km.toFixed(1)} km for a ${seg.km.toFixed(1)} km hole` }
  }
  if (s.ferry > 0.2) return { ok: false, why: 'the way across is a ferry' }
  if (route.km > SHARED_KM && s.other / route.km > 0.5 && ownShare < 0.25) {
    return { ok: false, why: `the road between the ends is ${s.mainOther}` }
  }
  if (category === 'expressway' && ownShare < 0.5 && s.motorway / route.km < 0.8) {
    return { ok: false, why: 'no expressway joins the two ends' }
  }
  if (retraces(route.coords, line, seg)) return { ok: false, why: 'the route runs back along the road itself' }
  if (doublesBack(route.coords)) return { ok: false, why: 'the route turns back on itself' }
  return { ok: true, why: `${route.km.toFixed(1)} km of road, ${Math.round(100 * ownShare)}% tagged with its number` }
}

/**
 * Points every STEP_KM along a line, each with how far along it is. The checks
 * below count length, and a route's own vertices are sparse wherever it runs
 * straight — exactly where a U-turn's two legs run side by side.
 */
const STEP_KM = 0.25
function resample(coords) {
  if (coords.length < 2) return coords.map((p) => ({ p, km: 0 }))
  const out = [{ p: coords[0], km: 0 }]
  let km = 0
  for (let i = 1; i < coords.length; i++) {
    const d = haversineKm(coords[i - 1], coords[i])
    const n = Math.max(1, Math.ceil(d / STEP_KM))
    for (let k = 1; k <= n; k++) {
      const t = k / n
      out.push({ p: [coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t, coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t], km: km + d * t })
    }
    km += d
  }
  return out
}

/**
 * Over 40% of the route lies within 100 m of a part of itself more than 1 km
 * further on or back: out to a U-turn and back down the other carriageway.
 * Hairpins pass close to each other too, but only at their bends.
 */
function doublesBack(coords) {
  const pts = resample(coords)
  if (pts.length < 5) return false
  let close = 0
  for (const { p, km } of pts) {
    for (let j = 1; j < pts.length; j++) {
      if (Math.abs(pts[j].km - km) < 1 || Math.abs(pts[j - 1].km - km) < 1) continue
      if (Math.abs(pts[j].p[1] - p[1]) > 0.01) continue // ~1 km: cannot be within 100 m
      if (offSegmentKm(p, pts[j - 1].p, pts[j].p) < 0.1) {
        close++
        break
      }
    }
  }
  return close / pts.length > 0.4
}

/** Over 30% of the route, away from the hole's ends, lies within 200 m of the rest of the line. */
function retraces(coords, line, seg) {
  const probe = resample(coords)
    .map(({ p }) => p)
    .filter((p) => haversineKm(p, seg.a) > 1 && haversineKm(p, seg.b) > 1)
  if (probe.length < 5) return false
  const lo = [Math.min(seg.a[0], seg.b[0]) - 0.5, Math.min(seg.a[1], seg.b[1]) - 0.5]
  const hi = [Math.max(seg.a[0], seg.b[0]) + 0.5, Math.max(seg.a[1], seg.b[1]) + 0.5]
  const near = []
  for (let i = 1; i < line.length; i++) {
    if (i === seg.i) continue
    const [p, q] = [line[i - 1], line[i]]
    if (Math.max(p[0], q[0]) < lo[0] || Math.min(p[0], q[0]) > hi[0]) continue
    if (Math.max(p[1], q[1]) < lo[1] || Math.min(p[1], q[1]) > hi[1]) continue
    near.push([p, q])
  }
  if (!near.length) return false
  const on = probe.filter((p) => near.some(([a, b]) => offSegmentKm(p, a, b) < 0.2)).length
  return on / probe.length > 0.3
}
