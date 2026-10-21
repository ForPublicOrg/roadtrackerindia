// node --test scripts/   — runs stage 1 of the corpus build against a fake Overpass
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MAX_SEGMENT_KM, haversineKm } from './lib/overpass.mjs'

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url))
const roots = []
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

/** Answers `relation(id:…);out geom;` from a fixture instead of the network. */
const STUB = `
import { readFileSync } from 'node:fs'
const elements = JSON.parse(readFileSync(process.env.OVERPASS_FIXTURE, 'utf8'))
globalThis.fetch = async (_url, init) => {
  const query = decodeURIComponent(String(init.body).replace(/^data=/, ''))
  const ids = new Set((query.match(/relation\\(id:([\\d,]+)\\)/)?.[1] ?? '').split(',').map(Number))
  return new Response(JSON.stringify({ elements: elements.filter((e) => ids.has(e.id)) }))
}
`

/**
 * The scripts find the repo from their own location, so copies of them in an
 * empty directory fetch into that directory's .cache, never the real one. The
 * relation list is already "cached", so the only Overpass call is the
 * geometry, which the stub answers. `cached` seeds .cache/osm/routes.
 */
function fetchRoads(relations, { args = [], cached = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rti-osm-roads-'))
  roots.push(root)
  const put = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  copyFileSync(join(SCRIPTS, 'fetch-osm-roads.mjs'), join(root, 'scripts', 'fetch-osm-roads.mjs'))
  copyFileSync(join(SCRIPTS, 'lib', 'overpass.mjs'), join(root, 'scripts', 'lib', 'overpass.mjs'))
  put('stub.mjs', STUB)
  put('fixture.json', JSON.stringify(relations.map(({ id, members }) => ({ type: 'relation', id, members }))))
  put('.cache/osm/relations.json', JSON.stringify(relations.map(({ id, tags }) => ({ id, tags }))))
  for (const [id, route] of Object.entries(cached)) put(`.cache/osm/routes/${id}.json`, JSON.stringify(route))
  const res = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(join(root, 'stub.mjs')).href, join(root, 'scripts', 'fetch-osm-roads.mjs'), ...args],
    { encoding: 'utf8', env: { ...process.env, OVERPASS_FIXTURE: join(root, 'fixture.json') } },
  )
  assert.equal(res.status, 0, res.stderr)
  const read = (id) => {
    const path = join(root, '.cache/osm/routes', `${id}.json`)
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  }
  const route = (id) => {
    const r = read(id)
    return r && { lengthKm: r.lengthKm, bridgedKm: r.bridgedKm }
  }
  /** the cached alignment's segment lengths, longest first */
  route.segments = (id) => {
    const { coords } = read(id)
    return coords.slice(1).map((p, i) => haversineKm(coords[i], p)).sort((a, b) => b - a)
  }
  return route
}

/** km → degrees of latitude, on the same sphere the scripts measure with */
const north = (km) => km / ((2 * Math.PI * 6371) / 360)

/** A straight piece of road due north, `fromKm` to `toKm` along a meridian. */
let wayId = 1000
function way(lng, fromKm, toKm) {
  const geometry = []
  for (let km = fromKm; km <= toKm + 1e-9; km += 1) geometry.push({ lon: lng, lat: 20 + north(km) })
  return { type: 'way', ref: wayId++, geometry }
}

test('a gap the first pass closes is counted as a bridge, not as road', () => {
  const route = fetchRoads([
    // 5 km, a 10 km gap, 5 km: 10 km of road, whatever the gap
    { id: 1, tags: { network: 'IN:NH', ref: 'NH 999' }, members: [way(77, 0, 5), way(77, 15, 20)] },
  ])
  assert.deepEqual(route('nh-999'), { lengthKm: 10, bridgedKm: 10 })
})

test('a named road is not welded across a gap wider than 4 km', () => {
  const route = fetchRoads([
    { id: 2, tags: { network: 'IN:SH:KL', name: 'Temple Road' }, members: [way(76, 0, 5), way(76, 15, 20)] },
  ])
  assert.deepEqual(route('kl-temple-road'), { lengthKm: 5, bridgedKm: 0 })
  assert.deepEqual(route('kl-temple-road-2'), { lengthKm: 5, bridgedKm: 0 })
})

test('a piece split off a named road keeps its own bridges out of its length', () => {
  const route = fetchRoads([
    {
      id: 3,
      tags: { network: 'IN:SH:KL', name: 'Church Road' },
      // 6 km here; 20 km away, 3 km and 2 km of another road with a 1 km gap
      members: [way(75, 0, 6), way(75, 26, 29), way(75, 30, 32)],
    },
  ])
  assert.deepEqual(route('kl-church-road'), { lengthKm: 6, bridgedKm: 0 })
  assert.deepEqual(route('kl-church-road-2'), { lengthKm: 5, bridgedKm: 1 })
})

test('a dead-straight road is cached with a real vertex every few kilometres', () => {
  // 60 km without a bend: simplifying by tolerance alone kept only its ends,
  // and the gap gate read the one 60 km segment as a hole in the stitching
  const route = fetchRoads([{ id: 4, tags: { network: 'IN:NH', ref: 'NH 998' }, members: [way(74, 0, 60)] }])
  assert.deepEqual(route('nh-998'), { lengthKm: 60, bridgedKm: 0 })
  assert.ok(route.segments('nh-998')[0] <= MAX_SEGMENT_KM + 0.05)
})

test('a bridge across a hole is still one segment, so the gap gate still sees it', () => {
  const route = fetchRoads([
    { id: 5, tags: { network: 'IN:NH', ref: 'NH 997' }, members: [way(73, 0, 20), way(73, 50, 70)] },
  ])
  assert.deepEqual(route('nh-997'), { lengthKm: 40, bridgedKm: 30 })
  const [longest, next] = route.segments('nh-997')
  assert.ok(Math.abs(longest - 30) < 0.05, `longest ${longest} km`)
  assert.ok(next <= MAX_SEGMENT_KM + 0.05, `next ${next} km`)
})

test('--only refetches the roads it names, cached or not, and no others', () => {
  const stale = { lengthKm: 1, bridgedKm: 0, coords: [[71, 20], [71, 20.01]] }
  const route = fetchRoads(
    [
      { id: 6, tags: { network: 'IN:NH', ref: 'NH 996' }, members: [way(72, 0, 12)] },
      { id: 7, tags: { network: 'IN:NH', ref: 'NH 995' }, members: [way(71, 0, 12)] },
    ],
    { args: ['--only', 'nh-996'], cached: { 'nh-996': stale, 'nh-995': stale } },
  )
  assert.deepEqual(route('nh-996'), { lengthKm: 12, bridgedKm: 0 })
  assert.deepEqual(route('nh-995'), { lengthKm: 1, bridgedKm: 0 })
})
