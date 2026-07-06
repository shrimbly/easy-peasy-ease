# Repository Guidelines

## Project Overview
- **easy-peasy-ease** is a client-side video processing tool that stitches short video clips together into a seamless loop with custom ease-in/out speed curves and background music.
- **Core Workflow**: Upload video segments -> Order and trim segments -> Apply speed curves (presets or custom Bezier) -> Stitch into final MP4 -> Mix audio -> Download.
- **Key Value**: Runs entirely in the browser using `mediabunny` for frame-perfect concatenation and retiming without server-side processing.

## Tech Stack & Architecture
- **Framework**: Next.js 16 App Router + React 19 + TypeScript 5.
- **Styling**: Tailwind CSS 4, `tw-animate-css`, `shadcn/ui` components, and CSS variables for theming (`globals.css`).
- **Video Engine**: `mediabunny` (client-side WASM/JS video processing).
- **State Management**: React `useState` / `useReducer` + Custom hooks (`useFinalizeVideo`, `useVideoPlayback`, `useAudioVisualization`).
- **UI Components**:
  - `components/FinalVideoEditor.tsx`: Main workspace for timeline, speed ramping, and audio mixing.
  - `components/CubicBezierEditor.tsx`: Visual editor for speed curves.
  - `components/VideoTimeline.tsx`: Interactive timeline for segment selection and scrubbing.

## Project Structure
- `app/`:
  - `page.tsx`: Main entry point. Manages file upload state and renders `FinalVideoEditor`.
  - `globals.css`: Global styles and theme variables.
- `components/`:
  - `ui/`: Reusable shadcn-like primitives.
  - `FinalVideoEditor.tsx`: The heart of the editing experience.
  - `VideoTimeline.tsx`: Timeline visualization.
  - `CubicBezierEditor.tsx`: Speed curve editor.
- `hooks/`:
  - `useFinalizeVideo.ts`: Orchestrates the pipeline (fast remux / cached re-stitch / full render paths, cache validation via configHash, AbortSignal, user-visible warnings).
  - `useApplySpeedCurve.ts`: Retimes one clip via output-driven frame sampling and re-encodes it on a capability-planned tier.
  - `useStitchVideos.ts`: Concatenates clips — lossless packet passthrough when clips share a stream config (always true for our own intermediates), planned re-encode fallback for mixed sources.
  - `useAudioMixing.ts` / `useRemuxAudio.ts`: Audio decode + assembly (shared `lib/audio-prep.ts`) and fast audio-only remux via video packet passthrough.
  - `useVideoPlayback.ts`: Manages HTML5 video element state (play/pause, seek).
  - `useAudioVisualization.ts`: Generates waveform data from audio files.
- `lib/`:
  - `encode-planner.ts`: Pure, tested planning of AVC profile/level/bitrate and resolution/framerate fallback ladders per machine capability.
  - `video-encoding.ts`: Builds mediabunny encoding configs from planned tiers; probes support with the EXACT production config (probe/encode parity).
  - `audio-prep.ts`: Offset/loop/downmix/fades audio assembly shared by mixing and remux paths (factory-injected, unit-testable).
  - `audio-codec.ts`: Lazy AAC WASM polyfill registration (Firefox etc.) + quality-based audio bitrates.
  - `abort-utils.ts`: AbortSignal helpers threaded through the pipeline.
  - `speed-curve.ts` & `easing-presets.ts`: Logic for timestamp remapping and ease curves.
  - `timeline-utils.ts`: Helpers for duration calculations.
- `lib/__tests__/`: Vitest suites for all pure logic (run with `npm test`).

## Workflow & Data Handling
- **Session-Only**: All video blobs and state are ephemeral. No persistent storage (localStorage/IndexedDB) is used for media.
- **Video Processing**:
  - Speed curves are applied by remapping frame timestamps, not interpolation.
  - Stitching requires matching codecs/dimensions (handled by `mediabunny` or best-effort).
  - Audio is mixed client-side.
- **Performance**: Heavy lifting happens in the browser. Large files may impact main thread; async processing with progress indicators is essential.

## Development Guidelines
- **UI Patterns**: Use `shadcn/ui` primitives where possible. For custom video controls, ensure accessibility and keyboard nav.
- **Styling**: Use `cn()` for class merging. Support `.dark` mode.
- **Type Safety**: Strict TypeScript usage. Define shared shapes in `lib/types.ts`.
- **Testing**: Run `npm run lint` and `npm test` (Vitest) before commits.
