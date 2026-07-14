# 010 — Restrict hover displacement to precise pointers

- **Status**: TODO
- **Commit**: 1f901a8
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Estimated scope**: 2 files, medium CSS cleanup

## Problem

Hover displacement applies without checking whether the device has a real hover-capable fine pointer. Touch taps can therefore trigger or latch translations intended for a mouse.

```css
/* app/globals.css:242 — current */
.landing-drop-zone:hover,
.landing-drop-zone:focus-visible {
  transform: translateY(-2px);
  box-shadow: /* ... */;
}

.group:hover .motion-icon,
.group:focus-visible .motion-icon {
  color: var(--primary);
  transform: translateY(-3px) scale(1.06);
  filter: /* ... */;
}
```

```tsx
// app/page.tsx:1900 — current
<a
  className="inline-block underline transition-[color,transform] duration-150 hover:-translate-y-px hover:text-foreground focus-visible:text-foreground"
>
```

## Target

Place hover-only transforms inside the exact capability query:

```css
@media (hover: hover) and (pointer: fine) {
  .landing-drop-zone:hover:not(:focus-visible):not(:active) {
    transform: translateY(-2px);
  }

  .group:hover:not(:focus-visible) .motion-icon {
    transform: translateY(-3px) scale(1.06);
  }

  .landing-footer-link:hover:not(:focus-visible) {
    transform: translateY(-1px);
  }
}
```

Focus-visible feedback remains universal but non-positional: border, shadow, color, filter, underline, and focus ring may change; transform must remain `none` for keyboard focus and coarse pointers.

## Repo conventions to follow

- Landing-specific custom motion already lives together in `app/globals.css:225-275`.
- Continue using Tailwind for static footer typography and add one semantic `landing-footer-link` class for the capability-gated transform.
- Preserve `transition-[color,transform] duration-150` on footer links so fine-pointer hover remains smooth.

## Steps

1. In `app/globals.css`, split the combined drop-zone hover/focus selector. Keep universal focus-visible box-shadow feedback without transform; move hover transform and hover box-shadow into `@media (hover: hover) and (pointer: fine)`, excluding `:focus-visible` and `:active` so keyboard focus and press feedback take precedence.
2. Split the combined motion-icon selector the same way. Keep universal focus-visible color/filter feedback without translation or scale; move hover transform into the capability query and exclude `:focus-visible`.
3. Keep `.landing-drop-zone:active` press feedback available on all pointers; it communicates direct press rather than hover.
4. Add `.landing-footer-link:hover:not(:focus-visible) { transform: translateY(-1px); }` inside the capability query.
5. In `app/page.tsx`, add `landing-footer-link` to both footer anchors and remove the unconditional `hover:-translate-y-px` class. Keep hover/focus text-color classes.
6. Confirm plan 004’s reduced-motion query overrides these transforms when reduced motion is requested, even on a fine-pointer device.

## Boundaries

- Do NOT remove color, border, shadow, filter, underline, focus ring, or active press feedback.
- Do NOT change hover distances, durations, or normal desktop appearance.
- Do NOT gate focus-visible feedback behind a pointer query.
- Do NOT add dependencies.
- If landing selectors have drifted since commit `1f901a8`, STOP and report.

## Verification

- **Mechanical**: run `npm run lint`, `npm test`, and `npm run build`; all must pass.
- **Feel check**: test a desktop mouse, keyboard-only navigation, and a real touch device or coarse-pointer emulation. Confirm:
  - mouse hover preserves the existing lift and icon movement;
  - touch taps never leave the drop zone, icon, or footer link visually translated;
  - keyboard focus remains obvious without moving the focused control;
  - reduced motion removes displacement while retaining color/shadow feedback.
- **Done when**: every hover-only transform cited above is inside `(hover: hover) and (pointer: fine)` and non-pointer focus feedback remains visible.
