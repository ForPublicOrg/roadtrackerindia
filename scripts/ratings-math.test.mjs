// node --test scripts/ratings-math.test.mjs   — the rules that turn one person's
// rating, review or like into the two documents a write puts back. Imports the
// shipped .ts file directly (Node's type stripping), so this tests the real code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL,
  MAX_ENTRIES_PER_PERSON,
  MAX_RANGE_KEYS,
  MAX_REVIEWS,
  MAX_TEXTS_PER_PERSON,
  RANGE_KEY,
  applyDelete,
  applyLike,
  applySave,
  canonicalRange,
  normaliseAgg,
  normaliseRater,
  personVote,
  sortReviews,
  writtenByOldCode,
} from '../api/_lib/ratings-math.ts'

const ROAD = 'nh-44'
const AB = 'agra--delhi'
const CD = 'gwalior--jhansi'

/** A road and the people on it, written the way ratings-store.ts writes: read,
 *  normalise, apply, and keep what the transaction would set. */
function world(agg, raters = {}) {
  const w = { agg, raters: { ...raters }, clock: 0, ids: 0 }
  const tick = () => new Date(Date.UTC(2026, 0, 1) + ++w.clock * 60_000).toISOString()
  // Frozen, so a rule that edits a document it was handed throws.
  const read = (who) => [
    deepFreeze(normaliseAgg(deepFreeze(w.agg), ROAD)),
    deepFreeze(normaliseRater(deepFreeze(w.raters[who]), ROAD)),
  ]
  const keep = (who, r) => {
    if (typeof r === 'object' && r.agg && r.rater) {
      w.agg = r.agg
      w.raters[who] = r.rater
    }
    return r
  }
  w.save = (who, input) => keep(who, applySave(...read(who), input, tick(), `id${++w.ids}`))
  w.del = (who, range) => keep(who, applyDelete(...read(who), range, tick()))
  w.like = (who, id, on) => keep(who, applyLike(...read(who), id, on, tick()))
  w.review = (id) => (w.agg?.reviews ?? []).find((r) => r.id === id)
  w.entries = (who) => normaliseRater(w.raters[who], ROAD).entries
  return w
}

const legacyAgg = (votes, reviews = []) => {
  const counts = {}
  for (const s of votes) counts[s] = (counts[s] ?? 0) + 1
  return {
    road_id: ROAD,
    counts,
    total: votes.length,
    sum: votes.reduce((a, b) => a + b, 0),
    updated_at: '2025-06-01T00:00:00.000Z',
    reviews,
  }
}
const oldReview = (id, stars, likes = 0) => ({
  id,
  text: 'written before stretches',
  stars,
  likes,
  at: '2025-06-01T00:00:00.000Z',
})

// ── keys ───────────────────────────────────────────────────────────

test('canonicalRange sorts the two slugs and rejects anything else', () => {
  assert.equal(canonicalRange('all'), 'all')
  assert.equal(canonicalRange('delhi--agra'), 'agra--delhi')
  assert.equal(canonicalRange('agra--delhi'), 'agra--delhi')
  assert.equal(canonicalRange('new-delhi--agra-2'), 'agra-2--new-delhi')
  assert.equal(canonicalRange('s3--s12'), 's12--s3') // plain string order, same as the client
  assert.equal(canonicalRange('agra--agra'), null)
  for (const bad of ['', 'ALL', 'agra', 'agra-delhi', 'Agra--Delhi', 'a--b--c', '-a--b', 'a---b', 'a--b-', 'a b--c', 'agra--delhi\n']) {
    assert.equal(canonicalRange(bad), null, JSON.stringify(bad))
  }
  const side = 'a'.repeat(44)
  assert.equal(canonicalRange(`${side}--${side.replace(/a$/, 'b')}`), `${side}--${side.replace(/a$/, 'b')}`) // 90
  assert.equal(canonicalRange(`${side}--${side}bb`), null) // 92
  assert.ok(RANGE_KEY.test('agra--delhi') && !RANGE_KEY.test('agra'))
})

// ── normalising old documents ──────────────────────────────────────

