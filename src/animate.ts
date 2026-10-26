import type maplibregl from 'maplibre-gl'

export function prefersReducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches
}

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
export const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

// ── route draw-on animation (GPU line-gradient sweep) ─────────────

let drawToken = 0

function gradientExpr(color: string, transparent: string, p: number): unknown {
  if (p >= 1) return color
  const head = Math.max(p, 0.0001)
  const tail = Math.max(head - 0.035, 0)
  if (head <= 0.0002) return transparent
  const expr: unknown[] = ['interpolate', ['linear'], ['line-progress']]
  if (tail > 0) expr.push(0, color, tail, color)
  else expr.push(0, color)
  expr.push(head, transparent)
  if (head < 1) expr.push(Math.min(head + 0.0001, 1), transparent)
  return expr
}

/**
 * The same sweep over a line with holes in it, as line-progress ranges: the
 * line stays one line, so the sweep runs on across a hole it does not draw.
 * Every point where either changes is a stop, given the sweep's opacity there,
 * or none just inside a hole.
 */
function holedGradientExpr(hex: string, alpha: number, p: number, holes: readonly Hole[]): unknown {
  if (p < 1 && Math.max(p, 0.0001) <= 0.0002) return withAlpha(hex, 0)
  const head = p >= 1 ? Infinity : Math.max(p, 0.0001)
  const tail = Math.max(head - 0.035, 0)
  const sweep = (q: number) => (q <= tail ? 1 : q >= head ? 0 : (head - q) / (head - tail))
  const inHole = (q: number) => holes.some(([a, b]) => q > a && q < b)
  const EDGE = 0.00001
  const at = new Set([0, 1])
  for (const q of [tail, head, head + 0.0001]) if (q > 0 && q < 1) at.add(q)
  for (const [a, b] of holes) for (const q of [a, a + EDGE, b - EDGE, b]) if (q >= 0 && q <= 1) at.add(q)
  const expr: unknown[] = ['interpolate', ['linear'], ['line-progress']]
  for (const q of [...at].sort((x, y) => x - y)) expr.push(q, withAlpha(hex, inHole(q) ? 0 : alpha * sweep(q)))
  return expr
}

/** A stretch of a line left undrawn, as [from, to] in line-progress (0–1). */
export type Hole = [number, number]

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

/**
 * Animate the selected road "drawing" itself along its length.
 * Interruptible: any later call (or cancelDraw) stops this one.
 */
export function drawRoute(
  map: maplibregl.Map,
  color: string,
  durationMs: number,
  onDone?: () => void,
  holes: readonly Hole[] = [],
): void {
  const token = ++drawToken
  const glow = withAlpha(color, 0.28)
  const glowClear = withAlpha(color, 0)
  const lineClear = withAlpha(color, 0)

  const apply = (p: number) => {
    if (!map.getLayer('selected-line')) return
    map.setPaintProperty(
      'selected-line',
      'line-gradient',
      holes.length ? holedGradientExpr(color, 1, p, holes) : gradientExpr(color, lineClear, p),
    )
    map.setPaintProperty(
      'selected-glow',
      'line-gradient',
      holes.length ? holedGradientExpr(color, 0.28, p, holes) : gradientExpr(glow, glowClear, p),
    )
  }

  if (prefersReducedMotion() || durationMs <= 0 || document.visibilityState === 'hidden') {
    apply(1)
    onDone?.()
    return
  }

  const start = performance.now()
  const frame = (now: number) => {
    if (token !== drawToken) return
    const t = Math.min(1, (now - start) / durationMs)
    apply(easeInOutCubic(t))
    if (t < 1) requestAnimationFrame(frame)
    else onDone?.()
  }
  apply(0)
  requestAnimationFrame(frame)
}

export function cancelDraw(): void {
  drawToken++
}

// ── generic spring (used by the mobile bottom sheet) ──────────────

export interface SpringHandle {
  cancel: () => void
}

export function spring(
  from: number,
  to: number,
  onUpdate: (v: number) => void,
  onDone?: () => void,
  opts: { stiffness?: number; damping?: number; velocity?: number } = {},
): SpringHandle {
  if (prefersReducedMotion() || document.visibilityState === 'hidden') {
    onUpdate(to)
    onDone?.()
    return { cancel: () => {} }
  }
  const stiffness = opts.stiffness ?? 340
  const damping = opts.damping ?? 32
  let v = opts.velocity ?? 0
  let x = from
  let raf = 0
  let last = performance.now()
  const tick = (now: number) => {
    const dt = Math.min(0.048, (now - last) / 1000)
    last = now
    const accel = -stiffness * (x - to) - damping * v
    v += accel * dt
    x += v * dt
    if (Math.abs(x - to) < 0.4 && Math.abs(v) < 4) {
      onUpdate(to)
      onDone?.()
      return
    }
    onUpdate(x)
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  return { cancel: () => cancelAnimationFrame(raf) }
}
