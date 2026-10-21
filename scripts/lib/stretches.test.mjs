// node --test scripts/lib/   — where a road's stretches begin and end
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { slug as clientSlug } from '../../src/stretches.ts'
import {
  cumulativeKm,
  deriveStops,
  haversineKm,
  isRing,
  orient,
  placeKey,
  placeMatch,
  projectPoint,
  rotateRing,
  slug,
} from './stretches.mjs'

// Every line here runs due north from 76°E 10°N, where a km along the line is a
// fixed step of latitude — so a place's km is known before anything measures it.
const KM_PER_DEG = (6371 * Math.PI) / 180
const LNG = 76
const at = (km, eastKm = 0) => [LNG + eastKm / (111.32 * Math.cos((10 * Math.PI) / 180)), 10 + km / KM_PER_DEG]
/** A straight line from km 0 to `km`, a point every `step` km. */
const line = (km, step = 5) => {
  const out = []
  for (let k = 0; k < km; k += step) out.push(at(k))
  out.push(at(km))
  return out
}
/** The same line with no points between km `from` and `to`: one straight jump across them. */
const holed = (km, from, to) => line(km).filter((p) => p[1] <= at(from)[1] || p[1] >= at(to)[1])

/**
 * A road through `places` ([name, km] or [name, km, km east of the line]); the
 * first and last are its termini, and every place is a major city unless
 * `majors` says otherwise.
 */
function road(places, { lengthKm, majors, start, end } = {}) {
  const names = places.map(([name]) => name)
  return {
    lengthKm: lengthKm ?? places[places.length - 1][1],
    route: { start: `${start ?? names[0]}, Kerala`, end: `${end ?? names[names.length - 1]}, Kerala`, majorCities: majors ?? names },
    waypoints: places.map(([name, km, east = 0]) => ({ name, coords: at(km, east) })),
  }
}

const names = (r) => r.stops.map((s) => s.n)
const kms = (r) => r.stops.map((s) => s.km)
const near = (a, b, tol = 0.2) => Math.abs(a - b) <= tol

// ── measuring ───────────────────────────────────────────────────────

test('a point lands at its km along the line, and its distance off it', () => {
  const coords = line(100)
  const cum = cumulativeKm(coords)
  assert.ok(near(cum.at(-1), 100, 0.01))
  const p = projectPoint(at(42, 3), coords, cum)
  assert.ok(near(p.km, 42, 0.05), `km ${p.km}`)
  assert.ok(near(p.distKm, 3, 0.05), `off ${p.distKm}`)
  // past the end, it lands on the end
  assert.ok(near(projectPoint(at(130), coords, cum).km, 100, 0.01))
})

test('place names match when equal, or when one is whole words of the other', () => {
  assert.ok(placeMatch('Kengeri Bengaluru', 'Bengaluru'))
  assert.ok(placeMatch('Bandikui area', 'Bandikui'))
  assert.ok(placeMatch('Delhi (DND Flyway)', 'delhi'))
  assert.ok(placeMatch('Bhubaneśwar', 'Bhubaneswar'))
  assert.ok(placeMatch('Sawai-Madhopur', 'Sawai Madhopur'))
  assert.ok(!placeMatch('Nagar', 'Nagaram'))
  assert.ok(!placeMatch('', 'Agra'))
})

// ── keys ────────────────────────────────────────────────────────────

test('a key is the name folded to a-z, 0-9 and single dashes', () => {
  assert.equal(slug('Bhubaneśwar'), 'bhubaneswar')
  assert.equal(slug('Delhi (DND Flyway)'), 'delhi')
  assert.equal(slug('Surat area (Kamrej)'), 'surat-area')
  assert.equal(slug('  Kherki Daula — Toll  '), 'kherki-daula-toll')
  assert.equal(slug('Sarai Kale Khan (Delhi) – ISBT'), 'sarai-kale-khan-isbt')
  // cut at 40 before anything else, with no dash left hanging
  assert.equal(slug('Jawaharlal Nehru Port Trust Container Terminal Road'), 'jawaharlal-nehru-port-trust-container-te')
  assert.equal(slug('Aaaaaaaaaa Bbbbbbbbbb Cccccccccc Dddddd Eeee'), 'aaaaaaaaaa-bbbbbbbbbb-cccccccccc-dddddd')
  // a name with no letters in it is named by its place in the list
  assert.equal(slug('(—)', 3), 's3')
  assert.equal(slug(''), 's0')
  for (const k of ['a--b', '-a', 'a-']) assert.notEqual(slug(k), k)
})

