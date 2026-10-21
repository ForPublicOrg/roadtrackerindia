// node --test scripts/integrity.test.mjs — the in-memory rate limiter, the one
// a deployment without Upstash (and every local run) actually uses. Imports the
// shipped .ts file directly (Node's type stripping), so this tests the real code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RATINGS_PER_HOUR } from '../api/_lib/ratings-math.ts'

// Read when the first limiter is built, so unset before anything asks for one.
delete process.env.UPSTASH_REDIS_REST_URL
delete process.env.UPSTASH_REDIS_REST_TOKEN
const { checkRateLimit } = await import('../api/_lib/integrity.ts')

/** How many of `n` checks in a row get through. */
async function allowed(n, ip, scope, limit) {
  let ok = 0
  for (let i = 0; i < n; i++) if (await checkRateLimit(typeof ip === 'function' ? ip(i) : ip, scope, limit)) ok++
  return ok
}

test("the first limit built does not pin the rest: 'rate' gets its 100 after a 20 was built", async () => {
  assert.equal(RATINGS_PER_HOUR, 100)
  assert.equal(await checkRateLimit('10.0.0.1', 'review'), true, 'builds the default 20 first')

  // One person on a /24 rating NH 44 stretch by stretch, and fixing taps:
  // 100 an hour, shared by the whole prefix, as both endpoints ask for it.
  assert.equal(await allowed(RATINGS_PER_HOUR, (i) => `10.1.1.${1 + (i % 200)}`, 'rate', RATINGS_PER_HOUR), 100)
  assert.equal(await checkRateLimit('10.1.1.250', 'rate', RATINGS_PER_HOUR), false, 'a neighbour on the same /24')
  assert.equal(await checkRateLimit('10.1.2.1', 'rate', RATINGS_PER_HOUR), true, 'another /24 has its own')

  // ...and the 20 still means 20, for a scope that never asked for more.
  assert.equal(await allowed(25, '10.1.1.9', 'review'), 20, 'reviews kept their own budget')
  assert.equal(await allowed(25, '10.1.1.9', 'like'), 20)
})

test('each limit is its own window, even for the same key', async () => {
  assert.equal(await allowed(5, '10.2.2.2', 'probe', 2), 2)
  assert.equal(await allowed(5, '10.2.2.2', 'probe', 3), 3, 'not judged by the hits of the 2')
})

test('a refused attempt does not push the lockout further out', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 0, 1) })
  const minute = 60_000
  assert.equal(await allowed(2, '10.3.3.3', 'retry', 2), 2)
  t.mock.timers.tick(30 * minute)
  assert.equal(await allowed(10, '10.3.3.3', 'retry', 2), 0, 'still within the hour')
  // An hour after the two that counted, the window is clear — the ten refused
  // half an hour later were never counted, as in Upstash's sliding window.
  t.mock.timers.tick(30 * minute + 1)
  assert.equal(await checkRateLimit('10.3.3.3', 'retry', 2), true)
})
