#!/usr/bin/env node
/**
 * Post-build SEO step. Stamps a real, readable page for every road, every
 * organisation, every state and the road directory, then a sitemap index over
 * the lot.
 *
 * Two things make this more than a meta-tag pass:
 *
 * 1. The prerendered copy goes *into the panel* — the same element the app
 *    fills once it boots. A crawler (and anyone on a slow phone, and anyone
 *    with JavaScript off) gets the road's story without waiting for MapLibre
 *    and three JSON fetches, and `showLoading()` overwrites it a moment later
 *    with no flash, because the panel is already open and already in place.
 *
 * 2. Those sections carry real <a href> links — to connected roads, to the
 *    states a road crosses, to the organisation behind it. A map app otherwise
 *    has no links at all: every "navigation" is a click handler, so a crawler
 *    that lands on one page can never reach a second one. The junction graph
 *    (`relatedRoads`, derived for 7,600 roads) is what turns the catalogue into
 *    something crawlable.
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST = join(ROOT, 'dist')
const SITE = 'https://roadtrackerindia.com'
const OG_IMAGE = `${SITE}/og.png`
/** Google rejects a sitemap over 50,000 URLs; stay well under it. */
const SITEMAP_CHUNK = 10000

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/index.html missing — run vite build first')
  process.exit(1)
}

const template = readFileSync(join(DIST, 'index.html'), 'utf8')
const index = JSON.parse(readFileSync(join(DIST, 'data', 'index.json'), 'utf8'))
const byId = new Map(index.roads.map((r) => [r.id, r]))

const CATEGORY_LABEL = {
  nh: 'National Highway',
  expressway: 'Expressway',
  sh: 'State Highway',
  district: 'District road',
  local: 'City road',
}
const CATEGORY_PLURAL = {
  nh: 'National Highways',
  expressway: 'Expressways',
  sh: 'State Highways',
  district: 'District roads',
  local: 'City roads',
}
const STATUS_LABEL = { operational: 'Open', 'under-construction': 'Being built', planned: 'Planned' }

/**
 * `lastmod` has to be the truth or it is worse than nothing — a build date
 * stamped on 7,757 URLs tells a crawler every page changed today, every deploy,
 * and the whole signal gets discounted. One `git log` pass gives the real date
 * each road file last changed.
 */
function gitLastModified() {
  const when = new Map()
  try {
    const log = execSync('git log --name-only --pretty=format:%x00%cI', {
      cwd: ROOT,
      maxBuffer: 1 << 28,
    }).toString()
    for (const record of log.split('\0')) {
      const lines = record.split('\n').filter(Boolean)
      if (!lines.length) continue
      const date = lines[0].slice(0, 10)
      for (const file of lines.slice(1)) if (!when.has(file)) when.set(file, date)
    }
  } catch {
    /* shallow clone or no git — fall back to the build date below */
  }
  return when
}
const gitDates = gitLastModified()
const TODAY = new Date().toISOString().slice(0, 10)
const roadLastmod = (id) => gitDates.get(`public/data/roads/${id}.json`) ?? TODAY
const orgLastmod = (id) => gitDates.get(`data/orgs/${id}.json`) ?? TODAY

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

// ── text helpers ───────────────────────────────────────────────────

const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const slug = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

const formatKm = (km) =>
  km < 1
    ? `${Math.round(km * 1000)} m`
    : km < 20
      ? `${km.toFixed(1)} km`
      : `${Math.round(km).toLocaleString('en-IN')} km`

/** Meta descriptions are cut at ~160 chars in results; never mid-word. */
function clamp(text, max) {
  const s = String(text).replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:.\s]+$/, '') + '…'
}

const list = (items) =>
  items.length <= 1
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

// ── the shell ──────────────────────────────────────────────────────

/**
 * Rewrites the built index.html into one page. The panel starts open and
 * carries the content, so the page reads as a finished document before a byte
 * of JavaScript runs; `is-static` is the flag the app strips when it takes the
 * panel over (without it the mobile sheet sits at translateY(100%), off-screen).
 */
/**
 * The share card and locale, added to a page that has neither.
 *
 * It strips before it inserts because this script writes the home page back
 * over `dist/index.html`, which is also the template every other page is cut
 * from: run it twice without an intervening `vite build` and a blind insert
 * gives every page two of each tag.
 */
