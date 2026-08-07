export type Theme = 'light' | 'dark'

const KEY = 'rti-theme'

export interface MapColors {
  categories: { expressway: string; nh: string; sh: string; district: string; local: string }
  casing: string
  labelText: string
  labelHalo: string
  background: string
}

export const MAP_COLORS: Record<Theme, MapColors> = {
  light: {
    categories: { expressway: '#3b5bdb', nh: '#d9480f', sh: '#2f9e44', district: '#9c6f19', local: '#78838f' },
    casing: '#ffffff',
    labelText: '#3d3830',
    labelHalo: 'rgba(255,255,255,0.92)',
    background: '#f4f1ea',
  },
  dark: {
    categories: { expressway: '#8da2fb', nh: '#f4915a', sh: '#6ecb7c', district: '#d4a24c', local: '#93a0af' },
    casing: '#10131a',
    labelText: '#d8d2c6',
    labelHalo: 'rgba(16,19,26,0.9)',
    background: '#10131a',
  },
}

let current: Theme = 'light'

export function getTheme(): Theme {
  return current
}

export function initTheme(): Theme {
  const stored = localStorage.getItem(KEY) as Theme | null
  current = stored ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  apply(current)
  // follow the OS only while the user hasn't chosen explicitly
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
    if (!localStorage.getItem(KEY)) {
      current = e.matches ? 'dark' : 'light'
      apply(current)
      notify()
    }
  })
  return current
}

export function toggleTheme(): Theme {
  current = current === 'light' ? 'dark' : 'light'
  localStorage.setItem(KEY, current)
  apply(current)
  notify()
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
