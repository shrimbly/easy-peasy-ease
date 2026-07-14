# 002 — Make timeline zoom track the pointer immediately

- **Status**: TODO
- **Commit**: 1f901a8
- **Severity**: HIGH
- **Category**: Purpose & frequency
- **Estimated scope**: 1 file, small change

## Problem

The zoom slider emits values for every mouse or touch move, while every clip width is covered by a CSS transition. This causes the timeline geometry to chase the pointer instead of behaving like direct manipulation.

```tsx
// components/VideoTimeline.tsx:84 — current
const handlePointerMove = (event: MouseEvent | TouchEvent) => {
  // ...
  updateValueFromPointer(event.clientX);
};
```

```tsx
// components/VideoTimeline.tsx:477 — current
<div
  className={cn(
    'relative h-full flex-none border-r border-border/50 transition-[background-color,box-shadow,width]',
    isSelected && 'ring-2 ring-primary ring-inset',
    isPlaying && 'bg-primary/10'
  )}
  style={{ width: `${Math.max(segmentWidth, 0)}px` }}
>
```

## Target

Clip widths must update immediately during zoom. Only state decoration may transition:

```tsx
className={cn(
  'relative h-full flex-none border-r border-border/50 transition-[background-color,box-shadow]',
  isSelected && 'ring-2 ring-primary ring-inset',
  isPlaying && 'bg-primary/10'
)}
style={{ width: `${Math.max(segmentWidth, 0)}px` }}
```

No animation duration or easing should be applied to width. Pointer movement and geometry must remain one-to-one.

## Repo conventions to follow

- Continue using `cn()` from `lib/utils.ts` for conditional classes.
- Preserve `TimelineZoomSlider`’s existing mouse and touch handling.
- The correct direct-manipulation exemplar is the split-marker drag in `components/SplitTrack.tsx:357`, which updates position without a CSS transition.

## Steps

1. In `components/VideoTimeline.tsx`, remove `width` from the segment transition property list, leaving exactly `transition-[background-color,box-shadow]`.
2. Search the same file for any other transition that covers zoom-driven `width`, `left`, or track geometry. Remove only geometry properties driven by `zoomValue`; keep color, shadow, and focus feedback.
3. Do not debounce, throttle, spring, or tween `onZoomChange`; the existing pointer cadence is the intended interaction.

## Boundaries

- Do NOT change zoom range, interpolation, minimum visible seconds, gutters, auto-scroll, or thumbnail rendering.
- Do NOT remove selection/playback color feedback.
- Do NOT add a release animation after dragging.
- Do NOT add dependencies.
- If segment geometry is no longer rendered at the cited location, STOP and report drift from commit `1f901a8`.

## Verification

- **Mechanical**: run `npm run lint`, `npm test`, and `npm run build`; all must pass.
- **Feel check**: run the editor with at least 10 clips and confirm:
  - the timeline width stays directly under the mouse and touch position during slow and fast zoom drags;
  - reversing drag direction immediately reverses the timeline with no catch-up tail;
  - selection rings and playback background changes remain visually smooth;
  - at 10% DevTools playback speed, clip edges do not continue moving after the pointer stops.
- **Done when**: no zoom-driven width has a transition and the timeline feels mechanically attached to the zoom handle.

