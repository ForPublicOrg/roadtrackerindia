import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection, LineString, MultiLineString } from 'geojson'
import type { Way } from './stretches'
import type { BBox, Category, LngLat, NetworkFC, ShapeFeature, StretchProps } from './types'
import { getTheme, MAP_COLORS, onThemeChange, type Theme } from './theme'
import { buildStyle, fallbackStyle } from './mapstyle'
import { cancelDraw, drawRoute, easeOutCubic, prefersReducedMotion, type Hole } from './animate'

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

/**
 * How long the tile CDN gets to hand over the base style before the map starts
 * on the plain fallback instead. A network that silently drops packets, rather
 * than refusing them, can hold that request open for minutes.
 */
const STYLE_WAIT_MS = 6000

/** How long a road's stretch colours take to come in once its line is drawn. */
const STRETCH_FADE_MS = 350

/** The selected road's width — its stretches draw at exactly this, over it. */
const SELECTED_WIDTH = ['interpolate', ['linear'], ['zoom'], 4, 3.4, 10, 6, 14, 9]

/**
 * Undefined until initMap has built it — and for good in a browser that cannot
 * (no WebGL, a blocklisted GPU). The app runs without it, so everything
 * exported below either checks for it or waits for it.
 */
let map: maplibregl.Map
let mapFailed = false
/** Map calls made before the map existed, in order — a deep link opened while the style was on its way. */
const pending: Array<() => void> = []
let networkFC: NetworkFC | null = null
/** The trunk tier's ids, to tell which roads in a focus live in the detail tier. */
let trunkIds = new Set<string>()
let detailFC: NetworkFC | null = null
let detailRequested = false
let detailNeededCb: (() => void) | null = null
let selectedShape: ShapeFeature | null = null
let selectedCategory: Category = 'nh'
/** The selected road's holes, where its line is not drawn. */
let selectedHoles: Hole[] = []
let dimmed = false
/**
 * The roads that stay in full colour while the rest of the country fades back:
 * one organisation's work, or everything running through a chosen city. Held
 * here because a style swap rebuilds every layer and has to repaint it.
 */
let focusIds: string[] | null = null
/**
 * The ids carrying focus feature state right now. MapLibre refuses to drop one
 * state key across a whole source (`removeFeatureState` wants an id with a
 * key), so the last focus has to be remembered to be cleared road by road.
 */
let focusApplied: string[] = []
/** An organisation also gets an accent line; an area keeps its road colours. */
let focusAccent = false
let hovered: { source: string; id: string } | null = null
let usingFallbackStyle = false

/** A stretch on the map, tagged with the road it was drawn for. */
type StretchFeatureProps = StretchProps & { road: string }

/**
 * The selected road's stretches, as the panel last scored them. Each carries
 * the road's id because swapping a source's data is not instant: for a frame
 * or two after a new road is chosen, the last road's lines can still answer a
 * tap, and that tap must not pick a stretch of the new one.
 */
let stretchData: FeatureCollection<LineString | MultiLineString, StretchFeatureProps> | null = null
/** Whether anyone has rated any stretch of this road — the grey for the rest only means something then. */
let stretchesRated = false
/** The stretches picked in the panel, or null while none is. */
let stretchPick: number[] | null = null
/** Which way the panel is looking at the road, whose ratings colour it —
 *  arrows along it say so. null while no road is open. */
let stretchWay: Way | null = null
/**
 * Bumped by every new selection, and checked when a draw-on sweep reports that
 * it has finished: the report may be about a road that has gone since.
 */
let selectionToken = 0
/** The current road's line has finished drawing itself; the stretches wait for that. */
let swept = false
let hoveredStretch: number | null = null

let roadClickCb: (id: string, lngLat: [number, number], stretch?: number) => void = () => {}
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

/**
 * Run something that needs the map now, or as soon as it exists. Dropped when
 * this browser cannot build one at all.
 */
export function whenMap(fn: () => void): void {
  if (map) fn()
  else if (!mapFailed) pending.push(fn)
}

export function onRoadClick(cb: typeof roadClickCb): void {
  roadClickCb = cb
}
export function onBaseClick(cb: typeof baseClickCb): void {
  baseClickCb = cb
}

