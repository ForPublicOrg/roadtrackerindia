/**
 * Community reports: potholes, damaged stretches, waterlogging.
 * Anyone can drop a pin; you can remove your own pins; in shared (Firestore)
 * mode others can "mark fixed" — three such votes hide the report.
 */
import maplibregl from 'maplibre-gl'
import { state } from './state'
import type { ReportItem, ReportType } from './types'
import { getStore } from './storage'
import { getMap } from './map'
import { nearestRoads } from './geo'
import { esc, relTime, toast } from './ui'

const TYPE_META: Record<ReportType, { label: string; cls: string; icon: string }> = {
  pothole: {
    label: 'Pothole',
    cls: 'rt-pothole',
    icon: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8" cy="8" r="1.9" fill="currentColor"/></svg>',
  },
  damage: {
    label: 'Damaged road',
    cls: 'rt-damage',
    icon: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6 15 14H1Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8 6v3.4M8 11.6v.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  },
  flooding: {
    label: 'Waterlogged',
    cls: 'rt-flooding',
    icon: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8S3.6 7 3.6 9.8a4.4 4.4 0 0 0 8.8 0C12.4 7 8 1.8 8 1.8Z" fill="currentColor"/></svg>',
  },
}

const markers = new Map<string, maplibregl.Marker>()
let popup: maplibregl.Popup | null = null
let dialogOpen = false

export function isReporting(): boolean {
  return state.reportMode
}

export function initReports(): void {
  const btn = document.getElementById('btn-report')!
  btn.addEventListener('click', () => (state.reportMode ? exitReportMode() : enterReportMode()))
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (dialogOpen || state.reportMode)) {
      e.preventDefault() // stop the global handler from also closing the panel
      if (dialogOpen) closeDialog()
      else exitReportMode()
    }
  })
  // show the user's own pins from previous visits
  void getStore().then(async (store) => {
    const mine = await store.getMyReports()
    mine.forEach(addMarker)
  })
}

export function enterReportMode(): void {
  state.reportMode = true
  document.body.classList.add('is-reporting')
  document.getElementById('btn-report')?.setAttribute('aria-pressed', 'true')
  getMap().getCanvas().style.cursor = 'crosshair'
  toast('Tap the exact spot on the road you want to report.', {
    action: { label: 'Cancel', cb: exitReportMode },
    duration: 6000,
  })
}

export function exitReportMode(): void {
  state.reportMode = false
  document.body.classList.remove('is-reporting')
  document.getElementById('btn-report')?.setAttribute('aria-pressed', 'false')
  getMap().getCanvas().style.cursor = ''
  closeDialog()
}

/** Called from the map click handler. Returns true when the click was consumed. */
export function handleMapClick(lngLat: [number, number]): boolean {
  if (!state.reportMode) return false
  if (!state.network) return true
  const near = nearestRoads(lngLat, state.network, 1)[0]
  if (!near || near.distKm > 4) {
    toast('Please tap on or right next to a road shown on the map.')
    return true
  }
  openDialog(lngLat, near.id, near.ref)
  return true
}

// ── dialog ─────────────────────────────────────────────────────────

