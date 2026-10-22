// node --test scripts/contracts.test.mjs — the few things the browser, the API
// and the build each keep their own copy of, held together. Each side has
// tests of its own rules; these only check that the copies still agree, so a
// change made on one side fails here instead of in somebody's stored review.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { buildStretches, expandRange, isRangeKey, rangeKey, ALL as CLIENT_ALL } from '../src/stretches.ts'
import { canonicalRange } from '../api/_lib/ratings-math.ts'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

/** The right-hand side of `const NAME = …` as written, exported or not. Read as
 *  text rather than imported, so a file that cannot load in Node (ratings.ts
 *  pulls in the map) can still be checked. */
function constant(src, name, path) {
  const m = src.match(new RegExp(`^\\s*(?:export\\s+)?const\\s+${name}\\s*(?::[^=]+)?=\\s*(.+)$`, 'm'))
  assert.ok(m, `no \`const ${name} = …\` in ${path}`)
  return m[1].trim()
}

const regexOf = (rhs, path) => {
  // anchored both ends, so the first `$/` closes it whatever comment follows
  const m = rhs.match(/^\/(\^.*?\$)\/([a-z]*)/)
  assert.ok(m, `${path}: not a regex literal: ${rhs}`)
  return { source: m[1], flags: m[2] }
}
const stringOf = (rhs, path) => {
  const m = rhs.match(/^(['"])([^'"]*)\1/)
  assert.ok(m, `${path}: not a string literal: ${rhs}`)
  return m[2]
}
const numberOf = (rhs, path) => {
  const m = rhs.match(/^(\d+)\b/)
  assert.ok(m, `${path}: not a number literal: ${rhs}`)
  return Number(m[1])
}

const SERVER = 'api/_lib/ratings-math.ts'
const CLIENT = 'src/stretches.ts'
const PANEL = 'src/ratings.ts'

test('RANGE_KEY and ALL read the same in the API and the browser', () => {
  const server = read(SERVER)
  const client = read(CLIENT)
  // a key the browser builds and the API turns away is a review nobody can save
  assert.deepEqual(regexOf(constant(client, 'RANGE_KEY', CLIENT), CLIENT), regexOf(constant(server, 'RANGE_KEY', SERVER), SERVER))
  assert.equal(stringOf(constant(client, 'ALL', CLIENT), CLIENT), stringOf(constant(server, 'ALL', SERVER), SERVER))
})

test('REVIEW_MAX reads the same in the API and the composer', () => {
  // the textarea's maxlength and counter, against the length the API accepts
  assert.equal(
    numberOf(constant(read(PANEL), 'REVIEW_MAX', PANEL), PANEL),
    numberOf(constant(read(SERVER), 'REVIEW_MAX', SERVER), SERVER),
  )
})

test('the map and the panel paint scores in the same six colours, in both themes', () => {
  const theme = read('src/theme.ts')
  const css = read('src/styles.css')
  // MAP_COLORS lists light first, then dark; each has one `scores: ['#…', …RATED]`
  assert.ok(theme.indexOf('light: {') < theme.indexOf('dark: {'), 'MAP_COLORS order changed')
  const hexes = (s) => [...s.matchAll(/'(#[0-9a-f]{6})'/gi)].map((x) => x[1].toLowerCase())
  const rated = theme.match(/const RATED = \[([^\]]*)\]/)
  assert.ok(rated, 'no RATED list in theme.ts')
  // (the interface's `scores: [string, …]` has no colours, so it is not matched)
  const map = [...theme.matchAll(/scores:\s*\[('#[^\]]*)\]/g)].map((m) =>
    hexes(m[1].replace('...RATED', rated[1])),
  )
  assert.equal(map.length, 2, 'expected scores for light and dark in theme.ts')

  const dark = css.indexOf("[data-theme='dark'] {")
  assert.ok(dark > 0, "no [data-theme='dark'] block in styles.css")
  const tokens = (block) => {
    const out = []
    for (const m of block.matchAll(/--score-(\d):\s*(#[0-9a-f]{6})/gi)) out[Number(m[1])] = m[2].toLowerCase()
    return out
  }
  const light = tokens(css.slice(0, dark))
  assert.deepEqual(light, map[0], 'light --score-0..5 vs MAP_COLORS.light.scores')
  // the dark block overrides only what differs, so read it over the light one
  const darkTokens = Object.assign([...light], tokens(css.slice(dark, css.indexOf('}', dark))))
  assert.deepEqual(darkTokens, map[1], 'dark --score-0..5 vs MAP_COLORS.dark.scores')
})

const NH44 = new URL('../public/data/shapes/nh-44.json', import.meta.url)

test(
  'NH 44 as built: stretches from Srinagar to Kanyakumari, every range one the API keeps as it is',
  { skip: !existsSync(NH44) && 'public/data/shapes/nh-44.json is not built — run `npm run data`' },
  () => {
    const shape = JSON.parse(readFileSync(NH44, 'utf8'))
    const { marks } = shape.properties
    const s = buildStretches(shape)
    assert.ok(s.length >= 8, `only ${s.length} stretches`)
    assert.equal(s[0].fromName, 'Srinagar')
    assert.equal(s.at(-1).toName, 'Kanyakumari')
    // the build's km and the browser's measure of the same line agree
    assert.ok(Math.abs(s.at(-1).kmTo - shape.properties.km) < 0.2, `${s.at(-1).kmTo} vs ${shape.properties.km}`)

    // Every run a person can pick is a key the API stores unchanged, and that
    // key reads back as the same run.
    for (let i0 = 0; i0 < s.length; i0++) {
      for (let i1 = i0; i1 < s.length; i1++) {
        const key = rangeKey(s, i0, i1)
        if (i0 === 0 && i1 === s.length - 1) assert.equal(key, CLIENT_ALL)
        assert.ok(isRangeKey(key), key)
        assert.equal(canonicalRange(key), key)
        assert.deepEqual(expandRange(s, key, marks), [i0, i1], key)
      }
    }
    // A review stored against a place that is not a stop any more still lands
    // on the road, and is a key the API would have taken.
    for (const [k] of marks ?? []) {
      const key = [k, s[0].fromKey].sort().join('--')
      assert.equal(canonicalRange(key), key)
      assert.ok(expandRange(s, key, marks), `${key} does not place`)
    }
  },
)
