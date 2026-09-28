// node --test scripts/lib/   — the rules that decide which headline belongs to which road
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMatchers, findRefs, norm } from './news-match.mjs'
import { isFeed, parseRss } from './news-feed.mjs'

const road = (id, fields) => ({
  id,
  category: 'nh',
  status: 'operational',
  lengthKm: 100,
  waypoints: [],
  sources: [],
  ...fields,
  route: { states: [], majorCities: [], ...fields.route },
})

// Shapes copied from real road files; the headlines are real ones too.
const ROADS = [
  road('nh-8', {
    ref: 'NH 8',
    name: 'Karimganj–Sabroom Highway',
    aka: ['Part of the former NH 44 (old numbering)'],
    newsQuery: '"NH 8" Tripura highway',
    route: { start: 'Karimganj, Assam', end: 'Sabroom, Tripura', states: ['Assam', 'Tripura'], majorCities: ['Karimganj', 'Agartala', 'Sabroom'] },
    waypoints: [{ name: 'Ambassa', coords: [91.8, 24.0] }],
  }),
  road('nh-44', {
    ref: 'NH 44',
    name: 'Srinagar–Kanyakumari Highway',
    aka: ['North–South Corridor', 'Formed from the former NH 1A, NH 1, NH 2, NH 3, NH 75, NH 26 and NH 7'],
    route: {
      start: 'Srinagar, Jammu and Kashmir',
      end: 'Kanyakumari, Tamil Nadu',
      states: ['Jammu and Kashmir', 'Punjab', 'Haryana', 'Delhi', 'Maharashtra', 'Tamil Nadu'],
      majorCities: ['Srinagar', 'Jammu', 'Karnal', 'Delhi', 'Nagpur', 'Kanyakumari'],
    },
  }),
  road('nh-66', {
    ref: 'NH 66',
    name: 'Panvel–Kanyakumari Highway',
    route: { start: 'Panvel, Maharashtra', end: 'Kanyakumari, Tamil Nadu', states: ['Maharashtra', 'Goa', 'Karnataka', 'Kerala', 'Tamil Nadu'], majorCities: ['Panvel', 'Kochi', 'Kanyakumari'] },
  }),
  road('nh-342', {
    ref: 'NH 342',
    name: 'Mudigubba–Chilamathur National Highway',
    provenance: 'osm',
    route: { start: 'Mudigubba, Andhra Pradesh', end: 'Chilamathur, Andhra Pradesh', states: ['Andhra Pradesh'], majorCities: ['Mudigubba', 'Chilamathur'] },
  }),
  road('sh-mp-29', {
    ref: 'SH 29',
    name: 'Vidisha–Gairatganj State Highway',
    category: 'sh',
    provenance: 'osm',
    route: { start: 'Vidisha, Madhya Pradesh', end: 'Gairatganj, Madhya Pradesh', states: ['Madhya Pradesh'], majorCities: ['Vidisha', 'Gairatganj'] },
  }),
  road('sh-ka-29', {
    ref: 'SH 29',
    name: 'Chitradurga–Hosadurga State Highway',
    category: 'sh',
    provenance: 'osm',
    route: { start: 'Chitradurga, Karnataka', end: 'Hosadurga, Karnataka', states: ['Karnataka'], majorCities: ['Chitradurga', 'Hosadurga'] },
  }),
  road('delhi-outer-ring-road', {
    ref: 'Outer Ring Road',
    name: 'Delhi Outer Ring Road',
    category: 'local',
    aka: ['ORR (Delhi)'],
    newsQuery: '"Outer Ring Road" Delhi',
    route: { start: 'Wazirabad, Delhi', end: 'Kalindi Kunj, Delhi', states: ['Delhi'], majorCities: ['Delhi', 'Munirka'] },
  }),
  road('delhi-ring-road', {
    ref: 'Ring Road',
    name: 'Delhi Ring Road',
    category: 'local',
    provenance: 'osm',
    route: { start: 'Delhi, Delhi', end: 'Delhi, Delhi', states: ['Delhi'], majorCities: ['Delhi'] },
  }),
  road('bengaluru-outer-ring-road', {
    ref: 'Outer Ring Road',
    name: 'Bengaluru Outer Ring Road',
    category: 'local',
    provenance: 'osm',
    route: { start: 'Hebbal, Karnataka', end: 'Hebbal, Karnataka', states: ['Karnataka'], majorCities: ['Bengaluru'] },
  }),
  road('ganga-expressway', {
    ref: 'Ganga Expressway',
    name: 'Ganga Expressway',
    category: 'expressway',
    route: { start: 'Meerut, Uttar Pradesh', end: 'Prayagraj, Uttar Pradesh', states: ['Uttar Pradesh'], majorCities: ['Meerut', 'Prayagraj'] },
  }),
  road('agra-lucknow-expressway', {
    ref: 'Agra–Lucknow Expressway',
    name: 'Agra–Lucknow Expressway',
    category: 'expressway',
    route: { start: 'Agra, Uttar Pradesh', end: 'Lucknow, Uttar Pradesh', states: ['Uttar Pradesh'], majorCities: ['Agra', 'Lucknow'] },
  }),
  road('atal-setu', {
    ref: 'Atal Setu',
    name: 'Atal Bihari Vajpayee Sewri–Nhava Sheva Atal Setu',
    category: 'expressway',
    aka: ['Mumbai Trans Harbour Link (MTHL)'],
    newsQuery: '"Atal Setu" Mumbai',
    route: { start: 'Sewri, Maharashtra', end: 'Chirle, Maharashtra', states: ['Maharashtra'], majorCities: ['Sewri', 'Navi Mumbai'] },
  }),
  road('mdr-tn-695', {
    ref: 'MDR 695',
    name: 'Ariyathidal–Papanasam District road',
    category: 'district',
    provenance: 'osm',
    route: { start: 'Ariyathidal, Tamil Nadu', end: 'Papanasam, Tamil Nadu', states: ['Tamil Nadu'], majorCities: ['Ariyathidal', 'Papanasam'] },
  }),
  road('tn-sugarcane-road-108', {
    ref: 'SCR',
    name: 'SCR',
    category: 'district',
    provenance: 'osm',
    route: { start: 'Tiruttani, Tamil Nadu', end: 'Tiruttani, Tamil Nadu', states: ['Tamil Nadu'], majorCities: [] },
  }),
]

