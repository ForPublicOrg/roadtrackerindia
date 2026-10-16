// node --test scripts/   — runs the toll script against a throwaway corpus
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./fetch-toll-rates.mjs', import.meta.url))
const roots = []
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

/** km → degrees of latitude, close enough for fixtures */
const north = (km) => km / 111.195

/**
 * The script finds the repo from its own location and reads TIS from its cache
 * when one is there, so a copy of it in an empty directory, with a cache file
 * put beside it, runs offline against only the roads the test writes.
 */
function run({ roads, shapes, plazas }) {
  const root = mkdtempSync(join(tmpdir(), 'rti-tolls-'))
  roots.push(root)
  const put = (path, body) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  mkdirSync(join(root, 'scripts'))
  copyFileSync(SCRIPT, join(root, 'scripts', 'fetch-toll-rates.mjs'))
  for (const [id, text] of Object.entries(roads)) put(`public/data/roads/${id}.json`, text)
  for (const [id, coordinates] of Object.entries(shapes)) {
    put(`public/data/shapes/${id}.json`, JSON.stringify({ type: 'Feature', geometry: { type: 'LineString', coordinates } }))
  }
  put('.cache/nhai/toll-plazas.json', JSON.stringify(plazas))
  const res = spawnSync(process.execPath, [join(root, 'scripts', 'fetch-toll-rates.mjs')], { encoding: 'utf8' })
  assert.equal(res.status, 0, res.stderr)
  const read = (id) => readFileSync(join(root, 'public/data/roads', `${id}.json`), 'utf8')
  return { read, road: (id) => JSON.parse(read(id)) }
}

/** A road file laid out the way the real ones are, one top-level key a line. */
const roadFile = (id, extra = '') => `{
  "id": "${id}",
  "name": "Test road",
  "lengthKm": 100,${extra}
  "status": "operational"
}
`

const plaza = (nh, name, [lng, lat], car = 100) => ({
  NHNo: nh,
  TollName: name,
  Longitude: lng,
  Latitude: lat,
  CarRate: car,
  FeeEffectiveDate: '2026-04-01',
})

test('a plaza listed by hand keeps its name and note, and gains the TIS rates', () => {
  const tolls = `
  "tolls": [
    { "name": "Kherki Daula toll plaza", "note": "famous for long queues at peak hours" },
    { "name": "Khed Shivapur toll plaza", "note": "just south of Pune" }
  ],`
  const { road } = run({
    roads: { 'nh-48': roadFile('nh-48', tolls) },
    shapes: { 'nh-48': [[77, 28], [77, 28 + north(50)]] },
    plazas: [
      plaza('NH-48', 'KHERKI DAULA', [77, 28 + north(5)], 115),
      plaza('NH-48', 'Shahjahanpur', [77, 28 + north(40)], 160),
    ],
  })
  const nh48 = road('nh-48')
  assert.deepEqual(nh48.tolls, [
    { name: 'Kherki Daula toll plaza', note: 'famous for long queues at peak hours', rates: { car: 115 } },
    // TIS does not list it here, but nobody asked for it to go
    { name: 'Khed Shivapur toll plaza', note: 'just south of Pune' },
    { name: 'Shahjahanpur', rates: { car: 160 } },
  ])
  assert.equal(nh48.tollInfo.asOf, '2026-04-01')
})

test("a spur's plaza goes to the spur, not to the parent it branches off", () => {
  // NH 348BB starts on NH 348B, so its plaza is within 6 km of both
  const shared = [[73, 18.9], [73, 18.9 + north(10)]]
  const { road } = run({
    roads: { 'nh-348b': roadFile('nh-348b'), 'nh-348bb': roadFile('nh-348bb') },
    shapes: { 'nh-348b': shared, 'nh-348bb': shared },
    plazas: [plaza('NH-348BB', 'Jasai', [73, 18.9 + north(3)])],
  })
  assert.equal(road('nh-348b').tolls, undefined)
  assert.deepEqual(road('nh-348bb').tolls, [{ name: 'Jasai', rates: { car: 100 } }])
})

test('a plaza on a long straight stretch matches, far as it is from every vertex', () => {
  const { road } = run({
    roads: { 'nh-62': roadFile('nh-62') },
    // one 52 km segment: the middle of it is 26 km from both ends
    shapes: { 'nh-62': [[73.9, 29.4], [73.9, 29.4 + north(52)]] },
    plazas: [
      plaza('NH-62', 'Midway', [73.9, 29.4 + north(26)]),
      plaza('NH-62', 'Elsewhere', [73.9 + 0.09, 29.4 + north(26)]), // ~8.7 km east of the line
    ],
  })
  assert.deepEqual(road('nh-62').tolls, [{ name: 'Midway', rates: { car: 100 } }])
})
