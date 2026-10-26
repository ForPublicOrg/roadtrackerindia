// node --test scripts/lib/   — telling a straight road from a hole, and judging what fills one
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { haversineKm } from './overpass.mjs'
import { bestRoute, between, isStraightRoad, judge, longSegments, normRef, segKey, split, summarise } from './gaps.mjs'

/** A segment of `km` running due north from [76, 27]. */
function seg(km, i = 1) {
  const a = [76, 27]
  const b = [76, 27 + km / 111.195] // a degree of latitude, as haversineKm measures it
  return { i, a, b, km: haversineKm(a, b) }
}

/** A route summary as summarise() leaves it. */
const route = ({ km, legs, coords = [], snapKm = 0, devKm = 1 }) => ({ km, legs, coords, snapKm, devKm })

test('refs compare however they are written', () => {
  assert.equal(normRef('NH 148B'), 'NH148B')
  assert.equal(normRef('nh-148b'), normRef('NH148B'))
  assert.equal(normRef('MDR002'), normRef('MDR 2'))
  assert.notEqual(normRef('NH 48'), normRef('NH 148'))
})

test('a segment is one key whichever way the line runs over it', () => {
  assert.equal(segKey([76, 27], [77, 28]), segKey([77, 28], [76, 27]))
  assert.notEqual(segKey([76, 27], [77, 28]), segKey([76, 27], [77, 28.1]))
})

test('long segments are found by the index of the point that ends them', () => {
  const s = seg(12)
  assert.deepEqual(longSegments([[75.99, 27], s.a, s.b, [76, 27.11]], 5).map((x) => x.i), [2])
})

test('points along a straight road keep every piece under the limit', () => {
  const s = seg(23)
  const line = [s.a, ...between(s.a, s.b, 5), s.b]
  assert.equal(line.length, 6)
  for (let i = 1; i < line.length; i++) assert.ok(haversineKm(line[i - 1], line[i]) <= 5)
  assert.deepEqual(between(s.a, seg(4).b, 5), [])
})

test('summarise reads length, snapping, straying and legs from an OSRM answer', () => {
  const s = seg(10)
  const mid = [76.02, 27.05]
  const r = summarise(
    {
      code: 'Ok',
      waypoints: [{ distance: 12 }, { distance: 40 }],
      routes: [
        {
          distance: 10400,
          geometry: { coordinates: [s.a, mid, s.b] },
          legs: [
            {
              steps: [
                { distance: 8000, ref: 'NH148B', mode: 'driving', intersections: [{ classes: ['motorway'] }] },
                { distance: 2400, ref: '', mode: 'ferry', intersections: [{}] },
                { distance: 0, ref: '', mode: 'driving', intersections: [{}] },
              ],
            },
          ],
        },
      ],
    },
    s,
  )
  assert.equal(r.km, 10.4)
  assert.equal(r.snapKm, 0.04)
  assert.ok(r.devKm > 1.9 && r.devKm < 2.1)
  assert.deepEqual(r.legs, [[8, 'NH148B', 'motorway'], [2.4, '', 'ferry']])
  assert.equal(summarise({ code: 'NoRoute' }, s), null)
})

test('a straight road is a route that runs along the segment itself', () => {
  const s = seg(10)
  assert.ok(isStraightRoad(s, route({ km: 10.05, legs: [], devKm: 0.02 })))
  assert.ok(!isStraightRoad(s, route({ km: 10.05, legs: [], devKm: 0.6 })), 'a road beside it is another road')
  assert.ok(!isStraightRoad(s, route({ km: 13, legs: [], devKm: 0.1 })), 'a detour is a hole')
  assert.ok(!isStraightRoad(s, route({ km: 10, legs: [], devKm: 0, snapKm: 0.4 })), 'an end off the road')
  assert.ok(!isStraightRoad(s, null))
})

test('kilometres split by the road they are on', () => {
  const r = route({ km: 10, legs: [[4, 'NH148B', ''], [3, 'NH48;NH148B', 'motorway'], [2, 'SH14', ''], [1, '', 'ferry']] })
  const out = split(r, 'NH 148B')
  assert.deepEqual(
    { own: out.own, other: out.other, none: out.none, motorway: out.motorway, ferry: out.ferry, mainOther: out.mainOther },
    { own: 7, other: 2, none: 1, motorway: 3, ferry: 1, mainOther: 'SH14' },
  )
})

const ctx = (extra) => ({ ref: 'NH 148B', category: 'nh', line: [], ...extra })

