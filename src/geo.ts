import type { BBox, LngLat, NetworkFC } from './types'

const R = 6371

export function haversineKm(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/**
 * Where point p falls on segment a–b, using a local flat projection: how far
 * away it is (km), and how far along the segment its foot lands (t, 0 at a and
 * 1 at b). The flat projection is plenty at the scale of one segment, and far
 * cheaper than doing it on the sphere for every segment of every road on a tap.
 */
export function segProject(p: LngLat, a: LngLat, b: LngLat): { distKm: number; t: number } {
  const kx = 111.32 * Math.cos((p[1] * Math.PI) / 180)
  const ky = 110.574
  const px = p[0] * kx
  const py = p[1] * ky
  const ax = a[0] * kx
  const ay = a[1] * ky
  const bx = b[0] * kx
  const by = b[1] * ky
  const dx = bx - ax
  const dy = by - ay
  if (dx === 0 && dy === 0) return { distKm: Math.hypot(px - ax, py - ay), t: 0 }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return { distKm: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t }
}

/** km from the start of the line to each of its points. */
export function cumulativeKm(coords: LngLat[]): number[] {
  const cum: number[] = []
  let km = 0
  for (let i = 0; i < coords.length; i++) {
    if (i) km += haversineKm(coords[i - 1], coords[i])
    cum.push(km)
  }
  return cum
}

/** The point on the line nearest p: how far along the line it is, and how far
 *  p is from it. `cum` is the line's cumulativeKm, passed in so a caller that
 *  asks many times measures the line once. */
export function nearestOnLine(p: LngLat, coords: LngLat[], cum: number[]): { km: number; distKm: number } {
  if (coords.length < 2) {
    return { km: 0, distKm: coords.length ? segProject(p, coords[0], coords[0]).distKm : Infinity }
  }
  let best = { km: 0, distKm: Infinity }
  for (let i = 1; i < coords.length; i++) {
    const { distKm, t } = segProject(p, coords[i - 1], coords[i])
    if (distKm < best.distKm) best = { km: cum[i - 1] + t * (cum[i] - cum[i - 1]), distKm }
  }
  return best
}

/** The first point index at or beyond km, never 0 — cum only ever grows, so a
 *  binary search finds it without walking a 3,000-point line. */
function pointAfter(cum: number[], km: number): number {
  let lo = 1
  let hi = cum.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cum[mid] < km) lo = mid + 1
    else hi = mid
  }
  return lo
}

function pointAt(coords: LngLat[], cum: number[], km: number): LngLat {
  const i = pointAfter(cum, km)
  const span = cum[i] - cum[i - 1]
  const f = span > 0 ? (km - cum[i - 1]) / span : 1
  const a = coords[i - 1]
  const b = coords[i]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
}

/** The part of the line between two distances along it. The ends are
 *  interpolated rather than snapped to the nearest point, so neighbouring
 *  slices meet exactly instead of overlapping or leaving a gap. */
export function sliceLine(coords: LngLat[], cum: number[], kmA: number, kmB: number): LngLat[] {
  if (coords.length < 2) return coords.slice()
  const total = cum[cum.length - 1]
  const a = Math.max(0, Math.min(total, Math.min(kmA, kmB)))
  const b = Math.max(0, Math.min(total, Math.max(kmA, kmB)))
  const out: LngLat[] = [pointAt(coords, cum, a)]
  for (let i = pointAfter(cum, a); i < coords.length && cum[i] < b; i++) {
    if (cum[i] > a) out.push(coords[i])
  }
  out.push(pointAt(coords, cum, b))
  return out
}

export function bboxOf(coords: LngLat[]): BBox {
  if (!coords.length) return [0, 0, 0, 0]
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng
    if (lat < minLat) minLat = lat
    if (lng > maxLng) maxLng = lng
    if (lat > maxLat) maxLat = lat
  }
  return [minLng, minLat, maxLng, maxLat]
}

export interface NearestRoad {
  id: string
  ref: string
  name: string
  distKm: number
}

/** The n nearest catalogued roads to a point, cheap enough to run on tap. */
export function nearestRoads(p: LngLat, network: NetworkFC, n = 3): NearestRoad[] {
  const results: NearestRoad[] = []
  for (const f of network.features) {
    const coords = f.geometry.coordinates
    let best = Infinity
    for (let i = 1; i < coords.length; i++) {
      // cheap prefilter: skip segments whose start is >5° away (~550 km)
      if (Math.abs(coords[i][0] - p[0]) > 5 || Math.abs(coords[i][1] - p[1]) > 5) {
        if (Math.abs(coords[i - 1][0] - p[0]) > 5 || Math.abs(coords[i - 1][1] - p[1]) > 5) continue
      }
      const d = segProject(p, coords[i - 1], coords[i]).distKm
      if (d < best) best = d
    }
    if (best < Infinity) {
      results.push({ id: f.properties.id, ref: f.properties.ref, name: f.properties.name, distKm: best })
    }
  }
  results.sort((a, b) => a.distKm - b.distKm)
  return results.slice(0, n)
}

export function formatKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`
  if (km < 20) return `${km.toFixed(1)} km`
  return `${Math.round(km).toLocaleString('en-IN')} km`
}

/**
 * Where a road runs, for a one-line list row. A ring road ends where it starts,
 * and "Bengaluru → Bengaluru" reads as a bug rather than as a loop.
 */
export function formatEnds(start: string, end: string): string {
  const from = start.split(',')[0]
  return start === end ? `around ${from}` : `${from} → ${end.split(',')[0]}`
}
