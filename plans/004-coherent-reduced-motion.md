# 004 — Make reduced motion coherent and informative

- **Status**: TODO
- **Commit**: 1f901a8
- **Severity**: HIGH
- **Category**: Accessibility
- **Estimated scope**: 3 files, medium change

## Problem

The global reduced-motion rule suppresses every CSS animation and transition, including loading feedback, while Motion-driven transforms without `useReducedMotion()` still run.

```css
/* app/globals.css:287 — current */
@media (prefers-reduced-motion: reduce) {
  .beat-pulse-dot {
    animation: none !important;
  }

  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

```tsx
// app/page.tsx:1699 — current
<motion.div
  layout
  initial={{ opacity: 0, y: 10, scale: 0.985, filter: 'blur(3px)' }}
  animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
  exit={{ opacity: 0, y: -6, scale: 0.985, filter: 'blur(2px)' }}
>
```

```tsx
// components/ui/segmented-control.tsx:24 — current
<motion.span
  initial={false}
  animate={{ x: activeIndex === 0 ? "0%" : "100%" }}
  transition={{ type: "tween", duration: 0.24, ease: "easeOut" }}
/>
```

## Target

Reduced motion means less displacement, not missing feedback:

- Preserve opacity, color, border, shadow, progress, and loading-state feedback.
- Remove `x`, `y`, scale, layout, and decorative looping displacement.
- Let segmented indicators snap to their correct position with `duration: 0` rather than leaving the indicator in the wrong segment.
- Replace spinner rotation with a gentle opacity pulse under reduced motion.

```css
@keyframes reduced-motion-loading {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  html:focus-within { scroll-behavior: auto; }
  .beat-pulse-dot { animation: none !important; }
  .animate-spin {
    animation: reduced-motion-loading 800ms ease-in-out infinite !important;
  }
  .landing-drop-zone,
  .motion-icon {
    transform: none !important;
  }
}
```

The 800ms pulse is opacity-only. It must not rotate, translate, or scale.

## Repo conventions to follow

- `components/ui/blur-fade.tsx:42` and `components/ui/light-rays.tsx:156` already use `useReducedMotion()` from `motion/react`; follow that pattern.
- Retain the existing `.beat-pulse-dot` suppression rule because beat visualization is decorative under reduced motion.
- Use `cn()` for conditional classes and values rather than duplicating markup.

## Steps

1. In `app/globals.css`, delete the universal `*`, `*::before`, `*::after` duration override. Keep automatic scrolling disabled through `html:focus-within { scroll-behavior: auto; }`.
2. Add the exact opacity-only `reduced-motion-loading` keyframes above and override `.animate-spin` inside the reduced-motion query with `800ms ease-in-out infinite`.
3. In that query, explicitly remove transforms from `.landing-drop-zone` and `.motion-icon`; leave their color, border, shadow, opacity, and filter feedback available.
4. In `app/page.tsx`, import and call `useReducedMotion()`. For mode content, errors, queue layout, queue entries, and drag indicators, branch positional/scale/layout values: reduced mode uses opacity and at most `blur(2px)`, with no `x`, `y`, scale, or layout movement. Use a 150ms opacity transition with `ease: [0.23, 1, 0.32, 1]`.
5. Set queue container/item `layout` props to `false` when reduced motion is requested. The queue must still update immediately and remain usable.
6. In `components/ui/segmented-control.tsx`, use `useReducedMotion()`. Keep the indicator’s correct 0%/100% destination but set the transition to `{ duration: 0 }` for reduced motion. Do not force it to remain at 0%.
7. Audit all direct `motion.*` elements in `app/page.tsx` after the change and confirm every positional or scale transition has an explicit reduced branch.

## Boundaries

- Do NOT remove all animation globally.
- Do NOT hide loading indicators, progress bars, focus rings, validation messages, or state changes.
- Do NOT change normal-motion timing in this plan.
- Do NOT change the wordmark’s normal-motion design.
- Do NOT add dependencies.
- If motion structure has drifted from commit `1f901a8`, STOP and report rather than applying a blanket replacement.

## Verification

- **Mechanical**: run `npm run lint`, `npm test`, and `npm run build`; all must pass.
- **Feel check**: in DevTools Rendering, toggle `prefers-reduced-motion: reduce` and confirm:
  - homepage mode content, upload errors, and queue items fade without horizontal/vertical movement or scale;
  - the segmented indicator snaps to the selected half and never animates through the middle;
  - loaders communicate ongoing work through opacity but do not rotate;
  - focus, hover color, render progress, and validation feedback remain visible;
  - normal-motion mode is visually unchanged.
- **Done when**: reduced-motion users retain comprehensible feedback with no unnecessary displacement, and no global rule suppresses all transitions.
