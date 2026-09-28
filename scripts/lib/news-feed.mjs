/**
 * Reading a Google News RSS feed. Pure — `scripts/fetch-news.mjs` does the
 * fetching, `news-match.test.mjs` covers this too.
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decode(s) {
  return s
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
    .replace(/\s+/g, ' ')
    .trim()
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`))
  return m ? decode(m[1].trim()) : ''
}

/** Throttling and errors come back as an HTML page, never as an empty feed. */
export const isFeed = (xml) => /<rss[\s>]/.test(xml) && xml.includes('<channel>')

/** `{ title, url, source, date }` for every usable item, in feed order. */
export function parseRss(xml) {
  const items = []
  for (const block of xml.split('<item>').slice(1)) {
    const raw = tag(block, 'title')
    const url = tag(block, 'link')
    const source = tag(block, 'source')
    const ts = Date.parse(tag(block, 'pubDate'))
    if (!raw || !/^https?:\/\//.test(url) || !Number.isFinite(ts)) continue
    // Google appends " - Source" to every headline; <source> has it cleanly
    const title = source && raw.endsWith(` - ${source}`) ? raw.slice(0, -(source.length + 3)).trim() : raw
    items.push({ title, url, source, date: new Date(ts).toISOString() })
  }
  return items
}