function openDialog(lngLat: [number, number], roadId: string, roadRef: string): void {
  const host = document.getElementById('report-dialog')!
  let type: ReportType | null = null
  dialogOpen = true

  host.innerHTML = `
    <h2>Report a problem</h2>
    <p class="rp-sub">On <b>${esc(roadRef)}</b> at the spot you tapped.</p>
    <div class="rp-types" role="group" aria-label="What kind of problem?">
      ${(Object.keys(TYPE_META) as ReportType[])
        .map(
          (t) => `<button class="rp-type" data-type="${t}" aria-pressed="false">
            <span class="ri-ico ${TYPE_META[t].cls}" style="width:34px;height:34px;border-radius:10px;display:grid;place-items:center;color:#fff">${TYPE_META[t].icon}</span>
            ${TYPE_META[t].label}</button>`,
        )
        .join('')}
    </div>
    <textarea class="rp-note" id="rp-note" rows="2" maxlength="280" placeholder="Anything helpful to add? (optional)"></textarea>
    <div class="rp-actions">
      <button class="btn btn-ghost" id="rp-cancel">Cancel</button>
      <button class="btn btn-primary" id="rp-save" disabled>Add report</button>
    </div>`
  host.hidden = false

  host.querySelector<HTMLButtonElement>('.rp-type')?.focus()

  const save = host.querySelector<HTMLButtonElement>('#rp-save')!
  host.querySelectorAll<HTMLButtonElement>('.rp-type').forEach((b) =>
    b.addEventListener('click', () => {
      type = b.dataset.type as ReportType
      host.querySelectorAll('.rp-type').forEach((x) => x.setAttribute('aria-pressed', String(x === b)))
      save.disabled = false
    }),
  )
  host.querySelector('#rp-cancel')?.addEventListener('click', () => {
    closeDialog()
    exitReportMode()
  })
  save.addEventListener('click', async () => {
    if (!type) return
    save.disabled = true
    save.textContent = 'Saving…'
    const note = (host.querySelector('#rp-note') as HTMLTextAreaElement).value.trim()
    try {
      const store = await getStore()
      const item = await store.addReport({ roadId, type, lng: lngLat[0], lat: lngLat[1], note })
      addMarker(item)
      toast(
        store.mode === 'cloud'
          ? 'Thanks! Your report is now visible to everyone.'
          : 'Report saved on this device. (Connect Firebase to share reports publicly.)',
      )
      refreshPanelSlot(roadId)
    } catch {
      toast("Couldn't save the report — please try again.")
    }
    closeDialog()
    exitReportMode()
  })
}

function closeDialog(): void {
  const host = document.getElementById('report-dialog')!
  const hadFocus = host.contains(document.activeElement)
  host.hidden = true
  host.innerHTML = ''
  dialogOpen = false
  if (hadFocus) document.getElementById('btn-report')?.focus()
}

// ── markers & popups ───────────────────────────────────────────────

function addMarker(r: ReportItem): void {
  if (markers.has(r.id) || (!r.mine && r.fixedBy.length >= 3)) return
  const el = document.createElement('button')
  el.className = `report-marker ${TYPE_META[r.type].cls}`
  el.setAttribute('aria-label', `${TYPE_META[r.type].label} report`)
  el.innerHTML = TYPE_META[r.type].icon
  el.addEventListener('click', (e) => {
    e.stopPropagation()
    showPopup(r)
  })
  const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
    .setLngLat([r.lng, r.lat])
    .addTo(getMap())
  markers.set(r.id, marker)
}

function removeMarker(id: string): void {
  markers.get(id)?.remove()
  markers.delete(id)
}

