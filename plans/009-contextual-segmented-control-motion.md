# 009 — Give segmented controls context-appropriate movement

- **Status**: TODO
- **Commit**: 1f901a8
- **Severity**: MEDIUM
- **Category**: Easing, performance, and cohesion
- **Estimated scope**: 2 files, medium change

## Problem

The shared indicator uses Motion’s `x` shorthand and the same ease-out tween in both contexts. The homepage ease-out is a settled design choice, but the editor’s on-screen Video/Audio indicator should use a tighter ease-in-out movement curve.

```tsx
// components/ui/segmented-control.tsx:24 — current
<motion.span
  aria-hidden="true"
  initial={false}
  animate={{ x: activeIndex === 0 ? "0%" : "100%" }}
  transition={{ type: "tween", duration: 0.24, ease: "easeOut" }}
/>
```

```tsx
// components/FinalVideoEditor.tsx:849 — current
<SegmentedControlIndicator
  activeIndex={inspectorView === 'segments' ? 0 : 1}
  className="bg-accent"
/>
```

## Target

Use a full transform string and an explicit motion profile:

```tsx
type SegmentedControlMotionProfile = "landing" | "editor";

animate={{
  transform: activeIndex === 0
    ? "translate3d(0%, 0, 0)"
    : "translate3d(100%, 0, 0)",
}}
```

- `landing`: 240ms, `[0.23, 1, 0.32, 1]` strong ease-out. This preserves the requested homepage response.
- `editor`: 200ms, `[0.77, 0, 0.175, 1]` strong ease-in-out for an element moving between two visible positions.
- reduced motion: correct destination transform with `{ duration: 0 }`.

## Repo conventions to follow

- Keep the shared styling exports in `components/ui/segmented-control.tsx`.
- `app/page.tsx:1410` uses the wrapper `<SegmentedControl>`; its default profile must remain `landing` so no page call-site change is required.
- `components/FinalVideoEditor.tsx:849` renders the indicator directly and must opt into `motionProfile="editor"`.
- If plan 011 has created `MOTION_EASING` and `MOTION_DURATION`, reuse those constants for 240ms/ease-out; keep the editor’s exact 200ms duration locally because it is context-specific.

## Steps

1. Add a `motionProfile?: "landing" | "editor"` prop to `SegmentedControlIndicator`, defaulting to `landing`.
2. Add the same optional prop to `SegmentedControl` and forward it to its indicator.
3. Replace Motion’s `x` shorthand with the exact `translate3d(0%, 0, 0)` / `translate3d(100%, 0, 0)` transform strings.
4. Branch the transition by profile using the exact target duration and easing values.
5. Integrate plan 004’s `useReducedMotion()` behavior: the destination remains correct and transition duration becomes zero.
6. In `components/FinalVideoEditor.tsx`, pass `motionProfile="editor"` to the Video/Audio indicator. Leave the homepage wrapper on its default landing profile.
7. Keep press feedback on the buttons separate from indicator travel; do not animate content in this corrective plan.

## Boundaries

- Do NOT alter toggle geometry, colors, corner radii, labels, ARIA roles, or keyboard behavior.
- Do NOT change the homepage profile to ease-in-out; its ease-out decision is settled.
- Do NOT use Motion `x`, `y`, or `scale` shorthand for indicator travel.
- Do NOT add a spring or bounce.
- Do NOT add dependencies.
- If the shared control API has drifted since commit `1f901a8`, STOP and report.

## Verification

- **Mechanical**: run `npm run lint`, `npm test`, and `npm run build`; all must pass.
- **Feel check**: at normal speed and 10% DevTools playback speed, confirm:
  - the homepage indicator retains its responsive ease-out and strictly horizontal path;
  - the editor indicator accelerates and decelerates symmetrically over 200ms;
  - neither indicator dips vertically or appears outside its control;
  - rapidly alternating choices retargets from the current position;
  - reduced motion snaps the indicator to the correct segment.
- **Done when**: both indicators use full transform strings, the landing and editor profiles use their exact curves, and reduced-motion placement is correct.

