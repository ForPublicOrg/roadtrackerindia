/**
 * Rating + review persistence. A deterministic doc id (`${roadId}__${raterKey}`)
 * makes one-rating-per-road-per-person atomic, and the SAME transaction
 * maintains the per-road aggregate so the displayed score can never drift from
 * the ratings behind it.
 *
 * Reviews live INSIDE that aggregate document rather than in a collection of
 * their own. A road's whole community verdict — score, distribution, and what
 * people wrote — is then one document read, the read the panel already makes,
 * so showing reviews costs nothing extra per road open. A per-road cap keeps the
 * document small; Firestore's 1 MiB limit is never in sight.
 *
 * Nothing here stores identity: the per-person doc holds the road, the stars, a
 * timestamp, the id of their own review and the ids they liked. The rater key
 * lives in the document id, is a salted hash, and is never written as a field
 * or returned to any client. Review ids are random, so nothing in a review
 * links it to its author or to the same person's reviews elsewhere.
 */
import { randomBytes } from 'node:crypto'
import { FieldValue, type Firestore } from 'firebase-admin/firestore'

export const RATINGS = 'road_ratings'
export const AGGREGATES = 'road_rating_aggregates'

/** Per road. Beyond this the least-liked, oldest review makes way for a new one. */
export const MAX_REVIEWS = 100
export const REVIEW_MAX = 500

export interface ReviewEntry {
  id: string
  text: string
  /** The author's stars, kept in step when they re-rate; null if they never rated. */
  stars: number | null
  likes: number
  at: string
  edited?: string
}

export interface RatingAggregate {
  road_id: string
  /** stars ("1".."5") → number of people who chose it */
  counts: Record<string, number>
  total: number
  sum: number
  updated_at: string
  reviews?: ReviewEntry[]
}

/** `road_ratings/<roadId>__<raterKey>` — everything one person did on one road. */
interface RaterDoc {
  road_id: string
  stars?: number
  updated_at: string
  review_id?: string
  liked?: string[]
}

export interface RatingSummary {
  roadId: string
  mean: number
  votes: number
  distribution: Record<string, number>
  /** Only on single-road reads — a browse list of 100 roads has no use for them. */
  reviews?: ReviewEntry[]
}

const emptyAgg = (roadId: string): RatingAggregate => ({
  road_id: roadId,
  counts: {},
  total: 0,
  sum: 0,
  updated_at: '',
})

export function emptySummary(roadId: string): RatingSummary {
  return toSummary(undefined, roadId)
}

/** Most-liked first, newest breaking ties: the order the client shows, and the
 *  order eviction trims from the end of. */
function sortReviews(list: ReviewEntry[]): ReviewEntry[] {
  return [...list].sort((a, b) => b.likes - a.likes || b.at.localeCompare(a.at))
}

export function toSummary(
  agg: RatingAggregate | undefined,
  roadId: string,
  withReviews = false,
): RatingSummary {
  const total = agg?.total ?? 0
  const s: RatingSummary = {
    roadId,
    mean: total ? agg!.sum / total : 0,
    votes: total,
    distribution: total ? agg?.counts ?? {} : {},
  }
  if (withReviews) s.reviews = sortReviews(agg?.reviews ?? [])
  return s
}

type Pair = { ratingRef: FirebaseFirestore.DocumentReference; aggRef: FirebaseFirestore.DocumentReference }

const refs = (db: Firestore, roadId: string, key: string): Pair => ({
  ratingRef: db.collection(RATINGS).doc(`${roadId}__${key}`),
  aggRef: db.collection(AGGREGATES).doc(roadId),
})

/** Both documents a write touches, read together inside the transaction. */
async function readPair(tx: FirebaseFirestore.Transaction, p: Pair, roadId: string) {
  const [ratingSnap, aggSnap] = await Promise.all([tx.get(p.ratingRef), tx.get(p.aggRef)])
  return {
    mine: (ratingSnap.data() ?? {}) as Partial<RaterDoc>,
    agg: (aggSnap.data() as RatingAggregate | undefined) ?? emptyAgg(roadId),
  }
}

/** Records a rating and returns the road's updated summary. `updated` is true
 *  when this person had already rated the road and changed their mind. */
export async function recordRating(
  db: Firestore,
  roadId: string,
  key: string,
  stars: number,
): Promise<{ summary: RatingSummary; updated: boolean }> {
  const p = refs(db, roadId, key)
  const now = new Date().toISOString()

  const { aggregate, updated } = await db.runTransaction(async (tx) => {
    const { mine, agg } = await readPair(tx, p, roadId)
    const prev = typeof mine.stars === 'number' ? mine.stars : null

    const counts: Record<string, number> = { ...agg.counts }
    let total = agg.total
    let sum = agg.sum

    if (prev != null) {
      // Changing an existing rating moves one vote between buckets — it must not
      // increase the total, or one person could inflate a road's rating count by
      // re-rating it repeatedly.
      counts[prev] = Math.max(0, (counts[prev] ?? 0) - 1)
      sum -= prev
    } else {
      total += 1
    }
    counts[stars] = (counts[stars] ?? 0) + 1
    sum += stars

    const newAgg: RatingAggregate = { ...agg, counts, total, sum, updated_at: now }
    // Their review shows the stars they gave — keep it in step with a re-rate.
    if (agg.reviews && mine.review_id) {
      newAgg.reviews = agg.reviews.map((r) => (r.id === mine.review_id ? { ...r, stars } : r))
    }
    tx.set(p.ratingRef, { road_id: roadId, stars, updated_at: now }, { merge: true })
    tx.set(p.aggRef, newAgg)
    return { aggregate: newAgg, updated: prev != null }
  })

  return { summary: toSummary(aggregate, roadId, true), updated }
}

