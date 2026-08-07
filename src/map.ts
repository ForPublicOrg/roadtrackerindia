import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { BBox, Category, NetworkFC, ShapeFeature } from './types'
import { getTheme, MAP_COLORS, onThemeChange, type Theme } from './theme'
import { buildStyle, fallbackStyle } from './mapstyle'
import { cancelDraw, drawRoute, easeOutCubic, prefersReducedMotion } from './animate'

const INDIA_BOUNDS: [[number, number], [number, number]] = [
  [67.8, 6.7],
  [97.5, 36.2],
]

const EMPTY_FC = { type: 'FeatureCollection', features: [] } as unknown as GeoJSON.GeoJSON

/**
 * State and district roads outnumber the trunk network ten to one and are
 * unreadable below this zoom, so they load only once someone gets close enough
 * to want them.
 */
const DETAIL_ZOOM = 7.2

let map: maplibregl.Map
let networkFC: NetworkFC | null = null
let detailFC: NetworkFC | null = null
let detailRequested = false
let detailNeededCb: () => void = () => {}
let selectedShape: ShapeFeature | null = null
let selectedCategory: Category = 'nh'
let dimmed = false
/** Road ids to light up for an organisation, remembered until the layers exist. */
let highlightIds: string[] | null = null
let hovered: { source: string; id: string } | null = null
let usingFallbackStyle = false

let roadClickCb: (id: string, lngLat: [number, number]) => void = () => {}
let baseClickCb: (lngLat: [number, number]) => void = () => {}

const tip = document.createElement('div')
tip.className = 'road-tip'
document.body.appendChild(tip)

export function getMap(): maplibregl.Map {
  return map
}

export function onRoadClick(cb: typeof roadClickCb): void {
  roadClickCb = cb
}
export function onBaseClick(cb: typeof baseClickCb): void {
  baseClickCb = cb
}

export async function initMap(): Promise<maplibregl.Map> {
  let style
  try {
    style = await buildStyle(getTheme())
    usingFallbackStyle = false
  } catch {
    style = fallbackStyle(getTheme())
    usingFallbackStyle = true
    showNetBanner()
  }

  map = new maplibregl.Map({
    container: 'map',
    style: style as never,
    center: [80.5, 22.6],
    zoom: 3.8,
    minZoom: 3.1,
    maxZoom: 17.5,
    attributionControl: false,
    fadeDuration: prefersReducedMotion() ? 0 : 300,
  })
  map.addControl(
    new maplibregl.AttributionControl({
      compact: true,
      customAttribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>',
    }),
    'bottom-right',
  )
  map.touchZoomRotate.disableRotation()
  map.keyboard.enable()

  map.fitBounds(INDIA_BOUNDS, { padding: fitPaddingHome(), duration: 0 })

  // Only a sustained burst of failures while offline earns the scary banner —
  // single aborted tiles (camera jumps, wifi flickers) are normal noise.
  let netErrors = 0
  let netErrorWindowStart = 0
  map.on('error', (e) => {
    const msg = (e as { error?: { message?: string } }).error?.message ?? ''
    if (!/fetch|network|Failed/i.test(msg)) return
    const now = Date.now()
    if (now - netErrorWindowStart > 5000) {
      netErrorWindowStart = now
      netErrors = 0
    }
    if (++netErrors >= 6 && !navigator.onLine) showNetBanner()
  })
  // a wifi blip can raise the banner — clear it once the map settles again,
  // and climb out of the offline fallback style as soon as we're back online
  map.on('idle', () => {
    if (!usingFallbackStyle) hideNetBanner()
  })
  window.addEventListener('online', () => {
    if (usingFallbackStyle) void retryStyle()
  })

  // Never block the app on tile loading (patchy networks are the norm):
  // layers attach as soon as the style itself is ready, before any tiles.
  map.once('style.load', () => {
    addAppLayers()
    restoreSelection()
  })
  wireInteractions()

  onThemeChange((theme) => void swapTheme(theme))

  document.getElementById('net-retry')?.addEventListener('click', () => {
    hideNetBanner()
    void retryStyle()
  })

  return map
}

function showNetBanner(): void {
  document.getElementById('net-banner')?.removeAttribute('hidden')
}
function hideNetBanner(): void {
  document.getElementById('net-banner')?.setAttribute('hidden', '')
}

async function retryStyle(): Promise<void> {
  try {
    const style = await buildStyle(getTheme())
    usingFallbackStyle = false
    applyStyle(style)
  } catch {
    usingFallbackStyle = true
    showNetBanner()
  }
}

