#!/usr/bin/env node
/**
 * Daily news. Asks the Google News RSS feed for headlines about the roads,
 * keeps only the ones that name a road (lib/news-match.mjs), and writes them
 * newest first to public/data/news/<id>.json. Run once a day by
 * .github/workflows/news.yml, which commits the result — and that commit is
 * what redeploys the site. docs/NEWS.md describes the whole job.
 *
 *   node scripts/fetch-news.mjs                   # a daily run
 *   node scripts/fetch-news.mjs --only nh-44,mc-road --dry-run
 *   node scripts/fetch-news.mjs --rules-changed   # the matching rules changed on
 *                                                 # purpose: let headlines go
 *
 * Google allows a feed reader a few hundred queries a day from one machine —
 * a GitHub runner was refused after 171 — and a refusal lasts hours. So each
 * run asks at most MAX_QUERIES, and makes each one count:
 *
 *   - It searches headline *terms*, not roads. A road contributes its numbers,
 *     its names, and (if it has no number) its two end towns; a term shared by
 *     many roads ("SH 29" is a road in most states) is asked once.
 *   - Terms go ten to a query, `"NH 342" OR "NH 548C" OR …`, which Google
 *     answers with the union of their results. Every headline that comes back
 *     is offered to every road behind the batch, and each road's own test
 *     decides. A batch that fills the feed's 100 results may have lost some,
 *     so it is split and asked again; a term that fills it alone is
 *     remembered, and asked alone from then on.
 *   - Hot roads — hand-written ones, and any road that already has news — are
 *     asked about every day. The other ~7,000 take turns: each run carries on
 *     through them from where the last one stopped, so every road is asked
 *     about roughly once a week.
 *
 * Each road's list merges today's matches with what it already had, all
 * re-checked against the current rules: newest first, at most eight, none
 * older than two years. Nothing is written until the run is over, and then
 * only if it looks sane:
 *
 *   exit 0  written
 *   exit 3  written, but Google refused before the run's budget was spent —
 *           the next run carries on from where this one stopped
 *   exit 4  written, but refused two runs in a row (or the rotation has not
 *           come round in three weeks): the workflow fails, so it gets noticed
 *   exit 1  the run looks broken (queries failing, feeds coming back empty,
 *           headlines vanishing wholesale) — nothing written
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isFeed, parseRss } from './lib/news-feed.mjs'
import { buildMatchers, norm } from './lib/news-match.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ROADS_DIR = join(ROOT, 'public', 'data', 'roads')
const NEWS_DIR = join(ROOT, 'public', 'data', 'news')
const STATUS_FILE = join(NEWS_DIR, '_status.json')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
function option(name) {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (i < 0) return null
  return argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : argv[i + 1]
}

const DRY = flag('dry-run')
const RULES_CHANGED = flag('rules-changed')
const ONLY = option('only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null
/** Well under the 171 queries after which a GitHub runner was first refused. */
const MAX_QUERIES = Number(option('max-queries') ?? 140)
/** Hot roads may use this many; the rotation always gets the rest. */
const HOT_SHARE = 0.6
const GAP_MS = Number(option('gap-ms') ?? 3000)

const MAX_ITEMS = 8
/** "In the news" means the last two years; older stories drop off the list. */
const WINDOW_MS = 730 * 24 * 3600_000
const BATCH = 10
/** The feed never returns more than 100; this many means some may be missing. */
const FULL = 95
/** A refusal can be a passing hiccup: wait once, then stop for the day. */
const REFUSAL_PAUSE_MS = 3 * 60_000
/** The rotation should come round in about a week; three means it is stuck. */
const LAP_ALARM_MS = 21 * 24 * 3600_000
const USER_AGENT = 'RoadTrackerIndia-news/2.0 (+https://roadtrackerindia.com)'

