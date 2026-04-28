# Review Report: Batch 5 — Behavioral + Coordinator + Compile + Editor tests (3.C.* part 2)

## Summary

| Item | Value |
|------|-------|
| Task groups reviewed | 7 (3.C.spice-behav-1, 3.C.behav-2, 3.C.mna-buck, 3.C.sparse, 3.C.coordinator, 3.C.compile, 3.C.editor) |
| Files reviewed | 20 |
| Violations — critical | 1 |
| Violations — major | 4 |
| Violations — minor | 1 |
| Gaps | 2 |
| Weak tests | 6 |
| Legacy references | 0 |
| Verdict | has-violations |

---

## Violations

### V-01 — CRITICAL — Duplicate `import type { AnalogFactory }` in spice-import-dialog.test.ts

**File:** `src/solver/analog/__tests__/spice-import-dialog.test.ts`  
**Lines:** 30 and 36  
**Rule violated:** Code hygiene — duplicate declarations prevent compilation; this is a TS2300 error that will block the entire test file from running.  
**Evidence:**
```ts
// line 30
import type { AnalogFactory } from "../../../core/registry.js";
import { BJT_NPN_DEFAULTS } from "../../../components/semiconductors/bjt.js";

// line 36 — DUPLICATE
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
```
The first import at line 30 brings in `AnalogFactory` as a type-only import. The second import at line 36 re-imports both `ModelEntry` and `AnalogFactory` from the same module. TypeScript will emit TS2300 "Duplicate identifier 'AnalogFactory'" in strict mode. The `getFactory` helper function (which needs `ModelEntry`) was added as a second import block mid-file without removing or merging with the existing import. This is not a comment problem — it is a structural compile-time error that makes the entire test file non-functional. Every test in `spice-import-dialog.test.ts` will fail to run.  
**Severity:** Critical

---

### V-02 — MAJOR — `3.C.spice-behav-1` never verified: status `pending` in hybrid-state despite `complete` in progress.md

**File:** `spec/.hybrid-state.json` line 411; `spec/progress.md` entry for `3.C.spice-behav-1`  
**Rule violated:** Verification gate (CLAUDE.md: "Every agent task that modifies code MUST be followed by a verifier pass before the work is considered complete.")  
**Evidence:**
```json
// spec/.hybrid-state.json line 411
"3.C.spice-behav-1": "pending",
```
The progress.md marks all four files as `complete`, but the hybrid-state shows `pending` — meaning the orchestrator's verifier was never dispatched or never confirmed this group. The implementer's §C.4 reports exist in progress.md but the orchestrator-level verification pass did not run. The duplicate-import violation in V-01 (above) is the likely reason the verifier would have caught this. Without verifier confirmation, this group cannot be considered done.  
**Severity:** Major

---

### V-03 — MAJOR — `reuses_symbolic_across_numeric_refactor` test solves but asserts nothing on solution values

**File:** `src/solver/analog/__tests__/sparse-solver.test.ts`  
**Lines:** 127–157  
**Rule violated:** rules.md — "Tests ALWAYS assert desired behaviour. Never adjust tests to match perceived limitations." Reviewer posture: trivially-true assertions.  
**Evidence:**
```ts
it("reuses_symbolic_across_numeric_refactor", () => {
  // ...
  const r1 = solver.factor();
  expect(r1).toBe(0);
  const x1 = new Float64Array(3);
  solver.solve(rhs1, x1);
  // NO assertion on x1 values

  // ...
  const r2 = solver.factor();
  expect(r2).toBe(0);
  const x2 = new Float64Array(3);
  solver.solve(rhs2, x2);
  // NO assertion on x2 values — comment in code even says:
  // "Analytical: det = 8-1=7; x1 = 7/7 = 1; x2 = 7/7 = 1"
});
```
The test knows the expected solution (`x[1]=1, x[2]=1`) — it even documents this in the comment — but never asserts it. This makes the test a pass-always for the "reuse" property: the solver could return garbage values and the test would still pass. The purpose of this test is to verify that symbolic reuse produces correct numeric results, not just that `factor()` returns 0.  
**Severity:** Major

---

### V-04 — MAJOR — `invalidate_forces_resymbolize` test solves but asserts nothing on solution values

