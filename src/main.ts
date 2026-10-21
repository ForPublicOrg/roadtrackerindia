import '@fontsource-variable/inter'
import '@fontsource-variable/fraunces'
import './styles.css'

import { inject as injectAnalytics } from '@vercel/analytics'

import type { Area, BBox, LngLat, NetworkFC } from './types'
import { initTheme, toggleTheme } from './theme'
import { emit, state } from './state'
import { loadDetail, loadIndex, loadNetwork, loadNetworkDetail, loadOrg, loadShape } from './data'
import { recountArea, resolveArea } from './area'
import {
  clearSelected,
  detailNetworkFailed,
  ensureDetailNetwork,
  flyHome,
  flyToArea,
  flyToRoad,
  focusArea,
  focusRoad,
  highlightRoads,
  initMap,
  onBaseClick,
  onDetailNetworkNeeded,
  onRoadClick,
  setDetailNetworkData,
  setNetworkData,
  showSelected,
} from './map'
import {
  closePanel,
  expandSheet,
  initSheetGestures,
  isPanelOpen,
  onPanelClose,
  panelMode,
  renderDetail,
  renderOrg,
  showLoading,
  showOrgLoading,
} from './panel'
import { initOrgs, orgSummary, renderOrgProfile } from './orgs'
import { initSearch } from './search'
import { initBrowse, openBrowse, refreshBrowseArea } from './browse'
import { initLocate } from './locate'
import { clearStretchSelection, hasDraft, holdsDraft, mayLeaveDraft, ownsRoad, stretchTap } from './ratings'
import { initReports, handleMapClick as handleReportClick, isReporting } from './reports'
import {
  applyMeta,
  applyOrgMeta,
  currentRoute,
  initRouter,
  navigateHome,
  navigateToOrg,
  navigateToRoad,
  replaceHome,
} from './router'
import { initLegend, toast } from './ui'
import { initInstall, registerServiceWorker } from './install'

/**
 * Vercel Web Analytics — a count of page views, nothing else. It is cookie-less
 * and stores no identifier, so it sits alongside the app's no-account stance
 * rather than against it.
 *
 * The injected script watches `pushState` on its own, which is what makes this
 * one call enough: every road and organisation the router opens is a real URL,
 * so /road/nh-44 is counted like any other page without a hook in router.ts.
 * Production only — in dev the package reaches for a debug script on Vercel's
 * CDN, and `npm run dev` has no business talking to the network for that.
 */
function startAnalytics(): void {
  if (import.meta.env.PROD) injectAnalytics()
}

