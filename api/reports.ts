/**
 * Community road-problem reports.
 *
 * GET    /api/reports?roadId=nh-44
 * POST   /api/reports   {roadId, type, lng, lat, note, fingerprint, turnstileToken}
 * DELETE /api/reports   {id, fingerprint, turnstileToken}
 *
 * Anyone may delete any report: stale reports outlive the pothole and their
 * author rarely comes back to clear them. Turnstile and the rate limit are what
 * keep "anyone can delete" from meaning "one script can wipe the map", and the
 * delete is soft, so a bad one is recoverable from the Firebase console.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getDb, isFirestoreConfigured } from './_lib/db.js'
import { checkRateLimit, getClientIp, verifyTurnstile } from './_lib/integrity.js'
import {
  REPORT_TYPES,
  addReport,
  getReportsByIds,
  listReports,
  softDeleteReport,
  type ReportType,
} from './_lib/reports-store.js'

const ROAD_ID = /^[a-z0-9][a-z0-9-]{0,99}$/
const NOTE_MAX = 280

/** India's bounding box — the same constraint the old security rules enforced. */
const inIndia = (lng: number, lat: number) =>
  lng > 60 && lng < 100 && lat > 5 && lat < 38

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const db = getDb()
  if (!db) {
    if (isFirestoreConfigured()) console.error('[reports] Firestore configured but unavailable')
    return res.status(503).json({ error: 'unavailable' })
  }

  if (req.method === 'GET') {
    // ?ids= resolves specific reports (a visitor's own pins from earlier
    // visits); ?roadId= lists everything on one road.
    const rawIds = typeof req.query.ids === 'string' ? req.query.ids : ''
    if (rawIds) {
      const ids = rawIds
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s && s.length <= 200)
        .slice(0, 100)
      if (!ids.length) return res.status(400).json({ error: 'bad-request' })
      try {
        const reports = await getReportsByIds(db, ids)
        res.setHeader('cache-control', 'private, no-store')
        return res.status(200).json({ ok: true, reports })
      } catch (err) {
        console.error('[reports] id lookup failed:', err)
        return res.status(503).json({ error: 'unavailable' })
      }
    }

    const roadId = typeof req.query.roadId === 'string' ? req.query.roadId.trim() : ''
    if (!ROAD_ID.test(roadId)) return res.status(400).json({ error: 'bad-request' })
    try {
      const reports = await listReports(db, roadId)
      // Shorter than the ratings cache: a new hazard should appear quickly, and
      // a deleted one should stop being shown quickly.
      res.setHeader('cache-control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=120')
      return res.status(200).json({ ok: true, reports })
    } catch (err) {
      console.error('[reports] read failed:', err)
      return res.status(503).json({ error: 'unavailable' })
    }
  }

  if (req.method !== 'POST' && req.method !== 'DELETE') {
    res.setHeader('allow', 'GET, POST, DELETE')
    return res.status(405).json({ error: 'method-not-allowed' })
  }

  const body = (req.body ?? {}) as {
    id?: string
    roadId?: string
    type?: string
    lng?: number
    lat?: number
    note?: string
    fingerprint?: string
    turnstileToken?: string
  }
  const ip = getClientIp(req.headers)

  const bot = await verifyTurnstile(body.turnstileToken ?? '', ip)
  if (!bot.ok) return res.status(403).json({ error: 'captcha', reason: bot.reason })

  if (!(await checkRateLimit(ip, 'report'))) return res.status(429).json({ error: 'rate-limited' })

  if (req.method === 'DELETE') {
    // Accept the id from the query too — some proxies drop DELETE bodies.
    const id = (body.id ?? (typeof req.query.id === 'string' ? req.query.id : '')).trim()
    if (!id || id.length > 200) return res.status(400).json({ error: 'invalid' })
    try {
      const removed = await softDeleteReport(db, id)
      if (!removed) return res.status(404).json({ error: 'not-found' })
      return res.status(200).json({ ok: true })
    } catch (err) {
      console.error('[reports] delete failed:', err)
      return res.status(503).json({ error: 'unavailable' })
    }
  }

  const { roadId = '', type = '', lng, lat, note = '' } = body
  if (
    !ROAD_ID.test(roadId) ||
    !REPORT_TYPES.includes(type as ReportType) ||
    typeof lng !== 'number' ||
    typeof lat !== 'number' ||
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    !inIndia(lng, lat) ||
    typeof note !== 'string' ||
    note.length > NOTE_MAX
  ) {
    return res.status(400).json({ error: 'invalid' })
  }

  try {
    const report = await addReport(db, {
      roadId,
      type: type as ReportType,
      lng,
      lat,
      note: note.trim(),
    })
    return res.status(200).json({ ok: true, dev: bot.dev ?? false, report })
  } catch (err) {
    console.error('[reports] write failed:', err)
    return res.status(503).json({ error: 'unavailable' })
  }
}
