# 007 — Render progress with a linear compositor transform

- **Status**: TODO
- **Commit**: 1f901a8
- **Severity**: MEDIUM
- **Category**: Performance and easing
- **Estimated scope**: 1 file, small change

## Problem

Each render-progress update starts a new 300ms ease-out transition on `width`. That both triggers layout during encoding and makes the visual bar repeatedly slow down behind the reported percentage.

```tsx
// app/page.tsx:120 — current
<div
  className="h-2 w-full overflow-hidden rounded-full bg-secondary"
  role="progressbar"
  aria-label="Rendering progress"
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={roundedProgress}
>
  <div
    className="h-full bg-primary transition-[width] duration-300 ease-out"
    style={{ width: `${normalizedProgress}%` }}
  />
</div>
```

## Target

Keep the fill at full width and animate only a left-origin transform with constant linear interpolation:

```tsx
<div
  className="h-full origin-left bg-primary transition-transform duration-150 ease-linear"
  style={{ transform: `scaleX(${normalizedProgress / 100})` }}
/>
```

The exact transition is `transform 150ms linear`. ARIA values and the numeric percentage remain driven by the un-smoothed real progress value.

## Repo conventions to follow

- Keep progress normalization and `roundedProgress` logic in `app/page.tsx` unchanged.
- Preserve the existing overflow-hidden rounded track and semantic `role="progressbar"` attributes.
- Tailwind already supplies `transition-transform`, `duration-150`, `ease-linear`, and `origin-left` in this project.

## Steps

1. In the finalization progress component in `app/page.tsx`, replace the width transition classes with exactly `origin-left transition-transform duration-150 ease-linear`.
2. Replace the inline width percentage with `transform: scaleX(normalizedProgress / 100)`.
3. Ensure the fill retains `h-full`, `bg-primary`, and its full intrinsic width.
4. Confirm progress reset to 0 and completion at 100 do not leave stale transform values.

## Boundaries

- Do NOT change progress calculation, status messages, update frequency, percentage copy, cancellation, or accessibility attributes.
- Do NOT use ease-in, ease-out, a spring, or width animation.
- Do NOT change the progress track’s dimensions or colors.
- Do NOT add dependencies.
- If the progress component moved since commit `1f901a8`, STOP and report.

## Verification

- **Mechanical**: run `npm run lint`, `npm test`, and `npm run build`; all must pass.
- **Feel check**: render a multi-clip project and confirm:
  - the bar advances evenly without repeatedly coasting to a stop;
  - the fill remains aligned to the left edge at every percentage;
  - the visual bar catches up within 150ms and reaches exactly 100%;
  - Performance records transform/composite work rather than layout from width changes;
  - reduced motion still communicates progress.
- **Done when**: the fill uses `scaleX(progress / 100)` with a 150ms linear transform transition and no animated width.

