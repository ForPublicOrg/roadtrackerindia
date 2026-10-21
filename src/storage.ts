/**
 * User-generated content (reports + ratings) lives in Cloud Firestore, but the
 * browser never talks to it. Everything goes through this site's own serverless
 * API (/api/ratings, /api/reports), which holds the Admin credentials — so
 * firestore.rules can deny every direct client read and write.
 *
 * There is no account and no anonymous sign-in: the server identifies nobody.
 * "One entry per person per range" (the whole road, or a run of its stretches)
 * is enforced with a salted hash of (coarse IP + device fingerprint) computed
 * server-side and never stored as a field. The only thing kept about *you*
 * lives in this browser's localStorage, purely so the UI can show your own
 * stars, reviews and pins back to you.
 */
import { ALL, isRangeKey } from './stretches'
import type {
  MyEntry,
  NewReport,
  RatingSummary,
  ReportItem,
  SaveEntryInput,
  SaveEntryResult,
  UserStore,
} from './types'
import { getTurnstileToken, resetTurnstile } from './turnstile'

/** range → your entry, per road. */
const MY_ENTRIES = 'rti-mine:'
/** What this browser kept before stretches: one rating and one review id per
 *  road, both whole-road. Folded into MY_ENTRIES on first read, then deleted. */
const OLD_RATING = 'rti-rating:'
const OLD_REVIEW = 'rti-review:'
const MY_REPORTS = 'rti-reports'
const MY_LIKES = 'rti-likes:'
const RATED_AT = 'rti-rated-at:'
const REPORTED_AT = 'rti-reported-at'

/** How long a pre-write copy can still come back from the edge: s-maxage plus
 *  stale-while-revalidate, as set in api/ratings.ts and api/reports.ts. Keep
 *  these in step with those headers. */
const RATINGS_CACHE_MS = (300 + 600) * 1000
const REPORTS_CACHE_MS = (30 + 120) * 1000

function local(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Whether storage took it. Most callers needn't care; the one that deletes
 *  something on the strength of a write does. */
function setLocal(key: string, value: string | null): boolean {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
    return true
  } catch {
    /* private mode / quota — it just won't be remembered next visit */
    return false
  }
}

/** A small, privacy-light device signal used ONLY as a soft dedupe hint. It is
 *  sent to our own API, hashed with a server-side secret, and never stored. */
