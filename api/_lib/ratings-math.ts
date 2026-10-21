/**
 * The rules behind ratings and reviews, with no Firestore in sight. Each write
 * takes the two documents it touches — the road's aggregate and one person's
 * rater doc — and returns what both should become; ratings-store.ts wraps that
 * in a transaction and writes both back whole.
 *
 * What a person holds on a road is a set of ENTRIES, one per range: stars for a
 * stretch between two stops, for a run of consecutive stretches, or for `all`
 * of it, plus an optional review. The road's headline counts each PERSON once —
 * their whole-road stars if they gave some, else the rounded mean of their
 * stretch stars — so rating six stretches does not weigh six times in the
 * road's score. `ranges` counts entries, which is what colours each stretch.
 *
 * Deliberately import-free and plain TypeScript (no enums, no namespaces, no
 * parameter properties): scripts/ratings-math.test.mjs loads this very file
 * under Node's type stripping, so the tests check the code that ships rather
 * than a copy that could drift.
 */

export const ALL = 'all'
/** `all`, or two stop slugs joined by `--`. Mirrored in src/stretches.ts, and
 *  scripts/contracts.test.mjs holds the two in step. */
export const RANGE_KEY = /^(?:all|[a-z0-9]+(?:-[a-z0-9]+)*--[a-z0-9]+(?:-[a-z0-9]+)*)$/
const RANGE_KEY_MAX = 90

/** Per road. Beyond this the least-liked, oldest review makes way for a new one. */
export const MAX_REVIEWS = 100
export const REVIEW_MAX = 500
/** Per road. The server cannot check a slug against the road's stops, so this
 *  is what stops made-up range keys growing the aggregate without bound. One
 *  build's 17 stops make at most 136 keys, `all` among them; the rest is room
 *  for stops that later builds dropped. Whoever hits it did nothing to fill it,
 *  so it answers 'road-full', not 'too-many'. */
export const MAX_RANGE_KEYS = 200
/** Per person per road — more than any real trip needs, few enough that one
 *  person cannot bloat a road's documents. */
export const MAX_ENTRIES_PER_PERSON = 20
export const MAX_TEXTS_PER_PERSON = 5
/** Star-only writes an hour, per coarse IP (a /24 or /48 — on mobile CGNAT,
 *  many people), across every road; /api/reviews and /api/ratings share it.
 *  Each stretch is its own write, so one person rating NH 44's 16 stretches and
 *  fixing a few taps is past 20 — a budget that small would lock their whole
 *  prefix out of rating anything for an hour. Dedupe and MAX_ENTRIES_PER_PERSON
 *  already bound what one person does to one road; this bounds how fast a
 *  prefix writes at all. */
export const RATINGS_PER_HOUR = 100

/** Why a save wrote nothing: 'too-many' is one of the person's own caps (they
 *  can edit or delete one of theirs), 'road-full' is the road's. */
export type SaveRefusal = 'too-many' | 'road-full'

export interface RangeStats {
  total: number
  sum: number
  /** stars ("1".."5") → number of votes; a bucket that empties is removed */
  counts: Record<string, number>
}

export interface ReviewEntry {
  id: string
  text: string
  /** The author's stars for this range, kept in step when they re-rate; null if they never rated. */
  stars: number | null
  likes: number
  at: string
  edited?: string
  /** Absent on reviews written before stretches existed, which were all whole-road. */
  range?: string
}

export interface RatingAggregate {
  road_id: string
  /** The headline: one vote per person. */
  counts: Record<string, number>
  total: number
  sum: number
  updated_at: string
  reviews?: ReviewEntry[]
  /** range key → that range's votes, one per entry. */
  ranges?: Record<string, RangeStats>
}

export interface RaterEntry {
  /** null only for an old whole-road review its author never rated */
  stars: number | null
  review_id?: string
}

/** `road_ratings/<roadId>__<raterKey>` — everything one person did on one road.
 *  `stars` and `review_id` are the pre-stretch shape, read but never written. */
export interface RaterDoc {
  road_id: string
  updated_at: string
  liked?: string[]
  entries?: Record<string, RaterEntry>
  stars?: number
  review_id?: string
}

