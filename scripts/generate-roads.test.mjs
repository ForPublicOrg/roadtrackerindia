// node --test scripts/   — runs stage 2 of the corpus build against a fake cache
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPTS = fileURLToPath(new URL('.', import.meta.url))
const roots = []
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

/** A road due north from Alpha to Beta, as stage 1 caches it. */
const route = (id) => ({
  id,
  ref: id.toUpperCase().replace('-', ' '),
  class: 'NH',
  category: 'nh',
  authority: 'national',
  coords: [[77, 20], [77, 20.25], [77, 20.5]],
  lengthKm: 55.6,
  bridgedKm: 0,
})

/**
 * The script finds the repo from where lib/overpass.mjs sits, so copies of the
 * two in an empty directory read that directory's cache and write its
 * data/geometry, never the real ones.
 */
function generate(files) {
  const root = mkdtempSync(join(tmpdir(), 'rti-generate-'))
  roots.push(root)
  const put = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), typeof body === 'string' ? body : JSON.stringify(body))
  }
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  mkdirSync(join(root, 'public', 'data', 'roads'), { recursive: true })
  copyFileSync(join(SCRIPTS, 'generate-roads.mjs'), join(root, 'scripts', 'generate-roads.mjs'))
  copyFileSync(join(SCRIPTS, 'lib', 'overpass.mjs'), join(root, 'scripts', 'lib', 'overpass.mjs'))
  put('.cache/osm/states.json', [
    { name: 'Testland', iso: 'IN-TT', bbox: [76, 19, 79, 22], rings: [[[76, 19], [79, 19], [79, 22], [76, 22], [76, 19]]] },
  ])
  put('.cache/osm/places.json', [
    { n: 'Alpha', k: 'town', p: 50000, c: [77, 20] },
    { n: 'Beta', k: 'town', p: 50000, c: [77, 20.5] },
  ])
  for (const [path, body] of Object.entries(files)) put(path, body)
  const res = spawnSync(process.execPath, [join(root, 'scripts', 'generate-roads.mjs'), '--overwrite'], {
    encoding: 'utf8',
  })
  assert.equal(res.status, 0, res.stderr)
  return { out: res.stdout, read: (path) => readFileSync(join(root, path), 'utf8'), has: (path) => existsSync(join(root, path)) }
}

test('a curated alignment survives regeneration from the cache; the rest are rewritten', () => {
  const repaired = '{"type":"Polyline","precision":5,"lengthKm":55.6,"data":"repaired by hand"}'
  const run = generate({
    '.cache/osm/routes/nh-901.json': route('nh-901'),
    '.cache/osm/routes/nh-902.json': route('nh-902'),
    'data/geometry/nh-901.json': repaired,
    'data/geometry/nh-902.json': '{"type":"Polyline","precision":5,"lengthKm":1,"data":"stale"}',
    'data/curated-geometry.json': {
      'nh-901': { why: 'test', date: '2026-10-21' },
      'nh-903': { why: 'a typo, or a file someone deleted', date: '2026-10-21' },
    },
  })
  assert.equal(run.read('data/geometry/nh-901.json'), repaired)
  assert.notEqual(JSON.parse(run.read('data/geometry/nh-902.json')).data, 'stale')
  // the list protects the line only; the road file is generated as usual
  assert.ok(run.has('public/data/roads/nh-901.json'))
  assert.match(run.out, /kept 1 curated alignments/)
  assert.match(run.out, /nh-903: listed in data\/curated-geometry\.json but has no data\/geometry file/)
})

test('without a curated list every cached alignment is written', () => {
  const run = generate({
    '.cache/osm/routes/nh-901.json': route('nh-901'),
    'data/geometry/nh-901.json': '{"type":"Polyline","precision":5,"lengthKm":1,"data":"stale"}',
  })
  assert.notEqual(JSON.parse(run.read('data/geometry/nh-901.json')).data, 'stale')
  assert.match(run.out, /kept 0 curated alignments/)
})
