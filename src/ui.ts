export function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

// ── toasts ─────────────────────────────────────────────────────────

interface ToastOpts {
  action?: { label: string; cb: () => void }
  duration?: number
}

export function toast(message: string, opts: ToastOpts = {}): void {
  const host = document.getElementById('toasts')
  if (!host) return
  while (host.children.length >= 3) host.firstElementChild?.remove()

  const el = document.createElement('div')
  el.className = 'toast'
  const span = document.createElement('span')
  span.textContent = message
  el.appendChild(span)
  if (opts.action) {
    const btn = document.createElement('button')
    btn.textContent = opts.action.label
    btn.addEventListener('click', () => {
      opts.action!.cb()
      dismiss()
    })
    el.appendChild(btn)
  }
  host.appendChild(el)

  let dismissed = false
  let timer = 0
  const dismiss = () => {
    if (dismissed) return
    dismissed = true
    el.classList.add('is-leaving')
    setTimeout(() => el.remove(), 260)
  }
  // pause the auto-dismiss while hovered or focused so the action stays reachable
  const arm = (ms: number) => {
    clearTimeout(timer)
    timer = window.setTimeout(dismiss, ms)
  }
  el.addEventListener('mouseenter', () => clearTimeout(timer))
  el.addEventListener('focusin', () => clearTimeout(timer))
  el.addEventListener('mouseleave', () => arm(2500))
  el.addEventListener('focusout', () => arm(2500))
  arm(opts.duration ?? (opts.action ? 8000 : 4200))
}

// ── legend ─────────────────────────────────────────────────────────

export function initLegend(): void {
  const legend = document.getElementById('legend')
  const btn = document.getElementById('legend-toggle')
  if (!legend || !btn) return
  const small = matchMedia('(max-width: 768px)').matches
  // reading storage throws when the browser blocks site data, and this runs
  // before anything else in boot — a throw here would leave the app unwired
  let stored: string | null = null
  try {
    stored = localStorage.getItem('rti-legend')
  } catch {
    /* blocked — fall back to the screen-size default */
  }
  let collapsed = stored ? stored === '0' : small
  const apply = () => {
    legend.classList.toggle('is-collapsed', collapsed)
    btn.setAttribute('aria-expanded', String(!collapsed))
  }
  btn.addEventListener('click', () => {
    collapsed = !collapsed
    try {
      localStorage.setItem('rti-legend', collapsed ? '0' : '1')
    } catch {
      /* storage blocked / quota — the toggle still works, it just isn't remembered */
    }
    apply()
  })
  apply()
}

// ── tiny helpers ───────────────────────────────────────────────────

export const CATEGORY_LABEL: Record<string, string> = {
  nh: 'National Highway',
  expressway: 'Expressway',
  sh: 'State Highway',
  district: 'District road',
  local: 'City road',
}

export const STATUS_LABEL: Record<string, string> = {
  operational: 'Open',
  'under-construction': 'Being built',
  planned: 'Planned',
}

export function relTime(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} day${d > 1 ? 's' : ''} ago`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo} month${mo > 1 ? 's' : ''} ago`
  // pluralise what is printed: 18 months rounds to "2 year", not "1 year"
  const y = Math.round(mo / 12)
  return `${y} year${y > 1 ? 's' : ''} ago`
}
