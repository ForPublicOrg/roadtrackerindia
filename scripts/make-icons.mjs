#!/usr/bin/env node
/**
 * Draws the app icons a phone or desktop needs to install the site as an app:
 *
 *   public/icons/icon-192.png      the mark as it is, corners rounded ("any")
 *   public/icons/icon-512.png
 *   public/icons/maskable-512.png  full-bleed square; Android cuts its own shape
 *   public/apple-touch-icon.png    full-bleed 180px; iOS rounds the corners itself
 *
 * Same trick as make-og-image.mjs: there is no image library here, so a real
 * browser paints each icon on a <canvas> and posts the PNG back. Run
 * `node scripts/make-icons.mjs`, open the URL it prints, and it writes the files
 * and stops on its own. Not part of `npm run build` — the icons only change
 * when the brand does.
 *
 * The geometry is public/favicon.svg's, on its 64-unit grid. A maskable icon
 * must keep everything that matters inside the central circle of radius 40%
 * (Android may crop to a circle), so the road there is drawn at 72% size.
 */
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PUBLIC = join(fileURLToPath(new URL('..', import.meta.url)), 'public')
const PORT = Number(process.env.PORT ?? 4398)

const ICONS = [
  { file: 'icons/icon-192.png', size: 192, rounded: true, scale: 1 },
  { file: 'icons/icon-512.png', size: 512, rounded: true, scale: 1 },
  { file: 'icons/maskable-512.png', size: 512, rounded: false, scale: 0.72 },
  { file: 'apple-touch-icon.png', size: 180, rounded: false, scale: 0.84 },
]

const PAGE = /* html */ `<!doctype html>
<meta charset="utf-8">
<title>RoadTracker India — app icons</title>
<style>
  body { margin: 0; background: #888; display: flex; flex-wrap: wrap; gap: 24px;
         align-items: center; justify-content: center; min-height: 100vh; font: 14px system-ui; }
  canvas { width: 160px; height: 160px; }
  p { width: 100%; text-align: center; color: #fff; }
</style>
<p id="status">drawing…</p>
<script>
const ICONS = ${JSON.stringify(ICONS)}
const ACCENT = '#bc4b1f'

function draw({ size, rounded, scale }) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  document.body.appendChild(c)
  const x = c.getContext('2d')
  const u = size / 64 // one unit of the favicon's 64-unit grid

  x.fillStyle = ACCENT
  x.beginPath()
  if (rounded) x.roundRect(0, 0, size, size, 14 * u)
  else x.rect(0, 0, size, size)
  x.fill()

  // the road, scaled about the centre so a maskable icon keeps it in the safe zone
  x.translate(size / 2, size / 2)
  x.scale(u * scale, u * scale)
  x.translate(-32, -32)
  const road = new Path2D('M20 56 C26 38 30 30 44 8')
  x.lineCap = 'round'
  x.strokeStyle = 'rgba(255,255,255,.3)'
  x.lineWidth = 13
  x.stroke(road)
  x.strokeStyle = '#fff'
  x.lineWidth = 3.5
  x.setLineDash([7, 8])
  x.stroke(road)
  return c
}

;(async () => {
  for (const icon of ICONS) {
    const blob = await new Promise((r) => draw(icon).toBlob(r, 'image/png'))
    const res = await fetch('/save?file=' + encodeURIComponent(icon.file), { method: 'POST', body: blob })
    if (!res.ok) { document.getElementById('status').textContent = 'save failed: ' + icon.file; return }
  }
  document.getElementById('status').textContent = 'saved ' + ICONS.length + ' icons — you can close this tab'
})()
</script>`

const wanted = new Set(ICONS.map((i) => i.file))

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'POST' && url.pathname === '/save') {
    const file = url.searchParams.get('file')
    // only the names above — this server writes into the repo
    if (!wanted.has(file)) return res.writeHead(400).end('unknown file')
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const png = Buffer.concat(chunks)
    const out = join(PUBLIC, file)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, png)
    res.writeHead(200).end('ok')
    console.log(`✓ wrote public/${file} (${(png.length / 1024).toFixed(1)} KB)`)
    wanted.delete(file)
    if (!wanted.size) server.close()
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
})

server.listen(PORT, () => console.log(`open http://localhost:${PORT}/ to draw the icons`))
