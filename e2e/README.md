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
