# Review Report: Phase 6 — Model Rewrites (Waves 6.1, 6.2, 6.3)

## Summary

- **Tasks reviewed**: 10 (6.1.1, 6.1.2, 6.2.a, 6.2.b, 6.2.c, 6.2.d, 6.3.1, 6.3.2, 6.3.3)
- **Violations found**: 11 (6 critical, 3 major, 2 minor)
- **Gaps found**: 8
- **Verdict**: has-violations

Wave 6.4 explicitly out of scope.

## Violations

### V-01 (CRITICAL): `src/core/analog-types.ts::AnalogElementCore` entirely unmodified
- **File**: `src/core/analog-types.ts`:127-243
- **Rule**: Task 6.1.2 "Files to modify" + acceptance: "No `stamp()`, `stampNonlinear()`, `updateOperatingPoint()`, `stampCompanion()`, `stampReactiveCompanion()` in **either** `AnalogElement` (element.ts) or `AnalogElementCore` (core/analog-types.ts)"
- **Evidence**: Full pre-migration split interface retained:
  ```typescript
  stamp(solver: SparseSolverStamp): void;
  stampNonlinear?(solver: SparseSolverStamp): void;
  updateOperatingPoint?(voltages: Readonly<Float64Array>): boolean | void;
  stampCompanion?(dt, method, voltages, order, deltaOld): void;
  stampReactiveCompanion?(solver: SparseSolverStamp): void;
  updateChargeFlux?(voltages, dt, method, order, deltaOld): void;
  updateState?(dt: number, voltages: Float64Array): void;
  checkConvergence?(voltages, prevVoltages, reltol, abstol): boolean;  // old 4-arg
  shouldBypass?(voltages, prevVoltages): boolean;
  ```
  `load(ctx: LoadContext): void` is absent. Task 6.2.c progress entry explicitly confessed: *"`core/analog-types.ts` is explicitly outside my 5-file modification scope."* Spec is explicit this is NOT cross-phase carve-out: *"Two sibling interfaces with different method sets is a shim by construction — both must reflect the post-Wave-6.1 shape atomically."*
- **Severity**: critical

### V-02 (CRITICAL): `integrateCapacitor`/`integrateInductor` deleted but imported by 7 production files
- **Files**:
  - `src/solver/analog/fet-base.ts`:22 (import); 512, 531, 597, 606, 926 (6 calls)
  - `src/components/semiconductors/diode.ts`:34 (import); 597 (call)
  - `src/components/semiconductors/mosfet.ts`:48 (import); 1699, 1731, 1772, 1883, 1911, 1926 (6 calls)
  - `src/components/semiconductors/varactor.ts`:33 (import); 232 (call)
  - `src/components/semiconductors/tunnel-diode.ts`:44 (import); 319 (call)
  - `src/components/io/led.ts`:31 (import); 310 (call)
  - `src/solver/analog/digital-pin-model.ts`:21 (import); 185, 203, 315, 333 (4 calls)
- **Rule**: Task 6.3.2 acceptance ("`integrateCapacitor` and `integrateInductor` do not exist. No element imports them"); Task 6.2.2 acceptance; Task 6.2.3 acceptance
- **Evidence** (`fet-base.ts`): `import { integrateCapacitor } from "./integration.js";` ... `const res = integrateCapacitor(caps.cgs, vgsNow, q0, q1, q2, dt, h1, order, method, ccapPrev);`
- **Impact**: Modules fail to load at runtime. `integrateCapacitor_does_not_exist` unit test creates false-green.
- **Severity**: critical

### V-03 (CRITICAL): Mock element in `test-helpers.ts` still implements old split interface
- **File**: `src/solver/analog/__tests__/test-helpers.ts`:76-82
- **Rule**: Task 6.3.1 acceptance
- **Evidence**:
  ```typescript
  return {
    pinNodeIds, allNodeIds: pinNodeIds, branchIndex: -1,
    stamp: () => {}, stampNonlinear: () => {},
    updateOperatingPoint: () => {}, isLinear: true, isReactive: false,
    ...
  ```
  No `load(ctx)`. Task 6.3.1 marked complete despite this.
- **Severity**: critical

### V-04 (CRITICAL): `controlled-source-base.test.ts` calls `stampNonlinear` on production subclasses
- **File**: `src/solver/analog/__tests__/controlled-source-base.test.ts`:89, 100, 111, 122
- **Rule**: Task 6.3.1 acceptance
- **Evidence**: `src.stampNonlinear(nullSolver);` (4 sites). Task 6.2.b progress flagged this; 6.3.1 marked complete without fixing.
- **Severity**: critical

### V-05 (CRITICAL): Five behavioral test files call deleted methods on migrated elements
- **Files**:
  - `behavioral-flipflop.test.ts`: ~13 sites (lines 118-305)
  - `behavioral-sequential.test.ts`: ~6 sites (lines 211-331)
  - `behavioral-remaining.test.ts`: lines 384, 397 `relay.stampCompanion!` + surrounding `stamp` loops
  - `behavioral-flipflop-variants.test.ts`: multiple sites including line 224 `element.updateCompanion(...)`
  - `behavioral-integration.test.ts`:492-494 (`flushQ` helper)
- **Rule**: Task 6.3.1 + Task 6.2.6 acceptance
- **Evidence**: `element.stamp(solver); element.stampNonlinear(solver); element.updateOperatingPoint(...)`
- **Severity**: critical

