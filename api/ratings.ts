/**
 * Road ratings. The browser never touches Firestore — this endpoint is the only
 * way in, which is what lets firestore.rules deny everything.
 *
 * GET  /api/ratings?roadId=nh-44          → one road's summary
 * GET  /api/ratings?roadIds=nh-44,nh-48   → many (for lists and search results)
 * POST /api/ratings {roadId, stars, fingerprint, turnstileToken}
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getDb, isFirestoreConfigured } from './_lib/db.js'
import { checkRateLimit, getClientIp, raterKey, verifyTurnstile } from './_lib/integrity.js'
import { emptySummary, getSummaries, recordRating } from './_lib/ratings-store.js'

/** Road ids are generated slugs (see scripts/fetch-osm-roads.mjs). Validating the
 *  shape keeps arbitrary strings out of document paths. */
const ROAD_ID = /^[a-z0-9][a-z0-9-]{0,99}$/

/** One request can price a whole browse page, but not the entire 7,750-road
 *  catalogue — that would be a free full-table read for anyone who asks. */
const MAX_BATCH = 100

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const db = getDb()
  if (!db) {
    // Configured but unavailable is a real outage; unconfigured is the
    // documented local-dev state. Both surface as "unavailable" to the client.
    if (isFirestoreConfigured()) console.error('[ratings] Firestore configured but unavailable')
    return res.status(503).json({ error: 'unavailable' })
  }

  if (req.method === 'GET') {
    const single = typeof req.query.roadId === 'string' ? req.query.roadId : ''
    const many = typeof req.query.roadIds === 'string' ? req.query.roadIds : ''
    const ids = (single ? [single] : many ? many.split(',') : [])
      .map((s) => s.trim())
      .filter((s) => ROAD_ID.test(s))
      .slice(0, MAX_BATCH)
    if (!ids.length) return res.status(400).json({ error: 'bad-request' })

    try {
      const summaries = await getSummaries(db, ids)
      // Cached at the edge: the panel fetches this on every road open, and a
      // rating's own POST returns the fresh summary, so staleness is invisible
      // to the person who just rated.
      res.setHeader('cache-control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=600')
      return res.status(200).json({ ok: true, summaries })
    } catch (err) {
      console.error('[ratings] summary read failed:', err)
      return res.status(503).json({ error: 'unavailable' })
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('allow', 'GET, POST')
    return res.status(405).json({ error: 'method-not-allowed' })
  }

  const body = (req.body ?? {}) as {
    roadId?: string
    stars?: number
    fingerprint?: string
    turnstileToken?: string
  }
  const { roadId = '', stars, fingerprint = '', turnstileToken = '' } = body

  if (
    !ROAD_ID.test(roadId) ||
    typeof stars !== 'number' ||
    !Number.isInteger(stars) ||
    stars < 1 ||
    stars > 5
  ) {
    return res.status(400).json({ error: 'invalid' })
  }

  const ip = getClientIp(req.headers)

  const bot = await verifyTurnstile(turnstileToken, ip)
  if (!bot.ok) return res.status(403).json({ error: 'captcha', reason: bot.reason })

  if (!(await checkRateLimit(ip, 'rate'))) return res.status(429).json({ error: 'rate-limited' })

  try {
    const { summary, updated } = await recordRating(db, roadId, raterKey(ip, fingerprint), stars)
    return res.status(200).json({ ok: true, updated, dev: bot.dev ?? false, summary })
  } catch (err) {
    console.error('[ratings] write failed:', err)
    return res.status(503).json({ error: 'unavailable', summary: emptySummary(roadId) })
  }
}
