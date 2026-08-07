#!/usr/bin/env node
/**
 * Build-time news snapshot. For each road, queries the free Google News RSS
 * feed and caches the latest headlines into public/data/news/<id>.json,
 * sorted newest first. Runs as part of `npm run build`, so every deploy
 * refreshes the news. Never fails the build: on any error the previous
 * snapshot (or nothing) is kept.
 *
 *   node scripts/fetch-news.mjs            # refresh stale (>20h) snapshots
 *   node scripts/fetch-news.mjs --force    # refresh everything
 *   node scripts/fetch-news.mjs --only nh-44,yamuna-expressway
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ROADS_DIR = join(ROOT, 'public', 'data', 'roads')
const NEWS_DIR = join(ROOT, 'public', 'data', 'news')
mkdirSync(NEWS_DIR, { recursive: true })

const FORCE = process.argv.includes('--force')
const ALL = process.argv.includes('--all')
const onlyArg = process.argv.find((a) => a.startsWith('--only'))
const ONLY = onlyArg
  ? (onlyArg.includes('=') ? onlyArg.split('=')[1] : process.argv[process.argv.indexOf(onlyArg) + 1])
      .split(',')
      .map((s) => s.trim())
  : null

const MAX_ITEMS = 8
const FRESH_MS = 20 * 60 * 60 * 1000 // refetch snapshots older than 20 hours

const unescape = (s) =>
  s
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))

const stripCdata = (s) => s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))
  return m ? unescape(stripCdata(m[1].trim())) : ''
}

function parseRss(xml) {
  const items = []
  for (const block of xml.split('<item>').slice(1)) {
    const title = tag(block, 'title')
    const link = tag(block, 'link')
    const pubDate = tag(block, 'pubDate')
    const source = tag(block, 'source')
    if (!title || !link) continue
    const ts = Date.parse(pubDate)
    items.push({
      // Google appends " - Source" to titles; the <source> tag has it cleanly
      title: source && title.endsWith(` - ${source}`) ? title.slice(0, -(source.length + 3)) : title,
      url: link,
      source: source || '',
      date: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
    })
  }
  items.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  return items.slice(0, MAX_ITEMS)
}

function defaultQuery(road) {
  // refs like "NH 44" are ambiguous worldwide — anchor them to India roads
  if (/^(NH|SH|NE)\s/i.test(road.ref)) return `"${road.ref}" India highway`
  return `"${road.ref}" India`
}

async function fetchNews(query) {
  const url =
    'https://news.google.com/rss/search?q=' +
    encodeURIComponent(query) +
    '&hl=en-IN&gl=IN&ceid=IN:en'
  const res = await fetch(url, {
    headers: { 'User-Agent': 'RoadTrackerIndia-news-build/1.0 (https://roadtrackerindia.com)' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return parseRss(await res.text())
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Which roads are worth a news query. A search for "SH 12 India highway"
 * returns noise, and 8,000 RSS calls would take an hour and get rate-limited —
 * so the automatic pass covers hand-written roads and the major national
 * routes. `--all` overrides.
 */
function worthFetching(road) {
  if (ALL || road.newsQuery) return true
  if (road.provenance !== 'osm') return true
  return (road.category === 'nh' || road.category === 'expressway') && road.lengthKm >= 200
}

const allRoads = readdirSync(ROADS_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(ROADS_DIR, f), 'utf8')))
  .filter((r) => (ONLY ? ONLY.includes(r.id) : true))
const roads = ONLY ? allRoads : allRoads.filter(worthFetching)
if (allRoads.length !== roads.length) {
  console.log(`news: ${roads.length} of ${allRoads.length} roads are in scope (pass --all for every road)`)
}

let ok = 0
let fresh = 0
let failed = 0

for (const road of roads) {
  const out = join(NEWS_DIR, `${road.id}.json`)
  if (!FORCE && existsSync(out)) {
    try {
      const prev = JSON.parse(readFileSync(out, 'utf8'))
      if (Date.now() - Date.parse(prev.generated) < FRESH_MS) {
        fresh++
        continue
      }
    } catch {
      /* refetch */
    }
  }
  const query = road.newsQuery ?? defaultQuery(road)
  try {
    const items = await fetchNews(query)
    writeFileSync(
      out,
      JSON.stringify({ generated: new Date().toISOString(), query, items }),
    )
    ok++
  } catch (e) {
    failed++
    console.log(`  ! ${road.id}: ${e.message} (keeping previous snapshot if any)`)
  }
  await sleep(350)
}

console.log(`✓ news: ${ok} refreshed, ${fresh} still fresh, ${failed} failed (soft)`)
process.exit(0) // news is best-effort — never break the build
