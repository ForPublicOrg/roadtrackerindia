/**
 * Report persistence.
 *
 * Two deliberate departures from the old client-direct design:
 *
 *  - NO AUTHOR IDENTITY. Reports used to carry the reporter's anonymous uid so
 *    the rules could enforce "only you may delete your report". Anyone may now
 *    delete, so the uid has no remaining purpose — and storing a stable id next
 *    to GPS coordinates was the sharpest privacy edge in the old schema.
 *
 *  - DELETES ARE SOFT. Unrestricted delete means one person could otherwise wipe
 *    every report on the site with a loop. A `deleted` flag hides the report
 *    everywhere while leaving it recoverable from the Firebase console.
 */
import type { Firestore } from 'firebase-admin/firestore'

export const REPORTS = 'reports'

export const REPORT_TYPES = ['pothole', 'damage', 'flooding'] as const
export type ReportType = (typeof REPORT_TYPES)[number]

export interface ReportDoc {
  road_id: string
  type: ReportType
  lng: number
  lat: number
  note: string
  created_at: string
  deleted?: boolean
  deleted_at?: string
}

export interface ReportOut {
  id: string
  roadId: string
  type: ReportType
  lng: number
  lat: number
  note: string
  createdAt: number
}

export interface NewReport {
  roadId: string
  type: ReportType
  lng: number
  lat: number
  note: string
}

export async function addReport(db: Firestore, r: NewReport): Promise<ReportOut> {
  const now = new Date().toISOString()
  const doc: ReportDoc = {
    road_id: r.roadId,
    type: r.type,
    lng: r.lng,
    lat: r.lat,
    note: r.note,
    created_at: now,
    deleted: false,
  }
  const ref = await db.collection(REPORTS).add(doc)
  return { id: ref.id, ...r, createdAt: Date.parse(now) }
}

/** A malformed created_at (hand-edited in the console) must not crash the list. */
function millis(iso: string | undefined): number {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : Date.now()
}

/** Deliberately a single equality filter with no orderBy: that combination is
 *  served by Firestore's automatic single-field index, so deploying this needs
 *  no composite index to be created by hand. Filtering `deleted` and sorting
 *  happen here instead — at 200 docs per road that is far cheaper than the
 *  operational cost of a manual index step. */
export async function listReports(db: Firestore, roadId: string): Promise<ReportOut[]> {
  const snap = await db.collection(REPORTS).where('road_id', '==', roadId).limit(200).get()
  const items: ReportOut[] = []
  snap.forEach((d) => {
    const v = d.data() as ReportDoc
    if (v.deleted) return
    items.push({
      id: d.id,
      roadId: v.road_id,
      type: v.type,
      lng: v.lng,
      lat: v.lat,
      note: v.note ?? '',
      createdAt: millis(v.created_at),
    })
  })
  return items.sort((a, b) => b.createdAt - a.createdAt).slice(0, 150)
}

/** Resolves specific reports by id. This is how a visitor still sees the pins
 *  they dropped on earlier visits: the browser remembers the ids it created and
 *  asks for them back, so the feature survives without the server holding any
 *  author identity. Ids are not secret — they identify a public report. */
export async function getReportsByIds(db: Firestore, ids: string[]): Promise<ReportOut[]> {
  if (!ids.length) return []
  const snaps = await db.getAll(...ids.map((id) => db.collection(REPORTS).doc(id)))
  const items: ReportOut[] = []
  for (const snap of snaps) {
    if (!snap.exists) continue
    const v = snap.data() as ReportDoc
    if (v.deleted) continue
    items.push({
      id: snap.id,
      roadId: v.road_id,
      type: v.type,
      lng: v.lng,
      lat: v.lat,
      note: v.note ?? '',
      createdAt: millis(v.created_at),
    })
  }
  return items.sort((a, b) => b.createdAt - a.createdAt)
}

/** Anyone may remove a report — stale ones outlive the pothole and nobody comes
 *  back to clear their own. Returns false when the id doesn't exist, so the API
 *  can answer 404 rather than pretending it deleted something. */
export async function softDeleteReport(db: Firestore, id: string): Promise<boolean> {
  const ref = db.collection(REPORTS).doc(id)
  const snap = await ref.get()
  if (!snap.exists) return false
  await ref.set({ deleted: true, deleted_at: new Date().toISOString() }, { merge: true })
  return true
}
