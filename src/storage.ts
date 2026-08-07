/**
 * User-generated content (reports + ratings) goes through a storage adapter.
 *  - CloudStore (Firestore, ./firestore.ts) — shared with everyone; used when
 *    /firebase-config.json contains a real Firebase web config.
 *  - LocalStore (below) — device-only fallback so every feature still works
 *    on a plain static deploy with zero configuration.
 * The Firestore SDK is only downloaded (dynamic import) when configured.
 */
import type { RatingSummary, ReportItem, ReportType, UserStore } from './types'

const UID_KEY = 'rti-uid'
const REPORTS_KEY = 'rti-reports'
const RATINGS_KEY = 'rti-ratings'

export function deviceId(): string {
  let id = localStorage.getItem(UID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(UID_KEY, id)
  }
  return id
}

class LocalStore implements UserStore {
  readonly mode = 'local' as const
  readonly uid = deviceId()

  private readReports(): ReportItem[] {
    try {
      return JSON.parse(localStorage.getItem(REPORTS_KEY) ?? '[]') as ReportItem[]
    } catch {
      return []
    }
  }
  private writeReports(items: ReportItem[]): void {
    localStorage.setItem(REPORTS_KEY, JSON.stringify(items))
  }

  async addReport(r: { roadId: string; type: ReportType; lng: number; lat: number; note: string }) {
    const item: ReportItem = {
      id: crypto.randomUUID(),
      ...r,
      createdAt: Date.now(),
      uid: this.uid,
      fixedBy: [],
      mine: true,
    }
    const all = this.readReports()
    all.push(item)
    this.writeReports(all)
    return item
  }

  async removeReport(id: string) {
    this.writeReports(this.readReports().filter((r) => r.id !== id))
  }

  async markFixed(id: string) {
    // local mode: marking your own report fixed just removes it
    await this.removeReport(id)
  }

  async getReportsForRoad(roadId: string) {
    return this.readReports()
      .filter((r) => r.roadId === roadId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  async getMyReports() {
    return this.readReports()
  }

  private readRatings(): Record<string, number> {
    try {
      return JSON.parse(localStorage.getItem(RATINGS_KEY) ?? '{}') as Record<string, number>
    } catch {
      return {}
    }
  }

  async setRating(roadId: string, stars: number) {
    const all = this.readRatings()
    all[roadId] = stars
    localStorage.setItem(RATINGS_KEY, JSON.stringify(all))
  }

  async getMyRating(roadId: string) {
    return this.readRatings()[roadId] ?? null
  }

  async getRatingSummary(): Promise<RatingSummary | null> {
    return null // no community data in device-only mode
  }
}

let storePromise: Promise<UserStore> | null = null

export function getStore(): Promise<UserStore> {
  if (!storePromise) storePromise = detect()
  return storePromise
}

async function detect(): Promise<UserStore> {
  try {
    const res = await fetch('/firebase-config.json', { cache: 'no-store' })
    if (res.ok) {
      const cfg = (await res.json()) as { apiKey?: string; projectId?: string }
      if (cfg.apiKey && cfg.projectId && !cfg.apiKey.startsWith('PASTE')) {
        const { CloudStore } = await import('./firestore')
        const store = new CloudStore()
        await store.init(cfg as Record<string, string>)
        return store
      }
    }
  } catch (e) {
    console.warn('[storage] Firestore unavailable, using device-local storage.', e)
  }
  return new LocalStore()
}
