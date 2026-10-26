// node --test scripts/lib/   — telling a straight road from a hole, and judging what fills one
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { haversineKm } from './overpass.mjs'
import { bearing, between, choose, identity, isStraightRoad, judge, longSegments, normRef, segKey, split, summarise, trim } from './gaps.mjs'

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
                { distance: 8000, ref: 'NH148B', name: 'Narnaul Road', mode: 'driving', intersections: [{ classes: ['motorway'] }] },
                { distance: 2400, ref: '', mode: 'ferry', intersections: [{}] },
                { distance: 0, ref: '', name: '', mode: 'driving', intersections: [{}] },
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
  assert.deepEqual(r.legs, [[8, 'NH148B', 'motorway', 'Narnaul Road'], [2.4, '', 'ferry', '']])
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

test('a national highway runs on whatever number OSM still gives its tarmac (NH 703 on SH 23, NH 28 on NH 27)', () => {
  const nh = ctx({ ref: 'NH 703', category: 'nh' })
  assert.ok(judge(seg(50.3), route({ km: 57.9, legs: [[20.6, 'SH23', ''], [17.5, 'MDR65', ''], [19.8, '', '']] }), nh).ok)
  assert.ok(judge(seg(16.8), route({ km: 19.8, legs: [[19.8, 'NH27', '']] }), ctx({ ref: 'NH 28', category: 'nh' })).ok)
  // still not a long way round
  assert.equal(judge(seg(20), route({ km: 40, legs: [[40, 'NH27', '']] }), nh).ok, false)
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

test('of the ways round, the one that keeps to its carriageway wins (NH 148B near Satnali)', () => {
  const s = seg(11.1)
  const uTurn = route({ km: 20.7, legs: [[20.7, 'NH148B', '']], devKm: 3 })
  const along = route({ km: 11.1, legs: [[11.1, 'NH148B', '']], devKm: 0.02 })
  for (const routes of [[uTurn, along], [along, uTurn], [null, along, uTurn]]) {
    const v = choose(s, routes, ctx())
    assert.ok(v.straight)
    assert.equal(v.route, along)
  }
  // neither straight: the shortest the verdict takes
  const a = route({ km: 14, legs: [[14, 'NH148B', '']], devKm: 2 })
  const b = route({ km: 13, legs: [[13, 'NH148B', '']], devKm: 2 })
  const v = choose(s, [a, b], ctx())
  assert.ok(v.ok && !v.straight)
  assert.equal(v.route, b)
  // none taken: why the shortest was refused
  const far = choose(s, [route({ km: 60, legs: [[60, '', '']] }), route({ km: 50, legs: [[50, '', '']] })], ctx())
  assert.equal(far.ok, false)
  assert.match(far.why, /50\.0 km for a 11\.1 km hole/)
  assert.match(choose(s, [null, null], ctx()).why, /no road/)
})

test('pieces on opposite carriageways: only the route held to its direction is the road (Samruddhi)', () => {
  const s = seg(23.7)
  const own = identity({ ref: 'Samruddhi Mahamarg', name: 'Hindu Hrudaysamrat Balasaheb Thackeray Maharashtra Samruddhi Mahamarg' })
  const e = ctx({ own, category: 'expressway' })
  const fwd = route({ km: 91.8, legs: [[55.5, 'ME-2', '', 'Samruddhi Mahamarg'], [4.8, 'SH173', '', ''], [31.9, 'ME-2', '', 'Samruddhi Mahamarg']] })
  const back = route({ km: 70.9, legs: [[43.1, 'ME-2', '', 'Samruddhi Mahamarg'], [8.4, 'NH161', '', ''], [19.4, 'ME-2', '', 'Samruddhi Mahamarg']] })
  assert.equal(choose(s, [fwd, back], e).ok, false)
  const held = route({ km: 23.76, legs: [[23.76, 'ME-2', '', 'Samruddhi Mahamarg']], devKm: 0.03, snapKm: 0.026 })
  assert.equal(choose(s, [fwd, back, held], e).route, held)
})

test('a road is known by its number, its names, its aka and the roads merged into it', () => {
  const own = identity(
    { ref: 'Ahmedabad–Vadodara Expressway', name: 'Mahatma Gandhi Expressway', aka: ['National Expressway 1 (NE-1)', 'NH 148N (Delhi–Vadodara section)'] },
    ['ne-1'],
  )
  for (const s of ['NE 1', 'NE-1', 'Ahmedabad Vadodara Expressway', 'Mahatma Gandhi Expressway', 'NH 148N']) assert.ok(own.has(normRef(s)), s)
  const e = ctx({ own, category: 'expressway' })
  const s = seg(13.4)
  assert.ok(judge(s, route({ km: 14, legs: [[14, 'NE1', '', '']] }), e).ok, 'by number')
  assert.ok(judge(s, route({ km: 14, legs: [[14, '', '', 'Mahatma Gandhi Expressway']] }), e).ok, 'by name')
  // a longer name that holds the road's whole name is the road; a bare word is not
  const sam = ctx({ own: identity({ ref: 'Samruddhi Mahamarg' }), category: 'expressway' })
  assert.ok(judge(s, route({ km: 14, legs: [[14, '', '', 'Hindu Hrudaysamrat Samruddhi Mahamarg']] }), sam).ok)
  assert.equal(judge(s, route({ km: 14, legs: [[14, '', '', 'Expressway']] }), e).ok, false)
})

/** Points every 0.5 km north along x = 76 + east, from km `from` to km `to`. */
const north = (from, to, east = 0) => {
  const n = Math.round(Math.abs(to - from) * 2)
  return Array.from({ length: n + 1 }, (_, k) => [76 + east, 27 + (from + ((to - from) * k) / n) / 111.195])
}
const lengthOf = (coords) => coords.reduce((sum, p, k) => (k ? sum + haversineKm(coords[k - 1], p) : 0), 0)

test('a route that U-turns first and then drives the whole segment is a straight road (NH 47)', () => {
  const s = seg(6.6)
  // starts on the far carriageway, 2 km the wrong way, back past a and on to b
  const coords = [...north(0, -2, 0.0004), ...north(-2, 6.6)]
  const r = route({ km: lengthOf(coords), legs: [[lengthOf(coords), 'NH47', '']], coords, devKm: 0.04 })
  assert.ok(isStraightRoad(s, r))
  assert.ok(choose(s, [r], ctx()).straight)
  // a fill drawn from such a route leaves the out-and-back off
  const bent = [...north(0, -2, 0.0004), ...north(-2, 3), [76.02, 27 + 4.8 / 111.195], s.b]
  const v = choose(s, [route({ km: lengthOf(bent), legs: [[lengthOf(bent), 'NH47', '']], coords: bent, devKm: 2 })], ctx())
  assert.ok(v.ok, v.why)
  assert.ok(v.route.km < 9 && haversineKm(v.route.coords[0], s.a) < 0.15, `${v.route.km}`)
})

test('one route serves two lines over the same segment, either way round (NH 130CD and its expressway)', () => {
  const s = seg(5)
  const back = { i: 1, a: s.b, b: s.a, km: s.km }
  const coords = [...north(0, 2), [76.02, 27 + 3.5 / 111.195], s.b]
  const r = route({ km: 8.1, legs: [[8.1, '', '']], coords, devKm: 1.9 })
  // judged first for the line that runs b to a, then for the one that runs a to b
  assert.ok(trim(back, r).km > 8)
  assert.ok(trim(s, r).km > 8)
  assert.ok(!isStraightRoad(back, r) && !isStraightRoad(s, r))
  assert.deepEqual(trim(back, r).coords[0], s.b)
})

test('a refusal over whose road it is holds for a longer route along the same roads (SH 72 on NH 152)', () => {
  const s = seg(20)
  const coords = [...north(0, 10), [76.03, 27 + 15 / 111.195], s.b]
  const named = route({ km: 22, legs: [[22, 'NH152', '']], coords })
  const unnamed = route({ km: 22.5, legs: [[22.5, '', '']], coords: coords.map(([x, y]) => [x + 0.0003, y]) })
  const sh = ctx({ ref: 'SH 72', category: 'sh' })
  assert.match(choose(s, [named, unnamed], sh).why, /NH152/)
  // a different road is judged on its own
  const elsewhere = route({ km: 23, legs: [[23, '', '']], coords: coords.map(([x, y]) => [x - 0.05, y]) })
  assert.ok(choose(s, [named, elsewhere], sh).ok)
  // and the same road tagged with the road's own number the other way is the road (SH 168 on the Surat bypass)
  const own = route({ km: 22.5, legs: [[22.5, 'SH72', '']], coords: coords.map(([x, y]) => [x + 0.0003, y]) })
  assert.equal(choose(s, [named, own], sh).route?.legs[0][1], 'SH72')
})

test('a national highway runs on no district road, and never back over its own line (NH 544G, NH 179B)', () => {
  const nh = ctx({ ref: 'NH 544G', category: 'nh' })
  assert.match(judge(seg(10.4), route({ km: 13.5, legs: [[12.4, 'MDR068', ''], [1.1, '', '']] }), nh).why, /MDR068/)
  // the line runs 30 km north, jumps back to its start, and runs north again
  // 1 km beside itself; the road between the jump's ends is another highway
  // 500 m off both
  const out = north(0, 30)
  const line = [...out, ...north(0, 30, 0.01)]
  const s = { i: out.length, a: line[out.length - 1], b: line[out.length], km: haversineKm(line[out.length - 1], line[out.length]) }
  const coords = north(30, 0, 0.005)
  const v = judge(s, route({ km: 32, legs: [[32, 'NH179A', '']], coords }), ctx({ ref: 'NH 179B', category: 'nh', line }))
  assert.equal(v.ok, false)
  assert.match(v.why, /jumping back/)
  // a hole whose far end the line does not reach is the highway's own
  const far = [76.1, 27]
  const s2 = { i: out.length, a: s.a, b: far, km: haversineKm(s.a, far) }
  const diagonal = Array.from({ length: 31 }, (_, k) => [76 + (0.1 * k) / 30, s.a[1] + ((27 - s.a[1]) * k) / 30])
  assert.ok(judge(s2, route({ km: 32, legs: [[32, 'NH179A', '']], coords: diagonal }), ctx({ ref: 'NH 179B', category: 'nh', line: [...out, far] })).ok)
})

test('a road being built is drawn only along its own mapped road (NH 150C)', () => {
  const s = seg(6)
  const built = ctx({ ref: 'NH 150C', category: 'nh', status: 'under-construction' })
  assert.match(judge(s, route({ km: 7.3, legs: [[7.3, '', '']] }), built).why, /still being built/)
  assert.ok(judge(s, route({ km: 7.3, legs: [[7.3, 'NH150C', '']] }), built).ok)
})

test('a stitch jumping back is a hole on any road, and only drawn road counts as reaching it (SH 128, NH 179B)', () => {
  // 30 km north, a jump back to the start, 30 km north again 1 km east; the
  // road between the jump's ends is an unnumbered one 500 m off both
  const out = north(0, 30)
  const line = [...out, ...north(0, 30, 0.01)]
  const s = { i: out.length, a: line[out.length - 1], b: line[out.length], km: haversineKm(line[out.length - 1], line[out.length]) }
  const r = route({ km: 31, legs: [[31, '', '']], coords: north(30, 0, 0.005) })
  assert.match(judge(s, r, ctx({ ref: 'SH 128', category: 'sh', line })).why, /jumping back/)
  // a hole whose end only another undrawn jump comes near (NH 179B's 5.5 km
  // gap beside the 65.6 km Harur–Salem jump) is judged on the road alone
  const far = [76.1, 27]
  const ghost = [...out, far, [76.01, s.a[1]]]
  const g = { i: out.length, a: s.a, b: far, km: haversineKm(s.a, far) }
  const diagonal = route({ km: 33, legs: [[33, '', '']], coords: Array.from({ length: 31 }, (_, k) => [76 + (0.1 * k) / 30, s.a[1] + ((27 - s.a[1]) * k) / 30]) })
  assert.match(judge(g, diagonal, ctx({ ref: 'SH 128', category: 'sh', line: ghost })).why, /jumping back/)
  assert.ok(judge(g, diagonal, ctx({ ref: 'SH 128', category: 'sh', line: ghost, undrawn: new Set([out.length + 1]) })).ok)
})

test('nothing fills a planned road but its own straight line', () => {
  const s = seg(8.9)
  const p = ctx({ ref: 'Hyderabad Regional Ring Road', category: 'expressway', status: 'planned', own: identity({ ref: 'RRR', aka: ['NH 161AA (northern section)'] }) })
  assert.match(judge(s, route({ km: 15.3, legs: [[10.4, 'NH161AA', ''], [4.9, '', '']] }), p).why, /planned/)
  assert.ok(choose(s, [route({ km: 8.95, legs: [], devKm: 0.02 })], p).straight)
  assert.ok(!identity({ aka: ['NH 161AA (northern section)'] }).has('NORTHERNSECTION'))
})

test('a bearing is the compass direction from a to b', () => {
  assert.equal(bearing([76, 27], [76, 28]), 0)
  assert.equal(bearing([76, 27], [77, 27]), 90)
  assert.equal(bearing([76, 28], [76, 27]), 180)
  assert.equal(bearing([76.78859, 20.21376], [76.56286, 20.18812]), 263)
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