const log = (s) => console.log(s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const startedAt = Date.now()
const elapsedMin = () => ((Date.now() - startedAt) / 60_000).toFixed(1)

// ── asking Google ───────────────────────────────────────────────────

class Refused extends Error {}
let lastRequest = 0
let refusals = 0

/**
 * One query → the feed's items. Network errors and 5xx are retried a few
 * times. A refusal (503/429, or Google's "Sorry…" page) is waited out once;
 * a second one ends the run with `Refused`.
 */
async function fetchFeed(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`
  let errors = 0
  let refusedHere = false
  for (;;) {
    const wait = lastRequest + GAP_MS + Math.random() * 500 - Date.now()
    if (wait > 0) await sleep(wait)
    lastRequest = Date.now()
    let status = 0
    let body = ''
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) })
      status = res.status
      body = await res.text()
    } catch (e) {
      if (++errors >= 4) throw new Error(`network: ${e.message}`)
      await sleep(5_000 * errors)
      continue
    }
    if (status === 200 && isFeed(body)) return parseRss(body)
    if (status === 429 || status === 503 || /unusual traffic|<title>Sorry/i.test(body)) {
      refusals++
      if (refusedHere) throw new Refused()
      refusedHere = true
      log(`  … Google refused a query; waiting ${REFUSAL_PAUSE_MS / 60_000} min before one more try`)
      await sleep(REFUSAL_PAUSE_MS)
      continue
    }
    if (++errors >= 4 || (status >= 400 && status < 500)) throw new Error(`HTTP ${status}`)
    await sleep(5_000 * errors)
  }
}

// ── what there is to ask ────────────────────────────────────────────

const roads = readdirSync(ROADS_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(ROADS_DIR, f), 'utf8')))
const byId = new Map(roads.map((r) => [r.id, r]))
const matchers = buildMatchers(roads)

if (ONLY) {
  const unknown = ONLY.filter((id) => !byId.has(id))
  if (unknown.length) {
    console.error(`news: unknown road id(s): ${unknown.join(', ')}`)
    process.exit(1)
  }
}

mkdirSync(NEWS_DIR, { recursive: true })
const readJSON = (p) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return null
  }
}
const newsPath = (id) => join(NEWS_DIR, `${id}.json`)
const previousStatus = readJSON(STATUS_FILE) ?? {}
const previous = new Map()
for (const f of readdirSync(NEWS_DIR)) {
  if (f.endsWith('.json') && !f.startsWith('_')) previous.set(f.slice(0, -5), readJSON(join(NEWS_DIR, f))?.items ?? [])
}
const had = (id) => (previous.get(id) ?? []).length > 0
const loud = new Set(previousStatus.loud ?? [])

const inScope = (ONLY ? ONLY.map((id) => byId.get(id)) : roads).filter((r) => matchers.get(r.id).searchable)
const isHot = (r) => r.provenance !== 'osm' || had(r.id)

/**
 * The things to ask, each keyed so the two lists sort the same way every run:
 * a search term (and every road it could be about), or a hand-written road's
 * own newsQuery, which is asked on its own because it is not a bare phrase.
 */
const entries = new Map()
for (const r of inScope) {
  const m = matchers.get(r.id)
  for (const t of m.terms) {
    const key = `t:${t.toLowerCase()}`
    const e = entries.get(key) ?? { key, term: t, roads: new Set(), hot: false }
    e.roads.add(r.id)
    e.hot ||= isHot(r)
    entries.set(key, e)
  }
  if (m.newsQuery) entries.set(`q:${r.id}`, { key: `q:${r.id}`, query: m.newsQuery, roads: new Set([r.id]), hot: true })
}
const hotList = [...entries.values()].filter((e) => e.hot).sort((a, b) => a.key.localeCompare(b.key))
const coldList = [...entries.values()].filter((e) => !e.hot).sort((a, b) => a.key.localeCompare(b.key))

const phrase = (t) => `"${t.replace(/"/g, '').replace(/[–—-]+/g, ' ').replace(/\s+/g, ' ').trim()}"`
const solo = (e) => !!e.query || loud.has(e.term)

/** Where `key` sits in a sorted list — the first entry at or after it. */
const indexOf = (list, key) => {
  const i = key == null ? 0 : list.findIndex((e) => e.key >= key)
  return i < 0 ? 0 : i
}

/**
 * Walks a list from `cursor`, wrapping at the end, and stops just before
 * `stopAt` (or after one whole lap), yielding the queries to ask: runs of up
 * to BATCH plain terms, and solo entries on their own.
 */
function* lap(list, cursor, stopAt) {
  const n = list.length
  if (!n) return
  const start = indexOf(list, cursor)
  const take = stopAt === undefined ? n : (indexOf(list, stopAt) - start + n) % n
  const order = Array.from({ length: take }, (_, i) => list[(start + i) % n])
  let batch = []
  for (const e of order) {
    if (solo(e)) {
      if (batch.length) yield batch
      batch = []
      yield [e]
      continue
    }
    batch.push(e)
    if (batch.length === BATCH) {
      yield batch
      batch = []
    }
  }
  if (batch.length) yield batch
}

const queryText = (group) => (group.length === 1 && group[0].query ? group[0].query : group.map((e) => phrase(e.term)).join(' OR '))

// ── the run ─────────────────────────────────────────────────────────

const unsearchable = roads.length - roads.filter((r) => matchers.get(r.id).searchable).length
log(
  `news: ${hotList.length} hot and ${coldList.length} rotating things to ask about ` +
    `(${unsearchable} roads have nothing a headline could name); up to ${MAX_QUERIES} queries`,
)

