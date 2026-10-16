// node --test scripts/   — stamps pages for a throwaway site with its own git history
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./gen-pages.mjs', import.meta.url))
const roots = []
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

// git that ignores the machine's own config (signing, hooks) and whatever repo
// the tests happen to run inside
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key]
const git = (cwd, args, date) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: date ? { ...env, GIT_AUTHOR_DATE: `${date}T12:00:00Z`, GIT_COMMITTER_DATE: `${date}T12:00:00Z` } : env,
    stdio: 'pipe',
  }).toString()

const put = (root, path, body) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body))
}

// just the markers shell() rewrites, as vite emits them
const TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <title>RoadTracker India</title>
    <meta name="description" content="Every road in India." />
    <link rel="canonical" href="https://roadtrackerindia.com/" />
    <meta property="og:title" content="RoadTracker India" />
    <meta property="og:description" content="Every road in India." />
    <meta property="og:url" content="https://roadtrackerindia.com/" />
    <meta name="twitter:card" content="summary" />
    <script type="application/ld+json">{}</script>
    <link rel="stylesheet" crossorigin href="/assets/style.css">
  </head>
  <body>
    <h1 class="visually-hidden" id="page-h1">RoadTracker India</h1>
    <aside id="panel" class="panel" aria-label="Road details" hidden>
      <div class="panel-scroll" id="panel-content"></div>
    </aside>
  </body>
</html>
`

const LOAN = 'Funded by a US$2 billion loan — $1, $& and $\' are not patterns.'
const row = (id, name) => ({
  id, ref: name, name, category: 'nh', status: 'operational', lengthKm: 100,
  start: 'Alpha, Kerala', end: 'Beta, Kerala', states: ['Kerala'], cities: ['Alpha', 'Beta'], bbox: [76, 10, 76, 10.9],
})
const detail = (id, fields) => ({
  id, route: { start: 'Alpha, Kerala', end: 'Beta, Kerala', states: ['Kerala'], majorCities: ['Alpha', 'Beta'] },
  sources: [{ title: 'NHAI', url: 'https://nhai.gov.in/' }], ...fields,
})

/** What `vite build` and `npm run data` leave in dist/ — untracked, as in a real checkout. */
function stampDist(root) {
  put(root, 'dist/index.html', TEMPLATE)
  put(root, 'dist/data/index.json', { roads: [row('osm-road', 'NH 1'), row('hand-road', 'NH 2')], aliases: {} })
  put(root, 'dist/data/roads/osm-road.json', detail('osm-road', { provenance: 'osm', significance: LOAN }))
  put(root, 'dist/data/roads/hand-road.json', detail('hand-road', { history: 'Written up by hand.' }))
  put(root, 'dist/data/orgs.json', { orgs: [{ id: 'acme', name: 'Acme Infra', type: 'contractor', summary: 'Builds roads.', stats: { roadCount: 1, lengthKm: 100 } }] })
  put(root, 'dist/data/org/acme.json', { id: 'acme', name: 'Acme Infra', roads: [{ id: 'osm-road', roles: ['built'] }] })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  copyFileSync(SCRIPT, join(root, 'scripts', 'gen-pages.mjs'))
}

const genPages = (root) => {
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'gen-pages.mjs')], { encoding: 'utf8', env })
  assert.equal(run.status, 0, run.stdout + run.stderr)
  return run.stdout + run.stderr
}
const page = (root, path) => readFileSync(join(root, 'dist', path, 'index.html'), 'utf8')
const lastmod = (root, sitemap, path) => {
  const xml = readFileSync(join(root, 'dist', sitemap), 'utf8')
  const url = xml.split('\n').find((l) => l.includes(`<loc>https://roadtrackerindia.com/${path}</loc>`))
  assert.ok(url, `${path} is in ${sitemap}`)
  return url.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]
}

/**
 * A repo whose files changed on known days: everything on 1 Jan, the OSM road
 * again on 10 Mar, and an unrelated commit on 20 Apr.
 */