function withSocialMeta(html) {
  const meta = [
    `<meta property="og:image" content="${OG_IMAGE}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="RoadTracker India — the living atlas of Indian roads" />`,
    `<meta name="twitter:image" content="${OG_IMAGE}" />`,
    `<meta property="og:locale" content="en_IN" />`,
  ].join('\n    ')
  return html
    .replace(/[ \t]*<meta\s+(?:property="og:(?:image[^"]*|locale)"|name="twitter:image")[^>]*>\n?/g, '')
    .replace(/(<meta\s+name="twitter:card"\s+content=")[^"]*(")/, `$1summary_large_image$2`)
    .replace('<meta name="twitter:card"', `${meta}\n    <meta name="twitter:card"`)
}

function shell({ title, description, url, h1, body, jsonLd, panelLabel = 'Road details' }) {
  return withSocialMeta(template)
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/(<meta\s+name="description"\s+content=")[\s\S]*?("\s*\/?>)/, `$1${esc(description)}$2`)
    .replace(/(<link\s+rel="canonical"\s+href=")[^"]*(")/, `$1${url}$2`)
    .replace(/(<meta\s+property="og:title"\s+content=")[^"]*(")/, `$1${esc(title)}$2`)
    .replace(
      /(<meta\s+property="og:description"\s+content=")[\s\S]*?("\s*\/?>)/,
      `$1${esc(description)}$2`,
    )
    .replace(/(<meta\s+property="og:url"\s+content=")[^"]*(")/, `$1${url}$2`)
    .replace(
      /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
      `<script type="application/ld+json">${JSON.stringify(jsonLd).replaceAll('<', '\\u003c')}</script>`,
    )
    .replace(/(<h1 class="visually-hidden" id="page-h1">)[\s\S]*?(<\/h1>)/, `$1${esc(h1)}$2`)
    .replace(
      '<aside id="panel" class="panel" aria-label="Road details" hidden>',
      `<aside id="panel" class="panel is-open is-static" aria-label="${esc(panelLabel)}">`,
    )
    .replace(
      '<div class="panel-scroll" id="panel-content"></div>',
      `<div class="panel-scroll" id="panel-content">${body}</div>`,
    )
}

/** The links every prerendered page ends with, so no page is a dead end. */
function footerNav(links) {
  return `<nav class="seo-nav" aria-label="More of RoadTracker India">
      ${links.map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join('')}
    </nav>`
}

const breadcrumb = (trail) => ({
  '@type': 'BreadcrumbList',
  itemListElement: trail.map(([name, item], i) => ({
    '@type': 'ListItem',
    position: i + 1,
    name,
    item,
  })),
})

// ── road pages ─────────────────────────────────────────────────────

/** A chip that links: same look as the app's button, but a crawler can follow it. */
function roadChip(road, label) {
  const badge = road.ref.length <= 9 ? road.ref : road.ref.split(/[\s–—]/)[0]
  return `<a class="rel-chip" href="/road/${road.id}/">
      <span class="sr-badge cat-${road.category}">${esc(badge)}</span>
      <span class="rc-main"><span class="rc-name">${esc(road.name)}</span>${
        label ? `<span class="rc-where">${esc(label)}</span>` : ''
      }</span></a>`
}

const section = (heading, inner) => (inner ? `<div class="rd-section"><h3>${heading}</h3>${inner}</div>` : '')
const para = (text) => `<p class="rd-history">${esc(text)}</p>`
const bullets = (items) =>
  `<ul class="rd-list">${items.map((x) => `<li>${x}</li>`).join('')}</ul>`

function roadBody(road, detail, orgById) {
  const d = detail ?? {}
  const route = d.route ?? { start: road.start, end: road.end, states: road.states, majorCities: road.cities }
  const loops = road.start === road.end
  const states = route.states ?? []
  const cities = route.majorCities ?? []

  const stateChip =
    states.length > 1
      ? `<span class="chip"><b>${states.length}</b>&nbsp;states</span>`
      : `<span class="chip">${esc(states[0] ?? '')}</span>`

  const where = loops
    ? `${esc(road.ref)} is a ${formatKm(road.lengthKm)} ${CATEGORY_LABEL[road.category].toLowerCase()} that loops right around ${esc(route.start)}.`
    : `${esc(road.ref)} runs ${formatKm(road.lengthKm)} from <b>${esc(route.start)}</b> to <b>${esc(route.end)}</b>.`

  const stateLinks = states.length
    ? `<p class="rd-history">Crosses ${list(states.map((s) => `<a href="/state/${slug(s)}/">${esc(s)}</a>`))}.</p>`
    : ''
  const cityLine = cities.length
    ? `<p class="rd-history">Through ${esc(list(cities))}.</p>`
    : ''

  const related = (d.relatedRoads ?? []).map((r) => [byId.get(r.id), r.label]).filter(([r]) => r)
  const relatedHtml = related.length
    ? `<div class="rel-chips">${related.map(([r, label]) => roadChip(r, label)).join('')}</div>`
    : ''

  // Who is behind it. "Who built the Yamuna Expressway" is a search in its own
  // right, and the linked answer is also what carries a crawler from a road to
  // an organisation and back out across every other road it touched.
  const orgRow = (label, refs) => {
    const chips = (refs ?? [])
      .map((ref) => {
        const org = ref.org ? orgById.get(ref.org) : null
        const note = ref.note ? `<span class="og-note">${esc(ref.note)}</span>` : ''
        const name = org ? (org.shortName ?? org.name) : (ref.name ?? '')
        if (!name) return ''
        return org
          ? `<a class="og-chip" href="/company/${org.id}/" title="${esc(org.name)}"><span class="og-name">${esc(name)}</span>${note}</a>`
          : `<span class="og-chip is-plain">${esc(name)}${note}</span>`
      })
      .filter(Boolean)
      .join('')
    return chips
      ? `<div class="og-row"><span class="og-label">${label}</span><div class="og-chips">${chips}</div></div>`
      : ''
  }
  // the free text is the fallback for the thousands of OpenStreetMap roads that
  // have no organisation on file — the linked chip says it better
  const behind =
    orgRow('Looked after by', d.authority ? [{ org: d.authority }] : d.agency ? [{ name: d.agency }] : []) +
    orgRow('Built by', d.builtBy?.length ? d.builtBy : d.contractor ? [{ name: d.contractor }] : []) +
    orgRow('Operated by', d.operatedBy)

  const kv = []
  if (d.lanes) kv.push(`<dt>Lanes</dt><dd>${esc(d.lanes)}</dd>`)
  if (d.cost) kv.push(`<dt>Project cost</dt><dd>${esc(d.cost)}</dd>`)

  const sources = (d.sources ?? []).length
    ? `<div class="rd-sources">${d.sources
        .map((s) => `<a href="${esc(s.url)}" rel="nofollow noopener" target="_blank">${esc(s.title)}</a>`)
        .join('')}</div>`
    : ''

  const primaryState = states[0]
  return `
    <div class="rd-head">
      <span class="rd-ref cat-${esc(road.category)}">${esc(road.ref)}</span>
      <h2 class="rd-name">${esc(road.name)}</h2>
    </div>
    ${road.aka?.length ? `<p class="rd-aka">Also known as ${esc(list(road.aka))}</p>` : ''}
    <div class="rd-chips">
      <span class="chip"><b>${formatKm(road.lengthKm)}</b></span>
      <span class="chip status-pill st-${esc(road.status)}">${STATUS_LABEL[road.status] ?? road.status}${
        road.status === 'under-construction' && road.completionPercent !== undefined
          ? ` · ${road.completionPercent}%`
          : ''
      }</span>
      ${stateChip}
      <span class="chip">${CATEGORY_LABEL[road.category]}</span>
    </div>
    ${section('Route', `<p class="rd-history">${where}</p>${stateLinks}${cityLine}`)}
    ${section('Why it matters', d.significance ? para(d.significance) : '')}
    ${section('History', d.history ? para(d.history) : '')}
    ${section('Good to know', d.facts?.length ? bullets(d.facts.map(esc)) : '')}
    ${section(
      'Timeline',
      d.timeline?.length
        ? `<ol class="rd-timeline">${d.timeline
            .map((t) => `<li><span class="tl-year">${esc(t.year)}</span><span>${esc(t.event)}</span></li>`)
            .join('')}</ol>`
        : '',
    )}
    ${section(
      'Key junctions',
      d.interchanges?.length
        ? bullets(
            d.interchanges.map(
              (x) => `<b>${esc(x.name)}</b>${x.note ? ` <span style="color:var(--ink-2)">— ${esc(x.note)}</span>` : ''}`,
            ),
          )
        : '',
    )}
    ${section(
      'Engineering highlights',
      d.engineering?.length
        ? bullets(
            d.engineering.map(
              (x) => `<b>${esc(x.name)}</b>${x.note ? ` <span style="color:var(--ink-2)">— ${esc(x.note)}</span>` : ''}`,
            ),
          )
        : '',
    )}
    ${section('On the road', d.travelNotes ? para(d.travelNotes) : '')}
    ${section('What&rsquo;s coming next', d.futureUpgrades?.length ? bullets(d.futureUpgrades.map(esc)) : '')}
    ${kv.length ? section('More details', `<dl class="kv">${kv.join('')}</dl>`) : ''}
    ${section('Behind this road', behind)}
    ${section('Connected roads', relatedHtml)}
    ${section('Sources', sources)}
    ${footerNav(
      [
        primaryState ? [`/state/${slug(primaryState)}/`, `All roads in ${primaryState}`] : null,
        ['/roads/', 'Every road in the catalogue'],
        ['/', 'RoadTracker India map'],
      ].filter(Boolean),
    )}`
}

/** "Sohna (Gurugram district), Haryana" is a terminus; "Sohna" is a title. */
const shortPlace = (s) => s.split(',')[0].replace(/\s*\([^)]*\)/g, '').trim()

function roadPage(road, orgById, canonicalId = road.id) {
  const startShort = shortPlace(road.start)
  const endShort = shortPlace(road.end)
  const loops = road.start === road.end
  const detail = detailOf(road.id)
  // A result only shows the first ~60 characters. The site name is the first
  // thing to go when a road's termini are long — Google appends it from the
  // WebSite schema anyway, and the road is what someone searched for.
  const core = clamp(
    loops ? `${road.ref} — around ${startShort}` : `${road.ref} — ${startShort} to ${endShort}`,
    64,
  )
  const suffix = ' | RoadTracker India'
  const title = core.length + suffix.length <= 62 ? core + suffix : core
  // "Delhi–Mumbai Expressway — Delhi–Mumbai Expressway" is not a heading
  const fullName = road.ref === road.name ? road.name : `${road.ref} — ${road.name}`

  const base =
    `${road.ref === road.name ? road.ref : `${road.ref} (${road.name})`} is a ` +
    `${formatKm(road.lengthKm)} ${CATEGORY_LABEL[road.category]} ` +
    (loops ? `right around ${road.start}` : `from ${road.start} to ${road.end}`) +
    '.'
  const description = clamp(`${base} ${detail?.significance ?? detail?.history ?? 'Route map, status, toll charges, emergency numbers and facts.'}`, 300)
  const url = `${SITE}/road/${canonicalId}/` // trailing slash matches the emitted directory — no 301 hop

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Road',
        '@id': `${url}#road`,
        name: fullName,
        alternateName: road.aka ?? undefined,
        description: clamp(base, 300),
        url,
        ...(road.bbox
          ? {
              geo: {
                '@type': 'GeoShape',
                box: `${road.bbox[1]} ${road.bbox[0]} ${road.bbox[3]} ${road.bbox[2]}`,
              },
            }
          : {}),
        containedInPlace: road.states.map((s) => ({
          '@type': 'AdministrativeArea',
          name: s,
          url: `${SITE}/state/${slug(s)}/`,
        })),
      },
      breadcrumb([
        ['RoadTracker India', `${SITE}/`],
        ['Roads', `${SITE}/roads/`],
        [road.ref, url],
      ]),
    ],
  }

  return shell({
    title,
    description,
    url,
    h1: fullName,
    body: roadBody(road, detail, orgById),
    jsonLd,
  })
}

// ── organisation pages ─────────────────────────────────────────────

function orgPage(org) {
  const stats = org.stats ?? { roadCount: 0, lengthKm: 0 }
  const name = org.shortName ?? org.name
  const title = `${name} — roads built and managed | RoadTracker India`
  const scale = stats.roadCount
    ? ` ${stats.roadCount} road${stats.roadCount === 1 ? '' : 's'} on RoadTracker, ${stats.lengthKm.toLocaleString('en-IN')} km in total.`
    : ''
  const description = clamp(`${org.name}: ${org.summary}${scale}`, 300)
  const url = `${SITE}/company/${org.id}/`

  let profile = null
  try {
    profile = JSON.parse(readFileSync(join(DIST, 'data', 'org', `${org.id}.json`), 'utf8'))
  } catch {
    /* index-only */
  }
  const roads = (profile?.roads ?? []).map((r) => byId.get(r.id)).filter(Boolean)

  const body = `
    <div class="rd-head">
      <h2 class="rd-name">${esc(org.name)}</h2>
    </div>
    ${org.shortName ? `<p class="rd-aka">Also known as ${esc(org.shortName)}</p>` : ''}
    <div class="rd-chips">
      ${stats.roadCount ? `<span class="chip"><b>${stats.roadCount}</b>&nbsp;roads</span>` : ''}
      ${stats.lengthKm ? `<span class="chip"><b>${stats.lengthKm.toLocaleString('en-IN')}</b>&nbsp;km</span>` : ''}
    </div>
    ${section('About', para(org.summary))}
    ${
      profile?.website
        ? section(
            'Official site',
            `<div class="rd-sources"><a href="${esc(profile.website)}" rel="nofollow noopener" target="_blank">${esc(profile.website)}</a></div>`,
          )
        : ''
    }
    ${section(
      `Roads on RoadTracker`,
      roads.length ? `<div class="rel-chips">${roads.map((r) => roadChip(r, null)).join('')}</div>` : '',
    )}
    ${footerNav([
      ['/company/', 'Every road authority and builder'],
      ['/roads/', 'Every road in the catalogue'],
      ['/', 'RoadTracker India map'],
    ])}`

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${url}#org`,
        name: org.name,
        ...(org.shortName ? { alternateName: org.shortName } : {}),
        description: org.summary,
        ...(profile?.website ? { sameAs: [profile.website] } : {}),
        url,
      },
      breadcrumb([
        ['RoadTracker India', `${SITE}/`],
        ['Road authorities', `${SITE}/company/`],
        [name, url],
      ]),
    ],
  }

  return shell({ title, description, url, h1: `${org.name} — roads built and managed`, body, jsonLd, panelLabel: 'Organisation details' })
}

