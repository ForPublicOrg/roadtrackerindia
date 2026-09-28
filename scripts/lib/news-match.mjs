/**
 * Decides whether a news headline is about one particular road, and what to
 * ask Google News for it.
 *
 * Google News search matches words anywhere on an article's page — its sidebar,
 * its "also read" links — and treats numbers loosely: "NH 342" returns Navy Day
 * coverage and a Boston Herald story, "SH 29" returns Texas. The RSS feed gives
 * nothing but the headline, so the headline is what gets checked, and a story is
 * kept only if its headline names the road:
 *
 *   - by number      "NH-161", "National Highway 161", "SH 29", "NE-4"
 *   - by name        "Ganga Expressway", "Atal Setu", "Samruddhi Mahamarg"
 *   - by its two ends, joined and followed by a road word — "Srinagar-Leh highway"
 *
 * A number or name that could mean more than one road also needs a place on
 * this road in the same headline:
 *
 *   - state-highway and district-road numbers restart in every state;
 *   - every NH number up to 235 was in use before the 2010 renumbering, and the
 *     press still says "NH-8" for Gurugram's highway (now NH 48) while today's
 *     NH 8 runs through Assam and Tripura;
 *   - generic names ("Outer Ring Road" — six cities have one) and abbreviations
 *     ("MC Road", "ORR").
 *
 * Everything here is pure: no network, no file system. `scripts/fetch-news.mjs`
 * does the fetching, and `news-match.test.mjs` pins the rules down.
 */

// ── text normalisation ──────────────────────────────────────────────

/** Renamed cities, and spellings the press still uses — folded to one form. */
const TOKEN_ALIAS = {
  bangalore: 'bengaluru', mysore: 'mysuru', mangalore: 'mangaluru', belgaum: 'belagavi',
  gulbarga: 'kalaburagi', bijapur: 'vijayapura', hubli: 'hubballi', shimoga: 'shivamogga',
  tumkur: 'tumakuru', bellary: 'ballari', chikmagalur: 'chikkamagaluru', hospet: 'hosapete',
  gurgaon: 'gurugram', bombay: 'mumbai', madras: 'chennai', calcutta: 'kolkata',
  pondicherry: 'puducherry', trivandrum: 'thiruvananthapuram', cochin: 'kochi',
  calicut: 'kozhikode', trichur: 'thrissur', alleppey: 'alappuzha', quilon: 'kollam',
  cannanore: 'kannur', palghat: 'palakkad', allahabad: 'prayagraj', baroda: 'vadodara',
  poona: 'pune', orissa: 'odisha', uttaranchal: 'uttarakhand', benares: 'varanasi',
  banaras: 'varanasi', vizag: 'visakhapatnam', trichy: 'tiruchirappalli',
  tiruchi: 'tiruchirappalli', tuticorin: 'thoothukudi', nasik: 'nashik', cuddapah: 'kadapa',
  tanjore: 'thanjavur', simla: 'shimla', gauhati: 'guwahati', chattisgarh: 'chhattisgarh',
  eway: 'expressway', expy: 'expressway', expwy: 'expressway',
}

/** Multi-word forms, applied after TOKEN_ALIAS. */
const PHRASE_ALIAS = [
  ['e way', 'expressway'],
  ['j and k', 'jammu and kashmir'],
  ['n h', 'nh'],
  ['s h', 'sh'],
]

/**
 * Lower-case, accent-free, punctuation-free, aliases folded, and padded with a
 * space at each end so that `t.includes(' nh 44 ')` is a whole-word test.
 */
export function norm(s) {
  let t = ` ${s}`
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
  t = ` ${t.trim()} `
    .replace(/ (nh|sh|ne|mdr|odr)(?=\d)/g, ' $1 ')
    .split(' ')
    .map((w) => TOKEN_ALIAS[w] ?? w)
    .join(' ')
  for (const [from, to] of PHRASE_ALIAS) t = t.replaceAll(` ${from} `, ` ${to} `)
  return t.replace(/ +/g, ' ')
}

