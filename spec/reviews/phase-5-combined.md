# Review Report: Phase 5 — Tier 2 Components (All 8 Waves)

## Summary

| Item | Value |
|------|-------|
| Tasks reviewed | 30 (Waves 5.1–5.8) |
| Files reviewed | ~40 source + test files |
| Violations — critical | 2 |
| Violations — major | 2 |
| Violations — minor | 4 |
| Gaps | 2 |
| Weak tests | 8 |
| Legacy references | 0 |
| Verdict | **has-violations** |

---

## Violations

### V-1 (Critical) — Type cast bypasses `SolverDiagnosticCode` union in `polarized-cap.ts`

- **File**: `src/components/passives/polarized-cap.ts`, line 253
- **Rule violated**: Code Hygiene — no safety wrappers; scorched earth on shortcuts. The progress note for Task 5.1.1 explicitly describes this as a deliberate workaround (`"used as SolverDiagnosticCode type assertion at runtime — functionally correct. When the file lock releases, the type should be added to the union."`). A justification comment for a known rule violation makes it worse, not better.
- **Quoted evidence**:
  ```typescript
  code: "reverse-biased-cap" as import("../../core/analog-engine-interface.js").SolverDiagnosticCode,
  ```
- **Severity**: Critical

The string `"reverse-biased-cap"` is not a member of the `SolverDiagnosticCode` union defined in `src/core/analog-engine-interface.ts` (lines 71–105). The union does not contain this code. The cast silences TypeScript but the code is outside the declared contract. The progress note in `spec/progress.md` (Task 5.1.1 Notes) acknowledges the union omission and describes the cast as a deliberate workaround until a "file lock releases." This is a self-described backwards-compatibility shim / workaround — banned by the rules.

---

### V-2 (Critical) — Type cast bypasses `SolverDiagnosticCode` union in `analog-fuse.ts`

- **File**: `src/components/passives/analog-fuse.ts`, line 176
- **Rule violated**: Same as V-1. The progress note for Task 5.1.3 states: `"SolverDiagnosticCode does not include 'fuse-blown' — used type cast (same pattern as polarized-cap's 'reverse-biased-cap'). The analog-engine-interface.ts file lock was held by task 5.7.1 during implementation."` The agent knowingly used a banned workaround and documented the reason.
- **Quoted evidence**:
  ```typescript
  code: "fuse-blown" as SolverDiagnosticCode,
  ```
- **Severity**: Critical

The string `"fuse-blown"` is not a member of the `SolverDiagnosticCode` union. The agent acknowledged the violation in the progress notes and left it as a deferred fix. This is banned.

---

### V-3 (Major) — Dead private field `_currentVoltage` in `AnalogFuseElement`

- **File**: `src/components/passives/analog-fuse.ts`, lines 94 and 147
- **Rule violated**: Code Hygiene — no dead code. The field `_currentVoltage` is declared and assigned in `updateOperatingPoint()` but never read anywhere in the class or externally. It is dead code.
- **Quoted evidence**:
  ```typescript
  private _currentVoltage: number = 0;
  // ...
  this._currentVoltage = vPos - vNeg;
  ```
- **Severity**: Major

This field serves no purpose. It is written but never consumed, suggesting incomplete implementation of a planned feature or a leftover from an abandoned approach.

---

### V-4 (Major) — `FuseDefinition` missing required `simulationModes` property

- **File**: `src/components/switching/fuse.ts`, lines 198–211
- **Rule violated**: Spec adherence — Task 5.1.3 "Files to modify" explicitly states: `add simulationModes: ['digital', 'behavioral']` to the FuseDefinition.
- **Quoted evidence** (fuse.ts, lines 198–211): The `FuseDefinition` object has `engineType: "both"` and `analogFactory` set, but no `simulationModes` property is present. Compare with `ClockDefinition` in `src/components/io/clock.ts` line 332 which correctly has `simulationModes: ["digital", "behavioral"]`.
- **Severity**: Major

The spec requires `simulationModes: ['digital', 'behavioral']` on the FuseDefinition. It is absent. This is an incomplete implementation of the spec.

---

### V-5 (Minor) — Historical-provenance comment in `fet-base.ts`

- **File**: `src/analog/fet-base.ts`, line 114
- **Rule violated**: Code Hygiene — no historical-provenance comments. The comment describes a construction-time limitation and a workaround method added to overcome it.
- **Quoted evidence**:
  ```typescript
  // isReactive is set after construction based on whether capacitances are present.
  // Subclasses set this via _initReactive().
  this.isReactive = false;
  ```
- **Severity**: Minor