// ── directory pages ────────────────────────────────────────────────

/**
 * The directories are plain documents, not the app. A list of roads has nothing
 * to draw on a map, so making the reader download MapLibre and the whole road
 * network to read one is a poor trade — these load instantly, share the site's
 * stylesheet, and hand off to the map on any link. It also keeps them entirely
 * clear of the app's router, which knows about roads and organisations only.
 */
const STYLESHEET = template.match(/<link rel="stylesheet"[^>]*href="([^"]+)"/)?.[1] ?? '/assets/style.css'

function hubShell({ title, description, url, h1, body, jsonLd }) {
  return `<!doctype html>
<html lang="en" data-theme="light">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}" />
    <link rel="canonical" href="${url}" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <meta name="theme-color" content="#f4f1ea" id="meta-theme-color" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="RoadTracker India" />
    <meta property="og:title" content="${esc(title)}" />
    <meta property="og:description" content="${esc(description)}" />
    <meta property="og:url" content="${url}" />
    <meta property="og:locale" content="en_IN" />
    <meta property="og:image" content="${OG_IMAGE}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:image" content="${OG_IMAGE}" />
    <link rel="stylesheet" href="${STYLESHEET}" />
    <script type="application/ld+json">${JSON.stringify(jsonLd).replaceAll('<', '\\u003c')}</script>
    <script>
      // the map app's own choice, honoured before first paint so the page never
      // flashes light at someone who picked dark
      try {
        var t = localStorage.getItem('rti-theme')
        document.documentElement.dataset.theme =
          t || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      } catch (e) {}
    </script>
  </head>
  <body class="hub-body">
    <div class="hub">
      <a class="hub-brand" href="/">
        <svg class="brand-mark" viewBox="0 0 28 28" aria-hidden="true">
          <rect x="1.5" y="1.5" width="25" height="25" rx="7" class="bm-bg" />
          <path d="M9 24 C11 16, 13 12, 19 4" class="bm-road" />
          <path d="M9 24 C11 16, 13 12, 19 4" class="bm-dash" />
        </svg>
        <span class="brand-name">RoadTracker&nbsp;<em>India</em></span>
      </a>
      <h1 class="hub-title">${esc(h1)}</h1>
      ${body}
    </div>
  </body>
</html>
`
}