**File:** `src/solver/analog/__tests__/sparse-solver.test.ts`  
**Lines:** 159–185  
**Rule violated:** rules.md — "Tests ALWAYS assert desired behaviour."  
**Evidence:**
```ts
it("invalidate_forces_resymbolize", () => {
  // First diagonal solve: A=[[3,0],[0,5]], b=[6,10] → x=[2,2]
  const x1 = new Float64Array(3);
  solver.solve(rhs1, x1);
  // NO assertion on x1

  // Second full 2x2 solve: A=[[4,1],[1,3]], b=[1,2]
  // Analytical: det=11; x[1]=(4-2)/11=... actually x[1]=(3*1-1*2)/11=1/11, x[2]=(4*2-1*1)/11=7/11
  const x2 = new Float64Array(3);
  solver.solve(rhs2, x2);
  // NO assertion on x2
});
```
The test is supposed to verify that calling `invalidateTopology()` forces a resymbolize that then produces a correct result for the new sparsity pattern. Without asserting the solution values, it only verifies that `factor()` does not return an error code — not that the result is numerically correct.  
**Severity:** Major

---

### V-05 — MAJOR — `cross-domain mode output adapter stamps rOut conductance` test has NO assertions

**File:** `src/solver/analog/__tests__/bridge-compilation.test.ts`  
**Lines:** 161–171  
**Rule violated:** rules.md — "Tests ALWAYS assert desired behaviour." This is a test body with zero `expect` calls.  
**Evidence:**
```ts
it('cross-domain mode output adapter stamps rOut conductance', () => {
  const group = makeBoundaryGroup(1);
  const stub = makeStub(group, 'digital-to-analog');
  const partition = makePartition([stub], [group]);
  const compiled = compileAnalogPartition(partition, new ComponentRegistry(), undefined, undefined, undefined, 'cross-domain');
  const adapter = compiled.bridgeAdaptersByGroupId.get(1)![0] as BridgeOutputAdapter;
  const solver = new MockSolver();
  adapter.load(makeCtx(solver));
  // nodeId=1 -> nodeIdx=0. Loaded: 1/rOut on diagonal.
  // ← NO expect() call. The comment describes what should be asserted but the assertion was never written.
});
```
The adjacent `none mode` test (lines 135–144) and the `per-net ideal override` test (lines 174–184) both correctly assert `expect(solver.sumStamp(0, 0)).toBe(0)`. The `cross-domain` loaded case is the positive complement — it should assert `expect(solver.sumStamp(0, 0)).toBeCloseTo(1 / CMOS_3V3.rOut, 9)` or similar. The test as written always passes vacuously.  
**Severity:** Major

---

### V-06 — MINOR — `pinNodeIds` appears in a comment in wire-current-resolver.test.ts (historical-provenance comment)

**File:** `src/editor/__tests__/wire-current-resolver.test.ts`  
**Line:** 790  
**Rule violated:** rules.md — "No `# previously this was...` comments." / "Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour."  
**Evidence:**
```ts
// Element currents (convention: positive = from pinNodeIds[0] to [1])
```
This comment references the old positional-array field `pinNodeIds` which was removed in the wave. The comment describes the old convention using the old field name — a historical-provenance comment. The code below it uses `getElementCurrent()` and has nothing to do with `pinNodeIds`.  
**Severity:** Minor

---

## Gaps

### G-01 — spec A.21 item 3: bridge-compilation.test.ts does not verify the anonymous CompositeElement subclass

**Spec requirement (A.21 item 3):** The `compileSubcircuitToMnaModel` function returns a `MnaModel` whose composite is an anonymous class extending `CompositeElement`. The spec note in the assignment says: "verify it still tests the new anonymous CompositeElement subclass produced by `compileSubcircuitToMnaModel`."  
**What was found:** `bridge-compilation.test.ts` tests `compileAnalogPartition` and bridge adapter creation/loading. It does not test `compileSubcircuitToMnaModel` or the anonymous `CompositeElement` subclass that function now produces. There is no assertion that the composite produced by subcircuit compilation is an instance of `CompositeElement` or has the expected `getSubElements()` forwarding behaviour.  
**File:** `src/solver/analog/__tests__/bridge-compilation.test.ts`  
**Note:** The progress.md entry for this file says "No changes required — file had zero C.1 forbidden-pattern hits prior to the wave." This is consistent with the file being otherwise clean, but the spec assignment explicitly called for verifying the anonymous CompositeElement subclass. This verification is absent.

