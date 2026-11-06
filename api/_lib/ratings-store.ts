/**
 * Rating + review persistence. A deterministic doc id (`${roadId}__${raterKey}`)
 * makes "one entry per person per range of a road" atomic, and the SAME
 * transaction maintains the per-road aggregate so the displayed score can never
 * drift from the ratings behind it. The rules for what a write does to the two
 * documents live in ratings-math.ts, where they are tested without Firestore;
 * this file only reads, applies and writes.
 *
 * Every write sets BOTH documents whole, never merged. A document from before
 * stretches is normalised on read, so the first write after the change rewrites
 * it in the new shape and its old fields simply go — no migration script.
 *
 * Reviews live INSIDE the aggregate document rather than in a collection of
 * their own. A road's whole community verdict — score, stretch scores, and what
 * people wrote — is then one document read, the read the panel already makes,
 * so showing reviews costs nothing extra per road open. Per-road caps keep the
 * document small; Firestore's 1 MiB limit is never in sight.
 *
 * Nothing here stores identity: the per-person doc holds the road, their entries
 * (stars per range, and the id of the review that goes with each), a timestamp
 * and the ids they liked. The rater key lives in the document id, is a salted
 * hash, and is never written as a field or returned to any client. Review ids
 * are random, so nothing in a review links it to its author or to the same
 * person's reviews elsewhere.
 */
import { randomBytes } from 'node:crypto'
import type { Firestore } from 'firebase-admin/firestore'
import {
  applyDelete,
  applyLike,
  applySave,
  normaliseAgg,
  normaliseRater,
  sortReviews,
  writtenByOldCode,
  type RangeStats,
  type RatingAggregate,
  type RaterDoc,
  type ReviewEntry,
  type SaveRefusal,
} from './ratings-math.js'

export const RATINGS = 'road_ratings'
export const AGGREGATES = 'road_rating_aggregates'

export interface RatingSummary {
  roadId: string
  /** One vote per person: see personVote() in ratings-math.ts. */
  mean: number
  votes: number
  distribution: Record<string, number>
  /** Only on single-road reads — a browse list of 100 roads has no use for them. */
  reviews?: ReviewEntry[]
  ranges?: Record<string, RangeStats>
}

export function emptySummary(roadId: string): RatingSummary {
  return toSummary(undefined, roadId)
}

export function toSummary(
  agg: RatingAggregate | undefined,
  roadId: string,
  withReviews = false,
): RatingSummary {
  const a = normaliseAgg(agg, roadId)
  const s: RatingSummary = {
    roadId,
    mean: a.total ? a.sum / a.total : 0,
    votes: a.total,
    distribution: a.total ? a.counts : {},
  }
  if (withReviews) {
    s.reviews = sortReviews(a.reviews ?? [])
    s.ranges = a.ranges ?? {}
  }
  return s
}

type Pair = { ratingRef: FirebaseFirestore.DocumentReference; aggRef: FirebaseFirestore.DocumentReference }

const refs = (db: Firestore, roadId: string, key: string): Pair => ({
  ratingRef: db.collection(RATINGS).doc(`${roadId}__${key}`),
  aggRef: db.collection(AGGREGATES).doc(roadId),
})

/** Both documents a write touches, read together inside the transaction and
 *  normalised, so the rules never see the pre-stretch shape. */
async function readPair(tx: FirebaseFirestore.Transaction, p: Pair, roadId: string) {
  const [ratingSnap, aggSnap] = await Promise.all([tx.get(p.ratingRef), tx.get(p.aggRef)])
  const raw = ratingSnap.data() as Partial<RaterDoc> | undefined
  // The road only, never the doc id: that carries the rater hash.
  if (writtenByOldCode(raw)) {
    console.error(
      `[ratings] ${roadId}: a rater doc was written by code from before stretches ` +
        '(a rollback, or a preview on this database). The headline may now hold a ' +
        'vote, or the reviews a review, that no rater doc backs — see docs/FIREBASE.md',
    )
  }
  return {
    mine: normaliseRater(raw, roadId),
    agg: normaliseAgg(aggSnap.data() as RatingAggregate | undefined, roadId),
  }
}

export interface EntryInput {
  range: string
  /** undefined: keep whatever stars the person already has for this range (or
   *  none) — what a page from before stretches means when it posts only text. */
  stars?: number
  /** undefined keeps any review text, '' removes it, anything else writes it */
  text?: string
}

export interface SavedEntry {
  summary: RatingSummary
  updated: boolean
  range: string
  stars: number | null
  /** The browser remembers this to know which review is theirs — the server never will. */
  reviewId: string | null
}

/** Writes, or replaces, this person's entry for one range of the road.
 *  'too-many' when it would break one of their own caps, 'road-full' when the
 *  road can take no new range key. */
export async function saveEntry(
  db: Firestore,
  roadId: string,
  key: string,
  input: EntryInput,
): Promise<SavedEntry | SaveRefusal> {
  const p = refs(db, roadId, key)
  const now = new Date().toISOString()
  // Random, so nothing in a review links it to its author. Drawn outside the
  // transaction, so a retried attempt reuses it — harmless, since a failed
  // attempt wrote nothing.
  const newId = randomBytes(6).toString('base64url')

  const out = await db.runTransaction(async (tx) => {
    const { mine, agg } = await readPair(tx, p, roadId)
    const stars = input.stars ?? mine.entries[input.range]?.stars ?? null
    const r = applySave(agg, mine, { range: input.range, stars, text: input.text }, now, newId)
    if (typeof r === 'string') return r
    tx.set(p.ratingRef, r.rater)
    tx.set(p.aggRef, r.agg)
    return r
  })
  if (typeof out === 'string') return out

  return {
    summary: toSummary(out.agg, roadId, true),
    updated: out.updated,
    range: input.range,
    stars: out.rater.entries?.[input.range]?.stars ?? null,
    reviewId: out.reviewId,
  }
}

/** Removes this person's entry for `range`; with no range, only the text of
 *  their whole-road review (an old page's delete). Null when there is nothing to remove. */
export async function deleteEntry(
  db: Firestore,
  roadId: string,
  key: string,
  range: string | undefined,
): Promise<RatingSummary | null> {
  const p = refs(db, roadId, key)
  const now = new Date().toISOString()

  const aggregate = await db.runTransaction(async (tx) => {
    const { mine, agg } = await readPair(tx, p, roadId)
    const r = applyDelete(agg, mine, range, now)
    if (r === 'not-found') return null
    tx.set(p.ratingRef, r.rater)
    tx.set(p.aggRef, r.agg)
    return r.agg
  })

  return aggregate ? toSummary(aggregate, roadId, true) : null
}

export type LikeResult = { likes: number; liked: boolean } | 'not-found' | 'own'

/** Sets (not toggles) whether this person finds a review helpful. */
export async function setReviewLike(
  db: Firestore,
  roadId: string,
  key: string,
  id: string,
  on: boolean,
): Promise<LikeResult> {
  const p = refs(db, roadId, key)
  const now = new Date().toISOString()

  return db.runTransaction(async (tx): Promise<LikeResult> => {
    const { mine, agg } = await readPair(tx, p, roadId)
    const r = applyLike(agg, mine, id, on, now)
    if (typeof r === 'string') return r
    // No documents back means it was already as asked: nothing to write.
    if (r.agg && r.rater) {
      tx.set(p.ratingRef, r.rater)
      tx.set(p.aggRef, r.agg)
    }
    return { likes: r.likes, liked: r.liked }
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
