// node --test scripts/lib/   — the Overpass client's idea of a failed query
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_SEGMENT_KM, haversineKm, overpass, simplify } from './overpass.mjs'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const answer = (body) => {
  globalThis.fetch = async () => new Response(JSON.stringify(body))
}

test('a 200 carrying a runtime error is a failure, not an empty result', async () => {
  // what Overpass sends when a query outlives its [timeout:N]
  answer({
    version: 0.6,
    elements: [],
    remark: 'runtime error: Query timed out in "query" at line 1 after 301 seconds.',
  })
  await assert.rejects(overpass('relation(id:1);out geom;', { retries: 0 }), /Query timed out/)
})

test('a 200 with a partial result and an out-of-memory remark is a failure too', async () => {
  answer({
    elements: [{ type: 'relation', id: 1, members: [] }],
    remark: 'runtime error: Query run out of memory using about 2048 MB of RAM.',
  })
  await assert.rejects(overpass('relation(id:1);out;way(r);out geom;', { retries: 0 }), /out of memory/)
})

test('an ordinary answer comes back as it is, empty or not', async () => {
  answer({ elements: [] })
  assert.deepEqual(await overpass('relation(id:1);out;', { retries: 0 }), { elements: [] })
  answer({ elements: [{ type: 'node', id: 7 }] })
  assert.deepEqual((await overpass('node(7);out;', { retries: 0 })).elements, [{ type: 'node', id: 7 }])
})

// ── simplify ─────────────────────────────────────────────────────────

/** A road due north from 20°N, a vertex every `stepKm`, with a `holeKm` hole at `holeAtKm`. */
function meridian(km, { stepKm = 0.2, holeAtKm = null, holeKm = 0 } = {}) {
  const deg = 360 / (2 * Math.PI * 6371)
  const line = []
  for (let k = 0; k * stepKm <= km + 1e-9; k++) {
    const d = k * stepKm
    if (holeAtKm !== null && d > holeAtKm + 1e-9 && d < holeAtKm + holeKm - 1e-9) continue
    line.push([75, 20 + d * deg])
  }
  return line
}
const segments = (line) => line.slice(1).map((p, i) => haversineKm(line[i], p))

test('a dead-straight road keeps a real vertex every few kilometres', () => {
  const road = meridian(60)
  // the trap: tolerance alone leaves 60 km of road as one segment
  assert.equal(simplify(road, 0.03).length, 2)
  const line = simplify(road, 0.03, { maxSegKm: MAX_SEGMENT_KM })
  assert.ok(Math.max(...segments(line)) <= MAX_SEGMENT_KM + 0.05, `longest ${Math.max(...segments(line))} km`)
  // every vertex kept is one the road had
  const had = new Set(road.map(String))
  assert.ok(line.every((p) => had.has(String(p))))
})

test('a hole stays one segment: there is no vertex in it to keep', () => {
  const line = simplify(meridian(80, { holeAtKm: 30, holeKm: 25 }), 0.03, { maxSegKm: MAX_SEGMENT_KM })
  const segs = segments(line).sort((a, b) => b - a)
  assert.ok(segs[0] > 24.9 && segs[0] < 25.1, `longest ${segs[0]} km`)
  assert.ok(segs[1] <= MAX_SEGMENT_KM + 0.05, `next longest ${segs[1]} km`)
})

test('keeping a vertex every few kilometres only ever adds vertices to a bendy road', () => {
  const deg = 360 / (2 * Math.PI * 6371)
  const road = meridian(40).map(([x, y], i) => [x + Math.sin(i / 7) * 0.4 * deg, y])
  const plain = simplify(road, 0.03)
  const capped = new Set(simplify(road, 0.03, { maxSegKm: MAX_SEGMENT_KM }).map(String))
  assert.ok(plain.every((p) => capped.has(String(p))))
})