---

### G-02 — spec §B.13 mandate: `or/nor/xor` factory tests in behavioral-gate.test.ts are trivial existence checks only

**Spec requirement (§B.13):** After deleting flag-only `it()` blocks, the replacement tests for factory functions must verify element behaviour, not just field existence. The spec says "Delete `it()` blocks dedicated solely to flag assertions" — the replacement should assert meaningful behaviour.  
**What was found:** Three factory tests were written as near-trivial existence checks:
```ts
it("or_factory_returns_analog_element", () => {
  const element = factory(new Map([["In_1", 1], ["In_2", 2], ["out", 3]]), props, () => 0);
  expect(element._pinNodes.size).toBe(3);
});
it("nor_factory_returns_analog_element", () => { ... expect(element._pinNodes.size).toBe(3); });
it("xor_factory_returns_analog_element", () => { ... expect(element._pinNodes.size).toBe(3); });
```
`_pinNodes.size` is set by the factory constructor in a single line and is structurally guaranteed — it never fails. These replaced the old `isNonlinear/isReactive` flag assertions with assertions that are equally trivial. The `and_factory_returns_analog_element` test at least checks `branchIndex === -1` and `typeof element.load === "function"`. The or/nor/xor variants test nothing meaningful.  
**File:** `src/solver/analog/__tests__/behavioral-gate.test.ts` (lines 451–470)

---

## Weak Tests

### WT-01 — behavioral-gate.test.ts::Factory::or_factory_returns_analog_element

**Path:** `src/solver/analog/__tests__/behavioral-gate.test.ts::Factory::or_factory_returns_analog_element`  
**Issue:** Single assertion `expect(element._pinNodes.size).toBe(3)` is structurally guaranteed to pass by the factory constructor — tests no behaviour.  
**Evidence:**
```ts
it("or_factory_returns_analog_element", () => {
  const element = factory(new Map([["In_1", 1], ["In_2", 2], ["out", 3]]), props, () => 0);
  expect(element._pinNodes.size).toBe(3);
});
```

---

### WT-02 — behavioral-gate.test.ts::Factory::nor_factory_returns_analog_element

**Path:** `src/solver/analog/__tests__/behavioral-gate.test.ts::Factory::nor_factory_returns_analog_element`  
**Issue:** Same as WT-01. Only asserts `_pinNodes.size`.  
**Evidence:**
```ts
it("nor_factory_returns_analog_element", () => {
  const element = factory(new Map([["In_1", 1], ["In_2", 2], ["out", 3]]), props, () => 0);
  expect(element._pinNodes.size).toBe(3);
});
```

---

### WT-03 — behavioral-gate.test.ts::Factory::xor_factory_returns_analog_element

**Path:** `src/solver/analog/__tests__/behavioral-gate.test.ts::Factory::xor_factory_returns_analog_element`  
**Issue:** Same as WT-01. Only asserts `_pinNodes.size`.  
**Evidence:**
```ts
it("xor_factory_returns_analog_element", () => {
  const element = factory(new Map([["In_1", 1], ["In_2", 2], ["out", 3]]), props, () => 0);
  expect(element._pinNodes.size).toBe(3);
});
```

---

### WT-04 — sparse-solver.test.ts::reuses_symbolic_across_numeric_refactor

**Path:** `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver::reuses_symbolic_across_numeric_refactor`  
**Issue:** Computes solution in `x2` but makes no assertion on its values. The comment documents the expected values (`x[1]=1, x[2]=1`) but they are never asserted. The test only verifies `factor()` returns 0 both times — it does not verify the reused symbolic factorization produces a numerically correct result.  
**Evidence:** Lines 127–157: `solver.solve(rhs2, x2)` with no subsequent `expect(x2[...])` call.

---

### WT-05 — sparse-solver.test.ts::invalidate_forces_resymbolize

**Path:** `src/solver/analog/__tests__/sparse-solver.test.ts::SparseSolver::invalidate_forces_resymbolize`  
**Issue:** Calls `solver.solve(rhs1, x1)` and `solver.solve(rhs2, x2)` but asserts nothing on the solution vectors. The test only checks `factor()` return codes.  
**Evidence:** Lines 159–185: Both `x1` and `x2` are computed and never asserted.

