/**
 * Road reviews — stars for a stretch of a road (or all of it), a few words if
 * you have them, and a "helpful" thumb.
 *
 * POST   /api/reviews {roadId, stars, range?, text?, fingerprint, turnstileToken} → write or replace your entry for that range
 * DELETE /api/reviews {roadId, range?, fingerprint, turnstileToken}               → remove it
 * PUT    /api/reviews {roadId, id, on, fingerprint, turnstileToken}               → like / unlike one
 *
 * `range` is `all` (the default), two stop slugs joined by `>` for a run driven
 * from the first to the second, or joined by `--`, in either order — the old
 * spelling, which the site reads as driven in road order. On POST, leaving `text` out keeps the review you have and an empty one
 * removes it. Pages built before stretches still post {roadId, text} and delete
 * {roadId}: both mean "my whole-road review", and the stars stay as they were.
 *
 * There is no GET: reviews ride inside the road's rating summary
 * (GET /api/ratings?roadId=…), so showing them costs no extra read.
 *
 * "Yours" means the same salted (coarse IP + device) key that makes ratings
 * one-per-range. The server still identifies nobody; the browser remembers
 * which reviews it wrote and which ones it liked.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getDb, isFirestoreConfigured } from './_lib/db.js'
import { checkRateLimit, getClientIp, raterKey, verifyTurnstile } from './_lib/integrity.js'
import { ALL, RATINGS_PER_HOUR, REVIEW_MAX, canonicalRange } from './_lib/ratings-math.js'
import { deleteEntry, saveEntry, setReviewLike } from './_lib/ratings-store.js'

const ROAD_ID = /^[a-z0-9][a-z0-9-]{0,99}$/
/** 6 random bytes, base64url — see saveEntry(). */
const REVIEW_ID = /^[A-Za-z0-9_-]{8}$/

/** Tidy whitespace and drop control characters. HTML is NOT stripped here — the
 *  client escapes on render, and a review that reads "use the <b> exit" should
 *  say exactly that. Blank comes back as '' (no text, not a bad one: the stars
 *  still save); null means unusable. */
function cleanText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (!text) return ''
  return text.length >= 3 && text.length <= REVIEW_MAX ? text : null
}

const isStars = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5

type Body = {
  roadId?: unknown
  stars?: unknown
  range?: unknown
  text?: unknown
  id?: unknown
  on?: unknown
  fingerprint?: string
  turnstileToken?: string
}

type Write =
  | { kind: 'like'; id: string; on: boolean }
  | { kind: 'delete'; range: string | undefined }
  | { kind: 'save'; range: string; stars: number | undefined; text: string | undefined }

/** Everything a request asks for, checked, or null if any of it is malformed. */
function parseWrite(method: string, body: Body, query: VercelRequest['query']): Write | null {
  if (method === 'PUT') {
    const { id, on } = body
    if (typeof id !== 'string' || !REVIEW_ID.test(id) || typeof on !== 'boolean') return null
    return { kind: 'like', id, on }
  }

  // Read from the query too, like roadId — some proxies drop DELETE bodies.
  const rawRange = body.range ?? query.range
  const range =
    rawRange == null ? undefined : typeof rawRange === 'string' ? canonicalRange(rawRange) : null
  if (range === null) return null
  if (method === 'DELETE') return { kind: 'delete', range }

  let stars: number | undefined
  if (body.stars != null) {
    if (!isStars(body.stars)) return null
    stars = body.stars
  } else if (range !== undefined) {
    // Only an old page leaves both out; a range always comes with stars.
    return null
  }

  let text: string | undefined
  if (body.text != null) {
    const t = cleanText(body.text)
    if (t === null) return null
    text = t
  }
  // An old page with nothing to say would be a write that changes nothing.
  if (stars === undefined && text === undefined) return null

  return { kind: 'save', range: range ?? ALL, stars, text }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const db = getDb()
  if (!db) {
    if (isFirestoreConfigured()) console.error('[reviews] Firestore configured but unavailable')
    return res.status(503).json({ error: 'unavailable' })
  }

  if (req.method !== 'POST' && req.method !== 'DELETE' && req.method !== 'PUT') {
    res.setHeader('allow', 'POST, PUT, DELETE')
    return res.status(405).json({ error: 'method-not-allowed' })
  }

  const body = (req.body ?? {}) as Body
  // Accept the road from the query too — some proxies drop DELETE bodies.
  const rawRoad = typeof body.roadId === 'string' ? body.roadId : req.query.roadId
  const roadId = typeof rawRoad === 'string' ? rawRoad.trim() : ''
  if (!ROAD_ID.test(roadId)) return res.status(400).json({ error: 'invalid' })

  // All of the request is checked before Turnstile and the rate limit, so a
  // malformed one spends neither the visitor's token nor their hourly budget.
  const w = parseWrite(req.method, body, req.query)
  if (!w) return res.status(400).json({ error: 'invalid' })

  const ip = getClientIp(req.headers)

  const bot = await verifyTurnstile(body.turnstileToken ?? '', ip)
  if (!bot.ok) return res.status(403).json({ error: 'captcha', reason: bot.reason })

  // Likes, ratings and written reviews each get a budget of their own, so a
  // generous reader is never locked out of writing, and rating a road stretch
  // by stretch never locks anyone out of reviewing it. Ratings get the larger
  // one, since every stretch is a write of its own (see RATINGS_PER_HOUR).
  const scope = w.kind === 'like' ? 'like' : w.kind === 'save' && !w.text ? 'rate' : 'review'
  const limit = scope === 'rate' ? RATINGS_PER_HOUR : undefined
  // An Upstash error rejects rather than failing open: fail closed, in JSON.
  const allowed = await checkRateLimit(ip, scope, limit).catch((err: unknown) => {
    console.error('[reviews] rate limiter failed:', err)
    return null
  })
  if (allowed === null) return res.status(503).json({ error: 'unavailable' })
  if (!allowed) return res.status(429).json({ error: 'rate-limited' })

  const key = raterKey(ip, body.fingerprint ?? '')
  const dev = bot.dev ?? false

  try {
    if (w.kind === 'like') {
      const r = await setReviewLike(db, roadId, key, w.id, w.on)
      if (r === 'not-found') return res.status(404).json({ error: 'not-found' })
      if (r === 'own') return res.status(400).json({ error: 'own' })
      return res.status(200).json({ ok: true, dev, ...r })
    }

    if (w.kind === 'delete') {
      const summary = await deleteEntry(db, roadId, key, w.range)
      if (!summary) return res.status(404).json({ error: 'not-found' })
      return res.status(200).json({ ok: true, dev, summary })
    }

    const r = await saveEntry(db, roadId, key, { range: w.range, stars: w.stars, text: w.text })
    // 'too-many' (one of their own caps) or 'road-full' (the road's), as it came
    if (typeof r === 'string') return res.status(400).json({ error: r })
    const { summary, updated, range, stars, reviewId } = r
    return res.status(200).json({ ok: true, dev, updated, range, stars, reviewId, summary })
  } catch (err) {
    console.error('[reviews] write failed:', err)
    return res.status(503).json({ error: 'unavailable' })
  }
}
