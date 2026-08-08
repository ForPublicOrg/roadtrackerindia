import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { BBox, Category, LngLat, NetworkFC, ShapeFeature } from './types'
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
let detailNeededCb: (() => void) | null = null
let selectedShape: ShapeFeature | null = null
let selectedCategory: Category = 'nh'
let dimmed = false
/**
 * The roads that stay in full colour while the rest of the country fades back:
 * one organisation's work, or everything running through a chosen city. Held
 * here because a style swap rebuilds every layer and has to repaint it.
 */
let focusIds: string[] | null = null
/** An organisation also gets an accent line; an area keeps its road colours. */
let focusAccent = false
let hovered: { source: string; id: string } | null = null
let usingFallbackStyle = false

let roadClickCb: (id: string, lngLat: [number, number]) => void = () => {}
let baseClickCb: (lngLat: [number, number]) => void = () => {}

const tip = document.createElement('div')
tip.className = 'road-tip'
// <main> is position:fixed, so it owns a stacking context: parked on <body> the
// chip sits in the root context and floats over the details sheet — over every
// z-index inside <main> — however low its own z-index goes.
;(document.querySelector('main') ?? document.body).appendChild(tip)

/**
 * A touchscreen has no hover, but tapping still fires one compatibility
 * mousemove — enough to raise the name chip and thicken the line, with no
 * pointer left to move away and take them back down again.
 */
const canHover = window.matchMedia('(hover: hover)')

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
  // a company deep link may have asked for a focus before the layers existed
  applyFocusState()
  applyAccent()
  applyDetailZoom()
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
  applyFocusState()
  applyDim()
}

/** Called once, the first time the user zooms in far enough to need them. */
export function onDetailNetworkNeeded(cb: () => void): void {
  detailNeededCb = cb
  maybeRequestDetail()
}

/**
 * Fetch the state/district tier now, whatever the zoom. Choosing a city has to
 * count its small roads before the camera has finished arriving there.
 */
export function ensureDetailNetwork(): void {
  if (detailNeededCb === null || detailRequested) return
  detailRequested = true
  detailNeededCb()
}

/** The loader failed — let the next zoom try again instead of giving up forever. */
export function detailNetworkFailed(): void {
  detailRequested = false
}

