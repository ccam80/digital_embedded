# Review Report: Phase 1 — Domain Leak Fix

## Summary

- **Tasks reviewed**: 6 completed (W1-T7, W2-T1, W2-T2, W2-T3, W2-T4, W2-T5); Wave 1 tasks W1-T1 through W1-T6 and W1-T8 through W1-T12 are listed as `pending` in progress.md but are implemented in source files — reviewed here on the basis of actual file state.
- **Violations**: 8
- **Gaps**: 9
- **Weak tests**: 4
- **Legacy references**: 3
- **Verdict**: `has-violations`

---

## Critical Observation: Wave 1 Tasks Implemented But Not Recorded

`spec/progress.md` lists W1-T1 through W1-T6 and W1-T8 through W1-T12 as `pending`. However the actual source files show these tasks were implemented: `compile/types.ts` has the unified `Diagnostic`, `netlist.ts` has `resolveNets` rebuilt on infrastructure, `facade.ts` has `setSignal`/`readSignal`/`settle`, etc. The progress.md was never updated to record these completions. This is a critical tracking failure — any future agent reading progress.md will re-implement already-done work.

---

## Violations

### V1 — Historical-provenance comment in extract-connectivity.ts
- **File**: `src/compile/extract-connectivity.ts:85`
- **Rule violated**: No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned.
- **Evidence**: `// for legacy circuits that predate model-property-at-creation.`
- **Severity**: minor

---

### V2 — "for now" comment in executor.ts (admitted deferral)
- **File**: `src/testing/executor.ts:245`
- **Rule violated**: Red-flag comment containing "for now" — indicates known incompleteness left in place.
- **Evidence**: `// Attach failure detail to the vector (stored in actualOutputs for now — message is informational)`
- **Severity**: major

The `formatAnalogFailure` return value is called with `void` at line 246 — the formatted failure message is computed but silently discarded. The comment admits this is a deferral. The failure message specified by the spec ("Expected 3.3V +-5% at Vout, got 2.8V (delta: 500mV)") is never stored in the vector result or surfaced to the caller.

---

### V3 — `dig-pin-scanner.ts` not deleted despite spec requirement
- **File**: `src/io/dig-pin-scanner.ts`
- **Rule violated**: "All replaced or edited code is removed entirely. Scorched earth." Spec explicitly states: "Delete (only consumer is `circuit_describe_file`)." Rules also state: "If a rule seems to conflict with the task, flag it to the orchestrator. Do not resolve the conflict yourself."
- **Evidence from progress.md W2-T2 notes**: "Note: `src/io/dig-pin-scanner.ts` was NOT deleted — it has other consumers (scan74xxPinMap used by circuit-mcp-server.ts, generate-all-components-fixture.ts, measure-engine-references.ts). Only the scanDigPins import was removed from circuit-tools.ts."
- **Evidence from progress.md W2-T5 notes**: "The file was previously deleted and restored per spec (only delete if ONLY consumer is circuit_describe_file, which was already deleted by W2-T2)"
- **Severity**: major

The agent identified a genuine conflict and resolved it unilaterally without flagging to the orchestrator. The rules prohibit this. The file exists at `src/io/dig-pin-scanner.ts`.

---

### V4 — `SolverDiagnostic` type alias kept as backward-compat shim in `analog-types.ts`
- **File**: `src/core/analog-types.ts:155-156`
- **Rule violated**: "No backwards compatibility shims. No re-exports." Spec acceptance criteria: "Single `Diagnostic` type used everywhere; `SolverDiagnostic` type deleted."
- **Evidence**:
  ```
  export type { DiagnosticCode as SolverDiagnosticCode } from "../compile/types.js";
  export type { Diagnostic as SolverDiagnostic } from "../compile/types.js";
  ```
- **Severity**: major

The spec says "Delete `SolverDiagnostic` type — Delete from `core/analog-types.ts`". Instead the type is kept as a re-export alias. This is the definition of a backward-compatibility shim.

---

### V5 — `SolverDiagnostic` type alias kept as backward-compat shim in `analog-engine-interface.ts`
- **File**: `src/core/analog-engine-interface.ts:19-20`
- **Rule violated**: Same as V4.
- **Evidence**:
  ```
  export type { DiagnosticCode as SolverDiagnosticCode } from "../compile/types.js";
  export type { Diagnostic as SolverDiagnostic } from "../compile/types.js";
  ```
- **Severity**: major

The spec task for `src/core/analog-engine-interface.ts` states: "update re-exports of `SolverDiagnostic` to re-export `Diagnostic` from the unified location." The implementation kept aliased re-exports under the old name. `SolverDiagnostic` remains importable and is actively used in `compiled-analog-circuit.ts` and test files.

---