test('normaliseAgg: every vote cast before stretches was a whole-road vote', () => {
  const old = legacyAgg([4, 4, 2], [oldReview('L1', 4)])
  const a = normaliseAgg(old, ROAD)
  assert.deepEqual(a.ranges, { all: { total: 3, sum: 10, counts: { 2: 1, 4: 2 } } })
  assert.deepEqual(a.reviews, old.reviews)
  a.ranges.all.counts['4'] = 99
  a.reviews[0].likes = 99
  assert.equal(old.counts['4'], 2, 'a working copy, not the document it came from')
  assert.equal(old.reviews[0].likes, 0)

  assert.deepEqual(normaliseAgg(undefined, ROAD), {
    road_id: ROAD, counts: {}, total: 0, sum: 0, updated_at: '', reviews: [], ranges: {},
  })
  // Reviews but no ratings yet: no `all` range at zero.
  assert.deepEqual(normaliseAgg(legacyAgg([], [oldReview('L', null)]), ROAD).ranges, {})
  // The old code left emptied buckets at 0.
  assert.deepEqual(normaliseAgg({ ...legacyAgg([5]), counts: { 3: 0, 5: 1 } }, ROAD).counts, { 5: 1 })
  // Already in the new shape: ranges are taken as they are.
  const ranges = { [AB]: { total: 1, sum: 2, counts: { 2: 1 } } }
  assert.deepEqual(normaliseAgg({ ...legacyAgg([2]), ranges }, ROAD).ranges, ranges)
})

test('normaliseRater folds the old one-rating-one-review shape into entries.all', () => {
  const n = (doc) => normaliseRater(doc, ROAD)
  assert.deepEqual(n(undefined), { road_id: ROAD, liked: [], entries: {} })
  assert.deepEqual(n({ road_id: ROAD, updated_at: 'x', stars: 4, review_id: 'L1', liked: ['a', 'a', 'b'] }), {
    road_id: ROAD, liked: ['a', 'b'], entries: { all: { stars: 4, review_id: 'L1' } },
  })
  assert.deepEqual(n({ road_id: ROAD, updated_at: 'x', stars: 3 }).entries, { all: { stars: 3 } })
  assert.deepEqual(n({ road_id: ROAD, updated_at: 'x', review_id: 'L2' }).entries, {
    all: { stars: null, review_id: 'L2' },
  })
  // entries present: the old fields are stale leftovers and mean nothing
  assert.deepEqual(
    n({ road_id: ROAD, updated_at: 'x', stars: 5, review_id: 'L3', entries: { [AB]: { stars: 2 } } }).entries,
    { [AB]: { stars: 2 } },
  )
})

test('writtenByOldCode: entries beside a pre-stretch field mean old code merged into a new doc', () => {
  const w = world(legacyAgg([4]), { p: { road_id: ROAD, updated_at: 'x', stars: 4, review_id: 'L1' } })
  assert.equal(writtenByOldCode(w.raters.p), false, 'an old doc, before any new write')
  w.save('p', { range: AB, stars: 2 })
  assert.equal(writtenByOldCode(w.raters.p), false, 'what this code writes')
  assert.equal(writtenByOldCode(undefined), false)
  // what the old recordRating / saveReview merge on top of it
  assert.equal(writtenByOldCode({ ...w.raters.p, stars: 5 }), true)
  assert.equal(writtenByOldCode({ ...w.raters.p, review_id: 'orphan' }), true)
  // the old like merges only `liked`, which both shapes share
  assert.equal(writtenByOldCode({ ...w.raters.p, liked: ['x'] }), false)
})

test('personVote: whole-road stars if given, else the rounded mean of stretch stars', () => {
  assert.equal(personVote({}), null)
  assert.equal(personVote({ all: { stars: 4 } }), 4)
  assert.equal(personVote({ all: { stars: 2 }, [AB]: { stars: 5 }, [CD]: { stars: 5 } }), 2)
  assert.equal(personVote({ all: { stars: null, review_id: 'x' }, [AB]: { stars: 2 }, [CD]: { stars: 5 } }), 4)
  assert.equal(personVote({ [AB]: { stars: 1 }, [CD]: { stars: 2 } }), 2)
  assert.equal(personVote({ [AB]: { stars: 1 }, [CD]: { stars: 1 }, 'a--b': { stars: 2 } }), 1)
  assert.equal(personVote({ all: { stars: null, review_id: 'x' } }), null)
})

