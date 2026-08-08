# Launch video recorder

Records the **live site** in a phone viewport and cuts the vertical launch video.
Nothing is written to the production database — the report flow is filled in and
then cancelled, and no rating is ever submitted.

```bash
npm i playwright-core ffmpeg-static
node record.mjs     # drives roadtrackerindia.com, saves every painted frame + timestamp
node base.mjs       # frames -> constant 60fps master (base.mp4)
node captions.mjs   # renders the caption/end-card PNGs using the app's own fonts
node compose.mjs    # composites, exports mp4 + gif + poster
```

Two things that are easy to get wrong:

- **`--force-device-scale-factor=3` is what makes the capture 1080×1920.** With
  `=1`, Chrome rasters the compositor surface at 360×640 and the screencast is a
  quarter-resolution mush, even though `page.screenshot()` still returns crisp 3×
  images and the WebGL canvas still reports 1080×1920. Verify the master's real
  dimensions before spending time on the edit.
- **Frame timing comes from `metadata.timestamp`, not wall clock.** A static page
  emits no frames at all, so a still moment is one frame with a long duration —
  which the concat list in `base.mjs` preserves. Scene marks, on the other hand,
  must use wall clock, because the last received frame lags whenever nothing moved.

Scene timings in `captions.mjs` are tied to the specific take in `frames.json`.
Re-record and they need re-timing — the quickest way is a 1 fps contact sheet:

```bash
ffmpeg -i base.mp4 -vf "fps=1,scale=190:-1,tile=10x5" -frames:v 1 sheet.png
```
