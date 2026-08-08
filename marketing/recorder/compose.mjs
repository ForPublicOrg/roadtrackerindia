/** Composites the caption track over the master and exports the deliverables. */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import ffmpeg from 'ffmpeg-static'
import { CAPS, LAST } from './captions.mjs'

const END = LAST
const FADE = 0.34
const OUTDIR = 'C:/Users/Vikas/Documents/roadtrackerindia/marketing'

const args = ['-y', '-i', 'base.mp4']
for (const c of CAPS) args.push('-loop', '1', '-t', (c.to - c.at).toFixed(2), '-i', `cap/out/${c.id}.png`)
args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo')

const chains = []
CAPS.forEach((c, i) => {
  const d = c.to - c.at
  chains.push(
    `[${i + 1}:v]format=rgba,` +
      `fade=t=in:st=0:d=${FADE}:alpha=1,` +
      `fade=t=out:st=${(d - FADE).toFixed(2)}:d=${FADE}:alpha=1,` +
      `setpts=PTS-STARTPTS+${c.at.toFixed(2)}/TB[k${i}]`,
  )
})
let last = '[0:v]'
CAPS.forEach((c, i) => {
  const out = i === CAPS.length - 1 ? '[v]' : `[t${i}]`
  chains.push(`${last}[k${i}]overlay=0:0:enable='between(t,${c.at.toFixed(2)},${c.to.toFixed(2)})'${out}`)
  last = `[t${i}]`
})

args.push(
  '-filter_complex', chains.join(';'),
  '-map', '[v]', '-map', `${CAPS.length + 1}:a`,
  '-t', String(END),
  '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-profile:v', 'high', '-level', '4.2',
  '-pix_fmt', 'yuv420p', '-r', '60', '-maxrate', '12M', '-bufsize', '24M',
  '-c:a', 'aac', '-b:a', '96k', '-shortest',
  '-movflags', '+faststart',
  'roadtracker-launch-9x16.mp4',
)

console.log('compositing…')
execFileSync(ffmpeg, args, { stdio: ['ignore', 'ignore', 'inherit'] })

// ── looping GIF teaser: the network, the search, the route drawing itself ──
console.log('gif…')
const GIF_IN = '0.6'
const GIF_LEN = '8.6'
execFileSync(ffmpeg, ['-y', '-ss', GIF_IN, '-t', GIF_LEN, '-i', 'roadtracker-launch-9x16.mp4',
  '-vf', 'fps=16,scale=500:-1:flags=lanczos,palettegen=stats_mode=diff:max_colors=176', 'palette.png'],
  { stdio: ['ignore', 'ignore', 'inherit'] })
execFileSync(ffmpeg, ['-y', '-ss', GIF_IN, '-t', GIF_LEN, '-i', 'roadtracker-launch-9x16.mp4', '-i', 'palette.png',
  '-lavfi', 'fps=16,scale=500:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
  '-loop', '0', 'roadtracker-launch-9x16.gif'],
  { stdio: ['ignore', 'ignore', 'inherit'] })

// ── a still for the post's link preview / first frame ──
execFileSync(ffmpeg, ['-y', '-ss', '1.4', '-i', 'roadtracker-launch-9x16.mp4', '-frames:v', '1',
  'roadtracker-launch-poster.png'], { stdio: ['ignore', 'ignore', 'inherit'] })

fs.mkdirSync(OUTDIR, { recursive: true })
for (const f of ['roadtracker-launch-9x16.mp4', 'roadtracker-launch-9x16.gif', 'roadtracker-launch-poster.png']) {
  fs.copyFileSync(f, `${OUTDIR}/${f}`)
  console.log(f, (fs.statSync(f).size / 1048576).toFixed(2), 'MB')
}
