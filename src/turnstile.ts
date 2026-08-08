/**
 * Cloudflare Turnstile, loaded lazily and rendered in "interaction-only" mode —
 * the widget stays invisible unless Cloudflare actually wants a challenge, so
 * rating a road stays a one-tap action for almost everyone.
 *
 * Without VITE_TURNSTILE_SITE_KEY this is a no-op returning an empty token, and
 * the API treats that as development mode (see api/_lib/integrity.ts). Set both
 * the site key and TURNSTILE_SECRET_KEY before relying on it in production.
 */
const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined

interface Turnstile {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string
  reset: (id?: string) => void
}
declare global {
  interface Window {
    turnstile?: Turnstile
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
/** A challenge the visitor never solves must not hang the rating forever. */
const TOKEN_TIMEOUT_MS = 20_000

let scriptPromise: Promise<void> | null = null
let widgetId: string | undefined
let token = ''
let waiters: ((t: string) => void)[] = []

function loadScript(): Promise<void> {
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = SCRIPT
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => {
      scriptPromise = null // let a later attempt retry rather than fail forever
      reject(new Error('turnstile-script-failed'))
    }
    document.head.appendChild(s)
  })
  return scriptPromise
}

function settle(t: string): void {
  token = t
  waiters.splice(0).forEach((r) => r(t))
}

function ensureWidget(): void {
  if (widgetId != null || !window.turnstile || !SITE_KEY) return
  let host = document.getElementById('turnstile-host')
  if (!host) {
    host = document.createElement('div')
    host.id = 'turnstile-host'
    document.body.appendChild(host)
  }
  widgetId = window.turnstile.render(host, {
    sitekey: SITE_KEY,
    appearance: 'interaction-only',
    callback: (t: string) => settle(t),
    'error-callback': () => settle(''),
    'timeout-callback': () => settle(''),
    // Tokens expire after ~5 minutes; drop ours so the next call asks for a
    // fresh one rather than sending a token the server will reject.
    'expired-callback': () => {
      token = ''
    },
  })
}

/** Resolves a single-use token, or '' when Turnstile isn't configured or fails.
 *  Never rejects: a captcha problem should surface as the API's own error, not
 *  as a thrown exception in the middle of a click handler. */
export async function getTurnstileToken(): Promise<string> {
  if (!SITE_KEY) return ''
  try {
    await loadScript()
  } catch {
    return ''
  }
  ensureWidget()
  if (token) return token
  return new Promise<string>((resolve) => {
    waiters.push(resolve)
    setTimeout(() => {
      waiters = waiters.filter((w) => w !== resolve)
      resolve('')
    }, TOKEN_TIMEOUT_MS)
  })
}

/** Turnstile tokens are single-use: once the server has seen one — accepted or
 *  not — mint a fresh one so the visitor can retry or change their rating
 *  without reloading the page. */
export function resetTurnstile(): void {
  if (!SITE_KEY) return
  token = ''
  try {
    if (widgetId != null) window.turnstile?.reset(widgetId)
  } catch {
    /* widget not rendered yet — nothing to reset */
  }
}
