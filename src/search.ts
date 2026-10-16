import { state } from './state'
import type { RoadSummary } from './types'
import { esc } from './ui'
import { formatEnds, formatKm } from './geo'

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

/** "National Highway 44" is NH 44, whether someone types it or an aka spells it out. */
const abbreviate = (s: string) =>
  s
    .replace(/\bnational highways?\b/g, 'nh')
    .replace(/\bnational expressways?\b/g, 'ne')
    .replace(/\bstate highways?\b/g, 'sh')

/** The squashed designation ("nh44") a whole normalised query names, or null. */
function designation(q: string): string | null {
  const m = abbreviate(q).match(/^(nh|ne|sh) ?(\d+[a-z]*)$/)
  return m ? m[1] + m[2] : null
}

/**
 * Every designation an aka mentions, matched whole so that old NH 4 is not old
 * NH 45. A list shares its prefix: "the former NH 8B, 8A and 15" names nh8b,
 * nh8a and nh15.
 */
function designationsIn(aka: string): string[] {
  const out: string[] = []
  let cls = ''
  for (const w of abbreviate(norm(aka)).split(/[^a-z0-9]+/)) {
    const joined = w.match(/^(nh|ne|sh)\d+[a-z]*$/)
    if (joined) {
      out.push(w)
      cls = joined[1]
    } else if (/^(nh|ne|sh)$/.test(w)) cls = w
    else if (cls && /^\d+[a-z]*$/.test(w)) out.push(cls + w)
    else if (w !== 'and') cls = ''
  }
  return out
}

/** "old NH 7" asks for the pre-2010 numbering, which lives only in aka. */
const OLD_NUMBERING = /^(?:the )?(?:old|former) /

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

  usePlaceholderThatFits(input)
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

/**
 * A phone header spends most of its width on the brand and the two buttons,
 * leaving the field ~105px of text at 360px against the 256px the full hint
 * needs. Swap in the short one rather than render "Search a r". The query must
 * track the .search rules in styles.css.
 */
function usePlaceholderThatFits(input: HTMLInputElement): void {
  const wide = input.placeholder
  const narrow = input.dataset.placeholderNarrow ?? wide
  const phone = window.matchMedia('(max-width: 768px)')
  const apply = () => {
    input.placeholder = phone.matches ? narrow : wide
  }
  apply()
  phone.addEventListener('change', apply)
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
  /** designations the road carried before the 2010 renumbering ("nh7"), from akas that say old or former */
  oldRefs: string[]
  /** the number of a numbered ref — "44" for NH 44, "444a" for NH 444A — or '' */
  num: string
  /** ref is just a road class ("MDR", "SH") with no number to identify it */
  classOnly: boolean
}
const CLASS_ONLY_REF = /^(nh|sh|ne|mdr|odr|scr|expressway|road)$/
const terms = new WeakMap<RoadSummary, Terms>()
function termsFor(road: RoadSummary): Terms {
  let t = terms.get(road)
  if (!t) {
    const ref = squash(road.ref)
    t = {
      ref,
      name: norm(road.name),
      sname: squash(road.name),
      aka: (road.aka ?? []).map(squash),
      oldRefs: (road.aka ?? []).filter((a) => /\b(old|former)\b/i.test(a)).flatMap(designationsIn),
      num: ref.match(/^[a-z]+(\d[0-9a-z]*)$/)?.[1] ?? '',
      classOnly: CLASS_ONLY_REF.test(ref),
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
  const sq = designation(q) ?? squash(q)
  // "old NH 7" finds only the roads whose aka marks that old number: ref and name
  // matching would put today's NH 7 (Fazilka–Mana) first, and an aka substring
  // would take old NH 45 for old NH 4.
  const oldRef = OLD_NUMBERING.test(q) ? designation(q.replace(OLD_NUMBERING, '')) : null
  // A bare "44" is a road number: matched against each ref's number it scores
  // just under an exact ref, so CATEGORY_BONUS puts NH 44 before SH 44.
  const numeric = /^\d+[a-z]{0,2}$/.test(sq)
  // Merged roads live on as aliases: ne-1 to ne-8 point at the named expressways
  // that carry those numbers now, and the alias is the only place the number
  // survives as a whole value. Without it "NE 1" opens NE 10 on a ref prefix.
  const merged = new Map(Object.entries(state.aliases).map(([from, to]) => [squash(from), to]))
  const out: Result[] = []
  const cityHits = new Map<string, RoadSummary[]>()
  const stateHits = new Map<string, RoadSummary[]>()

  for (const road of state.roads) {
    let score = 0
    const t = termsFor(road)
    if (oldRef) score = t.oldRefs.includes(oldRef) ? 90 : 0
    // A named road with no number carries the bare class as its badge ("MDR").
    // Treating that as an exact ref match would let 2,000 unnumbered stubs
    // outrank NH 44 for the query "nh" — the commonest search on the site.
    else if (t.ref === sq) score = t.classOnly ? 30 : 100
    else if (merged.get(sq) === road.id) score = 100
    else if (t.ref.startsWith(sq)) score = t.classOnly ? 25 : 80
    else if (numeric && t.num === sq) score = 90
    else if (numeric && t.num.startsWith(sq)) score = 60
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
              <span class="sr-sub">${formatKm(rd.lengthKm)}${scopeOf(rd)} · ${esc(formatEnds(rd.start, rd.end))}</span>
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

/**
 * The ref as a list badge, shared with browse. A name ("Outer Ring Road") is
 * cut to its first word, but a numbered ref stays whole: cut to "NH",
 * NH 365BB and NH 365BG look the same, and both look like an unnumbered stub.
 */
export function shortRef(ref: string): string {
  if (ref.length <= 7 || (/\d/.test(ref) && ref.length <= 14)) return ref
  return ref.split(/[\s–—]/)[0].slice(0, 7)
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
