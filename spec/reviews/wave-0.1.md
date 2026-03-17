# Review Report: Wave 0.1 — Interface Definitions

## Summary

| Item | Value |
|------|-------|
| Tasks reviewed | 2 (Task 0.1.1, Task 0.1.2) |
| Violations | 3 |
| Gaps | 2 |
| Weak tests | 6 |
| Legacy references | 0 |
| Verdict | **has-violations** |

---

## Violations

### V1 — Missing module causes TypeScript compile error (critical)

- **File**: `src/core/registry.ts`, line 12
- **Rule violated**: Rules — Completeness. "Never mark work as deferred, TODO, or 'not implemented.'" The import introduces a hard compile-time dependency on a file that does not exist, breaking the TypeScript build.
- **Evidence**:
  ```typescript
  import type { AnalogElement } from "../analog/element.js";
  ```
  Running `npx tsc --noEmit` produces:
  ```
  src/core/registry.ts(12,36): error TS2307: Cannot find module '../analog/element.js' or its corresponding type declarations.
  ```
  The spec states the import is a `type`-only import that "resolves at compile time only — no runtime dependency on Phase 1." However, TypeScript's type checker still requires the declaration file to exist. `src/analog/element.ts` does not exist; the only file in `src/analog/` is `compiler.ts`. The implementation added a cross-phase import that breaks the build before Phase 1 delivers the required file. The spec's intent was that this import would be safe, but that is only true once `element.ts` is created.
- **Severity**: critical

---

### V2 — Spec-required test describe block and test names absent (major)

- **File**: `src/core/__tests__/engine-interface.test.ts`
- **Rule violated**: Spec adherence — Task 0.1.1 tests. The spec mandates:
  - `src/core/__tests__/engine-interface.test.ts::EngineBaseInterface::digital_engine_satisfies_engine` — instantiate `DigitalEngine`, assign to `const e: Engine = engine`, call `e.step()`; assert no type errors and no runtime errors.
  - `src/core/__tests__/engine-interface.test.ts::EngineBaseInterface::simulation_engine_extends_engine` — create a mock implementing `SimulationEngine`; assert it is assignable to a variable typed `Engine`.
- **Evidence**: The file contains no `describe("EngineBaseInterface", ...)` block. Grep across `src/core/__tests__/` for `EngineBaseInterface`, `digital_engine_satisfies_engine`, and `simulation_engine_extends_engine` returns zero matches. The existing tests in `engine-interface.test.ts` test `MockEngine` against the `SimulationEngine` interface, not `DigitalEngine` against the new `Engine` base. The first test is particularly important because it verifies the concrete production class satisfies the new `Engine` interface.
- **Severity**: major

---

### V3 — Weak assertions: `typeof x === "function"` and `toBeDefined()` in test file (minor)

- **File**: `src/core/__tests__/analog-engine-interface.test.ts`, lines 189–193 and line 216
- **Rule violated**: Rules — Testing. "Test the specific: exact values, exact types, exact error messages where applicable." Testing that a property `typeof x === "function"` confirms only that the field is a function, not that it behaves correctly. `toBeDefined()` confirms only that a value exists, not what it is.
- **Evidence** (lines 189–193):
  ```typescript
  expect(typeof base.step).toBe("function");
  expect(typeof base.init).toBe("function");
  expect(typeof mockAnalogEngine.dcOperatingPoint).toBe("function");
  expect(typeof mockAnalogEngine.addBreakpoint).toBe("function");
  expect(typeof mockAnalogEngine.clearBreakpoints).toBe("function");
  ```
  Evidence (line 216):
  ```typescript
  expect(automatableSuggestion.patch).toBeDefined();
  ```
  The test at line 216 verifies only that `patch` is not `undefined`, but does not verify its structure or content. The mock was constructed with `patch: { op: "connect", from: "node3", to: "GND" }` — the assertion should verify those specific fields.

  The `typeof` checks are trivially true: TypeScript already enforces that the mock object satisfies the `AnalogEngine` interface at compile time. At runtime, the checks add no behavioral verification.
- **Severity**: minor

---

## Gaps

### G1 — `digital_engine_satisfies_engine` test not implemented

- **Spec requirement**: Task 0.1.1: "instantiate `DigitalEngine`, assign to `const e: Engine = engine`, call `e.step()`; assert no type errors and no runtime errors."
- **What was found**: No such test exists. The engine-interface test file tests `MockEngine` but never imports or instantiates `DigitalEngine`. The purpose of this test is to prove that the concrete production engine satisfies the new extracted `Engine` base at runtime, not just that a mock satisfies `SimulationEngine`.
- **File**: `src/core/__tests__/engine-interface.test.ts`

---

### G2 — `simulation_engine_extends_engine` test not implemented

- **Spec requirement**: Task 0.1.1: "create a mock implementing `SimulationEngine`; assert it is assignable to a variable typed `Engine`."
- **What was found**: No such test exists under the required `EngineBaseInterface` describe block. While `engine-interface.test.ts` does assign a `MockEngine` to a `SimulationEngine` typed variable (line 44), this is not the same test: it verifies `SimulationEngine` compliance, not that a `SimulationEngine` is assignable to `Engine`. The spec requires confirming that the base `Engine` reference accepts a `SimulationEngine` object, which is the structural subtype check proving `SimulationEngine extends Engine` is correctly wired.
- **File**: `src/core/__tests__/engine-interface.test.ts`

---

## Weak Tests

### WT1 — `analog_engine_extends_engine`: `typeof` checks are trivially true