const has = (t, phrase) => t.includes(` ${phrase} `)
const dashes = (s) => s.replace(/[‐‑‒–—―]/g, '-').replace(/\s+/g, ' ')

// ── road numbers ────────────────────────────────────────────────────

/**
 * Every standard road number in a piece of text. Case matters: "NH 130CD" has
 * suffix CD, "NH 44 in Kashmir" has none, and "NH-44A" is not NH 44. A suffix
 * is only read when it is attached — "NH 548C", "NH-548-C".
 */
const REF_SCAN = new RegExp(
  String.raw`(?<![A-Za-z0-9])(NH|NE|SH|MDR|ODR|N\.H\.|S\.H\.|[Nn]ational [Hh]ighway|[Nn]ational [Ee]xpressway|[Ss]tate [Hh]ighway|[Mm]ajor [Dd]istrict [Rr]oad|[Oo]ther [Dd]istrict [Rr]oad)` +
    String.raw`\s*(?:-\s*)?(?:[Nn]o\.?\s*)?(\d{1,4})(?:-?([A-Z]{1,3}))?(?![A-Za-z0-9])`,
  'g',
)

const KIND_OF = {
  'national highway': 'NH',
  'national expressway': 'NE',
  'state highway': 'SH',
  'major district road': 'MDR',
  'other district road': 'ODR',
}

/**
 * `{ kind, num, suffix }` for each road number in the text —
 * "NH 130CD" → `{ kind: 'NH', num: 130, suffix: 'CD' }`. Non-standard
 * designations ("SH-U 10", "MDR KJ-M-10") are not numbers any newspaper
 * prints, and are not returned.
 */
export function findRefs(text) {
  const out = []
  for (const m of dashes(text).matchAll(REF_SCAN)) {
    const kind = KIND_OF[m[1].toLowerCase()] ?? m[1].replace(/\./g, '').toUpperCase()
    out.push({ kind, num: Number(m[2]), suffix: m[3] ?? '' })
  }
  return out
}

export const refKey = (r) => `${r.kind} ${r.num}${r.suffix}`

/** How each kind of number is written in a headline (dashes already unified). */
const KIND_PATTERN = {
  NH: String.raw`NH|N\.\s?H\.|[Nn]ational\s+[Hh]ighway`,
  NE: String.raw`NE|N\.\s?E\.|[Nn]ational\s+[Ee]xpressway`,
  SH: String.raw`SH|S\.\s?H\.|[Ss]tate\s+[Hh]ighway`,
  MDR: String.raw`MDR|M\.D\.R\.|[Mm]ajor\s+[Dd]istrict\s+[Rr]oad`,
  ODR: String.raw`ODR|O\.D\.R\.|[Oo]ther\s+[Dd]istrict\s+[Rr]oad`,
}

/** Finds this exact number in a headline — and not NH 44A, or NH 441, for NH 44. */
function refRegex({ kind, num, suffix }) {
  const lead =
    String.raw`(?<![A-Za-z0-9])(?:${KIND_PATTERN[kind]})\s*(?:\([A-Z]{2,3}\)\s*)?(?:[-:]\s*)?` +
    String.raw`(?:[Nn]o\.?\s*|[Nn]umber\s*)?0*${num}`
  const tail = suffix
    ? String.raw`-?${suffix}(?![A-Za-z0-9])`
    : String.raw`(?![0-9])(?!-?[A-Z]{1,3}(?![A-Za-z0-9]))`
  return new RegExp(lead + tail)
}

/** The highest number the pre-2010 NH scheme reached. */
const OLD_SCHEME_MAX = 235

// ── names and places ────────────────────────────────────────────────