const hubSection = (heading, count, inner) =>
  inner
    ? `<section class="hub-section">
        <h2>${heading}${count === undefined ? '' : ` <span class="hub-count">${count.toLocaleString('en-IN')}</span>`}</h2>
        ${inner}
      </section>`
    : ''

/** A road as a card in a directory grid. */
function hubCard(road) {
  const badge = road.ref.length <= 11 ? road.ref : road.ref.split(/[\s–—]/)[0]
  const where = road.start === road.end ? `around ${road.start.split(',')[0]}` : `${road.start.split(',')[0]} → ${road.end.split(',')[0]}`
  return `<a class="hub-card" href="/road/${road.id}/">
      <span class="sr-badge cat-${road.category}">${esc(badge)}</span>
      <span class="hub-card-main">
        <span class="hub-card-name">${esc(road.name)}</span>
        <span class="hub-card-sub">${esc(where)} · ${formatKm(road.lengthKm)}</span>
      </span>
    </a>`
}

/**
 * Roads grouped by category, longest first — the order people search in.
 *
 * `plain` is what keeps these pages a sane weight. Tamil Nadu alone has 2,354
 * roads, and a card apiece put its page at 756 KB; the 5,000 district roads
 * still need a crawlable link each, but a name is all any of them can usefully
 * show, so below `sh` they collapse to a bare list.
 */
