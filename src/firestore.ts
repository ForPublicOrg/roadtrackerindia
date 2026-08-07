/**
 * Firestore-backed shared storage for community reports and ratings.
 * Loaded lazily (dynamic import) only when /firebase-config.json is present.
 * Uses anonymous auth — visitors never create an account.
 * Matching security rules live in firestore.rules at the repo root.
 */
import type { RatingSummary, ReportItem, ReportType, UserStore } from './types'
import type { FirebaseApp } from 'firebase/app'
import type { Firestore, Timestamp } from 'firebase/firestore'

/** A malformed createdAt (crafted client write) must never crash the whole list. */
function toMillisSafe(ts: Timestamp | undefined): number {
  return ts && typeof (ts as { toMillis?: unknown }).toMillis === 'function'
    ? ts.toMillis()
    : Date.now()
}

export class CloudStore implements UserStore {
  readonly mode = 'cloud' as const
  uid = ''
  private db!: Firestore
  private app!: FirebaseApp

  async init(config: Record<string, string>): Promise<void> {
    const { initializeApp } = await import('firebase/app')
    const { getAuth, signInAnonymously } = await import('firebase/auth')
    const { getFirestore } = await import('firebase/firestore')
    this.app = initializeApp(config)
    const auth = getAuth(this.app)
    const cred = await signInAnonymously(auth)
    this.uid = cred.user.uid
    this.db = getFirestore(this.app)
  }

  async addReport(r: { roadId: string; type: ReportType; lng: number; lat: number; note: string }) {
    const { addDoc, collection, serverTimestamp } = await import('firebase/firestore')
    const doc = await addDoc(collection(this.db, 'reports'), {
      ...r,
      uid: this.uid,
      fixedBy: [],
      createdAt: serverTimestamp(),
    })
    const item: ReportItem = {
      id: doc.id,
      ...r,
      createdAt: Date.now(),
      uid: this.uid,
      fixedBy: [],
      mine: true,
    }
    return item
  }

  async removeReport(id: string) {
    const { deleteDoc, doc } = await import('firebase/firestore')
    await deleteDoc(doc(this.db, 'reports', id))
  }

  async markFixed(id: string) {
    const { arrayUnion, doc, updateDoc } = await import('firebase/firestore')
    await updateDoc(doc(this.db, 'reports', id), { fixedBy: arrayUnion(this.uid) })
  }

  async getReportsForRoad(roadId: string): Promise<ReportItem[]> {
    const { collection, getDocs, limit, query, where } = await import('firebase/firestore')
    const snap = await getDocs(
      query(collection(this.db, 'reports'), where('roadId', '==', roadId), limit(150)),
    )
    const items: ReportItem[] = []
    snap.forEach((d) => {
      const v = d.data() as {
        roadId: string
        type: ReportType
        lng: number
        lat: number
        note: string
        uid: string
        fixedBy?: string[]
        createdAt?: Timestamp
      }
      items.push({
        id: d.id,
        roadId: v.roadId,
        type: v.type,
        lng: v.lng,
        lat: v.lat,
        note: v.note ?? '',
        uid: v.uid,
        fixedBy: Array.isArray(v.fixedBy) ? v.fixedBy : [],
        createdAt: toMillisSafe(v.createdAt),
        mine: v.uid === this.uid,
      })
    })
    // hide reports the community has marked fixed (3+ people) — but never hide
    // someone's own report from them
    return items
      .filter((r) => r.mine || r.fixedBy.length < 3)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  async getMyReports(): Promise<ReportItem[]> {
    const { collection, getDocs, limit, query, where } = await import('firebase/firestore')
    const snap = await getDocs(
      query(collection(this.db, 'reports'), where('uid', '==', this.uid), limit(100)),
    )
    const items: ReportItem[] = []
    snap.forEach((d) => {
      const v = d.data() as {
        roadId: string
        type: ReportType
        lng: number
        lat: number
        note: string
        uid: string
        fixedBy?: string[]
        createdAt?: Timestamp
      }
      items.push({
        id: d.id,
        roadId: v.roadId,
        type: v.type,
        lng: v.lng,
        lat: v.lat,
        note: v.note ?? '',
        uid: v.uid,
        fixedBy: Array.isArray(v.fixedBy) ? v.fixedBy : [],
        createdAt: toMillisSafe(v.createdAt),
        mine: true,
      })
    })
    return items
  }

  async setRating(roadId: string, stars: number) {
    const { doc, setDoc } = await import('firebase/firestore')
    await setDoc(doc(this.db, 'ratings', `${roadId}_${this.uid}`), {
      roadId,
      uid: this.uid,
      stars,
    })
  }

  async getMyRating(roadId: string) {
    const { doc, getDoc } = await import('firebase/firestore')
    const snap = await getDoc(doc(this.db, 'ratings', `${roadId}_${this.uid}`))
    return snap.exists() ? ((snap.data() as { stars: number }).stars ?? null) : null
  }

  async getRatingSummary(roadId: string): Promise<RatingSummary | null> {
    try {
      const { average, collection, count, getAggregateFromServer, query, where } = await import(
        'firebase/firestore'
      )
      const snap = await getAggregateFromServer(
        query(collection(this.db, 'ratings'), where('roadId', '==', roadId)),
        { count: count(), avg: average('stars') },
      )
      const { count: c, avg } = snap.data()
      if (!c || avg == null) return null
      return { avg, count: c }
    } catch {
      return null
    }
  }
}