/** Words that say what kind of road something is, not which one. */
const GENERIC = new Set(
  (
    'road roads marg path ring outer inner regional peripheral expressway express highway ' +
    'freeway bypass elevated link flyover flyway corridor bridge setu sea tunnel eastern western ' +
    'northern southern east west north south central main coastal coast marine drive trunk grand ' +
    'great satellite town city new old national state district major other feet foot radial ' +
    'access controlled economic super communication service industrial greenfield project ' +
    'section extension urban phase the of and to india indian nh sh ne mdr odr ii iii i'
  ).split(' '),
)

/** Programmes that span many roads — never a name for any one of them. */
const PROGRAMME = /\b(golden quadrilateral|bharatmala|sagarmala)\b/

/** Place names on the map that are also everyday words in a headline. */
const PLACE_STOP = new Set(
  (
    'fort pen more mill camp bank dam gate hill hills border road junction chowk bazar bazaar ' +
    'market nagar colony station city town village new old main sector block phase cantonment ' +
    'midc sipcot garden city bridge port beach lake park temple airport'
  ).split(' '),
)

/** State names as a headline writes them. "UP" is checked case-sensitively. */
const STATE_ALIASES = {
  'Jammu and Kashmir': ['jammu and kashmir', 'kashmir', 'jammu'],
  'Andhra Pradesh': ['andhra pradesh', 'andhra'],
  'Himachal Pradesh': ['himachal pradesh', 'himachal'],
  'Arunachal Pradesh': ['arunachal pradesh', 'arunachal'],
  'West Bengal': ['west bengal', 'bengal'],
  'Andaman and Nicobar Islands': ['andaman', 'nicobar'],
  'Dadra and Nagar Haveli and Daman and Diu': ['dadra', 'nagar haveli', 'daman', 'diu'],
}

/** Words that make "A–B …" a road rather than a flight, a train or a rivalry. */
const PAIR_ROAD_WORDS = 'road|roads|highway|highways|nh|sh|stretch|lane|laning|widening|bypass|toll|marg|ghat|tunnel'

/** "Ariyathidal–Papanasam District road", "Srinagar–Kanyakumari Highway", "Adoni - Gadwal Road" */
const ENDS_NAME = /^(.+?)\s+(national highway|state highway|district road|highway|road)$/i
/** Between the two ends of a name: an en/em dash, or a hyphen with spaces round it. */
const END_SPLIT = /\s*[–—]\s*|\s+-\s+/
/** Alternate names that are really notes: "Formed from parts of the former NH 31…" */
const DESCRIPTIVE = /\b(old|former|formed|largely|part of|parts of|section|stretch|includes|numbering|previously|originally|spur)\b/i
/** A designation on its own, which is a number and not a name: "SH-U 10", "MDR Cachar 001". */
const BARE_DESIGNATION = /^(NH|NE|SH|MDR|ODR|SCR)\b[\s-]*[A-Z0-9-]*\s*[\dA-Z]*$/i

const town = (s) => s.split(',')[0].trim()
/** "Mysuru Access Controlled" → "Mysuru", "Puducherry coastal" → "Puducherry" */
function trimGeneric(s) {
  const w = s.trim().split(/\s+/)
  while (w.length && GENERIC.has(norm(w[w.length - 1]).trim())) w.pop()
  while (w.length && GENERIC.has(norm(w[0]).trim())) w.shift()
  return w.join(' ')
}
const stripParens = (s) => s.replace(/\([^)]*\)/g, ' ').replace(/\s+—.*$/, '').replace(/\s+/g, ' ').trim()
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** "Outer Ring Road", "MC Road", "ORR" — true when the name alone cannot pick one road. */
function isGenericName(phrase) {
  if (PROGRAMME.test(phrase)) return true
  const left = phrase.split(' ').filter((w) => w && !GENERIC.has(w) && !/^\d+$/.test(w))
  if (!left.length) return true
  // an abbreviation on its own — MC Road, GT Road, ORR, ECR — is used all over
  // India; "KMP Expressway" and "DND Flyway" are the kind that name one road
  if (left.join('').length <= 3) return !/\b(expressway|flyway)\b/.test(phrase)
  return false
}