test('sortReviews: most-liked first, newest breaking ties', () => {
  const r = (id, likes, at) => ({ id, text: 't', stars: 3, likes, at })
  const list = [r('a', 0, '2026-01-01'), r('b', 2, '2026-01-01'), r('c', 0, '2026-02-01')]
  assert.deepEqual(sortReviews(list).map((x) => x.id), ['b', 'c', 'a'])
  assert.deepEqual(list.map((x) => x.id), ['a', 'b', 'c'], 'sorts a copy')
})

// ── saving ─────────────────────────────────────────────────────────

test('one person is one vote in the headline, one per entry in ranges', () => {
  const w = world(undefined)
  let r = w.save('p', { range: AB, stars: 2 })
  assert.equal(r.updated, false)
  assert.equal(r.reviewId, null)
  assert.deepEqual(w.agg.ranges, { [AB]: { total: 1, sum: 2, counts: { 2: 1 } } })
  w.save('p', { range: CD, stars: 5 })
  assert.deepEqual([w.agg.total, w.agg.sum, w.agg.counts], [1, 4, { 4: 1 }]) // round(3.5)
  w.save('p', { range: ALL, stars: 1 })
  assert.deepEqual([w.agg.total, w.agg.sum, w.agg.counts], [1, 1, { 1: 1 }])
  assert.equal(Object.keys(w.agg.ranges).length, 3)
  r = w.save('p', { range: ALL, stars: 3 })
  assert.equal(r.updated, true)
  assert.deepEqual(w.agg.ranges.all, { total: 1, sum: 3, counts: { 3: 1 } }, 'a re-rate moves, never adds')
  w.del('p', ALL)
  assert.deepEqual([w.agg.total, w.agg.sum, w.agg.counts], [1, 4, { 4: 1 }])
  w.save('q', { range: AB, stars: 4 })
  assert.deepEqual(w.agg.ranges[AB], { total: 2, sum: 6, counts: { 2: 1, 4: 1 } })
  assert.deepEqual([w.agg.total, w.agg.counts], [2, { 4: 2 }])
})

test('text: undefined keeps it, empty removes it, anything else writes it', () => {
  const w = world(undefined)
  const first = w.save('p', { range: AB, stars: 4, text: 'Smooth till Mathura' })
  const id = first.reviewId
  assert.ok(id)
  assert.deepEqual(w.review(id), {
    id, text: 'Smooth till Mathura', stars: 4, likes: 0, at: w.review(id).at, range: AB,
  })
  w.like('q', id, true)

  // A re-rate with no text: the words stay, the stars on them follow.
  let r = w.save('p', { range: AB, stars: 2 })
  assert.equal(r.reviewId, id)
  assert.equal(w.review(id).text, 'Smooth till Mathura')
  assert.equal(w.review(id).stars, 2)
  assert.equal(w.review(id).edited, undefined)

  // New words edit in place: same id, likes kept.
  r = w.save('p', { range: AB, stars: 3, text: 'Potholes after Mathura' })
  assert.equal(r.reviewId, id)
  assert.deepEqual([w.review(id).text, w.review(id).stars, w.review(id).likes], ['Potholes after Mathura', 3, 1])
  assert.ok(w.review(id).edited)
  assert.equal(w.agg.reviews.length, 1)

  // Empty: the review goes, the stars stay.
  r = w.save('p', { range: AB, stars: 3, text: '' })
  assert.equal(r.reviewId, null)
  assert.equal(w.review(id), undefined)
  assert.deepEqual(w.entries('p'), { [AB]: { stars: 3 } })
  assert.deepEqual(w.agg.ranges[AB], { total: 1, sum: 3, counts: { 3: 1 } })
})

test('an evicted review is gone; saving text again makes a new one', () => {
  const w = world(undefined)
  const mine = w.save('x', { range: AB, stars: 3, text: 'mine, and the oldest' }).reviewId
  for (let i = 0; i < MAX_REVIEWS; i++) w.save(`o${i}`, { range: ALL, stars: 4, text: `other ${i}` })
  assert.equal(w.agg.reviews.length, MAX_REVIEWS)
  assert.equal(w.review(mine), undefined, 'least-liked, oldest makes way')
  assert.equal(w.raters.x.entries[AB].review_id, mine, 'its author was not written, so it dangles')

  // A star-only write clears the dangling pointer...
  w.save('x', { range: AB, stars: 2 })
  assert.deepEqual(w.raters.x.entries[AB], { stars: 2 })
  // ...and new words are a new review, not an edit of the old one.
  const again = w.save('x', { range: AB, stars: 2, text: 'back again' })
  assert.notEqual(again.reviewId, mine)
  assert.deepEqual(
    [w.review(again.reviewId).text, w.review(again.reviewId).likes, w.review(again.reviewId).range],
    ['back again', 0, AB],
  )
  assert.equal(w.agg.reviews.length, MAX_REVIEWS)
})