This comment explains why a field that should be `readonly` is mutated post-construction, which is a description of a structural workaround. The comment's role is to justify the deviation, not explain complicated code logic.

---

### V-6 (Minor) — `_initReactive` method uses unsafe cast to mutate `isReactive`

- **File**: `src/analog/fet-base.ts`, lines 123–125
- **Rule violated**: Code Hygiene — no safety wrappers or workarounds. The method uses `(this as unknown as { isReactive: boolean }).isReactive = hasCaps` to mutate a field that the interface declares as `readonly` via the `AnalogElement` contract.
- **Quoted evidence**:
  ```typescript
  protected _initReactive(hasCaps: boolean): void {
    (this as unknown as { isReactive: boolean }).isReactive = hasCaps;
  }
  ```
- **Severity**: Minor

This is a type-safety workaround to mutate a field that is conceptually readonly after construction. The spec requires `readonly isReactive: true` on the base class. The implementation hacks around it rather than redesigning.

---

### V-7 (Minor) — Comment describing implementation as needing future action in `polarized-cap.ts`

- **File**: `src/components/passives/polarized-cap.ts`, line 307
- **Rule violated**: Code Hygiene — no comments describing what code used to do or future deferred work. The comment `// nodeIds = [n_pos, n_neg, n_cap_internal] — compiler provides the internal node` is descriptive, but the surrounding code context makes it marginally acceptable. However, the progress note for this task contains the banned language: `"When the file lock releases, the type should be added to the union."` — this is a deferred TODO described in progress.md as task commentary, indicating the implementation is acknowledged incomplete.
- **Severity**: Minor

This violation is the documentation of a known gap in progress.md rather than in-code. Since reviewers check progress notes as evidence of intent, this is reportable.

---

### V-8 (Minor) — `AnalogFuseDefinition` is a standalone definition separate from the spec intent

- **File**: `src/components/passives/analog-fuse.ts`, lines 374–389
- **Rule violated**: Spec adherence — Task 5.1.3 specifies creating `src/components/passives/analog-fuse.ts` with `AnalogFuseElement`, factory, and properties. The spec's "Files to modify" says to add `analogFactory` to the existing `FuseDefinition` in `src/components/switching/fuse.ts`. However, the implementation also creates a standalone `AnalogFuseDefinition` in `analog-fuse.ts` that is not mentioned in the spec. This is scope creep — an additional component definition beyond what was specified.
- **Quoted evidence**:
  ```typescript
  export const AnalogFuseDefinition: ComponentDefinition = {
    name: "AnalogFuse",
    ...
    engineType: "analog",  // standalone analog-only component, not mentioned in spec
  ```
- **Severity**: Minor

The spec only calls for modifying the existing `FuseDefinition`, not creating a second `AnalogFuseDefinition`. The additional definition adds an unspecified component to the registry.

---

## Gaps

### G-1 — `SolverDiagnosticCode` union not updated for `"reverse-biased-cap"` and `"fuse-blown"`

- **Spec requirement**: Task 5.1.1 specifies `emits 'reverse-biased-cap' diagnostic`; Task 5.1.3 specifies `emits 'fuse-blown' diagnostic with info severity`. Both diagnostic codes must be valid `SolverDiagnosticCode` values, meaning they must be added to the union in `src/core/analog-engine-interface.ts`.
- **What was actually found**: Neither `"reverse-biased-cap"` nor `"fuse-blown"` appear in the `SolverDiagnosticCode` union (lines 71–105 of `src/core/analog-engine-interface.ts`). Both implementations use unsafe type casts instead.
- **File**: `src/core/analog-engine-interface.ts`

---

### G-2 — `FuseDefinition.simulationModes` property absent

- **Spec requirement**: Task 5.1.3 "Files to modify" — `src/components/switching/fuse.ts`: add `simulationModes: ['digital', 'behavioral']`.
- **What was actually found**: `FuseDefinition` in `src/components/switching/fuse.ts` (lines 198–211) has no `simulationModes` property.
- **File**: `src/components/switching/fuse.ts`

---

## Weak Tests

### WT-1 — `analog-fuse.test.ts` definition block: bare `toBeDefined()` without content check

- **Test path**: `src/components/passives/__tests__/analog-fuse.test.ts::definition::AnalogFuseDefinition has analogFactory`
- **What is wrong**: `expect(AnalogFuseDefinition.analogFactory).toBeDefined()` asserts only that the field is not `undefined`. It does not verify the factory produces a working element, nor that it is the specific `createAnalogFuseElement` function. This is a trivially true assertion for any object that sets the field.
- **Quoted evidence**: `expect(AnalogFuseDefinition.analogFactory).toBeDefined();` (line 388)

