import '@fontsource-variable/inter'
import '@fontsource-variable/fraunces'
import './styles.css'

import { initTheme, toggleTheme } from './theme'
import { emit, state } from './state'
import { loadDetail, loadIndex, loadNetwork, loadShape } from './data'
import {
  clearSelected,
  flyHome,
  flyToRoad,
  initMap,
  onBaseClick,
  onRoadClick,
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
  showLoading,
} from './panel'
import { initSearch } from './search'
import { initBrowse, openBrowse } from './browse'
import { initLocate } from './locate'
import { initReports, handleMapClick as handleReportClick, isReporting } from './reports'
import { applyMeta, currentRoadId, initRouter, navigateHome, navigateToRoad, replaceHome } from './router'
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

  // ── selection flow ───────────────────────────────────────────────
  let selectToken = 0

  async function select(id: string, opts: { skipFly?: boolean; fromRouter?: boolean } = {}) {
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

  function deselect(opts: { fromRouter?: boolean } = {}) {
    selectToken++
    const hadSelection = state.selectedId !== null
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

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return // report mode/dialog consumed it
    const searchOpen = !document.getElementById('search-list')?.hidden
    if (searchOpen || isReporting()) return // handled elsewhere
    if (isPanelOpen()) deselect()
  })

  // ── deep link ────────────────────────────────────────────────────
  initRouter((roadId) => {
    if (roadId) void select(roadId, { fromRouter: true })
    else deselect({ fromRouter: true })
  })
  const initial = currentRoadId()
  if (initial) void select(initial, { fromRouter: true })
}

void boot()
