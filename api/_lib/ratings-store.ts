/**
 * Rating persistence. A deterministic doc id (`${roadId}__${raterKey}`) makes
 * one-rating-per-road-per-person atomic, and the SAME transaction maintains the
 * per-road aggregate so the displayed score can never drift from the ratings
 * behind it.
 *
 * Nothing here stores identity: the rating doc holds only the road, the stars
 * and a timestamp. The rater key lives in the document id, is a salted hash, and
 * is never written as a field or returned to any client.
 */
import type { Firestore } from 'firebase-admin/firestore'

export const RATINGS = 'road_ratings'
export const AGGREGATES = 'road_rating_aggregates'

export interface RatingAggregate {
  road_id: string
  /** stars ("1".."5") → number of people who chose it */
  counts: Record<string, number>
  total: number
  sum: number
  updated_at: string
}

export interface RatingSummary {
  roadId: string
  mean: number
  votes: number
  distribution: Record<string, number>
}

export function emptySummary(roadId: string): RatingSummary {
  return { roadId, mean: 0, votes: 0, distribution: {} }
}

export function toSummary(agg: RatingAggregate | undefined, roadId: string): RatingSummary {
  if (!agg || !agg.total) return emptySummary(roadId)
  return {
    roadId,
    mean: agg.sum / agg.total,
    votes: agg.total,
    distribution: agg.counts ?? {},
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
  const ratingRef = db.collection(RATINGS).doc(`${roadId}__${key}`)
  const aggRef = db.collection(AGGREGATES).doc(roadId)
  const now = new Date().toISOString()

  const { aggregate, updated } = await db.runTransaction(async (tx) => {
    const [ratingSnap, aggSnap] = await Promise.all([tx.get(ratingRef), tx.get(aggRef)])
    const prev = ratingSnap.exists ? (ratingSnap.data()!.stars as number) : null
    const data = (aggSnap.exists ? aggSnap.data() : null) as RatingAggregate | null

    const counts: Record<string, number> = { ...(data?.counts ?? {}) }
    let total = data?.total ?? 0
    let sum = data?.sum ?? 0

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

    const newAgg: RatingAggregate = { road_id: roadId, counts, total, sum, updated_at: now }
    tx.set(ratingRef, { road_id: roadId, stars, updated_at: now }, { merge: true })
    tx.set(aggRef, newAgg)
    return { aggregate: newAgg, updated: prev != null }
  })

  return { summary: toSummary(aggregate, roadId), updated }
}

/** Batch-reads aggregates for up to a few hundred roads in ONE Firestore call,
 *  which is what makes showing ratings in lists and search results affordable —
 *  a per-road aggregate query would be one round trip each. */
export async function getSummaries(db: Firestore, roadIds: string[]): Promise<RatingSummary[]> {
  if (!roadIds.length) return []
  const refs = roadIds.map((id) => db.collection(AGGREGATES).doc(id))
  const snaps = await db.getAll(...refs)
  return snaps.map((snap, i) =>
    toSummary(snap.exists ? (snap.data() as RatingAggregate) : undefined, roadIds[i]),
  )
}