function categoryGroups(roads, headingFor, { plain = [] } = {}) {
  const order = ['expressway', 'nh', 'sh', 'district', 'local']
  return order
    .filter((cat) => roads.some((r) => r.category === cat))
    .map((cat) => {
      const inCat = roads.filter((r) => r.category === cat).sort((a, b) => b.lengthKm - a.lengthKm)
      const inner = plain.includes(cat)
        ? `<div class="hub-plain">${inCat
            .map((r) => `<a href="/road/${r.id}/">${esc(r.name)}</a>`)
            .join('')}</div>`
        : `<div class="hub-grid">${inCat.map(hubCard).join('')}</div>`
      return hubSection(headingFor(cat), inCat.length, inner)
    })
    .join('')
}

const hubNav = (links) =>
  `<nav class="hub-nav" aria-label="More of RoadTracker India">
      ${links.map(([href, label]) => `<a href="${href}">${esc(label)}</a>`).join('')}
    </nav>`

function statePage(stateName, roads) {
  const url = `${SITE}/state/${slug(stateName)}/`
  const km = Math.round(roads.reduce((sum, r) => sum + r.lengthKm, 0))
  const nh = roads.filter((r) => r.category === 'nh').length
  const exp = roads.filter((r) => r.category === 'expressway').length
  const title = `Roads of ${stateName} — highways, expressways and state highways | RoadTracker India`
  const description = clamp(
    `Every road in ${stateName} on RoadTracker India: ${roads.length.toLocaleString('en-IN')} roads and ${km.toLocaleString('en-IN')} km, including ${nh} National Highway${nh === 1 ? '' : 's'} and ${exp} expressway${exp === 1 ? '' : 's'}. Routes, status, toll charges and history.`,
    300,
  )

  const body = `
    <p class="hub-lede">These are the ${roads.length.toLocaleString('en-IN')} roads RoadTracker has
      catalogued in ${esc(stateName)}, from National Highways down to district roads. Open any of them
      to see its route drawn on the map, with its status, toll charges, emergency numbers and history.</p>
    <div class="hub-stats">
      <span class="chip"><b>${roads.length.toLocaleString('en-IN')}</b>&nbsp;roads</span>
      <span class="chip"><b>${km.toLocaleString('en-IN')}</b>&nbsp;km</span>
      ${nh ? `<span class="chip"><b>${nh}</b>&nbsp;National Highways</span>` : ''}
      ${exp ? `<span class="chip"><b>${exp}</b>&nbsp;expressway${exp === 1 ? '' : 's'}</span>` : ''}
    </div>
    ${categoryGroups(roads, (cat) => `${CATEGORY_PLURAL[cat]} in ${esc(stateName)}`, {
      plain: ['district', 'local'],
    })}
    ${hubNav([
      ['/roads/', 'Every road in the catalogue'],
      ['/company/', 'Road authorities and builders'],
      ['/', 'RoadTracker India map'],
    ])}`

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        name: `Roads of ${stateName}`,
        description,
        url,
        about: { '@type': 'AdministrativeArea', name: stateName },
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: roads.length,
          itemListElement: roads.slice(0, 100).map((r, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: `${r.ref} — ${r.name}`,
            url: `${SITE}/road/${r.id}/`,
          })),
        },
      },
      breadcrumb([
        ['RoadTracker India', `${SITE}/`],
        ['Roads', `${SITE}/roads/`],
        [stateName, url],
      ]),
    ],
  }

  return hubShell({ title, description, url, h1: `Roads of ${stateName}`, body, jsonLd })
}