---

### WT-06 — bridge-compilation.test.ts::cross-domain mode bridge adapters are loaded::cross-domain mode output adapter stamps rOut conductance

**Path:** `src/solver/analog/__tests__/bridge-compilation.test.ts::bridge-compilation: cross-domain mode bridge adapters are loaded::cross-domain mode output adapter stamps rOut conductance`  
**Issue:** Zero `expect()` calls. Test body loads the adapter and stops. The comment describes what should be verified but the assertion is absent. This is a pre-existing vacuously-passing test (also captured as V-05 above).  
**Evidence:**
```ts
adapter.load(makeCtx(solver));
// nodeId=1 -> nodeIdx=0. Loaded: 1/rOut on diagonal.
// ← no expect()
```

---

## Legacy References

None found.

---

## Per-file C.1 Grep Results

All 20 files in this batch returned zero hits on the full C.1 forbidden-pattern sweep (`isReactive`, `isNonlinear`, `mayCreateInternalNodes`, `getInternalNodeCount`, `ReactiveAnalogElement`, `allNodeIds` field-form, `pinNodeIds` field-form, `withNodeIds(`, `makeVoltageSource(` as 4-arg, `stateBaseOffset`) with the following qualified notes:

- `behavioral-combinational.test.ts` and `behavioral-gate.test.ts`: contain a local function named `makeVoltageSource` (3-arg wrapper around `makeDcVoltageSource`). This is a conforming local helper, not the deleted 4-arg test helper. C15 does not apply.
- `convergence-regression.test.ts`: same pattern — local `makeVoltageSource` is a 3-arg wrapper.
- `wire-current-resolver.test.ts`: the string `pinNodeIds` appears only in a comment (line 790). This is the V-06 minor violation (historical-provenance comment referencing the removed field name).

---

## Notes on 3.C.spice-behav-1 Pending Status

The hybrid-state shows `"3.C.spice-behav-1": "pending"`, meaning the orchestrator never dispatched a verifier for this group. The progress.md marks all four files as `complete` with §C.4 reports. The most likely cause: the duplicate `AnalogFactory` import error in `spice-import-dialog.test.ts` (V-01) was introduced during implementation and would cause the test file to fail TypeScript compilation, which would cause any verifier to reject the group. This creates a circular: the implementer marked it complete, but the verifier was never run (or ran and found the compile error and reset to pending without recording the failure).

The assignment states this group's status is `pending` and asks to investigate. Root cause: V-01 (duplicate `import type { AnalogFactory }`) at lines 30 and 36 of `spice-import-dialog.test.ts`. Until that is fixed and the verifier re-runs, this group cannot be marked passed.

---

## Notes on 3.C.mna-buck Failed Status

The hybrid-state shows `"3.C.mna-buck": "failed"`. From the vitest failures file:

- `diode_shockley_equation_consistency` in `mna-end-to-end.test.ts` fails with `expected 0.013536179992185128 to be less than 0.001`.

This is a genuine numerical failure in the production diode model implementation, not a test authoring problem. The test correctly asserts the Shockley equation consistency to 0.1% tolerance — the assertion is appropriate. The failure indicates a pre-existing numerical divergence in `createDiodeElement` / the diode's `load()` implementation that was revealed by the fix-pass's addition of real production-factory wrappers. The test assertions themselves are good.

The `buckbjt-nr-probe.test.ts` failure (`buckbjt_load_dcop_parity: rhsOld + noncon + diagGmin + srcFact bit-exact vs ngspice`) is a separate numerical parity failure, also pre-existing, not caused by this batch's changes.

The mna-buck group's verifier `failed` status is therefore caused by pre-existing numerical failures in production code, not by test authoring defects in this batch.

---

## Notes on 3.C.sparse Failed Status

`sparse-solver.test.ts` does not appear in the vitest failures file — all its tests are passing. The `"3.C.sparse": "failed"` hybrid-state status reflects the verifier's assessment of the **original** (pre-fix) sparse-solver test, before the fix-pass added real assertions to `sums_duplicate_entries`, `identity_matrix_trivial`, and `mna_resistor_divider_3x3`. The fix-pass (progress.md entry `3.C.sparse (fix)`) was applied and those three tests now have real assertions and are passing. However, the two tests flagged as weak (WT-04, WT-05) remain without value assertions.
