import type { LngLat, NetworkFC } from './types'

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

/** Distance (km) from point p to segment a–b using a local flat projection. */
function segDistKm(p: LngLat, a: LngLat, b: LngLat): number {
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
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
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
      const d = segDistKm(p, coords[i - 1], coords[i])
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