export async function initMap(): Promise<maplibregl.Map> {
  // Only the light style is downloaded; dark is derived from it. Waiting on
  // that, then asking for the current theme, keeps a theme switch made during
  // the download.
  const fetched = buildStyle('light')
  let style = await Promise.race([
    fetched.then(() => buildStyle(getTheme())),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), STYLE_WAIT_MS)),
  ]).catch(() => null)
  if (style) {
    usingFallbackStyle = false
  } else {
    style = fallbackStyle(getTheme())
    usingFallbackStyle = true
    showNetBanner()
    // too slow is not the same as never: swap the real map in if it does come
    fetched.then(
      () => {
        if (map && usingFallbackStyle) void retryStyle()
      },
      () => {},
    )
  }

  try {
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
  } catch (e) {
    // no WebGL here: the rest of the app carries on without a map, so stop
    // saving up camera moves for one that is never coming
    mapFailed = true
    pending.length = 0
    throw e
  }
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
  // a wifi blip can raise the banner — clear it once a base map tile actually
  // arrives again. Not on 'idle': MapLibre counts a failed tile as finished, so
  // the map goes idle over blank tiles while still offline.
  map.on('sourcedata', (e) => {
    if (e.tile && e.source?.type === 'vector' && navigator.onLine && !usingFallbackStyle) hideNetBanner()
  })
  // and climb out of the offline fallback style as soon as we're back online
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

  // whatever was asked of the map while it was still on its way
  for (const fn of pending.splice(0)) fn()

  return map
}

function showNetBanner(): void {
  document.getElementById('net-banner')?.removeAttribute('hidden')
}
function hideNetBanner(): void {
  const el = document.getElementById('net-banner')
  if (el && !el.hidden) el.hidden = true // runs on every tile, so touch the DOM only when it changes
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
    drawRoute(map, MAP_COLORS[getTheme()].categories[selectedCategory], 0, undefined, selectedHoles)
    // A sweep the style swap cut short never reports back, and this redraw is
    // instant, so the stretches come straight back with it — onto a layer the
    // swap rebuilt from scratch, which knows nothing of the old one's state.
    swept = true
    const stretches = map.getSource('stretches') as maplibregl.GeoJSONSource | undefined
    stretches?.setData((stretchData ?? EMPTY_FC) as never)
    applyStretches(false)
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

/** A stretch's colour from its rounded score; `unrated` for one nobody has scored. */
function stretchColorExpr(theme: Theme, unrated: string): unknown {
  const s = MAP_COLORS[theme].scores
  return ['match', ['get', 'score'], 1, s[1], 2, s[2], 3, s[3], 4, s[4], 5, s[5], unrated]
}

const ARROW = 'stretch-arrow'

/**
 * The chevron laid along a picked stretch to say which way it is being rated:
 * white over a dark rim, so it reads on every score colour in either theme.
 * Drawn here rather than shipped, at the screen's own density. It points along
 * the line's own order, which is the road's; the other way turns it round.
 */
function addArrowImage(): void {
  if (map.hasImage(ARROW)) return
  const ratio = Math.max(1, Math.min(3, Math.round(window.devicePixelRatio || 1)))
  const size = 18 * ratio
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(ratio, ratio)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const chevron = (color: string, width: number) => {
    ctx.beginPath()
    ctx.moveTo(6.5, 4.5)
    ctx.lineTo(11.5, 9)
    ctx.lineTo(6.5, 13.5)
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.stroke()
  }
  chevron('rgba(0, 0, 0, 0.55)', 4.8)
  chevron('#fff', 2.4)
  map.addImage(ARROW, { width: size, height: size, data: ctx.getImageData(0, 0, size, size).data }, { pixelRatio: ratio })
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
      'line-width': SELECTED_WIDTH as never,
    },
  })

  // The selected road's stretches, coloured by how people rate them, laid over
  // the road at its own width. Flat ends, so neighbours meet at the stop they
  // share instead of overlapping round caps. Hidden until applyStretches says.
  map.addSource('stretches', { type: 'geojson', data: EMPTY_FC as never, promoteId: 'i' })
  map.addLayer({
    id: 'stretch-line',
    type: 'line',
    source: 'stretches',
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: {
      'line-color': stretchColorExpr(theme, colors.scores[0]) as never,
      'line-width': SELECTED_WIDTH as never,
      'line-opacity': 0,
    },
  })
  // Arrows along the open road, the way the panel is looking at it: its
  // colours are that way's ratings. Only the open road carries them, so the
  // rest of the map keeps one plain line per road.
  addArrowImage()
  map.addLayer({
    id: 'stretch-dir',
    type: 'symbol',
    source: 'stretches',
    filter: ['in', ['get', 'i'], ['literal', []]],
    layout: {
      'symbol-placement': 'line',
      'symbol-spacing': 72,
      'icon-image': ARROW,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 4, 0.7, 10, 0.85, 14, 1],
      'icon-rotation-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: { 'icon-opacity': 0 },
  })
  map.addLayer({
    id: 'stretch-hit',
    type: 'line',
    source: 'stretches',
    paint: { 'line-color': '#000', 'line-opacity': 0.001, 'line-width': 14 },
  })

  applyDim()
  // a company deep link may have asked for a focus before the layers existed
  applyFocusState()
  applyAccent()
  applyDetailZoom()
}

