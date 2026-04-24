# Review Report: Phase 0 — Residual Dead Code Audit

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 7 (0.1.1, 0.1.2, 0.2.1, 0.2.2, 0.2.3, 0.3.1, 0.3.2) |
| Violations — critical | 0 |
| Violations — major | 2 |
| Violations — minor | 3 |
| Gaps | 2 |
| Weak tests | 0 |
| Legacy references | 3 |

**Verdict: has-violations**

---

## Violations

### V-1 — MAJOR: `comparator.ts` changed from non-pool-backed to `poolBacked: true` with `stateSize: 0`, while retaining per-object mutable closure scalars outside the state pool

**File**: `src/components/active/comparator.ts` — lines 232–237 and 355–360
**Rule violated**: Code Hygiene — "No fallbacks. No backwards compatibility shims. No safety wrappers. All replaced or edited code is removed entirely." / CLAUDE.md — Component Model Architecture: pool-backed elements must have all mutable state in the state pool.

**Evidence**:

```ts
// comparator.ts — both factory functions
const childElements: readonly AnalogCapacitorElement[] = collectPinModelChildren([]);
const childStateSize = childElements.reduce((s, c) => s + c.stateSize, 0);

return {
  poolBacked: true as const,
  stateSchema: COMPARATOR_COMPOSITE_SCHEMA,
  stateSize: childStateSize,  // always 0 — comparator has no DigitalPinModel instances
  ...
```

And simultaneously retaining at the top of each factory:

```ts
let _outputActive = false;   // per-object mutable scalar outside state pool
let _outputWeight = 0.0;     // per-object mutable scalar outside state pool
```

**Analysis**: Prior to Phase 0, `createOpenCollectorComparatorElement` and `createPushPullComparatorElement` were plain `AnalogElementCore` (non-pool-backed, `isReactive: false`, no `stateSize`). The Phase 0 change adds `poolBacked: true`, `stateSize: 0`, and `stateSchema: COMPARATOR_COMPOSITE_SCHEMA` (an empty schema with zero slots). However the comparator has no `DigitalPinModel` instances, so `collectPinModelChildren([])` always returns an empty array. The composite pattern adds zero functional value here.

More critically: `_outputActive` and `_outputWeight` remain as per-object closure scalars that are NOT checkpointed/rolled-back by the analog engine on NR-failure or LTE-rejection retries. The element now declares itself `poolBacked: true` — which signals to the engine that all mutable state is in the pool and safe to checkpoint — but this claim is false. On any NR retry, `_outputActive` and `_outputWeight` will retain their values from the failed iteration rather than being restored to the pre-attempt state.

The spec for Task 0.2.3 explicitly states that `comparator.ts` is one of the owning files to apply the composite pattern to. However, it does not authorize converting a non-pool-backed element to pool-backed when the element has no pin models and retains out-of-pool mutable state.

---

### V-2 — MAJOR: Audit test walk excludes entire `ref/` directory instead of only `ref/ngspice/` as specified

**File**: `src/solver/analog/__tests__/phase-0-identifier-audit.test.ts` — lines 387–393
**Rule violated**: Spec acceptance criteria mismatch — Task 0.3.1 states "Walk excludes exactly: `node_modules`, `dist`, `ref/ngspice`, `spec`, `.git`, and the test's own file."

**Evidence**:

```ts
const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  "dist",
  "ref",        // ← excludes ALL of ref/, not just ref/ngspice/
  "spec",
  ".git",
]);
```

The spec says "ref/ngspice" specifically. The implementation excludes all of `ref/`. Currently `ref/` contains only `ref/ngspice/`, so there is no practical difference. However the acceptance criterion is not met: a future developer placing source files in `ref/some-other-tool/` would have them silently excluded from the audit without any test failure. The exclusion should match the spec exactly.

---

### V-3 — MINOR: `mosfet.ts` line 532 — "legacy" comment in a Phase-0-modified file