const origin = mkdtempSync(join(tmpdir(), 'rti-gen-pages-'))
roots.push(origin)
git(origin, ['init', '-q'])
put(origin, 'index.html', TEMPLATE)
put(origin, 'public/data/roads/osm-road.json', '{}')
put(origin, 'public/data/roads/hand-road.json', '{}')
put(origin, 'data/orgs/acme.json', '{}')
git(origin, ['add', '-A'])
git(origin, ['commit', '-q', '-m', 'catalogue'], '2026-01-01')
put(origin, 'public/data/roads/osm-road.json', '{"edited":true}')
git(origin, ['commit', '-q', '-am', 'osm road'], '2026-03-10')
put(origin, 'notes.txt', 'unrelated')
git(origin, ['add', 'notes.txt'])
git(origin, ['commit', '-q', '-m', 'notes'], '2026-04-20')
stampDist(origin)
genPages(origin)

test('every road page and directory page credits OpenStreetMap', () => {
  const credit = /Map data © <a href="https:\/\/www\.openstreetmap\.org\/copyright"[^>]*>OpenStreetMap<\/a> contributors, ODbL · Road catalogue © RoadTracker India contributors, ODbL/
  for (const path of ['road/osm-road', 'road/hand-road', 'company/acme', 'company', 'roads', 'state/kerala'])
    assert.match(page(origin, path), credit, path)
  // and the road generated from OSM says so in its own words, as the app's panel does
  assert.match(page(origin, 'road/osm-road'), /Route, length and place names for this road come from <a[^>]*>OpenStreetMap<\/a> contributors \(ODbL\)/)
  assert.doesNotMatch(page(origin, 'road/hand-road'), /Route, length and place names/)
})

test('a $ in road text is text, never a replacement pattern', () => {
  const html = page(origin, 'road/osm-road')
  const head = html.slice(0, html.indexOf('</head>'))
  assert.equal(head.match(/<meta\s+name="description"/g).length, 1)
  assert.match(head, /<meta name="description" content="[^"]*US\$2 billion loan — \$1, \$&amp; and \$&#39; are not patterns\.[^"]*" \/>/)
  assert.match(head, /<meta property="og:description" content="[^"]*US\$2 billion/)
  assert.match(html, /<p class="rd-history">Funded by a US\$2 billion loan — \$1, \$&amp; and \$&#39; are not patterns\.<\/p>/)
  // `$'` in the body would have pasted the rest of the template after it
  assert.equal(html.match(/<\/html>/g).length, 1)
})

test('lastmod is the day a page’s own inputs last changed', () => {
  assert.equal(lastmod(origin, 'sitemap-roads-1.xml', 'road/osm-road/'), '2026-03-10')
  assert.equal(lastmod(origin, 'sitemap-roads-1.xml', 'road/hand-road/'), '2026-01-01')
  // a hub lists roads, so it changed when the newest of them did — not when index.html did
  assert.equal(lastmod(origin, 'sitemap-pages.xml', 'state/kerala/'), '2026-03-10')
  assert.equal(lastmod(origin, 'sitemap-pages.xml', 'roads/'), '2026-03-10')
  assert.equal(lastmod(origin, 'sitemap-pages.xml', 'company/acme/'), '2026-03-10')
})

test('a shallow clone dates nothing to its boundary commit', () => {
  const clone = mkdtempSync(join(tmpdir(), 'rti-gen-pages-shallow-'))
  roots.push(clone)
  git(tmpdir(), ['clone', '-q', '--depth=1', `file://${origin}`, clone])
  stampDist(clone)
  const log = genPages(clone)
  // the clone's one commit (20 Apr) lists every file, but changed none of the roads
  assert.equal(lastmod(clone, 'sitemap-roads-1.xml', 'road/osm-road/'), undefined)
  assert.equal(lastmod(clone, 'sitemap-roads-1.xml', 'road/hand-road/'), undefined)
  assert.equal(lastmod(clone, 'sitemap-pages.xml', 'state/kerala/'), undefined)
  assert.doesNotMatch(readFileSync(join(clone, 'dist', 'sitemap.xml'), 'utf8'), /<lastmod>/)
  assert.match(log, /shallow git clone: 2 road\(s\)/)
})
