# End-to-end validation

Drives the real UI in a real Chromium (real WebCodecs — no mocks) through the
full pipeline: upload → capability checks → finalize → audio mix → update →
download, then validates the produced MP4s with ffprobe.

Scenarios:

- **A** — three uniform 1080p clips, full quality, music added, downloaded.
  Asserts H.264, 1920×1080, ~4.5s, exactly ~270 frames at 60fps (proves no
  frames are dropped at clip boundaries), and an AAC audio track.
- **B** — mixed 1080p + 720p clips: exercises the re-encode fallback path
  (packet passthrough is impossible for non-uniform streams).
- **C** — preview-quality render followed by Download, which must force a
  full-quality re-render (guards the quality-aware render cache).
- **D** — "Split a video": one 12s clip cut into 3 eased sections, rendered
  and validated like A.
- **E** — split mode on an iPhone-sized touch viewport: finger-sized split
  markers, tap-to-remove, full touch finalize, Export-tab download path.
- **F** — beat sync: uploads a 128 BPM kick track, asserts the detected-BPM
  pill, snaps sections to every 2nd beat (1.5s → 1.88s, frame-exact), checks
  toggle-off restores the baseline, renders, then verifies with ffmpeg that a
  kick lands on the first section boundary of the produced MP4 (proves both
  duration snapping and beat-grid offset alignment survive the render).

## Requirements

- `ffmpeg` on PATH (fixture generation + output validation)
- Playwright with Chromium (not part of the app's dependency tree):
  `npm i --no-save playwright && npx playwright install chromium`

## Run

```bash
./e2e/make-fixtures.sh              # once; writes e2e/fixtures/
npm run dev                         # or: npm run build && npm start
node e2e/run-e2e.mjs http://localhost:3000
```

Exits non-zero if any check fails. Outputs land in `e2e/out/`.