- **Test path**: `src/core/__tests__/analog-engine-interface.test.ts::AnalogEngineTypes::analog_engine_extends_engine`
- **What is wrong**: Lines 189–193 check `typeof x === "function"` for five methods. These assertions are trivially satisfied by any object with those properties assigned, regardless of whether the implementation is correct. TypeScript already enforces the interface contract at compile time; the runtime `typeof` checks add no behavioral signal.
- **Evidence**:
  ```typescript
  expect(typeof base.step).toBe("function");
  expect(typeof base.init).toBe("function");
  expect(typeof mockAnalogEngine.dcOperatingPoint).toBe("function");
  expect(typeof mockAnalogEngine.addBreakpoint).toBe("function");
  expect(typeof mockAnalogEngine.clearBreakpoints).toBe("function");
  ```

---

### WT2 — `solver_diagnostic_codes_exhaustive`: `typeof code === "string"` assertion is trivially true

- **Test path**: `src/core/__tests__/analog-engine-interface.test.ts::AnalogEngineTypes::solver_diagnostic_codes_exhaustive`
- **What is wrong**: Line 127 checks `expect(typeof code).toBe("string")` for each code in the array. Since all elements were just written as string literals in the same test, this assertion can never fail and tests nothing meaningful.
- **Evidence**:
  ```typescript
  for (const code of allCodes) {
    expect(typeof code).toBe("string");
    expect(code.length).toBeGreaterThan(0);
  }
  ```

---

### WT3 — `dc_op_result_structure`: `toBeInstanceOf(Float64Array)` without content check

- **Test path**: `src/core/__tests__/analog-engine-interface.test.ts::AnalogEngineTypes::dc_op_result_structure`
- **What is wrong**: Line 72 verifies `result.nodeVoltages` is a `Float64Array` instance, but the test constructs the object itself — so the assertion only verifies the literal was not mutated. The voltage values are not inspected (only index 1 is checked).
- **Evidence**:
  ```typescript
  expect(result.nodeVoltages).toBeInstanceOf(Float64Array);
  expect(result.nodeVoltages[1]).toBe(3.3);
  ```
  The `toBeInstanceOf` check adds no behavioral signal since the type is known at construction.

---

### WT4 — `diagnostic_suggestion_structure`: `toBeDefined()` without content inspection

- **Test path**: `src/core/__tests__/analog-engine-interface.test.ts::AnalogEngineTypes::diagnostic_suggestion_structure`
- **What is wrong**: Line 216 asserts `expect(automatableSuggestion.patch).toBeDefined()`. The object was constructed with `patch: { op: "connect", from: "node3", to: "GND" }`. The assertion should verify the specific field values, not merely that the field is not `undefined`.
- **Evidence**:
  ```typescript
  const automatableSuggestion: DiagnosticSuggestion = {
    text: "Connect floating node to ground",
    automatable: true,
    patch: { op: "connect", from: "node3", to: "GND" },
  };
  expect(automatableSuggestion.automatable).toBe(true);
  expect(automatableSuggestion.patch).toBeDefined();
  ```

---

### WT5 — `analog_engine_extends_engine`: `dcOperatingPoint` call only checks two fields

- **Test path**: `src/core/__tests__/analog-engine-interface.test.ts::AnalogEngineTypes::analog_engine_extends_engine`
- **What is wrong**: The `dcOperatingPoint()` call at lines 196–199 verifies `converged` and `method` but ignores `iterations`, `nodeVoltages`, and `diagnostics`. All three fields are required by the `DcOpResult` interface and the mock set specific values for them. The test does not verify that the mock's returned result is complete.
- **Evidence**:
  ```typescript
  const result = mockAnalogEngine.dcOperatingPoint();
  expect(result.converged).toBe(true);
  expect(result.method).toBe("direct");
  ```

---

### WT6 — `compiled_analog_extends_compiled`: structural subtype check only asserts two base fields

- **Test path**: `src/core/__tests__/analog-engine-interface.test.ts::AnalogEngineTypes::compiled_analog_extends_compiled`
- **What is wrong**: Lines 92–97 assign `compiled` to `base: CompiledCircuit` and then only call `expect(base.netCount).toBe(5)` and `expect(base.componentCount).toBe(3)`. The test verifies the two fields of the base type and the analog-specific `nodeCount`, `elementCount`, and `labelToNodeId`, but does not verify `wireToNodeId` beyond `size === 0`. An empty map check (`expect(compiled.wireToNodeId.size).toBe(0)`) does not validate the type or behavior of the map.
- **Evidence**:
  ```typescript
  expect(compiled.wireToNodeId.size).toBe(0);
  ```

---

## Legacy References

None found.

---

## Notes

The following observations are recorded for completeness but are not counted as violations:

1. **Scope creep — extra tests in analog-engine-interface.test.ts**: The spec lists 5 test cases for Task 0.1.2. The implementation delivers 9 (four additional: `diagnostic_suggestion_structure`, `solver_diagnostic_optional_fields`, `simulation_params_integration_methods`, `dc_op_result_methods`). These tests are well-formed and cover additional spec types. They do not violate any rule; they exceed the spec.

2. **`runner.ts` TypeScript errors**: `npx tsc --noEmit` also reports 4 errors in `src/headless/runner.ts` related to `CompiledAnalogCircuit` lacking `netWidths` and `labelToNetId`. Runner.ts is a Wave 0.2 file and is outside the scope of this review, but the errors are downstream consequences of the `CompiledAnalogCircuit` interface definition in this wave.
