// node --test scripts/stretches-client.test.mjs — the browser's side of stretch
// reviews: cutting a shape at its stops, naming and placing ranges, scoring,
// and what this browser remembers of your entries.
// src/stretches.ts imports nothing but geo.ts, so Node can load it as it is;
// src/storage.ts needs the small bridge set up before its tests below.
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALL,
  buildStretches,
  displayKm,
  expandRange,
  intersects,
  isRangeKey,
  nearestStretch,
  rangeKey,
  rangeLabel,
  rangeWay,
  scoreRange,
  scoreStretches,
  slug,
  stretchesFC,
  stretchName,
  wayLabel,
} from '../src/stretches.ts'
import { bboxOf, cumulativeKm, haversineKm, nearestOnLine, nearestRoads, segProject, sliceLine } from '../src/geo.ts'

// A straight road due north along 77°E, one point every 0.1° of latitude. Along
// a meridian the haversine distance is exactly R·Δφ, so every km is known.
const KM_PER_DEG = (6371 * Math.PI) / 180
const coords = Array.from({ length: 31 }, (_, i) => [77, i / 10])
const L = 3 * KM_PER_DEG // ≈ 333.6 km

const near = (actual, expected, tol = 1e-6) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${actual} is not within ${tol} of ${expected}`)

function shape({ km = Math.round(L * 10) / 10, scale = 1, stops, marks } = {}) {
  return {
    type: 'Feature',
    properties: {
      id: 'test-road',
      real: true,
      km,
      stops: stops ?? [
        { n: 'Delhi', k: 'delhi', km: 0 },
        { n: 'Mathura', k: 'mathura', km: KM_PER_DEG * scale },
        { n: 'Agra', k: 'agra', km: 2 * KM_PER_DEG * scale },
        { n: 'Etawah', k: 'etawah', km: L * scale },
      ],
      marks: marks ?? [
        ['palwal', 0.4 * KM_PER_DEG * scale],
        ['kosi-kalan', 0.8 * KM_PER_DEG * scale],
        ['firozabad', 2.5 * KM_PER_DEG * scale],
      ],
    },
    geometry: { type: 'LineString', coordinates: coords },
  }
}

const road = shape()
const s = buildStretches(road)
const marks = road.properties.marks

test('buildStretches cuts the line at each stop, in road order', () => {
  assert.equal(s.length, 3)
  assert.deepEqual(
    s.map((x) => [x.i, x.fromKey, x.toKey, x.fromName, x.toName]),
    [
      [0, 'delhi', 'mathura', 'Delhi', 'Mathura'],
      [1, 'mathura', 'agra', 'Mathura', 'Agra'],
      [2, 'agra', 'etawah', 'Agra', 'Etawah'],
    ],
  )
  near(s[0].kmFrom, 0)
  near(s[0].kmTo, KM_PER_DEG, 0.02) // the shape's km is rounded to 0.1, which scales stops a hair
  near(s[1].kmTo, 2 * KM_PER_DEG, 0.02)
  near(s[2].kmTo, L) // the last stop is pinned to the end of the line
  // neighbouring stretches meet exactly, and the ends are interpolated
  assert.deepEqual(s[0].coords.at(-1), s[1].coords[0])
  near(s[0].coords[0][1], 0)
  near(s[0].coords.at(-1)[1], 1, 1e-4)
  near(s[2].coords.at(-1)[1], 3)
  assert.equal(s[0].bbox[0], 77)
  near(s[0].bbox[3], 1, 1e-4)
})

test('buildStretches scales stop km to the line as measured here', () => {
  // the shape claims half the length it really has, so every stop doubles
  const half = buildStretches(shape({ km: L / 2, scale: 0.5 }))
  near(half[0].kmTo, KM_PER_DEG, 1e-6)
  near(half[1].kmTo, 2 * KM_PER_DEG, 1e-6)
  near(half[2].kmTo, L)
  // marks scale with the stops: firozabad ships at 1.25° worth of km, which is
  // 2.5° on the line, so it lands in the last stretch rather than the middle one
  assert.deepEqual(expandRange(half, 'etawah--firozabad', [['firozabad', 1.25 * KM_PER_DEG]]), [2, 2])
})

test('buildStretches gives nothing to split for fewer than three stops', () => {
  const two = shape({ stops: [{ n: 'Delhi', k: 'delhi', km: 0 }, { n: 'Etawah', k: 'etawah', km: L }] })
  assert.deepEqual(buildStretches(two), [])
  const none = shape()
  delete none.properties.stops
  assert.deepEqual(buildStretches(none), [])
})

test('rangeKey sorts the two end stops, and every stretch is the whole road', () => {
  assert.equal(rangeKey(s, 0, 2), ALL)
  assert.equal(rangeKey(s, 2, 0), ALL)
  assert.equal(rangeKey(s, 0, 0), 'delhi--mathura')
  assert.equal(rangeKey(s, 1, 2), 'etawah--mathura')
  assert.equal(rangeKey(s, 2, 1), 'etawah--mathura')
  assert.equal(rangeKey(s, 0, 1), 'agra--delhi')
  assert.ok(isRangeKey(rangeKey(s, 1, 1)))
  assert.equal(rangeKey([], 0, 0), ALL)
})

test('expandRange places a key whichever way it is sorted', () => {
  assert.deepEqual(expandRange(s, ALL), [0, 2])
  assert.deepEqual(expandRange(s, 'delhi--mathura'), [0, 0])
  assert.deepEqual(expandRange(s, 'mathura--delhi'), [0, 0])
  assert.deepEqual(expandRange(s, 'agra--delhi'), [0, 1])
  assert.deepEqual(expandRange(s, 'etawah--mathura'), [1, 2])
  assert.deepEqual(expandRange(s, 'delhi--etawah'), [0, 2])
  // every key rangeKey makes comes back to the same stretches
  for (let a = 0; a < 3; a++) {
    for (let b = a; b < 3; b++) assert.deepEqual(expandRange(s, rangeKey(s, a, b)), [a, b])
  }
})

test('expandRange falls back to marks for keys that are no longer stops', () => {
  assert.deepEqual(expandRange(s, 'kosi-kalan--palwal', marks), [0, 0])
  assert.deepEqual(expandRange(s, 'palwal--kosi-kalan', marks), [0, 0])
  assert.deepEqual(expandRange(s, 'agra--palwal', marks), [0, 1])
  assert.deepEqual(expandRange(s, 'firozabad--palwal', marks), [0, 2])
  assert.deepEqual(expandRange(s, 'firozabad--mathura', marks), [1, 2])
  // a mark a hair before a stop does not drag the stretch behind it in
  const edge = [['jajau', 2 * KM_PER_DEG - 0.3]]
  assert.deepEqual(expandRange(s, 'etawah--jajau', edge), [2, 2])
})

test('expandRange gives up on keys it cannot place or that are not keys', () => {
  assert.equal(expandRange(s, 'nowhere--delhi', marks), null)
  assert.equal(expandRange(s, 'kosi-kalan--palwal'), null) // no marks passed
  assert.equal(expandRange(s, 'Delhi--Agra'), null)
  assert.equal(expandRange(s, 'delhi'), null)
  assert.equal(expandRange(s, 'delhi--delhi'), null)
  assert.equal(expandRange(s, 'delhi---agra'), null)
  assert.equal(expandRange(s, `${'a'.repeat(50)}--${'b'.repeat(50)}`), null)
  assert.equal(expandRange([], ALL), null)
})

test('rangeLabel reads an old-spelling range in road order, the way it was rated', () => {
  assert.equal(rangeLabel(s, ALL), 'Whole road')
  assert.equal(rangeLabel(s, 'agra--delhi'), 'Delhi → Agra')
  assert.equal(rangeLabel(s, 'etawah--mathura'), 'Mathura → Etawah')
  assert.equal(rangeLabel(s, 'firozabad--mathura', marks), 'Mathura → Etawah')
  assert.equal(rangeLabel(s, 'nowhere--delhi', marks), 'Part of the road')
  assert.equal(rangeLabel([], 'agra--delhi'), 'Part of the road')
})

test('rangeKey with a way keeps the order it was driven in, the whole road included', () => {
  assert.equal(rangeKey(s, 0, 0, 'fwd'), 'delhi>mathura')
  assert.equal(rangeKey(s, 0, 0, 'rev'), 'mathura>delhi')
  assert.equal(rangeKey(s, 1, 2, 'rev'), 'etawah>mathura')
  assert.equal(rangeKey(s, 2, 1, 'fwd'), 'mathura>etawah') // indices the wrong way round are still 1..2
  // every stretch one way is a direction, not ALL
  assert.equal(rangeKey(s, 0, 2, 'fwd'), 'delhi>etawah')
  assert.equal(rangeKey(s, 0, 2, 'rev'), 'etawah>delhi')
  assert.equal(rangeKey([], 0, 0, 'fwd'), ALL)
  for (const way of ['fwd', 'rev']) {
    for (let a = 0; a < 3; a++) {
      for (let b = a; b < 3; b++) {
        const key = rangeKey(s, a, b, way)
        assert.ok(isRangeKey(key), key)
        assert.deepEqual(expandRange(s, key), [a, b], key)
        assert.equal(rangeWay(s, key), way, key)
      }
    }
  }
})

test('rangeWay reads the direction from stops or marks, and road order from the old spelling', () => {
  assert.equal(rangeWay(s, 'agra>delhi'), 'rev')
  assert.equal(rangeWay(s, 'delhi>agra'), 'fwd')
  assert.equal(rangeWay(s, 'firozabad>palwal', marks), 'rev')
  assert.equal(rangeWay(s, 'palwal>kosi-kalan', marks), 'fwd')
  assert.deepEqual(expandRange(s, 'firozabad>palwal', marks), [0, 2])
  // sorted, so the key's own order is not the road's: Agra comes after Delhi
  assert.equal(rangeWay(s, 'agra--delhi'), 'fwd')
  assert.equal(rangeWay(s, 'firozabad--palwal', marks), 'fwd')
  assert.equal(rangeWay(s, 'nowhere--delhi', marks), null)
  assert.equal(rangeWay(s, ALL), null)
  assert.equal(rangeWay(s, 'nowhere>delhi', marks), null)
  assert.equal(expandRange(s, 'delhi>delhi'), null)
  assert.equal(expandRange(s, 'delhi>>agra'), null)
  assert.equal(expandRange(s, 'delhi-->agra'), null)
  assert.equal(expandRange(s, 'delhi>agra--etawah'), null)
})

test('rangeLabel reads a range driven one way in the order it was driven', () => {
  assert.equal(rangeLabel(s, 'delhi>agra'), 'Delhi → Agra')
  assert.equal(rangeLabel(s, 'agra>delhi'), 'Agra → Delhi')
  assert.equal(rangeLabel(s, 'firozabad>mathura', marks), 'Etawah → Mathura')
  // the whole road one way is still a direction between two places
  assert.equal(rangeLabel(s, 'etawah>delhi'), 'Etawah → Delhi')
  assert.equal(rangeLabel(s, 'nowhere>delhi', marks), 'Part of the road')
})

test('rangeLabel names a run over every stretch by its ends, and a loop by which way round', () => {
  // the two end stops in the old spelling, stored before "every stretch" was
  // keyed as ALL: driven in road order like every old one
  assert.equal(rangeLabel(s, 'delhi--etawah'), 'Delhi → Etawah')
  // ends that are no longer stops, placed by their marks, still cover it all
  const ends = shape({
    stops: [
      { n: 'Palwal', k: 'palwal', km: 0 },
      { n: 'Mathura', k: 'mathura', km: KM_PER_DEG },
      { n: 'Agra', k: 'agra', km: 2 * KM_PER_DEG },
      { n: 'Firozabad', k: 'firozabad', km: L },
    ],
    marks: [['delhi', 0], ['etawah', L]],
  })
  assert.equal(rangeLabel(buildStretches(ends), 'delhi--etawah', ends.properties.marks), 'Palwal → Firozabad')
  // a loop starts and closes on one place, under a second key
  const ring = shape({
    stops: [
      { n: 'Gachibowli', k: 'gachibowli', km: 0 },
      { n: 'Shamshabad', k: 'shamshabad', km: KM_PER_DEG },
      { n: 'Medchal', k: 'medchal', km: 2 * KM_PER_DEG },
      { n: 'Gachibowli', k: 'gachibowli-2', km: L },
    ],
    marks: [],
  })
  const loop = buildStretches(ring)
  assert.equal(rangeKey(loop, 0, loop.length - 1), ALL)
  // a part of the loop still reads by its ends, an old one in road order
  assert.equal(rangeLabel(loop, 'gachibowli--medchal'), 'Gachibowli → Medchal')
  assert.equal(rangeLabel(loop, 'gachibowli-2--shamshabad'), 'Shamshabad → Gachibowli')
  assert.equal(rangeLabel(loop, 'gachibowli-2>shamshabad'), 'Gachibowli → Shamshabad')
  // All the way round from one place to itself says which way round. The
  // test line runs due north, so a loop of it has no area; give it one.
  const square = buildStretches({
    ...ring,
    properties: { ...ring.properties, km: undefined },
    geometry: { type: 'LineString', coordinates: [[77, 0], [78, 0], [78, 1], [77, 1], [77, 0]] },
  })
  // east, north, west, south: anticlockwise in road order
  assert.equal(rangeLabel(square, rangeKey(square, 0, square.length - 1, 'fwd')), 'Whole road, anticlockwise')
  assert.equal(rangeLabel(square, rangeKey(square, 0, square.length - 1, 'rev')), 'Whole road, clockwise')
  assert.equal(rangeLabel(square, 'gachibowli--gachibowli-2'), 'Whole road, anticlockwise') // old, so road order
  assert.equal(wayLabel(square, 'fwd'), 'going anticlockwise')
  assert.equal(wayLabel(square, 'rev'), 'going clockwise')
})

const stats = (votes) => {
  const counts = {}
  for (const v of votes) counts[v] = (counts[v] ?? 0) + 1
  return { total: votes.length, sum: votes.reduce((a, b) => a + b, 0), counts }
}

const ranges = {
  [ALL]: stats([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]), // whole-road votes colour nothing
  'delhi--mathura': stats([4, 4]),
  'agra--delhi': stats([2]), // stretches 0 and 1
  'etawah--mathura': stats([5]), // stretches 1 and 2
  'nowhere--delhi': stats([1, 1, 1]), // can't be placed, so it scores nothing
}

test('scoreStretches counts overlapping ranges on every stretch they cover, ALL on none', () => {
  const sc = scoreStretches(s, ranges, marks)
  assert.equal(sc.length, 3)
  near(sc[0].mean, 10 / 3)
  assert.equal(sc[0].votes, 3)
  near(sc[1].mean, 3.5)
  assert.equal(sc[1].votes, 2)
  near(sc[2].mean, 5)
  assert.equal(sc[2].votes, 1)

  const onlyAll = scoreStretches(s, { [ALL]: stats([3]), 'delhi--mathura': stats([4]) })
  assert.deepEqual(onlyAll, [{ mean: 4, votes: 1 }, null, null])
  assert.deepEqual(scoreStretches(s, undefined), [null, null, null])
})

test('scoreRange sums the counts of every range touching the selection', () => {
  const first = scoreRange(s, ranges, 0, 0, marks)
  near(first.mean, 10 / 3)
  assert.equal(first.votes, 3)
  assert.deepEqual(first.counts, { 4: 2, 2: 1 })

  const last = scoreRange(s, ranges, 2, 2, marks)
  assert.deepEqual(last, { mean: 5, votes: 1, counts: { 5: 1 } })

  const middleOn = scoreRange(s, ranges, 2, 1, marks) // reversed indices still mean 1..2
  assert.equal(middleOn.votes, 2)
  assert.deepEqual(middleOn.counts, { 2: 1, 5: 1 })

  assert.equal(scoreRange(s, { [ALL]: stats([4]) }, 0, 2), null)
})

const ways = {
  'delhi>mathura': stats([5, 5]), // stretch 0, driven from Delhi
  'mathura>delhi': stats([1]), // stretch 0, the other carriageway
  'delhi--mathura': stats([3]), // stretch 0, before directions: road order, from Delhi
  'etawah>delhi': stats([2, 2, 2]), // every stretch, one way: the whole road
}

test('scoreStretches given a way colours each side by its own votes, never the two together', () => {
  // driven from Delhi: 5, 5 and the old 3, which was rated in road order
  assert.deepEqual(scoreStretches(s, ways, undefined, 'fwd'), [{ mean: 13 / 3, votes: 3 }, null, null])
  // the other carriageway: its 1 alone — the whole road one way colours nothing
  assert.deepEqual(scoreStretches(s, ways, undefined, 'rev'), [{ mean: 1, votes: 1 }, null, null])
  // an old rating is on the road-order side only
  assert.deepEqual(scoreStretches(s, { 'delhi--mathura': stats([4]) }, undefined, 'fwd')[0], { mean: 4, votes: 1 })
  assert.deepEqual(scoreStretches(s, { 'delhi--mathura': stats([4]) }, undefined, 'rev')[0], null)
  assert.deepEqual(scoreStretches(s, { 'delhi>mathura': stats([4]) }, undefined, 'rev')[0], null)
})

test('scoreRange given a way leaves out the other way, old ratings on the road-order side', () => {
  assert.deepEqual(scoreRange(s, ways, 0, 0, undefined, 'fwd'), { mean: 13 / 3, votes: 3, counts: { 5: 2, 3: 1 } })
  assert.deepEqual(scoreRange(s, ways, 0, 0, undefined, 'rev'), { mean: 1, votes: 1, counts: { 1: 1 } })
  assert.equal(scoreRange(s, ways, 0, 0).votes, 4)
  // nobody drove stretch 1 on its own, and the whole road one way says nothing about it
  assert.equal(scoreRange(s, ways, 1, 1, undefined, 'rev'), null)
})

test('intersects places a range driven one way like any other', () => {
  assert.equal(intersects(s, 'mathura>delhi', 0, 0), true)
  assert.equal(intersects(s, 'mathura>delhi', 1, 2), false)
  assert.equal(intersects(s, 'etawah>delhi', 1, 1), true)
})

test('intersects keeps whole-road and unplaceable reviews in every filter', () => {
  assert.equal(intersects(s, ALL, 1, 1), true)
  assert.equal(intersects(s, 'nowhere--delhi', 1, 1, marks), true)
  assert.equal(intersects(s, 'delhi--mathura', 1, 2), false)
  assert.equal(intersects(s, 'delhi--mathura', 0, 1), true)
  assert.equal(intersects(s, 'agra--delhi', 1, 1), true)
  assert.equal(intersects(s, 'etawah--mathura', 0, 0), false)
  assert.equal(intersects(s, 'etawah--mathura', 2, 0), true)
  assert.equal(intersects(s, 'kosi-kalan--palwal', 0, 0, marks), true)
  assert.equal(intersects(s, 'kosi-kalan--palwal', 1, 2, marks), false)
})

test('nearestStretch finds the stretch under a tap, within reach', () => {
  assert.equal(nearestStretch(s, [77.05, 0.5]), 0)
  assert.equal(nearestStretch(s, [76.95, 1.5]), 1)
  assert.equal(nearestStretch(s, [77, 2.9]), 2)
  assert.equal(nearestStretch(s, [79, 1.5]), null) // ~220 km off the road
  assert.equal(nearestStretch(s, [77.2, 1.5]), null) // ~22 km: past the default 15
  assert.equal(nearestStretch(s, [77.2, 1.5], 30), 1)
  assert.equal(nearestStretch([], [77, 1]), null)
})

test('displayKm states lengths in the road’s published km', () => {
  assert.equal(displayKm(s, 0, 2, 340), 340)
  assert.equal(displayKm(s, 0, 0, 340), Math.round((KM_PER_DEG * 340) / L))
  assert.equal(displayKm(s, 2, 1, 340), Math.round((2 * KM_PER_DEG * 340) / L))
  assert.equal(displayKm([], 0, 0, 340), 0)
})

test('stretchesFC carries index, rounded score and the hover line', () => {
  const fc = stretchesFC(s, scoreStretches(s, ranges, marks))
  assert.equal(fc.type, 'FeatureCollection')
  assert.equal(fc.features.length, 3)
  assert.deepEqual(
    fc.features.map((f) => f.properties),
    [
      { i: 0, score: 3, tip: 'Delhi → Mathura · ★ 3.3 · 3 ratings' },
      { i: 1, score: 4, tip: 'Mathura → Agra · ★ 3.5 · 2 ratings' },
      { i: 2, score: 5, tip: 'Agra → Etawah · ★ 5.0 · 1 rating' },
    ],
  )
  assert.equal(fc.features[0].geometry.type, 'LineString')
  assert.equal(fc.features[0].geometry.coordinates, s[0].coords)

  const unrated = stretchesFC(s, [null, null, null])
  assert.deepEqual(unrated.features[2].properties, { i: 2, score: 0, tip: 'Agra → Etawah · not rated yet' })

  // looked at the other way, each stretch is named the way it is driven
  const back = stretchesFC(s, scoreStretches(s, ways, undefined, 'rev'), 'rev')
  assert.deepEqual(back.features[0].properties, { i: 0, score: 1, tip: 'Mathura → Delhi · ★ 1.0 · 1 rating' })
  assert.equal(back.features[2].properties.tip, 'Etawah → Agra · not rated yet')
})

test('wayLabel names the end a way heads for, or which way round a loop goes', () => {
  assert.equal(wayLabel(s, 'fwd'), 'towards Etawah')
  assert.equal(wayLabel(s, 'rev'), 'towards Delhi')
  assert.equal(wayLabel([], 'fwd'), '')
  assert.equal(stretchName(s[1]), 'Mathura → Agra')
  assert.equal(stretchName(s[1], 'rev'), 'Agra → Mathura')
})

test('slug makes keys the range pattern accepts', () => {
  assert.equal(slug('Delhi'), 'delhi')
  assert.equal(slug('Kengeri (Bengaluru)'), 'kengeri')
  assert.equal(slug('Foo(Bar)Baz'), 'foobaz') // as the build does it: dropped, not spaced
  assert.equal(slug('Bāṇasavāḍi'), 'banasavadi')
  assert.equal(slug('Sawai Madhopur – NH 552'), 'sawai-madhopur-nh-552')
  assert.equal(slug('  --Port Blair--  '), 'port-blair')
  assert.equal(slug('(Bypass)', 4), 's4')
  assert.equal(slug(''), 's0')
  const long = slug('Thiruvananthapuram International Airport Junction Road')
  assert.equal(long, 'thiruvananthapuram-international-airport')
  // a cut that lands just after a word must not leave its dash behind
  assert.equal(slug(`${'a'.repeat(39)} Road`), 'a'.repeat(39))
  assert.ok(isRangeKey(`${long}-2--${slug('Kollam')}`))
})

test('geo: segProject, nearestOnLine, sliceLine, bboxOf', () => {
  const a = [77, 0]
  const b = [77, 1]
  const mid = segProject([77.1, 0.5], a, b)
  near(mid.t, 0.5)
  near(mid.distKm, 0.1 * 111.32 * Math.cos((0.5 * Math.PI) / 180), 1e-6)
  assert.equal(segProject([77, -1], a, b).t, 0)
  assert.equal(segProject([77, 2], a, b).t, 1)
  const point = segProject([77, 2], a, a) // a segment of no length is a point
  assert.equal(point.t, 0)
  near(point.distKm, 2 * 110.574, 1e-6)

  const cum = cumulativeKm(coords)
  assert.equal(cum.length, coords.length)
  near(cum.at(-1), L)
  const on = nearestOnLine([77.01, 1.55], coords, cum)
  near(on.km, 1.55 * KM_PER_DEG, 1e-6)
  near(on.distKm, 0.01 * 111.32 * Math.cos((1.55 * Math.PI) / 180), 1e-6)

  const part = sliceLine(coords, cum, 1.25 * KM_PER_DEG, 0.35 * KM_PER_DEG) // either order
  near(part[0][1], 0.35)
  near(part.at(-1)[1], 1.25)
  assert.equal(part.length, 2 + 9) // the 9 points from 0.4° to 1.2° in between
  assert.ok(part.every((p, i) => i === 0 || p[1] > part[i - 1][1]))
  const clamped = sliceLine(coords, cum, -10, L + 10)
  assert.deepEqual(clamped[0], coords[0])
  assert.deepEqual(clamped.at(-1), coords.at(-1))

  assert.deepEqual(bboxOf([[77, 1], [76, 3], [78, 2]]), [76, 1, 78, 3])
})

test('geo: nearestRoads still ranks by distance to the line', () => {
  const net = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { id: 'far', ref: 'F', name: 'Far' }, geometry: { type: 'LineString', coordinates: [[78, 0], [78, 1]] } },
      { type: 'Feature', properties: { id: 'near', ref: 'N', name: 'Near' }, geometry: { type: 'LineString', coordinates: coords } },
    ],
  }
  const r = nearestRoads([77.1, 0.5], net, 2)
  assert.deepEqual(r.map((x) => x.id), ['near', 'far'])
  near(r[0].distKm, 0.1 * 111.32 * Math.cos((0.5 * Math.PI) / 180), 1e-6)
  assert.ok(haversineKm([77, 0], [77, 1]) > 111)
})

// ── what this browser remembers of your entries: src/storage.ts ──────────────
//
// storage.ts is written for Vite: its own imports carry no extension, and
// turnstile.ts reads import.meta.env as it loads. Both are bridged for src/
// alone — the first gets its .ts, the second a stub with no captcha — so these
// tests run the file that ships. localStorage and fetch are stand-ins below.

const SRC = new URL('../src/', import.meta.url).href
const TURNSTILE_STUB =
  'data:text/javascript,export const getTurnstileToken=async()=>"";export const resetTurnstile=()=>{}'
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(SRC) && /^\.\.?\/[^.]+$/.test(specifier)) {
      if (specifier === './turnstile') return { url: TURNSTILE_STUB, shortCircuit: true }
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})

/** localStorage as a browser at quota behaves: `full` refuses every setItem
 *  while getItem and removeItem still work. */
class MemoryStorage {
  #m = new Map()
  full = false
  getItem(k) {
    return this.#m.has(k) ? this.#m.get(k) : null
  }
  setItem(k, v) {
    if (this.full) throw new Error('QuotaExceededError')
    this.#m.set(k, String(v))
  }
  removeItem(k) {
    this.#m.delete(k)
  }
}
const disk = new MemoryStorage()
globalThis.localStorage = disk

/** Every request the store makes, and what the test has the API answer. */
const calls = []
let answer = () => [500, { error: 'unexpected-request' }]
globalThis.fetch = async (url, init = {}) => {
  const call = { url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined }
  calls.push(call)
  const [status, body] = answer(call)
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const { getStore } = await import('../src/storage.ts')
const store = await getStore()

const REVIEW = 'AbCdEfGh'
const summaryOf = ({ reviews = [], ranges = {} } = {}) => {
  const votes = Object.values(ranges).reduce((n, r) => n + r.total, 0)
  return { mean: votes ? 4 : 0, votes, distribution: votes ? { 4: votes } : {}, reviews, ranges }
}
const review = (id, range) => ({ id, text: 'Smooth till Mathura', stars: 4, likes: 0, at: '2026-10-01', range })
/** DELETE answers `del`; the road's read answers with `fresh`. */
const api = (del, fresh) => {
  calls.length = 0
  answer = (c) => (c.method === 'DELETE' ? del : [200, { summaries: [{ roadId: 'x', ...fresh }] }])
}
const seed = (road, entries) => disk.setItem(`rti-mine:${road}`, JSON.stringify(entries))
const onDisk = (key) => disk.getItem(key)

test('removeEntry: a 404 whose review is still listed keeps it as yours and says so', async () => {
  disk.full = false
  const road = 'rm-review-listed'
  const mine = { 'agra--delhi': { stars: 4, reviewId: REVIEW } }
  seed(road, mine)
  // written over home Wi-Fi, deleted over mobile data: another rater key
  api(
    [404, { error: 'not-found' }],
    summaryOf({
      reviews: [review(REVIEW, 'agra--delhi')],
      ranges: { 'agra--delhi': { total: 1, sum: 4, counts: { 4: 1 } } },
    }),
  )
  await assert.rejects(store.removeEntry(road, 'agra--delhi'), { message: 'not-yours' })
  assert.deepEqual(store.getMyEntries(road), mine)
  // the check read skipped the edge-cached copy, which may predate any write
  const read = calls.find((c) => c.method === 'GET')
  assert.match(read.url, /[?&]roadId=rm-review-listed&v=\d+$/)
})

test('removeEntry: a 404 with the review gone but votes left on its range keeps it too', async () => {
  disk.full = false
  const road = 'rm-review-gone-votes-left'
  const mine = { 'agra--delhi': { stars: 4, reviewId: REVIEW } }
  seed(road, mine)
  // an evicted review leaves its stars behind, and nothing says whose these are
  api([404, { error: 'not-found' }], summaryOf({ ranges: { 'agra--delhi': { total: 2, sum: 8, counts: { 4: 2 } } } }))
  await assert.rejects(store.removeEntry(road, 'agra--delhi'), { message: 'not-yours' })
  assert.deepEqual(store.getMyEntries(road), mine)
})

test('removeEntry: stars alone are kept while their range holds any vote', async () => {
  disk.full = false
  const road = 'rm-stars-held'
  seed(road, { all: { stars: 3 } })
  api([404, { error: 'not-found' }], summaryOf({ ranges: { all: { total: 1, sum: 3, counts: { 3: 1 } } } }))
  await assert.rejects(store.removeEntry(road, 'all'), { message: 'not-yours' })
  assert.deepEqual(store.getMyEntries(road), { all: { stars: 3 } })
})

test('forgetEntry: the way out of a not-yours that can never clear — local only', async () => {
  disk.full = false
  const road = 'rm-forget'
  // Deleted, but the answer was lost: the server holds nothing for this key
  // any more, and the one vote left on the range is somebody else's.
  seed(road, { all: { stars: 3 }, 'agra--delhi': { stars: 4 } })
  api([404, { error: 'not-found' }], summaryOf({ ranges: { all: { total: 1, sum: 5, counts: { 5: 1 } } } }))
  await assert.rejects(store.removeEntry(road, 'all'), { message: 'not-yours' })
  // a tab still on the page from before stretches wrote the old key meanwhile
  disk.setItem(`rti-rating:${road}`, '3')
  calls.length = 0
  store.forgetEntry(road, 'all')
  assert.equal(calls.length, 0, 'it asks the server nothing')
  // the old key goes with it, or the next read would fold the rating back in
  assert.equal(onDisk(`rti-rating:${road}`), null)
  assert.deepEqual(store.getMyEntries(road), { 'agra--delhi': { stars: 4 } })
  // forgetting what isn't there changes nothing
  store.forgetEntry(road, 'jammu--srinagar')
  assert.deepEqual(store.getMyEntries(road), { 'agra--delhi': { stars: 4 } })
})

test('removeEntry: a 404 for what the server truly no longer holds forgets it and resolves', async () => {
  disk.full = false
  const road = 'rm-truly-gone'
  seed(road, { 'agra--delhi': { stars: 4, reviewId: REVIEW }, all: { stars: 3 } })
  // a vote on another range says nothing about this one
  const fresh = summaryOf({ ranges: { all: { total: 1, sum: 3, counts: { 3: 1 } } } })
  api([404, { error: 'not-found' }], fresh)
  assert.deepEqual(await store.removeEntry(road, 'agra--delhi'), { roadId: 'x', ...fresh })
  assert.deepEqual(store.getMyEntries(road), { all: { stars: 3 } })

  // nothing left on the road at all reads as the empty summary
  const bare = 'rm-truly-gone-bare'
  seed(bare, { all: { stars: 3 } })
  api([404, { error: 'not-found' }], summaryOf())
  assert.deepEqual(await store.removeEntry(bare, 'all'), {
    mean: 0,
    votes: 0,
    distribution: {},
    reviews: [],
    ranges: {},
  })
  assert.deepEqual(store.getMyEntries(bare), {})
  assert.equal(onDisk(`rti-mine:${bare}`), null)
})

test('removeEntry: a 404 for an entry another tab already forgot just resolves', async () => {
  disk.full = false
  // the review is still listed — but nothing here says it is yours any more
  const fresh = summaryOf({
    reviews: [review(REVIEW, 'all')],
    ranges: { all: { total: 1, sum: 4, counts: { 4: 1 } } },
  })
  api([404, { error: 'not-found' }], fresh)
  assert.deepEqual(await store.removeEntry('rm-other-tab', 'all'), { roadId: 'x', ...fresh })
})

test('removeEntry: a delete that works forgets the entry; one that fails keeps it, unread', async () => {
  disk.full = false
  const road = 'rm-ok'
  seed(road, { all: { stars: 3 }, 'agra--delhi': { stars: 4 } })
  const after = summaryOf({ ranges: { 'agra--delhi': { total: 1, sum: 4, counts: { 4: 1 } } } })
  api([200, { ok: true, summary: after }], summaryOf())
  assert.deepEqual(await store.removeEntry(road, 'all'), after)
  assert.deepEqual(store.getMyEntries(road), { 'agra--delhi': { stars: 4 } })

  api([503, { error: 'unavailable' }], summaryOf())
  await assert.rejects(store.removeEntry(road, 'agra--delhi'), { message: 'unavailable' })
  assert.deepEqual(store.getMyEntries(road), { 'agra--delhi': { stars: 4 } })
  assert.equal(calls.filter((c) => c.method === 'GET').length, 0)
})

test('migration: old keys beside a whole-road entry are newer, and win field by field', () => {
  disk.full = false
  // an old-bundle tab re-rated and wrote a review after this one migrated
  seed('mig-both', { all: { stars: 3 }, 'agra--delhi': { stars: 2 } })
  disk.setItem('rti-rating:mig-both', '5')
  disk.setItem('rti-review:mig-both', REVIEW)
  const both = { all: { stars: 5, reviewId: REVIEW }, 'agra--delhi': { stars: 2 } }
  assert.deepEqual(store.getMyEntries('mig-both'), both)
  assert.deepEqual(JSON.parse(onDisk('rti-mine:mig-both')), both)
  assert.equal(onDisk('rti-rating:mig-both'), null)
  assert.equal(onDisk('rti-review:mig-both'), null)

  // stars only: that page's rating kept the review, so the id stays
  seed('mig-stars', { all: { stars: 3, reviewId: REVIEW } })
  disk.setItem('rti-rating:mig-stars', '5')
  assert.deepEqual(store.getMyEntries('mig-stars'), { all: { stars: 5, reviewId: REVIEW } })

  // a review only: its stars stayed as they were
  seed('mig-review', { all: { stars: 3 } })
  disk.setItem('rti-review:mig-review', 'XyZ12345')
  assert.deepEqual(store.getMyEntries('mig-review'), { all: { stars: 3, reviewId: 'XyZ12345' } })

  // a value that page could not have written changes nothing
  seed('mig-junk', { all: { stars: 3 } })
  disk.setItem('rti-rating:mig-junk', '7')
  assert.deepEqual(store.getMyEntries('mig-junk'), { all: { stars: 3 } })
  assert.equal(onDisk('rti-rating:mig-junk'), null)

  // and with nothing kept the new way, they simply become the ALL entry
  disk.setItem('rti-rating:mig-fresh', '4')
  disk.setItem('rti-review:mig-fresh', REVIEW)
  assert.deepEqual(store.getMyEntries('mig-fresh'), { all: { stars: 4, reviewId: REVIEW } })
})

test('migration: storage refusing the new entry keeps the old keys, and the entry shows for the visit', () => {
  const road = 'mig-quota'
  disk.full = false
  disk.setItem(`rti-rating:${road}`, '4')
  disk.setItem(`rti-review:${road}`, REVIEW)
  disk.full = true
  const want = { all: { stars: 4, reviewId: REVIEW } }
  assert.deepEqual(store.getMyEntries(road), want)
  assert.deepEqual(store.getMyEntries(road), want) // not just on the first read
  assert.equal(onDisk(`rti-mine:${road}`), null)
  assert.equal(onDisk(`rti-rating:${road}`), '4')
  assert.equal(onDisk(`rti-review:${road}`), REVIEW)

  // once a write goes through, the old keys go
  disk.full = false
  assert.deepEqual(store.getMyEntries(road), want)
  assert.deepEqual(JSON.parse(onDisk(`rti-mine:${road}`)), want)
  assert.equal(onDisk(`rti-rating:${road}`), null)
  assert.equal(onDisk(`rti-review:${road}`), null)
})

test('storage refusing writes: your changes show back for the visit, and old keys never undo them', async () => {
  const saved = (range, stars, reviewId = null) => {
    answer = () => [200, { ok: true, summary: summaryOf(), range, stars, reviewId }]
  }

  // a whole-road re-rate is not folded back to the old stars
  const road = 'quota-rerate'
  disk.full = false
  disk.setItem(`rti-rating:${road}`, '4')
  disk.setItem(`rti-review:${road}`, REVIEW)
  disk.full = true
  saved('all', 2, REVIEW)
  await store.saveEntry(road, { stars: 2, range: 'all' })
  assert.deepEqual(store.getMyEntries(road), { all: { stars: 2, reviewId: REVIEW } })
  assert.equal(onDisk(`rti-rating:${road}`), null)

  // a stretch rating shows back though storage never took it
  saved('agra--delhi', 5)
  await store.saveEntry(road, { stars: 5, range: 'agra--delhi' })
  assert.deepEqual(store.getMyEntries(road), { all: { stars: 2, reviewId: REVIEW }, 'agra--delhi': { stars: 5 } })

  // a removed whole-road entry stays removed
  const gone = 'quota-remove'
  disk.full = false
  seed(gone, { 'agra--delhi': { stars: 3 } })
  disk.setItem(`rti-rating:${gone}`, '4')
  disk.full = true
  api([200, { ok: true, summary: summaryOf() }], summaryOf())
  await store.removeEntry(gone, 'all')
  assert.deepEqual(store.getMyEntries(gone), { 'agra--delhi': { stars: 3 } })

  // where storage works it stays the source of truth: another tab's write counts
  disk.full = false
  const shared = 'quota-shared'
  saved('all', 4)
  await store.saveEntry(shared, { stars: 4, range: 'all' })
  seed(shared, { all: { stars: 1 } })
  assert.deepEqual(store.getMyEntries(shared), { all: { stars: 1 } })
})
