# Open Questions

## ui-modernization - 2026-03-15

- [ ] What is the minimum supported browser version? — Pointer Events require Chrome 55+, Safari 13+, Firefox 59+. If older browsers must be supported, a polyfill is needed.
- [ ] Should the 600px breakpoint (phone-size) be in scope or deferred? — The plan includes it in Phase 4 but the primary target is 768px (tablet). Phone-size may add complexity without matching the university use case.
- [ ] Is there a real-device test matrix available (specific iPad models, Chromebook models)? — Chrome DevTools emulation does not catch all touch behavior edge cases (especially around `setPointerCapture` and Safari-specific quirks).
- [ ] Should the tutorial-viewer.html receive the same responsive/touch treatment? — It has a different layout (step navigation + embedded simulator). The plan currently focuses only on simulator.html.
- [ ] What is the acceptable performance floor for pinch-to-zoom? — On low-end Chromebooks, Canvas2D redraws during pinch may stutter. Need to decide if dirty-rect optimization (P2 item 12) should be pulled into Phase 2 if performance is poor.
- [ ] Should palette drag ghost render the actual component shape or a simplified icon? — The agreed design says "clone of palette item icon" but rendering the actual component shape at grid scale would give better spatial feedback for placement.

### Added in iteration 2 (Architect + Critic review)

- [ ] Does `dblclick` fire reliably on touch with `touch-action: none`? — Plan includes a contingency double-tap detector, but real-device testing is needed to determine if the fallback is required. This blocks Phase 1 verification sign-off.
- [ ] Should `touch-action` conditional upgrade use a feature detect or always apply via JS? — Plan says JS sets `canvas.style.touchAction = 'none'` at init. If a screen reader is detected, should it remain `manipulation`? Need to define the detection heuristic.
- [ ] What is the real-device test matrix? — Architect and Critic both flagged that emulation is insufficient. Need at least one iPad (Safari), one Chromebook (Chrome), one Android tablet. Are devices available to the team?
- [ ] tutorial-viewer.html scope confirmed OUT for this plan — It uses only `onclick`/`.onclick` (no mouse event listeners). A separate responsive pass may be needed later but is not blocking for the simulator touch migration.

### Added in iteration 3 (Phases 6-8: Feature Surfacing)

- [ ] Should dark mode default to light or dark? — Currently `dark=true` by default (url-params.ts). The toggle button introduces localStorage persistence. Need to decide: does localStorage override the hardcoded default, or only the URL param? Plan says localStorage is read first, URL param overrides localStorage.
- [ ] GIF export: what is the maximum frame count / memory budget? — `exportGif()` captures N simulation steps as canvas frames. Large circuits at 2x scale with 100+ frames could consume significant memory. Should there be a warning or cap?
- [ ] Analysis suite: what is the maximum input count for truth table UI? — `model-analyser.ts` caps at 20 input bits (2^20 = ~1M rows). The truth table grid UI may struggle to render more than ~1000 rows without virtualization. Should the UI impose a stricter limit (e.g., 12 bits = 4096 rows) with a "too large" warning?
- [ ] Settings persistence: unified settings object or individual localStorage keys? — Phases 6-8 add multiple persisted settings (color scheme, snapshot budget, oscillation limit, zoom presets). A unified `digital-settings` JSON object in localStorage with schema versioning would be cleaner than separate keys. Decision needed before implementation.
- [ ] State diagram editor scope — Phase 8.2 mentions a graphical state diagram as a stretch goal. Should this be committed to or explicitly deferred to a separate plan? The state transition table (non-graphical) is the minimum deliverable.
- [ ] View menu placement — Phase 8.3 proposes a new top-level "View" menu. Currently the menubar has File, Edit, Insert, Simulation. Adding both "View" and "Analysis" menus brings the count to 6. At 600px with the hamburger menu this is fine, but at 768px-1024px the menubar may feel crowded. Need to validate layout.
- [ ] FILE property type: what file formats should the picker accept? — Phase 6.4 proposes `.hex,.bin,.dat` for the file input accept attribute. Need to confirm against what formats RAM/ROM components actually support for data loading.
