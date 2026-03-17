# Review Report: Wave 4b.2 — Compiler Cross-Engine Detection

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 2 (4b.2.1, 4b.2.2) |
| Violations — critical | 1 |
| Violations — major | 3 |
| Violations — minor | 1 |
| Gaps | 2 |
| Weak tests | 7 |
| Legacy references | 2 |

**Verdict: has-violations**

---

## Violations

### V1 — CRITICAL — Historical-provenance comment (compiler.ts)

**File**: `src/analog/compiler.ts`, line 411
**Rule**: Code Hygiene — "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned."
**Evidence**:
```
// getTime placeholder — replaced by MNAEngine at runtime
const getTime = (): number => 0;
```
The word "replaced" is explicitly listed as a banned provenance marker. This comment describes future runtime behaviour as a substitute for what the code used to do — it is a historical-provenance comment justifying a stub, which the rules explicitly identify as an agent signal of intentional shortcut-taking.

---

### V2 — MAJOR — "not yet implemented" diagnostic text in production code (compiler.ts)

**File**: `src/analog/compiler.ts`, lines 445, 462
**Rule**: Completeness — "Never mark work as deferred, TODO, or 'not implemented.'"
**Evidence** (line 445):
```typescript
`The digital bridge (Phase 4b) is not yet implemented. ` +
`Component "${el.typeId}" will be skipped in analog compilation. ` +
```
**Evidence** (line 462):
```typescript
`Transistor-level expansion (Phase 4c) is not yet implemented. ` +
`Component "${el.typeId}" will be skipped in analog compilation. ` +
```
These are user-visible diagnostic strings embedded in production code that openly describe deferred functionality. The rules forbid marking work as deferred. The diagnostic codes `digital-bridge-not-yet-implemented` and `transistor-model-not-yet-implemented` were added in an earlier wave (4a.5.1) — the question is whether they survive into this wave unchanged. They do. Even if these codes were carried forward from a prior wave, this wave modified `compiler.ts` and did not remove the deferred language.

---

### V3 — MAJOR — Overloaded function signature with backwards-compatible raw-Circuit path (compiler.ts)

**File**: `src/analog/compiler.ts`, lines 225–238
**Rule**: Code Hygiene — "No backwards compatibility shims. No safety wrappers."
**Evidence**:
```typescript
export function compileAnalogCircuit(
  circuitOrResult: Circuit | FlattenResult,
  registry: ComponentRegistry,
): ConcreteCompiledAnalogCircuit {
  // Unwrap: accept either a raw Circuit or a FlattenResult
  let circuit: Circuit;
  let crossEngineBoundaries: CrossEngineBoundary[];
  if ("crossEngineBoundaries" in circuitOrResult) {
    circuit = circuitOrResult.circuit;
    crossEngineBoundaries = circuitOrResult.crossEngineBoundaries;
  } else {
    circuit = circuitOrResult;
    crossEngineBoundaries = [];
  }
```
The spec says: "Accept `FlattenResult` instead of (or in addition to) `Circuit`" but the spec's call-site migration table and acceptance criteria make it clear the intent is to accept `FlattenResult`. Keeping `Circuit | FlattenResult` is a backwards-compatibility shim: the raw-Circuit branch exists solely to avoid breaking callers that still pass a plain `Circuit`. The rules prohibit this. All call sites must be migrated; no safety wrapper is permitted.

---

### V4 — MAJOR — `compiled-analog-circuit.ts` constructor accepts `bridges?` as optional (compiled-analog-circuit.ts)

**File**: `src/analog/compiled-analog-circuit.ts`, line 102
**Rule**: Code Hygiene — "No backwards compatibility shims."
**Evidence**:
```typescript
constructor(params: {
  ...
  bridges?: BridgeInstance[];
}) {
  ...
  this.bridges = params.bridges ?? [];
}
```
The `?` makes `bridges` optional and the `?? []` provides a backwards-compat default. The spec states `CompiledAnalogCircuit` gains `bridges?: BridgeInstance[]` on the interface (optional on the interface is legitimate), but the constructor of the concrete class should require it once the compiler always provides it. The `?? []` fallback silently produces an empty array if callers omit `bridges`, masking wiring bugs. This is a safety wrapper.

---

### V5 — MINOR — Backslash path separators in progress.md entry text

**File**: `spec/progress.md`, line 799
**Rule**: Shell Compatibility — "Use forward slashes in paths."
**Evidence**:
```
`src\engine\__tests__\flatten.test.ts`
```
The progress.md entry for Task 4b.2.1 uses backslash path separators in the Files modified section. While this is documentation rather than executable code, the rules apply to all path references in the project.

---

## Gaps

