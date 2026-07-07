# easy-peasy-ease

Client-side video editor that stitches video segments into seamless loops with custom ease-in/out speed curves and background music. Started as a weekend project; for best results use desktop Chrome, but the pipeline now adapts to what each machine can do (see Reliability below). I am not planning to maintain this project long term.

## Workflow

Upload video segments → Order and trim → Apply speed curves → Stitch into MP4 → Mix audio → Download

## Tech Stack

- **Framework**: Next.js 16 App Router + React 19 + TypeScript 5
- **Styling**: Tailwind CSS 4 + shadcn/ui components + CSS variables
- **Video Engine**: Mediabunny 1.50 (client-side WebCodecs/WASM processing)
- **State Management**: React hooks + custom hooks (`useFinalizeVideo`, `useVideoPlayback`, `useAudioVisualization`)

## Getting Started

```bash
npm install
npm run dev
```

## Key Features

- **Browser-based**: All processing happens client-side using Mediabunny—no server-side encoding
- **Two ways to start**: stitch several short clips, or split **one long video**
  into eased sections at split points you place (see
  [`docs/split-video-feature.md`](docs/split-video-feature.md))
- **Speed Curves**: Apply preset or custom Bezier curves for organic motion
- **Audio Mixing**: Mix background music with video client-side
- **Session-only**: No persistent storage; all data is ephemeral

## Reliability

The pipeline plans encoding around what the current machine actually supports:

- **Capability-probed tier ladder** (`lib/encode-planner.ts`): output resolution,
  frame rate, AVC profile/level, and bitrate are planned per source and probed
  with the exact production encoder config before a render starts. Machines
  that can't encode native resolution fall back to 1080p/720p (with real frame
  resizing) instead of failing mid-render.
- **Lossless stitching**: speed-curved clips share one encoding config, so the
  stitcher copies encoded packets instead of re-encoding — no second
  generation loss and roughly half the encode work. Mixed sources fall back to
  a planned re-encode with keyframes forced at clip boundaries.
- **Audio everywhere**: an AAC WASM polyfill registers on browsers without a
  native encoder (Firefox, Linux Chromium). Multichannel audio downmixes to
  stereo. When audio still can't be processed, the render completes and tells
  you, instead of silently producing a mute video.
- **Android end-of-clip frame drops** (the old known issue): the speed-curve
  stage decodes each section as a single forward, sequential pass
  (`VideoSampleSink.samples`) rather than seeking per output frame. Forward
  decoding drains the decoder to end-of-stream, so the true final frames are
  emitted instead of the eased ending freezing on an early frame — the failure
  mode of Android MediaCodec under per-timestamp seeking. Combined with the
  packet-passthrough stitcher, clip/section endings stay smooth.
- Renders are cancellable, keep the screen awake, guard against accidental
  tab closes, and report failures in a visible dialog.

## Commands

```bash
npm run dev      # Start development server (localhost:3000)
npm run build    # Build for production
npm run lint     # Run ESLint
npm test         # Run Vitest
```

There is also a real-browser end-to-end suite that drives the full pipeline
through actual WebCodecs and validates the produced MP4s — see [`e2e/`](e2e/README.md).
