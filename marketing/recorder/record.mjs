/**
 * Records roadtrackerindia.com in a phone viewport (360x640 @3 = 1080x1920)
 * via CDP screencast, saving every painted frame + its timestamp.
 * No writes are made to the live database — the report flow is cancelled.
 */
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'

const SITE = 'https://roadtrackerindia.com/'
const OUT = 'frames'
const SHOTS = 'shots'
fs.rmSync(OUT, { recursive: true, force: true })
fs.rmSync(SHOTS, { recursive: true, force: true })
fs.mkdirSync(OUT, { recursive: true })
fs.mkdirSync(SHOTS, { recursive: true })

// a point in the middle of the Mumbai–Pune Expressway
const GPS = { longitude: 73.4119, latitude: 18.7516 }

const initScript = () => {
  window.__fx = {}
  const ensure = () => {
    let host = document.getElementById('__fx')
    if (host) return host
    host = document.createElement('div')
    host.id = '__fx'
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647'
    document.documentElement.appendChild(host)
    const s = document.createElement('style')
    s.textContent = `
      .__tap{position:absolute;width:54px;height:54px;margin:-27px 0 0 -27px;border-radius:50%;
        background:rgba(199,74,42,.42);border:3px solid rgba(255,255,255,.95);
        box-shadow:0 2px 12px rgba(0,0,0,.38);
        animation:__tapa .60s cubic-bezier(.22,.7,.3,1) forwards}
      @keyframes __tapa{0%{transform:scale(.3);opacity:0}16%{transform:scale(1);opacity:1}
        100%{transform:scale(1.6);opacity:0}}`
    document.head.appendChild(s)
    return host
  }
  window.__ripple = (x, y) => {
    const host = ensure()
    const d = document.createElement('div')
    d.className = '__tap'
    d.style.left = x + 'px'
    d.style.top = y + 'px'
    host.appendChild(d)
    setTimeout(() => d.remove(), 700)
  }
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
  window.__scrollTo = (top, ms) =>
    new Promise((res) => {
      const el = document.getElementById('panel-content')
      if (!el) return res(false)
      const from = el.scrollTop
      const d = top - from
      const t0 = performance.now()
      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms)
        el.scrollTop = from + d * easeInOut(t)
        t < 1 ? requestAnimationFrame(step) : res(true)
      }
      requestAnimationFrame(step)
    })
  window.__scrollToText = (txt, ms, offset = 14) => {
    const el = document.getElementById('panel-content')
    if (!el) return Promise.resolve(false)
    const nodes = [...el.querySelectorAll('h2,h3')]
    const n = nodes.find((x) => (x.textContent || '').trim().toLowerCase().includes(txt.toLowerCase()))
    if (!n) return Promise.resolve(false)
    const to = el.scrollTop + (n.getBoundingClientRect().top - el.getBoundingClientRect().top) - offset
    return window.__scrollTo(Math.max(0, to), ms)
  }
}

const browser = await chromium.launch({
  channel: 'chrome',
  headless: false,
  // 3 is what makes the screencast surface a true 1080x1920 — at 1 the
  // compositor rasters at 360x640 and the capture is a quarter-res mush
  args: ['--hide-scrollbars', '--force-device-scale-factor=3', '--window-position=0,0'],
})
const ctx = await browser.newContext({
  viewport: { width: 360, height: 640 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  reducedMotion: 'no-preference',
  colorScheme: 'dark', // the app follows the OS when nothing is stored
  locale: 'en-IN',
  timezoneId: 'Asia/Kolkata',
  geolocation: GPS,
  permissions: ['geolocation'],
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
})
await ctx.addInitScript(initScript)
const page = await ctx.newPage()
const errs = []
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))

// ── warm the cache so the recorded boot is a returning-visitor boot ──
// and prove the 2.4 MB search index has actually landed before we roll
await page.goto(SITE, { waitUntil: 'load' })
await page.waitForTimeout(6000)
await page.click('#search-input')
await page.type('#search-input', 'NH 44', { delay: 20 })
await page.waitForSelector('#search-list li[data-i]', { timeout: 45000 })
await page.fill('#search-input', '')
await page.keyboard.press('Escape')
await page.click('#map', { position: { x: 180, y: 200 } }).catch(() => {})
await page.waitForTimeout(2500)

// ── recording helpers ────────────────────────────────────────────────
const cdp = await ctx.newCDPSession(page)
const frames = []
const writes = []
let i = 0
let recording = false
cdp.on('Page.screencastFrame', (f) => {
  const id = i++
  if (recording) {
    frames.push({ id, t: f.metadata.timestamp })
    writes.push(fs.promises.writeFile(path.join(OUT, `f${String(id).padStart(6, '0')}.jpg`), f.data, 'base64'))
  }
  cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
})