/** Writes, or replaces, this person's one review of the road. The id comes back
 *  so the browser can remember which review is theirs — the server never will. */
export async function saveReview(
  db: Firestore,
  roadId: string,
  key: string,
  text: string,
): Promise<{ summary: RatingSummary; reviewId: string }> {
  const p = refs(db, roadId, key)
  const now = new Date().toISOString()

  const { aggregate, id } = await db.runTransaction(async (tx) => {
    const { mine, agg } = await readPair(tx, p, roadId)
    const stars = typeof mine.stars === 'number' ? mine.stars : null
    let reviews = agg.reviews ?? []
    let id = mine.review_id ?? ''

    if (id && reviews.some((r) => r.id === id)) {
      reviews = reviews.map((r) => (r.id === id ? { ...r, text, stars, edited: now } : r))
    } else {
      // A full road drops its least-liked, oldest review to make room. Its
      // author's pointer then dangles harmlessly: editing simply writes anew.
      if (reviews.length >= MAX_REVIEWS) reviews = sortReviews(reviews).slice(0, MAX_REVIEWS - 1)
      id = randomBytes(6).toString('base64url')
      reviews = [...reviews, { id, text, stars, likes: 0, at: now }]
    }

    const newAgg: RatingAggregate = { ...agg, reviews, updated_at: now }
    tx.set(p.ratingRef, { road_id: roadId, review_id: id, updated_at: now }, { merge: true })
    tx.set(p.aggRef, newAgg)
    return { aggregate: newAgg, id }
  })

  return { summary: toSummary(aggregate, roadId, true), reviewId: id }
}

/** Removes this person's review. Null when they have none to remove. */
export async function deleteReview(
  db: Firestore,
  roadId: string,
  key: string,
): Promise<RatingSummary | null> {
  const p = refs(db, roadId, key)
  const now = new Date().toISOString()

  const aggregate = await db.runTransaction(async (tx) => {
    const { mine, agg } = await readPair(tx, p, roadId)
    const id = mine.review_id
    if (!id || !agg.reviews?.some((r) => r.id === id)) return null
    const newAgg: RatingAggregate = {
      ...agg,
      reviews: agg.reviews.filter((r) => r.id !== id),
      updated_at: now,
    }
    tx.set(p.ratingRef, { review_id: FieldValue.delete(), updated_at: now }, { merge: true })
    tx.set(p.aggRef, newAgg)
    return newAgg
  })

  return aggregate ? toSummary(aggregate, roadId, true) : null
}

export type LikeResult = { likes: number; liked: boolean } | 'not-found' | 'own'

/** Sets (not toggles) whether this person finds a review helpful. Idempotent, so
 *  a browser that has forgotten its own likes converges on the server's truth
 *  instead of flipping it blind. */
export async function setReviewLike(
  db: Firestore,
  roadId: string,
  key: string,
  id: string,
  on: boolean,
): Promise<LikeResult> {
  const p = refs(db, roadId, key)

  return db.runTransaction(async (tx): Promise<LikeResult> => {
    const { mine, agg } = await readPair(tx, p, roadId)
    const reviews = agg.reviews ?? []
    const target = reviews.find((r) => r.id === id)
    if (!target) return 'not-found'
    if (mine.review_id === id) return 'own'

    const liked = new Set(mine.liked ?? [])
    if (liked.has(id) === on) return { likes: target.likes, liked: on }

    if (on) liked.add(id)
    else liked.delete(id)
    const likes = Math.max(0, target.likes + (on ? 1 : -1))
    const now = new Date().toISOString()
    const live = new Set(reviews.map((r) => r.id))
    tx.set(
      p.ratingRef,
      // ids of reviews since evicted or deleted would otherwise linger forever
      { road_id: roadId, liked: [...liked].filter((x) => live.has(x)), updated_at: now },
      { merge: true },
    )
    tx.set(p.aggRef, {
      ...agg,
      reviews: reviews.map((r) => (r.id === id ? { ...r, likes } : r)),
      updated_at: now,
    })
    return { likes, liked: on }
  })
}

/** Batch-reads aggregates for up to a few hundred roads in ONE Firestore call,
 *  which is what makes showing ratings in lists and search results affordable —
 *  a per-road aggregate query would be one round trip each. */
export async function getSummaries(
  db: Firestore,
  roadIds: string[],
  withReviews = false,
): Promise<RatingSummary[]> {
  if (!roadIds.length) return []
  const refs = roadIds.map((id) => db.collection(AGGREGATES).doc(id))
  const snaps = await db.getAll(...refs)
  return snaps.map((snap, i) =>
    toSummary(snap.exists ? (snap.data() as RatingAggregate) : undefined, roadIds[i], withReviews),
  )
}
