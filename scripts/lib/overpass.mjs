/**
 * Shared Overpass API client for the data scripts.
 *
 * overpass-api.de returns HTTP 406 without a User-Agent, and 429/504 under
 * load — so every call here is identified, throttled and retried with backoff.
 * Data © OpenStreetMap contributors, ODbL.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const CACHE_DIR = join(ROOT, '.cache', 'osm')

/** Greater-India bounding box, Overpass order: south,west,north,east. */
export const BBOX = '(6.0,67.5,37.5,97.6)'

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
]

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// OVERPASS_START lets parallel workers start on different mirrors
let endpointIdx = Number(process.env.OVERPASS_START ?? 0) || 0

/**
 * Run an Overpass QL query (without the [out:json] prologue) and return JSON.
 * Rotates endpoints and backs off on rate limits / gateway timeouts.
 */
export async function overpass(query, { timeout = 600, retries = 4 } = {}) {
  const body = `data=${encodeURIComponent(`[out:json][timeout:${timeout}];${query}`)}`
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    const url = ENDPOINTS[endpointIdx % ENDPOINTS.length]
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'RoadTrackerIndia-data-build/1.0 (https://roadtrackerindia.com)',
          Accept: 'application/json',
        },
        body,
      })
      if (res.status === 429) throw Object.assign(new Error('HTTP 429'), { overloaded: true })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const text = await res.text()
      // Overpass sometimes returns a 200 with a truncated body on timeout
      if (!text.trimEnd().endsWith('}')) throw new Error('truncated response')
      return JSON.parse(text)
    } catch (e) {
      lastErr = e
      endpointIdx++
      // 429 means we are out of query slots, not that the query is bad —
      // backing off properly is far faster than hammering three endpoints
      const base = e.overloaded ? 15000 : 3000
      const wait = Math.min(90000, base * 2 ** attempt)
      if (attempt < retries) {
        process.stderr.write(`    overpass ${e.message} — retry in ${wait / 1000}s\n`)
        await sleep(wait)
      }
    }
  }
  throw lastErr
}

/** Read/write JSON through a local cache file so re-runs are free. */
export function cachePath(...parts) {
  const p = join(CACHE_DIR, ...parts)
  mkdirSync(dirname(p), { recursive: true })
  return p
}

export function readCache(...parts) {
  const p = cachePath(...parts)
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}

export function writeCache(value, ...parts) {
  writeFileSync(cachePath(...parts), JSON.stringify(value))
  return value
}

// ── geometry helpers ─────────────────────────────────────────────────

const R = 6371
export function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export const lineLengthKm = (coords) =>
  coords.slice(1).reduce((sum, p, i) => sum + haversineKm(coords[i], p), 0)

/** Douglas–Peucker; tolerance in km. */
export function simplify(coords, tolKm) {
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
    const ax = coords[lo][0] * kx
    const ay = coords[lo][1] * ky
    const dx = coords[hi][0] * kx - ax
    const dy = coords[hi][1] * ky - ay
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

export const round5 = (n) => Math.round(n * 1e5) / 1e5

// ── encoded polyline ─────────────────────────────────────────────────
// Google's algorithm. A stored alignment is ~5 bytes per point instead of the
// ~22 that a JSON [lng, lat] pair costs — the difference between a 10 MB and a
// 50 MB repository once every road in India is in the catalogue.

function encodeSigned(value, out) {
  let v = value < 0 ? ~(value << 1) : value << 1
  while (v >= 0x20) {
    out.push(String.fromCharCode((0x20 | (v & 0x1f)) + 63))
    v >>>= 5
  }
  out.push(String.fromCharCode(v + 63))
}

/** coords are [lng, lat]; precision 5 ≈ 1 m. */
export function encodePolyline(coords, precision = 5) {
  const factor = 10 ** precision
  const out = []
  let lastLng = 0
  let lastLat = 0
  for (const [lng, lat] of coords) {
    const y = Math.round(lat * factor)
    const x = Math.round(lng * factor)
    encodeSigned(y - lastLat, out)
    encodeSigned(x - lastLng, out)
    lastLat = y
    lastLng = x
  }
  return out.join('')
}

export function decodePolyline(str, precision = 5) {
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
