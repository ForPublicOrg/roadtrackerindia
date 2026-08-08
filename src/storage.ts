/**
 * User-generated content (reports + ratings) lives in Cloud Firestore, but the
 * browser never talks to it. Everything goes through this site's own serverless
 * API (/api/ratings, /api/reports), which holds the Admin credentials — so
 * firestore.rules can deny every direct client read and write.
 *
 * There is no account and no anonymous sign-in: the server identifies nobody.
 * "One rating per road" is enforced with a salted hash of (coarse IP + device
 * fingerprint) computed server-side and never stored as a field. The only thing
 * kept about *you* lives in this browser's localStorage, purely so the UI can
 * show your own stars and pins back to you.
 */
import type { NewReport, RatingSummary, ReportItem, UserStore } from './types'
import { getTurnstileToken, resetTurnstile } from './turnstile'

const MY_RATING = 'rti-rating:'
const MY_REPORTS = 'rti-reports'

/** A small, privacy-light device signal used ONLY as a soft dedupe hint. It is
 *  sent to our own API, hashed with a server-side secret, and never stored. */
function deviceFingerprint(): string {
  try {
    const bits = [
      navigator.language,
      new Date().getTimezoneOffset(),
      screen.width + 'x' + screen.height,
      screen.colorDepth,
      navigator.hardwareConcurrency,
      // navigator.platform is deprecated but still the most stable coarse
      // signal available without a permission prompt.
      navigator.platform,
    ].join('|')
    let h = 0
    for (let i = 0; i < bits.length; i++) h = (h * 31 + bits.charCodeAt(i)) >>> 0
    return h.toString(36)
  } catch {
    return 'na'
  }
}

function readIds(): string[] {
  try {
    const raw = localStorage.getItem(MY_REPORTS)
    const v: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(-100) : []
  } catch {
    return []
  }
}

function writeIds(ids: string[]): void {
  try {
    localStorage.setItem(MY_REPORTS, JSON.stringify(ids.slice(-100)))
  } catch {
    /* private mode / quota — the pins just won't persist */
  }
}

interface ApiError {
  error?: string
}

/** Turns a response into data or throws a short code.
 *
 *  The content-type check is load-bearing, not defensive noise: a host that
 *  doesn't run the functions — or a misrouted deploy — answers /api/* with the
 *  SPA's own index.html and HTTP 200. Parsing that into an empty object would
 *  make every road look genuinely unrated instead of unreadable, which is the
 *  exact false "be the first to rate this road" this code exists to prevent. */
async function parse<T>(res: Response): Promise<T> {
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json')
  if (!isJson) throw new Error(res.ok ? 'no-api' : `http-${res.status}`)
  const data = (await res.json().catch(() => null)) as (T & ApiError) | null
  if (!data) throw new Error(res.ok ? 'bad-response' : `http-${res.status}`)
  if (!res.ok) throw new Error(data.error || `http-${res.status}`)
  return data
}

/** Every write carries a Turnstile token and the fingerprint. The token is
 *  single-use, so it is reset after the round trip whatever the outcome. */
async function send<T>(path: string, method: string, body: Record<string, unknown>): Promise<T> {
  const turnstileToken = await getTurnstileToken()
  let res: Response
  try {
    res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, fingerprint: deviceFingerprint(), turnstileToken }),
    })
  } finally {
    resetTurnstile()
  }
  return parse<T>(res)
}

async function get<T>(path: string): Promise<T> {
  return parse<T>(await fetch(path))
}

class ApiStore implements UserStore {
  async addReport(r: NewReport): Promise<ReportItem> {
    const { report } = await send<{ report: Omit<ReportItem, 'mine'> }>(
      '/api/reports',
      'POST',
      r as unknown as Record<string, unknown>,
    )
    writeIds([...readIds(), report.id])
    return { ...report, mine: true }
  }

  async removeReport(id: string): Promise<void> {
    await send<unknown>('/api/reports', 'DELETE', { id })
    writeIds(readIds().filter((x) => x !== id))
  }

  async getReportsForRoad(roadId: string): Promise<ReportItem[]> {
    const mine = new Set(readIds())
    const { reports } = await get<{ reports: Omit<ReportItem, 'mine'>[] }>(
      `/api/reports?roadId=${encodeURIComponent(roadId)}`,
    )
    if (!Array.isArray(reports)) throw new Error('bad-response')
    return reports.map((r) => ({ ...r, mine: mine.has(r.id) }))
  }

  async getMyReports(): Promise<ReportItem[]> {
    const ids = readIds()
    if (!ids.length) return []
    const { reports } = await get<{ reports: Omit<ReportItem, 'mine'>[] }>(
      `/api/reports?ids=${ids.map(encodeURIComponent).join(',')}`,
    )
    if (!Array.isArray(reports)) throw new Error('bad-response')
    // Reports anyone has since deleted come back missing — forget them so the
    // list doesn't grow forever with ids that no longer resolve.
    writeIds(reports.map((r) => r.id))
    return reports.map((r) => ({ ...r, mine: true }))
  }

  async setRating(roadId: string, stars: number): Promise<RatingSummary> {
    const { summary } = await send<{ summary: RatingSummary }>('/api/ratings', 'POST', {
      roadId,
      stars,
    })
    try {
      localStorage.setItem(MY_RATING + roadId, String(stars))
    } catch {
      /* private mode — the stars just won't be remembered next visit */
    }
    return summary
  }

  getMyRating(roadId: string): number | null {
    try {
      const raw = localStorage.getItem(MY_RATING + roadId)
      const n = raw ? Number(raw) : NaN
      return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null
    } catch {
      return null
    }
  }

  async getRatingSummary(roadId: string): Promise<RatingSummary | null> {
    const { summaries } = await get<{ summaries: RatingSummary[] }>(
      `/api/ratings?roadId=${encodeURIComponent(roadId)}`,
    )
    // A well-formed reply always carries the array. Anything else is a failure
    // to read, never "this road has no ratings".
    if (!Array.isArray(summaries)) throw new Error('bad-response')
    const s = summaries[0]
    return s && s.votes > 0 ? s : null
  }
}

/** Reads community ratings for many roads at once — one request for a whole
 *  list or page of search results, instead of one per road. */
export async function getRatingSummaries(roadIds: string[]): Promise<Map<string, RatingSummary>> {
  const out = new Map<string, RatingSummary>()
  if (!roadIds.length) return out
  try {
    const { summaries } = await get<{ summaries: (RatingSummary & { roadId: string })[] }>(
      `/api/ratings?roadIds=${roadIds.slice(0, 100).map(encodeURIComponent).join(',')}`,
    )
    for (const s of summaries) if (s.votes > 0) out.set(s.roadId, s)
  } catch (e) {
    console.warn('[storage] bulk rating read failed —', e)
  }
  return out
}

const store: UserStore = new ApiStore()

/** The store is stateless — there is no connection to establish and no session
 *  to sign in, so this never rejects. Each call reports its own failure, which
 *  is also what lets a transient API blip recover on the next interaction
 *  instead of disabling community features for the whole page load. */
export function getStore(): Promise<UserStore> {
  return Promise.resolve(store)
}
