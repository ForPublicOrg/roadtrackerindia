export type Theme = 'light' | 'dark'

const KEY = 'rti-theme'

export interface MapColors {
  categories: { expressway: string; nh: string; sh: string; district: string; local: string }
  casing: string
  labelText: string
  labelHalo: string
  background: string
  /**
   * A stretch's colour by its rounded score: [not rated yet, 1★ … 5★]. The
   * panel's bar paints the same hex from the --score-0..5 tokens in
   * styles.css, so the two have to change together (scripts/contracts.test.mjs
   * fails when they don't).
   */
  scores: [string, string, string, string, string, string]
}

/** 1★ … 5★, the same in both themes — mid tones that read on the cream map
 *  and the dark one. Only "not rated yet" changes, to sink into each. Three
 *  colours, not five, as the legend says: 1-2★ bad, 3★ okay, 4-5★ good. */
const RATED = ['#f03e3e', '#f03e3e', '#fab005', '#2b8a3e', '#2b8a3e'] as const

export const MAP_COLORS: Record<Theme, MapColors> = {
  light: {
    categories: { expressway: '#3b5bdb', nh: '#d9480f', sh: '#2f9e44', district: '#9c6f19', local: '#78838f' },
    casing: '#ffffff',
    labelText: '#3d3830',
    labelHalo: 'rgba(255,255,255,0.92)',
    background: '#f4f1ea',
    scores: ['#adb5bd', ...RATED],
  },
  dark: {
    categories: { expressway: '#8da2fb', nh: '#f4915a', sh: '#6ecb7c', district: '#d4a24c', local: '#93a0af' },
    casing: '#10131a',
    labelText: '#d8d2c6',
    labelHalo: 'rgba(16,19,26,0.9)',
    background: '#10131a',
    scores: ['#5c677d', ...RATED],
  },
}

let current: Theme = 'light'
// picked with the button this visit — still honoured when storage couldn't keep it
let chosen = false

export function getTheme(): Theme {
  return current
}

/** The reader's explicit choice, if any. Reading localStorage throws when the
 *  browser blocks site data, and boot must not die over a colour preference. */
function stored(): Theme | null {
  try {
    return localStorage.getItem(KEY) as Theme | null
  } catch {
    return null
  }
}

export function initTheme(): Theme {
  current = stored() ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  apply(current)
  // follow the OS only while the user hasn't chosen explicitly
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!chosen && !stored()) {
      current = e.matches ? 'dark' : 'light'
      apply(current)
      notify()
    }
  })
  return current
}

export function toggleTheme(): Theme {
  current = current === 'light' ? 'dark' : 'light'
  chosen = true
  apply(current)
  notify()
  try {
    localStorage.setItem(KEY, current)
  } catch {
    /* storage blocked / quota — the switch still works, it just isn't remembered */
  }
  return current
}

function apply(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  document
    .getElementById('meta-theme-color')
    ?.setAttribute('content', MAP_COLORS[theme].background)
  const btn = document.getElementById('btn-theme')
  btn?.setAttribute('aria-label', theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode')
}

type Cb = (t: Theme) => void
const cbs: Cb[] = []
export function onThemeChange(cb: Cb): void {
  cbs.push(cb)
}
function notify(): void {
  cbs.forEach((cb) => cb(current))
}