/**
 * The road directory. Every road links from here, so nothing in the catalogue
 * is more than two clicks from the home page — including for a crawler, which
 * has no other way through a map.
 */
function roadsIndexPage(roads, states) {
  const url = `${SITE}/roads/`
  const km = Math.round(roads.reduce((sum, r) => sum + r.lengthKm, 0))
  const title = `Every road in India — the full catalogue | RoadTracker India`
  const description = clamp(
    `All ${roads.length.toLocaleString('en-IN')} roads on RoadTracker India — ${km.toLocaleString('en-IN')} km of National Highways, expressways, state highways and district roads, each with its route, status, toll charges and history.`,
    300,
  )

  // Expressways and National Highways in full — they are what people come here
  // looking for, and 722 cards is a page that still loads on a phone. The
  // 7,000 state, district and city roads each get their link from their own
  // state's page, one hop away.
  const national = roads.filter((r) => r.category === 'expressway' || r.category === 'nh')
  const rest = roads.length - national.length
  const body = `
    <p class="hub-lede">Every road RoadTracker has on file — ${roads.length.toLocaleString('en-IN')} of them,
      ${km.toLocaleString('en-IN')} km in all. India&rsquo;s expressways and National Highways are listed
      in full below; the other ${rest.toLocaleString('en-IN')} state, district and city roads are on
      their state&rsquo;s page.</p>
    <div class="hub-stats">
      <span class="chip"><b>${roads.length.toLocaleString('en-IN')}</b>&nbsp;roads</span>
      <span class="chip"><b>${km.toLocaleString('en-IN')}</b>&nbsp;km</span>
      <span class="chip"><b>${states.length}</b>&nbsp;states</span>
    </div>
    ${hubSection(
      'By state and union territory',
      states.length,
      `<div class="hub-links">${states
        .map(
          ([name, inState]) =>
            `<a href="/state/${slug(name)}/">${esc(name)} <span class="hub-count">${inState.length.toLocaleString('en-IN')}</span></a>`,
        )
        .join('')}</div>`,
    )}
    ${categoryGroups(national, (cat) => `${CATEGORY_PLURAL[cat]} of India`)}
    ${hubNav([
      ['/company/', 'Road authorities and builders'],
      ['/', 'RoadTracker India map'],
    ])}`

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        name: 'Every road in India',
        description,
        url,
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: roads.length,
          itemListElement: states.map(([name], i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: `Roads of ${name}`,
            url: `${SITE}/state/${slug(name)}/`,
          })),
        },
      },
      breadcrumb([
        ['RoadTracker India', `${SITE}/`],
        ['Roads', url],
      ]),
    ],
  }

  return hubShell({ title, description, url, h1: 'Every road in India', body, jsonLd })
}

