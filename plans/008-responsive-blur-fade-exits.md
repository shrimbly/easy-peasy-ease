# 008 — Make blur-fade exits respond immediately

- **Status**: TODO
- **Commit**: 1f901a8
- **Severity**: MEDIUM
- **Category**: Easing and duration
- **Estimated scope**: 2 files, small change

## Problem

Shared blur-fade exits and the homepage mode swap use ease-in curves. Ease-in begins slowly, delaying the moment a disappearing UI acknowledges the user’s action.

```tsx
// components/ui/blur-fade.tsx:64 — current
exit={shouldReduceMotion ? undefined : {
  opacity: 0,
  y: -6,
  filter: "blur(3px)",
  transition: { duration: 0.15, ease: "easeIn" },
}}
```

```ts
// app/page.tsx:1253 — current
exit: (direction: number) => ({
  x: direction * 4,
  opacity: 0,
  filter: 'blur(4px)',
  transition: { duration: 0.22, ease: [0.4, 0, 1, 1] as const },
}),
```

The same ease-in array appears again in `modeGroupVariant` at `app/page.tsx:1265`.

## Target

Every cited exit must use the exact strong ease-out curve `cubic-bezier(0.23, 1, 0.32, 1)`, represented to Motion as `[0.23, 1, 0.32, 1] as const`.

```tsx
transition: { duration: 0.15, ease: [0.23, 1, 0.32, 1] as const }
```

```ts
transition: { duration: 0.22, ease: [0.23, 1, 0.32, 1] as const }
```

Preserve all existing displacement, direction, blur, opacity, durations, and stagger. This plan changes only exit easing.

## Repo conventions to follow

- If `lib/motion.ts` exists after plan 011, import and reuse its `MOTION_EASING.out` tuple instead of repeating the array.
- If that file does not exist, use the exact tuple inline; do not substitute Motion’s string `"easeOut"`.
- Preserve `useReducedMotion()` behavior in `components/ui/blur-fade.tsx`.

## Steps

1. In `components/ui/blur-fade.tsx`, replace the `"easeIn"` exit easing with `[0.23, 1, 0.32, 1] as const` or the exact shared constant from plan 011.
2. In `app/page.tsx`, replace the `[0.4, 0, 1, 1]` easing in both `modeRevealVariant.exit` and `modeGroupVariant.exit` with the exact strong ease-out tuple.
3. Search `app/` and `components/` for remaining UI `easeIn`, `ease-in`, or `[0.4, 0, 1, 1]` exit transitions. Report unrelated occurrences rather than expanding this plan’s scope.

## Boundaries

- Do NOT change the established homepage horizontal direction, 4px displacement, blur treatment, stagger, or 340ms entrance durations.
- Do NOT change the landing segmented indicator’s requested ease-out behavior.
- Do NOT alter entering transitions in this plan.
- Do NOT add dependencies.
- If the cited variants have drifted since commit `1f901a8`, STOP and report.

## Verification

- **Mechanical**: run `npm run lint`, `npm test`, and `npm run build`; all must pass.
- **Feel check**: at normal speed and 10% DevTools playback speed, repeatedly switch homepage modes and remove a blur-fade item. Confirm:
  - exits react immediately instead of pausing at the beginning;
  - direction, blur, and stagger remain unchanged;
  - incoming and outgoing states do not pop in at remote positions;
  - rapid reversals retarget without a visible dead period;
  - reduced motion remains displacement-free after plan 004.
- **Done when**: no cited UI exit uses ease-in and all use the exact strong ease-out tuple.

