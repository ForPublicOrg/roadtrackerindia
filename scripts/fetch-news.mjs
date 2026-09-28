#!/usr/bin/env node
/**
 * Daily news. For every road, asks the Google News RSS feed for the latest
 * stories, keeps only the headlines that actually name that road (the rules
 * are in lib/news-match.mjs), and writes them newest first to
 * public/data/news/<id>.json. Run once a day by .github/workflows/news.yml,
 * which commits the result — and that commit is what redeploys the site.
 *
 *   node scripts/fetch-news.mjs                   # every road
 *   node scripts/fetch-news.mjs --only nh-44,mc-road
 *   node scripts/fetch-news.mjs --dry-run         # fetch and report, write nothing
 *   node scripts/fetch-news.mjs --reset           # the matching rules changed: start
 *                                                 # every list afresh
 *   node scripts/fetch-news.mjs --budget-min 200  # stop starting queries after 200 min
 *
 * Google throttles a feed reader that asks too fast, so requests are spaced,
 * and spaced further (after a pause) every time it pushes back. Nothing is
 * written until the run is over, and then only if the run looks sane:
 *
 *   exit 0  every road checked, results written
 *   exit 3  time or Google's patience ran out first — what was checked is
 *           written, and the rest is recorded so the next run starts with it
 *   exit 4  as 3, but no run has reached every road in three days: written,
 *           and the workflow then fails so a job Google keeps throttling
 *           gets noticed
 *   exit 1  the run looks broken (too many failed requests, feeds coming back
 *           empty, headlines vanishing wholesale) — nothing written
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
const RESET = flag('reset')
const ONLY = option('only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null
const BUDGET_MS = Number(option('budget-min') ?? 240) * 60_000

const MAX_ITEMS = 8
/** "In the news" means the last two years; older stories drop off the list. */
const WINDOW_MS = 730 * 24 * 3600_000
/** Starting gap between requests, and how far pushback may stretch it. */
const BASE_GAP_MS = Number(option('gap-ms') ?? 900)
const MAX_GAP_MS = 8_000
/** Stop for the day once Google has kept the run waiting this long in total. */
const MAX_THROTTLE_MS = 60 * 60_000
const WORKERS = 3
const USER_AGENT = 'RoadTrackerIndia-news/2.0 (+https://roadtrackerindia.com)'