async function swapTheme(theme: Theme): Promise<void> {
  let style
  try {
    style = usingFallbackStyle ? fallbackStyle(theme) : await buildStyle(theme)
  } catch {
    style = fallbackStyle(theme)
  }
  applyStyle(style)
}

/**
 * Swap the base style and re-attach app layers. The 'style.load' listener is
 * registered BEFORE setStyle (which can fire it synchronously on the diff
 * path), and diffing is disabled so our sources/layers are rebuilt cleanly.
 */
function applyStyle(style: unknown): void {
  clearHover()
  map.once('style.load', () => {
    addAppLayers()
    restoreSelection()
  })
  map.setStyle(style as never, { diff: false })
}

function restoreSelection(): void {
  if (selectedShape) {
    const src = map.getSource('selected') as maplibregl.GeoJSONSource | undefined
    src?.setData(selectedShape as never)
    drawRoute(map, MAP_COLORS[getTheme()].categories[selectedCategory], 0)
    applyDim()
  }
}

// ── layers ─────────────────────────────────────────────────────────

function categoryColorExpr(theme: Theme): unknown {
  const c = MAP_COLORS[theme].categories
  return [
    'match',
    ['get', 'category'],
    'expressway', c.expressway,
    'nh', c.nh,
    'sh', c.sh,
    'district', c.district,
    c.local,
  ]
}

function hoverWidth(base: number, hovered: number): unknown {
  return ['case', ['boolean', ['feature-state', 'hover'], false], hovered, base]
}

export function addAppLayers(): void {
  if (map.getSource('network')) return
  const theme = getTheme()
  const colors = MAP_COLORS[theme]

  // slot our lines beneath the base map's labels so place names stay readable
  const firstSymbol = map.getStyle().layers?.find((l) => l.type === 'symbol')?.id

  map.addSource('network', {
    type: 'geojson',
    data: (networkFC ?? EMPTY_FC) as never,
    promoteId: 'id',
  })
  map.addSource('network-detail', {
    type: 'geojson',
    data: (detailFC ?? EMPTY_FC) as never,
    promoteId: 'id',
  })
  map.addSource('selected', { type: 'geojson', data: EMPTY_FC as never, lineMetrics: true })

  map.addLayer(
    {
      id: 'network-casing',
      type: 'line',
      source: 'network',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': colors.casing,
        'line-opacity': 0.85,
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 3.2, 8, 6, 12, 11],
      },
    },
    firstSymbol,
  )

  const lineWidth = [
    'interpolate', ['linear'], ['zoom'],
    4, hoverWidth(1.5, 2.6),
    8, hoverWidth(3, 4.6),
    12, hoverWidth(6.5, 9),
  ]

  map.addLayer(
    {
      id: 'network-line',
      type: 'line',
      source: 'network',
      filter: ['==', ['get', 'status'], 'operational'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': categoryColorExpr(theme) as never,
        'line-width': lineWidth as never,
      },
    },
    firstSymbol,
  )

  map.addLayer(
    {
      id: 'network-line-dashed',
      type: 'line',
      source: 'network',
      filter: ['!=', ['get', 'status'], 'operational'],
      layout: { 'line-join': 'round' },
      paint: {
        'line-color': categoryColorExpr(theme) as never,
        'line-width': lineWidth as never,
        'line-dasharray': [2.1, 1.7],
        'line-opacity': 0.9,
      },
    },
    firstSymbol,
  )

  // the state/district tier: same look, thinner, and only near the ground
  map.addLayer(
    {
      id: 'network-detail-casing',
      type: 'line',
      source: 'network-detail',
      minzoom: DETAIL_ZOOM,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': colors.casing,
        'line-opacity': 0.8,
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 2.4, 12, 8],
      },
    },
    firstSymbol,
  )
  map.addLayer(
    {
      id: 'network-detail-line',
      type: 'line',
      source: 'network-detail',
      minzoom: DETAIL_ZOOM,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': categoryColorExpr(theme) as never,
        'line-width': ['interpolate', ['linear'], ['zoom'],
          7, hoverWidth(1.1, 2.2),
          12, hoverWidth(4.6, 7),
        ] as never,
      },
    },
    firstSymbol,
  )

  map.addLayer(
    {
      id: 'network-hit',
      type: 'line',
      source: 'network',
      paint: { 'line-color': '#000', 'line-opacity': 0.001, 'line-width': 20 },
    },
    firstSymbol,
  )
  map.addLayer(
    {
      id: 'network-detail-hit',
      type: 'line',
      source: 'network-detail',
      minzoom: DETAIL_ZOOM,
      paint: { 'line-color': '#000', 'line-opacity': 0.001, 'line-width': 16 },
    },
    firstSymbol,
  )

  // ref labels along the line (needs glyphs — absent in the offline fallback style)
  if ((map.getStyle() as { glyphs?: string }).glyphs) {
    map.addLayer({
      id: 'network-label',
      type: 'symbol',
      source: 'network',
      minzoom: 6.2,
      layout: {
        'symbol-placement': 'line',
        'text-field': ['get', 'ref'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11.5,
        'symbol-spacing': 420,
        'text-letter-spacing': 0.04,
      },
      paint: {
        'text-color': colors.labelText,
        'text-halo-color': colors.labelHalo,
        'text-halo-width': 1.6,
      },
    })
  }

  map.addLayer(
    {
      id: 'selected-glow',
      type: 'line',
      source: 'selected',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': ['interpolate', ['linear'], ['zoom'], 4, 9, 10, 16, 14, 24],
        'line-blur': 4,
      },
    },
  )
  map.addLayer({
    id: 'selected-line',
    type: 'line',
    source: 'selected',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-width': ['interpolate', ['linear'], ['zoom'], 4, 3.4, 10, 6, 14, 9],
    },
  })

  applyDim()
  applyHighlight() // a company deep link may have asked for one before now
}

