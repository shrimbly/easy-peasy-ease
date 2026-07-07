# Split a video into eased sections

A second way to start a project: instead of uploading several short clips to
stitch, upload **one long video** and cut it into **sections** at chosen
**split points**. Each section is retimed by its own ease curve, then the
sections play back to back — the same output the multi-clip flow produces, but
sourced from ranges of a single file.

## Vocabulary

- **Split point** — an interior moment (seconds) where one section ends and the
  next begins. Draggable, keyframe-like handles on the split track. `0` and the
  source duration are implicit boundaries, never split points.
- **Section** — a contiguous `[start, end]` range of the source between two
  boundaries. Each becomes one `TransitionVideo` with its own ease curve and
  output duration.

## Why this shape

The app already models a project as `TransitionVideo[]`, where each segment is
retimed by `useApplySpeedCurve` and concatenated by `useStitchVideos`. The
retimer is **output-driven**: for each output frame slot it computes the source
timestamp the easing curve calls for and pulls that frame. "Splitting" is
therefore not a new pipeline — it is the same per-segment machinery with each
segment pointing at a **sub-range of a shared source file** rather than a whole
separate file. That made the enabling change tiny and kept one code path for
both modes.

## Data model

`TransitionVideo` gained two optional fields (`lib/types.ts`):

```ts
sourceStartTime?: number; // seconds from the source's first frame
sourceEndTime?: number;
```

When present, only that sub-range is retimed; when absent, the whole clip is
used (unchanged multi-clip behaviour). All sections cut from one upload share
the same `file`; each gets its own object URL (so the existing
create-on-build / revoke-on-cleanup URL lifecycle keeps working).

## Modules

- **`lib/chunking.ts`** (pure, unit-tested) — split-point math: `deriveSections`,
  `sanitizeSplitTimes`, `computeEvenSplitTimes` (folds a tiny trailing remainder
  into the previous section; caps at `MAX_SECTIONS`), `computeSplitTimesByCount`,
  and `insert/move/remove/canInsert` with a `MIN_SECTION_DURATION` guard.
  `buildSectionSegments` maps sections → `TransitionVideo[]` and takes the URL
  factory as an argument so it stays testable (factory-injection, like
  `lib/audio-prep`).
- **`lib/speed-curve.ts`** — `buildEasedSourceTimestamps({ spanStart, spanEnd,
  trackEnd, easing, outputFrameCount, minFrameInterval })` precomputes the eased
  per-frame source timestamps for a range, clamped inside the last real frame so
  end-of-section requests can't fall off the track. Passing the whole clip
  reproduces the original behaviour exactly; a sub-range yields one section.
- **`hooks/useApplySpeedCurve.ts`** — resolves `spanStart/spanEnd` from
  `firstTimestamp + sourceStartTime/EndTime` (clamped to the track) and delegates
  to `buildEasedSourceTimestamps`. Everything else (tier planning, hold-frame
  edge handling, software-decode retry) is unchanged.
- **`hooks/useFinalizeVideo.ts`** — threads `sourceStartTime/EndTime` into the
  retimer and folds the range into `computeConfigHash`, so moving a split
  invalidates the intermediate cache.
- **`components/SplitTrack.tsx`** — the interactive lane: filmstrip, section
  overlays, scrubbing playhead, and draggable split markers (add at playhead or
  double-click, drag to move, select + Delete/×, arrow-key nudge).
- **`components/VideoSplitEditor.tsx`** — preview + `SplitTrack` + controls
  (section length with an "Split evenly" apply, per-section default output
  duration and ease preset, a live section summary). On **Create** it derives
  sections and hands off to the normal finalize + `FinalVideoEditor`, where each
  section can still be tuned individually.
- **`app/page.tsx`** — a landing-page mode toggle (**Stitch clips** /
  **Split one video**). Split upload probes one file (metadata + encode
  capability) and opens the editor; `handleCreateSections` builds the segments
  and renders them. The preflight total-size check dedupes by distinct `File`
  (sections share one file, so it must not be counted N times).

## Rendering path

Sections are retimed to a shared encoding config, so `useStitchVideos` takes its
**lossless packet-passthrough** path — no re-encode across section seams. Loops
(`cloneSegmentForLoop`) copy the source range via spread, so a looped project
replays the whole section sequence.

## Validation

- Unit: `lib/__tests__/chunking.test.ts` (39) and the
  `buildEasedSourceTimestamps` cases in `speed-curve.test.ts`.
- Real-browser E2E: `e2e/run-e2e.mjs` Scenario D uploads a 12s clip, takes the
  default 5s split (3 sections), renders, and asserts the output is a
  full-quality 1080p H.264 MP4 of ~4.5s / ~270 frames (90 per section — proving
  no boundary frames are dropped).