### G1 — Spec test name mismatch: `pin_electrical_resolved` vs `pin_electrical_resolved_for_ttl`

**Spec requirement** (Task 4b.2.2 Tests):
> `src/analog/__tests__/bridge-compiler.test.ts::BridgeCompilation::pin_electrical_resolved` — circuit has TTL logic family; assert bridge adapters use TTL thresholds (vIH=2.0, not CMOS 3.3V's 2.0 — same values but vOH differs: 3.4 not 3.3)

**What was found**: The test is named `pin_electrical_resolved_for_ttl` instead of `pin_electrical_resolved`. Furthermore, the assertion does not verify TTL thresholds (vOH=3.4, vIH=2.0) at all — it only checks `expect(bridge.outputAdapters[0]!.label).toContain("Y")`. This is addressed in the Weak Tests section (W7), but the gap is that the specified assertion (verify TTL thresholds differ from CMOS) is absent entirely.

**File**: `src/analog/__tests__/bridge-compiler.test.ts`, line 577

---

### G2 — Spec call-site migration table: 7 call sites listed but spec says `boundaryPins` not `crossEngineBoundaries`

**Spec requirement** (Task 4b.2.1 call-site migration table):
> Migration pattern: `const circuit = flattenCircuit(c)` → `const { circuit, boundaryPins } = flattenCircuit(c)`. Digital-only callers ignore `boundaryPins`.

**What was found**: The return field is named `crossEngineBoundaries` in the implementation (in both `FlattenResult` and all destructuring call sites), not `boundaryPins` as the spec's migration pattern specifies. While `crossEngineBoundaries` is a more descriptive name and the spec's crossEngineBoundaries field name is used consistently throughout the task spec body, the migration pattern example in the spec explicitly says `boundaryPins`. This is a naming inconsistency between the spec's migration table and the implementation. The field naming in the spec body (CrossEngineBoundary, crossEngineBoundaries) is internally consistent with the implementation, so this appears to be a spec typo in the migration table — but it must be flagged.

**File**: `src/engine/flatten.ts`, line 89 (field name `crossEngineBoundaries`)

---

## Weak Tests

### W1 — `compiles_digital_subcircuit_separately::toBeDefined()`

**Test**: `src/analog/__tests__/bridge-compiler.test.ts::BridgeCompilation::compiles_digital_subcircuit_separately`
**Problem**: `expect(bridge.compiledInner).toBeDefined()` is trivially true if the bridge was created at all — the test already asserts `compiled.bridges.toHaveLength(1)` and accesses `compiled.bridges[0]!`. A defined `compiledInner` is guaranteed by TypeScript typing.
**Evidence**:
```typescript
expect(bridge.compiledInner).toBeDefined();
expect(bridge.compiledInner.netCount).toBeGreaterThan(0);
```
The second assertion (`netCount > 0`) is also weak — it does not verify the specific net count expected for an AND gate circuit (which should have a known number of nets: In_A, In_B, And output, Out_Y = 4 nets minimum).

---

### W2 — `creates_output_adapters::outputNodeId > 0`

**Test**: `src/analog/__tests__/bridge-compiler.test.ts::BridgeCompilation::creates_output_adapters`
**Problem**: `expect(adapter.outputNodeId).toBeGreaterThan(0)` does not verify that the adapter is wired to the specific correct outer MNA node (the node for pin Y). The comment even acknowledges the exact node: "Node Y is connected via wire (20,3)-(30,3) which shares a net with res3's pin at (30,3)". The test could assert the exact node ID.
**Evidence**:
```typescript
const adapter = bridge.outputAdapters[0]!;
expect(adapter.outputNodeId).toBeGreaterThan(0);
```

---

### W3 — `creates_input_adapters::inputNodeId > 0`

**Test**: `src/analog/__tests__/bridge-compiler.test.ts::BridgeCompilation::creates_input_adapters`
**Problem**: Same pattern as W2. `toBeGreaterThan(0)` does not assert the specific outer MNA node for A or B. The test circuit is designed with known node positions; exact node IDs should be asserted.
**Evidence**:
```typescript
expect(bridge.inputAdapters[0]!.inputNodeId).toBeGreaterThan(0);
expect(bridge.inputAdapters[1]!.inputNodeId).toBeGreaterThan(0);
```

---

### W4 — `inner_net_ids_mapped::toBeGreaterThanOrEqual(0)`

**Test**: `src/analog/__tests__/bridge-compiler.test.ts::BridgeCompilation::inner_net_ids_mapped`
**Problem**: `toBeGreaterThanOrEqual(0)` combined with `toBeLessThan(inner.netCount)` only verifies the net ID is a valid index in the range — it does not verify which net ID corresponds to which pin label. The spec says "assert `outputPinNetIds` and `inputPinNetIds` map to valid net IDs in the inner compiled circuit." The spec's own phrasing is range-based, but the test should also confirm the IDs are distinct (A and B should be on different nets, and Y should be different from both A and B).
**Evidence**:
```typescript
expect(outNetId).toBeGreaterThanOrEqual(0);
expect(outNetId).toBeLessThan(inner.netCount);
```

---

### W5 — `inner_net_ids_mapped` — net IDs not verified as distinct

**Test**: `src/analog/__tests__/bridge-compiler.test.ts::BridgeCompilation::inner_net_ids_mapped`
**Problem**: `bridge.inputPinNetIds` has 2 entries (for A and B) but the test does not assert they are distinct. A and B connect to different internal nets in the AND gate; if the compiler erroneously mapped both to the same net, this test would not catch it.
**Evidence**:
```typescript
for (const netId of bridge.inputPinNetIds) {
  expect(netId).toBeGreaterThanOrEqual(0);
  expect(netId).toBeLessThan(inner.netCount);
}
```
No `expect(bridge.inputPinNetIds[0]).not.toBe(bridge.inputPinNetIds[1])`.

---

### W6 — `pin_electrical_resolved_for_ttl` — assertion does not verify TTL electrical values

**Test**: `src/analog/__tests__/bridge-compiler.test.ts::BridgeCompilation::pin_electrical_resolved_for_ttl`
**Problem**: The spec requires: "assert bridge adapters use TTL thresholds (vIH=2.0, not CMOS 3.3V's 2.0 — same values but vOH differs: 3.4 not 3.3)". The test only checks `expect(bridge.outputAdapters[0]!.label).toContain("Y")`. This does not test the electrical spec at all — it tests only the label string. The TTL vs CMOS distinction is the entire purpose of this test.
**Evidence**:
```typescript
// TTL vOH = 3.4V, CMOS 3.3V vOH = 3.3V
// Verify adapter is stamping TTL characteristics by checking the adapter exists
// and was created (exact internal validation is in bridge-adapter.test.ts).
// The adapter's label includes the instance name and pin label.
expect(bridge.outputAdapters[0]!.label).toContain("Y");
```
The comment "exact internal validation is in bridge-adapter.test.ts" is itself a red flag — it is justifying not testing the required behaviour by pointing elsewhere. The spec explicitly requires this test to verify TTL thresholds in this test file.

---

### W7 — `existing_flatten_tests_unchanged` reproduces only 2 of 7 specified call-site scenarios

**Test**: `src/engine/__tests__/flatten-bridge.test.ts::CrossEngine::existing_flatten_tests_unchanged`
**Problem**: The spec's `existing_flatten_tests_unchanged` test says "run all existing flatten tests; assert no regression." The implementation reproduces only two scenarios (singleSubcircuit and twoInstances) rather than running the existing test suite directly. While the 8 existing flatten tests are claimed to pass, the specification for this particular test case says "run all existing flatten tests" — the implementation reimplements only a subset.
**Evidence**: The test at line 366 constructs two mini-scenarios and checks them. It does not verify all 8 scenarios from flatten.test.ts (noSubcircuitsUnchanged, preservesLeafComponents, nestedSubcircuit, pinWiring, isSubcircuitHost, etc.).

---

## Legacy References

### L1 — "not yet implemented" in diagnostic code names (analog-engine-interface.ts)

**File**: `src/core/analog-engine-interface.ts`, lines 95–96
**Evidence**:
```typescript
| "digital-bridge-not-yet-implemented"
| "transistor-model-not-yet-implemented"
```
These diagnostic code strings contain "not-yet-implemented" — a deferred-work marker baked into a permanent type discriminant. Once a feature is implemented, these codes become stale artifacts. They originate from Task 4a.5.1 but Task 4b.2.2 modified this file (adding `bridge-inner-compile-error`, `bridge-unconnected-pin`, `bridge-missing-inner-pin`) without removing or renaming the "not-yet-implemented" codes, which is now a direct lie given that the digital bridge is being implemented in this very phase.

---

### L2 — Comment references "Phase 4b" and "Phase 4c" as not yet implemented (compiler.ts)

**File**: `src/analog/compiler.ts`, lines 445, 462
**Evidence**:
```typescript
`The digital bridge (Phase 4b) is not yet implemented. ` +
```
```typescript
`Transistor-level expansion (Phase 4c) is not yet implemented. ` +
```
These are historical-provenance / deferred-work strings embedded in user-visible diagnostics that reference the development phase structure. Phase 4b is now being implemented; this string is factually incorrect and constitutes a legacy reference to the prior state of the codebase.