test('caps answer too-many or road-full and change nothing', () => {
  const docs = (w) => JSON.stringify([w.agg, w.raters])

  // entries per person
  let w = world(undefined)
  for (let i = 0; i < MAX_ENTRIES_PER_PERSON; i++) assert.notEqual(w.save('p', { range: `s${i}--t${i}`, stars: 3 }), 'too-many')
  let before = docs(w)
  assert.equal(w.save('p', { range: 'u--v', stars: 3 }), 'too-many')
  assert.equal(docs(w), before)
  assert.notEqual(w.save('p', { range: 's0--t0', stars: 5 }), 'too-many', 'an existing entry can change')
  assert.notEqual(w.save('q', { range: 'u--v', stars: 3 }), 'too-many', 'the cap is per person')

  // range keys per road: 'road-full', which is not the person's doing, so it
  // must not read as one of their own caps; the whole road is always rateable
  const ranges = {}
  for (let i = 0; i < MAX_RANGE_KEYS; i++) ranges[`s${i}--t${i}`] = { total: 1, sum: 3, counts: { 3: 1 } }
  w = world({ ...legacyAgg([]), ranges })
  before = docs(w)
  assert.equal(w.save('p', { range: 'u--v', stars: 3 }), 'road-full', 'a first-time visitor')
  assert.equal(w.save('p', { range: 'u--v', stars: 3, text: 'words too' }), 'road-full')
  assert.equal(docs(w), before)
  assert.equal(typeof w.save('p', { range: 's7--t7', stars: 3 }), 'object', 'a key somebody holds')
  assert.equal(typeof w.save('p', { range: ALL, stars: 3 }), 'object')
  // a key whose last vote goes makes room again
  w = world({ ...legacyAgg([3]), ranges }, { gone: { road_id: ROAD, updated_at: 'x', entries: { 's0--t0': { stars: 3 } } } })
  w.del('gone', 's0--t0')
  assert.equal(typeof w.save('p', { range: 'u--v', stars: 3 }), 'object')
  // a person at their own cap on a full road hears about theirs: it is the one they can act on
  const twenty = {}
  for (let i = 0; i < MAX_ENTRIES_PER_PERSON; i++) twenty[`s${i}--t${i}`] = { stars: 3 }
  w = world({ ...legacyAgg([3]), ranges }, { p: { road_id: ROAD, updated_at: 'x', entries: twenty } })
  assert.equal(w.save('p', { range: 'u--v', stars: 3 }), 'too-many')

  // live texts per person
  w = world(undefined)
  for (let i = 0; i < MAX_TEXTS_PER_PERSON; i++) w.save('p', { range: `s${i}--t${i}`, stars: 3, text: `text ${i}` })
  before = docs(w)
  assert.equal(w.save('p', { range: 'u--v', stars: 3, text: 'one too many' }), 'too-many')
  assert.equal(docs(w), before)
  assert.notEqual(w.save('p', { range: 'u--v', stars: 3 }), 'too-many', 'stars alone are fine')
  assert.equal(w.save('p', { range: 'u--v', stars: 3, text: 'still too many' }), 'too-many')
  assert.notEqual(w.save('p', { range: 's0--t0', stars: 3, text: 'editing is fine' }), 'too-many')
  w.save('p', { range: 's1--t1', stars: 3, text: '' })
  assert.notEqual(w.save('p', { range: 'u--v', stars: 3, text: 'room now' }), 'too-many')
})

test('a ranges key goes when its last vote does', () => {
  const w = world(undefined)
  w.save('p', { range: AB, stars: 3 })
  w.save('p', { range: CD, stars: 4 })
  w.del('p', AB)
  assert.deepEqual(Object.keys(w.agg.ranges), [CD])
  w.del('p', CD)
  assert.deepEqual(w.agg.ranges, {})
  assert.deepEqual([w.agg.total, w.agg.sum, w.agg.counts], [0, 0, {}])
})

