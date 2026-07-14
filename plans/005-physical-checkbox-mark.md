# 005 — Reveal checkbox marks from a physical resting scale

- **Status**: TODO
- **Commit**: 1f901a8
- **Severity**: HIGH
- **Category**: Physicality and origin
- **Estimated scope**: 1 file, small change

## Problem

The custom checkbox mark begins at `scale: 0`, making the check appear from nothing.

```css
/* app/globals.css:195 — current */
input[type='checkbox']::before {
  content: '';
  height: 0.625rem;
  width: 0.625rem;
  scale: 0;
  transition: scale 120ms ease-out;
  background-color: var(--primary-foreground);
  clip-path: polygon(14% 44%, 0 65%, 50% 100%, 100% 16%, 80% 0%, 43% 62%);
}

input[type='checkbox']:checked::before {
  scale: 1;
}
```

## Target

Use opacity plus a subtle 0.92-to-1 scale with the canonical strong ease-out:

```css
input[type='checkbox']::before {
  opacity: 0;
  scale: 0.92;
  transition:
    opacity 120ms var(--ease-out),
    scale 120ms var(--ease-out);
}

input[type='checkbox']:checked::before {
  opacity: 1;
  scale: 1;
}
```

`--ease-out` must resolve to `cubic-bezier(0.23, 1, 0.32, 1)`. If plan 011 has not created it yet, add that exact token next to the existing easing tokens in `app/globals.css`.

## Repo conventions to follow

- Checkbox visuals are globally centralized in `app/globals.css:181-223`; do not add component-specific overrides.
- The existing 120ms duration is within the 100–160ms press-feedback budget and should remain unchanged.
- Keep the existing clip path, dimensions, colors, borders, focus ring, and disabled behavior.

## Steps

1. Ensure `--ease-out: cubic-bezier(0.23, 1, 0.32, 1);` exists in the root token block.
2. In `input[type='checkbox']::before`, replace `scale: 0` with `opacity: 0` and `scale: 0.92`.
3. Replace the scale-only transition with the exact two-property 120ms transition shown in the target.
4. Add `opacity: 1` to the checked pseudo-element and retain `scale: 1`.
5. Confirm unchecked, checked, keyboard-focused, disabled, and programmatically changed checkboxes all render correctly.

## Boundaries

- Do NOT replace native checkbox markup or accessibility semantics.
- Do NOT change checkbox size, color, corner radius, checkmark clip path, or label copy.
- Do NOT exceed 120ms or introduce bounce.
- Do NOT use `scale(0)` anywhere in the replacement.
- Do NOT add dependencies.
- If global checkbox styling has moved since commit `1f901a8`, STOP and report.

## Verification

- **Mechanical**: run `npm run lint`, `npm test`, and `npm run build`; all must pass.
- **Feel check**: at 10% DevTools playback speed, toggle both render-quality checkboxes at `app/page.tsx:1803` and `components/FinalVideoEditor.tsx:707` and confirm:
  - the mark is faintly present at 0.92 scale before resolving to 1;
  - it never grows from an invisible zero-size point;
  - rapid keyboard toggling retargets smoothly without restarting a keyframe;
  - focus and disabled styling are unchanged.
- **Done when**: every custom checkbox mark transitions only between 0.92/opacity 0 and 1/opacity 1 over 120ms with the exact ease-out token.