const gathered = new Map() // road id → [{ item, viaNewsQuery }]
const failed = []
const newLoud = new Set()
const quiet = new Set()
let asked = 0
let refused = false
let hotAsked = 0
let hotEmpty = 0

/**
 * Asks one list's queries, from `cursor` round to `stopAt` (default: one whole
 * lap), until `budget` runs out or Google refuses.
 *
 * @returns {{ next: string | null, done: boolean, wrapped: boolean, spent: number }}
 *   `next` is where to carry on next time; `done` says everything up to the
 *   stop was asked; `wrapped` says the walk went past the end of the list, so
 *   a pass over the whole list has now been completed.
 */
async function work(list, cursor, budget, hot, stopAt) {
  const firstKey = list[0]?.key
  const startsAtTop = indexOf(list, cursor) === 0
  const splits = []
  const it = lap(list, cursor, stopAt)
  let spent = 0
  let wrapped = false
  let next
  let done = false
  for (;;) {
    const group = splits.shift() ?? it.next().value
    if (!group) {
      done = true
      // a walk that began at the top and got to the bottom has come round too
      if (startsAtTop && stopAt === undefined) wrapped = true
      next = stopAt ?? cursor ?? null
      break
    }
    if (spent >= budget || refused) {
      next = group[0].key
      break
    }
    let items
    try {
      items = await fetchFeed(queryText(group))
    } catch (e) {
      if (e instanceof Refused) {
        refused = true
        next = group[0].key
        break
      }
      failed.push(queryText(group))
      log(`  ! ${queryText(group).slice(0, 90)}: ${e.message}`)
      spent++
      asked++
      continue
    }
    spent++
    asked++
    if (hot) {
      hotAsked++
      if (!items.length) hotEmpty++
    }
    if (items.length >= FULL && group.length > 1) {
      // some of this batch's headlines may not have fitted: ask each half again
      const half = Math.ceil(group.length / 2)
      splits.unshift(group.slice(0, half), group.slice(half))
      continue
    }
    if (!startsAtTop && group.some((e) => e.key === firstKey)) wrapped = true
    if (group.length === 1 && group[0].term) (items.length >= FULL ? newLoud : quiet).add(group[0].term)
    const viaNewsQuery = group.length === 1 && !!group[0].query
    for (const e of group) {
      for (const id of e.roads) {
        const list = gathered.get(id) ?? []
        for (const item of items) list.push({ item, viaNewsQuery })
        gathered.set(id, list)
      }
    }
  }
  return { next, done, wrapped, spent }
}

const hotStart = ONLY ? null : (previousStatus.hot?.cursor ?? null)
const hotBudget = ONLY ? MAX_QUERIES : Math.floor(MAX_QUERIES * HOT_SHARE)
const hot = await work(hotList, hotStart, hotBudget, true)
const cold = await work(coldList, ONLY ? null : (previousStatus.cold?.cursor ?? null), MAX_QUERIES - hot.spent, false)
// the rotation has had its share; what is left goes back to the hot roads
// this run did not reach, and stops where today's hot walk began
const hotRest = !hot.done && !refused && asked < MAX_QUERIES ? await work(hotList, hot.next, MAX_QUERIES - asked, true, hotStart ?? hotList[0]?.key) : null
const hotNext = hotRest ? hotRest.next : hot.next

// ── the stories each road keeps ─────────────────────────────────────

const now = Date.now()
const inWindow = (item) => {
  const t = Date.parse(item.date)
  return t > now - WINDOW_MS && t < now + 36 * 3600_000
}

/**
 * What came back that names this road, merged with what it already had —
 * re-checked, so a rule change reaches old stories too — newest first.
 * Google's results wobble from day to day; with the merge a story only
 * leaves when newer ones push it out or it turns two years old.
 */
function select(road, fetched) {
  const m = matchers.get(road.id)
  const carried = (previous.get(road.id) ?? []).map((item) => ({ item, viaNewsQuery: !!road.newsQuery }))
  const seen = new Set()
  const keep = []
  for (const { item, viaNewsQuery } of [...fetched, ...carried]) {
    if (!inWindow(item) || !m.test(item.title, { source: item.source, viaNewsQuery })) continue
    const key = norm(item.title).trim()
    if (seen.has(item.url) || seen.has(key)) continue
    seen.add(item.url)
    seen.add(key)
    keep.push({ title: item.title, url: item.url, source: item.source, date: item.date })
  }
  keep.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title))
  return keep.slice(0, MAX_ITEMS)
}