### V6 — `compiled-analog-circuit.ts` still imports and uses `SolverDiagnostic`
- **File**: `src/solver/analog/compiled-analog-circuit.ts:10,107`
- **Rule violated**: Imports of symbols that should be deleted; migration incomplete.
- **Evidence**:
  ```
  import type { CompiledAnalogCircuit, SolverDiagnostic } from "../../core/analog-engine-interface.js";
  readonly diagnostics: SolverDiagnostic[];
  ```
- **Severity**: major

The `diagnostics` array on `ConcreteCompiledAnalogCircuit` uses the alias type rather than the unified `Diagnostic`. The compile.ts loop pushing `compiledAnalog.diagnostics` into the unified array only works structurally because `SolverDiagnostic` is an alias — the migration was not completed cleanly.

---

### V7 — CLAUDE.md not updated: still documents old `sim-set-input`/`sim-read-output` message names
- **File**: `CLAUDE.md:73`
- **Rule violated**: "All replaced or edited code is removed entirely." Wire-protocol rename is a "hard cut, old names deleted." CLAUDE.md is the authoritative API documentation.
- **Evidence**: `  sim-set-input, sim-step, sim-read-output       — Drive simulation`
- **Severity**: major

The spec task W2-T3 renamed `sim-set-input` to `sim-set-signal` and `sim-read-output` to `sim-read-signal` as a hard cut. The implementation updated `postmessage-adapter.ts` and E2E tests correctly, but CLAUDE.md still documents the deleted names.

---

### V8 — Analog failure message discarded (dead computation, `void` operator)
- **File**: `src/testing/executor.ts:246`
- **Rule violated**: "Never mark work as deferred, TODO, or not implemented." The formatted message is computed but thrown away.
- **Evidence**: `void formatAnalogFailure(name, expected.value, actual, expected.tolerance ?? testData.analogPragmas?.tolerance);`
- **Severity**: major

`formatAnalogFailure` returns a `string`. The `void` operator discards it. The spec acceptance criterion for the analog test failure message is not met — no such message is returned in failing test vector results.

---

## Gaps

### G1 — `floating-terminal` diagnostic code used instead of spec-mandated `unconnected-analog-pin`
- **Spec requirement**: "For analog single-pin groups, reword to 'Floating terminal' with no directional language." The spec DiagnosticCode list includes `unconnected-analog-pin`.
- **Found**: A new code `floating-terminal` was added to the `DiagnosticCode` union (`compile/types.ts:67`) and used in `extract-connectivity.ts:493`. The spec-listed code `unconnected-analog-pin` is also in the union but not used. A new undocumented code was introduced instead of the spec-mandated one.
- **File**: `src/compile/extract-connectivity.ts:493`, `src/compile/types.ts:67`

---

### G2 — Width-mismatch diagnostic message improvement not implemented
- **Spec requirement**: "Width-mismatch diagnostic improved to name pins: `Bit-width mismatch: R1:A [8-bit] gate:out [1-bit]` instead of `Net N: connected digital pins have mismatched bit widths: 1, 8`". Also: "Width-mismatch diagnostic for analog-digital boundary says 'Analog terminal connected to multi-bit digital bus'".
- **Found**: The improved pin-named message format and analog-boundary special case are absent from `src/compile/extract-connectivity.ts`.
- **File**: `src/compile/extract-connectivity.ts`

---

### G3 — `circuit_test` description text change not tested
- **Spec**: "Description: change 'Digital test format' to 'test vector format.'"
- **Found**: W2-T2 tests do not assert the description text contains "test vector format". No test verifies this change.
- **File**: `scripts/__tests__/circuit-tools-w2t2.test.ts`

---

### G4 — `circuit_patch` analog example not asserted in tests
- **Spec**: "Add an analog example to the description: `{op:'set', target:'R1', props:{resistance:10000}}`"
- **Found**: `describe('circuit_patch description includes analog example')` only checks `expect(patchTool).toBeDefined()`. Trivial existence check.
- **File**: `scripts/__tests__/circuit-tools-w2t2.test.ts:178-185`

---

### G5 — `circuit_list` "ANALOG" in description not asserted in tests
- **Spec**: "Category filter description: add `ANALOG` to examples."
- **Found**: `it('category description includes ANALOG in the tool schema')` only checks `expect(circuitList).toBeDefined()`. No assertion that "ANALOG" appears in the description text.
- **File**: `scripts/__tests__/circuit-tools-w2t2.test.ts:106-110`

---

### G6 — E2E surface not tested for W2-T3 wire protocol rename
- **CLAUDE.md Three-Surface Testing Rule**: "Every user-facing feature MUST be tested across all three surfaces. All three surfaces are non-negotiable."
- **Found**: W2-T3 progress notes explicitly state: "E2E not run (dev server not available)." No evidence of E2E passing was recorded.
- **File**: `e2e/parity/headless-simulation.spec.ts`

