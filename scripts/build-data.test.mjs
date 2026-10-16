// node --test scripts/   — runs the data build against a throwaway corpus
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./build-data.mjs', import.meta.url))
const roots = []
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

/**
 * The script finds the repo from its own location, so a copy of it in an empty
 * directory builds whatever files the test puts around it — never the real
 * catalogue, and never the real public/data.
 */
function build(files, ...args) {
  const root = mkdtempSync(join(tmpdir(), 'rti-build-data-'))
  roots.push(root)
  const put = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body))
  }
  mkdirSync(join(root, 'scripts'))
  copyFileSync(SCRIPT, join(root, 'scripts', 'build-data.mjs'))
  for (const [path, body] of Object.entries(files)) put(path, body)
  const run = spawnSync(process.execPath, [join(root, 'scripts', 'build-data.mjs'), ...args], { encoding: 'utf8' })
  const read = (path) => (existsSync(join(root, path)) ? JSON.parse(readFileSync(join(root, path), 'utf8')) : null)
  return { code: run.status, log: run.stdout + run.stderr, read }
}

/** A valid road file through `stops` ([name, [lng, lat]] pairs), the first and last its termini. */
function road(id, { stops = [['Alpha', [76, 10]], ['Beta', [76, 10.9]]], km = 100, category = 'nh', ...fields } = {}) {
  const names = stops.map(([name]) => name)
  return {
    [`public/data/roads/${id}.json`]: {
      id,
      ref: id.toUpperCase(),
      name: `${id} road`,
      category,
      status: 'operational',
      lengthKm: km,
      route: { start: `${names[0]}, Kerala`, end: `${names.at(-1)}, Kerala`, states: ['Kerala'], majorCities: names },
      waypoints: stops.map(([name, coords]) => ({ name, coords })),
      sources: [{ title: 'NHAI', url: 'https://nhai.gov.in/' }],
      ...fields,
    },
  }
}

const line = (coordinates) => ({ type: 'LineString', coordinates })
const ORG = { id: 'acme', name: 'Acme Infra', type: 'contractor', summary: 'Builds roads.', sources: [{ title: 'Acme', url: 'https://acme.example/' }] }

test('a field of the wrong shape is reported by file and field, not a crash', () => {
  const { code, log } = build({
    'data/orgs/acme.json': { ...ORG, helplines: { kind: 'info', label: 'Desk', number: '1033' } },
    ...road('built', { builtBy: { org: 'acme' } }),
    ...road('operated', { operatedBy: { org: 'acme' } }),
    ...road('related', { relatedRoads: { id: 'built' } }),
    'public/data/roads/empty.json': 'null',
  }, '--lint')
  assert.equal(code, 1)
  assert.doesNotMatch(log, /TypeError|is not iterable|is not a function/)
  // every error survives, not just the first one the loop reached
  assert.match(log, /orgs\/acme\.json: "helplines" must be an array/)
  assert.match(log, /built\.json: "builtBy" must be an array/)
  assert.match(log, /operated\.json: "operatedBy" must be an array/)
  assert.match(log, /related\.json: "relatedRoads" must be an array/)
  assert.match(log, /empty\.json: must be a JSON object/)
})

test('a majorCities entry that is not a name fails lint, and the build writes nothing', () => {
  const files = road('nh-1')
  files['public/data/roads/nh-1.json'].route.majorCities = ['Alpha', null]
  const lint = build(files, '--lint')
  assert.equal(lint.code, 1)
  assert.match(lint.log, /nh-1\.json: "route\.majorCities" must list at least 2 place names/)

  const full = build(files)
  assert.equal(full.code, 1)
  assert.doesNotMatch(full.log, /TypeError/)
  assert.equal(full.read('public/data/index.json'), null)
})

test('data/geometry wins over the legacy directory, unless only the legacy line fits the road', () => {
  const out = build({
    // the legacy line stops 70 km short of the far end, as NH 19's did
    ...road('both-good'),
    'data/geometry/both-good.json': line([[76, 10], [76.01, 10.45], [76, 10.9]]),
    'public/data/geometry/both-good.json': line([[76, 10], [76, 10.27]]),
    // the generated line wanders off down a branch road, over three times too long
    ...road('data-bad'),
    'data/geometry/data-bad.json': line([[76, 10], [77.5, 10.45], [76, 10.9]]),
    'public/data/geometry/data-bad.json': line([[76, 10], [75.99, 10.45], [76, 10.9]]),
    ...road('legacy-only'),
    'public/data/geometry/legacy-only.json': line([[76, 10], [76.02, 10.45], [76, 10.9]]),
  })
  assert.equal(out.code, 0, out.log)
  const shape = (id) => out.read(`public/data/shapes/${id}.json`)

  assert.equal(shape('both-good').properties.real, true)
  assert.deepEqual(shape('both-good').geometry.coordinates[1], [76.01, 10.45])
  // the camera frames the whole road, not the stretch the stale line covered
  assert.equal(out.read('public/data/index.json').roads.find((r) => r.id === 'both-good').bbox[3], 10.9)

  assert.deepEqual(shape('data-bad').geometry.coordinates[1], [75.99, 10.45])
  assert.match(out.log, /data-bad: data\/geometry\/data-bad\.json misses an end of the road or its length/)

  assert.deepEqual(shape('legacy-only').geometry.coordinates[1], [76.02, 10.45])
  assert.doesNotMatch(out.log, /both-good:|legacy-only:/)
})

test('two far-apart towns of one name are not averaged into the country between them', () => {
  // Kothapeta, Andhra Pradesh, and Kothapeta, Telangana: one point each, and
  // the longer road's is the one somebody searching means
  const ap = [81.9, 16.7]
  const ts = [80.14, 17.56]
  const out = build({
    ...road('nh-216e', { km: 89, stops: [['Gamma', [81.9, 16.3]], ['Kothapeta', ap], ['Delta', [81.9, 17.1]]] }),
    ...road('nh-930p', { km: 300, stops: [['Eta', [80.14, 17.16]], ['Kothapeta', ts], ['Theta', [80.14, 17.96]]] }),
    // two waypoints for one town, a few km apart, stay one place
    ...road('sh-1', { category: 'sh', km: 30, stops: [['Epsilon', [76.5, 11.5]], ['Zeta', [76.5, 11.77]]] }),
    ...road('sh-2', { category: 'sh', km: 30, stops: [['Epsilon', [76.53, 11.52]], ['Iota', [76.53, 11.79]]] }),
  })
  assert.equal(out.code, 0, out.log)
  const cities = new Map(out.read('public/data/places.json').cities.map(([name, ...box]) => [name, box]))
  const holds = ([a, b, c, d], [x, y]) => x >= a && x <= c && y >= b && y <= d

  const kothapeta = cities.get('Kothapeta')
  assert.ok(holds(kothapeta, ts), `box ${kothapeta} misses the Kothapeta on the longer road`)
  assert.ok(!holds(kothapeta, ap))

  const epsilon = cities.get('Epsilon')
  assert.ok(holds(epsilon, [76.5, 11.5]) && holds(epsilon, [76.53, 11.52]), `box ${epsilon}`)
})
