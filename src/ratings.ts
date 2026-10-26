/**
 * The community verdict on a road, as one "Reviews" section: the headline
 * stars, the road laid flat as a coloured bar, one card to rate it from, and
 * what travellers wrote under that. One summary read serves all of it —
 * reviews ride inside it — so the list costs no extra request.
 *
 * A long road is rated by the stretch, not as one number: "Delhi → Agra" and
 * the Jammu mountain leg of NH 44 are different drives. The bar under the
 * headline is the road laid flat and coloured stretch by stretch; tapping a
 * part of it, a row in the list under it, or the road itself on the map narrows
 * the rating card and the reviews to that part. Roads too short or too
 * unreliable to cut up (see stretches.ts) keep one set of stars for the whole road.
 *
 * A road is looked at, and rated, one way at a time: the card says "Rate Agra →
 * Gwalior", and the arrows beside it turn that round to "Gwalior → Agra" — two
 * carriageways on a divided road, a climb and a descent on a ghat. Everything
 * follows the way being looked at, never both added together: the colours on
 * the map, the bar (laid out from the end you start at), the stretch list, the
 * card's score. Arrows along the road on the map say which way that is.
 *
 * Every fact is said once, and there is one row of stars to tap: the card's.
 * The headline's stars only show the average. Writing a review opens inside
 * that card, under those same stars, so rating a road and reviewing it are one
 * thing. The reviews under it are deliberately quiet: the three most-liked,
 * each clamped to a few lines, one button for the rest. On a phone the whole
 * thing is a bottom sheet, so every control is a thumb-sized target and the
 * inputs are 16px so iOS doesn't zoom.
 */
import type { FeatureCollection, LineString } from 'geojson'
import { prefersReducedMotion } from './animate'
import { flyToRoad, setStretchSelection, showStretches } from './map'
import { state } from './state'
import { getStore } from './storage'
import {
  ALL,
  buildStretches,
  displayKm,
  expandRange,
  intersects,
  nearestStretch,
  otherWay,
  rangeKey,
  rangeLabel,
  rangeWay,
  scoreRange,
  scoreStretches,
  stretchesFC,
  stretchName,
  wayLabel,
  type Stretch,
  type StretchScore,
  type Way,
} from './stretches'
import type { BBox, LngLat, RatingSummary, ReviewItem, ShapeFeature, StretchProps, UserStore } from './types'
import { esc, relTime, toast } from './ui'

const STAR =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.95 5.98 6.6.96-4.78 4.66 1.13 6.58L12 17.57l-5.9 3.11 1.13-6.58L2.45 9.44l6.6-.96Z" fill="currentColor"/></svg>'
const THUMB =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 7h3v7H2zM5 7l3-5.5c1.2 0 2 .9 1.8 2.1L9.3 7H13a1.5 1.5 0 0 1 1.45 1.9l-1.2 4.2A1.5 1.5 0 0 1 11.8 14H5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>'
const PEN =
  '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2 12h10M3 9.5 10 2.5l1.5 1.5-7 7H3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>'
const FLIP =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.5h10.5M10.5 2.5l3 3-3 3M13.5 10.5H3M5.5 7.5l-3 3 3 3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** How many reviews show before "Show more" — enough to get the gist, not a wall. */
const SHOWN = 3
/** The longest review the API takes (api/_lib/ratings-math.ts — scripts/contracts.test.mjs keeps them equal). */
const REVIEW_MAX = 500
/** The server caps how many entries one person keeps on one road. */
const TOO_MANY = "You've reviewed a lot of this road already — edit one of your reviews instead."
/** …and how many ranges one road keeps at all. That cap is nobody's doing, and
 *  `all` never fills it, so the whole road is still there to rate. */
const ROAD_FULL = "This stretch can't take new ratings right now — you can still rate the whole road."
/** A delete the server refused while it may still hold the entry under another
 *  key: the key hashes the network, so it only matches from the one that wrote
 *  it. "May": stars carry no name, and a delete that went through but whose
 *  answer was lost reads the same, which is why it comes with a way to let go. */
const NOT_YOURS =
  "Couldn't remove it — it may have been saved over a different connection. Try again on the Wi-Fi or mobile data you posted it from, or forget it on this device."

const errCode = (e: unknown): string => (e as Error)?.message ?? String(e)

/** Says which range failed, for when the screen has moved on to another since. */
const failedOf = (what: string, of?: string): string => (of ? `Your ${what.toLowerCase()} of ${of} didn't save. ` : '')

/** One voice for every failed write, whatever was being saved. */
function failMessage(code: string, what: string, of?: string): string {
  const lead = failedOf(what, of)
  if (code === 'rate-limited') return `${lead}You've done a lot just now — try again a little later.`
  if (code === 'captcha') return `${lead}Couldn't verify this browser — reload the page and try again.`
  if (code === 'unavailable' || code === 'no-api') return `${lead}${what} is unavailable right now — please try again later.`
  return `Couldn't save your ${what.toLowerCase()}${of ? ` of ${of}` : ''} — try again.`
}

