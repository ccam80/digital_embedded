# Notepad
<!-- Auto-managed by OMC. Manual edits preserved in MANUAL section. -->

## Priority Context
<!-- ALWAYS loaded. Keep under 500 chars. Critical discoveries only. -->

## Working Memory
<!-- Session notes. Auto-pruned after 7 days. -->
### 2026-03-06 07:02
Full codebase review completed (Phases 1-11). Fix spec written to spec/fix-spec.md with 7 priority levels. N14 (Phase 4 missing tasks) and N15 (timing diagram cursor) implemented. Key rendering bugs found: R1 (drawPath never fills), R2 (double translation), R3 (DPR per-frame). Engine wiring spec complete (~120 lines needed). Phase 8 Part 2 (waves 8.2-8.3) still unreviewed.
### 2026-03-12 00:22
## Session Summary - 2026-03-12

### Fixes Applied (5 files changed):

1. **Subcircuit pin ordering (sysreg R/W/Add/Dat swap)** — `src/components/subcircuit/pin-derivation.ts`
   - `deriveInterfacePins()` now emits pins in XML document order instead of grouping by face
   - `buildLayoutPositions()` in `subcircuit.ts` now sorts within each face group internally

2. **Bus split/merge loses bitWidth** — `src/editor/wire-drawing.ts` + `src/editor/wire-merge.ts`
   - `splitWiresAtPoint()` passes `wire.bitWidth` to new Wire constructors
   - `mergeOnAxis()` passes `Math.max(a.bitWidth, b.bitWidth)` to merged Wire

3. **Selection bbox misaligned** — `src/editor/hit-test.ts`
   - `worldBoundingBox()` now extracts local offset from getBoundingBox(), applies mirror then rotation, then translates

4. **Text upside-down at rotation 1** — `src/core/upright-text.ts`
   - Counter-rotate 180° + flip alignment for rotations 1 AND 2 (was only 2)

### Architecture Plan Written:
- `spec/architectural-refactor-derive-on-read.md` — 7-step plan to eliminate construction-time caching
- Root cause: every layer copies data into readonly fields at construction, creating 7-layer snapshot chain
- Fix: make getPins(), getBoundingBox() derive from properties on each call

### Test Results: 5366 passed, 5 pre-existing failures (4 fixture data + 1 PFET)


## 2026-03-06 07:02
Full codebase review completed (Phases 1-11). Fix spec written to spec/fix-spec.md with 7 priority levels. N14 (Phase 4 missing tasks) and N15 (timing diagram cursor) implemented. Key rendering bugs found: R1 (drawPath never fills), R2 (double translation), R3 (DPR per-frame). Engine wiring spec complete (~120 lines needed). Phase 8 Part 2 (waves 8.2-8.3) still unreviewed.


## MANUAL
<!-- User content. Never auto-pruned. -->

