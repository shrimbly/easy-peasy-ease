# Animation improvement plans

These plans were written against commit `1f901a8` after a full motion audit. Their status is advisory until an executor applies and verifies them. Application source was not changed while producing these documents.

## Plan index

| # | Plan | Severity | Status | Dependencies |
| --- | --- | --- | --- | --- |
| 001 | [Move playback playheads on the compositor](001-compositor-playheads.md) | HIGH | TODO | None |
| 002 | [Make timeline zoom track the pointer immediately](002-immediate-timeline-zoom.md) | HIGH | TODO | None |
| 003 | [Keep decorative light rays on the landing page](003-scope-landing-light-rays.md) | HIGH | TODO | None |
| 004 | [Make reduced motion coherent and informative](004-coherent-reduced-motion.md) | HIGH | TODO | Prefer 011 first; coordinate with 009 and 010 |
| 005 | [Reveal checkbox marks from a physical resting scale](005-physical-checkbox-mark.md) | HIGH | TODO | 011 provides `--ease-out` |
| 006 | [Move curve handles with transforms](006-compositor-curve-handles.md) | MEDIUM | TODO | None |
| 007 | [Render progress with a linear compositor transform](007-linear-compositor-progress.md) | MEDIUM | TODO | None |
| 008 | [Make blur-fade exits respond immediately](008-responsive-blur-fade-exits.md) | MEDIUM | TODO | Prefer 011 first |
| 009 | [Give segmented controls context-appropriate movement](009-contextual-segmented-control-motion.md) | MEDIUM | TODO | 011, then 004 |
| 010 | [Restrict hover displacement to precise pointers](010-gate-hover-motion.md) | MEDIUM | TODO | Coordinate with 004 |
| 011 | [Establish one motion vocabulary](011-consolidate-motion-tokens.md) | LOW | TODO | None; foundation for 004, 005, 008, and 009 |

## Recommended execution order

Execute and review plans sequentially in this order:

1. **011 — motion vocabulary.** Establishes the exact shared CSS and Motion values required by later plans.
2. **004 — reduced motion.** Establishes accessibility branches before other shared primitives are refined.
3. **001 — playback playheads.** Highest-leverage editor performance work; verify playback semantics before proceeding.
4. **002 — timeline zoom.** Small, isolated direct-manipulation fix.
5. **006 — curve handles.** Second direct-manipulation performance change; test mobile and desktop geometry.
6. **003 — landing-only light rays.** Removes decorative background work from both editors without retuning the settled landing treatment.
7. **007 — render progress.** Isolated compositor and linear-easing change.
8. **008 — blur-fade exits.** Reuses the canonical strong ease-out from 011.
9. **009 — segmented controls.** Builds on 011’s curves and 004’s reduced-motion behavior while preserving the homepage’s settled ease-out.
10. **005 — checkbox physicality.** Reuses the canonical CSS ease-out token.
11. **010 — hover capability gating.** Finish after 004 so normal, reduced-motion, keyboard, and coarse-pointer selectors are reconciled once.

## File-overlap constraints

Do not execute the following plans in parallel unless their diffs are manually coordinated:

- `app/globals.css`: 004, 005, 010, 011
- `app/page.tsx`: 003, 004, 007, 008, 010, 011
- `components/ui/segmented-control.tsx`: 004, 009, 011
- `components/ui/blur-fade.tsx`: 008, 011
- `components/FinalVideoEditor.tsx`: 001, 009

Plans 001, 002, 003, 006, and 007 are otherwise independent enough to review separately after the foundational token/accessibility work.

## Execution contract

- Apply one plan at a time against the current tree, then update its status from `TODO` to `DONE` only after every verification item passes.
- If cited code has drifted from commit `1f901a8`, stop and reconcile the plan rather than approximating the intended edit.
- Preserve the current user-owned dirty worktree and avoid overwriting unrelated design or video-preview work.
- Do not add dependencies for any plan.
- Run `npm run lint`, `npm test`, and `npm run build` after each implementation. Complete the plan-specific real-device, reduced-motion, slow-motion, and Performance-panel checks before marking it done.
- After implementation, review the diff against the animation audit bar before moving to the next overlapping plan.

To begin execution through the animation workflow, start with `improve-animations execute plans/011-consolidate-motion-tokens.md`, then follow the order above.

