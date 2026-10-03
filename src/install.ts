import { toast } from './ui'

/**
 * Installing the site as an app.
 *
 * The manifest and icons are what make the site installable at all; this is
 * the nudge. Chrome, Edge and Samsung Internet hand the page a
 * `beforeinstallprompt` event it can hold on to and fire from its own button.
 * Safari on an iPhone has no such event — the only way in is Share → Add to
 * Home Screen — so there the card says exactly that, rather than offering a
 * button that could not work.
 *
 * The card waits until the reader has been here a little while, stays out of
 * the way of an open sheet on a phone and of report mode (see styles.css), and
 * "Not now" means not for a month. An installed app never sees it.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const KEY = 'rti-install-snooze'
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000
const SETTLE_MS = 25_000

let deferred: BeforeInstallPromptEvent | null = null
let card: HTMLElement | null = null

const MARK = `<svg class="brand-mark" viewBox="0 0 28 28" aria-hidden="true">
  <rect x="1.5" y="1.5" width="25" height="25" rx="7" class="bm-bg" />
  <path d="M9 24 C11 16, 13 12, 19 4" class="bm-road" />
  <path d="M9 24 C11 16, 13 12, 19 4" class="bm-dash" />
</svg>`

const SHARE_ICON = `<svg class="ic-share" viewBox="0 0 20 20" aria-hidden="true">
  <path d="M10 12.5V2.5M6.5 6 10 2.5 13.5 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
  <path d="M7 8.5H5v9h10v-9h-2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
</svg>`

function isInstalled(): boolean {
  return (
    matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/**
 * An iPhone or iPad browser that can add to the home screen: Safari, and since
 * iOS 16.4 Chrome, Edge and Firefox too. In-app browsers (Instagram, Facebook)
 * cannot, and they leave "Safari/" out of their user agent. iPadOS reports
 * itself as a Mac, so a Mac with a touchscreen is an iPad.
 */
function isIosBrowser(): boolean {
  const ua = navigator.userAgent
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  return ios && /Safari\//.test(ua)
}

function snoozed(): boolean {
  return Number(localStorage.getItem(KEY)) > Date.now()
}

function snooze(): void {
  localStorage.setItem(KEY, String(Date.now() + SNOOZE_MS))
}

export function initInstall(): void {
  if (isInstalled()) return
  const start = performance.now()
  const showSoon = (fill: (el: HTMLElement) => void) => {
    if (snoozed()) return
    setTimeout(() => show(fill), Math.max(0, SETTLE_MS - (performance.now() - start)))
  }

  addEventListener('beforeinstallprompt', (e) => {
    // always held, even while snoozed — otherwise Chrome on Android puts up its
    // own install bar and "Not now" would mean nothing
    e.preventDefault()
    deferred = e as BeforeInstallPromptEvent
    showSoon(promptCard)
  })
  addEventListener('appinstalled', () => {
    deferred = null
    hide()
    toast('RoadTracker is installed — open it from your home screen or app list.')
  })
  if (isIosBrowser()) showSoon(iosCard)
}

function promptCard(el: HTMLElement): void {
  const where = matchMedia('(pointer: coarse)').matches ? 'from your home screen' : 'in its own window'
  el.innerHTML = `${MARK}
    <div class="ic-text">
      <strong>Get the RoadTracker app</strong>
      <span>Opens straight to the map ${where}. No app store, nothing to sign up for.</span>
    </div>
    <div class="ic-actions">
      <button type="button" class="ic-later">Not now</button>
      <button type="button" class="ic-go">Install</button>
    </div>`
  el.querySelector('.ic-later')!.addEventListener('click', () => {
    snooze()
    hide()
  })
  el.querySelector('.ic-go')!.addEventListener('click', () => void install())
}

function iosCard(el: HTMLElement): void {
  el.innerHTML = `${MARK}
    <div class="ic-text">
      <strong>Add RoadTracker to your Home Screen</strong>
      <span>Tap ${SHARE_ICON}<b>Share</b>, then <b>Add to Home Screen</b>. On newer iPhones, Share is under the <b>•••</b> button.</span>
    </div>
    <div class="ic-actions">
      <button type="button" class="ic-later">Got it</button>
    </div>`
  el.querySelector('.ic-later')!.addEventListener('click', () => {
    snooze()
    hide()
  })
}

async function install(): Promise<void> {
  const e = deferred
  if (!e) return
  deferred = null // the browser lets a held prompt be shown only once
  hide()
  await e.prompt()
  const { outcome } = await e.userChoice
  // a "no" in the browser's own dialog is the same answer as our "Not now";
  // a "yes" is acknowledged by the appinstalled handler
  if (outcome === 'dismissed') snooze()
}

function show(fill: (el: HTMLElement) => void): void {
  if (card || snoozed() || isInstalled()) return
  // the Chrome card is only worth showing while the prompt it fires is in hand
  if (fill === promptCard && !deferred) return
  card = document.createElement('aside')
  card.className = 'install-card'
  card.setAttribute('aria-label', 'Install RoadTracker as an app')
  fill(card)
  // after #panel inside <main>: styles.css hides the card while a sheet is up
  document.querySelector('main')?.appendChild(card)
}

function hide(): void {
  if (!card) return
  const el = card
  card = null
  el.classList.add('is-leaving')
  setTimeout(() => el.remove(), 260)
}

/**
 * The service worker only stands in for pages that can't load offline (see
 * public/sw.js). Production only — in dev it would sit between Vite and its own
 * reloads — and registered after the page has loaded, so it never competes
 * with the map for the first second of bandwidth.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  const register = () => void navigator.serviceWorker.register('/sw.js').catch(() => {})
  if (document.readyState === 'complete') register()
  else addEventListener('load', register, { once: true })
}