function orgsIndexPage(orgs) {
  const url = `${SITE}/company/`
  const title = `Road authorities and builders in India | RoadTracker India`
  const description = clamp(
    `The ${orgs.length} organisations behind India's roads — NHAI, the state highway departments, expressway authorities and the companies that built them. What each one looks after, and every road on its books.`,
    300,
  )
  const byType = new Map()
  for (const org of orgs) {
    const key = org.type ?? 'other'
    if (!byType.has(key)) byType.set(key, [])
    byType.get(key).push(org)
  }
  const TYPE_LABEL = {
    authority: 'Road authorities',
    government: 'Government departments',
    company: 'Companies',
    contractor: 'Contractors',
    other: 'Others',
  }

  const body = `
    <p class="hub-lede">India&rsquo;s roads are built and looked after by a patchwork of national
      authorities, state departments and private concessionaires. These are the ${orgs.length} on
      RoadTracker — each one&rsquo;s page maps every road it has touched.</p>
    <div class="hub-stats"><span class="chip"><b>${orgs.length}</b>&nbsp;organisations</span></div>
    ${[...byType]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([type, group]) =>
        hubSection(
          esc(TYPE_LABEL[type] ?? type),
          group.length,
          `<div class="hub-grid">${group
            .sort((a, b) => (b.stats?.roadCount ?? 0) - (a.stats?.roadCount ?? 0))
            .map(
              (o) =>
                `<a class="hub-card" href="/company/${o.id}/"><span class="hub-card-main"><span class="hub-card-name">${esc(o.shortName ?? o.name)}</span><span class="hub-card-sub">${esc(clamp(o.summary, 88))}</span></span></a>`,
            )
            .join('')}</div>`,
        ),
      )
      .join('')}
    ${hubNav([
      ['/roads/', 'Every road in the catalogue'],
      ['/', 'RoadTracker India map'],
    ])}`

  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        name: 'Road authorities and builders in India',
        description,
        url,
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: orgs.length,
          itemListElement: orgs.map((o, i) => ({
            '@type': 'ListItem',
            position: i + 1,
            name: o.name,
            url: `${SITE}/company/${o.id}/`,
          })),
        },
      },
      breadcrumb([
        ['RoadTracker India', `${SITE}/`],
        ['Road authorities', url],
      ]),
    ],
  }

  return hubShell({ title, description, url, h1: "Who builds and runs India's roads", body, jsonLd })
}

// ── home page ──────────────────────────────────────────────────────

/**
 * The home page keeps its map-first shell — no open panel, nothing injected
 * into the body. Its one outbound link ("Browse the full catalogue", in the
 * map key) is real UI in index.html rather than markup stamped in here: a link
 * a reader can see is worth more than one hidden behind a full-screen map, and
 * because it lives in the template every page inherits it.
 */
function homePage(roads) {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite',
        '@id': `${SITE}/#website`,
        name: 'RoadTracker India',
        url: `${SITE}/`,
        inLanguage: 'en-IN',
        description:
          'A map-first encyclopedia of Indian roads — National Highways, Expressways and State Highways.',
        potentialAction: {
          '@type': 'SearchAction',
          target: { '@type': 'EntryPoint', urlTemplate: `${SITE}/?q={search_term_string}` },
          'query-input': 'required name=search_term_string',
        },
      },
      {
        '@type': 'Dataset',
        '@id': `${SITE}/#dataset`,
        name: 'RoadTracker India road catalogue',
        description: `${roads.length.toLocaleString('en-IN')} Indian roads — National Highways, expressways, state highways and district roads — with routes, lengths, status, toll charges and history.`,
        url: `${SITE}/roads/`,
        license: 'https://opendatacommons.org/licenses/odbl/',
        isAccessibleForFree: true,
        spatialCoverage: { '@type': 'Country', name: 'India' },
        creator: { '@type': 'Organization', name: 'RoadTracker India', url: `${SITE}/` },
      },
    ],
  }

  return withSocialMeta(template).replace(
    /<script type="application\/ld\+json">[\s\S]*?<\/script>/,
    `<script type="application/ld+json">${JSON.stringify(jsonLd).replaceAll('<', '\\u003c')}</script>`,
  )
}

// ── write everything ───────────────────────────────────────────────

let orgIndex = []
try {
  orgIndex = JSON.parse(readFileSync(join(DIST, 'data', 'orgs.json'), 'utf8')).orgs
} catch {
  /* no organisations on file yet */
}
const orgById = new Map(orgIndex.map((o) => [o.id, o]))

