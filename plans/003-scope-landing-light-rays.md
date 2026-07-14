# 003 — Keep decorative light rays on the landing page

- **Status**: TODO
- **Commit**: 1f901a8
- **Severity**: HIGH
- **Category**: Performance and cohesion
- **Estimated scope**: 1 file, small change

## Problem

`LightRays` is outside the landing/editor branch, so its seven large blurred layers keep animating behind both technical editors and during client-side encoding.

```tsx
// app/page.tsx:1279 — current
<LightRays
  className="absolute inset-0 z-0"
  color="rgba(160, 210, 255, 0.15)"
  count={7}
  speed={14}
  length="70vh"
  interactive={isDropZoneHovered}
/>
<main>
  {finalVideo ? (
    // editor
  ) : splitSource ? (
    // split editor
  ) : (
    // landing
  )}
</main>
```

The rays use infinite rotation/opacity motion and a 36px filtered layer in `components/ui/light-rays.tsx:73-92` and `components/ui/light-rays.tsx:148`.

## Target

Mount the existing light-ray system only while the landing workflow is visible:

```tsx
{!(finalVideo || splitSource || isFinalizingVideo) && (
  <LightRays
    className="absolute inset-0 z-0"
    color="rgba(160, 210, 255, 0.15)"
    count={7}
    speed={14}
    length="70vh"
    interactive={isDropZoneHovered}
  />
)}
```

The landing appearance, slow beam timing, hover behavior, opacity, count, blur, color, and speed must remain unchanged. The sole motion change is lifecycle scoping.

## Repo conventions to follow

- `app/page.tsx` already exposes `isFinalizingVideo` for the active client-side encoding state; include it alongside the two editor-state symbols.
- The footer uses `!(finalVideo || splitSource)` for landing-only content, but its visibility requirements differ from this performance-sensitive decoration.
- React conditional mounting is preferable here to hiding with CSS because hidden filtered layers could still consume resources.

## Steps

1. In `app/page.tsx`, wrap the existing `LightRays` element in `!(finalVideo || splitSource || isFinalizingVideo) && (...)`.
2. Keep the element in the same stacking context and preserve every existing prop verbatim.
3. Confirm `LightRays` unmounts when either editor opens or encoding starts, and remounts when returning to the idle landing workflow.

## Boundaries

- Do NOT modify `components/ui/light-rays.tsx`.
- Do NOT retune the slow hover beam; that treatment is a settled design decision.
- Do NOT reduce count, blur, opacity, color, speed, or length on the landing page.
- Do NOT add entrance or exit motion around the ray layer.
- Do NOT add dependencies.
- If the page-state branch differs from commit `1f901a8`, STOP and report.

## Verification

- **Mechanical**: run `npm run lint`, `npm test`, and `npm run build`; all must pass.
- **Feel check**: run `npm run dev` and confirm:
  - the landing rays and hover beam look identical before upload;
  - opening either editor or starting client-side encoding removes all ray layers from the Elements panel;
  - returning to the landing page restores the same rays without duplicates;
  - a Performance recording during editor playback or render no longer contains work from the infinite ray animations.
- **Done when**: `LightRays` is absent from the DOM in both editor states and throughout client-side encoding, while remaining unchanged on the idle landing page.
