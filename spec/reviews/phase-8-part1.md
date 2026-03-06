# Review Report: Phase 8 — Wave 8.1 (Tasks 8.1.1–8.1.5)

## Summary

| Field | Value |
|---|---|
| Tasks reviewed | 5 (8.1.1, 8.1.2, 8.1.3, 8.1.4, 8.1.5) |
| Violations | 1 |
| Gaps | 4 |
| Weak tests | 5 |
| Legacy references | 0 |
| Verdict | **has-violations** |

---

## Violations

### V-1 — Historical-provenance comment in substitute-library.ts (minor)

- **File**: `src/analysis/substitute-library.ts`, line 199
- **Rule violated**: "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned."
- **Evidence**:
  ```
  // Copy all wires from the original circuit (element-level wires between substituted
  // components are replaced inside the substitution; top-level structural wires are kept)
  ```
- **Severity**: minor
- **Notes**: The clause "element-level wires between substituted components are replaced inside the substitution" describes what the substitution process replaces — a historical-provenance explanation of what changed. The comment should either be removed or rewritten to state only the invariant the reader needs to know ("top-level structural wires are preserved in the result circuit").

---

## Gaps

### G-1 — Task 8.1.4: `analyseSequential` signature does not match spec

- **Spec requirement** (`spec/phase-8-analysis-synthesis.md`, line 167):
  ```
  src/analysis/state-transition.ts — analyseSequential(facade, circuit): StateTransitionTable
  ```
  The spec prescribes two parameters: a `SimulatorFacade` and a `Circuit`. The function is responsible for identifying state variables, combinational inputs, and outputs by inspecting the circuit.

- **What was found** (`src/analysis/state-transition.ts`, lines 65–70):
  ```typescript
  export function analyseSequential(
    facade: SequentialAnalysisFacade,
    stateVars: SignalSpec[],
    inputs: SignalSpec[],
    outputs: SignalSpec[],
  ): StateTransitionTable {
  ```
  The implementation takes a bespoke `SequentialAnalysisFacade` (not `SimulatorFacade`) plus three pre-decomposed signal lists. The `circuit: Circuit` parameter is absent entirely. The function does not identify state variables by inspecting the circuit — the caller must provide them pre-computed.

- **Impact**: The spec contract (auto-identify flip-flop Q outputs, derive state variable list from circuit topology) is not implemented. The function cannot be called from any code that holds only a `SimulatorFacade` and a `Circuit`, which is the integration scenario described in the phase spec.

---

### G-2 — Task 8.1.4: Test `srLatch` does not verify transition values

- **Spec requirement** (`spec/phase-8-analysis-synthesis.md`, line 171):
  ```
  srLatch — SR latch → correct transitions for all S,R combinations
  ```
- **What was found** (`src/analysis/__tests__/state-transition.test.ts`, lines 97–120): The test creates an SR latch mock and asserts only `result.transitions.toHaveLength(8)`. It does not verify any specific `currentState`, `input`, `nextState`, or `output` values for any of the eight transitions.
- **Impact**: The spec requires verifying correctness of transitions for all S,R combinations. An implementation that returns eight rows with completely wrong values would pass this test. Classified as both a Gap (spec requirement unmet) and a Weak Test (see W-3 below).

---

### G-3 — Task 8.1.4: Test `twoStateBits` does not verify transition values

- **Spec requirement** (`spec/phase-8-analysis-synthesis.md`, line 172):
  ```
  twoStateBits — 2 flip-flops → 4 states × input combinations
  ```
- **What was found** (`src/analysis/__tests__/state-transition.test.ts`, lines 122–145): The test asserts only `result.transitions.toHaveLength(8)`. It does not verify the `currentState`, `input`, `nextState`, or `output` fields of any transition.
- **Impact**: Same as G-2. Counting rows is not the same as verifying correctness of the state machine behaviour.

---

### G-4 — Task 8.1.2: `substituteForAnalysis` returns `SubstitutionResult`, not `Circuit`

- **Spec requirement** (`spec/phase-8-analysis-synthesis.md`, line 95):
  ```
  substituteForAnalysis(circuit: Circuit, registry: ComponentRegistry): Circuit
  ```
  The spec prescribes a return type of `Circuit`.

- **What was found** (`src/analysis/substitute-library.ts`, lines 39–47, 91–94):
  ```typescript
  export interface SubstitutionResult {
    circuit: Circuit;
    blockingComponents: string[];
  }

  export function substituteForAnalysis(
    circuit: Circuit,
    registry: ComponentRegistry,
  ): SubstitutionResult {
  ```
  The function returns `SubstitutionResult` instead of `Circuit`. The blocking-components reporting is a reasonable extension, but it changes the public API contract from what the spec defines. Any caller expecting a bare `Circuit` return will require destructuring. This is a scope deviation from the spec's prescribed API surface.

---

## Weak Tests

### W-1 — `cycle-detector.test.ts::selfLoop`: assertion on `.length > 0` without content check is weak