// Every road with a file is re-checked, asked about today or not: stories age
// out, and an empty file (the old fetcher wrote them) is removed.
const results = new Map()
for (const r of ONLY ? ONLY.map((id) => byId.get(id)) : roads) {
  if (gathered.has(r.id) || previous.has(r.id)) results.set(r.id, select(r, gathered.get(r.id) ?? []))
}

// ── is this run sane? ───────────────────────────────────────────────

const hasNews = [...results.values()].filter((items) => items.length).length
const hadNews = [...results.keys()].filter(had).length
const stillHas = [...results.keys()].filter((id) => had(id) && results.get(id).length).length
const gained = [...results.keys()].filter((id) => !had(id) && results.get(id).length).length
log(
  `news: ${asked} queries (${refusals} refused) in ${elapsedMin()} min · ${hasNews} roads with headlines, ` +
    `${gained} of them new${refused ? ' · stopped early: Google refused' : ''}`,
)

const problems = []
if (asked >= 20 && failed.length / asked > 0.1) problems.push(`${failed.length} of ${asked} queries failed`)
// hot roads are the ones in the news; their feeds are never nearly all empty
if (hotAsked >= 10 && hotEmpty / hotAsked > 0.9)
  problems.push(`Google returned nothing for ${hotEmpty} of ${hotAsked} queries about roads that are in the news`)
if (!RULES_CHANGED && hadNews >= 40 && stillHas < hadNews * 0.5)
  problems.push(`only ${stillHas} of ${hadNews} roads kept their headlines — pass --rules-changed if that is on purpose`)
if (problems.length) {
  console.error(`news: not writing anything — ${problems.join('; ')}`)
  process.exit(1)
}

if (DRY) {
  for (const [id, items] of results) {
    if (!ONLY && !items.length) continue
    log(`${id} (${(gathered.get(id) ?? []).length} fetched → ${items.length} kept)`)
    for (const i of items) log(`    ${i.date.slice(0, 10)}  ${i.title}  — ${i.source}`)
  }
  log('news: dry run, nothing written')
  process.exit(0)
}

// ── write ───────────────────────────────────────────────────────────

let written = 0
let removed = 0
for (const [id, items] of results) {
  const path = newsPath(id)
  if (!items.length) {
    if (existsSync(path)) {
      rmSync(path)
      removed++
    }
    continue
  }
  // only a real change touches the file, so each day's commit is a true diff
  const text = `${JSON.stringify({ items }, null, 2)}\n`
  if (existsSync(path) && readFileSync(path, 'utf8') === text) continue
  writeFileSync(path, text)
  written++
}

let exitCode = refused ? 3 : 0
if (!ONLY) {
  // a road that no longer exists (merged, renamed) takes its news with it
  for (const id of previous.keys()) {
    if (!byId.has(id) && existsSync(newsPath(id))) {
      rmSync(newsPath(id))
      removed++
    }
  }
  const withNews = readdirSync(NEWS_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_')).length
  const finished = new Date().toISOString()
  const lastLap = cold.wrapped ? finished : (previousStatus.cold?.lastLap ?? null)
  const status = {
    checked: finished,
    roads: roads.length,
    withNews,
    queries: asked,
    refused,
    hot: { cursor: hotNext },
    // the rotation through every other road: where the next run carries on,
    // and when it last came all the way round
    cold: { cursor: cold.next, lastLap, lapStarted: previousStatus.cold?.lapStarted ?? finished },
    loud: [...new Set([...loud, ...newLoud])].filter((t) => entries.has(`t:${t.toLowerCase()}`) && !quiet.has(t)).sort(),
  }
  if (cold.wrapped) status.cold.lapStarted = finished
  writeFileSync(STATUS_FILE, `${JSON.stringify(status, null, 2)}\n`)

  const lapAge = Date.now() - Date.parse(lastLap ?? status.cold.lapStarted)
  if (refused && previousStatus.refused) exitCode = 4
  if (lapAge > LAP_ALARM_MS) exitCode = 4

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Road news\n\n| | |\n|---|---|\n` +
        `| Queries | ${asked} of ${MAX_QUERIES}${refused ? ' — stopped early, Google refused' : ''} |\n` +
        `| Roads with headlines | ${withNews} (${gained} new today) |\n| Files | ${written} updated, ${removed} removed |\n` +
        `| Rotation | ${cold.wrapped ? 'came all the way round today' : `last came round ${lastLap ?? 'not yet'}`} |\n`,
    )
  }
}
log(`news: ${written} files updated, ${removed} removed`)
if (exitCode === 4) console.error('news: Google has refused this job two runs in a row, or the rotation is stuck — see docs/NEWS.md')
process.exit(exitCode)
