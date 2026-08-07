import type { RoadSummary } from './types'

const SITE = 'https://roadtrackerindia.com'
const DEFAULT_TITLE = 'RoadTracker India — The living atlas of Indian roads'
const DEFAULT_DESC =
  'Explore every National Highway, Expressway and State Highway of India on one interactive map. Routes, status, toll plazas, history and facts.'

let onRoute: (roadId: string | null) => void = () => {}

export function initRouter(cb: typeof onRoute): void {
  onRoute = cb
  window.addEventListener('popstate', () => onRoute(parsePath(location.pathname)))
}

export function currentRoadId(): string | null {
  return parsePath(location.pathname)
}

function parsePath(path: string): string | null {
  const m = path.match(/^\/road\/([a-z0-9-]+)\/?$/)
  return m ? m[1] : null
}

export function navigateToRoad(road: RoadSummary): void {
  const path = `/road/${road.id}/`
  if (location.pathname !== path && location.pathname !== path.slice(0, -1))
    history.pushState({ roadId: road.id }, '', path)
  applyMeta(road)
}

export function navigateHome(): void {
  if (location.pathname !== '/') history.pushState({}, '', '/')
  applyMeta(null)
}

/** Like navigateHome but without adding a history entry (safe inside popstate). */
export function replaceHome(): void {
  if (location.pathname !== '/') history.replaceState({}, '', '/')
  applyMeta(null)
}

export function applyMeta(road: RoadSummary | null): void {
  const title = road
    ? `${road.ref} — ${road.start.split(',')[0]} to ${road.end.split(',')[0]} | RoadTracker India`
    : DEFAULT_TITLE
  const desc = road
    ? `${road.ref} (${road.name}): ${Math.round(road.lengthKm).toLocaleString('en-IN')} km from ${road.start} to ${road.end}. Route map, status, toll plazas, history and facts.`
    : DEFAULT_DESC
  const url = road ? `${SITE}/road/${road.id}/` : `${SITE}/`

  document.title = title
  setMeta('name', 'description', desc)
  setMeta('property', 'og:title', title)
  setMeta('property', 'og:description', desc)
  setMeta('property', 'og:url', url)
  document.querySelector('link[rel="canonical"]')?.setAttribute('href', url)
}

function setMeta(attr: 'name' | 'property', key: string, value: string): void {
  document.querySelector(`meta[${attr}="${key}"]`)?.setAttribute('content', value)
}
