import { state } from './state'
import type { RoadSummary } from './types'
import { esc } from './ui'
import { formatKm } from './geo'

interface RoadResult {
  kind: 'road'
  road: RoadSummary
  score: number
}
interface CityResult {
  kind: 'city'
  city: string
  roads: RoadSummary[]
  score: number
}
interface StateResult {
  kind: 'state'
  state: string
  roads: RoadSummary[]
  score: number
}
type Result = RoadResult | CityResult | StateResult

let onPickRoad: (id: string) => void = () => {}
let onPickCity: (city: string) => void = () => {}
let onPickState: (state: string) => void = () => {}
let active = -1
let results: Result[] = []

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[–—-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** "nh44" and "nh 44" should match the same way. */
const squash = (s: string) => norm(s).replace(/\s/g, '')

export function initSearch(cb: {
  onRoad: (id: string) => void
  onCity: (city: string) => void
  onState: (state: string) => void
}): void {
  onPickRoad = cb.onRoad
  onPickCity = cb.onCity
  onPickState = cb.onState
  const input = document.getElementById('search-input') as HTMLInputElement
  const list = document.getElementById('search-list')!

  input.addEventListener('input', () => update(input.value))
  input.addEventListener('focus', () => update(input.value))
  input.addEventListener('blur', () => setTimeout(hide, 150))
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!results.length) return
      const dir = e.key === 'ArrowDown' ? 1 : -1
      setActive(
        active === -1
          ? dir === 1
            ? 0
            : results.length - 1
          : (active + dir + results.length) % results.length,
      )
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (active >= 0 && results[active]) pick(results[active])
      else if (results[0]) pick(results[0])
    } else if (e.key === 'Escape') {
      hide()
      input.blur()
    }
  })

  // "/" focuses search from anywhere
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
      e.preventDefault()
      input.focus()
      input.select()
    }
  })

  // deep-linked search: /?q=nh 44
  const q = new URLSearchParams(location.search).get('q')
  if (q) {
    input.value = q
    input.focus()
    update(q)
  }
}

function update(raw: string): void {
  const q = norm(raw)
  if (q.length < 1) {
    hide()
    return
  }
  results = compute(q).slice(0, 8)
  render()
}

/**
 * Normalising 8,000 refs and names on every keystroke is the difference
 * between instant and laggy on a mid-range phone — do it once per road.
 */
interface Terms {
  ref: string
  name: string
  sname: string
  aka: string[]
}
const terms = new WeakMap<RoadSummary, Terms>()
function termsFor(road: RoadSummary): Terms {
  let t = terms.get(road)
  if (!t) {
    t = {
      ref: squash(road.ref),
      name: norm(road.name),
      sname: squash(road.name),
      aka: (road.aka ?? []).map(squash),
    }
    terms.set(road, t)
  }
  return t
}

/** A search for "44" should surface NH 44 before a district road numbered 44. */
const CATEGORY_BONUS: Record<string, number> = {
  expressway: 6,
  nh: 5,
  sh: 2,
  district: 0,
  local: 1,
}

function compute(q: string): Result[] {
  const sq = squash(q)
  const out: Result[] = []
  const cityHits = new Map<string, RoadSummary[]>()
  const stateHits = new Map<string, RoadSummary[]>()

  for (const road of state.roads) {
    let score = 0
    const t = termsFor(road)
    if (t.ref === sq) score = 100
    else if (t.ref.startsWith(sq)) score = 80
    else if (t.name.startsWith(q)) score = 72
    else if (t.sname.includes(sq)) score = 55
    else if (t.aka.some((a) => a.includes(sq))) score = 50
    if (score > 0) {
      // prefer bigger, more important roads on ties
      out.push({
        kind: 'road',
        road,
        score: score + (CATEGORY_BONUS[road.category] ?? 0) + Math.min(9, road.lengthKm / 500),
      })
    }
    for (const city of road.cities) {
      const nc = norm(city)
      if (nc.startsWith(q) || (q.length > 3 && nc.includes(q))) {
        if (!cityHits.has(city)) cityHits.set(city, [])
        cityHits.get(city)!.push(road)
      }
    }
    for (const st of road.states) {
      const ns = norm(st)
      if (q.length > 2 && ns.startsWith(q)) {
        if (!stateHits.has(st)) stateHits.set(st, [])
        stateHits.get(st)!.push(road)
      }
    }
  }

  for (const [city, roads] of cityHits) {
    const exact = norm(city) === q
    out.push({ kind: 'city', city, roads, score: (exact ? 76 : 40) + Math.min(14, roads.length) })
  }
  for (const [st, roads] of stateHits) {
    const exact = norm(st) === q
    out.push({ kind: 'state', state: st, roads, score: (exact ? 74 : 38) + Math.min(14, roads.length) })
  }

  out.sort((a, b) => b.score - a.score)
  return out
}

