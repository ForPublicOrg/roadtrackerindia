import '@fontsource-variable/inter'
import '@fontsource-variable/fraunces'
import './styles.css'

import type { BBox } from './types'
import { initTheme, toggleTheme } from './theme'
import { emit, state } from './state'
import { loadDetail, loadIndex, loadNetwork, loadNetworkDetail, loadOrg, loadShape } from './data'
import {
  clearSelected,
  detailNetworkFailed,
  flyHome,
  flyToRoad,
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
import { initBrowse, openBrowse } from './browse'
import { initLocate } from './locate'
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

async function boot(): Promise<void> {
  initTheme()
  initLegend()

  const mapReady = initMap()

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
  state.network = network
  emit('dataready', undefined)

  await mapReady
  setNetworkData(network)

  // thousands of state and district roads — fetched the first time the map is
  // zoomed in far enough for them to be legible, never on the home view
  onDetailNetworkNeeded(() => {
    void loadNetworkDetail()
      .then(setDetailNetworkData)
      .catch(() => {
        // the trunk network still works, so this needs no alarm — but let the
        // next zoom retry rather than leaving the tier dead for the session
        detailNetworkFailed()
      })
  })

  void initOrgs() // org names for the panel chips; the page works without them

  // ── selection flow ───────────────────────────────────────────────
  let selectToken = 0
  let selectedOrgId: string | null = null

  function clearOrg(): void {
    if (!selectedOrgId) return
    selectedOrgId = null
    highlightRoads(null)
  }

  async function select(id: string, opts: { skipFly?: boolean; fromRouter?: boolean } = {}) {
    clearOrg()
    const summary = state.byId.get(id)
    if (!summary) {
      toast("We don't have that road catalogued (yet).")
      if (opts.fromRouter) replaceHome() // never pushState inside popstate — traps the back button
      else navigateHome()
      applyMeta(null)
      return
    }
    const token = ++selectToken
    const already = state.selectedId === id
    state.selectedId = id
    emit('select', id)
    document.getElementById('btn-browse')?.setAttribute('aria-pressed', 'false')

    if (!already || !isPanelOpen()) showLoading(summary)
    if (!opts.skipFly) flyToRoad(summary.bbox)
    if (opts.fromRouter) applyMeta(summary)
    else navigateToRoad(summary)

    try {
      const [detail, shape] = await Promise.all([loadDetail(id), loadShape(id)])
      if (token !== selectToken) return
      showSelected(shape, summary.category, summary.lengthKm)
      renderDetail(detail, summary)
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
    const token = ++selectToken
    state.selectedId = null
    emit('select', null)
    clearSelected()
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

  function deselect(opts: { fromRouter?: boolean } = {}) {
    selectToken++
    const hadSelection = state.selectedId !== null || selectedOrgId !== null
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
  }

  // ── wire everything ──────────────────────────────────────────────
  initSheetGestures()
  onPanelClose(() => deselect())

  onRoadClick((id, lngLat) => {
    if (isReporting()) {
      handleReportClick(lngLat)
      return
    }
    void select(id)
  })
  onBaseClick((lngLat) => {
    if (isReporting()) {
      handleReportClick(lngLat)
      return
    }
    if (isPanelOpen()) deselect()
  })

  initSearch({
    onRoad: (id) => void select(id),
    onCity: (city) => {
      deselect()
      openBrowse({ city })
      document.getElementById('btn-browse')?.setAttribute('aria-pressed', 'true')
    },
    onState: (st) => {
      deselect()
      openBrowse({ state: st })
      document.getElementById('btn-browse')?.setAttribute('aria-pressed', 'true')
    },
  })

  initBrowse({
    onRoad: (id) => void select(id),
    onClose: () => {
      closePanel()
      document.getElementById('btn-browse')?.setAttribute('aria-pressed', 'false')
    },
  })
  document.getElementById('btn-browse')?.addEventListener('click', () => {
    const btn = document.getElementById('btn-browse')!
    if (isPanelOpen() && panelMode() === 'browse') {
      closePanel()
      btn.setAttribute('aria-pressed', 'false')
    } else {
      if (state.selectedId) deselect()
      openBrowse()
      btn.setAttribute('aria-pressed', 'true')
    }
  })

  initLocate((id, opts) => void select(id, opts))
  initReports()

  document.getElementById('btn-theme')?.addEventListener('click', () => toggleTheme())

  document.getElementById('brand-link')?.addEventListener('click', (e) => {
    e.preventDefault()
    deselect()
    flyHome()
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

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return // report mode/dialog consumed it
    const searchOpen = !document.getElementById('search-list')?.hidden
    if (searchOpen || isReporting()) return // handled elsewhere
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
