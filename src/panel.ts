import type { RoadDetail, RoadSummary } from './types'
import { esc, CATEGORY_LABEL, STATUS_LABEL, toast, relTime } from './ui'
import { formatKm } from './geo'
import { state } from './state'
import { loadNews } from './data'
import { prefersReducedMotion, spring, type SpringHandle } from './animate'
import { renderRatingRow } from './ratings'
import { renderRoadReports } from './reports'
import { behindHtml, contactsHtml, helplinesFor, loadOrg, orgKnown, tollHtml } from './orgs'

type PanelMode = 'detail' | 'browse' | 'org'
type SheetState = 'peek' | 'full'

const panel = () => document.getElementById('panel')!
const content = () => document.getElementById('panel-content')!

let mode: PanelMode | null = null
let onCloseCb: () => void = () => {}
let sheetY = 0
let sheetAnim: SpringHandle | null = null
let sheetShown = false
let sheetState: SheetState = 'peek'
let pendingClose: (() => void) | null = null
let lastFocus: HTMLElement | null = null
const PEEK_VISIBLE = 196

export function onPanelClose(cb: () => void): void {
  onCloseCb = cb
}

const isMobile = () => matchMedia('(max-width: 768px)').matches

export function openPanel(newMode: PanelMode, sheet: SheetState = 'peek'): void {
  mode = newMode
  pendingClose?.() // a close animation is in flight — cancel it, don't let it hide us
  pendingClose = null
  const el = panel()
  if (!(document.activeElement instanceof HTMLElement) || !el.contains(document.activeElement)) {
    lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  el.hidden = false
  if (isMobile()) {
    void el.offsetHeight // flush layout so the sheet animates from off-screen
    snapSheet(newMode === 'browse' ? 'full' : sheet)
  } else {
    void el.offsetHeight // flush layout so the CSS transition runs
    el.classList.add('is-open')
  }
}

export function closePanel(): void {
  const el = panel()
  if (el.hidden) return
  mode = null
  // hand keyboard focus back to where the user was before the panel opened
  if (el.contains(document.activeElement)) {
    ;(lastFocus && document.contains(lastFocus)
      ? lastFocus
      : document.getElementById('search-input'))?.focus({ preventScroll: true })
  }
  if (isMobile()) {
    sheetAnim?.cancel()
    const h = el.getBoundingClientRect().height
    sheetShown = false
    sheetAnim = spring(sheetY, h, setSheetY, () => {
      el.hidden = true
    })
    if (prefersReducedMotion()) el.hidden = true
  } else {
    el.classList.remove('is-open')
    if (prefersReducedMotion() || document.visibilityState === 'hidden') {
      el.hidden = true
    } else {
      const done = () => {
        el.hidden = true
        cancel()
      }
      const cancel = () => {
        el.removeEventListener('transitionend', done)
        clearTimeout(fallback)
        pendingClose = null
      }
      // transitionend can be swallowed (tab hidden mid-close) — never get stuck
      const fallback = setTimeout(done, 600)
      el.addEventListener('transitionend', done)
      pendingClose = cancel // openPanel() calls this if we reopen mid-close
    }
  }
}

export function isPanelOpen(): boolean {
  return !panel().hidden
}
export function panelMode(): PanelMode | null {
  return mode
}

// ── mobile bottom sheet ────────────────────────────────────────────

function setSheetY(y: number): void {
  sheetY = y
  panel().style.transform = `translateY(${y}px)`
}

function snapSheet(state: SheetState): void {
  const h = panel().getBoundingClientRect().height
  const target = state === 'full' ? 0 : Math.max(0, h - PEEK_VISIBLE)
  sheetAnim?.cancel()
  sheetState = state
  content().style.overflowY = state === 'full' ? 'auto' : 'hidden'
  // collapsed: keep the browser from claiming vertical pans so the whole card drags
  content().style.touchAction = state === 'full' ? 'pan-y' : 'none'
  const from = sheetShown ? sheetY : h // first open animates up from off-screen
  sheetShown = true
  sheetAnim = spring(from, target, setSheetY)
}

export function expandSheet(): void {
  if (isMobile() && isPanelOpen()) snapSheet('full')
}

export function initSheetGestures(): void {
  const el = panel()
  const handle = document.getElementById('sheet-handle')!
  const DRAG_THRESHOLD = 8 // px of movement before a touch counts as a drag, not a tap
  let startY = 0
  let startSheetY = 0
  let lastY = 0
  let lastT = 0
  let velocity = 0
  let armed = false
  let dragging = false
  let suppressClick = false

  const onDown = (e: PointerEvent) => {
    if (!isMobile() || el.hidden || !e.isPrimary) return
    // expanded sheet: the content area scrolls, so only the handle starts a drag
    if (sheetState === 'full' && !handle.contains(e.target as Node)) return
    armed = true
    dragging = false
    suppressClick = false
    startY = lastY = e.clientY
    startSheetY = sheetY
    lastT = performance.now()
    velocity = 0
  }
  const onMove = (e: PointerEvent) => {
    if (!armed) return
    if (!dragging) {
      if (Math.abs(e.clientY - startY) < DRAG_THRESHOLD) return
      dragging = true
      startY = e.clientY
      startSheetY = sheetY
      sheetAnim?.cancel()
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        /* pointer already gone — bubbling listeners still track it */
      }
    }
    const now = performance.now()
    const dy = e.clientY - lastY
    const dt = Math.max(1, now - lastT)
    velocity = (dy / dt) * 1000
    lastY = e.clientY
    lastT = now
    setSheetY(Math.max(0, startSheetY + (e.clientY - startY)))
  }
  const onUp = () => {
    armed = false
    if (!dragging) return
    dragging = false
    suppressClick = true
    const h = el.getBoundingClientRect().height
    const peekTarget = h - PEEK_VISIBLE
    if (velocity > 650 && sheetY > peekTarget * 0.55) {
      // fast downward fling from low position → dismiss
      onCloseCb()
      return
    }
    if (velocity > 380) {
      snapSheet('peek')
    } else if (velocity < -380) {
      snapSheet('full')
    } else {
      snapSheet(sheetY < peekTarget / 2 ? 'full' : 'peek')
    }
  }

  el.addEventListener('pointerdown', onDown)
  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', onUp)
  el.addEventListener('pointercancel', onUp)
  // capture phase so a drag's trailing click never reaches buttons underneath
  el.addEventListener(
    'click',
    (e) => {
      if (!suppressClick) return
      suppressClick = false
      e.preventDefault()
      e.stopPropagation()
    },
    true,
  )
  el.addEventListener('click', (e) => {
    if (!isMobile()) return
    const target = e.target as HTMLElement
    if (handle.contains(target)) {
      const h = el.getBoundingClientRect().height
      snapSheet(sheetY > (h - PEEK_VISIBLE) / 2 ? 'full' : 'peek')
      return
    }
    // collapsed card: tapping anywhere non-interactive pulls it up
    if (sheetState === 'peek' && !target.closest('button, a, input, select, textarea, summary, label, [role="button"]')) {
      snapSheet('full')
    }
  })
}