**File**: `src/components/semiconductors/mosfet.ts` — lines 532–533
**Rule violated**: Code Hygiene — "Historical-provenance comments are dead-code markers" / comments containing "legacy" must be investigated.

**Evidence**:

```ts
// The `vsb` argument is the legacy digiTS VSB = vs - vb convention; these
// helpers invert it to ngspice's vbs for internal use per mos1load.c:500-509.
```

**Analysis**: `mosfet.ts` was modified in Task 0.1.2 (per `spec/progress.md`). The comment describes a naming-convention difference between the `computeIds`/`computeGm` helpers and ngspice. The word "legacy" here refers to the argument naming, not to dead code — the helpers are live and the inversion at line 533 is the actual implementation. This is not a dead-code situation; however the comment does contain the banned word "legacy" in a file modified by Phase 0, and by the Code Hygiene rule it must be flagged for inspection. The `vsb` argument is still used at live call sites; the code it decorates is not dead.

---

### V-4 — MINOR: `mosfet.ts` line 950 — "legacy" comment in a Phase-0-modified file

**File**: `src/components/semiconductors/mosfet.ts` — line 950
**Rule violated**: Code Hygiene — comments containing "legacy."

**Evidence**:

```ts
// For PMOS, VTO is stored as magnitude (matching legacy expectation);
// type sign is applied via polarity at use sites.
```

**Analysis**: Same file as V-3. The comment describes how `VTO` is stored for PMOS. "legacy expectation" refers to a convention, not a removed code path. The `Math.abs(params.VTO)` line it decorates is live PMOS polarity code. Not dead code, but the word "legacy" appears in a Phase-0-modified file.

---

### V-5 — MINOR: Progress.md Task 0.2.2 entry contains a documentation error about `stateSize`

**File**: `spec/progress.md` — Task 0.2.2 entry
**Rule violated**: Completeness / accuracy of implementation record.

**Evidence** (from `spec/progress.md`):

```
changed stateSize from 9 to 4
```

The actual implementation in `src/components/io/led.ts` line 225:

```ts
stateSize: hasCapacitance ? 6 : 4,
```

The stateSize for the capacitive variant was changed from 9 to **6**, not 4. The "4" in progress.md appears to refer only to the non-capacitive variant. The spec requires the cap variant to have exactly 6 slots, which the code correctly implements. This is a documentation-only error (the code is correct), but it misrepresents the implementation to future readers of `progress.md`.

---

## Gaps

### G-1: Task 0.2.3 spec requires test `getChildElements_returns_capacitor_when_loaded_and_cout_positive` to assert `cOut` condition "fails" — test only checks length, not the spec-stated failure case

**Spec requirement** (Task 0.2.3):

> `getChildElements_returns_capacitor_when_loaded_and_cout_positive` — asserts `getChildElements()` returns an array of length 1 when `loaded=true` and `cOut=1e-12`, **length 0 when either condition fails**.

**What was found** (`src/solver/analog/__tests__/digital-pin-model.test.ts` — lines 420–435):

The test `getChildElements_returns_capacitor_when_loaded_and_cout_positive` (line 420) only asserts the length-1 positive case. The "length 0 when either condition fails" assertion (when `loaded=false` with `cOut > 0`) is in a separate test `getChildElements_empty_for_unloaded_output` (line 430). The `loaded=true, cOut=0` failure case is tested via `getChildElements_empty_for_input_with_zero_cin` for the input model, but there is no direct test of `DigitalOutputPinModel` with `loaded=true, cOut=0`.

The spec combined both positive and negative cases into a single test. The implementation splits them into two tests; while the negative case for the input model is covered, the negative case for the output model with `cOut=0` is absent.

---

### G-2: Task 0.3.1 acceptance criterion "Walk excludes exactly" is not met — `ref/ngspice` versus `ref/`

**Spec requirement** (Task 0.3.1):

