/**
 * Base map styles. Light = OpenFreeMap "positron" (free, keyless vector tiles).
 * Dark = the same style with every colour run through an HSL lightness
 * inversion, which turns the near-grayscale positron palette into a clean
 * night map without hosting our own style.
 */
import type { Theme } from './theme'

const POSITRON_URL = 'https://tiles.openfreemap.org/styles/positron'

type StyleSpec = Record<string, unknown> & {
  layers?: Array<Record<string, unknown>>
  name?: string
}

let lightStyle: StyleSpec | null = null
let darkStyle: StyleSpec | null = null

export async function buildStyle(theme: Theme): Promise<StyleSpec> {
  if (!lightStyle) {
    const res = await fetch(POSITRON_URL)
    if (!res.ok) throw new Error(`style fetch failed: HTTP ${res.status}`)
    lightStyle = (await res.json()) as StyleSpec
  }
  if (theme === 'light') return lightStyle
  if (!darkStyle) {
    darkStyle = transformToDark(structuredClone(lightStyle))
  }
  return darkStyle
}

/** Minimal offline style so the app still works if the tile CDN is unreachable. */
export function fallbackStyle(theme: Theme): StyleSpec {
  return {
    version: 8,
    name: 'fallback',
    sources: {},
    layers: [
      {
        id: 'bg',
        type: 'background',
        paint: { 'background-color': theme === 'dark' ? '#10131a' : '#f4f1ea' },
      },
    ],
  }
}

// ── colour transformation ──────────────────────────────────────────

function transformToDark(style: StyleSpec): StyleSpec {
  style.name = 'positron-dark'
  for (const layer of style.layers ?? []) {
    const paint = layer.paint as Record<string, unknown> | undefined
    if (paint) {
      for (const key of Object.keys(paint)) {
        if (key.includes('color')) paint[key] = mapColors(paint[key])
      }
    }
    const layout = layer.layout as Record<string, unknown> | undefined
    if (layout) {
      for (const key of Object.keys(layout)) {
        if (key.includes('color')) layout[key] = mapColors(layout[key])
      }
    }
  }
  return style
}

/** Recursively transform colour strings inside a paint value / expression. */
function mapColors(value: unknown): unknown {
  if (typeof value === 'string') {
    const c = parseColor(value)
    return c ? darken(c) : value
  }
  if (Array.isArray(value)) return value.map(mapColors)
  if (value && typeof value === 'object') {
    // stop objects like {stops: [[z, color], ...]}
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = mapColors(v)
    return out
  }
  return value
}

interface RGBA {
  r: number
  g: number
  b: number
  a: number
}

function parseColor(s: string): RGBA | null {
  const str = s.trim().toLowerCase()
  let m = str.match(/^#([0-9a-f]{3})$/)
  if (m) {
    const [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16))
    return { r, g, b, a: 1 }
  }
  m = str.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/)
  if (m) {
    const n = parseInt(m[1], 16)
    return {
      r: (n >> 16) & 255,
      g: (n >> 8) & 255,
      b: n & 255,
      a: m[2] ? parseInt(m[2], 16) / 255 : 1,
    }
  }
  m = str.match(/^rgba?\(([^)]+)\)$/)
  if (m) {
    const parts = m[1].split(',').map((p) => parseFloat(p))
    if (parts.length >= 3) return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 }
  }
  m = str.match(/^hsla?\(([^)]+)\)$/)
  if (m) {
    const parts = m[1].split(',').map((p) => parseFloat(p))
    if (parts.length >= 3) {
      const { r, g, b } = hslToRgb(parts[0] / 360, parts[1] / 100, parts[2] / 100)
      return { r, g, b, a: parts[3] ?? 1 }
    }
  }
  if (str === 'white') return { r: 255, g: 255, b: 255, a: 1 }
  if (str === 'black') return { r: 0, g: 0, b: 0, a: 1 }
  if (str === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  return null
}

function darken(c: RGBA): string {
  let [h, s, l] = rgbToHsl(c.r, c.g, c.b)
  l = (1 - l) * 0.82 + 0.05 // invert lightness, biased dark
  s = Math.min(1, s * 0.72 + 0.02) // gently desaturate
  // keep a whisper of warmth in near-neutrals so the map matches the UI
  if (s < 0.04) {
    h = 0.61 // slate blue
    s = 0.09
  }
  const { r, g, b } = hslToRgb(h, s, l)
  return c.a >= 1
    ? `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`
    : `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${+c.a.toFixed(3)})`
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  if (s === 0) {
    const v = l * 255
    return { r: v, g: v, b: v }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return { r: f(h + 1 / 3) * 255, g: f(h) * 255, b: f(h - 1 / 3) * 255 }
}