export function setNetworkData(fc: NetworkFC): void {
  networkFC = fc
  const src = map.getSource('network') as maplibregl.GeoJSONSource | undefined
  src?.setData(fc as never)
}

export function setDetailNetworkData(fc: NetworkFC): void {
  detailFC = fc
  const src = map.getSource('network-detail') as maplibregl.GeoJSONSource | undefined
  src?.setData(fc as never)
  applyDim()
}

/** Called once, the first time the user zooms in far enough to need them. */
export function onDetailNetworkNeeded(cb: () => void): void {
  detailNeededCb = cb
  maybeRequestDetail()
}

function maybeRequestDetail(): void {
  if (detailRequested || !map || map.getZoom() < DETAIL_ZOOM) return
  detailRequested = true
  detailNeededCb()
}

// ── interactions ───────────────────────────────────────────────────

function clearHover(): void {
  if (hovered && map.getSource(hovered.source)) {
    map.setFeatureState({ source: hovered.source, id: hovered.id }, { hover: false })
  }
  hovered = null
  tip.classList.remove('is-on')
  if (map) map.getCanvas().style.cursor = ''
}

/** Hit layers currently on the map — the detail tier only exists once loaded. */
function hitLayers(): string[] {
  return ['network-hit', 'network-detail-hit'].filter((l) => map.getLayer(l))
}

function wireInteractions(): void {
  map.on('mouseout', clearHover)
  // zoomend covers wheel and pinch; moveend also catches a fitBounds that lands
  // deep (following a deep link straight to a two-kilometre district road)
  map.on('zoomend', maybeRequestDetail)
  map.on('moveend', maybeRequestDetail)
  map.on('mousemove', (e) => {
    const layers = hitLayers()
    if (!layers.length) return
    const top = map.queryRenderedFeatures(e.point, { layers })[0]
    if (hovered && (!top || top.properties.id !== hovered.id)) clearHover()
    if (top && !document.body.classList.contains('is-reporting')) {
      if (hovered?.id !== top.properties.id) {
        hovered = { source: top.source, id: top.properties.id as string }
        map.setFeatureState({ source: hovered.source, id: hovered.id }, { hover: true })
        tip.textContent = `${top.properties.ref} — ${top.properties.name}`
        tip.classList.add('is-on')
      }
      map.getCanvas().style.cursor = 'pointer'
      const rect = map.getContainer().getBoundingClientRect()
      tip.style.left = `${rect.left + e.point.x}px`
      tip.style.top = `${rect.top + e.point.y}px`
    }
  })

  map.on('click', (e) => {
    const layers = hitLayers()
    const feats = layers.length ? map.queryRenderedFeatures(e.point, { layers }) : []
    if (feats[0]) roadClickCb(feats[0].properties.id as string, [e.lngLat.lng, e.lngLat.lat])
    else baseClickCb([e.lngLat.lng, e.lngLat.lat])
  })
}

// ── selection ──────────────────────────────────────────────────────

