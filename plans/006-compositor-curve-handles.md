# 006 — Move curve handles with transforms

- **Status**: TODO
- **Commit**: 1f901a8
- **Severity**: MEDIUM
- **Category**: Performance
- **Estimated scope**: 1 file, medium change

## Problem

The curve gesture is correctly batched to one commit per animation frame, but both control handles are positioned with `left` and `top` on every update. Those properties trigger layout during the editor’s most precise direct-manipulation gesture.

```ts
// components/CubicBezierEditor.tsx:385 — current
const controlStyles = useMemo(
  () => ({
    p1: {
      left: `${(value[0] * 100).toFixed(2)}%`,
      top: `${((1 - value[1]) * 100).toFixed(2)}%`,
    },
    p2: {
      left: `${(value[2] * 100).toFixed(2)}%`,
      top: `${((1 - value[3]) * 100).toFixed(2)}%`,
    },
  }),
  [value]
);
```

```tsx
// components/CubicBezierEditor.tsx:471 — current
<button
  className="group absolute flex size-10 -translate-x-1/2 -translate-y-1/2 ..."
  style={controlStyles.p1}
>
```

## Target

Measure the plot only when its size changes, then express each normalized point as pixel translation in a full transform string:

```ts
const pointTransform = (x: number, y: number) =>
  `translate3d(${x * plotSize.width}px, ${(1 - y) * plotSize.height}px, 0) translate(-50%, -50%)`;

const controlStyles = {
  p1: { transform: pointTransform(value[0], value[1]) },
  p2: { transform: pointTransform(value[2], value[3]) },
};
```

Buttons must be anchored at `left: 0; top: 0`. There must be no transition on position during pointer or keyboard manipulation. The curve path and handles must remain numerically aligned in rectangular mobile and square desktop plots.

## Repo conventions to follow

- Keep the existing `requestAnimationFrame(flushPendingChange)` batching at `components/CubicBezierEditor.tsx:268`.
- Reuse the existing `editorRef` at `components/CubicBezierEditor.tsx:421` as the measured plot element.
- The component already falls back to `DEFAULT_SIZE` during drag calculations; preserve that behavior until a real size is available.
- Continue using `ResizeObserver`, with cleanup, as elsewhere in the repository (`components/SplitTrack.tsx:69`).

## Steps

1. Add local `plotSize` state initialized to `{ width: DEFAULT_SIZE, height: DEFAULT_SIZE }`.
2. Add an effect that observes `editorRef.current` with `ResizeObserver`, writes rounded non-zero width and height only when they change, and disconnects on cleanup. Perform one synchronous initial measurement before observing.
3. Replace percentage `left`/`top` values in `controlStyles` with direct `transform` strings based on `plotSize`. Include `plotSize` in the memo dependencies.
4. Add `left-0 top-0` to both handle buttons and remove `-translate-x-1/2 -translate-y-1/2`; centering now belongs to the inline transform string.
5. Keep the inner visual handle’s existing 150ms active-scale feedback. Do not add a transition to the outer button transform.
6. Verify the plot’s `aspect-[16/9]` mobile and `sm:aspect-square` desktop modes both map normalized endpoints exactly to the visual corners.

## Boundaries

- Do NOT alter bezier math, normalized values, clamping, keyboard increments, commit cadence, grid, SVG path, or hit-target size.
- Do NOT add easing, a spring, or inertia to the drag.
- Do NOT move the accessible button into SVG.
- Do NOT drive the child transform from a CSS variable on a parent.
- Do NOT add dependencies.
- If the editor structure has drifted since commit `1f901a8`, STOP and report.

## Verification

- **Mechanical**: run `npm run lint`, `npm test`, and `npm run build`; all must pass.
- **Feel check**: on both a narrow mobile viewport and desktop, confirm:
  - each handle stays directly under the pointer with no lag or easing;
  - rapidly reversing direction does not leave a trailing handle;
  - keyboard arrow and Shift+arrow movement remains exact;
  - handles and SVG connection lines remain aligned at all four edges;
  - the Performance panel shows transform updates without repeated layout caused by handle `top`/`left`.
- **Done when**: outer handle buttons use only `translate3d(...) translate(-50%, -50%)` for changing position and remain aligned with the curve path.

