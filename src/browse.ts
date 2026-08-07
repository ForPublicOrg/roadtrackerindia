import { state } from './state'
import type { Category, RoadSummary, Status } from './types'
import { esc, STATUS_LABEL } from './ui'
import { formatKm } from './geo'
import { openPanel, setBrowseContent } from './panel'

interface Filters {
  category: Category | 'all'
  status: Status | 'all'
  state: string
  city: string | null
}

const filters: Filters = { category: 'all', status: 'all', state: 'all', city: null }

const MAX_ROWS = 400

let onRoad: (id: string) => void = () => {}
let onClose: () => void = () => {}

export function initBrowse(cb: { onRoad: (id: string) => void; onClose: () => void }): void {
  onRoad = cb.onRoad
  onClose = cb.onClose
}

export function openBrowse(preset: Partial<Filters> = {}): void {
  Object.assign(filters, { category: 'all', status: 'all', state: 'all', city: null }, preset)
  render()
  openPanel('browse', 'full')
}

function allStates(): string[] {
  const set = new Set<string>()
  for (const r of state.roads) r.states.forEach((s) => set.add(s))
  return [...set].sort()
}

function matches(r: RoadSummary): boolean {
  if (filters.category !== 'all' && r.category !== filters.category) return false
  if (filters.status !== 'all' && r.status !== filters.status) return false
  if (filters.state !== 'all' && !r.states.includes(filters.state)) return false
  if (filters.city && !r.cities.includes(filters.city)) return false
  return true
}

const CAT_CHIPS: [Category | 'all', string][] = [
  ['all', 'All'],
  ['expressway', 'Expressways'],
  ['nh', 'National'],
  ['sh', 'State'],
  ['district', 'District'],
  ['local', 'City'],
]
const STATUS_CHIPS: [Status | 'all', string][] = [
  ['all', 'Any status'],
  ['operational', 'Open'],
  ['under-construction', 'Being built'],
  ['planned', 'Planned'],
]

function render(): void {
  const root = document.createElement('div')

  const rows = state.roads.filter(matches)
  rows.sort((a, b) => b.lengthKm - a.lengthKm)
  // "All roads" is thousands of rows; building that much DOM janks the sheet
  // open, and nobody scrolls past the first screenful anyway
  const shown = rows.slice(0, MAX_ROWS)

  root.innerHTML = `
    <div class="rd-head">
      <h2 class="rd-name" style="font-size:21px">Browse roads</h2>
      <button class="rd-close" id="br-close" aria-label="Close browse">
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
          <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
    <div class="br-filters">
      ${filters.city ? `<div class="br-chip-row"><button class="br-chip" id="br-city-clear" aria-pressed="true">Through ${esc(filters.city)} ✕</button></div>` : ''}
      <div class="br-chip-row" role="group" aria-label="Filter by road type">
        ${CAT_CHIPS.map(([v, l]) => `<button class="br-chip" data-cat="${v}" aria-pressed="${filters.category === v}">${l}</button>`).join('')}
      </div>
      <div class="br-chip-row" role="group" aria-label="Filter by status">
        ${STATUS_CHIPS.map(([v, l]) => `<button class="br-chip" data-status="${v}" aria-pressed="${filters.status === v}">${l}</button>`).join('')}
      </div>
      <select class="br-select" id="br-state" aria-label="Filter by state">
        <option value="all">Every state &amp; UT</option>
        ${allStates().map((s) => `<option value="${esc(s)}" ${filters.state === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
      </select>
    </div>
    <p class="br-count">${shown.length === rows.length ? `${rows.length.toLocaleString('en-IN')} road${rows.length === 1 ? '' : 's'}` : `Longest ${shown.length} of ${rows.length.toLocaleString('en-IN')} roads — filter or search to narrow it down`}</p>
    <ul class="br-list">
      ${shown
        .map(
          (r) => `<li><button class="br-row" data-id="${esc(r.id)}">
            <span class="sr-badge cat-${esc(r.category)}">${esc(shortRef(r.ref))}</span>
            <span class="sr-main">
              <span class="sr-title">${esc(r.name)}</span>
              <span class="sr-sub">${esc(r.start.split(',')[0])} → ${esc(r.end.split(',')[0])}${r.states.length === 1 ? ` · ${esc(r.states[0])}` : ` · ${STATUS_LABEL[r.status]}`}</span>
            </span>
            <span class="br-len">${formatKm(r.lengthKm)}</span>
          </button></li>`,
        )
        .join('')}
    </ul>
    ${rows.length === 0 ? `<div class="rd-sparse" style="margin-top:6px">Nothing matches these filters yet — we're adding more roads all the time. Try clearing a filter.</div>` : ''}
  `

  root.querySelector('#br-close')?.addEventListener('click', () => onClose())
  root.querySelector('#br-city-clear')?.addEventListener('click', () => {
    filters.city = null
    render()
  })
  root.querySelectorAll('[data-cat]').forEach((b) =>
    b.addEventListener('click', () => {
      filters.category = (b as HTMLElement).dataset.cat as Filters['category']
      render()
    }),
  )
  root.querySelectorAll('[data-status]').forEach((b) =>
    b.addEventListener('click', () => {
      filters.status = (b as HTMLElement).dataset.status as Filters['status']
      render()
    }),
  )
  root.querySelector('#br-state')?.addEventListener('change', (e) => {
    filters.state = (e.target as HTMLSelectElement).value
    render()
  })
  root.querySelectorAll('.br-row').forEach((b) =>
    b.addEventListener('click', () => onRoad((b as HTMLElement).dataset.id!)),
  )

  setBrowseContent(root)
}

function shortRef(ref: string): string {
  return ref.length <= 7 ? ref : ref.split(/[\s–—]/)[0].slice(0, 7)
}