export function showSelected(shape: ShapeFeature, category: Category, lengthKm: number): void {
  selectedShape = shape
  selectedCategory = category
  const src = map.getSource('selected') as maplibregl.GeoJSONSource | undefined
  src?.setData(shape as never)
  setDimmed(true)
  const duration = Math.min(2400, Math.max(950, lengthKm * 0.85 + 650))
  drawRoute(map, MAP_COLORS[getTheme()].categories[category], duration)
}

export function clearSelected(): void {
  cancelDraw()
  selectedShape = null
  const src = map.getSource('selected') as maplibregl.GeoJSONSource | undefined
  src?.setData(EMPTY_FC as never)
  setDimmed(false)
}

export function setDimmed(v: boolean): void {
  dimmed = v
  applyDim()
}

/**
 * Light up every road belonging to one organisation. Reuses the network
 * sources rather than fetching anything — the ids are already on the map, so
 * this is a filter change, not a download.
 */
export function highlightRoads(ids: string[] | null): void {
  highlightIds = ids?.length ? ids : null
  applyHighlight()
  setDimmed(!!highlightIds)
}

/**
 * Deep-linking straight to a company page can ask for a highlight before the
 * style has loaded and the network layers exist. Remember what was asked for
 * and paint it here, which `addAppLayers` calls again once they do.
 */
function applyHighlight(): void {
  for (const [layer, source, minzoom] of [
    ['org-highlight', 'network', undefined],
    ['org-highlight-detail', 'network-detail', DETAIL_ZOOM],
  ] as const) {
    if (!map.getSource(source)) continue
    if (!map.getLayer(layer)) {
      map.addLayer({
        id: layer,
        type: 'line',
        source,
        ...(minzoom ? { minzoom } : {}),
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': MAP_COLORS[getTheme()].categories.expressway,
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 2.6, 8, 4.6, 12, 8] as never,
          'line-opacity': 0.95,
        },
      })
    }
    map.setFilter(
      layer,
      highlightIds
        ? (['in', ['get', 'id'], ['literal', highlightIds]] as never)
        : (['==', ['get', 'id'], ''] as never),
    )
  }
}

function applyDim(): void {
  if (!map.getLayer('network-line')) return
  const lineOp = dimmed ? 0.3 : 1
  map.setPaintProperty('network-line', 'line-opacity', lineOp)
  map.setPaintProperty('network-line-dashed', 'line-opacity', dimmed ? 0.28 : 0.9)
  map.setPaintProperty('network-casing', 'line-opacity', dimmed ? 0.4 : 0.85)
  if (map.getLayer('network-detail-line')) {
    map.setPaintProperty('network-detail-line', 'line-opacity', dimmed ? 0.22 : 0.92)
    map.setPaintProperty('network-detail-casing', 'line-opacity', dimmed ? 0.3 : 0.8)
  }
  if (map.getLayer('network-label'))
    map.setPaintProperty('network-label', 'text-opacity', dimmed ? 0.45 : 1)
}

// ── camera ─────────────────────────────────────────────────────────

function isDesktop(): boolean {
  return matchMedia('(min-width: 769px)').matches
}

function fitPaddingHome() {
  return isDesktop()
    ? { top: 90, bottom: 60, left: 60, right: 60 }
    : { top: 84, bottom: 70, left: 26, right: 26 }
}

export function flyToRoad(bbox: BBox): void {
  const w = map.getContainer().clientWidth
  const h = map.getContainer().clientHeight
  const padding = isDesktop()
    ? {
        top: 100,
        bottom: 70,
        left: Math.min(464, Math.round(w * 0.45)),
        right: 60,
      }
    : { top: 86, bottom: Math.round(h * 0.42), left: 28, right: 28 }
  map.fitBounds(
    [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[3]],
    ],
    {
      padding,
      duration: prefersReducedMotion() ? 0 : 1500,
      easing: easeOutCubic,
      maxZoom: 12.5,
    },
  )
}

export function flyHome(): void {
  map.fitBounds(INDIA_BOUNDS, {
    padding: fitPaddingHome(),
    duration: prefersReducedMotion() ? 0 : 1200,
    easing: easeOutCubic,
  })
}

export function flyToPoint(lngLat: [number, number], zoom = 13): void {
  map.flyTo({
    center: lngLat,
    zoom,
    duration: prefersReducedMotion() ? 0 : 1600,
    curve: 1.35,
  })
}

// ── user location marker ───────────────────────────────────────────

let userMarker: maplibregl.Marker | null = null

export function setUserMarker(lngLat: [number, number]): void {
  if (!userMarker) {
    const el = document.createElement('div')
    el.className = 'user-dot'
    userMarker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map)
  } else {
    userMarker.setLngLat(lngLat)
  }
}
