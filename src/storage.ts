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

interface FirebaseCfg {
  apiKey?: string
  projectId?: string
}

/** Accepts strict JSON but also the JS-object literal people paste straight
 *  from the Firebase console ({apiKey: "...", ...} with unquoted keys). */
function parseConfig(raw: string): FirebaseCfg | null {
  try {
    return JSON.parse(raw) as FirebaseCfg
  } catch {
    try {
      const fixed = raw
        .replace(/'/g, '"')
        .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
        .replace(/,\s*}/g, '}')
      return JSON.parse(fixed) as FirebaseCfg
    } catch {
      return null
    }
  }
}

/** Preferred source: VITE_FIREBASE_CONFIG env var, set in the host's dashboard
 *  at build time — the config never lives in the repo. */
function envConfig(): FirebaseCfg | null {
  const raw = import.meta.env.VITE_FIREBASE_CONFIG as string | undefined
  if (!raw) return null
  const cfg = parseConfig(raw)
  if (!cfg) console.warn('[storage] VITE_FIREBASE_CONFIG could not be parsed — falling back to device-local mode.')
  return cfg
}

/** Fallback source: /firebase-config.json (gitignored; for local testing). */
async function fileConfig(): Promise<FirebaseCfg | null> {
  try {
    const res = await fetch('/firebase-config.json', { cache: 'no-store' })
    if (!res.ok) return null
    return parseConfig(await res.text())
  } catch {
    return null
  }
}

async function detect(): Promise<UserStore> {
  let reason = 'no Firebase config found (VITE_FIREBASE_CONFIG env var or /firebase-config.json)'
  try {
    const cfg = envConfig() ?? (await fileConfig())
    if (cfg?.apiKey && cfg.projectId && !cfg.apiKey.startsWith('PASTE')) {
      const { CloudStore } = await import('./firestore')
      const store = new CloudStore()
      await store.init(cfg as Record<string, string>)
      console.info(`[storage] shared mode — Firestore project "${cfg.projectId}"`)
      return store
    }
    if (cfg) reason = 'config found but apiKey/projectId missing or placeholder'
  } catch (e) {
    const code = (e as { code?: string })?.code
    reason =
      code === 'auth/admin-restricted-operation' || code === 'auth/operation-not-allowed'
        ? `Firestore init failed (${code}) — enable ANONYMOUS sign-in: Firebase console → Authentication → Sign-in method → Anonymous`
        : code === 'auth/unauthorized-domain'
          ? `Firestore init failed (${code}) — add this site's domain: Firebase console → Authentication → Settings → Authorized domains`
          : `Firestore init failed (${code ?? (e as Error)?.message ?? e})`
  }
  console.warn(`[storage] device-local mode — ${reason}`)
  return new LocalStore()
}
