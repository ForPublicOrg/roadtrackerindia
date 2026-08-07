export type Category = 'nh' | 'expressway' | 'sh' | 'local'
export type Status = 'operational' | 'under-construction' | 'planned'
export type LngLat = [number, number]
export type BBox = [number, number, number, number]

export interface RoadSummary {
  id: string
  ref: string
  name: string
  category: Category
  status: Status
  lengthKm: number
  start: string
  end: string
  states: string[]
  cities: string[]
  bbox: BBox
  aka?: string[]
  completionPercent?: number
}

export interface RoadDetail {
  id: string
  ref: string
  name: string
  category: Category
  status: Status
  lengthKm: number
  route: { start: string; end: string; states: string[]; majorCities: string[] }
  waypoints: { name: string; coords: LngLat }[]
  sources: { title: string; url: string }[]
  aka?: string[]
  completionPercent?: number
  lanes?: string
  agency?: string
  cost?: string
  contractor?: string
  tolls?: { name: string; note?: string }[]
  timeline?: { year: string; event: string }[]
  history?: string
  facts?: string[]
  significance?: string
  engineering?: { name: string; note?: string }[]
  interchanges?: { name: string; note?: string }[]
  relatedRoads?: { id: string; label?: string }[]
  travelNotes?: string
  futureUpgrades?: string[]
  newsQuery?: string
}

export interface NewsItem {
  title: string
  url: string
  source: string
  date: string | null
}

export interface NewsSnapshot {
  generated: string
  query: string
  items: NewsItem[]
}

export interface RoadIndex {
  generated: string
  count: number
  roads: RoadSummary[]
}

export interface NetworkFeature {
  type: 'Feature'
  properties: {
    id: string
    ref: string
    name: string
    category: Category
    status: Status
    lengthKm: number
  }
  geometry: { type: 'LineString'; coordinates: LngLat[] }
}

export interface NetworkFC {
  type: 'FeatureCollection'
  features: NetworkFeature[]
}

export interface ShapeFeature {
  type: 'Feature'
  properties: { id: string; real?: boolean }
  geometry: { type: 'LineString'; coordinates: LngLat[] }
}

export type ReportType = 'pothole' | 'damage' | 'flooding'

export interface ReportItem {
  id: string
  roadId: string
  type: ReportType
  lng: number
  lat: number
  note: string
  createdAt: number
  uid: string
  fixedBy: string[]
  mine: boolean
}

export interface RatingSummary {
  avg: number
  count: number
}

export interface UserStore {
  readonly uid: string
  addReport(r: {
    roadId: string
    type: ReportType
    lng: number
    lat: number
    note: string
  }): Promise<ReportItem>
  removeReport(id: string): Promise<void>
  markFixed(id: string): Promise<void>
  getReportsForRoad(roadId: string): Promise<ReportItem[]>
  getMyReports(): Promise<ReportItem[]>
  setRating(roadId: string, stars: number): Promise<void>
  getMyRating(roadId: string): Promise<number | null>
  getRatingSummary(roadId: string): Promise<RatingSummary | null>
}