// ── old documents and old pages ────────────────────────────────────

test('a pre-stretch rater doc is rewritten in the new shape on its first write', () => {
  const w = world(legacyAgg([4], [oldReview('L1', 4)]), {
    p: { road_id: ROAD, updated_at: '2025-06-01T00:00:00.000Z', stars: 4, review_id: 'L1', liked: ['gone'] },
  })
  w.save('p', { range: AB, stars: 2 })
  assert.deepEqual(w.raters.p, {
    road_id: ROAD,
    updated_at: w.raters.p.updated_at,
    entries: { all: { stars: 4, review_id: 'L1' }, [AB]: { stars: 2 } },
  })
  assert.deepEqual([w.agg.total, w.agg.counts], [1, { 4: 1 }], 'their whole-road stars still lead')
  assert.deepEqual(w.agg.ranges, {
    all: { total: 1, sum: 4, counts: { 4: 1 } },
    [AB]: { total: 1, sum: 2, counts: { 2: 1 } },
  })
})

test('an old page posting only text keeps the stars the person gave', () => {
  // ratings-store.ts fills missing stars from the person's whole-road entry
  const w = world(legacyAgg([5]), { p: { road_id: ROAD, updated_at: 'x', stars: 5 } })
  const stars = w.entries('p').all?.stars ?? null
  const r = w.save('p', { range: ALL, stars, text: 'Wide and fast' })
  assert.deepEqual([w.review(r.reviewId).stars, w.agg.total, w.agg.sum], [5, 1, 5])
  // never rated: a review with no stars, which counts nowhere
  const n = w.save('q', { range: ALL, stars: null, text: 'Never drove it' })
  assert.deepEqual(w.entries('q'), { all: { stars: null, review_id: n.reviewId } })
  assert.equal(w.agg.total, 1)
  assert.deepEqual(w.agg.ranges, { all: { total: 1, sum: 5, counts: { 5: 1 } } })
})

test('delete with no range removes only the whole-road text', () => {
  const w = world(legacyAgg([4], [oldReview('L1', 4), oldReview('L2', null)]), {
    p: { road_id: ROAD, updated_at: 'x', stars: 4, review_id: 'L1' },
    q: { road_id: ROAD, updated_at: 'x', review_id: 'L2' },
  })
  w.save('p', { range: AB, stars: 1, text: 'about one stretch' })
  const r = w.del('p', undefined)
  assert.notEqual(r, 'not-found')
  assert.equal(w.review('L1'), undefined)
  assert.equal(w.agg.reviews.length, 2, 'the stretch review and q are untouched')
  assert.equal(w.entries('p').all.stars, 4)
  assert.equal(w.entries('p').all.review_id, undefined)
  assert.deepEqual([w.agg.total, w.agg.sum], [1, 4])
  assert.equal(w.del('p', undefined), 'not-found', 'no whole-road text left')

  // review-only: nothing is left, so the entry goes
  w.del('q', undefined)
  assert.deepEqual(w.entries('q'), {})

  // with a range, the stars go too
  w.del('p', ALL)
  assert.deepEqual([w.agg.total, w.agg.sum, w.agg.counts], [1, 1, { 1: 1 }])
  assert.equal(w.agg.ranges.all, undefined)
  assert.equal(w.del('p', ALL), 'not-found')
  assert.equal(w.del('nobody', AB), 'not-found')
})

// ── likes ──────────────────────────────────────────────────────────

test("likes: 'own' across all of a person's entries, set not toggle, liked cleaned", () => {
  const w = world(legacyAgg([3], [oldReview('L1', 3)]), {
    old: { road_id: ROAD, updated_at: 'x', stars: 3, review_id: 'L1' },
  })
  w.save('p', { range: ALL, stars: 4 })
  const stretch = w.save('p', { range: AB, stars: 2, text: 'about one stretch' }).reviewId
  const other = w.save('r', { range: CD, stars: 5, text: 'another stretch' }).reviewId
  assert.equal(w.like('p', stretch, true), 'own')
  assert.equal(w.like('old', 'L1', true), 'own', 'a pre-stretch review is still yours')
  assert.equal(w.like('p', 'nope', true), 'not-found')

  const first = w.like('q', stretch, true)
  assert.deepEqual([first.likes, first.liked, Boolean(first.agg && first.rater)], [1, true, true])
  const again = w.like('q', stretch, true)
  assert.equal(again.agg, undefined, 'already liked: nothing to write')
  assert.equal(w.review(stretch).likes, 1)

  w.like('q', other, true)
  w.del('r', CD)
  w.like('q', 'L1', true)
  assert.deepEqual(w.raters.q.liked, [stretch, 'L1'], 'the deleted review left their list')
  w.like('q', stretch, false)
  assert.equal(w.review(stretch).likes, 0)
  assert.deepEqual(w.raters.q.liked, ['L1'])
})

