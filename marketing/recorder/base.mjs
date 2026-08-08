/** Turns the captured variable-rate frames into a constant 60fps master. */
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import ffmpeg from 'ffmpeg-static'

const m = JSON.parse(fs.readFileSync('frames.json', 'utf8'))
const f = m.frames
const t0 = f[0].t

const lines = []
for (let i = 0; i < f.length; i++) {
  const dur = i < f.length - 1 ? f[i + 1].t - f[i].t : 1 / 50
  lines.push(`file 'frames/f${String(f[i].id).padStart(6, '0')}.jpg'`)
  lines.push(`duration ${dur.toFixed(6)}`)
}
lines.push(`file 'frames/f${String(f[f.length - 1].id).padStart(6, '0')}.jpg'`)
fs.writeFileSync('concat.txt', lines.join('\n'))

console.log('span', (f[f.length - 1].t - t0).toFixed(2), 's over', f.length, 'frames')

execFileSync(
  ffmpeg,
  ['-y', '-f', 'concat', '-safe', '0', '-i', 'concat.txt',
   '-fps_mode', 'cfr', '-r', '60',
   '-c:v', 'libx264', '-crf', '15', '-preset', 'medium', '-pix_fmt', 'yuv420p',
   '-movflags', '+faststart', 'base.mp4'],
  { stdio: ['ignore', 'ignore', 'inherit'] },
)

// a 1-per-second contact sheet, to place captions against what is really there
execFileSync(
  ffmpeg,
  ['-y', '-i', 'base.mp4', '-vf', 'fps=1,scale=200:-1,drawtext=text=%{eif\\:n\\:d}:x=6:y=6:fontsize=26:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=10x5:margin=4:padding=4',
   '-frames:v', '1', 'sheet.png'],
  { stdio: ['ignore', 'ignore', 'inherit'] },
)
console.log('ok')