/** A rater doc as the write rules see it: old fields folded into `entries`. */
export interface NormalRater {
  road_id: string
  liked: string[]
  entries: Record<string, RaterEntry>
}

export interface SaveInput {
  range: string
  stars: number | null
  /** undefined keeps any review text, '' removes it, anything else writes it */
  text?: string
}

export interface SaveOutcome {
  agg: RatingAggregate
  rater: RaterDoc
  reviewId: string | null
  /** true when this person already had an entry for this range */
  updated: boolean
}

export interface DeleteOutcome {
  agg: RatingAggregate
  rater: RaterDoc
}

/** agg and rater are absent when nothing changed, and there is nothing to write. */
export interface LikeOutcome {
  agg?: RatingAggregate
  rater?: RaterDoc
  likes: number
  liked: boolean
}

/** The one spelling of a range: `agra--delhi` and `delhi--agra` are the same
 *  road, so they must be the same key, or one stretch would split its votes. */
export function canonicalRange(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length > RANGE_KEY_MAX || !RANGE_KEY.test(raw)) return null
  if (raw === ALL) return ALL
  const [a, b] = raw.split('--')
  if (a === b) return null
  return [a, b].sort().join('--')
}

const entry = (stars: number | null, reviewId?: string): RaterEntry =>
  reviewId ? { stars, review_id: reviewId } : { stars }

/** Copies counts without empty buckets. Negative ones are kept: they would be a
 *  bug, and hiding it here would only stop the tests seeing it. */
function cleanCounts(counts: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, n] of Object.entries(counts ?? {})) if (n) out[k] = n
  return out
}

/** A full working copy, safe to change. Aggregates from before stretches have
 *  no `ranges`; every vote in them was whole-road, so that is where they go. */
export function normaliseAgg(agg: RatingAggregate | undefined, roadId: string): RatingAggregate {
  const total = agg?.total ?? 0
  const sum = agg?.sum ?? 0
  const counts = cleanCounts(agg?.counts)
  const ranges: Record<string, RangeStats> = {}
  if (agg?.ranges) {
    for (const [k, s] of Object.entries(agg.ranges)) {
      ranges[k] = { total: s.total, sum: s.sum, counts: cleanCounts(s.counts) }
    }
  } else if (total) {
    ranges[ALL] = { total, sum, counts: { ...counts } }
  }
  return {
    road_id: roadId,
    counts,
    total,
    sum,
    updated_at: agg?.updated_at ?? '',
    reviews: (agg?.reviews ?? []).map((r) => ({ ...r })),
    ranges,
  }
}

/** Before stretches a person had one rating and one review per road: that is
 *  their whole-road entry now. Once `entries` exists the old fields mean nothing
 *  (the next write drops them). */
export function normaliseRater(doc: Partial<RaterDoc> | undefined, roadId: string): NormalRater {
  const liked = [...new Set((doc?.liked ?? []).filter((x) => typeof x === 'string'))]
  const entries: Record<string, RaterEntry> = {}
  if (doc?.entries) {
    for (const [k, e] of Object.entries(doc.entries)) {
      entries[k] = entry(typeof e.stars === 'number' ? e.stars : null, e.review_id)
    }
  } else {
    const stars = typeof doc?.stars === 'number' ? doc.stars : null
    if (stars !== null || doc?.review_id) entries[ALL] = entry(stars, doc?.review_id)
  }
  return { road_id: roadId, liked, entries }
}

/** A rater doc holding `entries` AND a pre-stretch field. This code sets the doc
 *  whole, so it never leaves both; only code from before stretches merging into
 *  a new doc does — a rollback, or a preview on the same database. That write
 *  counted the person as a new rater (or their text as a new review), and
 *  normaliseRater cannot undo it: the headline keeps a vote no rater doc backs.
 *  Worth a loud log, since nothing else would ever show it. */
export function writtenByOldCode(doc: Partial<RaterDoc> | undefined): boolean {
  return Boolean(doc?.entries) && (doc?.stars !== undefined || doc?.review_id !== undefined)
}