async function boot(): Promise<void> {
  startAnalytics()
  registerServiceWorker()
  initInstall() // before any await: the browser offers installing once per page load
  initTheme()
  initLegend()

  // The map is the one part of the page that can fail to start (no WebGL, a
  // blocked GPU) or start slowly (its style comes from a tile CDN). Nothing
  // below waits to find out: search, browse, the panel and deep links all work
  // without it, and the map catches up with whatever was chosen meanwhile.
  const mapReady = initMap().then(
    () => true,
    (e: unknown) => {
      console.warn('[map] could not start —', e)
      toast("This browser couldn't start the map — search and browse still work.", { duration: 12000 })
      return false
    },
  )

  let index, network
  try {
    ;[index, network] = await Promise.all([loadIndex(), loadNetwork()])
  } catch {
    toast('Could not load the road catalogue — check your connection.', {
      action: { label: 'Retry', cb: () => location.reload() },
      duration: 12000,
    })
    return
  }

  state.roads = index.roads
  state.byId = new Map(index.roads.map((r) => [r.id, r]))
  state.aliases = index.aliases ?? {}
  state.newsChecked = index.newsChecked ?? null
  state.network = network
  emit('dataready', undefined)

  setNetworkData(network)

  // ── area flow: the map narrowed to one city or state ─────────────
  let currentArea: Area | null = null
  let areaToken = 0

  const areaFilter = (area: Area) => ({ kind: area.kind, name: area.name, ids: new Set(area.ids) })

  function applyArea(area: Area): void {
    currentArea = area
    focusArea(area.ids)
    refreshBrowseArea(areaFilter(area))
  }

  function clearArea(): void {
    areaToken++ // an area still resolving must not land after this
    if (!currentArea) return
    currentArea = null
    focusArea(null)
  }

  // thousands of state and district roads — fetched the first time the map is
  // zoomed in far enough for them to be legible, never on the home view. One
  // request however many things ask: the map, a chosen city, Find my road.
  let detailLoad: Promise<NetworkFC> | null = null
  function loadDetailTier(): Promise<NetworkFC> {
    if (!detailLoad) {
      detailLoad = loadNetworkDetail().then(
        (fc) => {
          state.networkDetail = fc
          setDetailNetworkData(fc)
          // a city chosen before these arrived was measured against the trunk
          // network alone — most of its roads are in this file
          if (currentArea) applyArea(recountArea(currentArea))
          return fc
        },
        (e: unknown) => {
          // the trunk network still works, so this needs no alarm — but let the
          // next zoom retry rather than leaving the tier dead for the session
          detailLoad = null
          detailNetworkFailed()
          throw e
        },
      )
    }
    return detailLoad
  }
  onDetailNetworkNeeded(() => void loadDetailTier().catch(() => {}))

  void initOrgs() // org names for the panel chips; the page works without them

  // ── selection flow ───────────────────────────────────────────────
  let selectToken = 0
  let selectedOrgId: string | null = null

  /**
   * Whether the open road may give way to something else. A review being
   * written there is never dropped without asking (ratings.ts asks). Back and
   * Forward have already moved the address bar by the time this runs, so
   * staying puts the open road's address back on top of the history.
   */
  function mayLeave(fromRouter = false): boolean {
    if (!isPanelOpen() || mayLeaveDraft()) return true
    const open = state.selectedId ? state.byId.get(state.selectedId) : undefined
    if (fromRouter && open) navigateToRoad(open)
    return false
  }

  function clearOrg(): void {
    if (!selectedOrgId) return
    selectedOrgId = null
    // an organisation borrowed the map's focus — hand it back to the area, if
    // the user had narrowed to one, rather than letting the whole country back
    if (currentArea) focusArea(currentArea.ids)
    else highlightRoads(null)
  }

  /**
   * Picking a place from search: the camera goes there, its roads are the only
   * ones left lit, and the panel lists exactly those. The list opens on the
   * name match immediately and is swapped for the geographic answer as soon as
   * the place extents have landed.
   */
  async function selectArea(kind: 'city' | 'state', name: string) {
    if (!deselect()) return
    const token = ++areaToken
    ensureDetailNetwork() // a city is mostly district roads, so fetch them now
    openBrowse({ area: { kind, name, ids: null } })
    document.getElementById('btn-browse')?.setAttribute('aria-pressed', 'true')

    const area = await resolveArea(kind, name)
    if (token !== areaToken) return
    if (!area) {
      toast(`We can't place ${name} on the map yet — these are the roads that name it.`)
      return
    }
    applyArea(area)
    if (state.selectedId === null) flyToArea(area.bbox)
  }

  async function select(
    id: string,
    opts: { skipFly?: boolean; fromRouter?: boolean; at?: LngLat } = {},
  ) {
    // a link to a road we have since merged into another one still points at a
    // real road — follow it rather than telling the reader it does not exist
    const merged = state.aliases[id]
    const aliased = Boolean(merged) && !state.byId.has(id) && state.byId.has(merged)
    if (aliased) id = merged
    const summary = state.byId.get(id)
    const already = state.selectedId === id
    if (summary && already && isPanelOpen() && hasDraft(id)) {
      // This road is open with a review being written in it. Building its
      // panel again would throw the words away, so it stays as it is — the
      // camera still goes where it was asked to.
      selectToken++ // nor may an earlier load of it land over the draft
      if (!opts.skipFly) {
        if (opts.at) focusRoad(summary.bbox, opts.at)
        else flyToRoad(summary.bbox)
      }
      return
    }
    clearOrg()
    if (!summary) {
      toast("We don't have that road catalogued (yet).")
      if (opts.fromRouter) replaceHome() // never pushState inside popstate — traps the back button
      else navigateHome()
      applyMeta(null)
      return
    }
    if (!already && !mayLeave(opts.fromRouter)) return
    const token = ++selectToken
    state.selectedId = id
    emit('select', id)
    document.getElementById('btn-browse')?.setAttribute('aria-pressed', 'false')

    if (!already || !isPanelOpen()) showLoading(summary)
    if (!opts.skipFly) {
      if (opts.at) focusRoad(summary.bbox, opts.at)
      else flyToRoad(summary.bbox)
    }
    if (opts.fromRouter) {
      // the old address still opens the road, but the bar should show the real
      // one — it is what gets copied and shared. Replace, never push: this runs
      // at boot and inside popstate.
      if (aliased) history.replaceState({ roadId: id }, '', `/road/${id}/`)
      applyMeta(summary)
    } else navigateToRoad(summary)

    try {
      const [detail, shape] = await Promise.all([loadDetail(id), loadShape(id)])
      if (token !== selectToken) return
      showSelected(shape, summary.category, summary.lengthKm)
      renderDetail(detail, summary, { shape, at: opts.at })
    } catch {
      if (token !== selectToken) return
      toast("Couldn't load this road's details — check your connection.")
    }
  }

  /** One box around every road an organisation touched, from the search index. */
  function unionBbox(ids: string[]): BBox | null {
    let box: BBox | null = null
    for (const id of ids) {
      const b = state.byId.get(id)?.bbox
      if (!b) continue
      box = box
        ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])]
        : [...b]
    }
    return box
  }

  /**
   * A company page: its profile in the panel, and every road it has touched lit
   * up on the map at once. That map view is the whole point — it turns "who
   * built this?" into "what else have they built?".
   */
  async function selectOrg(id: string, opts: { fromRouter?: boolean } = {}) {
    if (!mayLeave(opts.fromRouter)) return
    const token = ++selectToken
    state.selectedId = null
    emit('select', null)
    clearSelected()
    clearArea() // a company's roads are the answer now, not a city's
    selectedOrgId = id
    document.getElementById('btn-browse')?.setAttribute('aria-pressed', 'false')

    const summary = orgSummary(id)
    showOrgLoading(summary?.name ?? 'Loading…')
    if (summary) {
      if (opts.fromRouter) applyOrgMeta(summary)
      else navigateToOrg(summary)
    }

    try {
      const org = await loadOrg(id)
      if (token !== selectToken) return
      // on a cold deep link the org index has not arrived yet, so the title and
      // canonical URL are still the defaults — set them from the profile itself
      if (!summary) {
        const loaded = { id: org.id, name: org.name, shortName: org.shortName, type: org.type, summary: org.summary, stats: org.stats }
        if (opts.fromRouter) applyOrgMeta(loaded)
        else navigateToOrg(loaded)
      }
      renderOrg(renderOrgProfile(org))
      const ids = org.roads.map((r) => r.id).filter((rid) => state.byId.has(rid))
      highlightRoads(ids)
      const bbox = unionBbox(ids)
      if (bbox) flyToRoad(bbox)
    } catch {
      if (token !== selectToken) return
      toast("We don't have a profile for that organisation.")
      deselect(opts)
    }
  }

  /** False when the reader chose to stay with a review they are writing, and
   *  nothing was closed — the caller must not go on to replace the panel. */
  function deselect(opts: { fromRouter?: boolean } = {}): boolean {
    if (!mayLeave(opts.fromRouter)) return false
    selectToken++
    const hadSelection = state.selectedId !== null || selectedOrgId !== null
    clearArea() // before clearOrg, which would otherwise hand focus back to it
    clearOrg()
    state.selectedId = null
    emit('select', null)
    clearSelected()
    closePanel()
    document.getElementById('btn-browse')?.setAttribute('aria-pressed', 'false')
    if (!opts.fromRouter) {
      if (hadSelection) navigateHome()
    } else {
      applyMeta(null)
    }
    return true
  }

  // ── wire everything ──────────────────────────────────────────────
  initSheetGestures()
  // Staying with a draft brings the sheet back up (ratings.ts), which also
  // undoes a fling that was meant to dismiss it.
  onPanelClose(() => void deselect())

  onRoadClick((id, lngLat, i) => {
    if (isReporting()) {
      handleReportClick(lngLat)
      return
    }
    // A tap on the road that is already open picks a stretch of it. Selecting
    // it again would re-render the panel and wipe a half-written review. Not
    // while its details are still loading, or failed to: then the tap opens it
    // again, which is how a slow or failed load is retried.
    if (id === state.selectedId && isPanelOpen() && ownsRoad(id)) {
      stretchTap(id, i ?? null, lngLat)
      return
    }
    // a tap that missed the open road must not throw away a review being written
    if (isPanelOpen() && holdsDraft()) return
    // `at` is what keeps the camera from pulling back to frame the whole road
    void select(id, { at: lngLat })
  })
  onBaseClick((lngLat) => {
    if (isReporting()) {
      handleReportClick(lngLat)
      return
    }
    // A tap off the road never throws away a review being written, and lets go
    // of a picked stretch before it closes anything: one thing per tap.
    if (clearStretchSelection()) return
    if (isPanelOpen()) deselect()
  })

  initSearch({
    onRoad: (id) => void select(id),
    onCity: (city) => void selectArea('city', city),
    onState: (st) => void selectArea('state', st),
  })

  initBrowse({
    onRoad: (id) => void select(id),
    onClose: () => {
      closePanel()
      document.getElementById('btn-browse')?.setAttribute('aria-pressed', 'false')
    },
    onAreaClear: () => clearArea(),
  })
  document.getElementById('btn-browse')?.addEventListener('click', () => {
    const btn = document.getElementById('btn-browse')!
    if (isPanelOpen() && panelMode() === 'browse') {
      closePanel()
      btn.setAttribute('aria-pressed', 'false')
    } else {
      // going back to the list means dropping the open road or company, not
      // the city the user narrowed to — deselect clears both, so put the area
      // back. A company counts too: its URL, title and lit-up roads would
      // otherwise outlive the profile the list just replaced.
      const area = currentArea
      if ((state.selectedId || selectedOrgId) && !deselect()) return
      if (area) applyArea(area)
      openBrowse(area ? { area: areaFilter(area) } : {})
      btn.setAttribute('aria-pressed', 'true')
    }
  })

  initLocate((id, opts) => void select(id, opts), loadDetailTier)
  // report mode is a tap on the map and its pins sit on the map, so it waits
  // for one — and stays off in a browser that could not start it
  void mapReady.then((ok) => {
    if (ok) initReports()
  })

  document.getElementById('btn-theme')?.addEventListener('click', () => toggleTheme())

  document.getElementById('brand-link')?.addEventListener('click', (e) => {
    e.preventDefault()
    if (deselect()) flyHome()
  })

  // "Connected roads" chips in the panel select without tight coupling
  document.addEventListener('rti:select-road', (e) => {
    const id = (e as CustomEvent<{ id?: string }>).detail?.id
    if (id) void select(id)
  })
  document.addEventListener('rti:select-org', (e) => {
    const id = (e as CustomEvent<{ id?: string }>).detail?.id
    if (id) void selectOrg(id)
  })
  // the review composer sits low in the sheet — bring it up before focusing it
  document.addEventListener('rti:expand-sheet', () => expandSheet())

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return // report mode/dialog consumed it
    const searchOpen = !document.getElementById('search-list')?.hidden
    if (searchOpen || isReporting()) return // handled elsewhere
    if (clearStretchSelection()) return // a review being written, then a picked stretch, then the panel
    if (isPanelOpen()) deselect()
  })

  // ── deep link ────────────────────────────────────────────────────
  const go = (route: ReturnType<typeof currentRoute>, fromRouter: boolean) => {
    if (route?.kind === 'road') void select(route.id, { fromRouter })
    else if (route?.kind === 'org') void selectOrg(route.id, { fromRouter })
    else deselect({ fromRouter })
  }
  initRouter((route) => go(route, true))
  const initial = currentRoute()
  if (initial) go(initial, true)
}

void boot()