const write = (parts, html) => {
  const dir = join(DIST, ...parts)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), html)
}

// states, from the roads that name them
const stateRoads = new Map()
for (const road of index.roads) {
  for (const s of road.states ?? []) {
    if (!stateRoads.has(s)) stateRoads.set(s, [])
    stateRoads.get(s).push(road)
  }
}
const states = [...stateRoads].sort((a, b) => a[0].localeCompare(b[0]))

for (const road of index.roads) write(['road', road.id], roadPage(road, orgById))

/**
 * Roads that were merged into another record keep their URL. The page shows the
 * surviving road and points its canonical tag at the survivor, so a search
 * engine folds the two together instead of indexing a dead link. The app
 * rewrites the address bar to the real one as soon as it boots.
 */
let merged = 0
for (const [from, to] of Object.entries(index.aliases ?? {})) {
  const road = byId.get(to)
  if (!road) continue
  write(['road', from], roadPage(road, orgById, to))
  merged++
}

for (const org of orgIndex) write(['company', org.id], orgPage(org))
if (orgIndex.length) write(['company'], orgsIndexPage(orgIndex))

for (const [name, roads] of states) write(['state', slug(name)], statePage(name, roads))
write(['roads'], roadsIndexPage(index.roads, states))
writeFileSync(join(DIST, 'index.html'), homePage(index.roads))

// ── sitemaps ───────────────────────────────────────────────────────

const xml = (urls) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  urls
    .map(
      ({ loc, lastmod, priority }) =>
        `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod>` +
        (priority ? `<priority>${priority}</priority>` : '') +
        `</url>`,
    )
    .join('\n') +
  `\n</urlset>\n`

const siteLastmod = gitDates.get('index.html') ?? TODAY

// Hubs first: they are the pages that carry the links to everything else.
const hubUrls = [
  { loc: `${SITE}/`, lastmod: siteLastmod, priority: '1.0' },
  { loc: `${SITE}/roads/`, lastmod: siteLastmod, priority: '0.9' },
  ...(orgIndex.length ? [{ loc: `${SITE}/company/`, lastmod: siteLastmod, priority: '0.8' }] : []),
  ...states.map(([name]) => ({
    loc: `${SITE}/state/${slug(name)}/`,
    lastmod: siteLastmod,
    priority: '0.8',
  })),
  ...orgIndex.map((o) => ({
    loc: `${SITE}/company/${o.id}/`,
    lastmod: orgLastmod(o.id),
    priority: '0.6',
  })),
]

/**
 * A road's priority is relative, and the trunk network is what people search
 * for — an expressway matters more than one of 5,000 district roads. Merged
 * ids are deliberately absent: their canonical points elsewhere, so listing
 * them would only ask Google to crawl a page it must then discard.
 */
const PRIORITY = { expressway: '0.9', nh: '0.8', sh: '0.6', district: '0.4', local: '0.4' }
const roadUrls = index.roads.map((r) => ({
  loc: `${SITE}/road/${r.id}/`,
  lastmod: roadLastmod(r.id),
  priority: PRIORITY[r.category] ?? '0.5',
}))

const files = []
writeFileSync(join(DIST, 'sitemap-pages.xml'), xml(hubUrls))
files.push('sitemap-pages.xml')
for (let i = 0; i < roadUrls.length; i += SITEMAP_CHUNK) {
  const name = `sitemap-roads-${Math.floor(i / SITEMAP_CHUNK) + 1}.xml`
  writeFileSync(join(DIST, name), xml(roadUrls.slice(i, i + SITEMAP_CHUNK)))
  files.push(name)
}

writeFileSync(
  join(DIST, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    files
      .map((f) => `  <sitemap><loc>${SITE}/${f}</loc><lastmod>${TODAY}</lastmod></sitemap>`)
      .join('\n') +
    `\n</sitemapindex>\n`,
)

copyFileSync(join(DIST, 'index.html'), join(DIST, '404.html'))

// A road we have no page for must still open rather than 404 — a shared link is
// worth more than a tidy status code. Static files win over these rules, so the
// stamped pages keep their own meta tags. Cloudflare Pages and Netlify read
// _redirects; 404.html covers hosts that read neither. Vercel uses vercel.json.
writeFileSync(
  join(DIST, '_redirects'),
  ['/road/* /index.html 200', '/company/* /index.html 200', '/state/* /index.html 200', ''].join('\n'),
)

const total = hubUrls.length + roadUrls.length
console.log(
  `✓ ${index.roads.length.toLocaleString('en-IN')} road pages, ${merged} merged-road aliases, ` +
    `${orgIndex.length} company pages, ${states.length} state pages, /roads/, /company/\n` +
    `✓ sitemap index over ${files.length} files, ${total.toLocaleString('en-IN')} URLs`,
)