export function setNetworkData(fc: NetworkFC): void {
  networkFC = fc
  trunkIds = new Set(fc.features.map((f) => f.properties.id))
  if (!map) return // addAppLayers draws it once the layers exist
  const src = map.getSource('network') as maplibregl.GeoJSONSource | undefined
  src?.setData(fc as never)
}

export function setDetailNetworkData(fc: NetworkFC): void {
  detailFC = fc
  if (!map) return // addAppLayers draws it once the layers exist
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
  hoveredStretch = null
  tip.classList.remove('is-on')
  // report mode's crosshair is the only cue that a tap drops a pin — leaving
  // the map, or hovering a road, must not take it away
  if (map && !document.body.classList.contains('is-reporting')) map.getCanvas().style.cursor = ''
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

/**
 * The selected road's stretch under a point, if there is one. Asked on its
 * own, never alongside the network's hit layers: a query naming a layer that
 * is missing — this one is, until the style has loaded — comes back empty for
 * every layer in it.
 */
function stretchAt(point: maplibregl.PointLike): { i: number; tip: string } | null {
  const road = selectedShape?.properties.id
  if (!road || !stretchData?.features.length || !map.getLayer('stretch-hit')) return null
  const f = map
    .queryRenderedFeatures(point, { layers: ['stretch-hit'] })
    .find((x) => x.properties.road === road)
  return f ? { i: Number(f.properties.i), tip: String(f.properties.tip ?? '') } : null
}

function placeTip(point: maplibregl.Point): void {
  const rect = map.getContainer().getBoundingClientRect()
  tip.style.left = `${rect.left + point.x}px`
  tip.style.top = `${rect.top + point.y}px`
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
    // The open road's own stretches answer first, with their name and score.
    // They never set the road's hover state — that would thicken the network
    // line under them — but a road the pointer has just left still lets go.
    const stretch = stretchAt(e.point)
    if (stretch) {
      if (hovered || (hoveredStretch !== null && hoveredStretch !== stretch.i)) clearHover()
      if (!document.body.classList.contains('is-reporting')) {
        // the text too: a new rating rewrites a stretch's line without moving it
        if (hoveredStretch !== stretch.i || tip.textContent !== stretch.tip) {
          hoveredStretch = stretch.i
          tip.textContent = stretch.tip
          tip.classList.add('is-on')
        }
        map.getCanvas().style.cursor = 'pointer'
        placeTip(e.point)
      }
      return
    }
    if (hoveredStretch !== null) clearHover()
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
      placeTip(e.point)
    }
  })

  map.on('click', (e) => {
    const at: [number, number] = [e.lngLat.lng, e.lngLat.lat]
    // a tap on the open road is about the stretch under it, whatever crosses there
    const stretch = stretchAt(e.point)
    if (stretch && selectedShape) {
      roadClickCb(selectedShape.properties.id, at, stretch.i)
      return
    }
    const layers = hitLayers()
    const feats = layers.length ? map.queryRenderedFeatures(e.point, { layers }) : []
    if (feats[0]) roadClickCb(feats[0].properties.id as string, at)
    else baseClickCb(at)
  })
}

// ── selection ──────────────────────────────────────────────────────

export function showSelected(shape: ShapeFeature, category: Category, lengthKm: number): void {
  // the last road's stretches go now; this road's wait for its line to draw
  clearStretches()
  selectedShape = shape
  selectedCategory = category
  selectedHoles = holesOf(shape)
  const token = ++selectionToken
  swept = false
  setDimmed(true)
  if (!map) return // restoreSelection draws it once the layers exist
  const src = map.getSource('selected') as maplibregl.GeoJSONSource | undefined
  src?.setData(shape as never)
  const duration = Math.min(2400, Math.max(950, lengthKm * 0.85 + 650))
  drawRoute(map, MAP_COLORS[getTheme()].categories[category], duration, () => {
    if (token !== selectionToken) return
    swept = true
    applyStretches(true)
  }, selectedHoles)
}