function render(): void {
  const list = document.getElementById('search-list')!
  const input = document.getElementById('search-input')!
  active = -1
  input.removeAttribute('aria-activedescendant')
  if (results.length === 0) {
    list.innerHTML = `<li class="sr-empty" role="option" aria-disabled="true">No roads or cities match — try “NH 44” or “Mumbai”</li>`
  } else {
    list.innerHTML = results
      .map((r, i) => {
        if (r.kind === 'road') {
          const rd = r.road
          return `<li role="option" id="sr-${i}" data-i="${i}">
            <span class="sr-badge cat-${esc(rd.category)}">${esc(shortRef(rd.ref))}</span>
            <span class="sr-main">
              <span class="sr-title">${esc(rd.name)}</span>
              <span class="sr-sub">${formatKm(rd.lengthKm)}${scopeOf(rd)} · ${esc(rd.start.split(',')[0])} → ${esc(rd.end.split(',')[0])}</span>
            </span></li>`
        }
        const label = r.kind === 'city' ? r.city : r.state
        return `<li role="option" id="sr-${i}" data-i="${i}">
          <span class="sr-badge city">${r.kind === 'city' ? 'City' : 'State'}</span>
          <span class="sr-main">
            <span class="sr-title">${esc(label)}</span>
            <span class="sr-sub">${r.roads.length} catalogued road${r.roads.length > 1 ? 's' : ''} pass${r.roads.length > 1 ? '' : 'es'} through</span>
          </span></li>`
      })
      .join('')
  }
  list.hidden = false
  input.setAttribute('aria-expanded', 'true')
  list.querySelectorAll('li[data-i]').forEach((li) => {
    li.addEventListener('mousedown', (e) => e.preventDefault())
    li.addEventListener('click', () => {
      const i = Number((li as HTMLElement).dataset.i)
      if (results[i]) pick(results[i])
    })
  })
}

function shortRef(ref: string): string {
  return ref.length <= 7 ? ref : ref.split(/[\s–—]/)[0].slice(0, 7)
}

/**
 * Every state numbers its own highways, so "SH 27" and "MDR 37" each match
 * several roads. The state is what tells them apart — show it whenever a road
 * belongs to exactly one.
 */
function scopeOf(rd: RoadSummary): string {
  return rd.states.length === 1 ? ` · ${esc(rd.states[0])}` : ''
}

function setActive(i: number): void {
  active = i
  const list = document.getElementById('search-list')!
  const input = document.getElementById('search-input')!
  list.querySelectorAll('li').forEach((li, j) => {
    li.setAttribute('aria-selected', String(j === i))
  })
  const el = document.getElementById(`sr-${i}`)
  if (el) {
    input.setAttribute('aria-activedescendant', `sr-${i}`)
    el.scrollIntoView({ block: 'nearest' })
  }
}

function pick(r: Result): void {
  const input = document.getElementById('search-input') as HTMLInputElement
  hide()
  input.value = ''
  if (r.kind === 'road') onPickRoad(r.road.id)
  else if (r.kind === 'city') onPickCity(r.city)
  else onPickState(r.state)
  input.blur()
}

function hide(): void {
  const list = document.getElementById('search-list')!
  const input = document.getElementById('search-input')!
  list.hidden = true
  input.setAttribute('aria-expanded', 'false')
  input.removeAttribute('aria-activedescendant')
}
