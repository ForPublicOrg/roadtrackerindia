// node --test scripts/   — runs stage 1 of the corpus build against a fake Overpass
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
 * geometry, which the stub answers.
 */
function fetchRoads(relations) {
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
  const res = spawnSync(
    process.execPath,
    ['--import', pathToFileURL(join(root, 'stub.mjs')).href, join(root, 'scripts', 'fetch-osm-roads.mjs')],
    { encoding: 'utf8', env: { ...process.env, OVERPASS_FIXTURE: join(root, 'fixture.json') } },
  )
  assert.equal(res.status, 0, res.stderr)
  return (id) => {
    const path = join(root, '.cache/osm/routes', `${id}.json`)
    if (!existsSync(path)) return null
    const { lengthKm, bridgedKm } = JSON.parse(readFileSync(path, 'utf8'))
    return { lengthKm, bridgedKm }
  }
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
