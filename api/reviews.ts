/**
 * Road reviews — a few words to go with the stars, and a "helpful" thumb.
 *
 * POST   /api/reviews {roadId, text, fingerprint, turnstileToken}    → write or replace yours
 * DELETE /api/reviews {roadId, fingerprint, turnstileToken}          → remove yours
 * PUT    /api/reviews {roadId, id, on, fingerprint, turnstileToken}  → like / unlike one
 *
 * There is no GET: reviews ride inside the road's rating summary
 * (GET /api/ratings?roadId=…), so showing them costs no extra read.
 *
 * "Yours" means the same salted (coarse IP + device) key that makes ratings
 * one-per-road. The server still identifies nobody; the browser remembers which
 * review it wrote and which ones it liked.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getDb, isFirestoreConfigured } from './_lib/db.js'
import { checkRateLimit, getClientIp, raterKey, verifyTurnstile } from './_lib/integrity.js'
import { REVIEW_MAX, deleteReview, saveReview, setReviewLike } from './_lib/ratings-store.js'

const ROAD_ID = /^[a-z0-9][a-z0-9-]{0,99}$/
/** 6 random bytes, base64url — see saveReview(). */
const REVIEW_ID = /^[A-Za-z0-9_-]{8}$/

/** Tidy whitespace and drop control characters. HTML is NOT stripped here — the
 *  client escapes on render, and a review that reads "use the <b> exit" should
 *  say exactly that. */
function cleanText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.length >= 3 && text.length <= REVIEW_MAX ? text : null
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

  const body = (req.body ?? {}) as {
    roadId?: string
    text?: string
    id?: string
    on?: boolean
    fingerprint?: string
    turnstileToken?: string
  }
  // Accept the road from the query too — some proxies drop DELETE bodies.
  const rawRoad = typeof body.roadId === 'string' ? body.roadId : req.query.roadId
  const roadId = typeof rawRoad === 'string' ? rawRoad.trim() : ''
  if (!ROAD_ID.test(roadId)) return res.status(400).json({ error: 'invalid' })

  const ip = getClientIp(req.headers)

  const bot = await verifyTurnstile(body.turnstileToken ?? '', ip)
  if (!bot.ok) return res.status(403).json({ error: 'captcha', reason: bot.reason })

  // Likes get a budget of their own, so a generous reader is never locked out
  // of writing — and a review spree never locks anyone out of liking.
  const scope = req.method === 'PUT' ? 'like' : 'review'
  // An Upstash error rejects rather than failing open: fail closed, in JSON.
  const allowed = await checkRateLimit(ip, scope).catch((err: unknown) => {
    console.error('[reviews] rate limiter failed:', err)
    return null
  })
  if (allowed === null) return res.status(503).json({ error: 'unavailable' })
  if (!allowed) return res.status(429).json({ error: 'rate-limited' })

  const key = raterKey(ip, body.fingerprint ?? '')
  const dev = bot.dev ?? false

  try {
    if (req.method === 'PUT') {
      const id = typeof body.id === 'string' ? body.id : ''
      if (!REVIEW_ID.test(id) || typeof body.on !== 'boolean') {
        return res.status(400).json({ error: 'invalid' })
      }
      const r = await setReviewLike(db, roadId, key, id, body.on)
      if (r === 'not-found') return res.status(404).json({ error: 'not-found' })
      if (r === 'own') return res.status(400).json({ error: 'own' })
      return res.status(200).json({ ok: true, dev, ...r })
    }

    if (req.method === 'DELETE') {
      const summary = await deleteReview(db, roadId, key)
      if (!summary) return res.status(404).json({ error: 'not-found' })
      return res.status(200).json({ ok: true, dev, summary })
    }

    const text = cleanText(body.text)
    if (!text) return res.status(400).json({ error: 'invalid' })
    const { summary, reviewId } = await saveReview(db, roadId, key, text)
    return res.status(200).json({ ok: true, dev, summary, reviewId })
  } catch (err) {
    console.error('[reviews] write failed:', err)
    return res.status(503).json({ error: 'unavailable' })
  }
}
