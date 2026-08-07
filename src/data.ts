import type {
  NetworkFC,
  NewsSnapshot,
  OrgIndex,
  OrgProfile,
  RoadDetail,
  RoadIndex,
  ShapeFeature,
} from './types'

const cache = new Map<string, unknown>()

async function getJSON<T>(url: string): Promise<T> {
  if (cache.has(url)) return cache.get(url) as T
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`)
  const data = (await res.json()) as T
  cache.set(url, data)
  return data
}

export const loadIndex = () => getJSON<RoadIndex>('/data/index.json')
export const loadNetwork = () => getJSON<NetworkFC>('/data/network-lite.geojson')
/** State + district roads — only worth downloading once the map is zoomed in. */
export const loadNetworkDetail = () => getJSON<NetworkFC>('/data/network-detail.geojson')
export const loadDetail = (id: string) => getJSON<RoadDetail>(`/data/roads/${id}.json`)
export const loadShape = (id: string) => getJSON<ShapeFeature>(`/data/shapes/${id}.json`)
export const loadNews = (id: string) => getJSON<NewsSnapshot>(`/data/news/${id}.json`)
export const loadOrgIndex = () => getJSON<OrgIndex>('/data/orgs.json')
export const loadOrg = (id: string) => getJSON<OrgProfile>(`/data/org/${id}.json`)