> "Walk excludes exactly: `node_modules`, `dist`, `ref/ngspice`, `spec`, `.git`, and the test's own file (to avoid recursive matches on the manifest)."

**What was found**: The walk excludes `ref` entirely (all content), not `ref/ngspice` specifically. See V-2 above for the implementation evidence. This acceptance criterion is explicitly not met, even though the practical effect is currently identical.

---

## Weak Tests

None found.

---

## Legacy References

### L-1: `src/solver/analog/load-context.ts` line 89 — "backwards compatibility" in interface JSDoc

**File**: `src/solver/analog/load-context.ts` — line 89
**Reference**:

```ts
 * The string form is retained for backwards compatibility
 * with existing IntegrationMethod consumers; use numeric 0/1 when porting
```

**Note**: `load-context.ts` is NOT in the Phase 0 modified files list. This is a pre-existing legacy reference outside Phase 0 scope. It is reported here because it appears in a production interface file that the audit test should ideally check, and because it decorates a live field — the comment explains an intentional design choice to retain the string form. No dead code is present. The use of the banned phrase "backwards compatibility" in a comment, however, violates the Code Hygiene rule and should be addressed in a follow-on cleanup.

---

### L-2: `src/components/semiconductors/mosfet.ts` line 532 — "legacy" in function-group comment

**File**: `src/components/semiconductors/mosfet.ts` — line 532

```ts
// The `vsb` argument is the legacy digiTS VSB = vs - vb convention; these
```

This file was modified in Phase 0 (Task 0.1.2). The comment describes a live naming convention, not a removed code path. See V-3 for full analysis.

---

### L-3: `src/components/semiconductors/mosfet.ts` line 950 — "legacy" in inline comment

**File**: `src/components/semiconductors/mosfet.ts` — line 950

```ts
  // For PMOS, VTO is stored as magnitude (matching legacy expectation);
```

This file was modified in Phase 0 (Task 0.1.2). See V-4 for full analysis.

---

## Per-Task Adherence Summary

### Task 0.1.1 — Delete `derivedNgspiceSlots`

All deletions confirmed:
- `DerivedNgspiceSlot` interface: absent from `src/solver/analog/__tests__/harness/types.ts` (grep: zero hits in entire `src/`)
- `derivedNgspiceSlots?` field: absent from `DeviceMapping`
- `if (mapping.derivedNgspiceSlots)` blocks in `ngspice-bridge.ts`, `compare.ts`, `parity-helpers.ts`: all removed
- `derivedNgspiceSlots.VSB` comment in `harness-integration.test.ts`: removed
- `device-mappings.ts` docstring: tightened to "direct-offset correspondences only"

**Result: CLEAN**

---

### Task 0.1.2 — Strip historical doc-comment residue

All specified comment deletions confirmed:
- `bjt.ts` module header: `_updateOp`/`_stampCompanion` sentence absent
- `mosfet.ts` module header and line 884: cleaned (new "legacy vsb" comments at lines 532/540/950 are pre-existing or from sign-convention documentation, not Phase 0 introductions — see L-2, L-3)
- `njfet.ts`, `pjfet.ts` module headers and inline blocks: clean
- `varactor.ts` paragraph 13–17: replaced with correct §F2 architectural-alignment rationale
- `bjt.test.ts` lines 6 and 323: clean
- `jfet.test.ts` lines 9–10: clean
- `diode.test.ts` line 703 area: `Math.min(vd/nVt, 700)` deletion note absent; line 703 now contains normal test code
- `timer-555.test.ts` line 6: clean (header contains only A1 test-handling rationale)
- `ckt-mode.test.ts` line 5: `InitMode` mention absent
- `coupled-inductor.ts` lines 9–10: clean (file now describes mutual inductance purpose without provenance commentary)

**Result: CLEAN**

---

### Task 0.2.1 — Collapse tunnel-diode cross-method state slots

