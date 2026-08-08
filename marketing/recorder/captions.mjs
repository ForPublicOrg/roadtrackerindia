/**
 * Renders each caption as a transparent 1080x1920 PNG using the app's own fonts.
 *
 * Timings are expressed relative to the scene marks the recorder wrote, not as
 * absolute seconds — a re-record shifts every scene by a little, and hardcoded
 * times silently drift until a caption is describing the wrong screen.
 */
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'

const meta = JSON.parse(fs.readFileSync('frames.json', 'utf8'))
const t0 = meta.frames[0].t
const M = Object.fromEntries(meta.marks.map((m) => [m.name.split('-')[0], m.w - t0]))
export const LAST = meta.frames[meta.frames.length - 1].t - t0

const MARK = `<svg class="mark" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <rect width="64" height="64" rx="14" fill="#e8703d"/>
  <path d="M20 56 C26 38 30 30 44 8" stroke="#fff" stroke-opacity=".3" stroke-width="13" fill="none" stroke-linecap="round"/>
  <path d="M20 56 C26 38 30 30 44 8" stroke="#fff" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-dasharray="7 8"/>
</svg>`

export const CAPS = [
  { id: 'c1', at: 0.30, to: M.s2 + 0.75, pos: 'top',
    h: 'Every numbered road in India. <em>One map.</em>',
    p: '<b>7,761 roads</b> · 3,42,735 km · every state' },

  { id: 'c2', at: M.s2 + 1.05, to: M.s2 + 3.75, pos: 'bottom',
    h: 'Search any road.',
    p: 'By number, by name, or by the city it runs through.' },

  { id: 'c3', at: M.s3 - 2.20, to: M.s3 + 0.50, pos: 'top',
    h: 'Then read it like an <em>encyclopedia.</em>',
    p: 'Length, status, every state it crosses.' },

  { id: 'c4', at: M.s3 + 1.00, to: M.s4 - 0.40, pos: 'top',
    h: 'Where it starts. Where it ends.',
    p: 'And every major town on the way.' },

  { id: 'c5', at: M.s4 + 0.20, to: M.s5 - 0.15, pos: 'top',
    h: 'Broken down on a highway? <em>These numbers work.</em>',
    p: '<b>1033</b> highway emergency · <b>112</b> police · <b>108</b> ambulance' },

  { id: 'c6', at: M.s5 + 0.35, to: M.s6 - 0.20, pos: 'top',
    h: 'And who is <em>accountable</em> for it.',
    p: 'The authority, the builder, the operator — named.' },

  { id: 'c7', at: M.s6 + 1.10, to: M.s7 - 1.40, pos: 'top',
    h: 'Live news for <em>that exact road.</em>',
    p: 'Closures, landslides, potholes, toll contracts — as they are reported.' },

  { id: 'c8', at: M.s7 + 0.40, to: M.s8 - 0.45, pos: 'top',
    h: 'One tap: <em>which highway am I on?</em>',
    p: 'Your GPS snaps to the nearest catalogued road.' },

  { id: 'c9', at: M.s8 + 0.45, to: M.s8 + 3.85, pos: 'top',
    h: 'See a pothole? <em>Pin it.</em>',
    p: 'Potholes, damaged stretches, waterlogging — on the exact spot.' },

  { id: 'c10', at: M.s8 + 4.25, to: M.s9 - 0.55, pos: 'top',
    h: 'And anyone can clear it <em>once it is fixed.</em>',
    p: 'No account. No login. Nothing about you is stored.' },

  // runs past the cut on purpose — its fade-out must never land before the
  // final frame, or the video ends on a bare map instead of the URL
  { id: 'end', at: M.s9 + 2.45, to: LAST + 0.60, pos: 'end' },
]

const html = (c) => {
  if (c.pos === 'end') {
    return `<div class="end">
      ${MARK}
      <h2>The living atlas of Indian roads</h2>
      <div class="url">roadtrackerindia.com</div>
      <div class="stat">7,761 roads · 3,42,735 km <span>catalogued</span></div>
      <div class="chips"><span class="chip">Free</span><span class="chip">Open source</span><span class="chip">No tracking</span></div>
      <div class="credit">Map data © OpenStreetMap contributors</div>
    </div>`
  }
  return `<div class="band ${c.pos}">
    <div class="rule"></div>
    <h1>${c.h}</h1>
    ${c.p ? `<p>${c.p}</p>` : ''}
  </div>`
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 })
  await page.goto('file:///' + path.resolve('cap/caption.html').replace(/\\/g, '/'))
  await page.evaluate(() => document.fonts.ready)

  fs.mkdirSync('cap/out', { recursive: true })
  for (const c of CAPS) {
    await page.evaluate((h) => (document.body.innerHTML = h), html(c))
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(120)
    await page.screenshot({ path: `cap/out/${c.id}.png`, omitBackground: true })
  }
  console.log('rendered', CAPS.length, 'captions · cut at', LAST.toFixed(2), 's')
  console.log(CAPS.map((c) => `${c.id} ${c.at.toFixed(2)}-${c.to.toFixed(2)}`).join('  '))
  await browser.close()
}