test('a route a little longer than the hole fills it', () => {
  const s = seg(40)
  const v = judge(s, route({ km: 48, legs: [[48, '', '']] }), ctx())
  assert.ok(v.ok, v.why)
})

test('a long way round is not this road (NH 148B, Kotputli to Baroda Meo)', () => {
  const s = seg(58.4)
  const v = judge(s, route({ km: 85.1, legs: [[57, 'SH14', ''], [14, 'NH48', ''], [11, 'NH248A', ''], [3, '', '']] }), ctx())
  assert.equal(v.ok, false)
  assert.match(v.why, /85\.1 km for a 58\.4 km hole/)
})

test('a winding road on its own number is still the road', () => {
  const s = seg(30)
  assert.ok(judge(s, route({ km: 55, legs: [[50, 'NH148B', ''], [5, '', '']] }), ctx()).ok)
  assert.equal(judge(s, route({ km: 55, legs: [[55, '', '']] }), ctx()).ok, false)
})

test('a long route on another number is that road; a short one may be shared', () => {
  const remnant = judge(seg(55.4), route({ km: 62.9, legs: [[50.6, 'NH334B', ''], [11.1, 'SH20', ''], [1.2, '', '']] }), ctx({ ref: 'SH 20', category: 'sh' }))
  assert.equal(remnant.ok, false)
  assert.match(remnant.why, /NH334B/)
  assert.ok(judge(seg(6), route({ km: 6.5, legs: [[6.5, 'NH48', '']] }), ctx()).ok)
})

test('an expressway hole is filled only by expressway', () => {
  const s = seg(30)
  const e = ctx({ ref: 'NE 4', category: 'expressway' })
  assert.equal(judge(s, route({ km: 33, legs: [[33, 'NH48', '']] }), e).ok, false)
  assert.ok(judge(s, route({ km: 33, legs: [[33, '', 'motorway']] }), e).ok)
})

test('a ferry, a stray end or no route leaves the hole open', () => {
  const s = seg(20)
  assert.match(judge(s, route({ km: 22, legs: [[18, '', ''], [4, '', 'ferry']] }), ctx()).why, /ferry/)
  assert.match(judge(s, route({ km: 22, legs: [[22, '', '']], snapKm: 2 }), ctx()).why, /from any road/)
  assert.match(judge(s, null, ctx()).why, /no road/)
})

test('a route back along the line itself is the stitch gone wrong (NH 709B)', () => {
  // the line runs north 30 km, then jumps 30 km straight back to its start
  const out = Array.from({ length: 31 }, (_, k) => [76, 27 + k / 110.574])
  const line = [...out, [76.0001, 27]]
  const s = { i: 31, a: line[30], b: line[31], km: haversineKm(line[30], line[31]) }
  const back = [...out].reverse().map(([x, y]) => [x + 0.0005, y])
  const v = judge(s, route({ km: 30, legs: [[30, 'NH148B', '']], coords: back }), ctx({ line }))
  assert.equal(v.ok, false)
  assert.match(v.why, /back along the road/)
})

test('of the two ways round, the one that keeps to its carriageway wins (NH 148B near Satnali)', () => {
  const s = seg(11.1)
  const uTurn = route({ km: 20.7, legs: [[20.7, 'NH148B', '']], devKm: 3 })
  const along = route({ km: 11.1, legs: [[11.1, 'NH148B', '']], devKm: 0.02 })
  assert.equal(bestRoute(s, uTurn, along), along)
  assert.equal(bestRoute(s, along, uTurn), along)
  assert.equal(bestRoute(s, uTurn, null), uTurn)
  assert.equal(bestRoute(s, null, along), along)
  // neither straight: the shorter
  const a = route({ km: 14, legs: [], devKm: 2 })
  const b = route({ km: 13, legs: [], devKm: 2 })
  assert.equal(bestRoute(s, a, b), b)
})

test('a route out to a U-turn and back down the other carriageway is not the road', () => {
  const s = seg(5)
  // 5 km north on one carriageway, back on the other 40 m east, then north again
  const north = (from, to, east = 0) => Array.from({ length: 11 }, (_, k) => [76 + east, 27 + (from + ((to - from) * k) / 10) / 111.195])
  const loop = [...north(0, 5), ...north(5, 0, 0.0004), ...north(0, 5)]
  const v = judge(s, route({ km: 14, legs: [[14, 'NH148B', '']], coords: loop }), ctx())
  assert.equal(v.ok, false)
  assert.match(v.why, /turns back on itself/)
})
