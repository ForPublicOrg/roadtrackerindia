/**
 * Firebase Admin handle (server-only). The browser has no Firebase SDK at all
 * any more, so this is the ONLY path to Firestore — which is what lets
 * firestore.rules deny everything (the Admin SDK bypasses rules).
 *
 * Ported from RankYourPolitician's lib/firebase-admin.ts.
 */
import { cert, getApps, initializeApp, applicationDefault, type App } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'

let _db: Firestore | null | undefined

export function isFirestoreConfigured(): boolean {
  return Boolean(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS,
  )
}

function initApp(): App {
  const existing = getApps()[0]
  if (existing) return existing

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  if (raw) {
    const svc = JSON.parse(raw) as { private_key?: string; project_id?: string }
    // Vercel stores multi-line private keys with escaped newlines.
    if (typeof svc.private_key === 'string') {
      svc.private_key = svc.private_key.replace(/\\n/g, '\n')
    }
    return initializeApp({
      credential: cert(svc as Parameters<typeof cert>[0]),
      projectId: svc.project_id || process.env.FIREBASE_PROJECT_ID,
    })
  }
  return initializeApp({ credential: applicationDefault() })
}

/** Returns a Firestore handle, or null when Firestore isn't configured. */
export function getDb(): Firestore | null {
  // A resolved handle, or the cached null of credential-less mode, is returned
  // directly. A FAILED init is deliberately NOT cached (see below).
  if (_db !== undefined) return _db
  if (!isFirestoreConfigured()) {
    // No credentials at all: this instance can never gain them at runtime, so
    // caching the null is safe.
    _db = null
    return _db
  }
  try {
    return (_db = getFirestore(initApp()))
  } catch (err) {
    // Credentials ARE present but init threw (transient, or a malformed key
    // mid-deploy). Do NOT cache null: that would downgrade this instance for its
    // whole lifetime after one hiccup. Leaving _db undefined retries next call.
    console.error('[db] Firestore init failed (credentials present); will retry:', err)
    return null
  }
}