- **Test**: `src/analysis/__tests__/cycle-detector.test.ts::CycleDetector::selfLoop` (lines 94–114)
- **Issue**: `expect(cycles.length).toBeGreaterThan(0)` is a length guard rather than an assertion on the specific detected cycle. While `componentIds.toContain('not1')` is present and useful, there is no assertion on `cycles[0].description` or the complete `componentIds` array. A bug that detects a spurious extra cycle, or a cycle with wrong component IDs, would not be caught.
- **Evidence**:
  ```typescript
  const cycles = detectCycles(circuit);
  expect(cycles.length).toBeGreaterThan(0);
  expect(cycles[0].componentIds).toContain('not1');
  ```
- **Recommendation**: Assert exact length (`toHaveLength(1)`) and verify the complete `componentIds` array and/or the `description` string.

---

### W-2 — `substitute-library.test.ts::muxToGates`: uses `.some()` predicates instead of exact assertions

- **Test**: `src/analysis/__tests__/substitute-library.test.ts::SubstituteLibrary::muxToGates` (lines 369–386)
- **Issue**: The test uses `typeIds.some((t) => t === 'AND' || t === 'And')` to check that AND gates are present, and similarly for NOT. It does not verify the exact number of each gate type produced, nor that the substituted circuit is structurally correct. An implementation that substitutes the MUX with a single AND gate and a single NOT gate (wrong gate count) would pass.
- **Evidence**:
  ```typescript
  expect(typeIds.some((t) => t === 'AND' || t === 'And')).toBe(true);
  expect(typeIds.some((t) => t === 'NOT' || t === 'Not')).toBe(true);
  ```

---

### W-3 — `state-transition.test.ts::srLatch`: row count only, no value verification

- **Test**: `src/analysis/__tests__/state-transition.test.ts::StateTransitionTable::srLatch` (lines 97–120)
- **Issue**: Only `result.transitions.toHaveLength(8)` is asserted. No transition's `currentState`, `input`, `nextState`, or `output` is checked. This is a trivially-true assertion: any result with 8 rows passes, regardless of correctness.
- **Evidence**:
  ```typescript
  expect(result.transitions).toHaveLength(8);
  ```
  (No further assertions after this line.)

---

### W-4 — `state-transition.test.ts::twoStateBits`: row count only, no value verification

- **Test**: `src/analysis/__tests__/state-transition.test.ts::StateTransitionTable::twoStateBits` (lines 122–145)
- **Issue**: Same pattern as W-3. Only `result.transitions.toHaveLength(8)` is asserted, verifying no correctness of state transitions.
- **Evidence**:
  ```typescript
  expect(result.transitions).toHaveLength(8);
  ```

---

### W-5 — `substitute-library.test.ts::subcircuitInlined`: uses `.some()` predicates instead of exact assertions

- **Test**: `src/analysis/__tests__/substitute-library.test.ts::SubstituteLibrary::subcircuitInlined` (lines 388–407)
- **Issue**: Uses `typeIds.some((t) => t === 'AND' || t === 'And')` to check for AND presence and `typeIds.some((t) => t === 'In')` / `typeIds.some((t) => t === 'Out')`. Does not verify exact element counts or that the subcircuit element itself is fully absent (only checks `not.toContain('AndSubcircuit')` for the type name, but subcircuit element may have been renamed by the `OffsetElement` wrapper — the `typeId` of `OffsetElement` is inherited from the inner element, so this check is correct, but the test still lacks structural precision).
- **Evidence**:
  ```typescript
  expect(typeIds.some((t) => t === 'AND' || t === 'And')).toBe(true);
  expect(typeIds.some((t) => t === 'In')).toBe(true);
  expect(typeIds.some((t) => t === 'Out')).toBe(true);
  ```

---

## Legacy References

None found.

---

## Notes

### Task 8.1.1 — Model Analyzer

Implementation is complete and matches the spec API exactly: `analyseCircuit(facade: SimulatorFacade, circuit: Circuit): TruthTable`. All five specified tests are present and contain specific value assertions (exact bigint row values). The 20-bit input limit and cycle detection paths are correctly implemented and tested. The `multiBit` test uses two 1-bit inputs rather than one 2-bit input; this is acceptable as the spec intent ("2-bit input, 2-bit output → 4 rows") is satisfied by 2 total bits of input.

The comment block on `model-analyser.ts` lines 1–15 is a file-level JSDoc describing the algorithm's steps and Java reference. This is permissible — it explains the algorithm to future developers, not what the code replaced.

### Task 8.1.3 — Truth Table Display/Editor

Implementation matches spec API. The `TruthTableTab` class is present with `render()`, `getRows()`, and `getOutputCell()`. All three specified UI tests are present with specific value assertions. The `TruthTable` data model implements `setOutput`, `addInput`, `removeInput`, and `reorderInputColumns` as specified. The `reorderColumns` test verifies exact output values after the swap. No issues found in this task.

### Task 8.1.5 — Truth Table Import/Export

All seven functions (`importCsv`, `exportCsv`, `exportHex`, `exportLatex`, `exportTestCase`, `loadTru`, `saveTru`) are present as specified. The five required tests are present, and four of them use exact value assertions. An additional `csvWithDontCare` test is present (scope extension, not a violation). The `latexExport` test verifies `\begin{tabular}`, column names, and data line count. The `testCaseExport` test verifies exact line content. The `truRoundTrip` test verifies per-row output values. No issues found in this task.
