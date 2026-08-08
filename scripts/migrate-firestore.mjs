/**
 * One-time migration to the server-side, identity-free schema.
 *
 * Why it is needed:
 *  - Reports were written by the browser as {roadId, createdAt, uid, fixedBy}.
 *    The API queries `road_id`, so without this every existing report becomes
 *    invisible — and the `uid` next to each report's GPS coordinates is exactly
 *    the tracking we set out to remove.
 *  - The old `ratings` collection keyed documents by anonymous uid. Those keys
 *    cannot be re-derived under the new salted (IP + fingerprint) scheme, so
 *    per-person dedupe cannot be carried across. The stars themselves still
 *    count, so they are folded into the aggregates and the old docs dropped.
 *
 * Usage (dry run prints what it WOULD do and changes nothing):
 *   node scripts/migrate-firestore.mjs
 *   node scripts/migrate-firestore.mjs --apply
 *
 * Credentials: set FIREBASE_SERVICE_ACCOUNT_JSON (the same value as on Vercel)
 * or GOOGLE_APPLICATION_CREDENTIALS pointing at the key file.
 */
import { cert, applicationDefault, initializeApp } from 'firebase-admin/app'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

const APPLY = process.argv.includes('--apply')

function init() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (raw) {
    const svc = JSON.parse(raw)
    if (typeof svc.private_key === 'string') svc.private_key = svc.private_key.replace(/\\n/g, '\n')
    return initializeApp({ credential: cert(svc), projectId: svc.project_id })
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return initializeApp({ credential: applicationDefault() })
  }
  console.error(
    'No credentials. Set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.',
  )
  process.exit(1)
}

const db = getFirestore(init())
const iso = (v) => {
  if (!v) return new Date().toISOString()
  if (typeof v?.toDate === 'function') return v.toDate().toISOString()
  if (typeof v === 'number') return new Date(v).toISOString()
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return v
  return new Date().toISOString()
}

async function migrateReports() {
  const snap = await db.collection('reports').get()
  let touched = 0
  let cleared = 0
  for (const doc of snap.docs) {
    const v = doc.data()
    const isOld = v.roadId !== undefined || v.uid !== undefined || v.fixedBy !== undefined
    if (!isOld) continue
    touched++
    if (v.uid !== undefined) cleared++
    const next = {
      road_id: v.road_id ?? v.roadId,
      type: v.type,
      lng: v.lng,
      lat: v.lat,
      note: v.note ?? '',
      created_at: v.created_at ?? iso(v.createdAt),
      // Reports the community had already voted "fixed" three times were hidden
      // in the old UI — preserve that, don't resurrect them.
      deleted: v.deleted ?? (Array.isArray(v.fixedBy) && v.fixedBy.length >= 3),
      roadId: FieldValue.delete(),
      createdAt: FieldValue.delete(),
      uid: FieldValue.delete(),
      fixedBy: FieldValue.delete(),
    }
    if (APPLY) await doc.ref.set(next, { merge: true })
  }
  console.log(
    `reports: ${snap.size} total, ${touched} to migrate, ${cleared} carrying a uid to strip`,
  )
}

async function migrateRatings() {
  const snap = await db.collection('ratings').get()
  if (snap.empty) return console.log('ratings: none found (nothing to fold in)')

  const byRoad = new Map()
  for (const doc of snap.docs) {
    const v = doc.data()
    const roadId = v.roadId ?? v.road_id
    const stars = Number(v.stars)
    if (!roadId || !Number.isInteger(stars) || stars < 1 || stars > 5) continue
    const agg = byRoad.get(roadId) ?? { counts: {}, total: 0, sum: 0 }
    agg.counts[stars] = (agg.counts[stars] ?? 0) + 1
    agg.total++
    agg.sum += stars
    byRoad.set(roadId, agg)
  }

  console.log(
    `ratings: ${snap.size} old docs → ${byRoad.size} road aggregates ` +
      `(per-person dedupe cannot carry over; these become uncontested history)`,
  )
  if (!APPLY) return

  const now = new Date().toISOString()
  for (const [roadId, agg] of byRoad) {
    const ref = db.collection('road_rating_aggregates').doc(roadId)
    await db.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data()
      const counts = { ...(cur?.counts ?? {}) }
      for (const [k, n] of Object.entries(agg.counts)) counts[k] = (counts[k] ?? 0) + n
      tx.set(ref, {
        road_id: roadId,
        counts,
        total: (cur?.total ?? 0) + agg.total,
        sum: (cur?.sum ?? 0) + agg.sum,
        updated_at: now,
      })
    })
  }
  // The old docs carry a uid in their document id — delete them, that is the point.
  for (const doc of snap.docs) await doc.ref.delete()
  console.log('ratings: old uid-keyed documents deleted')
}

await migrateReports()
await migrateRatings()
console.log(
  APPLY ? '\nMigration applied.' : '\nDry run — nothing changed. Re-run with --apply to commit.',
)