/**
 * Where the shape's holes fall in line-progress, which MapLibre measures in
 * Web Mercator — so they are measured that way here too, not in km, or a long
 * north–south road would put them a little off.
 */
function holesOf(shape: ShapeFeature): Hole[] {
  const gaps = shape.properties.gaps
  const c = shape.geometry.coordinates
  if (!gaps?.length || c.length < 2) return []
  const merc = c.map(([lng, lat]) => [lng / 360, Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / (2 * Math.PI)])
  const cum = [0]
  for (let i = 1; i < merc.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(merc[i][0] - merc[i - 1][0], merc[i][1] - merc[i - 1][1]))
  }
  const total = cum[cum.length - 1]
  if (!(total > 0)) return []
  return gaps.filter((g) => g > 0 && g < c.length).map((g): Hole => [cum[g - 1] / total, cum[g] / total])
}

export function clearSelected(): void {
  cancelDraw()
  selectedShape = null
  selectedHoles = []
  selectionToken++
  swept = false
  clearStretches()
  setDimmed(false)
  if (!map) return
  const src = map.getSource('selected') as maplibregl.GeoJSONSource | undefined
  src?.setData(EMPTY_FC as never)
}

/**
 * Colour the selected road by stretch, from the panel's scores. Called again
 * whenever the scores change; dropped if the road has been closed meanwhile.
 * Has to come after showSelected for that road, which clears the last one's.
 */
export function showStretches(fc: FeatureCollection<LineString | MultiLineString, StretchProps>): void {
  if (!selectedShape) return
  const road = selectedShape.properties.id
  stretchData = {
    type: 'FeatureCollection',
    features: fc.features.map((f) => ({ ...f, properties: { ...f.properties, road } })),
  }
  stretchesRated = fc.features.some((f) => f.properties.score > 0)
  if (!map) return // restoreSelection hands them over once the layers exist
  const src = map.getSource('stretches') as maplibregl.GeoJSONSource | undefined
  src?.setData(stretchData as never)
  applyStretches(true)
}

/** Show only these stretches, and fade the rest of the road behind them. null
 *  or [] shows them all again. Arrows point `way` along whatever shows. */
export function setStretchSelection(indices: number[] | null, way: Way | null = null): void {
  if (!selectedShape) return
  stretchPick = indices?.length ? [...indices] : null
  stretchWay = way
  if (!map) return
  applyStretches(true)
}

/** Back to the plain selected line, at once — nothing fades out of a road being left. */
export function clearStretches(): void {
  stretchData = null
  stretchesRated = false
  stretchPick = null
  stretchWay = null
  if (hoveredStretch !== null) clearHover()
  if (!map) return
  const src = map.getSource('stretches') as maplibregl.GeoJSONSource | undefined
  src?.setData(EMPTY_FC as never)
  applyStretches(false)
}

/**
 * Put the stretches, and the selected line under them, in the state the
 * selection asks for. Nothing shows until the line has finished drawing and
 * the scores are in: colour arriving over a half-drawn road fights the sweep.
 *
 * With nothing picked, rated stretches wear their score and the rest go grey —
 * unless none is rated, when the road keeps its own colour, because a road of
 * grey says less than the plain line. Picking shows just those stretches (in
 * the road's colour while nobody has rated them) over a faded road.
 *
 * Each opacity is a plain number, never an expression: MapLibre snaps a
 * data-driven value rather than fading it, so which stretches draw is left to
 * the filter.
 */