// ── per-road identifiers ────────────────────────────────────────────

/**
 * Everything that could identify a road in a headline, before the corpus-wide
 * pass decides which of those are ambiguous.
 */
function identifiers(road) {
  const hand = road.provenance !== 'osm'
  const states = road.route?.states ?? []
  const strong = new Set() // states, the towns at each end, major cities
  const weak = new Set() // every other waypoint — only ever confirms a road number
  const addPlace = (set, name) => {
    const p = norm(name).trim()
    if (p.length >= 3 && !PLACE_STOP.has(p) && !GENERIC.has(p) && !/^\d+$/.test(p)) set.add(p)
  }
  for (const s of states) for (const a of STATE_ALIASES[s] ?? [s]) addPlace(strong, a)
  for (const c of [town(road.route?.start ?? ''), town(road.route?.end ?? ''), ...(road.route?.majorCities ?? [])])
    addPlace(strong, c)
  // a hand-written road's waypoints are towns someone chose; a generated road's
  // are whatever villages OSM put along it
  for (const w of road.waypoints ?? []) addPlace(hand ? strong : weak, w.name)

  const refs = new Map()
  const addRef = (r) => refs.set(refKey(r), r)
  for (const r of findRefs(road.ref)) addRef(r)
  // "NH 34 (old numbering, Dalkhola–Kolkata)" is a number this road no longer has
  for (const a of road.aka ?? []) if (!DESCRIPTIVE.test(a)) findRefs(a).forEach(addRef)

  const names = new Map() // normalised phrase → { display, forceAnchor, reversed }
  const pairs = []
  const addName = (text, forceAnchor = false) => {
    if (DESCRIPTIVE.test(text)) return
    const clean = stripParens(text)
    if (!clean || BARE_DESIGNATION.test(clean) || findRefs(clean).length) return
    const ends = (clean.match(ENDS_NAME)?.[1].split(END_SPLIT) ?? []).map(trimGeneric).filter(Boolean)
    if (ends.length >= 2) {
      // nobody headlines "Ariyathidal–Papanasam District road", but they do
      // write "Ariyathidal-Papanasam road": the two ends are the identifier
      pairs.push([ends[0], ends[ends.length - 1]])
      return
    }
    const phrase = norm(clean).trim()
    if (phrase.length < 3) return
    const prev = names.get(phrase)
    names.set(phrase, { display: clean, forceAnchor: forceAnchor || !!prev?.forceAnchor, reversed: false })
    // "Agra–Lucknow Expressway" is headlined both ways round
    const parts = clean.split(END_SPLIT)
    if (parts.length === 2) {
      const words = parts[1].split(' ')
      const cut = words.findIndex((w) => GENERIC.has(norm(w).trim()))
      if (cut > 0) {
        const b = words.slice(0, cut).join(' ')
        const suffix = words.slice(cut).join(' ')
        const rev = `${b}–${parts[0]} ${suffix}`
        const revPhrase = norm(rev).trim()
        if (!names.has(revPhrase)) names.set(revPhrase, { display: rev, forceAnchor, reversed: true })
      }
    }
  }
  addName(road.ref)
  addName(road.name)
  for (const a of road.aka ?? []) addName(a)
  const start = town(road.route?.start ?? '')
  const end = town(road.route?.end ?? '')
  if (start && end) pairs.push([start, end])

  // A hand-written newsQuery is the author saying how this road gets written
  // up. Quoted phrases are its names (or numbers); the words outside the quotes
  // are the places that tell it apart — `"Atal Setu" Mumbai`.
  if (road.newsQuery) {
    const anchors = norm(road.newsQuery.replace(/"[^"]*"/g, ' '))
      .trim()
      .split(' ')
      .filter((w) => w.length >= 3 && !GENERIC.has(w))
    for (const a of anchors) strong.add(a)
    for (const [, q] of road.newsQuery.matchAll(/"([^"]+)"/g)) {
      const qRefs = findRefs(q)
      if (qRefs.length) qRefs.forEach(addRef)
      else addName(q, anchors.length > 0)
    }
  }

  return { hand, states, strong, weak, refs, names, pairs }
}

