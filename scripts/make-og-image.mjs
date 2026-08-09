#!/usr/bin/env node
/**
 * Draws public/og.png — the 1200×630 card every link to the site unfurls as.
 *
 * There is no image library in this project and adding one to produce a single
 * static file would be a poor trade, so the drawing happens on a <canvas> in a
 * real browser: this serves a page that paints the card, posts the PNG back
 * here, and exits. Run `node scripts/make-og-image.mjs`, open the URL it
 * prints, and it writes the file and stops on its own.
 *
 * Deliberately not part of `npm run build` — the card only changes when the
 * brand does, and a build step that needs a browser is a build step that
 * breaks in CI.
 */
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const OUT = join(fileURLToPath(new URL('..', import.meta.url)), 'public', 'og.png')
const PORT = Number(process.env.PORT ?? 4399)

const PAGE = /* html */ `<!doctype html>
<meta charset="utf-8">
<title>RoadTracker India — OG card</title>
<style>
  body { margin: 0; background: #222; display: grid; place-items: center; min-height: 100vh; }
  canvas { width: 600px; height: 315px; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
  p { color: #ddd; font: 14px system-ui; }
</style>
<canvas id="c" width="1200" height="630"></canvas>
<p id="status">drawing…</p>
<script>
const c = document.getElementById('c')
const x = c.getContext('2d')

const PAPER = '#f4f1ea', INK = '#221f1a', INK2 = '#6b6456', ACCENT = '#bc4b1f'
const LINE = '#e5dfd2'
// the category colours, straight from the stylesheet
const CATS = ['#3b5bdb', '#d9480f', '#2f9e44', '#9c6f19']

x.fillStyle = PAPER
x.fillRect(0, 0, 1200, 630)

// a faint map grid, so the card reads as an atlas rather than a title slide
x.strokeStyle = LINE
x.lineWidth = 1
for (let i = 60; i < 1200; i += 60) { x.beginPath(); x.moveTo(i + .5, 0); x.lineTo(i + .5, 630); x.stroke() }
for (let i = 60; i < 630; i += 60) { x.beginPath(); x.moveTo(0, i + .5); x.lineTo(1200, i + .5); x.stroke() }

// four roads sweeping across the right, in the four category colours
const routes = [
  [[700, 640], [830, 420], [1010, 300], [1240, 120]],
  [[640, 660], [900, 470], [1080, 430], [1260, 330]],
  [[820, 680], [940, 560], [1120, 540], [1270, 480]],
  [[760, 300], [900, 210], [1060, 200], [1250, 60]],
]
routes.forEach((pts, i) => {
  x.strokeStyle = CATS[i]
  x.lineCap = 'round'
  x.globalAlpha = 0.9
  x.lineWidth = i === 1 ? 13 : 9
  x.beginPath()
  x.moveTo(pts[0][0], pts[0][1])
  for (let k = 1; k < pts.length - 1; k++) {
    const mx = (pts[k][0] + pts[k + 1][0]) / 2
    const my = (pts[k][1] + pts[k + 1][1]) / 2
    x.quadraticCurveTo(pts[k][0], pts[k][1], mx, my)
  }
  x.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1])
  x.stroke()
  // centre line, the way the map draws a divided carriageway
  if (i === 1) {
    x.strokeStyle = PAPER
    x.lineWidth = 2.4
    x.setLineDash([10, 12])
    x.stroke()
    x.setLineDash([])
  }
  x.globalAlpha = 1
})

// the mark: the app's rounded square with its road and dashes
const R = 26, MX = 92, MY = 88, S = 86
x.fillStyle = ACCENT
x.beginPath()
x.roundRect(MX, MY, S, S, R)
x.fill()
const road = new Path2D()
road.moveTo(MX + 24, MY + 74)
road.bezierCurveTo(MX + 30, MY + 50, MX + 36, MY + 38, MX + 58, MY + 12)
x.strokeStyle = 'rgba(255,255,255,.3)'
x.lineWidth = 17
x.lineCap = 'round'
x.stroke(road)
x.strokeStyle = '#fff'
x.lineWidth = 5
x.setLineDash([9, 10])
x.stroke(road)
x.setLineDash([])

// wordmark
x.fillStyle = INK
x.font = '640 62px Georgia, "Times New Roman", serif'
x.textBaseline = 'alphabetic'
x.fillText('RoadTracker', 210, 152)
const w = x.measureText('RoadTracker ').width
// "India" flies the real tiranga — saffron, white, green, in equal bands
// across the glyphs. On paper the white band would disappear, so the letters
// are outlined: the outline is what makes the middle band a band at all.
const g = x.createLinearGradient(0, 106, 0, 158)
g.addColorStop(0, '#ff9933'); g.addColorStop(1 / 3, '#ff9933')
g.addColorStop(1 / 3, '#ffffff'); g.addColorStop(2 / 3, '#ffffff')
g.addColorStop(2 / 3, '#138808'); g.addColorStop(1, '#138808')
x.font = 'italic 640 62px Georgia, "Times New Roman", serif'
x.fillStyle = g
x.fillText('India', 210 + w, 152)
x.strokeStyle = 'rgba(34, 31, 26, 0.55)'
x.lineWidth = 1.6
x.lineJoin = 'round'
x.strokeText('India', 210 + w, 152)

// headline
x.fillStyle = INK
x.font = '620 74px Georgia, "Times New Roman", serif'
x.fillText('The living atlas of', 92, 350)
x.fillText('Indian roads', 92, 436)

x.fillStyle = INK2
x.font = '400 30px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
x.fillText('Every National Highway, Expressway and State Highway', 92, 496)
x.fillText('on one map — routes, tolls, history and facts.', 92, 536)

x.fillStyle = ACCENT
x.font = '650 27px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
x.fillText('roadtrackerindia.com', 92, 594)

c.toBlob(async (blob) => {
  const res = await fetch('/save', { method: 'POST', body: blob })
  document.getElementById('status').textContent = res.ok
    ? 'saved public/og.png — you can close this tab'
    : 'save failed'
}, 'image/png')
</script>`

const server = createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/save') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const png = Buffer.concat(chunks)
    writeFileSync(OUT, png)
    res.writeHead(200).end('ok')
    console.log(`✓ wrote public/og.png (${(png.length / 1024).toFixed(0)} KB)`)
    server.close()
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
})

server.listen(PORT, () => console.log(`open http://localhost:${PORT}/ to draw the card`))