const M = buildMatchers(ROADS)
const about = (id, title, from) => M.get(id).test(title, from)
const who = (title, from) => ROADS.map((r) => r.id).filter((id) => about(id, title, from))

test('road numbers: exact, suffix-aware, case-aware', () => {
  assert.deepEqual(findRefs('NH 130CD to open'), [{ kind: 'NH', num: 130, suffix: 'CD' }])
  assert.deepEqual(findRefs('NH 44 in Kashmir'), [{ kind: 'NH', num: 44, suffix: '' }])
  assert.deepEqual(findRefs('NH-548C'), [{ kind: 'NH', num: 548, suffix: 'C' }])
  assert.deepEqual(findRefs('National Highway No. 44'), [{ kind: 'NH', num: 44, suffix: '' }])
  assert.deepEqual(findRefs('Kerala State Highway 1'), [{ kind: 'SH', num: 1, suffix: '' }])
  assert.deepEqual(findRefs('SH-U 10'), [])
  assert.deepEqual(findRefs('MDR KJ-M-10'), [])
})

test('normalisation folds renamed cities and punctuation', () => {
  assert.equal(norm('Bangalore–Mysore e-way'), ' bengaluru mysuru expressway ')
  assert.equal(norm("J&K's NH44"), ' jammu and kashmir nh 44 ')
})

test('an old-scheme NH number needs a place on today’s road', () => {
  assert.ok(about('nh-8', 'Returnee groups block NH-8 in Tripura during 72-hour bandh'))
  assert.ok(about('nh-8', 'Driver Rescued After Horrific Truck Accident on NH-8 in Ambassa'))
  assert.ok(about('nh-8', 'National Highway-8 Turns Death Trap in North Tripura, Unakoti'))
  // Gurugram's "NH-8" has been NH 48 since 2010
  assert.ok(!about('nh-8', '4 children among 7 injured in NH-8 crash'))
  assert.ok(!about('nh-8', 'Cop halts NH-8 traffic in Gurugram after CNG leak'))
  // an old number listed in aka is not one of today's numbers
  assert.ok(!about('nh-8', 'Assam-Agartala NH-44 in Tripura turns death trap'))
})

test('the outlet’s name counts as a place', () => {
  const t = 'Year-Old Flyover on NH-44 Develops Major Pothole, Exposing Iron Rods'
  assert.ok(!about('nh-44', t))
  assert.ok(about('nh-44', t, { source: 'The Live Nagpur' }))
  assert.ok(about('nh-44', 'Rain havoc across J&K: NH-44 shut, landslides block roads'))
})

test('a different number is a different road', () => {
  assert.deepEqual(who('Karode–Kanyakumari NH 66 stretch likely to be completed by Dec, Kerala'), ['nh-66'])
  assert.ok(!about('nh-44', 'NH-44A widening in Punjab'))
  assert.ok(!about('nh-44', 'NH 441 in Delhi'))
})