function refScope(r, road) {
  // SH and district numbers restart in every state
  return r.kind === 'NH' || r.kind === 'NE' ? refKey(r) : `${refKey(r)}@${(road.route?.states ?? []).join('+')}`
}

const pairKey = (a, b) => [norm(a).trim(), norm(b).trim()].sort().join('|')

// ── matchers ────────────────────────────────────────────────────────

/**
 * One matcher per road, built together because whether "Outer Ring Road", "SH
 * 29" or "Delhi–Mumbai" is ambiguous depends on how many roads share it.
 *
 * @returns {Map<string, { id: string, queries: string[], searchable: boolean, test: (title: string) => boolean }>}
 */
export function buildMatchers(roads) {
  const ids = new Map(roads.map((r) => [r.id, identifiers(r)]))

  const nameCount = new Map()
  const refCount = new Map()
  const pairCount = new Map()
  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1)
  for (const road of roads) {
    const x = ids.get(road.id)
    for (const p of x.names.keys()) bump(nameCount, p)
    for (const r of x.refs.values()) bump(refCount, refScope(r, road))
    for (const k of new Set(x.pairs.map(([a, b]) => pairKey(a, b)))) bump(pairCount, k)
  }

  // "Ring Road" sits inside "Outer Ring Road", which is a different road
  const allNames = [...nameCount.keys()]
  const longerThan = new Map()
  for (const p of allNames) {
    const inside = allNames.filter((q) => q.length > p.length && has(` ${q} `, p))
    if (inside.length) longerThan.set(p, inside)
  }

  const out = new Map()
  for (const road of roads) {
    const x = ids.get(road.id)

    const refs = [...x.refs.values()].map((r) => ({
      ...r,
      re: refRegex(r),
      needsPlace: r.kind !== 'NH' || r.num <= OLD_SCHEME_MAX || refCount.get(refScope(r, road)) > 1,
    }))
    const ownRefs = new Set(refs.map(refKey))

    const ownTokens = new Set([...x.strong, ...x.weak].flatMap((p) => p.split(' ')).filter((w) => !GENERIC.has(w)))
    const names = [...x.names.entries()].map(([phrase, meta]) => ({
      phrase,
      display: meta.display,
      reversed: meta.reversed,
      // a name the hand-written newsQuery anchored (`"Atal Setu" Mumbai`) is
      // also vouched for by that query having returned the story
      vouched: meta.forceAnchor && !isGenericName(phrase),
      needsPlace:
        meta.forceAnchor ||
        isGenericName(phrase) ||
        nameCount.get(phrase) > 1 ||
        // an OSM street name ("Palm Beach Road", "Station Road") is only trusted
        // on its own when it carries one of the road's own place names
        (!x.hand && !phrase.split(' ').some((w) => ownTokens.has(w))),
      longer: (longerThan.get(phrase) ?? []).filter((q) => !x.names.has(q)),
    }))

    const pairs = []
    for (const [a, b] of x.pairs) {
      const na = norm(a).trim()
      const nb = norm(b).trim()
      const key = pairKey(a, b)
      if (na === nb || na.length < 3 || nb.length < 3 || PLACE_STOP.has(na) || PLACE_STOP.has(nb)) continue
      if (pairCount.get(key) > 1 || pairs.some((p) => p.key === key)) continue
      const tail = String.raw`(?:\S+ ){0,2}(?:${PAIR_ROAD_WORDS}) `
      pairs.push({
        key,
        a,
        b,
        re: new RegExp(` ${esc(na)} (?:to )?${esc(nb)} ${tail}| ${esc(nb)} (?:to )?${esc(na)} ${tail}`),
      })
    }

    const strong = [...x.strong]
    const weak = [...x.weak]
    const hasUP = x.states.includes('Uttar Pradesh')

    /**
     * @param {string} title
     * @param {{ source?: string, viaNewsQuery?: boolean }} [from] the outlet's
     *   name counts as a place ("Kashmir Observer", "Telangana Today"), and
     *   `viaNewsQuery` says the road's hand-written newsQuery returned the story
     */
    const test = (title, from = {}) => {
      const raw = dashes(title)
      const t = norm(title)
      if (has(t, 'new hampshire')) return false
      const where = `${t}${norm(from.source ?? '')}`
      const strongPlace = strong.some((p) => has(where, p)) || (hasUP && /(?<![A-Za-z])UP(?![A-Za-z])/.test(raw))
      const anyPlace = strongPlace || weak.some((p) => has(where, p))

      for (const r of refs) if (r.re.test(raw) && (!r.needsPlace || anyPlace)) return true
      for (const n of names) {
        let tt = t
        for (const q of n.longer) tt = tt.replaceAll(` ${q} `, ' \u0000 ')
        if (has(tt, n.phrase) && (!n.needsPlace || strongPlace || (n.vouched && from.viaNewsQuery))) return true
      }
      if (pairs.length) {
        // "Karode–Kanyakumari NH 66 stretch" is NH 66's news, whoever else ends there
        if (findRefs(raw).some((r) => !ownRefs.has(refKey(r)))) return false
        for (const p of pairs) if (p.re.test(t)) return true
      }
      return false
    }

    // What gets searched is a smaller set than what gets recognised: Google
    // allows a feed reader a few hundred queries a day, so every term has to
    // earn its place. A district road's number ("MDR 695") essentially never
    // reaches a headline; its two towns sometimes do. A road with a number or
    // a name is found by those, and has its towns searched only without either.
    const searchRefs = refs.filter((r) => r.kind !== 'MDR' && r.kind !== 'ODR')
    const searchNames = names.filter(
      (n) =>
        !n.reversed &&
        // an abbreviation on its own ("ORR", "ECR") brings back every
        // headline in India that uses it
        n.phrase.replace(/ /g, '').length >= 5 &&
        // a generated road's street name ("Station Road") only if it is
        // distinctive enough to stand on its own
        (x.hand || !n.needsPlace),
    )
    // One search per name, not one per spelling: "Lucknow–Agra Expressway" is
    // the same search as "Agra–Lucknow Expressway" (the test reads both), and
    // a name the road's own newsQuery already asks for is not asked twice. (A
    // number is: `"NH 50" Karnataka` would never find NH 50 in Maharashtra.)
    const quotedInQuery = new Set([...(road.newsQuery ?? '').matchAll(/"([^"]+)"/g)].map((m) => norm(m[1]).trim()))
    const signature = (s) => norm(s).trim().split(' ').sort().join(' ')
    const seenSig = new Set()
    const once = (t) => {
      const sig = signature(t)
      if (seenSig.has(sig)) return false
      seenSig.add(sig)
      return true
    }
    const terms = [
      ...searchRefs.map(refKey).filter(once),
      ...searchNames.map((n) => n.display).filter((t) => !quotedInQuery.has(norm(t).trim()) && once(t)),
      ...(searchRefs.length || searchNames.length ? [] : pairs.map((p) => `${p.a} ${p.b}`).filter(once)),
    ]
    out.set(road.id, {
      id: road.id,
      /**
       * Phrases a headline about this road would contain — what gets searched.
       * The test above still decides; a term only has to bring the right
       * headlines back.
       */
      terms: [...new Set(terms.map((s) => s.replace(/["“”]/g, '').replace(/[–—]/g, ' ').replace(/\s+/g, ' ').trim()))],
      /** The road's hand-written query, sent as it is. */
      newsQuery: road.newsQuery ?? null,
      /** False when nothing about this road could ever be recognised in a headline. */
      searchable: refs.length > 0 || names.length > 0 || pairs.length > 0,
      test,
    })
  }
  return out
}
