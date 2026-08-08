/**
 * Server-side write integrity, ported from RankYourPolitician's
 * lib/vote-integrity.ts. Layered, and honest about limits: no login-less system
 * is sybil-proof. We (1) verify a Cloudflare Turnstile token, (2) rate-limit on
 * a hashed, coarsened IP, and (3) dedupe on a salted hash of
 * (coarse IP + device fingerprint). We NEVER store raw IPs or fingerprints —
 * only the derived key, which is what makes "one rating per road" possible
 * without holding any identity for the person who cast it.
 */
import { createHash } from 'node:crypto'

const SALT = process.env.VOTE_HASH_SALT || 'dev-only-change-me'

// A production deploy still on the built-in dev salt has effectively unsalted
// dedupe hashes: the salt is the only thing stopping someone who can guess a
// visitor's coarse IP + fingerprint from recomputing their key. The remedy is an
// ops step (set a strong random VOTE_HASH_SALT), so we WARN loudly rather than
// throw — an unset env var must not take the whole write path down.
if (process.env.NODE_ENV === 'production' && SALT === 'dev-only-change-me') {
  console.error(
    '[integrity] CRITICAL: VOTE_HASH_SALT is unset or still the default dev ' +
      'value in production. Set a strong random VOTE_HASH_SALT to protect ' +
      'rating-dedupe hashes.',
  )
}

/** The client IP that seeds the dedupe and rate-limit keys. It must come from a
 *  header the PLATFORM controls, not the client: on any deployment whose edge
 *  proxy APPENDS to x-forwarded-for instead of overwriting it, the leftmost
 *  entries are whatever the client sent, and a curl loop forging them would mint
 *  a fresh key per request. Trust order:
 *  1. x-vercel-forwarded-for — written by Vercel itself.
 *  2. x-real-ip — only ever set by a reverse proxy, never forwarded by a client.
 *  3. x-forwarded-for LAST entry — the hop appended by the proxy in front of us;
 *     everything to its left is unverified. */
export function getClientIp(headers: Record<string, string | string[] | undefined>): string {
  const one = (v: string | string[] | undefined): string =>
    (Array.isArray(v) ? v[0] : v)?.trim() ?? ''
  const vff = one(headers['x-vercel-forwarded-for'])
  if (vff) return vff.split(',')[0].trim()
  const realIp = one(headers['x-real-ip'])
  if (realIp) return realIp
  const xff = one(headers['x-forwarded-for'])
  if (xff) {
    const parts = xff.split(',')
    return parts[parts.length - 1].trim()
  }
  return '0.0.0.0'
}

/** Coarsen to a /24 (IPv4) or /48 (IPv6) so shared NAT doesn't over-collapse —
 *  a whole office on one public IP should not be treated as one rater. */
export function coarsenIp(ip: string): string {
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + '::/48'
  const parts = ip.split('.')
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.0/24` : ip
}

export function sha(input: string): string {
  return createHash('sha256').update(`${SALT}:${input}`).digest('hex').slice(0, 32)
}

/** Deterministic per-rater key: both the coarse IP AND the fingerprint must
 *  match to count as the same person (avoids collapsing a whole campus). */
export function raterKey(ip: string, fingerprint: string): string {
  return sha(`${coarsenIp(ip)}|${fingerprint || 'none'}`)
}

export function ipRateKey(ip: string): string {
  return sha(coarsenIp(ip))
}

// ── Turnstile ──────────────────────────────────────────────────────

export interface TurnstileResult {
  ok: boolean
  dev?: boolean
  reason?: string
}

export async function verifyTurnstile(token: string, ip: string): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY
  // Not configured → development mode: allow, but flag it in the response so a
  // misconfigured production deploy is visible rather than silently open.
  if (!secret) return { ok: true, dev: true }
  if (!token) return { ok: false, reason: 'missing-token' }
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
    })
    const data = (await res.json()) as { success: boolean; 'error-codes'?: string[] }
    return { ok: data.success, reason: data['error-codes']?.join(',') }
  } catch {
    return { ok: false, reason: 'verify-failed' }
  }
}

// ── Rate limiting ──────────────────────────────────────────────────
// Upstash sliding window when configured, else an in-process fallback. The
// fallback is per-lambda-instance and therefore weak — it is a speed bump for
// casual abuse, not a real control. Configure Upstash before relying on it.

type Limiter = (key: string) => Promise<{ success: boolean }>

let limiter: Limiter | null = null
const memHits = new Map<string, number[]>()

function memLimiter(limit: number, windowMs: number): Limiter {
  return async (key: string) => {
    const now = Date.now()
    const arr = (memHits.get(key) || []).filter((t) => now - t < windowMs)
    arr.push(now)
    memHits.set(key, arr)
    return { success: arr.length <= limit }
  }
}

async function getLimiter(limit: number): Promise<Limiter> {
  if (limiter) return limiter
  const url = process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
  if (url && token) {
    try {
      const { Ratelimit } = await import('@upstash/ratelimit')
      const { Redis } = await import('@upstash/redis')
      const rl = new Ratelimit({
        redis: new Redis({ url, token }),
        limiter: Ratelimit.slidingWindow(limit, '1 h'),
        prefix: 'rti:write',
      })
      limiter = async (key: string) => {
        const { success } = await rl.limit(key)
        return { success }
      }
      return limiter
    } catch {
      // @upstash/* not installed — fall through to memory.
    }
  }
  limiter = memLimiter(limit, 60 * 60 * 1000)
  return limiter
}

/** `scope` keeps rating and report budgets separate, so a burst of ratings
 *  cannot lock someone out of reporting a genuine hazard. */
export async function checkRateLimit(ip: string, scope: string, limit = 20): Promise<boolean> {
  const rl = await getLimiter(limit)
  const { success } = await rl(`${scope}:${ipRateKey(ip)}`)
  return success
}
