# 001 — Move playback playheads on the compositor

- **Status**: TODO
- **Commit**: 1f901a8
- **Severity**: HIGH
- **Category**: Performance
- **Estimated scope**: 5 files, medium refactor

## Problem

Playback writes React state on every animation frame, which rerenders the editor tree. The two visible playheads are then positioned with `left`, a layout-triggering property.

```ts
// hooks/useVideoPlayback.ts:56 — current
updateCurrentTimeRef.current = () => {
  if (videoElementRef.current && !videoElementRef.current.paused) {
    const currentTime = videoElementRef.current.currentTime;
    setState((prev) => ({ ...prev, currentTime }));
    onTimeUpdateRef.current?.(currentTime);
    animationFrameRef.current = requestAnimationFrame(() => updateCurrentTimeRef.current?.());
  }
};
```

```tsx
// components/VideoTimeline.tsx:518 — current
<div
  className="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-primary"
  style={{ left: `${playheadPosition}px` }}
>
```

```tsx
// components/SplitTrack.tsx:329 — current
<div
  className="pointer-events-none absolute top-0 bottom-0 z-20 w-0.5 bg-foreground"
  style={{ left: `${playheadX}px` }}
>
```

## Target

Keep a Motion `MotionValue<number>` for frame-frequency time. Update that value from the existing rAF loop without calling `setState` there. Position both playheads using a full transform string so the browser can composite them:

```tsx
const playheadTransform = useTransform(frameTime, (time) =>
  `translate3d(${timeToPixels(normalizeTime(time), pixelsPerSecond)}px, 0, 0)`
);

<motion.div
  className="pointer-events-none absolute inset-y-0 left-0 z-10 w-0.5 bg-primary"
  style={{ transform: playheadTransform }}
/>
```

The ordinary `state.currentTime` must still update from native `timeupdate`, seek, metadata, pause, and ended events for labels, selection, and accessibility. The frame-frequency Motion value is only for smooth visual positioning. Do not add easing to playback: it represents time and must remain linear and immediate.

## Repo conventions to follow

- Motion is already installed as `motion` and imported from `motion/react` in `components/ui/blur-fade.tsx`.
- Existing timeline conversion must remain centralized in `lib/timeline-utils.ts` through `timeToPixels` and `clamp`.
- `hooks/useVideoPlayback.ts` owns playback lifecycle and cleanup; keep rAF cancellation there.
- Keep the current public state shape so `VideoPlaybackControls` and time labels do not need unrelated changes.

## Steps

1. In `hooks/useVideoPlayback.ts`, import `MotionValue` and `useMotionValue` from `motion/react`. Add `frameTime: MotionValue<number>` to `UseVideoPlaybackReturn` and create it with an initial value of `0`.
2. In the rAF callback, replace the per-frame `setState` call with `frameTime.set(currentTime)`. Continue invoking `onTimeUpdateRef` per frame because `FinalVideoEditor.tsx:324` uses it to detect segment-boundary changes; that callback only writes React state when the segment actually changes.
3. Update `frameTime` alongside `state.currentTime` in `setVideoRef`, `seek`, metadata handling, pause, ended, and the native `timeupdate` fallback. During playing `timeupdate`, update `state.currentTime` for text at the browser’s native cadence instead of 60 times per second.
4. Return `frameTime` from the hook. Thread it from `FinalVideoEditor.tsx` into `VideoTimeline` and from `VideoSplitEditor.tsx` into `SplitTrack` as a required `MotionValue<number>` prop.
5. In `components/VideoTimeline.tsx`, import `motion` and `useTransform`. Replace the playhead’s `left` style with a `MotionValue<string>` containing `translate3d(..., 0, 0)`. Preserve modulo normalization, zoom, and the existing gutter math.
6. In `components/SplitTrack.tsx`, make the same change using its clamped duration and `pixelsPerSecond`. Keep all split markers and section geometry unchanged.
7. Confirm the React `currentTime` state still updates while paused, after keyboard/pointer seeking, and at native `timeupdate` cadence while playing.

## Boundaries

- Do NOT change video timing, looping, segment auto-selection, scroll-follow behavior, or seek semantics.
- Do NOT animate playheads with a tween or spring; playback position is continuous linear motion.
- Do NOT move timeline widths, split markers, or audio waveform geometry in this plan.
- Do NOT add dependencies.
- If the hook API or playback ownership has drifted since commit `1f901a8`, STOP and report instead of improvising.

## Verification

- **Mechanical**: run `npm run lint`, `npm test`, and `npm run build`; all must exit successfully.
- **Feel check**: run `npm run dev`, load both workflows, and confirm:
  - the main editor and split editor playheads remain visually locked to the video at normal speed and 10% DevTools playback speed;
  - play/pause and pointer seeking snap to the exact requested time without easing or overshoot;
  - segment selection still changes at boundaries and the timeline still scrolls to follow playback;
  - React DevTools Profiler no longer shows the entire editor rerendering at display-frame cadence solely for the playhead;
  - the Performance panel shows transform updates rather than repeated layout work from `left`.
- **Done when**: both playheads use a full `translate3d(...)` Motion value, no rAF callback calls `setState` every frame, and all playback behavior remains intact.

