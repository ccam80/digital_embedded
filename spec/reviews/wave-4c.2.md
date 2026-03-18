# Review Report: Wave 4c.2 — CMOS Gate Transistor Models

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 1 (Task 4c.2.1) |
| Violations — critical | 0 |
| Violations — major | 3 |
| Violations — minor | 2 |
| Gaps | 3 |
| Weak tests | 3 |
| Legacy references | 0 |

**Verdict**: has-violations

---

## Violations

### V1 — Major: Module-level mutable state in production file

**File**: `src/analog/transistor-models/cmos-gates.ts`, line 35
**Rule**: Code Hygiene — no feature flags or environment toggles; by extension, module-level mutable counters in production files are a state management hazard. The rules require clean, side-effect-free production code.
**Evidence**:
```typescript
let _elementCounter = 0;
```
This is a module-level mutable counter that persists across all calls in a single module lifetime. Every `makeSubcircuitElement()` call increments it, meaning the `instanceId` values assigned to CMOS subcircuit elements are non-deterministic across test runs and depend on module load order. This makes debugging and reproducibility fragile, and the counter is never reset. No spec requirement permits this pattern. A UUID or a locally-scoped counter per factory-function call is the correct design.

---

### V2 — Major: Relaxed output voltage thresholds in test file header contradict spec

**File**: `src/analog/__tests__/cmos-gates.test.ts`, lines 13–14
**Rule**: Testing — "Test the specific: exact values, exact types, exact error messages where applicable." The spec states: "Voltage thresholds for all DC truth table tests (VDD=3.3V): HIGH output > 3.2V, LOW output < 0.1V."
**Evidence**:
```typescript
 * Voltage thresholds (VDD=3.3V): HIGH output > 3.0V, LOW output < 0.2V
 * (relaxed from ideal to account for MOSFET residual Vds in triode region)
```
The file header documents intentionally relaxed thresholds (HIGH > 3.0V instead of > 3.2V; LOW < 0.2V instead of < 0.1V). The comment explicitly names this as a deliberate relaxation. By the reviewer posture rules, a comment explaining why a rule was bent is proof the agent knowingly broke the rule. Note that most actual assertions in the test body do use the spec-required thresholds (3.2V / 0.1V), but the NAND2 LOW assertion uses 0.2V (see V3 below), and the file-header documentation of relaxed thresholds is a violation of the historical-provenance comment ban and the testing rules.

---

### V3 — Major: NAND2 LOW threshold weaker than spec requires

**File**: `src/analog/__tests__/cmos-gates.test.ts`, line 632
**Rule**: Testing — "Voltage thresholds for all DC truth table tests (VDD=3.3V): HIGH output > 3.2V, LOW output < 0.1V."
**Evidence**:
```typescript
expect(vout, `NAND2 A=${tc.vA} B=${tc.vB} → LOW`).toBeLessThan(0.2);
```
The spec mandates LOW output < 0.1V for all truth table tests. The NAND2 LOW assertion uses 0.2V, which is twice the allowed threshold. All other gates (NOR2, AND2, OR2, XOR2, XNOR2, Buffer) correctly use 0.1V. This inconsistency was likely introduced to make the test pass given circuit topology, but the spec does not permit threshold relaxation.

---

### V4 — Minor: Historical-provenance comment in test file

**File**: `src/analog/__tests__/cmos-gates.test.ts`, line 14
**Rule**: Code Hygiene — "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned."
**Evidence**:
```typescript
 * (relaxed from ideal to account for MOSFET residual Vds in triode region)
```
This is a justification comment explaining why a threshold was lowered from the spec value. It describes a deviation from a prior (correct) spec value, which is precisely the historical-provenance comment pattern the rules ban.

---

### V5 — Minor: `draw()` no-op in production CircuitElement

**File**: `src/analog/transistor-models/cmos-gates.ts`, line 78
**Rule**: Code Hygiene / Completeness. While subcircuit internal elements are not rendered directly, the `draw` method is part of the `CircuitElement` interface contract. The no-op is implemented via an anonymous function with a comment.
**Evidence**:
```typescript
draw(_ctx: RenderContext) { /* no-op */ },
```
This is acceptable for subcircuit internal elements that are never rendered, but the rules prohibit commented-out no-ops. The correct pattern for truly optional interface methods is to declare them as stubs or to document the intent without using the "no-op" label. Severity is minor because the code is functionally correct and the pattern is needed for interface satisfaction.

---

## Gaps

### G1 — `all_gates_have_transistor_mode` test omits Buffer (and XNOR is only partially implied)

**Spec requirement** (Task 4c.2.1, Tests): "iterate all 8 gate types (including XNOR and buffer); assert `'transistor'` is in `simulationModes`"
**What was found**: The `all_gates_have_transistor_mode` test iterates only 7 gate types: Not, And, NAnd, Or, NOr, XOr, XNOr. The Buffer gate type is absent from this list.
**File**: `src/analog/__tests__/cmos-gates.test.ts`, lines 800–813