// ── the property test ──────────────────────────────────────────────

/** Small, fast and seedable, so a failure reproduces exactly. */
function mulberry32(seed) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v)
    for (const x of Object.values(v)) deepFreeze(x)
  }
  return v
}

/** Firestore Admin rejects undefined anywhere in a written document. */
function assertNoUndefined(v, path) {
  if (v === undefined) assert.fail(`undefined at ${path}`)
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) assertNoUndefined(x, `${path}.${k}`)
}

// Written from scratch here rather than imported, so the recount does not share
// a bug with the code it checks.
function entriesOf(doc) {
  if (!doc) return {}
  if (doc.entries) return doc.entries
  const e = {}
  if (typeof doc.stars === 'number' || doc.review_id) {
    e.all = { stars: typeof doc.stars === 'number' ? doc.stars : null }
    if (doc.review_id) e.all.review_id = doc.review_id
  }
  return e
}
function voteOf(entries) {
  if (typeof entries.all?.stars === 'number') return entries.all.stars
  const s = Object.entries(entries).filter(([k, e]) => k !== 'all' && typeof e.stars === 'number').map(([, e]) => e.stars)
  return s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null
}
function addVote(stats, stars) {
  stats.total++
  stats.sum += stars
  stats.counts[stars] = (stats.counts[stars] ?? 0) + 1
}