function writeFail(code: string, what: string, of?: string): string {
  if (code === 'too-many') return failedOf(what, of) + TOO_MANY
  if (code === 'road-full') return failedOf(what, of) + ROAD_FULL
  return failMessage(code, what, of)
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const kmText = (km: number): string => `${Math.round(km).toLocaleString('en-IN')} km`
const smooth = (): ScrollBehavior =>
  prefersReducedMotion() || document.visibilityState === 'hidden' ? 'auto' : 'smooth'

// ── the road on screen ───────────────────────────────────────────────

/** First and last stretch of a run, in road order. */
type Span = [number, number]

export interface CommunityCtx {
  roadId: string
  roadRef: string
  /** The road's published length — what the chip says, so the parts add up to it. */
  lengthKm: number
  shape?: ShapeFeature
  /** Where the road was tapped or found, if it was: the stretch a new review starts on. */
  at?: LngLat
}

interface Composer {
  /** Editing, or adding words to, an entry you already have. Its range is the
   *  thing being edited, so it can't move — another range would be another entry. */
  locked: string | null
  span: Span | null
  stars: number | null
  text: string
  /** The words being edited, to tell "left alone" from "cleared". null for a new entry. */
  original: string | null
  /** What it opened with. Stars, words or a range changed since are a draft,
   *  and a stray Escape or tap on the map must not throw a draft away. */
  start: { stars: number | null; text: string; span: Span | null; way: Way }
  /** A new review picked onto a range you already hold, and what it brought
   *  in from that entry (null where it brought nothing), so it can take them
   *  away again when the range moves on — see fillHeld. */
  fill: { key: string; text: string | null; stars: number | null } | null
  busy: boolean
}

interface Road {
  token: number
  store: UserStore
  roadId: string
  roadRef: string
  lengthKm: number
  /** Empty on a road that keeps whole-road stars. */
  s: Stretch[]
  marks: [string, number][] | undefined
  at: LngLat | undefined
  ratingEl: HTMLElement
  reviewsEl: HTMLElement
  summary: RatingSummary | null
  /** The summary is on screen — read, or returned by a write. */
  loaded: boolean
  /** Why the first read failed, while nothing has replaced it. */
  failed: string | null
  /** Set once any write here returns a summary, which is newer than the initial read. */
  wrote: boolean
  scores: (StretchScore | null)[]
  fc: FeatureCollection<LineString, StretchProps>
  /** What the reviews are narrowed to. The composer never changes it, so
   *  closing the composer hands the bar and the map straight back to it. */
  sel: Span | null
  /** Which way the road is being looked at and rated — the composer's From
   *  and To included, so what it posts and the colours around it agree. It
   *  stays as it is from one stretch to the next: whoever drove Gwalior → Agra
   *  drove the stretches either side of it that way too. */
  way: Way
  /** The way `scores` and `fc` were worked out for. */
  scoredWay: Way
  composer: Composer | null
  expanded: boolean
  /** Reviews opened with "Read more". The list is rebuilt on every change —
   *  a star tap above it, a write — and must not fold one back up while it is
   *  being read. A new pick starts folded again. */
  opened: Set<string>
  /** range → stars tapped but not yet accepted by the server. */
  pending: Map<string, number>
  /** range → the newest tap's number, so only its failure may undo the paint. */
  taps: Map<string, number>
}

/** Bumped for every road. A result that comes back for an older one is
 *  dropped, so a slow read for road A can never paint road B. */
let token = 0
let cur: Road | null = null
/** One per road, so a road's listeners can never fire for the next one. */
let wiring: AbortController | null = null

const live = (r: Road): boolean => r.token === token
/** Only the road the map is showing gets to draw stretches on it. */
const onMap = (r: Road): boolean => live(r) && r.s.length > 0 && state.selectedId === r.roadId
/** The road is still the one in the open panel, not one it showed earlier. */
const inPanel = (r: Road): boolean =>
  live(r) && state.selectedId === r.roadId && r.ratingEl.isConnected && !r.ratingEl.closest('[hidden]')

const indices = (sp: Span): number[] => Array.from({ length: sp[1] - sp[0] + 1 }, (_, k) => sp[0] + k)
const within = (sp: Span | null, i: number): boolean => sp !== null && i >= sp[0] && i <= sp[1]

function spanBox(s: readonly Stretch[], sp: Span): BBox {
  const box: BBox = [...s[sp[0]].bbox]
  for (let i = sp[0] + 1; i <= sp[1]; i++) {
    const b = s[i].bbox
    box[0] = Math.min(box[0], b[0])
    box[1] = Math.min(box[1], b[1])
    box[2] = Math.max(box[2], b[2])
    box[3] = Math.max(box[3], b[3])
  }
  return box
}

const spanName = (r: Road, sp: Span): string =>
  viewWay(r) === 'fwd' ? `${r.s[sp[0]].fromName} → ${r.s[sp[1]].toName}` : `${r.s[sp[1]].toName} → ${r.s[sp[0]].fromName}`

/** What a range is called in a sentence: "Delhi → Agra", or the road itself —
 *  which a key over every stretch is too, whatever its two ends are called,
 *  unless it is driven one way between two different places. */
function nameOf(r: Road, key: string): string {
  if (key === ALL) return r.s.length ? 'the whole road' : 'this road'
  const label = rangeLabel(r.s, key, r.marks)
  // the labels that are not place names, as they read mid-sentence
  if (label === 'Part of the road') return 'part of the road'
  return label.startsWith('Whole road') ? `the w${label.slice(1)}` : label
}

/** The stretches lit up on the bar, the list and the map: the composer's pick
 *  while composing, otherwise what the reviews are narrowed to. */
function activeSpan(r: Road): Span | null {
  const c = r.composer
  if (!c) return r.sel
  return c.locked ? expandRange(r.s, c.locked, r.marks) : c.span
}

/** Which way that span is being rated: an entry being edited, the way it was
 *  driven. null only for an edit of the whole road's `all`. */
function activeWay(r: Road): Way | null {
  const c = r.composer
  return c?.locked ? rangeWay(r.s, c.locked, r.marks) : r.way
}

/** The way the colours, the bar and the list show the road: the way being
 *  rated, or while `all` is being edited, the way it was looked at. */
const viewWay = (r: Road): Way => activeWay(r) ?? r.way

/**
 * The key stretches sp are rated under, driven `way`. A rating you gave before
 * directions sits under the old spelling, `agra--delhi`, and was driven in road
 * order — so for the road-order way it is that entry, and re-rating it or adding
 * words changes it, rather than casting you a second vote on the same side.
 * Everybody else writes the new key.
 */
function ownKey(r: Road, sp: Span, way: Way): string {
  const key = rangeKey(r.s, sp[0], sp[1], way)
  if (way !== 'fwd') return key
  // every stretch in the old spelling is `all`, the headline's own vote
  const old = rangeKey(r.s, sp[0], sp[1])
  return old !== ALL && r.store.getMyEntries(r.roadId)[old] ? old : key
}

/** The range the composer would post to — null until one is picked. */
function composerKey(r: Road): string | null {
  const c = r.composer
  if (!c) return null
  if (c.locked) return c.locked
  if (!r.s.length) return ALL
  return c.span ? ownKey(r, c.span, r.way) : null
}

/** The range the card's stars rate. null: a stretched road with nothing
 *  picked, where the stars open the composer instead of saving. */
function rowKey(r: Road): string | null {
  if (r.composer) return composerKey(r)
  if (!r.s.length) return ALL
  return r.sel ? ownKey(r, r.sel, r.way) : null
}

/** What the card's arrows turn to, said the way the label would say it: the
 *  picked stretches driven back, or the road looked at from its other end.
 *  null where there is no other way to turn to: a road with no stretches, or
 *  an entry being edited, whose range is the entry. */
function flipName(r: Road): string | null {
  const c = r.composer
  if (!r.s.length || c?.locked) return null
  const sp = c ? c.span : r.sel
  const other = otherWay(r.way)
  return sp ? nameOf(r, rangeKey(r.s, sp[0], sp[1], other)) : wayLabel(r.s, other)
}

function rowStars(r: Road): number | null {
  if (r.composer) return r.composer.stars
  const key = rowKey(r)
  if (key === null) return null
  return r.pending.get(key) ?? r.store.getMyEntries(r.roadId)[key]?.stars ?? null
}

/** Your words for a range, while the server still has them. */
function liveReview(r: Road, key: string): ReviewItem | undefined {
  const id = r.store.getMyEntries(r.roadId)[key]?.reviewId
  return id ? r.summary?.reviews?.find((v) => v.id === id) : undefined
}

/** The stretch you are on, if the road was opened from a tap or a location. */
function near(r: Road): Span | null {
  const i = r.at && r.s.length ? nearestStretch(r.s, r.at) : null
  return i === null ? null : [i, i]
}

/** Stars, words or where you drove changed since the composer opened. Picking
 *  From and To is work too, and a tap that misses the road must not undo it. */
const touched = (r: Road, c: Composer): boolean =>
  c.stars !== c.start.stars ||
  c.text !== c.start.text ||
  String(c.span) !== String(c.start.span) ||
  (c.span !== null && r.way !== c.start.way)

// ── painting ─────────────────────────────────────────────────────────

const painted = new WeakMap<Element, string>()

/** Rewrites only what changed, so a live region isn't read out again for
 *  nothing and a row under the keyboard isn't rebuilt beneath it. */
function setHtml(el: Element | null, html: string): void {
  if (!el || painted.get(el) === html) return
  painted.set(el, html)
  el.innerHTML = html
}

/**
 * Re-render a box without dropping keyboard focus on the floor: the same
 * control comes back focused if it still exists, else `fallback()`.
 */
function rerender(box: HTMLElement, html: string, fallback: () => HTMLElement | null): void {
  const a = document.activeElement
  const had = a instanceof HTMLElement && box.contains(a) ? a : null
  const act = had?.dataset.act
  const item = had?.closest<HTMLElement>('.rv-item')
  box.innerHTML = html
  if (!had) return
  let scope: HTMLElement | null = box
  if (item?.dataset.id) scope = box.querySelector<HTMLElement>(`.rv-item[data-id="${CSS.escape(item.dataset.id)}"]`)
  else if (item?.dataset.range) scope = box.querySelector<HTMLElement>(`.rv-item[data-range="${CSS.escape(item.dataset.range)}"]`)
  const next = act ? scope?.querySelector<HTMLElement>(`[data-act="${CSS.escape(act)}"]`) : item ? scope : null
  focusOn(next ?? fallback())
}

/** Focus for the keyboard's sake, on a heading or a list item as well as a
 *  control. The tabindex goes on only when needed, so a tap on a review's
 *  text never focuses (and outlines) the whole item. */
function focusOn(el: HTMLElement | null | undefined): void {
  if (!el) return
  if (el.tabIndex < 0 && !el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1')
  el.focus({ preventScroll: true })
}

function starButtons(): string {
  return [1, 2, 3, 4, 5]
    .map(
      (n) =>
        `<button type="button" data-act="star" data-n="${n}" aria-pressed="false" aria-label="${n} star${n > 1 ? 's' : ''}">${STAR}</button>`,
    )
    .join('')
}

function paintStars(box: Element | null, val: number | null): void {
  box?.querySelectorAll<HTMLButtonElement>('[data-n]').forEach((b) => {
    const n = Number(b.dataset.n)
    b.classList.toggle('is-on', val !== null && n <= val)
    b.setAttribute('aria-pressed', String(val === n))
  })
}

/** 0 = not rated yet, else the rounded mean — the bar and the map agree. */
const scoreClass = (sc: StretchScore | null): number => (sc ? Math.min(5, Math.max(1, Math.round(sc.mean))) : 0)

function ratingHtml(r: Road): string {
  const n = r.s.length
  // The bar is the quick way in for a finger or a mouse, and says nothing a
  // screen reader can use — the list under it is the same choice as buttons.
  const stretches = n
    ? `<div class="sb" aria-hidden="true">${r.s
        .map(
          (st, i) =>
            `<span class="sb-seg s0" data-i="${i}" style="flex-grow:${Math.max(0.001, st.kmTo - st.kmFrom).toFixed(3)}"></span>`,
        )
        .join('')}</div>
      <div class="sb-ends" aria-hidden="true"><span>${esc(r.s[0].fromName)}</span><span>${esc(r.s[n - 1].toName)}</span></div>
      <p class="sb-legend" aria-hidden="true"><span><i class="s5"></i>Good</span><span><i class="s3"></i>Okay</span><span><i class="s1"></i>Bad</span><span><i class="s0"></i>Not rated yet</span></p>
      <details class="sb-list">
        <summary>All ${n} stretches</summary>
        <div class="sb-rows">${r.s
          .map((_, i) => `<button type="button" class="sb-row" data-i="${i}" aria-pressed="false"></button>`)
          .join('')}</div>
      </details>`
    : ''
  // The card holds the only stars that take a tap. Its label says what they
  // rate; a review being written opens in .rate-act, right under them, so a
  // review never needs a second row of stars. How the picked stretch rates so
  // far shares the row with the write button: beside five thumb-sized stars a
  // phone has no room for it, and it would only wrap onto a row of its own.
  // Letting go of a pick is the reviews' "Show all", next to what it changes.
  // The arrows beside the label turn what it names round, "Agra → Gwalior" to
  // "Gwalior → Agra", right where the direction is written — and with it the
  // whole road: the bar, the list and the map show that way's ratings.
  const flip = n ? `<button type="button" class="rate-flip" data-act="flip" hidden>${FLIP}</button>` : ''
  return `
    <h3>Reviews</h3>
    <div class="rating-head"></div>
    ${stretches}
    <div class="rate">
      <div class="rate-top"><p class="rating-label" id="rating-label"></p>${flip}</div>
      <div class="rate-row">
        <div class="stars" role="group" aria-labelledby="rating-label">${starButtons()}</div>
      </div>
      <div class="rate-foot">
        <div class="rate-act"></div>
        ${n ? `<p class="rate-meta" aria-live="polite"></p>` : ''}
      </div>
    </div>`
}

function headHtml(r: Road): string {
  if (!r.loaded) {
    // never claim "be the first" for a road we merely failed to read
    if (r.failed === 'no-api') return `<p class="rh-empty">Ratings need the site API — not available on this deployment.</p>`
    if (r.failed) return `<p class="rh-empty">Community ratings can't be loaded right now.</p>`
    return `<div class="skel" style="height:34px;width:62%"></div>`
  }
  const sum = r.summary
  if (!sum || !(sum.votes > 0)) {
    // your own stars live in this browser, so they can show before the edge cache catches up
    const rated = Object.values(r.store.getMyEntries(r.roadId)).some((e) => e.stars !== null)
    return `<p class="rh-empty">${rated ? 'Thanks for rating!' : 'Be the first to rate this road'}</p>`
  }
  const pct = Math.max(0, Math.min(100, (sum.mean / 5) * 100)).toFixed(1)
  const rated = r.s.length ? ` · ${r.scores.filter(Boolean).length} of ${r.s.length} stretches rated` : ''
  return `<b class="rh-mean">${sum.mean.toFixed(1)}</b><span class="visually-hidden"> out of 5</span>
    <span class="rh-stars" aria-hidden="true">★★★★★<span style="width:${pct}%">★★★★★</span></span>
    <span class="rh-meta">from ${plural(sum.votes, 'rating')}${rated}</span>`
}

function rowHtml(r: Road, i: number): string {
  const st = r.s[i]
  const sc = r.scores[i]
  const score = sc
    ? `<span aria-hidden="true">★ ${sc.mean.toFixed(1)} (${sc.votes})</span><span class="visually-hidden">${sc.mean.toFixed(1)} stars from ${plural(sc.votes, 'rating')}</span>`
    : 'not rated yet'
  return `<i class="sb-dot s${scoreClass(sc)}" aria-hidden="true"></i>
    <span class="sb-name">${esc(stretchName(st, r.scoredWay))}</span>
    <span class="sb-meta">${kmText(displayKm(r.s, i, i, r.lengthKm))} · ${score}</span>`
}

/**
 * The bar and the list read from the end you start at: looking at the road
 * driven back, the bar is laid out the other way round, its ends swap, and the
 * list runs from the other end. The rows are moved rather than restyled, so a
 * keyboard meets them in the order they are shown.
 */
function orderStretches(r: Road): void {
  const el = r.ratingEl
  const rev = r.scoredWay === 'rev'
  el.querySelector('.sb')?.classList.toggle('is-rev', rev)
  const ends = el.querySelectorAll('.sb-ends span')
  const n = r.s.length
  if (ends.length === 2) {
    ends[0].textContent = rev ? r.s[n - 1].toName : r.s[0].fromName
    ends[1].textContent = rev ? r.s[0].fromName : r.s[n - 1].toName
  }
  const box = el.querySelector('.sb-rows')
  const first = rev ? String(n - 1) : '0'
  if (!box || (box.firstElementChild as HTMLElement | null)?.dataset.i === first) return
  const rows = Array.from(box.children).reverse()
  for (const row of rows) box.appendChild(row)
}

function paintStretches(r: Road): void {
  const el = r.ratingEl
  const sp = activeSpan(r)
  orderStretches(r)
  el.querySelector('.sb')?.classList.toggle('has-sel', sp !== null)
  el.querySelectorAll<HTMLElement>('.sb-seg').forEach((seg) => {
    const i = Number(seg.dataset.i)
    seg.className = `sb-seg s${scoreClass(r.scores[i] ?? null)}${within(sp, i) ? ' is-sel' : ''}`
    seg.title = r.fc.features[i]?.properties.tip ?? ''
  })
  el.querySelectorAll<HTMLButtonElement>('.sb-row').forEach((row) => {
    const i = Number(row.dataset.i)
    row.setAttribute('aria-pressed', String(within(sp, i)))
    setHtml(row, rowHtml(r, i))
  })
}

/** What the card's label calls the thing its stars rate. */
function labelText(r: Road, key: string | null): string {
  const locked = r.composer?.locked
  if (locked) return `Your review of ${nameOf(r, locked)}`
  // with nothing picked, which way the road is being looked at
  return key === null ? `Rate a stretch ${wayLabel(r.s, r.way)}` : `Rate ${nameOf(r, key)}`
}

/** How a picked stretch rates so far, next to the stars that rate it — the
 *  label above already names it. */
function metaHtml(r: Road, sp: Span): string {
  // each fact is a span the line may break between, never inside
  const km = `<span>${kmText(displayKm(r.s, sp[0], sp[1], r.lengthKm))}</span>`
  // until the read lands, "not rated yet" would only be a guess
  if (!r.loaded) return km
  // the way the label names: what the other way's drivers said is theirs
  const sc = scoreRange(r.s, r.summary?.ranges, sp[0], sp[1], r.marks, viewWay(r))
  if (!sc) return `not rated yet · ${km}`
  const mean = sc.mean.toFixed(1)
  return `<span aria-hidden="true">★ ${mean} · ${plural(sc.votes, 'rating')}</span><span class="visually-hidden">${mean} stars from ${plural(sc.votes, 'rating')}</span> · ${km}`
}

/** Under the stars: the way to write — or, once those stars are yours, the
 *  ways to change them. The card already shows your stars, so the list under
 *  it doesn't say them again. */
function writeHtml(r: Road, key: string | null): string {
  const write = (act: string, label: string) =>
    `<button type="button" class="rate-write" data-act="${act}">${PEN}<span>${label}</span></button>`
  if (key === null) return write('write', 'Write a review')
  if (liveReview(r, key)) return write('edit-here', 'Edit your review')
  if (r.store.getMyEntries(r.roadId)[key]?.stars == null) return write('write', 'Write a review')
  return `${write('edit-here', 'Add a few words')}<button type="button" class="rate-write rate-del" data-act="delete-here">Delete</button>`
}

/** The card: its label, its stars, and under them the way to write. */
function paintRate(r: Road): void {
  const el = r.ratingEl
  const c = r.composer
  const key = rowKey(r)
  setHtml(el.querySelector('.rating-label'), esc(labelText(r, key)))
  const flip = el.querySelector<HTMLButtonElement>('.rate-flip')
  if (flip) {
    const other = flipName(r)
    flip.hidden = other === null
    el.querySelector('.rate')?.classList.toggle('can-flip', other !== null)
    if (other !== null) {
      const label = `Switch to the other way: ${other}`
      flip.setAttribute('aria-label', label)
      flip.title = label
    }
  }
  paintStars(el.querySelector('.rate-row'), rowStars(r))
  // While composing, the composer's own line says what is picked, and one
  // announcement is enough.
  const sel = c ? null : r.sel
  setHtml(el.querySelector('.rate-meta'), sel ? metaHtml(r, sel) : '')
  if (c) return paintComposer(r, c)
  // "Write" can turn into "Edit" under the keyboard when the summary lands
  const act = el.querySelector<HTMLElement>('.rate-act')
  const had = act?.contains(document.activeElement) ?? false
  setHtml(act, writeHtml(r, key))
  if (had && !act?.contains(document.activeElement)) focusOn(act?.querySelector<HTMLElement>('button'))
}

function paintRating(r: Road): void {
  // The way can turn under any repaint — the arrows, From after To, opening
  // an entry driven the other way — and the colours on the map go with it.
  if (r.scoredWay !== viewWay(r)) {
    rescore(r)
    showOnMap(r)
  }
  setHtml(r.ratingEl.querySelector('.rating-head'), headHtml(r))
  if (r.s.length) paintStretches(r)
  paintRate(r)
}

// ── reviews list ─────────────────────────────────────────────────────

const OWN = `<span class="rv-own"><button type="button" class="rv-btn" data-act="edit">Edit</button><button type="button" class="rv-btn" data-act="delete">Delete</button></span>`

function starsHtml(n: number | null): string {
  return n
    ? `<span class="rv-stars" role="img" aria-label="${n} star${n > 1 ? 's' : ''}">${'★'.repeat(n)}<span>${'★'.repeat(5 - n)}</span></span>`
    : ''
}

/** What the reviews are narrowed to: the stretches the card's label names.
 *  While a review is being written that is the range it is about — r.sel
 *  stays as it was, so Cancel hands the old filter straight back. A run over
 *  every stretch is the whole road, which narrows nothing. */
function listSpan(r: Road): Span | null {
  const sp = r.composer ? activeSpan(r) : r.sel
  return sp && !(sp[0] === 0 && sp[1] === r.s.length - 1) ? sp : null
}

/** Which part of the road a review is about, and which way. A road with no
 *  stretches has no parts to tell apart, so its reviews carry no chip at all —
 *  and a review of just what the list is narrowed to, driven the way the card
 *  above names, needs none either. One from the other way says so. */
function rangeChip(r: Road, key: string, sp: Span | null): string {
  if (!r.s.length) return ''
  const ex = sp ? expandRange(r.s, key, r.marks) : null
  if (sp && ex && ex[0] === sp[0] && ex[1] === sp[1] && rangeWay(r.s, key, r.marks) === activeWay(r)) return ''
  return `<span class="rv-range">${esc(rangeLabel(r.s, key, r.marks))}</span>`
}

const likeHtml = (likes: number): string => `${THUMB}<span>Helpful</span>${likes ? `<b>${likes}</b>` : ''}`

function reviewHtml(r: Road, v: ReviewItem, mineKey: string | null, liked: boolean, sp: Span | null): string {
  const mine = mineKey !== null
  const key = mineKey ?? v.range ?? ALL
  const open = r.opened.has(v.id)
  const helped = v.likes ? `<span class="rating-note">${plural(v.likes, 'person', 'people')} found this helpful</span>` : ''
  return `<li class="rv-item${mine ? ' is-mine' : ''}${open ? ' is-open' : ''}" data-id="${esc(v.id)}"${mine ? ` data-range="${esc(key)}"` : ''}>
    <div class="rv-head">${starsHtml(v.stars)}${rangeChip(r, key, sp)}<span>${esc(relTime(Date.parse(v.at)))}${v.edited ? ' · edited' : ''}</span>${mine ? '<span class="rv-you">You</span>' : ''}</div>
    <p class="rv-text">${esc(v.text)}</p>
    <div class="rv-actions">
      ${
        mine
          ? `${OWN}${helped}`
          : `<button type="button" class="rv-btn rv-like" data-act="like" aria-pressed="${liked}" aria-label="Helpful${v.likes ? `, ${v.likes}` : ''}">${likeHtml(v.likes)}</button>`
      }
      ${open ? '' : '<button type="button" class="rv-btn rv-read" data-act="read" hidden>Read more</button>'}
    </div>
  </li>`
}

/** Stars with no words are yours too, and need the same ways to change them —
 *  but they are one line, not a card: there is nothing in them to read. */
function ratedHtml(r: Road, key: string, stars: number): string {
  return `<li class="rv-item rv-rated" data-range="${esc(key)}">
    <span>You rated <b>${esc(nameOf(r, key))}</b> ${starsHtml(stars)}</span>
    <span class="rv-own"><button type="button" class="rv-btn" data-act="words">Add a few words</button><button type="button" class="rv-btn" data-act="delete">Delete</button></span>
  </li>`
}

function listHtml(r: Road): string {
  // A failed read says so once, in the headline above.
  if (!r.loaded) return r.failed ? '' : `<div class="skel" style="height:44px"></div>`
  const entries = r.store.getMyEntries(r.roadId)
  const reviews = r.summary?.reviews ?? []
  const byId = new Map(reviews.map((v) => [v.id, v]))
  const sp = listSpan(r)
  const shows = (key: string) => !sp || intersects(r.s, key, sp[0], sp[1], r.marks)

  // Every review exactly once. Yours come first — they are the ones you would
  // look for — in road order. A review of yours is in the server's list too,
  // and a stale browser can hold one id under two ranges: `mine` keeps yours
  // from coming back as somebody else's, `seen` keeps any from showing twice.
  const order = (key: string) => (key === ALL ? -1 : (expandRange(r.s, key, r.marks)?.[0] ?? r.s.length))
  const mine = new Set<string>()
  for (const e of Object.values(entries)) if (e.reviewId) mine.add(e.reviewId)
  const seen = new Set<string>()
  // Your stars with no words go apart from the reviews: they are one short
  // line each, and must not take the slots meant for words someone can read.
  const rated: string[] = []
  const cards: string[] = []
  // The card above already shows the stars of the range it rates, and the
  // composer the words it has in its box: an edit's, or those it brought in
  // from a range you hold. Words it did not bring in stay listed, so what a
  // post would replace can still be read.
  const c = r.composer
  const inCard = (key: string) => key === rowKey(r)
  const inBox = (key: string) => c !== null && key === composerKey(r) && (c.locked !== null || c.fill?.text != null)
  for (const [key, e] of Object.entries(entries).sort((a, b) => order(a[0]) - order(b[0]))) {
    if (!shows(key)) continue
    const v = e.reviewId ? byId.get(e.reviewId) : undefined
    if (v) {
      if (seen.has(v.id)) continue
      seen.add(v.id)
      if (!inBox(key)) cards.push(reviewHtml(r, v, key, false, sp))
    } else if (e.stars !== null && !inCard(key)) {
      rated.push(ratedHtml(r, key, e.stars))
    }
  }
  const liked = r.store.getMyLikes(r.roadId)
  for (const v of reviews) {
    if (mine.has(v.id) || seen.has(v.id) || !shows(v.range ?? ALL)) continue
    seen.add(v.id)
    cards.push(reviewHtml(r, v, null, liked.has(v.id), sp))
  }

  // The card above already names what is picked. The count is of what is
  // listed here, so a review open in the composer above isn't counted twice.
  // While one is being written its From and To are what move this, and Cancel
  // lets go, so there is no "Show all" to tap.
  const what = sp && sp[0] !== sp[1] ? 'these stretches' : 'this stretch'
  const count = cards.length ? `${plural(cards.length, 'review')} of ${what}` : `No reviews of ${what} yet`
  const all = c ? '' : ` · <button type="button" data-act="show-all">Show all</button>`
  const filter = sp ? `<p class="rv-filter"><span>${count}</span>${all}</p>` : ''
  const items = [...rated, ...(r.expanded ? cards : cards.slice(0, SHOWN))]
  // On a road nobody has rated, the headline already asks for the first
  // rating. Once someone has, this says the words are still missing; the ask
  // is only for those who haven't given theirs.
  const yours = Object.values(entries).some((e) => e.stars !== null)
  const empty =
    sp || r.composer || !(r.summary && r.summary.votes > 0)
      ? ''
      : `<p class="rv-empty">No reviews yet.${yours ? '' : ' Driven it? Tap the stars above.'}</p>`
  const body = items.length ? `<ul class="rv-list">${items.join('')}</ul>` : empty
  const more =
    !r.expanded && cards.length > SHOWN
      ? `<button type="button" class="rv-more" data-act="more">Show ${cards.length - SHOWN} more</button>`
      : ''
  return `${filter}${body}${more}`
}

function renderList(r: Road): void {
  const box = r.reviewsEl
  rerender(box, listHtml(r), () => box.querySelector<HTMLElement>('.rv-item') ?? r.ratingEl.querySelector<HTMLElement>('h3'))
  // only offer "Read more" where the clamp actually hid something
  box.querySelectorAll<HTMLElement>('.rv-text').forEach((p) => {
    if (p.scrollHeight > p.clientHeight + 1) {
      p.parentElement?.querySelector('.rv-read')?.removeAttribute('hidden')
    }
  })
}

// ── the map ──────────────────────────────────────────────────────────

function showOnMap(r: Road): void {
  if (!onMap(r)) return
  showStretches(r.fc)
  syncMap(r, false)
}

function syncMap(r: Road, fly: boolean): void {
  if (!onMap(r)) return
  const sp = activeSpan(r)
  // Arrows say which way the colours are: along a picked run, the way it is
  // being rated; with nothing picked, along the whole road.
  setStretchSelection(sp ? indices(sp) : null, viewWay(r))
  if (fly && sp) flyToRoad(spanBox(r.s, sp))
}

/** Each stretch's score driven the way the road is being looked at, never the
 *  two ways added together, and the map's lines to match. */
function rescore(r: Road): void {
  r.scoredWay = viewWay(r)
  r.scores = scoreStretches(r.s, r.summary?.ranges, r.marks, r.scoredWay)
  r.fc = stretchesFC(r.s, r.scores, r.scoredWay)
}

/** Everything that follows from a new summary: the scores, both slots, the map. */
function refresh(r: Road): void {
  rescore(r)
  paintRating(r)
  renderList(r)
  showOnMap(r)
}

/** A write's summary is newer than anything the first read could still bring. */
function adopt(r: Road, summary: RatingSummary): void {
  r.summary = summary
  r.wrote = true
  r.loaded = true
  r.failed = null
}

// ── picking stretches ────────────────────────────────────────────────

/** Narrow everything to a run of stretches, or let go with null. */
function setSel(r: Road, sp: Span | null): void {
  r.sel = sp
  r.expanded = false
  r.opened.clear()
  paintRating(r)
  renderList(r)
  syncMap(r, sp !== null)
}

/** The card's arrows: the road looked at, and rated, the other way — its
 *  colours on the map and the bar, the list, the card's score and what its
 *  stars rate. In the composer it also swaps From and To. */
function flip(r: Road): void {
  const c = r.composer
  if (c && (c.busy || c.locked)) return
  r.way = otherWay(r.way)
  if (c) return rangeMoved(r, c, false)
  paintRating(r)
  // reviews from the way just left now carry a chip saying so
  renderList(r)
  syncMap(r, false)
}

/** The filter rule: a tap picks that one stretch, and a tap on the one picked
 *  lets go. Says whether it picked. */
function filterTap(r: Road, i: number): boolean {
  const same = r.sel !== null && r.sel[0] === i && r.sel[1] === i
  setSel(r, same ? null : [i, i])
  return !same
}

/** The composer rule: a review can cover a run of stretches, so a tap outside
 *  the run stretches it to there; inside a longer run it starts again from
 *  that stretch; on the only one picked it lets go. */
function composerTap(r: Road, i: number): void {
  const c = r.composer
  if (!c || c.busy) return
  if (c.locked) {
    // An entry is its range, so an edit can't move it — another range would
    // be another entry. The rows, the bar and the map look the same as ever,
    // so say why the tap did nothing.
    say(`You're editing your review of ${nameOf(r, c.locked)}. Cancel to review another stretch.`)
    return
  }
  const sp = c.span
  if (!sp) c.span = [i, i]
  else if (i < sp[0] || i > sp[1]) c.span = [Math.min(sp[0], i), Math.max(sp[1], i)]
  else if (sp[0] !== sp[1]) c.span = [i, i]
  else c.span = null
  rangeMoved(r, c, false)
}

/** The composer's range changed, and with it, maybe, the entry it writes to. */
function rangeMoved(r: Road, c: Composer, fly: boolean): void {
  fillHeld(r, c)
  paintRating(r)
  // The list is narrowed to the range being written about, and leaves out what
  // the composer now shows — so both move with it.
  renderList(r)
  syncMap(r, fly)
}

/**
 * A new review picked onto a range you already hold is that entry again —
 * there is one per range — so the composer shows what it holds: its words in
 * the box when none are typed, its stars when none are tapped. What it brought
 * in and nobody has changed goes again when the range moves on, so words about
 * one stretch are never posted about another.
 */
function fillHeld(r: Road, c: Composer): void {
  if (c.locked) return
  const key = composerKey(r)
  const was = c.fill
  if (was?.key === key) return
  if (was) {
    if (was.text !== null && c.text === was.text) c.text = ''
    if (was.stars !== null && c.stars === was.stars) c.stars = null
    c.original = null
    c.fill = null
  }
  const e = key === null ? undefined : r.store.getMyEntries(r.roadId)[key]
  const pending = key === null ? undefined : r.pending.get(key)
  if (key === null || (!e && pending === undefined)) return
  const fill: NonNullable<Composer['fill']> = { key, text: null, stars: null }
  // a star tap still on its way is the newest answer, as in editInit
  if (c.stars === null) c.stars = fill.stars = pending ?? e?.stars ?? null
  const v = liveReview(r, key)
  if (v && !c.text.trim()) {
    c.text = fill.text = v.text
    // as in an edit: words left as they are stay, an emptied box takes them down
    c.original = v.text
  }
  c.fill = fill
}

/** The stops a span starts and ends at, driven that way: stop j is where
 *  stretch j starts, so stretches j..k-1 run from stop j to stop k. */
function endsOf(sp: Span, way: Way): [number, number] {
  return way === 'fwd' ? [sp[0], sp[1] + 1] : [sp[1] + 1, sp[0]]
}

/**
 * From or To moved. Either can be any stop: From after To is the same road
 * driven back. The other end follows when it has to — to the next stop the
 * way being driven — so the pair always names a real run, never an empty one.
 */
function endPicked(r: Road, end: 'from' | 'to', raw: string): void {
  const c = r.composer
  if (!c || c.locked) return
  if (c.busy) {
    // this puts the select back to the range being posted
    paintRating(r)
    syncMap(r, false)
    return
  }
  const stops = r.s.length
  if (raw === '') c.span = null
  else {
    const j = Math.max(0, Math.min(stops, Number(raw)))
    const step = r.way === 'fwd' ? 1 : -1
    const beside = (k: number, by: number) => (k + by >= 0 && k + by <= stops ? k + by : k - by)
    const was = c.span ? endsOf(c.span, r.way) : null
    let from: number
    let to: number
    if (end === 'from') {
      from = j
      to = was && was[1] !== from ? was[1] : beside(from, step)
    } else {
      to = j
      from = was && was[0] !== to ? was[0] : beside(to, -step)
    }
    r.way = from < to ? 'fwd' : 'rev'
    c.span = [Math.min(from, to), Math.max(from, to) - 1]
  }
  rangeMoved(r, c, c.span !== null)
}

const pick = (r: Road, i: number): void => {
  if (r.composer) composerTap(r, i)
  else filterTap(r, i)
}

/** The stretch drawn under a tap on the bar — by where the parts are drawn,
 *  which is their km, so a short stretch is a small target and the list is
 *  there for it. */
function segAt(bar: HTMLElement, x: number): number | null {
  let best: number | null = null
  let bestD = Infinity
  for (const seg of Array.from(bar.querySelectorAll<HTMLElement>('.sb-seg'))) {
    const b = seg.getBoundingClientRect()
    const d = x < b.left ? b.left - x : x > b.right ? x - b.right : 0
    if (d < bestD) {
      bestD = d
      best = Number(seg.dataset.i)
    }
  }
  return best
}

const peeking = (): boolean =>
  matchMedia('(max-width: 768px)').matches && document.getElementById('panel')?.dataset.sheet === 'peek'

/** Bring the reviews up: the sheet first, then the section, then focus. */
function showReviews(r: Road): void {
  if (!inPanel(r)) return
  document.dispatchEvent(new CustomEvent('rti:expand-sheet'))
  focusOn(r.ratingEl.querySelector<HTMLElement>('h3'))
  r.ratingEl.scrollIntoView({ block: 'start', behavior: smooth() })
}

/**
 * A tap on the open road, on the map. `i` is the stretch the map hit, or null
 * for a tap on the road line itself, which picks the nearest stretch. Never
 * re-renders the panel — a half-written review must survive a map tap.
 */
export function stretchTap(roadId: string, i: number | null, at: LngLat): void {
  const r = cur
  // never a road the panel has since closed, whose elements are off the page
  if (!r || !inPanel(r) || r.roadId !== roadId || !r.s.length) return
  r.at = at
  const idx = i !== null && Number.isInteger(i) && i >= 0 && i < r.s.length ? i : nearestStretch(r.s, at)
  if (idx === null) return
  if (r.composer) return composerTap(r, idx)
  // a peeking sheet shows the headline at most, so say what was picked here
  if (filterTap(r, idx) && peeking()) {
    toast(r.fc.features[idx]?.properties.tip ?? spanName(r, [idx, idx]), {
      action: { label: 'Reviews', cb: () => showReviews(r) },
    })
  }
}

/**
 * Whether the open panel's reviews are this road's, and on screen. A tap on
 * the open road goes to stretchTap only then: until they are — its details
 * still loading, or failed to — tapping the road again must open it again,
 * which is the retry, and there is no review on screen yet that it could wipe.
 */
export function ownsRoad(roadId: string): boolean {
  return cur !== null && inPanel(cur) && cur.roadId === roadId
}

/** What was last said about a tap or a key that did nothing, and when, so a
 *  few in a row make one toast, not a stack of them. */
let said = { text: '', at: -Infinity }

function say(text: string): void {
  const now = performance.now()
  if (text === said.text && now - said.at <= 4000) return
  said = { text, at: now }
  toast(text)
}

/** Say why a tap or a key did nothing. Not while posting: that ends by itself.
 *  Post stays disabled until it has a range and stars, so "tap Post" alone
 *  would send people to a button that can't be tapped — say what is missing. */
function nudge(r: Road, c: Composer): void {
  if (c.busy) return
  const next =
    composerKey(r) === null
      ? 'pick where you drove, then Post'
      : c.stars === null
        ? 'tap a star, then Post'
        : 'tap Post'
  say(`Your review isn't posted yet — ${next}, or Cancel.`)
}

/** The open composer holds something a stray tap must not throw away. */
const keeps = (r: Road): Composer | null => {
  const c = r.composer
  return c && inPanel(r) && (c.busy || touched(r, c)) ? c : null
}

/**
 * Escape and a tap off the road, before they close anything. A review being
 * written comes first: with stars, words or a range changed it is a draft,
 * and stays — Cancel is the way to drop one. Left untouched, it just closes.
 * Only then does a picked stretch let go. True when there was something to
 * keep or let go of, which is the caller's cue to stop there.
 */
export function clearStretchSelection(): boolean {
  const r = cur
  if (!r || !inPanel(r)) return false
  const c = r.composer
  if (c) {
    const kept = keeps(r)
    if (kept) nudge(r, kept)
    else cancelComposer(r)
    return true
  }
  if (!r.s.length || !r.sel) return false
  setSel(r, null)
  return true
}

/**
 * A tap on another road while a review is being written here. Opening that
 * road would re-render the panel over the draft, and the composer itself
 * sends people to the map, so a tap that misses this road's line and lands on
 * a crossing one is easy. True when the tap should stop here.
 */
export function holdsDraft(): boolean {
  const c = cur ? keeps(cur) : null
  if (cur && c) nudge(cur, c)
  return c !== null
}

/**
 * The open road is this one, with a review being written — or posted — in
 * it. Opening the road again (search, Find my road, a link to it) would build
 * its panel afresh over the draft, so the caller leaves the panel as it is.
 */
export function hasDraft(roadId: string): boolean {
  return cur !== null && cur.roadId === roadId && keeps(cur) !== null
}

/**
 * Leaving the road on purpose — another road from search or a chip, a
 * company, Back, the close button — would render over a review being written.
 * A stray tap on the map is simply refused (holdsDraft); a choice made on
 * purpose is asked about. True when it may go ahead: a draft let go of is
 * cancelled, so nothing asks twice on the way out. One being posted is already
 * on its way, so it doesn't hold anything up.
 */
export function mayLeaveDraft(): boolean {
  const r = cur
  const c = r && inPanel(r) ? r.composer : null
  if (!r || !c || c.busy || !touched(r, c)) return true
  if (confirm("Your review isn't posted yet. Leave without posting it?")) {
    cancelComposer(r)
    return true
  }
  // staying: bring the draft back into view, as a second "Write" would
  document.dispatchEvent(new CustomEvent('rti:expand-sheet'))
  focusOn(r.ratingEl.querySelector<HTMLElement>('.rv-form textarea'))
  r.ratingEl.querySelector('.rate')?.scrollIntoView({ block: 'nearest', behavior: smooth() })
  return false
}

// ── composer ─────────────────────────────────────────────────────────

interface ComposerInit {
  locked?: string
  span?: Span | null
  stars?: number | null
  text?: string
  original?: string | null
}

/** Where focus goes once the composer is open: the words, or nowhere new —
 *  a star just tapped keeps it. A range still to pick wins over both. */
type Aim = 'text' | 'stars'

function composerHtml(r: Road, c: Composer): string {
  // Every stop in road order, in both lists: a run starts and ends at any two
  // different stops, and From after To is the road driven back.
  const stops = r.s.length ? [r.s[0].fromName, ...r.s.map((st) => st.toName)] : []
  const opts = stops.map((name, j) => `<option value="${j}">${esc(name)}</option>`).join('')
  const pick =
    r.s.length && !c.locked
      ? `<div class="rv-pick" role="group" aria-label="Where you drove">
          <span class="rv-end"><label for="rv-from">From</label><select id="rv-from" data-end="from"><option value="">Choose…</option>${opts}</select></span>
          <span class="rv-end"><label for="rv-to">To</label><select id="rv-to" data-end="to"><option value="">Choose…</option>${opts}</select></span>
        </div>
        <p class="rv-pick-sum" aria-live="polite"></p>`
      : ''
  return `<form class="rv-form">
    ${pick}
    <textarea class="rp-note rv-input" name="text" rows="3" maxlength="${REVIEW_MAX}" aria-label="Your review (optional)"
      placeholder="Add a few words (optional) — surface, traffic, tolls, where to stop…">${esc(c.text)}</textarea>
    <p class="rating-note rv-form-foot">Public and anonymous · <span data-count>${c.text.length}</span>/${REVIEW_MAX}</p>
    <div class="rp-actions">
      <button type="button" class="btn btn-ghost" data-act="cancel">Cancel</button>
      <button type="submit" class="btn btn-primary"></button>
    </div>
  </form>`
}

/** What the From/To pair adds up to. The card's label already names it. */
function pickSumHtml(r: Road, key: string | null): string {
  const sp = key === null ? null : expandRange(r.s, key, r.marks)
  if (key === null || !sp) return 'Pick where you joined and left the road — or tap it on the map'
  const n = sp[1] - sp[0] + 1
  const parts = n === r.s.length ? `All ${n} stretches` : plural(n, 'stretch', 'stretches')
  // one entry per range: what is posted here replaces what is already there
  const had = r.store.getMyEntries(r.roadId)[key]
  const before = liveReview(r, key)
    ? ' · this updates your earlier review'
    : had?.stars != null
      ? ' · this updates your earlier rating'
      : ''
  return `${parts} · ${kmText(displayKm(r.s, sp[0], sp[1], r.lengthKm))}${before}`
}

function paintComposer(r: Road, c: Composer): void {
  const form = r.ratingEl.querySelector<HTMLFormElement>('.rv-form')
  if (!form) return
  const key = composerKey(r)
  const from = form.querySelector<HTMLSelectElement>('#rv-from')
  const to = form.querySelector<HTMLSelectElement>('#rv-to')
  if (from && to) {
    const ends = c.span ? endsOf(c.span, r.way) : null
    from.value = ends ? String(ends[0]) : ''
    to.value = ends ? String(ends[1]) : ''
    // a drive ends somewhere other than where it started
    for (const o of Array.from(to.options)) o.disabled = ends !== null && o.value === String(ends[0])
    setHtml(form.querySelector('.rv-pick-sum'), pickSumHtml(r, key))
  }
  const area = form.querySelector<HTMLTextAreaElement>('textarea')
  if (area) {
    // read-only rather than disabled while posting, so focus stays where it is
    area.readOnly = c.busy
    // a range you already hold brings its words into the box, and takes them back
    if (area.value !== c.text) {
      area.value = c.text
      const count = form.querySelector('[data-count]')
      if (count) count.textContent = String(c.text.length)
    }
  }
  const submit = form.querySelector<HTMLButtonElement>('[type=submit]')
  if (submit) {
    submit.disabled = c.busy || c.stars === null || key === null
    // The stars may be off screen behind the keyboard, so the button that
    // won't work says why. Where you drove has its own line just above. Words
    // already up are changed, not posted again.
    const edits = key !== null && liveReview(r, key) !== undefined
    submit.textContent = c.busy ? 'Saving…' : c.stars === null ? 'Tap a star first' : edits ? 'Save' : 'Post'
  }
}

function openComposer(r: Road, init: ComposerInit, aim: Aim): void {
  const box = r.ratingEl.querySelector<HTMLElement>('.rate-act')
  if (!box || !live(r)) return
  const open = r.composer
  if (open && (open.busy || touched(r, open))) {
    // one at a time — never throw away words already typed
    focusOn(box.querySelector<HTMLElement>('textarea'))
    r.ratingEl.querySelector('.rate')?.scrollIntoView({ block: 'nearest', behavior: smooth() })
    return
  }
  // an untouched one simply gives way to the one asked for now
  const c: Composer = {
    locked: init.locked ?? null,
    span: init.span ?? null,
    stars: init.stars ?? null,
    text: init.text ?? '',
    original: init.original ?? null,
    start: { stars: null, text: '', span: null, way: 'fwd' },
    fill: null,
    busy: false,
  }
  r.composer = c
  fillHeld(r, c)
  // what it opens with, an entry you hold included, is not yet a draft
  c.start = { stars: c.stars, text: c.text, span: c.span, way: r.way }
  said = { text: '', at: -Infinity } // a new draft gets its own first "not posted yet"
  setHtml(box, composerHtml(r, c))
  paintRating(r)
  renderList(r) // "No reviews yet" gives way while one is being written
  syncMap(r, false)
  // the card may sit low in the sheet — bring the sheet up before focusing in it
  document.dispatchEvent(new CustomEvent('rti:expand-sheet'))
  const target =
    composerKey(r) === null
      ? box.querySelector<HTMLElement>('#rv-from')
      : aim === 'text'
        ? box.querySelector<HTMLElement>('textarea')
        : null
  focusOn(target)
  r.ratingEl.querySelector('.rate')?.scrollIntoView({ block: 'nearest', behavior: smooth() })
}

/** Back to the "Write a review" button; the callers repaint the rest. */
function closeComposer(r: Road): void {
  r.composer = null
  paintRate(r)
}

function cancelComposer(r: Road): void {
  const c = r.composer
  if (!c || c.busy) return
  // a tap on the map is not a reason to pull focus into the panel
  const wasIn = r.ratingEl.querySelector('.rv-form')?.contains(document.activeElement) ?? false
  // the way the draft turned the road goes back with it, as its pick does
  r.way = c.start.way
  closeComposer(r)
  paintRating(r)
  renderList(r)
  syncMap(r, false)
  if (wasIn || document.activeElement === document.body) {
    focusOn(r.ratingEl.querySelector<HTMLElement>('.rate-write'))
  }
}

/** Edit what you have for a range: its stars, and its words if they are here.
 *  A star tap still on its way is the newest answer, so it wins, as in fillHeld. */
function editInit(r: Road, key: string): ComposerInit {
  const e = r.store.getMyEntries(r.roadId)[key]
  const v = liveReview(r, key)
  const stars = r.pending.get(key) ?? v?.stars ?? e?.stars ?? null
  return { locked: key, stars, text: v?.text ?? '', original: v?.text ?? '' }
}

/** A new entry starts on what is picked, else the stretch you are on. Whatever
 *  you already gave that range comes in with fillHeld, once it is open. */
function writeInit(r: Road): ComposerInit {
  return { span: r.s.length ? (r.sel ?? near(r)) : null }
}

async function post(r: Road): Promise<void> {
  const c = r.composer
  if (!c || c.busy) return
  const key = composerKey(r)
  if (key === null || c.stars === null) return
  const words = c.text.trim()
  if (words && words.length < 3) {
    toast('Write a few more words — or leave it empty.')
    r.ratingEl.querySelector<HTMLElement>('.rv-form textarea')?.focus()
    return
  }
  // Leaving the words out keeps whatever you wrote before; an edit that
  // empties them takes them down and keeps the stars.
  const text = c.original === null ? words || undefined : words === c.original.trim() ? undefined : words
  const stars = c.stars
  c.busy = true
  paintRate(r)
  try {
    const res = await r.store.saveEntry(r.roadId, { stars, range: key, text })
    if (!live(r)) return
    adopt(r, res.summary)
    r.pending.delete(res.range)
    closeComposer(r)
    // show what was just posted in its place: the list narrowed to its
    // stretches, and the card facing the way it was driven
    r.sel = res.range === ALL ? null : expandRange(r.s, res.range, r.marks)
    r.way = rangeWay(r.s, res.range, r.marks) ?? r.way
    r.expanded = false
    r.opened.clear()
    refresh(r)
    toast(
      text
        ? 'Thanks! Your review is live.'
        : text === ''
          ? 'Your words were removed — your stars stay.'
          : `Saved: ${plural(stars, 'star')} for ${nameOf(r, res.range)}`,
    )
    focusOn(
      r.reviewsEl.querySelector<HTMLElement>(`.rv-item[data-range="${CSS.escape(res.range)}"]`) ??
        r.ratingEl.querySelector<HTMLElement>('h3'),
    )
  } catch (e) {
    if (!live(r) || r.composer !== c) return
    c.busy = false
    paintRate(r)
    // the button was disabled under the pointer; hand focus back to it
    r.ratingEl.querySelector<HTMLElement>('.rv-form [type=submit]')?.focus({ preventScroll: true })
    toast(writeFail(errCode(e), 'Review'))
  }
}

// ── writes from the list and the card's stars ────────────────────────

/**
 * A quick 4★-then-5★ puts two writes in the queue. Only the newest tap's
 * failure may undo the paint, and it goes back to what the server last
 * accepted — not to whatever was on screen when that tap was made, which may
 * itself have been an earlier tap that never saved. Kept per range: a tap on
 * one stretch never undoes another's.
 */
async function saveStars(r: Road, key: string, stars: number): Promise<void> {
  const tap = (r.taps.get(key) ?? 0) + 1
  r.taps.set(key, tap)
  r.pending.set(key, stars)
  paintRating(r)
  try {
    // The POST returns the recomputed summary, so the numbers update from
    // the write itself rather than a follow-up read that the edge cache
    // could answer with a pre-rating value.
    const res = await r.store.saveEntry(r.roadId, { stars, range: key })
    if (!live(r)) return
    const newest = r.taps.get(key) === tap
    if (newest) r.pending.delete(key)
    adopt(r, res.summary)
    refresh(r) // your review, if any, now shows the new stars
    // An older tap's "Saved: 4 stars" would contradict the 5 on the card; the
    // newest says "Saved" itself when it lands.
    if (newest) savedToast(r, res.range, stars)
  } catch (e) {
    // a newer tap is still on its way, and its outcome decides what shows
    if (!live(r) || r.taps.get(key) !== tap) return
    // the optimistic paint above must not survive a failed write, or a
    // rejected rating looks saved until the next reload
    r.pending.delete(key)
    paintRating(r)
    const code = errCode(e)
    console.warn('[ratings] save failed —', code)
    // the card may show another stretch by now, so say which one this was
    toast(writeFail(code, 'Rating', rowKey(r) === key ? undefined : nameOf(r, key)))
  }
}

/** "Saved", and — the moment someone has an opinion being the moment to ask
 *  for the words — a way to add them, while that range has none. */
function savedToast(r: Road, range: string, stars: number): void {
  const ask = !liveReview(r, range) && !r.composer
  toast(`Saved: ${plural(stars, 'star')} for ${nameOf(r, range)}`, {
    action: ask
      ? {
          label: 'Add a few words',
          cb: () => {
            if (inPanel(r)) openComposer(r, editInit(r, range), 'text')
          },
        }
      : undefined,
  })
}

function starTap(r: Road, stars: number): void {
  const c = r.composer
  if (c) {
    // the composer's stars: nothing is saved until Post
    if (c.busy) return
    c.stars = stars
    // tapped, they are yours now, and stay whatever range is picked next
    if (c.fill) c.fill.stars = null
    paintRate(r)
    return
  }
  const key = rowKey(r)
  // a stretched road with nothing picked: stars alone can't say where, so
  // they start a review of the stretch you are on and let you choose
  if (key === null) {
    openComposer(r, { span: near(r), stars }, 'stars')
    // the tap that opened it is already your answer, so it is a draft from the start
    if (r.composer) r.composer.start.stars = null
    return
  }
  // The stars this range already has, tapped again, change nothing: no write,
  // and no Turnstile token spent on one. One still on its way says "Saved"
  // itself when it lands; one that already has, says it again.
  const pending = r.pending.get(key)
  if (pending === stars) return
  if (pending === undefined && r.store.getMyEntries(r.roadId)[key]?.stars === stars) return savedToast(r, key, stars)
  void saveStars(r, key, stars)
}

async function remove(r: Road, key: string): Promise<void> {
  // the review being posted to this range is locked like the rest of the
  // composer: a delete sent behind that post would take it straight down
  if (r.composer?.busy && composerKey(r) === key) return
  const words = Boolean(r.store.getMyEntries(r.roadId)[key]?.reviewId)
  if (!confirm(`Delete your rating${words ? ' and review' : ''} of ${nameOf(r, key)}?`)) return
  try {
    const summary = await r.store.removeEntry(r.roadId, key)
    if (!live(r)) return
    adopt(r, summary)
    r.pending.delete(key)
    if (r.composer?.locked === key) closeComposer(r)
    refresh(r)
    toast(words ? 'Your rating and review were removed.' : 'Your rating was removed.')
  } catch (e) {
    if (!live(r)) return
    const code = errCode(e)
    if (code !== 'not-yours') return toast(writeFail(code, 'Review'))
    // Storage still holds it as yours, so it stays on screen with its Delete
    // for when you are back on the connection that wrote it. If it is in fact
    // gone, that Delete can never work, so it can also be let go of here.
    toast(NOT_YOURS, { action: { label: 'Forget it', cb: () => forget(r, key) } })
  }
}

/** Lets go of an entry in this browser only. Whatever the server holds stays
 *  as it is; it just no longer shows as yours. */
function forget(r: Road, key: string): void {
  if (!inPanel(r)) return
  if (r.composer?.busy && composerKey(r) === key) return
  r.store.forgetEntry(r.roadId, key)
  r.pending.delete(key)
  if (r.composer?.locked === key) closeComposer(r)
  refresh(r)
  toast('Forgotten on this device.')
}

async function like(r: Road, btn: HTMLButtonElement, id: string): Promise<void> {
  const v = r.summary?.reviews?.find((x) => x.id === id)
  if (!v) return
  const on = btn.getAttribute('aria-pressed') !== 'true'
  const was = v.likes
  const show = (likes: number, liked: boolean) => {
    v.likes = likes
    btn.setAttribute('aria-pressed', String(liked))
    btn.setAttribute('aria-label', `Helpful${likes ? `, ${likes}` : ''}`)
    btn.innerHTML = likeHtml(likes)
  }
  show(Math.max(0, was + (on ? 1 : -1)), on) // optimistic; the list keeps its order so nothing jumps under your thumb
  try {
    const res = await r.store.setReviewLike(r.roadId, id, on)
    show(res.likes, res.liked)
  } catch (e) {
    show(was, !on)
    if (!live(r)) return
    const code = errCode(e)
    toast(code === 'not-found' ? 'That review is gone.' : failMessage(code, 'Liking'))
  }
}

// ── wiring ───────────────────────────────────────────────────────────

function wire(r: Road, signal: AbortSignal): void {
  // Stars, bar and list are wired BEFORE the summary loads. The buttons are on
  // screen from the first paint. Wiring them only after the read returned left
  // them dead for as long as that took — seconds on a cold start — so the
  // first tap did nothing and only the second one rated.
  r.ratingEl.addEventListener(
    'click',
    (e) => {
      const t = e.target as HTMLElement
      const btn = t.closest<HTMLButtonElement>('[data-act]')
      switch (btn?.dataset.act) {
        case 'star':
          return starTap(r, Number(btn.dataset.n))
        case 'write':
          return openComposer(r, writeInit(r), 'text')
        case 'edit-here': {
          const key = rowKey(r)
          if (key !== null) openComposer(r, editInit(r, key), 'text')
          return
        }
        case 'delete-here': {
          const key = rowKey(r)
          if (key !== null) void remove(r, key)
          return
        }
        case 'cancel':
          return cancelComposer(r)
        case 'flip':
          return flip(r)
      }
      const row = t.closest<HTMLButtonElement>('.sb-row')
      if (row) return pick(r, Number(row.dataset.i))
      // Not a button, so on a peeking sheet this tap also pulls the sheet up
      // (initSheetGestures) — which is where the answer to it is.
      const bar = t.closest<HTMLElement>('.sb')
      const i = bar ? segAt(bar, e.clientX) : null
      if (i !== null) pick(r, i)
    },
    { signal },
  )
  r.ratingEl.querySelector('.sb-list')?.addEventListener(
    'toggle',
    (e) => {
      const open = (e.currentTarget as HTMLDetailsElement).open
      // its pressed row says what the card's meta would, right above it
      r.ratingEl.querySelector('.rate')?.classList.toggle('is-listed', open)
      // sixteen rows don't fit in a peeking sheet
      if (open) document.dispatchEvent(new CustomEvent('rti:expand-sheet'))
    },
    { signal },
  )
  r.ratingEl.addEventListener(
    'change',
    (e) => {
      const sel = e.target
      if (!(sel instanceof HTMLSelectElement)) return
      const end = sel.dataset.end
      if (end === 'from' || end === 'to') endPicked(r, end, sel.value)
    },
    { signal },
  )
  r.ratingEl.addEventListener(
    'submit',
    (e) => {
      e.preventDefault()
      void post(r)
    },
    { signal },
  )
  r.ratingEl.addEventListener(
    'input',
    (e) => {
      const ta = e.target
      if (!(ta instanceof HTMLTextAreaElement) || !r.composer) return
      r.composer.text = ta.value
      const count = r.ratingEl.querySelector('[data-count]')
      if (count) count.textContent = String(ta.value.length)
    },
    { signal },
  )

  r.reviewsEl.addEventListener(
    'click',
    (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]')
      if (!btn || btn.disabled) return
      const item = btn.closest<HTMLElement>('.rv-item')
      switch (btn.dataset.act) {
        case 'more': {
          r.expanded = true
          renderList(r)
          // the first review that just came into view; your star lines sit above the reviews
          focusOn(r.reviewsEl.querySelectorAll<HTMLElement>('.rv-item:not(.rv-rated)')[SHOWN])
          return
        }
        case 'show-all':
          return setSel(r, null)
        case 'edit':
        case 'words':
          // the composer lives in the card above, under its stars
          return openComposer(r, editInit(r, item?.dataset.range ?? ALL), 'text')
        case 'delete':
          if (item?.dataset.range) void remove(r, item.dataset.range)
          return
        case 'read':
          if (item?.dataset.id) r.opened.add(item.dataset.id)
          item?.classList.add('is-open')
          btn.remove()
          focusOn(item)
          return
        case 'like':
          if (item?.dataset.id) void like(r, btn, item.dataset.id)
          return
      }
    },
    { signal },
  )
}

export async function renderCommunity(ratingEl: HTMLElement, reviewsEl: HTMLElement, ctx: CommunityCtx): Promise<void> {
  wiring?.abort()
  const ac = (wiring = new AbortController())
  const t = ++token
  const store = await getStore()
  if (t !== token) return
  const s = ctx.shape ? buildStretches(ctx.shape) : []
  const scores: (StretchScore | null)[] = s.map(() => null)
  const r: Road = {
    token: t,
    store,
    roadId: ctx.roadId,
    roadRef: ctx.roadRef,
    lengthKm: ctx.lengthKm,
    s,
    marks: ctx.shape?.properties.marks,
    at: ctx.at,
    ratingEl,
    reviewsEl,
    summary: null,
    loaded: false,
    failed: null,
    wrote: false,
    scores,
    fc: stretchesFC(s, scores),
    sel: null,
    way: 'fwd',
    scoredWay: 'fwd',
    composer: null,
    expanded: false,
    opened: new Set(),
    pending: new Map(),
    taps: new Map(),
  }
  cur = r

  ratingEl.innerHTML = ratingHtml(r)
  reviewsEl.innerHTML = ''
  wire(r, ac.signal)
  paintRating(r)
  renderList(r)
  // the stretches go on the map before their scores, so picking one works
  // even when the read is slow or fails
  showOnMap(r)

  try {
    const loaded = await store.getRatingSummary(r.roadId)
    // A rating or review saved while this read was in flight returned a newer
    // summary than the one this (possibly edge-cached) read is about to give.
    if (!live(r) || r.wrote) return
    r.summary = loaded
    r.loaded = true
  } catch (e) {
    if (!live(r) || r.wrote) return // the write's own summary is already on screen
    r.failed = errCode(e)
    console.warn('[ratings] summary unavailable —', r.failed)
  }
  refresh(r)
}