/** The one vote a person casts in the road's headline. A whole-road rating says
 *  what they think of the road; without one, their stretches are the best guess. */
export function personVote(entries: Record<string, RaterEntry>): number | null {
  const whole = entries[ALL]?.stars
  if (typeof whole === 'number') return whole
  let n = 0
  let sum = 0
  for (const [k, e] of Object.entries(entries)) {
    if (k !== ALL && typeof e.stars === 'number') {
      n++
      sum += e.stars
    }
  }
  return n ? Math.round(sum / n) : null
}

/** Most-liked first, newest breaking ties: the order the client shows, and the
 *  order eviction trims from the end of. */
export function sortReviews(list: ReviewEntry[]): ReviewEntry[] {
  return [...list].sort((a, b) => b.likes - a.likes || b.at.localeCompare(a.at))
}

function bump(s: RangeStats, stars: number, by: 1 | -1): void {
  const k = String(stars)
  const n = (s.counts[k] ?? 0) + by
  if (n) s.counts[k] = n
  else delete s.counts[k]
  s.total += by
  s.sum += by * stars
}

/** Moves one vote from `prev` stars to `next`; a null side means add or remove.
 *  Changing a vote must never change the total, or re-rating would inflate it. */
function moveVote(s: RangeStats, prev: number | null, next: number | null): void {
  if (prev === next) return
  if (prev !== null) bump(s, prev, -1)
  if (next !== null) bump(s, next, 1)
}

function moveRange(
  ranges: Record<string, RangeStats>,
  key: string,
  prev: number | null,
  next: number | null,
): void {
  if (prev === next) return
  const s = ranges[key] ?? { total: 0, sum: 0, counts: {} }
  moveVote(s, prev, next)
  // An empty range is dropped rather than kept at zero, so a road's key count
  // (and MAX_RANGE_KEYS) reflects ranges somebody actually holds.
  if (s.total) ranges[key] = s
  else delete ranges[key]
}

type Written = { agg: RatingAggregate; rater: RaterDoc; entries: Record<string, RaterEntry> }

/** The tail every write shares. Drops pointers to reviews that are gone
 *  (evicted, or deleted) and entries left holding nothing, then moves this
 *  person's one headline vote from what it was to what it now is. `agg` must be
 *  a working copy; `rater` is the person as they were before this write. */
function commit(
  agg: RatingAggregate,
  rater: NormalRater,
  entries: Record<string, RaterEntry>,
  now: string,
): Written {
  const live = new Set((agg.reviews ?? []).map((r) => r.id))
  const kept: Record<string, RaterEntry> = {}
  for (const [k, e] of Object.entries(entries)) {
    const id = e.review_id && live.has(e.review_id) ? e.review_id : undefined
    if (e.stars !== null || id) kept[k] = entry(e.stars, id)
  }

  const top: RangeStats = { total: agg.total, sum: agg.sum, counts: agg.counts }
  moveVote(top, personVote(rater.entries), personVote(kept))

  // ids of reviews since evicted or deleted would otherwise linger forever
  const liked = rater.liked.filter((id) => live.has(id))
  const doc: RaterDoc = { road_id: rater.road_id, updated_at: now, entries: kept }
  if (liked.length) doc.liked = liked
  return {
    agg: { ...agg, counts: top.counts, total: top.total, sum: top.sum, updated_at: now },
    rater: doc,
    entries: kept,
  }
}

const liveReview = (agg: RatingAggregate, e: RaterEntry | undefined): string | null =>
  e?.review_id && (agg.reviews ?? []).some((r) => r.id === e.review_id) ? e.review_id : null

