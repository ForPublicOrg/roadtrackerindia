// node --test scripts/lib/   — the Overpass client's idea of a failed query
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { overpass } from './overpass.mjs'

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