// ── loading skeleton ───────────────────────────────────────────────

export function showLoading(summary: RoadSummary): void {
  content().innerHTML = `
    ${headHtml(summary.ref, summary.category, summary.name)}
    <div class="rd-chips">${chipsHtml(summary)}</div>
    <div class="rd-section">
      <div class="skel" style="height:15px;width:70%"></div>
      <div style="height:9px"></div>
      <div class="skel" style="height:15px;width:52%"></div>
      <div style="height:9px"></div>
      <div class="skel" style="height:15px;width:63%"></div>
    </div>`
  wireHead()
  openPanel('detail')
}

// ── detail rendering ───────────────────────────────────────────────

function headHtml(ref: string, category: string, name: string): string {
  return `
    <div class="rd-head">
      <span class="rd-ref cat-${esc(category)}">${esc(ref)}</span>
      <h2 class="rd-name" tabindex="-1">${esc(name)}</h2>
      <button class="rd-close" id="rd-close" aria-label="Close road details">
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
          <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
        </svg>
      </button>
    </div>`
}

function chipsHtml(s: { lengthKm: number; status: string; completionPercent?: number; states: string[] }): string {
  const pct =
    s.status === 'under-construction' && s.completionPercent !== undefined
      ? ` · ${s.completionPercent}%`
      : ''
  const stateChip =
    s.states.length > 1
      ? `<span class="chip"><b>${s.states.length}</b>&nbsp;states</span>`
      : `<span class="chip">${esc(s.states[0] ?? '')}</span>`
  return `
    <span class="chip"><b>${formatKm(s.lengthKm)}</b></span>
    <span class="chip status-pill st-${esc(s.status)}">${STATUS_LABEL[s.status] ?? s.status}${pct}</span>
    ${stateChip}`
}

