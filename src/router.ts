import type { OrgSummary, RoadSummary } from './types'

const SITE = 'https://roadtrackerindia.com'
const DEFAULT_TITLE = 'RoadTracker India — The living atlas of Indian roads'
const DEFAULT_DESC =
  'Explore every National Highway, Expressway and State Highway of India on one interactive map. Routes, status, toll plazas, history and facts.'

export type Route = { kind: 'road' | 'org'; id: string } | null

let onRoute: (route: Route) => void = () => {}

export function initRouter(cb: typeof onRoute): void {
  onRoute = cb
  window.addEventListener('popstate', () => onRoute(parsePath(location.pathname)))
}

export function currentRoute(): Route {
  return parsePath(location.pathname)
}

function parsePath(path: string): Route {
  const road = path.match(/^\/road\/([a-z0-9-]+)\/?$/)
  if (road) return { kind: 'road', id: road[1] }
  const org = path.match(/^\/company\/([a-z0-9-]+)\/?$/)
  if (org) return { kind: 'org', id: org[1] }
  return null
}

export function navigateToRoad(road: RoadSummary): void {
  const path = `/road/${road.id}/`
  if (location.pathname !== path && location.pathname !== path.slice(0, -1))
    history.pushState({ roadId: road.id }, '', path)
  applyMeta(road)
}

export function navigateToOrg(org: OrgSummary): void {
  const path = `/company/${org.id}/`
  if (location.pathname !== path && location.pathname !== path.slice(0, -1))
    history.pushState({ orgId: org.id }, '', path)
  applyOrgMeta(org)
}

export function applyOrgMeta(org: OrgSummary): void {
  const km = org.stats.lengthKm
  const title = `${org.shortName ?? org.name} — roads built and managed | RoadTracker India`
  const desc =
    `${org.name}: ${org.summary} ` +
    (org.stats.roadCount
      ? `${org.stats.roadCount} road${org.stats.roadCount === 1 ? '' : 's'} on RoadTracker, ${km.toLocaleString('en-IN')} km in total.`
      : '')
  setAll(title, desc.slice(0, 300), `${SITE}/company/${org.id}/`)
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
  // a ring road ends where it starts, and "Bengaluru to Bengaluru" reads as a
  // mistake rather than as a loop
  const loops = road ? road.start === road.end : false
  const title = road
    ? loops
      ? `${road.ref} — around ${road.start.split(',')[0]} | RoadTracker India`
      : `${road.ref} — ${road.start.split(',')[0]} to ${road.end.split(',')[0]} | RoadTracker India`
    : DEFAULT_TITLE
  const where = road
    ? loops
      ? `${Math.round(road.lengthKm).toLocaleString('en-IN')} km right around ${road.start}`
      : `${Math.round(road.lengthKm).toLocaleString('en-IN')} km from ${road.start} to ${road.end}`
    : ''
  const desc = road
    ? `${road.ref} (${road.name}): ${where}. Route map, status, toll charges, emergency numbers, history and facts.`
    : DEFAULT_DESC
  setAll(title, desc, road ? `${SITE}/road/${road.id}/` : `${SITE}/`)
}

function setAll(title: string, desc: string, url: string): void {
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