test('property: 3,000 random writes over old and new documents keep every count exact', () => {
  const rnd = mulberry32(20261020)
  const pick = (list) => list[Math.floor(rnd() * list.length)]
  const KEYS = ['all', 'agra--delhi', 'agra--gwalior', 'delhi--gwalior', 'gwalior--jhansi', 'agra--jhansi', 'delhi--jhansi', 'jhansi--nagpur']
  for (const k of KEYS) assert.equal(canonicalRange(k), k)
  const PEOPLE = ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']
  const OLD = '2025-06-01T00:00:00.000Z'

  // Start from documents written before stretches: 120 people who never come
  // back (90 of them with a review, enough that new reviews force evictions),
  // and six who do, in every old shape — rated and reviewed, rated only,
  // reviewed only, liking, absent.
  const raters = {}
  const reviews = []
  for (let i = 0; i < 120; i++) {
    const stars = 1 + (i % 5)
    raters[`ghost${i}`] = { road_id: ROAD, updated_at: OLD, stars }
    if (i % 4) {
      raters[`ghost${i}`].review_id = `g${i}`
      reviews.push({ id: `g${i}`, text: 'old', stars, likes: (i * 7) % 5, at: `2025-05-01T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z` })
    }
  }
  raters.p0 = { road_id: ROAD, updated_at: OLD, stars: 4, review_id: 'L0' }
  raters.p1 = { road_id: ROAD, updated_at: OLD, stars: 2 }
  raters.p2 = { road_id: ROAD, updated_at: OLD, review_id: 'L2' }
  raters.p3 = { road_id: ROAD, updated_at: OLD, stars: 5, liked: ['g1', 'g2'] }
  raters.p5 = { road_id: ROAD, updated_at: OLD, stars: 1, review_id: 'L5', liked: ['g3', 'gone'] }
  reviews.push(oldReview('L0', 4), oldReview('L2', null, 2), oldReview('L5', 1))
  const votes = Object.values(raters).map((d) => d.stars).filter((s) => typeof s === 'number')
  const s = { agg: legacyAgg(votes, reviews), raters }
  assert.equal(s.agg.ranges, undefined)

  // Likes on old reviews from people outside the six; everything after is theirs.
  const baseLikes = {}
  for (const r of reviews) baseLikes[r.id] = r.likes
  for (const d of Object.values(raters)) for (const id of d.liked ?? []) if (id in baseLikes) baseLikes[id]--
  // Frozen, so a rule that edits a document it was handed throws here.
  deepFreeze(s.agg)
  for (const d of Object.values(s.raters)) deepFreeze(d)

  const seen = { saved: 0, tooMany: 0, edits: 0, evictions: 0, deleted: 0, legacyDeletes: 0, legacySaves: 0, notFound: 0, own: 0, liked: 0, noop: 0 }

  function check(step, touched) {
    const at = (m) => `step ${step}: ${m}`
    const { agg } = s
    const people = Object.values(s.raters).filter(Boolean).map(entriesOf)

    const top = { total: 0, sum: 0, counts: {} }
    const ranges = {}
    for (const e of people) {
      const v = voteOf(e)
      if (v !== null) addVote(top, v)
      for (const [k, x] of Object.entries(e)) {
        if (typeof x.stars === 'number') addVote((ranges[k] ??= { total: 0, sum: 0, counts: {} }), x.stars)
      }
    }
    assert.deepEqual({ total: agg.total, sum: agg.sum, counts: agg.counts }, top, at('headline == recount of person votes'))
    const stored = agg.ranges ?? (agg.total ? { all: { total: agg.total, sum: agg.sum, counts: agg.counts } } : {})
    assert.deepEqual(stored, ranges, at('ranges == recount of entries'))
    assert.ok(Object.keys(stored).length <= MAX_RANGE_KEYS)
    for (const st of [top, ...Object.values(stored)]) {
      for (const n of Object.values(st.counts)) assert.ok(Number.isInteger(n) && n > 0, at('bucket > 0'))
    }
    for (const st of Object.values(stored)) assert.ok(st.total > 0 && st.sum >= st.total && st.sum <= 5 * st.total, at('range sane'))

    const list = agg.reviews ?? []
    assert.ok(list.length <= MAX_REVIEWS, at('review cap'))
    const live = new Set(list.map((r) => r.id))
    assert.equal(live.size, list.length, at('review ids unique'))
    const refs = new Map()
    for (const e of people) {
      for (const [k, x] of Object.entries(e)) {
        if (x.review_id && live.has(x.review_id)) refs.set(x.review_id, [...(refs.get(x.review_id) ?? []), [k, x]])
      }
    }
    for (const r of list) {
      const by = refs.get(r.id) ?? []
      assert.equal(by.length, 1, at(`review ${r.id} has exactly one author entry`))
      const [k, x] = by[0]
      assert.equal(r.stars, x.stars, at(`review ${r.id} stars == entry stars`))
      assert.equal(r.range ?? 'all', k, at(`review ${r.id} sits under its range`))
      const likers = Object.values(s.raters).filter((d) => d?.liked?.includes(r.id)).length
      assert.equal(r.likes, (baseLikes[r.id] ?? 0) + likers, at(`review ${r.id} likes == people who liked it`))
    }

    if (touched) {
      const doc = s.raters[touched]
      assertNoUndefined(doc, touched)
      assertNoUndefined(agg, 'agg')
      assert.ok(agg.ranges, at('a written aggregate always has ranges'))
      assert.ok(doc.entries && !('stars' in doc) && !('review_id' in doc), at('written in the new shape'))
      const e = Object.values(doc.entries)
      assert.ok(e.length <= MAX_ENTRIES_PER_PERSON)
      for (const x of e) {
        assert.ok(x.stars !== null || x.review_id, at('no empty entries'))
        if (x.review_id) assert.ok(live.has(x.review_id), at(`${touched} points only at live reviews`))
      }
      assert.ok(e.filter((x) => x.review_id).length <= MAX_TEXTS_PER_PERSON, at('text cap'))
      for (const id of doc.liked ?? []) assert.ok(live.has(id), at('liked only live reviews'))
      assert.equal(new Set(doc.liked ?? []).size, (doc.liked ?? []).length)
    }
  }

  check(-1, null)
  for (let step = 0; step < 3000; step++) {
    const who = pick(PEOPLE)
    const now = new Date(Date.UTC(2026, 0, 1) + step * 1000).toISOString()
    const me = entriesOf(s.raters[who])
    const live = new Set((s.agg.reviews ?? []).map((r) => r.id))
    const isLive = (x) => Boolean(x?.review_id && live.has(x.review_id))
    const texts = Object.values(me).filter(isLive).length
    const agg = deepFreeze(normaliseAgg(s.agg, ROAD))
    const rater = deepFreeze(normaliseRater(s.raters[who], ROAD))
    let touched = null
    const roll = rnd()

    if (roll < 0.55) {
      const legacy = rnd() < 0.1
      const range = legacy ? ALL : pick(KEYS)
      const t = rnd()
      let text = t < 0.4 ? undefined : t < 0.55 ? '' : `note ${step}`
      let stars = 1 + Math.floor(rnd() * 5)
      if (legacy) {
        // an old page: no stars, always words (see api/reviews.ts)
        stars = typeof me.all?.stars === 'number' ? me.all.stars : null
        text ??= `note ${step}`
      }
      const prev = me[range]
      const expectTooMany =
        (!prev && Object.keys(me).length >= MAX_ENTRIES_PER_PERSON) ||
        (Boolean(text) && !isLive(prev) && texts >= MAX_TEXTS_PER_PERSON)
      const newId = `n${step}`
      const r = applySave(agg, rater, { range, stars, text }, now, newId)
      assert.notEqual(r, 'road-full', `step ${step}: eight keys never fill a road`)
      assert.equal(r === 'too-many', expectTooMany, `step ${step}: too-many exactly when a cap applies`)
      if (r === 'too-many') {
        seen.tooMany++
      } else {
        const after = new Set((r.agg.reviews ?? []).map((x) => x.id))
        for (const id of live) if (!after.has(id) && !(text === '' && id === prev?.review_id)) seen.evictions++
        assert.equal(r.updated, Boolean(prev))
        const entry = entriesOf(r.rater)[range]
        if (stars === null && !r.reviewId) assert.equal(entry, undefined)
        else assert.equal(entry.stars, stars)
        assert.equal(entry?.review_id ?? null, r.reviewId)
        if (text === '') assert.equal(r.reviewId, null)
        else if (text === undefined) assert.equal(r.reviewId, isLive(prev) ? prev.review_id : null)
        else {
          assert.equal(r.reviewId, isLive(prev) ? prev.review_id : newId)
          assert.equal(r.agg.reviews.find((x) => x.id === r.reviewId).text, text)
          if (isLive(prev)) seen.edits++
        }
        if (legacy) seen.legacySaves++
        seen.saved++
        s.agg = deepFreeze(r.agg)
        s.raters[who] = deepFreeze(r.rater)
        touched = who
      }
    } else if (roll < 0.75) {
      const range = rnd() < 0.2 ? undefined : pick(KEYS)
      const prev = me[range ?? ALL]
      const r = applyDelete(agg, rater, range, now)
      assert.equal(r === 'not-found', !prev || (range === undefined && !isLive(prev)), `step ${step}: delete not-found`)
      if (r === 'not-found') {
        seen.notFound++
      } else {
        const e = entriesOf(r.rater)
        if (range === undefined) {
          assert.equal(e.all?.review_id, undefined)
          assert.equal(e.all?.stars ?? null, prev.stars, 'the stars stay')
          seen.legacyDeletes++
        } else {
          assert.equal(e[range], undefined)
        }
        if (prev.review_id) assert.ok(!r.agg.reviews.some((x) => x.id === prev.review_id))
        seen.deleted++
        s.agg = deepFreeze(r.agg)
        s.raters[who] = deepFreeze(r.rater)
        touched = who
      }
    } else {
      const ids = [...live]
      const id = !ids.length || rnd() < 0.05 ? 'nope' : pick(ids)
      const on = rnd() < 0.7
      const r = applyLike(agg, rater, id, on, now)
      if (!live.has(id)) {
        assert.equal(r, 'not-found')
        seen.notFound++
      } else if (Object.values(me).some((x) => x.review_id === id)) {
        assert.equal(r, 'own')
        seen.own++
      } else {
        assert.equal(r.liked, on)
        const had = (s.raters[who]?.liked ?? []).includes(id)
        if (had === on) {
          assert.equal(r.agg, undefined)
          assert.equal(r.rater, undefined)
          seen.noop++
        } else {
          s.agg = deepFreeze(r.agg)
          s.raters[who] = deepFreeze(r.rater)
          touched = who
          seen.liked++
        }
      }
    }
    check(step, touched)
  }

  // Guard against the test going quiet: every path above must have run.
  for (const [k, n] of Object.entries(seen)) assert.ok(n > 0, `never exercised: ${k} (${JSON.stringify(seen)})`)
})