function applyStretches(animate: boolean): void {
  if (!map || !map.getLayer('stretch-line')) return
  const theme = getTheme()
  const colors = MAP_COLORS[theme]
  const picked = stretchPick !== null
  const show = swept && Boolean(stretchData?.features.length) && (picked || stretchesRated)
  // undefined rather than null for no filter: MapLibre tells the two apart,
  // and would re-cut the source's tiles on every call
  map.setFilter('stretch-line', picked ? (['in', ['get', 'i'], ['literal', stretchPick]] as never) : undefined)
  // Grey only where it can show. On a road nobody has rated, un-picking fades
  // this layer out over the line beneath it, and a colour change re-cuts the
  // source's tiles: the rebuilt ones land a frame or two in, near full opacity,
  // and would paint the whole road grey just as it fades. In the road's own
  // colour the fade cannot be seen, and picking there changes only the filter.
  const unrated = picked || !stretchesRated ? colors.categories[selectedCategory] : colors.scores[0]
  map.setPaintProperty('stretch-line', 'line-color', stretchColorExpr(theme, unrated))
  const ms = animate && !prefersReducedMotion() && document.visibilityState !== 'hidden' ? STRETCH_FADE_MS : 0
  const faded = show && picked
  setOpacity('stretch-line', show ? 1 : 0, ms)
  setOpacity('selected-line', faded ? 0.3 : 1, ms)
  setOpacity('selected-glow', faded ? 0 : 1, ms)
  if (map.getLayer('stretch-dir')) {
    // The colours are one way's, so the arrows go wherever colours show: along
    // the picked stretches, close together, or spread along the whole road. A
    // flip turns them round without re-cutting which stretches carry them.
    map.setFilter('stretch-dir', picked ? (['in', ['get', 'i'], ['literal', stretchPick]] as never) : undefined)
    map.setLayoutProperty('stretch-dir', 'symbol-spacing', picked ? 72 : 180)
    map.setLayoutProperty('stretch-dir', 'icon-rotate', stretchWay === 'rev' ? 180 : 0)
    map.setPaintProperty('stretch-dir', 'icon-opacity-transition', { duration: ms, delay: 0 })
    map.setPaintProperty('stretch-dir', 'icon-opacity', show && stretchWay ? 1 : 0)
  }
}

/** The transition is set with every value, so an instant change can't inherit a fade, or a fade an instant. */
function setOpacity(layer: string, value: number, ms: number): void {
  if (!map.getLayer(layer)) return
  map.setPaintProperty(layer, 'line-opacity-transition', { duration: ms, delay: 0 })
  map.setPaintProperty(layer, 'line-opacity', value)
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
  // a state PWD's roads are nearly all state and district roads, which only
  // the detail tier has — fetch it now rather than once someone happens to
  // zoom past DETAIL_ZOOM, or the focus lights up nothing at all
  if (focusIds?.some((id) => !trunkIds.has(id))) ensureDetailNetwork()
  if (!map) return // addAppLayers applies the rest once the layers exist
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
  for (const layer of ['network-detail-casing', 'network-detail-line', 'network-detail-hit']) {
    if (map.getLayer(layer)) map.setLayerZoomRange(layer, min, 24)
  }
  // an organisation's own roads are the whole answer, and a state department's
  // fill a phone's frame well below that floor — its accent line draws at any zoom
  if (map.getLayer('org-highlight-detail')) map.setLayerZoomRange('org-highlight-detail', focusAccent ? 0 : min, 24)
}

/**
 * Which roads are in focus is a per-feature question, so it is answered with
 * feature state rather than a filter: a 2,000-id `in` expression would be
 * re-evaluated against all 7,700 features every time the layer re-bucketed.
 */
function applyFocusState(): void {
  const stale = focusApplied
  focusApplied = focusIds ?? []
  for (const source of ['network', 'network-detail']) {
    if (!map.getSource(source)) continue
    for (const id of stale) map.removeFeatureState({ source, id }, 'focus')
    for (const id of focusApplied) map.setFeatureState({ source, id }, { focus: true })
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
  if (!map || !map.getLayer('network-line')) return
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
  whenMap(() =>
    map.fitBounds(asBounds(bbox), {
      padding: fitPadding(),
      duration: prefersReducedMotion() ? 0 : 1500,
      easing: easeOutCubic,
      maxZoom: 12.5,
    }),
  )
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
  whenMap(() =>
    map.fitBounds(asBounds(bbox), {
      padding: fitPadding(),
      duration: prefersReducedMotion() ? 0 : 1400,
      easing: easeOutCubic,
      maxZoom: 13.5,
    }),
  )
}

export function flyHome(): void {
  whenMap(() =>
    map.fitBounds(INDIA_BOUNDS, {
      padding: fitPaddingHome(),
      duration: prefersReducedMotion() ? 0 : 1200,
      easing: easeOutCubic,
    }),
  )
}

export function flyToPoint(lngLat: [number, number], zoom = 13): void {
  whenMap(() =>
    map.flyTo({
      center: lngLat,
      zoom,
      duration: prefersReducedMotion() ? 0 : 1600,
      curve: 1.35,
    }),
  )
}

// ── user location marker ───────────────────────────────────────────

let userMarker: maplibregl.Marker | null = null

export function setUserMarker(lngLat: [number, number]): void {
  whenMap(() => {
    if (!userMarker) {
      const el = document.createElement('div')
      el.className = 'user-dot'
      userMarker = new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map)
    } else {
      userMarker.setLngLat(lngLat)
    }
  })
}