function showPopup(r: ReportItem): void {
  popup?.remove()
  const div = document.createElement('div')
  div.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
      <span class="ri-ico ${TYPE_META[r.type].cls}" style="width:26px;height:26px;border-radius:8px;display:grid;place-items:center;color:#fff">${TYPE_META[r.type].icon}</span>
      <b>${TYPE_META[r.type].label}</b>
    </div>
    ${r.note ? `<div style="margin:6px 0;overflow-wrap:anywhere">${esc(r.note)}</div>` : ''}
    <div style="color:var(--ink-2);font-size:12px">${r.mine ? 'Reported by you' : 'Community report'} · ${relTime(r.createdAt)}</div>
    <div style="display:flex;gap:8px;margin-top:9px" class="rp-pop-actions"></div>`
  const actions = div.querySelector('.rp-pop-actions')!
  const mkBtn = (label: string, cb: () => void) => {
    const b = document.createElement('button')
    b.textContent = label
    b.style.cssText =
      'font-weight:650;font-size:12.5px;color:var(--accent);padding:4px 8px;border-radius:6px;background:color-mix(in srgb,var(--accent) 10%,transparent)'
    b.addEventListener('click', cb)
    actions.appendChild(b)
  }
  void getStore().then((store) => {
    if (r.mine) {
      mkBtn('Remove report', async () => {
        try {
          await store.removeReport(r.id)
          removeMarker(r.id)
          popup?.remove()
          toast('Report removed.')
          refreshPanelSlot(r.roadId)
        } catch {
          toast("Couldn't remove it — try again.")
        }
      })
    } else if (store.mode === 'cloud') {
      mkBtn('✓ It’s fixed now', async () => {
        try {
          await store.markFixed(r.id)
          popup?.remove()
          toast('Thanks! With a few confirmations this report will disappear.')
        } catch {
          toast("Couldn't record that — try again.")
        }
      })
    }
  })
  popup = new maplibregl.Popup({ offset: 20, maxWidth: '270px' })
    .setLngLat([r.lng, r.lat])
    .setDOMContent(div)
    .addTo(getMap())
}

// ── panel section ──────────────────────────────────────────────────

function refreshPanelSlot(roadId: string): void {
  const slot = document.getElementById('reports-slot')
  if (slot && state.selectedId === roadId) {
    const summary = state.byId.get(roadId)
    void renderRoadReports(slot, roadId, summary?.ref ?? '')
  }
}

export async function renderRoadReports(el: HTMLElement, roadId: string, roadRef: string): Promise<void> {
  el.innerHTML = `<h3>Road problems</h3><div class="skel" style="height:44px"></div>`
  const store = await getStore()
  let items: ReportItem[] = []
  try {
    items = await store.getReportsForRoad(roadId)
  } catch {
    /* offline — show just the CTA */
  }
  if (state.selectedId !== roadId) return
  items.forEach(addMarker)

  const list = items.length
    ? `<div style="display:grid;gap:8px">${items
        .map(
          (r) => `<div class="report-item" data-id="${esc(r.id)}">
          <span class="ri-ico ${TYPE_META[r.type].cls}">${TYPE_META[r.type].icon}</span>
          <span class="ri-main">
            <span class="ri-type">${TYPE_META[r.type].label}</span>
            ${r.note ? `<div class="ri-note">${esc(r.note)}</div>` : ''}
            <div class="ri-time">${r.mine ? 'You' : 'Someone'} reported this ${relTime(r.createdAt)}</div>
          </span>
          <span class="ri-actions">
            ${r.mine ? `<button data-act="remove">Remove</button>` : store.mode === 'cloud' ? `<button data-act="fixed">Fixed?</button>` : ''}
          </span>
        </div>`,
        )
        .join('')}</div>`
    : `<p class="rd-meta-line" style="margin-top:0">No problems reported on ${esc(roadRef)} yet.</p>`

  el.innerHTML = `<h3>Road problems</h3>${list}
    <button class="panel-cta" id="report-cta">
      <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2v10M2 7h10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      Report a pothole, damage or flooding
    </button>
    <p class="rating-note" style="margin:8px 0 0">${
      store.mode === 'cloud'
        ? 'Reports are shared with all visitors. Three “fixed” confirmations hide a report.'
        : 'Reports are saved on this device only.'
    }</p>`

  el.querySelector('#report-cta')?.addEventListener('click', () => enterReportMode())
  el.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.closest<HTMLElement>('.report-item')!.dataset.id!
      try {
        if (btn.dataset.act === 'remove') {
          await store.removeReport(id)
          removeMarker(id)
          toast('Report removed.')
        } else {
          await store.markFixed(id)
          toast('Thanks! With a few confirmations this report will disappear.')
        }
        void renderRoadReports(el, roadId, roadRef)
      } catch {
        toast('That didn’t go through — try again.')
      }
    })
  })
}