function maybeRequestDetail(): void {
  // The zoom listeners are wired during initMap, before main.ts has handed us
  // the loader. Burning the one-shot flag here would disable the whole detail
  // tier for the session, silently — so wait until there is something to call.
  if (detailNeededCb === null || detailRequested || !map) return
  if (map.getZoom() < DETAIL_ZOOM) return
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

/** Most roads carry a number and a name; a few are only ever their name. */
function tipLabel(ref: unknown, name: unknown): string {
  const r = String(ref ?? '').trim()
  const n = String(name ?? '').trim()
  if (!r) return n
  return !n || n === r ? r : `${r} — ${n}`
}

function wireInteractions(): void {
  map.on('mouseout', clearHover)
  // a hybrid laptop reports (hover: hover) and still gets tapped
  map.on('touchstart', clearHover)
  // zoomend covers wheel and pinch; moveend also catches a fitBounds that lands
  // deep (following a deep link straight to a two-kilometre district road)
  map.on('zoomend', maybeRequestDetail)
  map.on('moveend', maybeRequestDetail)
  map.on('mousemove', (e) => {
    if (!canHover.matches) return
    const layers = hitLayers()
    if (!layers.length) return
    const top = map.queryRenderedFeatures(e.point, { layers })[0]
    if (hovered && (!top || top.properties.id !== hovered.id)) clearHover()
    if (top && !document.body.classList.contains('is-reporting')) {
      if (hovered?.id !== top.properties.id) {
        hovered = { source: top.source, id: top.properties.id as string }
        map.setFeatureState({ source: hovered.source, id: hovered.id }, { hover: true })
        tip.textContent = tipLabel(top.properties.ref, top.properties.name)
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
  setFocus(ids, true)
}

/**
 * Narrow the map to one city or state. Its roads keep their own colours and
 * full weight; everything else recedes to a hint of where the network runs.
 */
export function focusArea(ids: string[] | null): void {
  setFocus(ids, false)
}

function setFocus(ids: string[] | null, accent: boolean): void {
  focusIds = ids?.length ? ids : null
  focusAccent = focusIds !== null && accent
  applyFocusState()
  applyAccent()
  applyDetailZoom() // after applyAccent, which is what creates its detail layer
  applyDim()
}

/**
 * A state fits on screen at about zoom 6.5, below where the state and district
 * tier normally appears — so a focus, which is exactly the request to see one
 * place's roads, brings that tier forward. Only far enough to cover a state:
 * the whole country's minor roads at once would still be a wall of lines.
 */
function applyDetailZoom(): void {
  const min = focusIds ? 6.2 : DETAIL_ZOOM
  for (const layer of ['network-detail-casing', 'network-detail-line', 'network-detail-hit', 'org-highlight-detail']) {
    if (map.getLayer(layer)) map.setLayerZoomRange(layer, min, 24)
  }
}

/**
 * Which roads are in focus is a per-feature question, so it is answered with
 * feature state rather than a filter: a 2,000-id `in` expression would be
 * re-evaluated against all 7,700 features every time the layer re-bucketed.
 */
function applyFocusState(): void {
  for (const source of ['network', 'network-detail']) {
    if (!map.getSource(source)) continue
    map.removeFeatureState({ source }, 'focus')
    if (!focusIds) continue
    for (const id of focusIds) map.setFeatureState({ source, id }, { focus: true })
  }
}

/**
 * The accent line an organisation's roads get on top of their own colour.
 * Deep-linking straight to a company page can ask for it before the style has
 * loaded and the network layers exist, so `addAppLayers` calls this again.
 */
function applyAccent(): void {
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
      focusIds && focusAccent
        ? (['in', ['get', 'id'], ['literal', focusIds]] as never)
        : (['==', ['get', 'id'], ''] as never),
    )
  }
}

/**
 * How far back everything that is not the answer fades. Low enough that the
 * roads in focus are the only ones the eye picks up, high enough that the rest
 * of the network still shows where it runs.
 */
const FADED = { line: 0.13, dashed: 0.12, casing: 0.14, detail: 0.1, label: 0.18 }

/**
 * Fading is per-road as soon as a focus exists, so a chosen city's roads stay
 * bright while the country behind them drops away. With nothing chosen it is a
 * flat wash over the whole network, sitting behind the selected road.
 */
function fade(full: number, faded: number): unknown {
  if (focusIds) return ['case', ['boolean', ['feature-state', 'focus'], false], full, faded]
  return dimmed ? faded : full
}

function applyDim(): void {
  if (!map.getLayer('network-line')) return
  map.setPaintProperty('network-line', 'line-opacity', fade(1, FADED.line) as never)
  map.setPaintProperty('network-line-dashed', 'line-opacity', fade(0.9, FADED.dashed) as never)
  map.setPaintProperty('network-casing', 'line-opacity', fade(0.85, FADED.casing) as never)
  if (map.getLayer('network-detail-line')) {
    map.setPaintProperty('network-detail-line', 'line-opacity', fade(0.92, FADED.detail) as never)
    map.setPaintProperty('network-detail-casing', 'line-opacity', fade(0.8, FADED.detail) as never)
  }
  if (map.getLayer('network-label'))
    map.setPaintProperty('network-label', 'text-opacity', fade(1, FADED.label) as never)
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

/** Room for the panel, so what we frame does not open underneath it. */
function fitPadding() {
  const w = map.getContainer().clientWidth
  const h = map.getContainer().clientHeight
  return isDesktop()
    ? { top: 100, bottom: 70, left: Math.min(464, Math.round(w * 0.45)), right: 60 }
    : { top: 86, bottom: Math.round(h * 0.42), left: 28, right: 28 }
}

/**
 * What the panel is about to cover, in screen pixels. Narrower than the fit
 * padding on a phone, where a road opens the sheet at its peek height rather
 * than full — this is the strip that must stay clear, not a comfortable frame.
 */
function panelInset() {
  const w = map.getContainer().clientWidth
  return isDesktop()
    ? { top: 92, bottom: 44, left: Math.min(452, Math.round(w * 0.45)), right: 28 }
    : { top: 80, bottom: 216, left: 24, right: 24 }
}

const asBounds = (b: BBox): [[number, number], [number, number]] => [
  [b[0], b[1]],
  [b[2], b[3]],
]

export function flyToRoad(bbox: BBox): void {
  map.fitBounds(asBounds(bbox), {
    padding: fitPadding(),
    duration: prefersReducedMotion() ? 0 : 1500,
    easing: easeOutCubic,
    maxZoom: 12.5,
  })
}

/**
 * Selecting a road by tapping it on the map. Framing the whole road is right
 * when it makes the road *bigger*, and wrong the rest of the time: pulling back
 * to fit 3,700 km of NH 44 because someone tapped it in Kochi throws away the
 * view they were working in. So the camera only ever moves closer, and
 * otherwise just slides the tapped point out from behind the panel.
 */
export function focusRoad(bbox: BBox, at: LngLat): void {
  const camera = map.cameraForBounds(asBounds(bbox), { padding: fitPadding() })
  const fitZoom = Math.min(camera?.zoom ?? 0, 12.5)
  if (fitZoom >= map.getZoom() + 0.6) flyToRoad(bbox)
  else keepInView(at)
}

/**
 * Pan by the least that clears a point from behind the panel — and by nothing
 * at all when it is already visible. The zoom is never touched.
 */
export function keepInView(at: LngLat): void {
  const el = map.getContainer()
  const inset = panelInset()
  const margin = 18
  const left = inset.left + margin
  const right = el.clientWidth - inset.right - margin
  const top = inset.top + margin
  const bottom = el.clientHeight - inset.bottom - margin
  const p = map.project(at)

  let dx = 0
  let dy = 0
  if (right > left) dx = p.x < left ? p.x - left : p.x > right ? p.x - right : 0
  if (bottom > top) dy = p.y < top ? p.y - top : p.y > bottom ? p.y - bottom : 0
  if (dx === 0 && dy === 0) return

  // move the camera by the overshoot rather than panBy'ing the content, so the
  // sign of the shift stays obvious
  const centre = map.project(map.getCenter())
  map.easeTo({
    center: map.unproject([centre.x + dx, centre.y + dy]),
    duration: prefersReducedMotion() ? 0 : 520,
    easing: easeOutCubic,
  })
}

/** Frame a city or a state. Cities are small, so this can go a lot closer in. */
export function flyToArea(bbox: BBox): void {
  map.fitBounds(asBounds(bbox), {
    padding: fitPadding(),
    duration: prefersReducedMotion() ? 0 : 1400,
    easing: easeOutCubic,
    maxZoom: 13.5,
  })
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