function wireHead(): void {
  document.getElementById('rd-close')?.addEventListener('click', () => onCloseCb())
}

export function renderDetail(d: RoadDetail, summary: RoadSummary): void {
  const cityLine = d.route.majorCities.join(' · ')
  const kv: string[] = []
  if (d.lanes) kv.push(`<dt>Lanes</dt><dd>${esc(d.lanes)}</dd>`)
  // the linked org chips say this better — the free text is the fallback for
  // the thousands of OpenStreetMap roads that have no organisation on file
  if (d.agency && !orgKnown(d.authority)) kv.push(`<dt>Looked after by</dt><dd>${esc(d.agency)}</dd>`)
  if (d.cost) kv.push(`<dt>Project cost</dt><dd>${esc(d.cost)}</dd>`)
  if (d.contractor && !d.builtBy?.length) kv.push(`<dt>Built by</dt><dd>${esc(d.contractor)}</dd>`)

  const tolls = '' // toll plazas now render with their rates, in their own section

  const timeline = d.timeline?.length
    ? `<div class="rd-section"><h3>Timeline</h3><ol class="rd-timeline">${d.timeline
        .map((t) => `<li><span class="tl-year">${esc(t.year)}</span><span>${esc(t.event)}</span></li>`)
        .join('')}</ol></div>`
    : ''

  const interchanges = d.interchanges?.length
    ? `<div class="rd-section"><h3>Key junctions</h3><ul class="rd-list">${d.interchanges
        .map((x) => `<li><b>${esc(x.name)}</b>${x.note ? ` <span style="color:var(--ink-2)">— ${esc(x.note)}</span>` : ''}</li>`)
        .join('')}</ul></div>`
    : ''

  const hasMore = kv.length > 0 || tolls || timeline || interchanges
  const more = hasMore
    ? `<details class="rd-more" ${matchMedia('(min-width: 769px)').matches ? 'open' : ''}>
         <summary>More details</summary>
         ${kv.length ? `<dl class="kv">${kv.join('')}</dl>` : ''}
         ${interchanges}${tolls}${timeline}
       </details>`
    : ''

  const significance = d.significance
    ? `<div class="rd-section"><h3>Why it matters</h3><p class="rd-history">${esc(d.significance)}</p></div>`
    : ''
  const engineering = d.engineering?.length
    ? `<div class="rd-section"><h3>Engineering highlights</h3><ul class="rd-list">${d.engineering
        .map((x) => `<li><b>${esc(x.name)}</b>${x.note ? ` <span style="color:var(--ink-2)">— ${esc(x.note)}</span>` : ''}</li>`)
        .join('')}</ul></div>`
    : ''
  const travel = d.travelNotes
    ? `<div class="rd-section"><h3>On the road</h3><p class="rd-history">${esc(d.travelNotes)}</p></div>`
    : ''
  const future = d.futureUpgrades?.length
    ? `<div class="rd-section"><h3>What's coming next</h3><ul class="rd-list">${d.futureUpgrades
        .map((f) => `<li>${esc(f)}</li>`)
        .join('')}</ul></div>`
    : ''
  const related = (d.relatedRoads ?? []).filter((r) => state.byId.has(r.id))
  const relatedHtml = related.length
    ? `<div class="rd-section"><h3>Connected roads</h3><div class="rel-chips">${related
        .map((r) => {
          const s = state.byId.get(r.id)!
          // A short label ("Met near Barshi") is the one thing the chip cannot
          // already show, so it goes on screen. A long one stays a tooltip —
          // there is no hover on a phone, but there is no room for it either.
          const inline = r.label && r.label.length <= 30 ? r.label : null
          return `<button class="rel-chip" data-road="${esc(r.id)}" title="${esc(r.label ?? s.name)}">
            <span class="sr-badge cat-${s.category}">${esc(s.ref.length <= 9 ? s.ref : s.ref.split(/[\s–—]/)[0])}</span>
            <span class="rc-main"><span class="rc-name">${esc(s.name)}</span>${
              inline ? `<span class="rc-where">${esc(inline)}</span>` : ''
            }</span></button>`
        })
        .join('')}</div></div>`
    : ''

  const history = d.history
    ? `<div class="rd-section"><h3>History</h3><p class="rd-history">${esc(d.history)}</p></div>`
    : ''
  const facts = d.facts?.length
    ? `<div class="rd-section"><h3>Good to know</h3><ul class="rd-list">${d.facts
        .map((f) => `<li>${esc(f)}</li>`)
        .join('')}</ul></div>`
    : ''

  const sparse =
    !hasMore && !d.history && !d.facts?.length && !d.significance
      ? `<div class="rd-section"><div class="rd-sparse">We're still compiling detailed records for this road. The route on the map, its length and status are verified — richer history, toll and project details are on the way.</div></div>`
      : ''

  const sources = `<div class="rd-section"><h3>Sources</h3><div class="rd-sources">${d.sources
    .map(
      (s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2h6v6M10 2L2 10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>${esc(s.title)}</a>`,
    )
    .join('')}</div>${
      d.provenance === 'osm'
        ? `<p class="rd-provenance">Route, length and place names for this road come from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors (ODbL).</p>`
        : ''
    }</div>`

  content().innerHTML = `
    ${headHtml(d.ref, d.category, d.name)}
    ${d.aka?.length ? `<p class="rd-aka">Also known as: ${d.aka.map(esc).join(' · ')}</p>` : ''}
    <div class="rd-chips">${chipsHtml({ ...d, states: d.route.states })}
      <span class="chip">${CATEGORY_LABEL[d.category]}</span>
    </div>
    <div class="rd-section" id="rating-slot"></div>
    <div class="rd-section">
      <h3>Route</h3>
      <div class="rd-route-ends">
        <i class="re-dot"></i><span>${esc(d.route.start)}</span>
        <i class="re-bar"></i><span></span>
        <i class="re-flag"></i><span>${esc(d.route.end)}</span>
      </div>
      <p class="rd-meta-line"><b>Through:</b> ${esc(d.route.states.join(', '))}</p>
      <p class="rd-meta-line"><b>Main stops:</b> ${esc(cityLine)}</p>
    </div>
    ${tollHtml(d)}
    <div id="contacts-slot"></div>
    ${behindHtml(d)}
    ${significance}
    ${more}
    ${engineering}
    ${history}
    ${facts}
    ${travel}
    ${future}
    ${relatedHtml}
    ${sparse}
    <div class="rd-section" id="news-slot" hidden></div>
    <div class="rd-section" id="reports-slot"></div>
    ${sources}
    <div class="rd-section">
      <button class="panel-cta" id="copy-link">
        <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M5.5 8.5l3-3M6 3.5L7.8 1.7a2.6 2.6 0 013.7 3.7L9.7 7.2M8 10.5l-1.8 1.8a2.6 2.6 0 01-3.7-3.7L4.3 6.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        Copy link to this road
      </button>
    </div>`

  wireHead()
  // move screen-reader/keyboard context into the freshly opened panel
  content().querySelector<HTMLElement>('.rd-name')?.focus({ preventScroll: true })
  document.getElementById('copy-link')?.addEventListener('click', () => {
    const url = `${location.origin}/road/${d.id}/`
    navigator.clipboard
      .writeText(url)
      .then(() => toast('Link copied — share away!'))
      .catch(() => toast(url, { duration: 8000 }))
  })

  content()
    .querySelectorAll<HTMLButtonElement>('.rel-chip')
    .forEach((b) =>
      b.addEventListener('click', () =>
        document.dispatchEvent(new CustomEvent('rti:select-road', { detail: { id: b.dataset.road } })),
      ),
    )

  const ratingSlot = document.getElementById('rating-slot')!
  void renderRatingRow(ratingSlot, d.id)
  const reportsSlot = document.getElementById('reports-slot')!
  void renderRoadReports(reportsSlot, d.id, summary.ref)
  void fillNews(d.id)
  void fillContacts(d)
  wireOrgChips()
}

/** Org chips select a company without this module knowing how routing works. */
function wireOrgChips(): void {
  content()
    .querySelectorAll<HTMLButtonElement>('.og-chip[data-org]')
    .forEach((b) =>
      b.addEventListener('click', () =>
        document.dispatchEvent(new CustomEvent('rti:select-org', { detail: { id: b.dataset.org } })),
      ),
    )
}

/**
 * The numbers to ring. The national ones are always right, so they render
 * immediately; the authority's own numbers arrive with its profile.
 */
async function fillContacts(d: RoadDetail): Promise<void> {
  const paint = (html: string) => {
    const slot = document.getElementById('contacts-slot')
    if (slot && state.selectedId === d.id) slot.innerHTML = html
  }
  paint(contactsHtml(helplinesFor(d, null), undefined))
  if (!d.authority) return
  try {
    const org = await loadOrg(d.authority)
    paint(contactsHtml(helplinesFor(d, org), org.grievance))
  } catch {
    /* national numbers are already on screen — that is the part that matters */
  }
}

// ── organisation profile ───────────────────────────────────────────

export function renderOrg(html: string): void {
  content().innerHTML = html
  wireHead()
  content().querySelector<HTMLElement>('.rd-name')?.focus({ preventScroll: true })
  content()
    .querySelectorAll<HTMLButtonElement>('.br-row')
    .forEach((b) =>
      b.addEventListener('click', () =>
        document.dispatchEvent(new CustomEvent('rti:select-road', { detail: { id: b.dataset.id } })),
      ),
    )
}

export function showOrgLoading(name: string): void {
  content().innerHTML = `
    <div class="rd-head">
      <h2 class="rd-name" tabindex="-1">${esc(name)}</h2>
      <button class="rd-close" id="rd-close" aria-label="Close">
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
          <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
    <div class="rd-section">
      <div class="skel" style="height:15px;width:70%"></div>
      <div style="height:9px"></div>
      <div class="skel" style="height:15px;width:52%"></div>
    </div>`
  wireHead()
  openPanel('org', 'full')
}

/** "In the news" — latest-first headlines snapshotted at build time. */
async function fillNews(id: string): Promise<void> {
  const slot = document.getElementById('news-slot')
  if (!slot) return
  try {
    const snap = await loadNews(id)
    if (state.selectedId !== id || !snap.items.length) return
    slot.hidden = false
    slot.innerHTML = `<h3>In the news</h3>
      <ul class="news-list">${snap.items
        .map(
          (n) => `<li><a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">
            <span class="nw-title">${esc(n.title)}</span>
            <span class="nw-meta">${esc(n.source || 'News')}${n.date ? ` · ${relTime(Date.parse(n.date))}` : ''}</span>
          </a></li>`,
        )
        .join('')}</ul>
      <p class="rating-note">Headlines auto-collected from Google News, newest first · snapshot ${relTime(Date.parse(snap.generated))}</p>`
  } catch {
    /* no news snapshot for this road — section stays hidden */
  }
}

// ── browse mode uses the same shell ───────────────────────────────

export function setBrowseContent(el: HTMLElement): void {
  content().replaceChildren(el)
}