### V-06 (CRITICAL): `fet-base.test.ts` and `dcop-init-jct.test.ts` call deleted methods
- **Files**:
  - `src/solver/analog/__tests__/fet-base.test.ts`: 228, 237, 242, 246, 270, 276, 348, 355, 405, 418, 430, 438, 459, 478, 488 (15 sites)
  - `src/solver/analog/__tests__/dcop-init-jct.test.ts`: 126, 143, 168, 192, 227, 240, 262, 274, 292, 294 (10 sites)
- **Rule**: Task 6.3.1 + Task 6.2.3 acceptance
- **Evidence**: `element.updateOperatingPoint!(voltages, null);`, `element.stampCompanion!(dt, "bdf1", voltages, 1, [dt])`, `element.stampNonlinear!(solver)`
- **Severity**: critical

### V-07 (MAJOR): `varactor.test.ts` uses `as any` casts to call deleted methods
- **File**: `src/components/semiconductors/__tests__/varactor.test.ts`:74, 81, 91-92, 219, 242, 248
- **Rule**: Task 6.3.1 + rules.md ban on shims
- **Evidence**:
  ```typescript
  element.updateOperatingPoint!(voltages);
  (varactor as any).updateOperatingPoint!(voltages);
  (varactor as any).stampCompanion!(dt, "trapezoidal", voltages, 2, [dt, dt]);
  expect(v.stampCompanion).toBeDefined();
  ```
- **Severity**: major

### V-08 (MAJOR): `sparse-solver.test.ts` sniffs `el.stampNonlinear` presence
- **File**: `src/solver/analog/__tests__/sparse-solver.test.ts`:461, 482
- **Rule**: Task 6.3.1 + rules.md ban on conditional method-presence checks
- **Evidence**: `if (el.isNonlinear && el.stampNonlinear) el.stampNonlinear(rawSolver);`
- **Severity**: major

### V-09 (MAJOR): `behavioral-flipflop-engine-dispatch.test.ts` narrates deleted engine path
- **File**: `src/solver/analog/__tests__/behavioral-flipflop-engine-dispatch.test.ts`:4-6, 222-229
- **Evidence**: `element.updateCompanion(1e-9, 'bdf1', ...)` + pre-migration narrative header comment
- **Severity**: major

### V-10 (MINOR): Historical-provenance migration comment in `test-helpers.ts`
- **File**: `src/solver/analog/__tests__/test-helpers.ts`:743-748
- **Evidence**: Describes migration helpers + prior API names
- **Severity**: minor

### V-11 (MINOR): TODO comments in `netlist-generator.ts`
- **File**: `src/solver/analog/__tests__/harness/netlist-generator.ts`:269, 281, 298
- **Severity**: minor

## Gaps

### G-01: `AnalogElementCore` missing `load(ctx: LoadContext): void`
- **Spec**: Task 6.1.2 Files to modify
- **File**: `src/core/analog-types.ts`

### G-02: `checkConvergence` signature on `AnalogElementCore` not updated to single-arg `(ctx: LoadContext)`
- **File**: `src/core/analog-types.ts`:170

### G-03: `resistor_load_interface` test missing from `mna-end-to-end.test.ts`
- **Spec**: Task 6.2.1 Tests
- **File**: `src/solver/analog/__tests__/mna-end-to-end.test.ts`

### G-04: All 6 per-element DC-OP parity tests from Task 6.2.1 missing
- `resistor_load_dcop_parity`, `potentiometer_load_dcop_parity`, `ntc_load_dcop_parity`, `ldr_load_dcop_parity`, `fuse_load_dcop_parity`, `spark_gap_load_dcop_parity`

### G-05: All 8 per-element transient parity tests from Task 6.2.2 missing
- capacitor / polarized_cap / inductor / transformer / tapped_transformer / crystal / memristor / transmission_line `_load_transient_parity`

### G-06: `buckbjt-convergence.test.ts` missing; `dcop-init-jct.test.ts` and `fet-base.test.ts` not migrated to `load()`
- **Spec**: Task 6.2.3 Tests

### G-07: Tasks 6.2.4 and 6.2.5 parity tests absent
- One parity test per source type + per active element (10 elements)

### G-08: `SparseSolver.stamp(row, col, value)` still present (Task 6.3.4 not executed)
- **Spec**: Task 6.3.4 deletion
- **File**: `src/solver/analog/sparse-solver.ts`
- Method still on `SparseSolver`; 50+ caller sites across passive elements

## Weak Tests

### T-01: `integrateCapacitor_does_not_exist` green but production code still imports it
- **Path**: `integration.test.ts::deleted_integrate_functions::integrateCapacitor_does_not_exist`
- **Issue**: False confidence; did not statically check that production callers are gone

### T-02: Behavioral tests drive elements via deleted methods; never exercise `load(ctx)`
- **Paths**: `behavioral-flipflop.test.ts`, `behavioral-sequential.test.ts`, `behavioral-flipflop-variants.test.ts`, `behavioral-integration.test.ts::flushQ`
- **Issue**: Post-migration `load(ctx)` path has zero behavioral coverage

### T-03: `varactor.test.ts::expect(v.stampCompanion).toBeDefined()` is an inverse-correctness assertion
- **Path**: `varactor.test.ts`:219
- **Issue**: Passes only when migration is incomplete

## Legacy References

### L-01: `src/solver/analog/__tests__/test-helpers.ts`:744-748 — migration commentary
### L-02: `src/solver/analog/__tests__/behavioral-flipflop-engine-dispatch.test.ts`:4-6 — pre-migration defect narrative
### L-03: `src/solver/analog/__tests__/behavioral-remaining.test.ts`:319-336 — 18-line pre-migration flow description
### L-04: `src/core/analog-types.ts`:205-243 — JSDoc throughout `AnalogElementCore` describes deleted methods