const log = (s) => console.log(s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── pacing ──────────────────────────────────────────────────────────

const pace = {
  gap: BASE_GAP_MS,
  next: 0,
  /** Every worker holds until Google has had its pause. */
  pausedUntil: 0,
  throttledMs: 0,
  pushbacks: 0,
  async slot() {
    for (;;) {
      const now = Date.now()
      const at = Math.max(this.next, this.pausedUntil)
      if (at <= now) {
        this.next = now + this.gap + Math.random() * 250
        return
      }
      await sleep(at - now)
    }
  },
  pushback() {
    // workers already queued behind a pause report the same pushback
    if (Date.now() < this.pausedUntil) return
    this.pushbacks++
    // 1, 2, 4, 8, then 10 minutes — and the gap widens for the rest of the run
    const wait = Math.min(10, 2 ** Math.min(this.pushbacks - 1, 4)) * 60_000
    this.gap = Math.min(MAX_GAP_MS, Math.round(this.gap * 1.6))
    this.throttledMs += wait
    this.pausedUntil = Date.now() + wait
    log(`  … Google pushed back (#${this.pushbacks}); pausing ${wait / 60_000} min, gap now ${this.gap} ms`)
  },
}

class GiveUp extends Error {}

const startedAt = Date.now()
const outOfTime = () => Date.now() - startedAt > BUDGET_MS
const outOfPatience = () => pace.throttledMs > MAX_THROTTLE_MS

/**
 * One query → the feed's items. Retries network errors and 5xx a few times;
 * waits out throttling for as long as the run's patience lasts.
 */
async function fetchFeed(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-IN&gl=IN&ceid=IN:en`
  let errors = 0
  for (;;) {
    if (outOfTime() || outOfPatience()) throw new GiveUp()
    await pace.slot()
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
      pace.pushback()
      continue
    }
    if (++errors >= 4 || (status >= 400 && status < 500)) throw new Error(`HTTP ${status}`)
    await sleep(5_000 * errors)
  }
}

// ── what to check ───────────────────────────────────────────────────

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

// Whatever the last run did not reach goes first, then hand-written roads,
// then roads that already have news, then the rest. A run cut short has spent
// itself on the roads that matter most, and the next one picks up the others.
const pending = new Set(previousStatus.pending ?? [])
const rank = new Map(roads.map((r) => [r.id, pending.has(r.id) ? 0 : r.provenance !== 'osm' ? 1 : had(r.id) ? 2 : 3]))
const queue = (ONLY ? ONLY.map((id) => byId.get(id)) : roads)
  .filter((r) => matchers.get(r.id).searchable)
  .sort((a, b) => rank.get(a.id) - rank.get(b.id) || a.id.localeCompare(b.id))
const unsearchable = roads.length - roads.filter((r) => matchers.get(r.id).searchable).length

const now = Date.now()
const inWindow = (item) => {
  const t = Date.parse(item.date)
  return t > now - WINDOW_MS && t < now + 36 * 3600_000
}

/**
 * The stories that name this road — what the queries returned, merged with
 * what the road already had (re-checked, so a rule change applies to old
 * stories too) — newest first. Google's results wobble from day to day; with
 * the merge a story only leaves the list when newer ones push it out or it
 * turns two years old.
 */
function select(road, fetched) {
  const m = matchers.get(road.id)
  const carried = RESET ? [] : (previous.get(road.id) ?? []).map((item) => ({ item, viaNewsQuery: !!road.newsQuery }))
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

// ── the run ─────────────────────────────────────────────────────────

log(`news: checking ${queue.length} roads (${unsearchable} have nothing a headline could name)`)

const results = new Map() // id → items
const raw = new Map() // id → how many stories the feed returned before filtering
const failures = new Map() // id → message
let cursor = 0
let stopped = false

async function worker() {
  while (!stopped && cursor < queue.length) {
    const road = queue[cursor++]
    const m = matchers.get(road.id)
    try {
      const fetched = []
      for (const [i, q] of m.queries.entries()) {
        const viaNewsQuery = i === 0 && !!road.newsQuery
        for (const item of await fetchFeed(q)) fetched.push({ item, viaNewsQuery })
      }
      raw.set(road.id, fetched.length)
      results.set(road.id, select(road, fetched))
    } catch (e) {
      // out of time or patience: this road is simply not reached
      if (e instanceof GiveUp) {
        stopped = true
        break
      }
      failures.set(road.id, e.message)
      log(`  ! ${road.id}: ${e.message}`)
    }
    const done = results.size + failures.size
    if (done % 250 === 0) log(`  ${done}/${queue.length} · ${((Date.now() - startedAt) / 60_000).toFixed(1)} min · gap ${pace.gap} ms`)
  }
}
await Promise.all(Array.from({ length: WORKERS }, worker))

const notReached = queue.filter((r) => !results.has(r.id) && !failures.has(r.id)).map((r) => r.id)
const complete = notReached.length === 0

// ── is this run sane? ───────────────────────────────────────────────

const attempted = results.size + failures.size
const hasNews = [...results.values()].filter((items) => items.length).length
const hadNews = [...results.keys()].filter(had).length
const stillHas = [...results.keys()].filter((id) => had(id) && results.get(id).length).length
// hand-written roads are the best-known ones; their feeds are never all empty
const hand = [...results.keys()].filter((id) => byId.get(id).provenance !== 'osm')
const emptyHand = hand.filter((id) => raw.get(id) === 0).length
const minutes = ((Date.now() - startedAt) / 60_000).toFixed(1)
log(
  `news: ${results.size} checked, ${failures.size} failed, ${notReached.length} not reached · ` +
    `${hasNews} with headlines · ${minutes} min, ${pace.pushbacks} pushbacks`,
)

const problems = []
if (attempted && failures.size / attempted > 0.1) problems.push(`${failures.size} of ${attempted} roads failed`)
if (hand.length >= 20 && emptyHand / hand.length > 0.5)
  problems.push(`Google returned nothing at all for ${emptyHand} of ${hand.length} hand-written roads`)
if (!RESET && hadNews >= 40 && stillHas < hadNews * 0.5)
  problems.push(`only ${stillHas} of ${hadNews} roads kept their headlines — pass --reset if the rules changed on purpose`)
if (problems.length) {
  console.error(`news: not writing anything — ${problems.join('; ')}`)
  process.exit(1)
}

if (DRY) {
  for (const [id, items] of results) {
    if (!ONLY && !items.length) continue
    log(`${id} (${raw.get(id)} fetched → ${items.length} kept)`)
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
  const status = {
    checked: finished,
    completed: complete ? finished : (previousStatus.completed ?? null),
    roads: roads.length,
    withNews,
    pending: notReached,
  }
  writeFileSync(STATUS_FILE, `${JSON.stringify(status, null, 2)}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Road news\n\n| | |\n|---|---|\n| Roads checked | ${results.size} of ${queue.length} |\n` +
        `| Failed | ${failures.size} |\n| Roads with headlines | ${withNews} |\n| Files changed | ${written} updated, ${removed} removed |\n` +
        `| Time | ${minutes} min, ${pace.pushbacks} pushbacks from Google |\n`,
    )
  }
}
log(`news: ${written} files updated, ${removed} removed${complete ? '' : ` · ${notReached.length} roads left for the next run`}`)

if (!complete) {
  const lastComplete = Date.parse(previousStatus.completed ?? '')
  if (!ONLY && !(lastComplete > Date.now() - 72 * 3600_000)) {
    console.error('news: no run has reached every road in three days — Google is throttling this job')
    process.exit(4)
  }
  process.exit(3)
}
