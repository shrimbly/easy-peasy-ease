# 011 — Establish one motion vocabulary

- **Status**: TODO
- **Commit**: 1f901a8
- **Severity**: LOW
- **Category**: Cohesion and tokens
- **Estimated scope**: 6 files, mechanical consolidation

## Problem

The repository has two CSS easing tokens, but Motion components and transition strings repeat similar curves and durations as raw values. This creates multiple sources of truth.

```css
/* app/globals.css:102 — current */
--ease-out-smooth: cubic-bezier(0.22, 1, 0.36, 1);
--ease-interactive: cubic-bezier(0.2, 0, 0, 1);
```

```tsx
// components/ui/blur-fade.tsx:71 — current
transition={shouldReduceMotion ? { duration: 0 } : {
  delay: 0.04 + delay,
  duration,
  ease: [0.22, 1, 0.36, 1],
}}
```

```tsx
// components/ui/segmented-control.tsx:28 — current
transition={{ type: "tween", duration: 0.24, ease: "easeOut" }}
```

```tsx
// components/ui/button.tsx:8 — current
"... duration-150 ease-out ... active:scale-[0.96] ..."
```

## Target

Define the canonical CSS tokens in `app/globals.css`:

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);
--motion-duration-press: 150ms;
--motion-duration-popover: 160ms;
--motion-duration-ui: 240ms;
```

Create the exact JS equivalents in `lib/motion.ts` for Motion:

```ts
export const MOTION_EASING = {
  out: [0.23, 1, 0.32, 1] as const,
  inOut: [0.77, 0, 0.175, 1] as const,
  drawer: [0.32, 0.72, 0, 1] as const,
};

export const MOTION_DURATION = {
  press: 0.15,
  popover: 0.16,
  ui: 0.24,
} as const;
```

The duration values correspond exactly to 150ms button feedback, 160ms small popovers, and 240ms general UI motion, all inside the audit budgets.

## Repo conventions to follow

- Global design tokens live in the root token block in `app/globals.css`.
- Shared TypeScript helpers live in `lib/` and use named exports.
- Source imports use the `@/` alias, e.g. `import { cn } from "@/lib/utils"`.
- Preserve the specially tuned slow landing beam in `components/ui/light-rays.tsx` and the wordmark response in `components/text/text-pressure.tsx`; those are settled expressive treatments, not generic UI motion.

## Steps

1. In `app/globals.css`, replace `--ease-out-smooth` and `--ease-interactive` with the six exact canonical tokens shown above.
2. Update CSS references to the removed names: entering/exiting and press feedback use `var(--ease-out)`; visible on-screen movement uses `var(--ease-in-out)`. Do not mechanically change constant decorative motion to either curve.
3. Add `lib/motion.ts` with the exact typed constants shown above.
4. In `components/ui/blur-fade.tsx`, import `MOTION_EASING` and replace the raw entrance tuple with `MOTION_EASING.out`. Plan 008 should also use the same constant for exits.
5. In `components/ui/segmented-control.tsx`, import both constant groups. Use `MOTION_DURATION.ui` and `MOTION_EASING.out` for the landing profile; plan 009’s editor profile uses `MOTION_EASING.inOut` with its specified 0.2-second duration.
6. In `app/page.tsx`, replace the duplicated homepage exit arrays addressed by plan 008 with `MOTION_EASING.out`.
7. In `components/ui/button.tsx`, replace `duration-150 ease-out` with `duration-[var(--motion-duration-press)] [transition-timing-function:var(--ease-out)]`. Preserve the existing 0.96 active scale because this plan consolidates timing rather than retuning physicality.
8. Search `app/`, `components/`, and `hooks/` for the removed token names and for raw copies of the three canonical tuples. Migrate generic UI copies; explicitly leave and document the settled `LightRays` and `TextPressure` curves.

## Boundaries

- Do NOT retune the landing hover beam, wordmark interpolation, beat timing, video speed curves, or media-processing easing presets.
- Do NOT replace linear progress motion with an eased token.
- Do NOT convert all durations to 240ms; use the semantic duration matching each interaction.
- Do NOT add a package or dependency.
- Do NOT change visual geometry, colors, or markup.
- If token ownership has drifted since commit `1f901a8`, STOP and report rather than creating a second token system.

## Verification

- **Mechanical**: run `rg -n "ease-out-smooth|ease-interactive|0\\.23, 1, 0\\.32, 1|0\\.77, 0, 0\\.175, 1" app components hooks lib`, inspect every result, then run `npm run lint`, `npm test`, and `npm run build`; all must pass.
- **Feel check**: at normal speed and 10% DevTools playback speed, compare buttons, blur fades, homepage toggle, and editor toggle. Confirm:
  - equivalent interaction types now share a curve and duration;
  - the homepage’s requested ease-out remains responsive;
  - editor on-screen movement uses the stronger ease-in-out profile;
  - the slow landing beam and wordmark still feel unchanged;
  - no transition unexpectedly adopts the drawer curve.
- **Done when**: generic UI motion imports or references one canonical vocabulary, removed token names have no remaining references, and the explicitly exempt expressive treatments are unchanged.