---

### G7 — W2-T5 `state-transition.ts` `setInput` left unchanged without spec justification
- **Spec**: W2-T5 renames `setInput` to `setSignal` in all consumer files.
- **Found**: `src/analysis/state-transition.ts:41,97` still uses `setInput` on `SequentialAnalysisFacade`. The agent claimed this was intentional as a "specialized interface" but the spec does not carve out specialized interfaces.
- **File**: `src/analysis/state-transition.ts:41,97`

---

### G8 — progress.md never updated for Wave 1 tasks (W1-T1 through W1-T6, W1-T8 through W1-T12)
- **Rule** (`rules.md`): "If you cannot finish: write detailed progress to spec/progress.md so the next agent can continue from exactly where you stopped."
- **Found**: All 11 Wave 1 tasks show status `pending` in progress.md despite being implemented. Any future agent reading progress.md will re-implement them, causing regressions.
- **File**: `spec/progress.md`

---

### G9 — Analog failure message never surfaced in test vector results
- **Spec acceptance criterion** (executor.ts section): "Analog test failure message: Expected 3.3V +-5% at Vout, got 2.8V (delta: 500mV)"
- **Found**: `formatAnalogFailure` computes this string but is called with `void` — it is discarded. No field in `TestResults` or `TestVector` carries this message. The spec requirement is unmet.
- **File**: `src/testing/executor.ts:239-248`

---

## Weak Tests

### WT1 — `circuit_patch` analog example test is trivially true
- **Test**: `scripts/__tests__/circuit-tools-w2t2.test.ts::circuit_patch description includes analog example::patch tool schema description includes resistor analog example`
- **Problem**: Assertion is `expect(patchTool).toBeDefined()`. The test title claims to verify the analog example text is present, but the assertion only checks the tool exists — trivially satisfied even if the description has no analog example.
- **Evidence**: `const patchTool = tools['circuit_patch']; expect(patchTool).toBeDefined();`

---

### WT2 — `circuit_list` category description "ANALOG" test is trivially true
- **Test**: `scripts/__tests__/circuit-tools-w2t2.test.ts::circuit_list include_pins::category description includes ANALOG in the tool schema`
- **Problem**: Assertion is `expect(circuitList).toBeDefined()`. Same pattern as WT1 — existence check masquerading as content check.
- **Evidence**: `const circuitList = tools['circuit_list']; expect(circuitList).toBeDefined();`

---

### WT3 — `default-facade.test.ts` comments reference deleted `readOutput` API name
- **Test**: `src/headless/__tests__/default-facade.test.ts:5,70`
- **Problem**: File header and inline comment say `readOutput (AND gate)` — describing the test using the deleted method name. Historical-provenance comment in a test file.
- **Evidence**: `* 1. Build + compile + step + readOutput (AND gate)` and `// Test 1: Build + compile + step + readOutput`

---

### WT4 — `port-mcp.test.ts` describe/it strings use deleted `setInput`/`readOutput` names
- **Test**: `src/headless/__tests__/port-mcp.test.ts:9,144,147,148`
- **Problem**: Describe block title and it-string say `setInput`/`readOutput` — old deleted API names. Historical-provenance descriptions in test metadata.
- **Evidence**:
  - `*   - setInput()/readOutput() resolve Port labels via labelSignalMap`
  - `describe('Port MCP surface — setInput/readOutput via Port labels', ...`
  - `it('setInput and readOutput resolve Port labels in a wire-through circuit', ...`

---

## Legacy References

### LR1 — `SolverDiagnostic` actively imported in `compiled-analog-circuit.ts`
- **File**: `src/solver/analog/compiled-analog-circuit.ts:10`
- **Evidence**: `import type { CompiledAnalogCircuit, SolverDiagnostic } from "../../core/analog-engine-interface.js";`

The type should have been deleted. It persists as an alias shim and this file imports it by the old name, with `diagnostics` typed as `SolverDiagnostic[]` instead of `Diagnostic[]`.

---

### LR2 — `SolverDiagnostic` named in `analog-engine-interface.ts` doc comment
- **File**: `src/core/analog-engine-interface.ts:127`
- **Evidence**: `* source stepping. Emits SolverDiagnostic records for every fallback or`

Doc comment names the deleted type. Future readers will look for a type that should not exist.

---

### LR3 — `sim-set-input`/`sim-read-output` still in CLAUDE.md
- **File**: `CLAUDE.md:73`
- **Evidence**: `  sim-set-input, sim-step, sim-read-output       — Drive simulation`

Deleted message types documented as current in the project canonical reference document.
