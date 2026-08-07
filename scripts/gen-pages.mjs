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
  local: 'city road',
}

const escAttr = (s) =>
  String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

function roadHtml(road) {
  const startShort = road.start.split(',')[0]
  const endShort = road.end.split(',')[0]
  const title = `${road.ref} — ${startShort} to ${endShort} | RoadTracker India`
  let history = ''
  try {
    const detail = JSON.parse(readFileSync(join(DIST, 'data', 'roads', `${road.id}.json`), 'utf8'))
    history = detail.history ? ` ${detail.history}` : ''
  } catch {
    /* summary-only description */
  }
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

let pages = 0
for (const road of index.roads) {
  const dir = join(DIST, 'road', road.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), roadHtml(road))
  pages++
}

const today = new Date().toISOString().slice(0, 10)
const urls = [`${SITE}/`, ...index.roads.map((r) => `${SITE}/road/${r.id}/`)]
const sitemap =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls.map((u) => `  <url><loc>${u}</loc><lastmod>${today}</lastmod></url>`).join('\n') +
  `\n</urlset>\n`
writeFileSync(join(DIST, 'sitemap.xml'), sitemap)

copyFileSync(join(DIST, 'index.html'), join(DIST, '404.html'))

console.log(`✓ ${pages} road pages, sitemap.xml (${urls.length} urls), 404.html`)
