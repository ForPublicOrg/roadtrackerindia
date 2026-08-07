/**
 * User-generated content (reports + ratings) is stored ONLY in Cloud Firestore
 * (./firestore.ts, lazy-loaded). Config comes from the VITE_FIREBASE_CONFIG
 * env var (baked in at build time) or a gitignored /firebase-config.json for
 * local development. When Firestore is unavailable the community features
 * surface an "unavailable" state — there is no device-local fallback.
 */
import type { UserStore } from './types'

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

function envConfig(): FirebaseCfg | null {
  const raw = import.meta.env.VITE_FIREBASE_CONFIG as string | undefined
  if (!raw) return null
  const cfg = parseConfig(raw)
  if (!cfg) console.warn('[storage] VITE_FIREBASE_CONFIG could not be parsed.')
  return cfg
}

async function fileConfig(): Promise<FirebaseCfg | null> {
  try {
    const res = await fetch('/firebase-config.json', { cache: 'no-store' })
    if (!res.ok) return null
    return parseConfig(await res.text())
  } catch {
    return null
  }
}

let storePromise: Promise<UserStore> | null = null

/** Resolves the Firestore-backed store, or rejects with a human-readable
 *  reason. Failures are not cached — the next call retries. */
export function getStore(): Promise<UserStore> {
  if (!storePromise) {
    storePromise = connect().catch((e) => {
      storePromise = null
      throw e
    })
  }
  return storePromise
}

async function connect(): Promise<UserStore> {
  const cfg = envConfig() ?? (await fileConfig())
  if (!cfg?.apiKey || !cfg.projectId || cfg.apiKey.startsWith('PASTE')) {
    const reason = cfg
      ? 'Firebase config found but apiKey/projectId missing or placeholder'
      : 'no Firebase config (set the VITE_FIREBASE_CONFIG env var — see docs/FIREBASE.md)'
    console.warn(`[storage] community features disabled — ${reason}`)
    throw new Error(reason)
  }
  try {
    const { CloudStore } = await import('./firestore')
    const store = new CloudStore()
    await store.init(cfg as Record<string, string>)
    console.info(`[storage] Firestore connected — project "${cfg.projectId}"`)
    return store
  } catch (e) {
    const code = (e as { code?: string })?.code
    const reason =
      code === 'auth/admin-restricted-operation' || code === 'auth/operation-not-allowed'
        ? `Firestore init failed (${code}) — enable ANONYMOUS sign-in: Firebase console → Authentication → Sign-in method → Anonymous`
        : code === 'auth/unauthorized-domain'
          ? `Firestore init failed (${code}) — add this site's domain: Firebase console → Authentication → Settings → Authorized domains`
          : `Firestore init failed (${code ?? (e as Error)?.message ?? e})`
    console.warn(`[storage] community features disabled — ${reason}`)
    throw new Error(reason)
  }
}
