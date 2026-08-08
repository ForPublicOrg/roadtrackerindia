import { loadPlaces } from './data'
import { state } from './state'
import type { Area, BBox, LngLat, NetworkFC, PlaceExtent } from './types'

/**
 * Narrowing the map to a city or a state.
 *
 * The extents come from `places.json`; membership is decided on the ground
 * rather than from the road's own list of towns, because a road that clips the
 * edge of a district belongs to it just as much as one that names it, and
 * because half of India's place names are shared by three other places.
 */

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

let extents: { city: Map<string, BBox>; state: Map<string, BBox> } | null = null
let loading: Promise<void> | null = null

function index(rows: PlaceExtent[]): Map<string, BBox> {
  const m = new Map<string, BBox>()
  for (const [name, a, b, c, d] of rows) m.set(norm(name), [a, b, c, d])
  return m
}

async function ready(): Promise<void> {
  if (extents) return
  loading ??= loadPlaces()
    .then((p) => {
      extents = { city: index(p.cities), state: index(p.states) }
    })
    .finally(() => {
      loading = null
    })
  await loading
}

/**
 * Where a place is and what runs through it. Resolves to null when the
 * catalogue has the name but nothing that can position it — the caller still
 * has a road list to show, it just can't fly anywhere.
 */
export async function resolveArea(kind: 'city' | 'state', name: string): Promise<Area | null> {
  try {
    await ready()
  } catch {
    return null
  }
  const bbox = extents?.[kind].get(norm(name))
  if (!bbox) return null
  return { kind, name, bbox, ids: roadsInArea(kind, name, bbox) }
}

/** Re-count an area once more of the network has arrived. */
export function recountArea(area: Area): Area {
  return { ...area, ids: roadsInArea(area.kind, area.name, area.bbox) }
}

function roadsInArea(kind: 'city' | 'state', name: string, bbox: BBox): string[] {
  // A state is a jurisdiction, not a rectangle: the catalogue already records
  // which ones every road runs through, and that answer beats any box.
  if (kind === 'state') return state.roads.filter((r) => r.states.includes(name)).map((r) => r.id)

  const ids = new Set<string>()
  for (const road of state.roads) {
    if (road.cities.includes(name) && overlaps(road.bbox, bbox)) ids.add(road.id)
  }
  for (const fc of [state.network, state.networkDetail]) {
    if (!fc) continue
    collectCrossings(fc, bbox, ids)
  }
  return [...ids]
}

function collectCrossings(fc: NetworkFC, bbox: BBox, into: Set<string>): void {
  for (const f of fc.features) {
    const id = f.properties.id
    if (into.has(id)) continue
    // the road's own extent rejects all but a handful before any segment maths
    const summary = state.byId.get(id)
    if (summary && !overlaps(summary.bbox, bbox)) continue
    if (crosses(f.geometry.coordinates, bbox)) into.add(id)
  }
}

export function overlaps(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]
}

function crosses(line: LngLat[], box: BBox): boolean {
  for (let i = 1; i < line.length; i++) {
    if (segmentHitsBox(line[i - 1], line[i], box)) return true
  }
  return line.length === 1 ? inside(line[0], box) : false
}

const inside = (p: LngLat, b: BBox) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]

/**
 * Liang–Barsky: does the segment touch the box at all? Testing vertices alone
 * would miss a highway that crosses a small town in one long simplified hop.
 */
function segmentHitsBox(from: LngLat, to: LngLat, b: BBox): boolean {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const p = [-dx, dx, -dy, dy]
  const q = [from[0] - b[0], b[2] - from[0], from[1] - b[1], b[3] - from[1]]
  let t0 = 0
  let t1 = 1
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false // parallel to this edge and outside it
      continue
    }
    const t = q[i] / p[i]
    if (p[i] < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
  }
  return true
}
