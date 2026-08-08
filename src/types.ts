export type Category = 'nh' | 'expressway' | 'sh' | 'district' | 'local'
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

/** The six standard Indian toll classes. Two-wheelers travel free. */
export type VehicleClass = 'car' | 'lcv' | 'bus' | 'axle3' | 'hcm' | 'oversized'
export type TollRates = Partial<Record<VehicleClass, number>>

export type HelplineKind = 'emergency' | 'complaint' | 'control-room' | 'info'

export interface Helpline {
  kind: HelplineKind
  label: string
  number: string
  note?: string
  /** Filled in by the app when the number is inherited from an organisation. */
  via?: string
}

export interface TollInfo {
  tolled?: boolean
  asOf?: string
  endToEnd?: TollRates
  note?: string
  passes?: string[]
  source?: { title: string; url: string }
}

/** A builder or operator: either a link to an org profile, or a bare name. */
export interface OrgRef {
  org?: string
  name?: string
  note?: string
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
  authority?: string
  builtBy?: OrgRef[]
  operatedBy?: OrgRef[]
  helplines?: Helpline[]
  tollInfo?: TollInfo
  tolls?: { name: string; note?: string; rates?: TollRates }[]
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
  /** "osm" when the route was derived from OpenStreetMap rather than written by hand. */
  provenance?: 'osm'
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

// ── organisations: authorities, builders and operators ──────────────

export type OrgType = 'authority' | 'pwd' | 'psu' | 'developer' | 'contractor' | 'operator'
/** How an organisation is attached to a road. */
export type OrgRole = 'authority' | 'built' | 'operates'

export interface OrgDetail {
  id: string
  name: string
  type: OrgType
  summary: string
  sources: { title: string; url: string }[]
  shortName?: string
  aka?: string[]
  founded?: string
  headquarters?: string
  ownership?: string
  website?: string
  about?: string
  facts?: string[]
  helplines?: Helpline[]
  grievance?: { url?: string; app?: string; email?: string; note?: string }
}

/** One road on an organisation's profile — derived from the road files. */
export interface OrgRoadRef {
  id: string
  /** An organisation can hold more than one role on the same road. */
  roles: OrgRole[]
  /** Per role — a company may have built a road for one reason and run it for another. */
  notes?: Partial<Record<OrgRole, string>>
}

/** Rolled up at build time from every road that links to this organisation. */
export interface OrgStats {
  roadCount: number
  authorityCount: number
  builtCount: number
  operatesCount: number
  lengthKm: number
  /** Sum of the roads whose `cost` could be parsed, in ₹ crore. */
  costCrore: number
  /** How many of those roads had a stated cost — the sum means little without it. */
  costedRoads: number
  underConstruction: number
  states: string[]
}

export interface OrgSummary {
  id: string
  name: string
  shortName?: string
  type: OrgType
  summary: string
  stats: OrgStats
}

export interface OrgIndex {
  generated: string
  count: number
  orgs: OrgSummary[]
}

/** `public/data/org/<id>.json` — the authored file plus its derived road list. */
export interface OrgProfile extends OrgDetail {
  stats: OrgStats
  roads: OrgRoadRef[]
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
  /** `null` means the road is genuinely unrated. A failed lookup rejects — the
   *  two must stay distinguishable or the UI reports "no ratings yet" for a road
   *  it simply could not read. */
  getRatingSummary(roadId: string): Promise<RatingSummary | null>
}