function deviceFingerprint(): string {
  try {
    const bits = [
      navigator.language,
      new Date().getTimezoneOffset(),
      // Smaller side first, so rotating an Android phone (which swaps width and
      // height) doesn't turn one person into two raters. A phone held upright
      // already reports its smaller side first, so keys from portrait phones are
      // unchanged by this; a landscape screen (most desktops) gets a new one once.
      Math.min(screen.width, screen.height) + 'x' + Math.max(screen.width, screen.height),
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

/** Writes go out one at a time. Each needs its own single-use Turnstile token,
 *  and a new one is only minted once the previous write has reset the widget —
 *  two writes in flight together would carry the same token, and the second
 *  would be refused as a duplicate. Queuing also means quick successive taps
 *  (4★ then 5★) reach the server in the order they were made. */
let writes: Promise<unknown> = Promise.resolve()

function send<T>(path: string, method: string, body: Record<string, unknown>): Promise<T> {
  const p = writes.then(() => sendOne<T>(path, method, body))
  writes = p.catch(() => {})
  return p
}

/** Every write carries a Turnstile token and the fingerprint. The token is
 *  single-use, so it is reset after the round trip whatever the outcome. */
async function sendOne<T>(path: string, method: string, body: Record<string, unknown>): Promise<T> {
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

/** The reads are edge-cached and nothing purges them on a write, so right after
 *  your own write the same URL can answer with the copy from before it — your
 *  review missing, your removed pin back. For as long as such a copy could
 *  still be served, this browser's reads carry its write time, which the edge
 *  treats as a different URL. Everyone else keeps the shared cache. Kept in
 *  localStorage so a reload inside the window is covered too, and in memory so
 *  it still holds where storage throws. The newer of the two wins, so a write
 *  made in another tab counts here as well. */
const wroteAt = new Map<string, number>()

function afterWrite(path: string, key: string, windowMs: number): string {
  const at = Math.max(wroteAt.get(key) ?? 0, Number(local(key)) || 0)
  if (!at) return path
  if (Date.now() - at > windowMs) {
    wroteAt.delete(key)
    setLocal(key, null)
    return path
  }
  return `${path}&v=${at}`
}

function markWrite(key: string): void {
  const now = Date.now()
  wroteAt.set(key, now)
  setLocal(key, String(now))
}

const validStars = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5

/** Drops anything this code could not have written — a hand-edited or
 *  half-written value must not turn into a phantom "your review". */
function cleanEntries(v: unknown): Record<string, MyEntry> {
  const out: Record<string, MyEntry> = {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out
  for (const [range, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!isRangeKey(range) || !raw || typeof raw !== 'object') continue
    const { stars, reviewId } = raw as { stars?: unknown; reviewId?: unknown }
    const e: MyEntry = { stars: validStars(stars) ? stars : null }
    if (typeof reviewId === 'string' && reviewId) e.reviewId = reviewId
    if (e.stars !== null || e.reviewId) out[range] = e
  }
  return out
}

/** Your entries also live in memory, so they still show back to you for the
 *  rest of the visit where storage won't keep them: where reading it throws
 *  (private mode), and where only writing does (quota), which leaves the copy
 *  on disk older than what you just did. Otherwise storage stays the source of
 *  truth, so a write made in another tab counts. */
const mineMem = new Map<string, Record<string, MyEntry>>()
/** Roads whose last write to storage failed — read from memory until one works. */
const mineUnsaved = new Set<string>()

function readMine(roadId: string): Record<string, MyEntry> {
  let raw: string | null
  try {
    raw = localStorage.getItem(MY_ENTRIES + roadId)
  } catch {
    return { ...mineMem.get(roadId) }
  }
  if (mineUnsaved.has(roadId)) return { ...mineMem.get(roadId) }
  try {
    return cleanEntries(raw ? JSON.parse(raw) : {})
  } catch {
    return {}
  }
}

/** Whether storage kept them; memory always does. */
function writeMine(roadId: string, entries: Record<string, MyEntry>): boolean {
  mineMem.set(roadId, entries)
  const saved = setLocal(MY_ENTRIES + roadId, Object.keys(entries).length ? JSON.stringify(entries) : null)
  if (saved) mineUnsaved.delete(roadId)
  else mineUnsaved.add(roadId)
  return saved
}

function dropOld(roadId: string): void {
  setLocal(OLD_RATING + roadId, null)
  setLocal(OLD_REVIEW + roadId, null)
}

/** Keeps a change you made here. The old keys go once storage holds what they
 *  were folded into. A change to the whole road drops them even where storage
 *  refused it: they describe the road as it was before, and the next read
 *  would fold them back over what you just did. */
function keepMine(roadId: string, range: string, entries: Record<string, MyEntry>): void {
  if (writeMine(roadId, entries) || range === ALL) dropOld(roadId)
}

/** Before stretches, your stars and your review id were kept apart, and both
 *  were about the whole road — so they become its ALL entry.
 *
 *  Old keys found beside an ALL entry are the newer of the two: everything here
 *  that writes your entries deletes them once storage has the result, so they
 *  can only have been written since, by a tab still on the page from before
 *  stretches. Each wins for what it holds. That page rated without touching the
 *  review and wrote a review without touching the stars, so the field it left
 *  alone is still right as it stands.
 *
 *  They are deleted only once storage holds the entry they became. Where only
 *  writes fail (quota), removing still works, and deleting them first would
 *  drop the one copy of your review id; kept, they are folded in again on the
 *  next read — to the same entry — until a write goes through. */
function migrateOld(roadId: string, entries: Record<string, MyEntry>): Record<string, MyEntry> {
  const rawStars = local(OLD_RATING + roadId)
  const reviewId = local(OLD_REVIEW + roadId)
  if (rawStars === null && reviewId === null) return entries
  const stars = rawStars ? Number(rawStars) : NaN
  const prev = entries[ALL]
  const e: MyEntry = { stars: validStars(stars) ? stars : (prev?.stars ?? null) }
  const id = reviewId || prev?.reviewId
  if (id) e.reviewId = id
  if (e.stars !== null || e.reviewId) entries = { ...entries, [ALL]: e }
  if (writeMine(roadId, entries)) dropOld(roadId)
  return entries
}

const emptySummary = (): RatingSummary => ({ mean: 0, votes: 0, distribution: {}, reviews: [], ranges: {} })

const errCode = (e: unknown): string => (e as Error)?.message ?? String(e)

class ApiStore implements UserStore {
  async addReport(r: NewReport): Promise<ReportItem> {
    const { report } = await send<{ report: Omit<ReportItem, 'mine'> }>(
      '/api/reports',
      'POST',
      r as unknown as Record<string, unknown>,
    )
    writeIds([...readIds(), report.id])
    markWrite(REPORTED_AT)
    return { ...report, mine: true }
  }

  async removeReport(id: string): Promise<void> {
    await send<unknown>('/api/reports', 'DELETE', { id })
    writeIds(readIds().filter((x) => x !== id))
    // Not per road: a removal only knows the report's id. Reports are rare
    // enough that skipping the cache on every road for a couple of minutes
    // costs next to nothing.
    markWrite(REPORTED_AT)
  }

  async getReportsForRoad(roadId: string): Promise<ReportItem[]> {
    const mine = new Set(readIds())
    const path = `/api/reports?roadId=${encodeURIComponent(roadId)}`
    const { reports } = await get<{ reports: Omit<ReportItem, 'mine'>[] }>(
      afterWrite(path, REPORTED_AT, REPORTS_CACHE_MS),
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

  async getRatingSummary(roadId: string): Promise<RatingSummary | null> {
    const path = `/api/ratings?roadId=${encodeURIComponent(roadId)}`
    const { summaries } = await get<{ summaries: RatingSummary[] }>(
      afterWrite(path, RATED_AT + roadId, RATINGS_CACHE_MS),
    )
    // A well-formed reply always carries the array. Anything else is a failure
    // to read, never "this road has no ratings".
    if (!Array.isArray(summaries)) throw new Error('bad-response')
    const s = summaries[0]
    return s && (s.votes > 0 || s.reviews?.length) ? s : null
  }

  async saveEntry(roadId: string, input: SaveEntryInput): Promise<SaveEntryResult> {
    const body: Record<string, unknown> = { roadId, stars: input.stars, range: input.range }
    if (input.text !== undefined) body.text = input.text
    const r = await send<{
      summary: RatingSummary
      range?: string
      stars?: number | null
      reviewId?: string | null
    }>('/api/reviews', 'POST', body)
    // Kept under the range the server stored it as, with the stars and review
    // id it now holds — not what was sent, which a removed text or an evicted
    // review would make stale.
    const range = typeof r.range === 'string' ? r.range : input.range
    const stars = r.stars === undefined ? input.stars : r.stars
    const reviewId = typeof r.reviewId === 'string' && r.reviewId ? r.reviewId : null
    const entries = this.getMyEntries(roadId)
    if (stars === null && !reviewId) delete entries[range]
    else entries[range] = reviewId ? { stars, reviewId } : { stars }
    keepMine(roadId, range, entries)
    markWrite(RATED_AT + roadId)
    return { summary: r.summary, range, stars, reviewId }
  }

  async removeEntry(roadId: string, range: string): Promise<RatingSummary> {
    const forget = () => {
      const entries = this.getMyEntries(roadId)
      delete entries[range]
      keepMine(roadId, range, entries)
      markWrite(RATED_AT + roadId)
    }
    try {
      const { summary } = await send<{ summary: RatingSummary }>('/api/reviews', 'DELETE', { roadId, range })
      forget()
      return summary
    } catch (e) {
      if (errCode(e) !== 'not-found') throw e
    }
    // Not found under the key this request carried — which is no proof it is
    // gone. The key hashes the coarse IP with this device's fingerprint, so it
    // changes with the network (home Wi-Fi to mobile data, a new CGNAT address)
    // and with the fingerprint, and the entry may still be public under the
    // key it was written with. So look
    // first, past the edge-cached copy, and let go here only of what the
    // server no longer holds for anyone who could be you.
    markWrite(RATED_AT + roadId)
    const fresh = (await this.getRatingSummary(roadId)) ?? emptySummary()
    const mine = this.getMyEntries(roadId)[range]
    // Already forgotten: deleted from another tab, which shares this storage.
    if (!mine) return fresh
    // A review id is yours alone, so a review still listed is still yours.
    // Stars carry no name: any vote left on the range could be yours.
    const held =
      Boolean(mine.reviewId && fresh.reviews?.some((v) => v.id === mine.reviewId)) ||
      (mine.stars !== null && (fresh.ranges?.[range]?.total ?? 0) > 0)
    // Kept, so it still shows as yours, with Edit and Delete for when you are
    // back on the connection that wrote it. For stars that is a guess — they
    // may be someone else's, after a delete whose answer was lost — so the
    // caller offers forgetEntry as the way out.
    if (held) throw new Error('not-yours')
    forget()
    return fresh
  }

  forgetEntry(roadId: string, range: string): void {
    const entries = this.getMyEntries(roadId)
    if (!(range in entries)) return
    delete entries[range]
    keepMine(roadId, range, entries)
  }

  async setReviewLike(roadId: string, id: string, on: boolean) {
    const r = await send<{ likes: number; liked: boolean }>('/api/reviews', 'PUT', { roadId, id, on })
    const likes = this.getMyLikes(roadId)
    if (r.liked) likes.add(id)
    else likes.delete(id)
    setLocal(MY_LIKES + roadId, JSON.stringify([...likes]))
    markWrite(RATED_AT + roadId)
    return r
  }

  getMyEntries(roadId: string): Record<string, MyEntry> {
    return migrateOld(roadId, readMine(roadId))
  }

  getMyLikes(roadId: string): Set<string> {
    try {
      const v: unknown = JSON.parse(local(MY_LIKES + roadId) ?? '[]')
      return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    } catch {
      return new Set()
    }
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
