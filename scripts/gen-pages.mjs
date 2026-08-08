#!/usr/bin/env node
/**
 * Post-build SEO step. For every road, stamps a static page at
 * dist/road/<id>/index.html with its own title/description/OG/JSON-LD,
 * then writes sitemap.xml and a 404.html SPA fallback.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST = join(ROOT, 'dist')
const SITE = 'https://roadtrackerindia.com'

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/index.html missing — run vite build first')
  process.exit(1)
}

const template = readFileSync(join(DIST, 'index.html'), 'utf8')
const index = JSON.parse(readFileSync(join(DIST, 'data', 'index.json'), 'utf8'))

const CATEGORY_LABEL = {
  nh: 'National Highway',
  expressway: 'Expressway',
  sh: 'State Highway',
  district: 'district road',
  local: 'city road',
}

/**
 * Which roads get a prerendered page. Every road stays reachable through the
 * SPA fallback; stamping a 7 KB shell for all 8,000 of them would bloat the
 * deploy with thin pages, so this covers the roads people actually search for.
 */
const worthPrerendering = (road) =>
  road.category === 'nh' ||
  road.category === 'expressway' ||
  road.lengthKm >= 100 ||
  detailOf(road.id)?.history !== undefined

const detailCache = new Map()
function detailOf(id) {
  if (detailCache.has(id)) return detailCache.get(id)
  let detail = null
  try {
    detail = JSON.parse(readFileSync(join(DIST, 'data', 'roads', `${id}.json`), 'utf8'))
  } catch {
    /* summary-only */
  }
  detailCache.set(id, detail)
  return detail
}

const escAttr = (s) =>
  String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

function roadHtml(road) {
  const startShort = road.start.split(',')[0]
  const endShort = road.end.split(',')[0]
  const title = `${road.ref} — ${startShort} to ${endShort} | RoadTracker India`
  const history = detailOf(road.id)?.history ? ` ${detailOf(road.id).history}` : ''
  const desc = (
    `${road.ref} (${road.name}) is a ${Math.round(road.lengthKm).toLocaleString('en-IN')} km ` +
    `${CATEGORY_LABEL[road.category]} from ${road.start} to ${road.end}.${history}`
  ).slice(0, 300)
  const url = `${SITE}/road/${road.id}/` // trailing slash matches the emitted directory — no 301 hop

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Place',
        name: `${road.ref} — ${road.name}`,
        description: desc,
        url,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'RoadTracker India', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: road.ref, item: url },
        ],
      },
    ],
  }

  return template
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escAttr(title)}</title>`)
    .replace(/(<meta\s+name="description"\s+content=")[\s\S]*?("\s*\/?>)/, `$1${escAttr(desc)}$2`)
    .replace(/(<link\s+rel="canonical"\s+href=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<meta\s+property="og:title"\s+content=")[^"]*(")/, `$1${escAttr(title)}$2`)
    .replace(/(<meta\s+property="og:description"\s+content=")[\s\S]*?("\s*\/?>)/, `$1${escAttr(desc)}$2`)
    .replace(/(<meta\s+property="og:url"\s+content=")[^"]*(")/, `$1${url}$2`)
    .replace(
      '</head>',
      `<script type="application/ld+json">${JSON.stringify(jsonLd).replaceAll('<', '\\u003c')}</script></head>`,
    )
}

/**
 * Company pages. "Who built the Yamuna Expressway" is a real search, and the
 * answer lives on an organisation's page, so every profile gets stamped —
 * there are only a few dozen of them.
 */
function orgHtml(org) {
  const stats = org.stats
  const title = `${org.shortName ?? org.name} — roads built and managed | RoadTracker India`
  const scale = stats.roadCount
    ? ` ${stats.roadCount} road${stats.roadCount === 1 ? '' : 's'} on RoadTracker, ${stats.lengthKm.toLocaleString('en-IN')} km in total.`
    : ''
  const desc = `${org.name}: ${org.summary}${scale}`.slice(0, 300)
  const url = `${SITE}/company/${org.id}/`

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        name: org.name,
        ...(org.shortName ? { alternateName: org.shortName } : {}),
        description: org.summary,
        ...(org.website ? { sameAs: [org.website] } : {}),
        url,
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'RoadTracker India', item: `${SITE}/` },
          { '@type': 'ListItem', position: 2, name: org.shortName ?? org.name, item: url },
        ],
      },
    ],
  }

  return template
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escAttr(title)}</title>`)
    .replace(/(<meta\s+name="description"\s+content=")[\s\S]*?("\s*\/?>)/, `$1${escAttr(desc)}$2`)
    .replace(/(<link\s+rel="canonical"\s+href=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<meta\s+property="og:title"\s+content=")[^"]*(")/, `$1${escAttr(title)}$2`)
    .replace(/(<meta\s+property="og:description"\s+content=")[\s\S]*?("\s*\/?>)/, `$1${escAttr(desc)}$2`)
    .replace(/(<meta\s+property="og:url"\s+content=")[^"]*(")/, `$1${url}$2`)
    .replace(
      '</head>',
      `<script type="application/ld+json">${JSON.stringify(jsonLd).replaceAll('<', '\\u003c')}</script></head>`,
    )
}

const prerendered = index.roads.filter(worthPrerendering)
let pages = 0
for (const road of prerendered) {
  const dir = join(DIST, 'road', road.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), roadHtml(road))
  pages++
}

let orgs = []
try {
  orgs = JSON.parse(readFileSync(join(DIST, 'data', 'orgs.json'), 'utf8')).orgs
} catch {
  /* no organisations on file yet */
}
for (const org of orgs) {
  const dir = join(DIST, 'company', org.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), orgHtml(org))
}

const today = new Date().toISOString().slice(0, 10)
const urls = [
  `${SITE}/`,
  ...prerendered.map((r) => `${SITE}/road/${r.id}/`),
  ...orgs.map((o) => `${SITE}/company/${o.id}/`),
]
const sitemap =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map((u) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod></url>`).join('\n') +
  `\n</urlset>\n`
writeFileSync(join(DIST, 'sitemap.xml'), sitemap)

copyFileSync(join(DIST, 'index.html'), join(DIST, '404.html'))

// Only the roads worth their own page get one stamped; the rest are reachable
// but would otherwise be served by 404.html with an HTTP 404 status, which
// turns a perfectly good shared link into a dead one. Static files still win
// over these rules, so the prerendered pages keep their own meta tags.
// Cloudflare Pages and Netlify both read _redirects; 404.html stays as the
// fallback for hosts that read neither.
writeFileSync(
  join(DIST, '_redirects'),
  ['/road/* /index.html 200', '/company/* /index.html 200', ''].join('\n'),
)

console.log(
  `✓ ${pages} road pages of ${index.roads.length} roads, ${orgs.length} company pages, ` +
    `sitemap.xml (${urls.length} urls), 404.html`,
)