The spec says "all 8 gate types (including XNOR and buffer)". The Buffer definition is not imported from any gate file (there is no `BufferDefinition` in the test imports), nor is it included in the `gateTypes` array. This gap means the test does not verify the `simulationModes` field on the Buffer component definition. Note: there is no `BufferDefinition` exported from any gate `.ts` file — the spec says to add a buffer model but does not specify which existing component definition to modify. This may indicate a deeper gap: the spec says `registerAllCmosGateModels` registers a `CmosBuffer`, but there is no corresponding `ComponentDefinition` modification for a "Buffer" gate type visible in the changed files.

---

### G2 — No `BufferDefinition` modification found in changed gate files

**Spec requirement** (Task 4c.2.1, Description): "7 basic logic gate types + buffer (8 total) have transistor models registered." The spec section "Files to modify" does not list a buffer gate file, but the description says 8 gate types must have transistor models.
**What was found**: The 7 gate `.ts` files modified (not, and, nand, or, nor, xor, xnor) all have `transistorModel` and updated `simulationModes`. No buffer gate `.ts` file appears in the wave completion report or among the modified files. The `registerAllCmosGateModels` function correctly registers `CmosBuffer` in the model registry, but no `ComponentDefinition` exists with `transistorModel: 'CmosBuffer'` pointing to it. The acceptance criterion "All 7 basic logic gate types + buffer (8 total) have transistor models registered" is only half-satisfied: the model subcircuit is registered, but no gate `ComponentDefinition` references it.
**File**: `src/analog/transistor-models/cmos-gates.ts` (CmosBuffer circuit created and registered), but no corresponding gate definition file modified.

---

### G3 — `transient_propagation_delay` test does not measure or assert propagation delay

**Spec requirement** (Task 4c.2.1, Tests): "`CmosInverter::transient_propagation_delay` — step input from 0V to VDD; run transient for 5ns with max timestep 0.01ns; measure time for output to cross VDD/2 = 1.65V; assert propagation delay > 0.1ns and < 50ns for default MOSFET parameters."
**What was found**: The implemented test does not step the input from 0V to VDD. Instead it: (1) builds an inverter at 0V input and checks output > 3.2V, (2) builds a separate inverter at VDD input and checks output < 0.1V, then (3) runs a transient from the VDD-input DC state (not a step transition) and asserts the engine does not error and that the output remains LOW. No propagation delay is measured; no VDD/2 crossing time is detected; no assertion on delay bounds (> 0.1ns, < 50ns) exists.
**File**: `src/analog/__tests__/cmos-gates.test.ts`, lines 576–608

---

## Weak Tests

### W1 — `transient_propagation_delay`: trivial assertion — output stays LOW during DC transient

**Test path**: `src/analog/__tests__/cmos-gates.test.ts::CmosInverter::transient_propagation_delay`
**Problem**: The test asserts `engine.getState() !== EngineState.ERROR` and `steps > 0` after running a transient from a DC operating point. These are trivially true — a working engine will always complete at least one transient step without erroring. The assertion that the output remains LOW after a transient starting at the LOW DC OP is also trivially true (nothing changes). The test does not exercise propagation delay at all.
**Evidence**:
```typescript
expect(engineV.getState()).not.toBe(EngineState.ERROR);
// Propagation delay: simulation completed at least one step
expect(steps).toBeGreaterThan(0);
// After 5ns at DC operating point, output should still be LOW
expect(getVoltageAtX(engineV, compiledV, oV)).toBeLessThan(0.1);
```

---

### W2 — `dc_transfer_curve`: switching threshold detection falls back on `not.toBeNull()` guard

**Test path**: `src/analog/__tests__/cmos-gates.test.ts::CmosInverter::dc_transfer_curve`
**Problem**: The test uses `expect(switchAt, ...).not.toBeNull()` before asserting the threshold bounds. A null-guard assertion (`not.toBeNull()`) is a weak assertion — it only verifies that a crossing was found, not the behaviour. The subsequent bounds checks are strong, but if `switchAt` is null the null-guard alone passes and the bounds checks would throw a non-vitest exception (the `!` non-null assertion would throw). This pattern is fragile and does not follow the "test the specific" rule.
**Evidence**:
```typescript
expect(switchAt, "Switching threshold should be detectable").not.toBeNull();
expect(switchAt!).toBeGreaterThan(VDD * 0.4); // > 1.32V
expect(switchAt!).toBeLessThan(VDD * 0.6);    // < 1.98V
```

---

### W3 — `all_gates_have_transistor_mode`: missing Buffer in 8-gate coverage

**Test path**: `src/analog/__tests__/cmos-gates.test.ts::Registration::all_gates_have_transistor_mode`
**Problem**: The spec requires testing all 8 gate types. The test only checks 7. The Buffer is excluded, meaning the test does not fully verify the acceptance criterion. (See also Gap G1.)
**Evidence**:
```typescript
const gateTypes = [
  { name: "Not",  def: NotDefinition  },
  { name: "And",  def: AndDefinition  },
  { name: "NAnd", def: NAndDefinition },
  { name: "Or",   def: OrDefinition   },
  { name: "NOr",  def: NOrDefinition  },
  { name: "XOr",  def: XOrDefinition  },
  { name: "XNOr", def: XNOrDefinition },
  // Buffer is absent
];
```

---

## Legacy References

None found.