/** Writes, or replaces, this person's entry for one range. */
export function applySave(
  agg0: RatingAggregate,
  rater: NormalRater,
  input: SaveInput,
  now: string,
  newId: string,
): SaveOutcome | SaveRefusal {
  const { range, stars, text } = input
  const agg = normaliseAgg(agg0, agg0.road_id)
  const ranges = agg.ranges ?? {}
  let reviews = agg.reviews ?? []
  const prev = rater.entries[range]
  const liveId = liveReview(agg, prev)

  if (!prev) {
    // Their own cap first: it is the one they can do something about.
    if (Object.keys(rater.entries).length >= MAX_ENTRIES_PER_PERSON) return 'too-many'
    if (range !== ALL && !ranges[range] && Object.keys(ranges).length >= MAX_RANGE_KEYS) {
      return 'road-full'
    }
  }
  if (text && !liveId) {
    let texts = 0
    for (const e of Object.values(rater.entries)) if (liveReview(agg, e)) texts++
    if (texts >= MAX_TEXTS_PER_PERSON) return 'too-many'
  }

  moveRange(ranges, range, prev?.stars ?? null, stars)

  let reviewId = liveId
  if (text === undefined) {
    // Their review shows the stars they gave — keep it in step with a re-rate.
    if (liveId) reviews = reviews.map((r) => (r.id === liveId ? { ...r, stars } : r))
  } else if (!text) {
    if (liveId) reviews = reviews.filter((r) => r.id !== liveId)
    reviewId = null
  } else if (liveId) {
    reviews = reviews.map((r) =>
      r.id === liveId ? { ...r, text, stars, range, edited: now } : r,
    )
  } else {
    // A full road drops its least-liked, oldest review to make room. Its
    // author's pointer then dangles until their next write here clears it.
    if (reviews.length >= MAX_REVIEWS) reviews = sortReviews(reviews).slice(0, MAX_REVIEWS - 1)
    reviews = [...reviews, { id: newId, text, stars, likes: 0, at: now, range }]
    reviewId = newId
  }

  const entries = { ...rater.entries, [range]: entry(stars, reviewId ?? undefined) }
  const out = commit({ ...agg, ranges, reviews }, rater, entries, now)
  return {
    agg: out.agg,
    rater: out.rater,
    reviewId: out.entries[range]?.review_id ?? null,
    updated: Boolean(prev),
  }
}

/** Removes this person's entry for `range`, stars and review together. With no
 *  range it is a page from before stretches asking to remove "my review": only
 *  the whole-road text goes, the stars stay. */
export function applyDelete(
  agg0: RatingAggregate,
  rater: NormalRater,
  range: string | undefined,
  now: string,
): DeleteOutcome | 'not-found' {
  const agg = normaliseAgg(agg0, agg0.road_id)
  const ranges = agg.ranges ?? {}
  let reviews = agg.reviews ?? []
  const key = range ?? ALL
  const prev = rater.entries[key]
  if (!prev) return 'not-found'
  const liveId = liveReview(agg, prev)

  const entries = { ...rater.entries }
  if (range === undefined) {
    if (!liveId) return 'not-found'
    entries[ALL] = entry(prev.stars)
  } else {
    delete entries[key]
    moveRange(ranges, key, prev.stars, null)
  }
  if (liveId) reviews = reviews.filter((r) => r.id !== liveId)

  const out = commit({ ...agg, ranges, reviews }, rater, entries, now)
  return { agg: out.agg, rater: out.rater }
}

/** Sets (not toggles) whether this person finds a review helpful. Idempotent, so
 *  a browser that has forgotten its own likes converges on the server's truth
 *  instead of flipping it blind. */
export function applyLike(
  agg0: RatingAggregate,
  rater: NormalRater,
  id: string,
  on: boolean,
  now: string,
): LikeOutcome | 'not-found' | 'own' {
  const target = (agg0.reviews ?? []).find((r) => r.id === id)
  if (!target) return 'not-found'
  if (Object.values(rater.entries).some((e) => e.review_id === id)) return 'own'
  if (rater.liked.includes(id) === on) return { likes: target.likes, liked: on }

  const agg = normaliseAgg(agg0, agg0.road_id)
  const likes = Math.max(0, target.likes + (on ? 1 : -1))
  const liked = on ? [...rater.liked, id] : rater.liked.filter((x) => x !== id)
  const reviews = (agg.reviews ?? []).map((r) => (r.id === id ? { ...r, likes } : r))
  const out = commit({ ...agg, reviews }, { ...rater, liked }, rater.entries, now)
  return { agg: out.agg, rater: out.rater, likes, liked: on }
}