All spec changes confirmed:
- Slot constants: `const SLOT_VD = 0, SLOT_GEQ = 1, SLOT_IEQ = 2, SLOT_ID = 3; const SLOT_Q = 4, SLOT_CCAP = 5;` — correct
- `TUNNEL_DIODE_CAP_STATE_SCHEMA`: 6 entries (VD, GEQ, IEQ, ID, Q, CCAP) — confirmed
- `stateSize: hasCapacitance ? 6 : 4` — confirmed
- `load()` writes only `s0[base + SLOT_Q] = q0; s0[base + SLOT_CCAP] = ccap;` (no SLOT_CAP_GEQ/IEQ/V writes) — confirmed
- `capGeq`, `capIeq` remain as `load()` locals stamped directly — confirmed
- Spec-required tests `cap_state_schema_has_no_cap_geq_ieq_v_slots` and `cap_state_size_is_six` present with correct assertions via `schema.indexOf.get()` and `schema.size`

Note: spec prescribed `stateSchema.getSlotOffset("CAP_GEQ")` but `StateSchema` has no `getSlotOffset` method — only `indexOf: ReadonlyMap`. The tests use `schema.indexOf.get()` which is the correct API. Similarly spec said `totalSlots === 6` but the property is `size`. Both are correct-API choices; the spec text was aspirational.

**Result: CLEAN**

---

### Task 0.2.2 — Collapse LED cross-method state slots

All spec changes confirmed:
- Slot constants: `const SLOT_VD = 0, SLOT_GEQ = 1, SLOT_IEQ = 2, SLOT_ID = 3; const SLOT_Q = 4, SLOT_CCAP = 5;` — correct
- `LED_CAP_STATE_SCHEMA` exported, 6 entries — confirmed
- `stateSize: hasCapacitance ? 6 : 4` — confirmed (progress.md says "9 to 4" which is wrong; see V-5)
- `load()` writes only SLOT_Q and SLOT_CCAP — confirmed
- Spec-required tests present — confirmed

**Result: CLEAN (minor progress.md documentation error — V-5)**

---

### Task 0.2.3 — Refactor `DigitalPinModel` to use `AnalogCapacitorElement` child

Key acceptance criteria:
- `_prevVoltage`, `_prevCurrent` absent from `digital-pin-model.ts` — confirmed (grep zero hits)
- `accept(ctx, voltage)` method absent from both classes — confirmed (tests assert this)
- `getChildElements()` returns capacitor child when `loaded && cOut > 0` — confirmed
- `collectPinModelChildren` helper present in `digital-pin-model.ts` — confirmed
- All 15+ listed owning files have composite pattern applied — confirmed via grep (19 files total in `src/solver/analog/` and `src/components/active/` have `_childElements`/`collectPinModelChildren`)

Concerns:
- `comparator.ts` converted from non-pool-backed to `poolBacked: true` with `stateSize: 0` while retaining `_outputActive` and `_outputWeight` as out-of-pool mutable scalars — see V-1

**Result: has-violations (V-1, G-1)**

---

### Task 0.3.1 — Author identifier-audit vitest test

All three required tests present (`scope_dirs_exist`, `no_unexpected_hits`, `allowlist_is_not_stale`).
All manifest identifiers from the spec are present.
`_prevClockVoltage` allowlist covers the correct 7 files.
`Math.min(..., 700)` allowlist covers the single test-side reference.
Walk correctly excludes the test's own file via `THIS_FILE` comparison.

Concern:
- Excludes all of `ref/` rather than just `ref/ngspice/` — see V-2 and G-2

**Result: has-violations (V-2, G-2)**

---

### Task 0.3.2 — Author Phase 0 audit report

`spec/phase-0-audit-report.md` exists and is correctly structured:
- Header with HEAD SHA present
- Per-identifier resolution table covers all manifest identifiers
- Four bucket sections match manifest classifications
- "How to re-run" section present with correct vitest command

**Result: CLEAN**