test('a new-scheme NH number stands on its own', () => {
  assert.ok(about('nh-342', 'Woman killed as lorry hits bike on NH-342'))
  assert.ok(about('nh-342', 'Land acquisition for National Highway 342 speeded up'))
  assert.ok(!about('nh-342', 'Crash closes NH 342 in New Hampshire'))
  assert.ok(!about('nh-342', 'Navy Day celebrations in Visakhapatnam'))
})

test('state-highway numbers restart in every state', () => {
  assert.deepEqual(who('Two killed on SH-29 near Vidisha'), ['sh-mp-29'])
  assert.deepEqual(who('SH 29 repairs begin in Chitradurga'), ['sh-ka-29'])
  assert.deepEqual(who('Bicyclist Killed in Car Accident on S.H. 29 in Georgetown, TX'), [])
  assert.deepEqual(who('SH 29 closed for repairs'), [])
})

test('a generic name needs its city, and the longest name wins', () => {
  assert.deepEqual(who('DELHI: WATERLOGGING AT MUNIRKA TRIGGERS TRAFFIC SNARL ON OUTER RING ROAD'), ['delhi-outer-ring-road'])
  assert.deepEqual(who("Bengaluru's Outer Ring Road gets a dedicated bus lane"), ['bengaluru-outer-ring-road'])
  assert.deepEqual(who('Delhi plans elevated corridor to decongest Ring Road by 2030'), ['delhi-ring-road'])
  assert.deepEqual(who('Traffic jam on Outer Ring Road'), [])
})

test('a distinctive name stands on its own, either way round', () => {
  assert.ok(about('ganga-expressway', '2 dead, over 25 injured as double-decker bus overturns on Ganga Expressway'))
  assert.ok(!about('ganga-expressway', 'Jewar Airport gets new Rs 8,585 crore expressway link'))
  assert.ok(about('agra-lucknow-expressway', 'Speeding car hits truck on Lucknow-Agra Expressway'))
})

test('a newsQuery anchor vouches for what that query returned', () => {
  const t = 'FIR filed after viral video of bike-borne duo speeding on Atal Setu'
  assert.ok(!about('atal-setu', t))
  assert.ok(about('atal-setu', t, { viaNewsQuery: true }))
  assert.ok(about('atal-setu', 'Mumbai’s Atal Setu sees illegal bike ride'))
  assert.ok(about('atal-setu', 'Mumbai Trans Harbour Link toll to stay unchanged'))
})

test('a road known only by its two ends', () => {
  assert.ok(about('mdr-tn-695', 'Ariyathidal-Papanasam road to be widened'))
  assert.ok(about('mdr-tn-695', 'Papanasam to Ariyathidal stretch in bad shape'))
  assert.ok(!about('mdr-tn-695', 'Papanasam and Ariyathidal residents protest water cuts'))
  assert.ok(!about('mdr-tn-695', 'Ariyathidal-Papanasam NH 36 stretch flooded'))
})

test('queries', () => {
  assert.deepEqual(M.get('nh-342').queries, ['"NH 342"'])
  assert.deepEqual(M.get('sh-mp-29').queries, ['"SH 29" "Madhya Pradesh"'])
  assert.deepEqual(M.get('mdr-tn-695').queries, ['"Ariyathidal" "Papanasam" road'])
  assert.equal(M.get('nh-8').queries[0], '"NH 8" Tripura highway')
  assert.ok(M.get('nh-8').queries.includes('"NH 8" Assam OR Tripura'))
  for (const m of M.values()) assert.ok(m.queries.length <= 3)
  assert.equal(M.get('tn-sugarcane-road-108').searchable, false)
})

test('reading the feed', () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>
    <item><title>R&amp;B dept widens NH-342 - The Hindu</title><link>https://news.google.com/rss/articles/abc?oc=5</link>
      <pubDate>Sun, 09 Nov 2025 08:00:00 GMT</pubDate><source url="https://www.thehindu.com">The Hindu</source></item>
    <item><title><![CDATA[Road&#39;s &#x2018;fix&#x2019; - Onmanorama]]></title><link>https://news.google.com/rss/articles/def</link>
      <pubDate>Mon, 10 Nov 2025 08:00:00 GMT</pubDate><source url="https://x">Onmanorama</source></item>
    <item><title>No date</title><link>https://news.google.com/rss/articles/ghi</link></item>
  </channel></rss>`
  assert.ok(isFeed(xml))
  assert.deepEqual(parseRss(xml), [
    { title: 'R&B dept widens NH-342', url: 'https://news.google.com/rss/articles/abc?oc=5', source: 'The Hindu', date: '2025-11-09T08:00:00.000Z' },
    { title: 'Road\'s ‘fix’', url: 'https://news.google.com/rss/articles/def', source: 'Onmanorama', date: '2025-11-10T08:00:00.000Z' },
  ])
  assert.ok(!isFeed('<html><head><title>Sorry...</title></head></html>'))
})
