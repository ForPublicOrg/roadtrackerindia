// node --test scripts/   — runs the data build against a throwaway corpus
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodePolyline } from './lib/overpass.mjs'

const SCRIPT = fileURLToPath(new URL('./build-data.mjs', import.meta.url))
const LIB = fileURLToPath(new URL('./lib', import.meta.url))
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
  // what the build imports comes along with it
  cpSync(LIB, join(root, 'scripts', 'lib'), { recursive: true })
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
/**
 * A line through `corners` with a point every tenth of each leg, as an OSM
 * alignment has: a 50 km leg in one segment is a hole in the stitching, and
 * gets the road no stretches.
 */
const via = (...corners) =>
  line(
    corners.flatMap((b, j) => {
      if (j === 0) return [b]
      const a = corners[j - 1]
      return Array.from({ length: 10 }, (_, i) => {
        const f = (i + 1) / 10
        return [Math.round((a[0] + (b[0] - a[0]) * f) * 1e5) / 1e5, Math.round((a[1] + (b[1] - a[1]) * f) * 1e5) / 1e5]
      })
    }),
  )
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
    'data/geometry/both-good.json': via([76, 10], [76.01, 10.45], [76, 10.9]),
    'public/data/geometry/both-good.json': via([76, 10], [76, 10.27]),
    // the generated line wanders off down a branch road, over three times too long
    ...road('data-bad'),
    'data/geometry/data-bad.json': via([76, 10], [77.5, 10.45], [76, 10.9]),
    'public/data/geometry/data-bad.json': via([76, 10], [75.99, 10.45], [76, 10.9]),
    ...road('legacy-only'),
    'public/data/geometry/legacy-only.json': via([76, 10], [76.02, 10.45], [76, 10.9]),
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

test('a long road gets its stretch stops, start → end, and a short one gets none', () => {
  // due north from 76°E 10°N, so each km is a fixed step of latitude
  const at = (km) => [76, Math.round((10 + km / ((6371 * Math.PI) / 180)) * 1e5) / 1e5]
  const north = Array.from({ length: 31 }, (_, i) => at(i * 5))
  const out = build({
    ...road('nh-9', { km: 150, stops: [['Alpha', at(0)], ['Beta', at(50)], ['Gamma', at(100)], ['Delta', at(150)]] }),
    // drawn end → start, as NH 44 was
    'data/geometry/nh-9.json': line(north.slice().reverse()),
    ...road('mdr-kl-1', { category: 'district', km: 12, provenance: 'osm', stops: [['Eta', [76.5, 11]], ['Theta', [76.5, 11.108]]] }),
    ...road('nh-10', { km: 12, stops: [['Iota', [77, 11]], ['Kappa', [77, 11.108]]] }),
  })
  assert.equal(out.code, 0, out.log)

  const long = out.read('public/data/shapes/nh-9.json')
  assert.deepEqual(long.geometry.coordinates[0], at(0))
  assert.equal(long.properties.km, 150)
  assert.deepEqual(long.properties.stops, [
    { n: 'Alpha', k: 'alpha', km: 0 },
    { n: 'Beta', k: 'beta', km: 50 },
    { n: 'Gamma', k: 'gamma', km: 100 },
    { n: 'Delta', k: 'delta', km: 150 },
  ])
  assert.equal(long.properties.marks, undefined)
  // the overview is turned round with it
  const lite = out.read('public/data/network-lite.geojson').features.find((f) => f.properties.id === 'nh-9')
  assert.deepEqual(lite.geometry.coordinates[0], [76, 10])

  const short = out.read('public/data/shapes/mdr-kl-1.json').properties
  assert.equal(short.stops, undefined)
  assert.equal(short.marks, undefined)
  assert.equal(short.km, 12)

  assert.match(out.log, /stretches: 1 roads, 1 flipped, 2 gated out \(short 2\)/)
  // only the hand-written road is named; generated ones are only counted
  assert.match(out.log, /hand-written\): nh-10 \(short\)$/m)
  assert.doesNotMatch(out.log, /mdr-kl-1/)
})

test('a line with a hole in it gets no stops, and the build names the road', () => {
  const at = (km, lng = 76) => [lng, Math.round((10 + km / ((6371 * Math.PI) / 180)) * 1e5) / 1e5]
  const stops = (lng) => [['Alpha', at(0, lng)], ['Beta', at(50, lng)], ['Gamma', at(100, lng)], ['Delta', at(150, lng)]]
  // OSM has nothing between km 40 and km 100, so the line jumps 60 km
  // straight across. Simplified, it is the same two points as a straight road
  // with a point every 5 km — only the full line tells the two apart.
  const holed = Array.from({ length: 31 }, (_, i) => at(i * 5)).filter(([, lat]) => lat <= at(40)[1] || lat >= at(100)[1])
  const out = build({
    ...road('nh-11', { km: 150, stops: stops(76) }),
    'data/geometry/nh-11.json': line(holed),
    // drawn from its waypoints, a road is one long straight leg after another
    ...road('nh-12', { km: 150, stops: stops(77) }),
  })
  assert.equal(out.code, 0, out.log)

  const gapped = out.read('public/data/shapes/nh-11.json').properties
  assert.equal(gapped.real, true)
  assert.equal(gapped.stops, undefined)
  assert.equal(gapped.marks, undefined)
  assert.equal(out.read('public/data/shapes/nh-12.json').properties.stops.length, 4)

  assert.match(out.log, /stretches: 1 roads, 0 flipped, 1 gated out \(gap 1\)/)
  assert.match(out.log, /hand-written\): nh-11 \(gap\)$/m)
  assert.match(out.log, /nh-11: no stretches — the line jumps 60 km in a straight line at km 40; its reviews stay whole-road/)
  assert.doesNotMatch(out.log, /nh-12/)
})

test('a hole fill-gaps found no road for is measured along but never drawn', () => {
  const at = (km) => [76, Math.round((10 + km / ((6371 * Math.PI) / 180)) * 1e5) / 1e5]
  // OSM has no road from km 60 to km 70. The file runs Delta to Alpha, so the
  // build turns it round, and the hole has to come through that by its ends.
  const north = Array.from({ length: 31 }, (_, i) => at(i * 5)).filter(([, lat]) => lat <= at(60)[1] || lat >= at(70)[1])
  const coords = north.slice().reverse()
  const out = build({
    ...road('nh-13', { km: 140, stops: [['Alpha', at(0)], ['Beta', at(50)], ['Gamma', at(100)], ['Delta', at(150)]] }),
    'data/geometry/nh-13.json': {
      type: 'Polyline',
      precision: 5,
      lengthKm: 140,
      holes: [coords.indexOf(north[12])],
      data: encodePolyline(coords),
    },
  })
  assert.equal(out.code, 0, out.log)
  assert.match(out.log, /1 drawn around holes OSM has no road for/)

  const shape = out.read('public/data/shapes/nh-13.json')
  const c = shape.geometry.coordinates
  assert.equal(shape.geometry.type, 'LineString')
  assert.deepEqual(shape.properties.gaps.map((g) => [c[g - 1], c[g]]), [[at(60), at(70)]])
  // a 10 km hole in 150 km is no reason to refuse stretches
  assert.equal(shape.properties.stops.length, 4)

  const lite = out.read('public/data/network-lite.geojson').features.find((f) => f.properties.id === 'nh-13')
  assert.equal(lite.geometry.type, 'MultiLineString')
  const [south, rest] = lite.geometry.coordinates
  assert.deepEqual([south[0], south.at(-1), rest[0]], [at(0), at(60), at(70)].map(([x, y]) => [x, Math.round(y * 1e4) / 1e4]))
})
