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
): void {
  const token = ++drawToken
  const glow = withAlpha(color, 0.28)
  const glowClear = withAlpha(color, 0)
  const lineClear = withAlpha(color, 0)

  const apply = (p: number) => {
    if (!map.getLayer('selected-line')) return
    map.setPaintProperty('selected-line', 'line-gradient', gradientExpr(color, lineClear, p))
    map.setPaintProperty('selected-glow', 'line-gradient', gradientExpr(glow, glowClear, p))
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