const marks = []
const wait = (ms) => page.waitForTimeout(ms)
// wall clock, not last-frame time: a static page stops emitting frames, so
// frame timestamps lag reality by however long nothing moved
const mark = (name) => marks.push({ name, w: Date.now() / 1000, frame: frames.length })
const tap = async (x, y, pre = 130) => {
  await page.evaluate(([a, b]) => window.__ripple(a, b), [x, y])
  await wait(pre)
  await page.touchscreen.tap(x, y)
}
const tapSel = async (sel, pre = 130) => {
  const box = await page.locator(sel).first().boundingBox()
  if (!box) throw new Error('no box for ' + sel)
  await tap(box.x + box.width / 2, box.y + box.height / 2, pre)
  return box
}
const shot = (n) => page.screenshot({ path: path.join(SHOTS, n) })

// keep the very first frame — a static page emits nothing after it
recording = true
await cdp.send('Page.startScreencast', {
  format: 'jpeg',
  quality: 92,
  maxWidth: 1080,
  maxHeight: 1920,
  everyNthFrame: 1,
})
const T0 = Date.now()

// ── S1 · the whole network ───────────────────────────────────────────
mark('s1-network')
await wait(1900)
await shot('s1.png')

// ── S2 · search a highway ────────────────────────────────────────────
mark('s2-search')
await tapSel('#search-input')
await wait(320)
await page.type('#search-input', 'NH 44', { delay: 125 })
await wait(950)
await shot('s2-list.png')
const first = await page.locator('#search-list li[data-i]').first().boundingBox()
if (!first) throw new Error('no search results')
await tap(first.x + first.width / 2, first.y + first.height / 2, 180)
await wait(3700) // camera flight + route draw-on + sheet
await shot('s2-road.png')

// ── S3 · the profile, and who to call ────────────────────────────────
mark('s3-sheet')
await tapSel('#sheet-handle', 200)
await wait(1100)
await shot('s3-full.png')
await page.evaluate(() => window.__scrollToText('route', 1300))
await wait(1150)
await shot('s3-route.png')
mark('s4-helpline')
await page.evaluate(() => window.__scrollToText('if something goes wrong', 1500))
await wait(2600)
await shot('s4-helpline.png')

// ── S5 · who is behind it, and its news ──────────────────────────────
mark('s5-who')
await page.evaluate(() => window.__scrollToText("who's behind this road", 1200))
await wait(1500)
await shot('s5-who.png')
mark('s6-news')
await page.evaluate(() => window.__scrollToText('in the news', 1600))
await wait(2100)
await shot('s6-news.png')
// keep reading — closures, landslides, potholes, toll contracts
await page.evaluate(() => window.__scrollTo(document.getElementById('panel-content').scrollTop + 620, 2300))
await wait(1400)
await shot('s6-news2.png')

// ── S7 · find my road (real GPS on the Mumbai–Pune Expressway) ───────
mark('s7-locate')
await page.keyboard.press('Escape') // collapse the sheet back
await wait(700)
await page.evaluate(() => document.getElementById('panel')?.classList.contains('is-open'))
await shot('s7-before.png')
await tapSel('#btn-locate', 200)
await wait(3800)
await shot('s7-located.png')

// ── S8 · report a problem (cancelled — nothing is written) ───────────
mark('s8-report')
await page.keyboard.press('Escape')
await wait(900)
await tapSel('#btn-report', 200)
await wait(1250)
await shot('s8-mode.png')
await tap(180, 292, 200) // on the expressway, just above centre
await wait(1200)
await shot('s8-dialog.png')
const potholeBox = await page.locator('.rp-type[data-type="pothole"]').boundingBox()
if (potholeBox) {
  await tap(potholeBox.x + potholeBox.width / 2, potholeBox.y + potholeBox.height / 2, 180)
  await wait(700)
  await page.locator('#rp-note').tap()
  await page.type('#rp-note', 'Deep pothole, left lane', { delay: 72 })
  await wait(1150)
}
await shot('s8-filled.png')
await wait(700)

// ── S9 · pull all the way back out for the end card ──────────────────
mark('s9-home')
await page.locator('#rp-cancel').click() // nothing is written to the live database
await wait(500)
await page.keyboard.press('Escape')
await wait(600)
await tapSel('#brand-link', 200)
await wait(3600) // flyHome across the whole country
await shot('s9-home.png')
mark('s10-end')
await wait(2000)

recording = false
await cdp.send('Page.stopScreencast')
await Promise.all(writes)

const meta = {
  frames,
  marks,
  wallSecs: +((Date.now() - T0) / 1000).toFixed(2),
  count: frames.length,
  fps: +(frames.length / ((frames[frames.length - 1].t - frames[0].t) || 1)).toFixed(1),
  errs,
}
fs.writeFileSync('frames.json', JSON.stringify(meta))
console.log(
  JSON.stringify(
    {
      count: meta.count,
      wallSecs: meta.wallSecs,
      fps: meta.fps,
      errs: meta.errs,
      marks: marks.map((m) => ({ name: m.name, at: +(m.w - frames[0].t).toFixed(2) })),
    },
    null,
    2,
  ),
)
await browser.close()