test('the browser folds every place name in the catalogue to the same key', () => {
  const dir = new URL('../../public/data/roads/', import.meta.url)
  const corpus = [
    'Bhubaneśwar', 'Bāṇasavāḍi', 'Delhi (DND Flyway)', 'Foo(Bar)Baz', '(—)', '', '  --Port Blair--  ',
    'Jawaharlal Nehru Port Trust Container Terminal Road', 'Aaaaaaaaaa Bbbbbbbbbb Cccccccccc Dddddd Eeee',
    'Ōsaka', 'Ærø', 'İstanbul', 'Mysore (old) Road (new)', 'NH 48 / NH 44',
  ]
  for (const f of readdirSync(dir)) {
    const r = JSON.parse(readFileSync(new URL(f, dir), 'utf8'))
    corpus.push(r.route.start.split(',')[0], r.route.end.split(',')[0], ...r.route.majorCities, ...r.waypoints.map((w) => w.name))
  }
  const differ = corpus.filter((n, i) => clientSlug(n, i) !== slug(n, i))
  assert.deepEqual(differ, [])
})

test("keys are unique in km order, and never take a name that is another place's own", () => {
  const long = 'Jawaharlal Nehru Port Trust Container Terminal Road'
  const r = deriveStops(
    road([['Alpha', 0], ['Agra', 30], [long, 50], ['Mid', 65], ['Agra', 80], ['Agra 2', 100], [long, 120], ['Omega', 140]], {
      majors: ['Alpha', 'Mid', 'Omega'],
    }),
    line(140),
    false,
  )
  assert.equal(r.gate, null)
  const keys = Object.fromEntries(r.marks.map(([k, km]) => [km, k]))
  assert.equal(keys[30], 'agra')
  // "agra-2" is what "Agra 2" is called, so the second Agra skips it
  assert.equal(keys[80], 'agra-3')
  assert.equal(keys[100], 'agra-2')
  assert.equal(keys[50], 'jawaharlal-nehru-port-trust-container-te')
  assert.equal(keys[120], 'jawaharlal-nehru-port-trust-container-te-2')
  for (const k of [...r.marks.map(([k]) => k), ...r.stops.map((s) => s.k)]) assert.match(k, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
})

test('a place keeps its key when a rule change stops making it a stop', () => {
  const places = [['Alpha', 0], ['Beta', 60], ['Gamma', 120], ['Delta', 180], ['Omega', 240]]
  const all = deriveStops(road(places), line(240), false)
  const fewer = deriveStops(road(places, { majors: ['Alpha', 'Beta', 'Delta', 'Omega'] }), line(240), false)
  assert.deepEqual(names(all), ['Alpha', 'Beta', 'Gamma', 'Delta', 'Omega'])
  assert.deepEqual(names(fewer), ['Alpha', 'Beta', 'Delta', 'Omega'])
  const keyOf = (r) => new Map([...r.stops.map((s) => [s.km, s.k]), ...r.marks.map(([k, km]) => [km, k])])
  assert.deepEqual([...keyOf(fewer)].sort(), [...keyOf(all)].sort())
  assert.deepEqual(fewer.marks, [['gamma', 120]])
})

// ── which way the line runs ─────────────────────────────────────────

test('a line drawn end → start is turned round by its termini', () => {
  const r = road([['Alpha', 0], ['Beta', 50], ['Gamma', 100]])
  const backwards = line(100).reverse()
  const o = orient(backwards, r.waypoints, false)
  assert.equal(o.flipped, true)
  assert.deepEqual(o.coords[0], at(0))
  assert.equal(backwards[0][1], at(100)[1], 'the input is left alone')
  assert.equal(orient(line(100), r.waypoints, false).flipped, false)
})

test('termini too close to tell go by the waypoints in between', () => {
  // first and last waypoint 2 km apart in the middle of the line: the ends say
  // "keep" by 4 km, which is no evidence, and four of five steps run backwards
  const r = road([['Alpha', 49], ['Beta', 30], ['Gamma', 10], ['Delta', 90], ['Eta', 70], ['Omega', 51]])
  assert.equal(orient(line(100), r.waypoints, false).flipped, true)
  const forwards = road([['Alpha', 51], ['Beta', 70], ['Gamma', 90], ['Delta', 10], ['Eta', 30], ['Omega', 49]])
  assert.equal(orient(line(100), forwards.waypoints, false).flipped, false)
})

// ── loops ───────────────────────────────────────────────────────────

const RADIUS = 20
const onCircle = (deg) => {
  const t = (deg * Math.PI) / 180
  return [LNG + (RADIUS * Math.cos(t)) / (111.32 * Math.cos((10 * Math.PI) / 180)), 10 + (RADIUS * Math.sin(t)) / 110.574]
}
/** An anticlockwise circle from angle 0 back to angle 0. */
const circle = () => Array.from({ length: 121 }, (_, i) => onCircle((i * 3) % 360))
function loop(stops) {
  const ring = stops.map(([name, deg]) => ({ name, coords: onCircle(deg) }))
  return {
    lengthKm: 125,
    route: { start: 'Kochi, Kerala', end: 'Kochi, Kerala', majorCities: stops.map(([n]) => n) },
    waypoints: [...ring, ring[0]],
  }
}
const loopKm = (deg) => (2 * Math.PI * RADIUS * deg) / 360

test('a loop is a closed line that its road also calls a loop', () => {
  const r = loop([['Alpha', 90], ['Beta', 180], ['Gamma', 270]])
  assert.equal(isRing(r, circle()), true)
  // the same closed line under a road that runs from one place to another
  const open = road([['Alpha', 0], ['Omega', 125]])
  open.waypoints = [{ name: 'Alpha', coords: onCircle(0) }, { name: 'Omega', coords: onCircle(180) }]
  assert.equal(isRing(open, circle()), false)
  // a 1 km lane that ends 900 m from where it began
  assert.equal(isRing(r, line(1, 0.2)), false)
})

test('a loop runs the way its waypoints go round', () => {
  const r = loop([['Alpha', 90], ['Beta', 150], ['Gamma', 210], ['Delta', 270], ['Eta', 330]])
  assert.equal(orient(circle(), r.waypoints, true).flipped, false)
  assert.equal(orient(circle().reverse(), r.waypoints, true).flipped, true)
})

test('a loop is cut at its first stop and closes on it again', () => {
  const r = deriveStops(loop([['Alpha', 90], ['Beta', 150], ['Gamma', 210], ['Delta', 270], ['Eta', 330]]), circle(), true)
  assert.equal(r.gate, null)
  assert.ok(haversineKm(r.coords[0], onCircle(90)) < 0.05, 'the line starts at Alpha')
  assert.deepEqual(r.coords[0], r.coords.at(-1))
  assert.deepEqual(names(r), ['Alpha', 'Beta', 'Gamma', 'Delta', 'Eta', 'Alpha'])
  assert.deepEqual(r.stops.map((s) => s.k), ['alpha', 'beta', 'gamma', 'delta', 'eta', 'alpha-2'])
  r.stops.slice(0, -1).forEach((s, i) => assert.ok(near(s.km, loopKm(60 * i), 0.3), `${s.n} at ${s.km}`))
  assert.equal(r.stops.at(-1).km, Math.round(cumulativeKm(r.coords).at(-1) * 10) / 10)
})

test('cutting a loop keeps every point and its length', () => {
  const c = circle()
  const L = cumulativeKm(c).at(-1)
  const cut = rotateRing(c, 40)
  assert.ok(near(cumulativeKm(cut).at(-1), L, 0.01))
  assert.deepEqual(cut[0], cut.at(-1))
  assert.ok(near(projectPoint(cut[0], c, cumulativeKm(c)).km, 40, 0.01))
})

// ── stops ───────────────────────────────────────────────────────────

test('a place far off the line is no stop and no mark', () => {
  const r = deriveStops(
    road([['Alpha', 0], ['Beta', 60, 20], ['Gamma', 120, 10], ['Delta', 180], ['Omega', 240]], { majors: ['Alpha', 'Beta', 'Delta', 'Omega'] }),
    line(240),
    false,
  )
  assert.deepEqual(names(r), ['Alpha', 'Delta', 'Omega'])
  // 10 km off is still on the road
  assert.deepEqual(r.marks, [['gamma', 120]])
})

test('a main stop out of order along the line is dropped, and kept as a mark', () => {
  const r = deriveStops(road([['Alpha', 0], ['Beta', 100], ['Stray', 40], ['Gamma', 150], ['Omega', 200]]), line(200), false)
  assert.equal(r.gate, null)
  assert.deepEqual(names(r), ['Alpha', 'Beta', 'Gamma', 'Omega'])
  assert.deepEqual(r.marks, [['stray', 40]])
})

test('termini are km 0 and the end of the line, named as route.start/end name them', () => {
  const r = deriveStops(
    road([['Kengeri Bengaluru', 2], ['Beta', 60], ['Gamma', 120], ['Mysuru Ring Road', 178]], {
      lengthKm: 180,
      start: 'Bengaluru',
      end: 'Mysuru',
      majors: ['Bengaluru', 'Beta', 'Gamma', 'Mysuru'],
    }),
    line(180),
    false,
  )
  assert.deepEqual(names(r), ['Bengaluru', 'Beta', 'Gamma', 'Mysuru'])
  assert.equal(r.stops[0].km, 0)
  assert.equal(r.stops.at(-1).km, 180)
  assert.equal(r.stops[0].k, 'bengaluru')
})

test('stops closer than 10 km are one stop, and an end of the road always stays', () => {
  const r = deriveStops(road([['Alpha', 0], ['Near', 5], ['Beta', 50], ['Beta East', 55], ['Close', 118], ['Omega', 125]]), line(125), false)
  // Near and Close give way to the ends; of Beta and Beta East, losing Beta
  // leaves the shorter stretch behind (Alpha–Beta East, 55 km, against
  // Beta–Close, 68)
  assert.deepEqual(names(r), ['Alpha', 'Beta East', 'Omega'])
  assert.deepEqual(r.marks, [['near', 5], ['beta', 50], ['close', 118]])
})

test('a stretch over 250 km is split at the waypoint nearest its middle', () => {
  const r = deriveStops(
    road([['Alpha', 0], ['Beta', 100], ['Gamma', 290], ['Delta', 320], ['Eta', 500], ['Edge', 595], ['Omega', 600]], { majors: ['Alpha', 'Omega'] }),
    line(600, 10),
    false,
  )
  assert.deepEqual(names(r), ['Alpha', 'Beta', 'Gamma', 'Eta', 'Omega'])
  assert.deepEqual(kms(r), [0, 100, 290, 500, 600])
  // never a stop within 10 km of an existing one
  assert.deepEqual(r.marks.map(([k]) => k), ['delta', 'edge'])
})

test('a road with too many main stops is thinned to 17, keeping both ends', () => {
  const places = Array.from({ length: 25 }, (_, i) => [`Town ${String.fromCharCode(65 + i)}`, i * 20])
  const r = deriveStops(road(places), line(480, 10), false)
  assert.equal(r.stops.length, 17)
  assert.equal(r.stops[0].n, 'Town A')
  assert.equal(r.stops.at(-1).n, 'Town Y')
  assert.equal(r.marks.length, 8)
  for (let i = 1; i < r.stops.length; i++) assert.ok(r.stops[i].km - r.stops[i - 1].km <= 40)
})

test('with fewer than two major cities on the line, every place is a main stop', () => {
  const r = deriveStops(road([['Alpha', 0], ['Beta', 40], ['Gamma', 80]], { majors: ['Nowhere', 'Elsewhere'] }), line(80), false)
  assert.deepEqual(names(r), ['Alpha', 'Beta', 'Gamma'])
})

test("a major city named only in a waypoint's brackets is that waypoint", () => {
  // the Eastern Peripheral Expressway's waypoints, which matched two cities of five
  const r = deriveStops(
    road([['Kundli', 0], ['Duhai (Ghaziabad)', 40], ['Sirsa (Greater Noida)', 88], ['Palwal', 135]], {
      majors: ['Kundli', 'Baghpat', 'Ghaziabad', 'Greater Noida', 'Palwal'],
    }),
    line(135),
    false,
  )
  assert.deepEqual(names(r), ['Kundli', 'Ghaziabad', 'Greater Noida', 'Palwal'])
  // shown under the city's name, stored under the place's own key as before
  assert.deepEqual(r.stops.map((s) => s.k), ['kundli', 'duhai', 'sirsa', 'palwal'])

  // a terminus too, and "near" is no part of the name
  const ends = deriveStops(road([['Kudrail (near Etawah)', 0], ['Auraiya', 50], ['Orai', 125]], { majors: ['Etawah', 'Auraiya', 'Orai'] }), line(125), false)
  assert.deepEqual(names(ends), ['Etawah', 'Auraiya', 'Orai'])
  assert.equal(ends.stops[0].k, 'kudrail')
})

test('a city in brackets is matched exactly, by one place, and only when no place has its name', () => {
  const places = [['Bajghera (Delhi–Haryana border)', 0], ['Hajira (Surat)', 30], ['Surat', 60], ['Kamrej (Surat)', 80], ['Navsari', 120]]
  const majors = ['Delhi', 'Surat', 'Navsari']
  const r = deriveStops(road(places, { majors }), line(120), false)
  // no Delhi out of a border, and Surat once — at Surat
  assert.deepEqual(names(r), ['Bajghera (Delhi–Haryana border)', 'Surat', 'Navsari'])
  assert.deepEqual(r.marks, [['hajira', 30], ['kamrej', 80]])
  // with no Surat of its own, the first place to name it in brackets is Surat
  const bracketsOnly = deriveStops(road(places.filter(([n]) => n !== 'Surat'), { majors }), line(120), false)
  assert.deepEqual(names(bracketsOnly), ['Bajghera (Delhi–Haryana border)', 'Surat', 'Navsari'])
  assert.deepEqual(bracketsOnly.stops[1], { n: 'Surat', k: 'hajira', km: 30 })
  assert.deepEqual(bracketsOnly.marks, [['kamrej', 80]])
})

// ── names ───────────────────────────────────────────────────────────

test('no two stops go by one name: the one that is not an end of the road stays a mark', () => {
  // generated waypoints that come back to a place (NH 251 is "Una | Diu | Una | Diu")
  const r = deriveStops(road([['Una', 0], ['Diu', 40], ['Una', 80], ['Kodinar', 120], ['Diu', 160]]), line(160), false)
  assert.deepEqual(names(r), ['Una', 'Kodinar', 'Diu'])
  assert.deepEqual(r.stops.map((s) => s.k), ['una', 'kodinar', 'diu-2'])
  assert.deepEqual(r.marks, [['diu', 40], ['una-2', 80]])
  // two in the middle: the one whose loss leaves the shorter stretch goes
  const twice = deriveStops(road([['Alpha', 0], ['Beta', 30], ['Gamma', 60], ['Beta', 130], ['Omega', 200]]), line(200), false)
  assert.deepEqual(names(twice), ['Alpha', 'Gamma', 'Beta', 'Omega'])
  assert.deepEqual(twice.marks, [['beta', 30]])
})

test('a place that only holds a city in its name gives the city back to the city', () => {
  const r = deriveStops(
    road([['Gaighata', 0], ['Kolkata', 40], ['East Kolkata Wetlands', 60], ['Canning', 100]], { majors: ['Gaighata', 'Kolkata', 'Canning'] }),
    line(100),
    false,
  )
  assert.deepEqual(names(r), ['Gaighata', 'Kolkata', 'East Kolkata Wetlands', 'Canning'])
  // and keeps it when no other stop goes by it
  const alone = deriveStops(road([['Ramgarh', 0], ['Bokaro Steel City', 50], ['Dhanbad', 100]], { majors: ['Ramgarh', 'Bokaro', 'Dhanbad'] }), line(100), false)
  assert.deepEqual(names(alone), ['Ramgarh', 'Bokaro', 'Dhanbad'])
})

test('however a road repeats its places, no two of its stops share a name', () => {
  // waypoint lists that come back to places, and cities that are whole words
  // of other places: "Diu → Diu" must never come out of any of them
  let seed = 7
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647
  const pool = ['Una', 'Diu', 'Kodinar', 'Una Port', 'East Diu', 'Veraval', 'Diu (Fort)']
  let checked = 0
  for (let n = 0; n < 400; n++) {
    const count = 3 + Math.floor(rand() * 8)
    const places = Array.from({ length: count }, (_, i) => [pool[Math.floor(rand() * pool.length)], Math.round((i * 300) / (count - 1))])
    const majors = pool.filter(() => rand() < 0.5)
    const r = deriveStops(road(places, { majors: majors.length ? majors : ['Nowhere'] }), line(300), false)
    if (r.gate) continue
    checked++
    const seen = r.stops.map((s) => placeKey(s.n))
    assert.equal(new Set(seen).size, seen.length, `${places.map(([p]) => p).join(' | ')} → ${names(r).join(' → ')}`)
  }
  assert.ok(checked > 100, `only ${checked} roads got stops`)
})

test('a loop closes on its first stop: the one name a road shows twice', () => {
  const r = deriveStops(loop([['Alpha', 90], ['Beta', 180], ['Alpha', 270]]), circle(), true)
  assert.deepEqual(names(r), ['Alpha', 'Beta', 'Alpha'])
  assert.deepEqual(r.marks.map(([k]) => k), ['alpha-2'])
  assert.equal(new Set(r.stops.map((s) => s.k)).size, 3)
})

test('a road that starts and ends in one city but is no loop goes by the waypoints at its ends', () => {
  // the Bengaluru Inner Ring Road, drawn as an arc: "Bengaluru → … → Bengaluru" named neither end
  const majors = ['Bengaluru', 'Indiranagar', 'Koramangala', 'Vijaya Nagar', 'Sadashivanagar']
  const arc = road([['Indiranagar', 0], ['Koramangala', 15], ['Vijaya Nagar', 30], ['Sadashivanagar', 45]], { start: 'Bengaluru', end: 'Bengaluru', majors })
  const r = deriveStops(arc, line(45), false)
  assert.deepEqual(names(r), ['Indiranagar', 'Koramangala', 'Vijaya Nagar', 'Sadashivanagar'])
  assert.equal(r.stops[0].k, 'indiranagar')

  // and when those two are one name as well, the line is a loop that does not close
  // up 50 km, 6 km across, and back down
  const u = [...line(50), ...line(50).reverse().map((p) => [p[0] + (at(0, 6)[0] - at(0)[0]), p[1]])]
  const broken = road([['Urse', 0], ['Beta', 50], ['Gamma', 50, 6], ['Urse', 0, 6]], { lengthKm: 106 })
  assert.equal(isRing(broken, u), false)
  const out = deriveStops(broken, u, false)
  assert.equal(out.gate?.reason, 'ends')
  assert.match(out.gate.detail, /ends are 6 km apart, but both are Urse/)
})

// ── the quality gate ────────────────────────────────────────────────

test('a road that fails the gate gets no stops, and says why', () => {
  const ok = road([['Alpha', 0], ['Beta', 50], ['Gamma', 100]])
  assert.equal(deriveStops(ok, line(100), false).gate, null)
  const cases = {
    short: [road([['Alpha', 0], ['Beta', 10], ['Gamma', 20]]), line(20)],
    length: [{ ...ok, lengthKm: 200 }, line(100)],
    // the line stops 40 km short of the road's first waypoint
    ends: [road([['Alpha', -40], ['Beta', 50], ['Gamma', 100]], { lengthKm: 100 }), line(100)],
    'off-line': [
      road([['Alpha', 0], ['B', 10, 20], ['C', 20, 20], ['D', 30], ['E', 40, 20], ['F', 50, 20], ['G', 60], ['H', 70], ['I', 80], ['Omega', 100]]),
      line(100),
    ],
    order: [road([['Alpha', 0], ['B', 80], ['C', 20], ['D', 60], ['E', 40], ['Omega', 100]]), line(100)],
    stops: [road([['Alpha', 0], ['Omega', 100]]), line(100)],
    // the line as it came in jumps 40 km in one straight segment
    gap: [ok, line(100), holed(100, 30, 70)],
    // out 50 km and back down the same road, which its waypoints say it does
    retrace: [road([['Alpha', 0], ['Beta', 50], ['Alpha', 0]], { lengthKm: 100 }), [...line(50), ...line(50).reverse()]],
  }
  for (const [reason, [r, coords, raw]] of Object.entries(cases)) {
    const out = deriveStops(r, coords, false, { raw })
    assert.equal(out.gate?.reason, reason, `${reason}: ${JSON.stringify(out.gate)}`)
    assert.deepEqual(out.stops, [])
    assert.deepEqual(out.marks, [])
    assert.equal(out.coords, coords)
    assert.ok(out.gate.detail)
  }
})

test('a hole is a jump in the full line, not a straight the simplified one was left with', () => {
  const r = road([['Alpha', 0], ['Beta', 50], ['Gamma', 100]])
  // a straight road that simplifying left as one segment, with its full line
  // behind it — and a line drawn from waypoints, which has no full line at all
  assert.equal(deriveStops(r, [at(0), at(100)], false, { raw: line(100, 0.5) }).gate, null)
  assert.equal(deriveStops(r, [at(0), at(100)], false).gate, null)
  // a straight that is a small part of a long road is a greenfield expressway's
  // (the Samruddhi Mahamarg's is 24 km of 700), not a hole
  const long = road([['Alpha', 0], ['Beta', 350], ['Gamma', 700]])
  assert.equal(deriveStops(long, line(700), false, { raw: holed(700, 300, 324) }).gate, null)
  const hole = deriveStops(long, line(700), false, { raw: holed(700, 300, 340) })
  assert.equal(hole.gate?.reason, 'gap')
  assert.match(hole.gate.detail, /jumps 40 km in a straight line at km 300/)
})

test('a line out and back down one road is no loop, though its road ends where it starts', () => {
  // NH 744A: Kadachanenthal out to Vadipatti and back down the same road
  const r = road([['Alpha', 0], ['Beta', 25], ['Gamma', 50], ['Delta', 25, 0.05], ['Alpha', 0, 0.05]], { lengthKm: 100 })
  const there = line(50)
  const back = line(50).reverse().map((p) => [p[0] + (at(0, 0.05)[0] - at(0)[0]), p[1]])
  const coords = [...there, ...back]
  assert.equal(isRing(r, coords), true)
  const out = deriveStops(r, coords, true)
  assert.equal(out.gate?.reason, 'retrace')
  assert.match(out.gate.detail, /^\d+% of the line runs back over another part of it$/)
  assert.deepEqual(out.stops, [])
})

test('a road that doubles back for a while is still cut; one that is mostly there and back is not', () => {
  // out 85 km and 15 km back down the same road: both sides of the shared part
  // count, about a quarter of the line, like the generated roads that do this
  const spur = (back) => {
    const out = 100 - back
    const coords = [...line(out), ...line(out).reverse().filter((p) => p[1] >= at(out - back)[1]).slice(1)]
    return deriveStops(road([['Alpha', 0], ['Beta', 40], ['Gamma', out - back]], { lengthKm: 100 }), coords, false)
  }
  const some = spur(15)
  assert.equal(some.gate, null, JSON.stringify(some.gate))
  assert.deepEqual(names(some), ['Alpha', 'Beta', 'Gamma'])
  // out 75 and 25 back is nearly half the line twice
  const most = spur(25)
  assert.equal(most.gate?.reason, 'retrace')
  assert.match(most.gate.detail, /^4\d% of the line/)
})

test('a road that winds back and forth up a hill is not running back over itself', () => {
  // 2 km legs 100 m apart: each leg lies beside the next, but only a few km
  // further along the line, which is what a hairpin is
  const coords = []
  for (let leg = 0; leg < 20; leg++) {
    const [a, b] = leg % 2 ? [2, 0] : [0, 2]
    coords.push(at(leg * 0.1, a), at(leg * 0.1, b))
  }
  const km = cumulativeKm(coords).at(-1)
  const r = {
    lengthKm: km,
    route: { start: 'Alpha, Kerala', end: 'Gamma, Kerala', majorCities: ['Alpha', 'Beta', 'Gamma'] },
    waypoints: [
      { name: 'Alpha', coords: coords[0] },
      { name: 'Beta', coords: coords[20] },
      { name: 'Gamma', coords: coords.at(-1) },
    ],
  }
  const out = deriveStops(r, coords, false)
  assert.equal(out.gate, null, JSON.stringify(out.gate))
})

test('the gate checks a line reaches each end, on the line it was given', () => {
  const r = road([['Alpha', 0], ['Beta', 100], ['Gamma', 200]])
  // the end 30 km short of Gamma, but a long line still covers its length
  const short = line(170)
  const out = deriveStops({ ...r, lengthKm: 180 }, short, false)
  assert.equal(out.gate?.reason, 'ends')
  assert.match(out.gate.detail, /ends 30 km from Gamma/)
})