---

### WT-2 — `analog-fuse.test.ts` definition block: bare `toBeDefined()` for element instantiation

- **Test path**: `src/components/passives/__tests__/analog-fuse.test.ts::definition::AnalogFuseCircuitElement can be instantiated`
- **What is wrong**: `expect(el).toBeDefined()` asserts only that construction did not return `undefined`. It does not verify any property of the constructed element.
- **Quoted evidence**: `expect(el).toBeDefined();` (line 408)

---

### WT-3 — `polarized-cap.test.ts` definition block: bare `toBeDefined()` for analogFactory

- **Test path**: `src/components/passives/__tests__/polarized-cap.test.ts::definition::PolarizedCapDefinition has analogFactory`
- **What is wrong**: `expect(PolarizedCapDefinition.analogFactory).toBeDefined()` is trivially true — it just checks the field exists.
- **Quoted evidence**: `expect(PolarizedCapDefinition.analogFactory).toBeDefined();` (line 299)

---

### WT-4 — `polarized-cap.test.ts` definition block: bare `toBeDefined()` for instantiation

- **Test path**: `src/components/passives/__tests__/polarized-cap.test.ts::definition::PolarizedCapElement can be instantiated`
- **What is wrong**: `expect(el).toBeDefined()` — trivially true.
- **Quoted evidence**: `expect(el).toBeDefined();` (line 330)

---

### WT-5 — `analog-switch.test.ts` SPDT block: `expect(diagEntry).toBeDefined()` without resistance check

- **Test path**: `src/components/active/__tests__/analog-switch.test.ts::SPST::on_resistance`
- **What is wrong**: Line 132 has `expect(diagEntry).toBeDefined()` as an intermediate guard. While the test continues to check the actual resistance value, the intermediate `toBeDefined` followed by non-null assertion (`diagEntry![2]`) means the test would pass the `toBeDefined` assertion even if the wrong matrix entry was found. The finding is in the guard pattern, not the final assertion.
- **Quoted evidence**: `expect(diagEntry).toBeDefined();` (line 132), followed by `const g = diagEntry![2];`

---

### WT-6 — `analog-switch.test.ts` SPDT break-before-make: weak intermediate `toBeDefined()` guards

- **Test path**: `src/components/active/__tests__/analog-switch.test.ts::SPDT::break_before_make`
- **What is wrong**: Lines 347 and 352 use `expect(offComNo).toBeDefined()` / `expect(offComNc).toBeDefined()` as guards before accessing `.![2]`. If the wrong matrix entries were found, the `toBeDefined` passes but the subsequent `toBeCloseTo` would fail on a misleading value. The guard asserts existence but not identity.
- **Quoted evidence**: `expect(offComNo).toBeDefined();` (line 347), `expect(offComNc).toBeDefined();` (line 352)

---

### WT-7 — `crystal.test.ts` definition block: bare `toBeDefined()` for analogFactory

- **Test path**: `src/components/passives/__tests__/crystal.test.ts::definition` (line 345)
- **What is wrong**: `expect(CrystalDefinition.analogFactory).toBeDefined()` — trivially true existence check with no content verification.
- **Quoted evidence**: `expect(CrystalDefinition.analogFactory).toBeDefined();`

---

### WT-8 — `transmission-line.test.ts` definition block: bare `toBeDefined()` for `getInternalNodeCount`

- **Test path**: `src/components/passives/__tests__/transmission-line.test.ts::TransmissionLine::definition::has getInternalNodeCount`
- **What is wrong**: `expect(TransmissionLineDefinition.getInternalNodeCount).toBeDefined()` — asserts the function exists but does not test its output for any given property set.
- **Quoted evidence**: `expect(TransmissionLineDefinition.getInternalNodeCount).toBeDefined();` (line 647)

---

## Legacy References

None found.

---

## Notes

The two critical violations (V-1 and V-2) are connected to Gap G-1: the `SolverDiagnosticCode` union was never updated because the agents described the `analog-engine-interface.ts` file as "locked" by another parallel task. The underlying cause was a parallel wave execution order that prevented the type system from being updated. The workaround (type cast) is the banned pattern, and the progress notes explicitly acknowledge it. Both diagnostic codes must be added to the union and the casts removed.

The dead field `_currentVoltage` (V-3) suggests the fuse's `updateOperatingPoint()` was written with an intent to use the voltage reading inside `stampNonlinear`, but `stampNonlinear` instead recomputes the voltage from `updateState` independently. The field is vestigial.
