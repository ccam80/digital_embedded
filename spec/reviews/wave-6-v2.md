# Review Report: Wave 6 v2 — SPICE Apply + Model Library Dialog

## Summary

- **Tasks reviewed**: 3 (W6.1, W6.2, W6.3)
- **Violations**: 6 (0 critical, 4 major, 2 minor)
- **Gaps**: 2
- **Weak tests**: 9
- **Legacy references**: 1
- **Verdict**: `has-violations`

**Files reviewed:**
- `src/app/spice-model-apply.ts`
- `src/app/spice-import-dialog.ts`
- `src/app/spice-subckt-dialog.ts`
- `src/app/canvas-popup.ts`
- `src/app/menu-toolbar.ts`
- `src/app/spice-model-library-dialog.ts`
- `src/solver/analog/__tests__/spice-import-dialog.test.ts`
- `src/solver/analog/__tests__/spice-subckt-dialog.test.ts`
- `src/solver/analog/__tests__/spice-model-library.test.ts`

---

## Violations

### V1 — major
**File**: `src/app/spice-import-dialog.ts:238`
**Rule**: No `as unknown` casts (extra review instructions: "No aliases, no re-exports, no `as unknown`")
**Evidence**:
```typescript
const def = (element as unknown as { definition?: { models?: { mnaModels?: Record<string, { deviceType?: string }> } } }).definition;
```
This is a type escape hatch that bypasses TypeScript type-checking to access `element.definition`, which is not declared on the `CircuitElement` interface. The `resolveDeviceTypeFromElement` function works around an interface gap with a double-cast. The spec explicitly bans `as unknown` and this is exactly the pattern called out.

---

### V2 — major
**File**: `src/app/spice-subckt-dialog.ts:9`
**Rule**: No historical-provenance comments (rules.md: "Any comment describing what code replaced, what it used to do...")
**Evidence** (JSDoc lines 9-10):
```
 *   - Builds a Circuit from the parsed subcircuit via buildSpiceSubcircuit()
 *   - Returns the result for the caller to register and apply
```
The JSDoc states the module "Builds a Circuit from the parsed subcircuit via buildSpiceSubcircuit()" but the actual implementation does NOT call `buildSpiceSubcircuit()` at all. The implementation constructs a `MnaSubcircuitNetlist` directly inline. This comment describes a non-existent code path — a historical-provenance comment describing what the code used to do or was intended to do.

---

### V3 — major
**File**: `src/app/spice-subckt-dialog.ts:118-119` and `src/app/spice-model-library-dialog.ts:430-431`
**Rule**: Completeness — never write hollow placeholders; no partial implementations (rules.md)
**Evidence** (spice-subckt-dialog.ts):
```typescript
  internalNetCount: 0,
  netlist: parsed.elements.map(() => []),
```
`internalNetCount` is hardcoded to `0` and every element connectivity entry is always an empty array `[]`. Per the spec, `MnaSubcircuitNetlist.netlist` is "Net connectivity: netlist[elementIndex][pinIndex] -> net index." Emitting empty connectivity arrays means the netlist cannot be used for any actual simulation — sub-elements have no net assignments. This is a hollow placeholder. The same defect is replicated in `spice-model-library-dialog.ts:430-431`.

---

### V4 — major
**File**: `src/app/spice-model-library-dialog.ts:304-310`
**Rule**: CLAUDE.md three-surface testing rule — every user-facing feature must be testable on all three surfaces
**Evidence**:
```typescript
const compType = window.prompt(
  `Assign subcircuit "${name}" to component type.\nEnter: ComponentType:modelKey`,
);
if (!compType) return;
const trimmed = compType.trim();
if (!trimmed.includes(':')) {
  window.alert('Format must be ComponentType:modelKey');
  return;
}
```
The W6.3 "Assign to component type" action uses `window.prompt()` and `window.alert()` — native browser blocking dialogs that cannot be invoked in any headless test environment. The project uses `createModal` from `dialog-manager.ts` everywhere else. Using `window.prompt` makes the entire assignment input path untestable headlessly and via MCP, violating the CLAUDE.md three-surface rule. There are zero tests for the assignment dialog interaction itself — all `spice-model-library.test.ts` tests bypass the dialog and write to metadata directly.

---

### V5 — minor
**File**: `src/solver/analog/__tests__/spice-import-dialog.test.ts:358-365`
**Rule**: rules.md — "Test the specific: exact values"; no loose tolerances
**Evidence**:
```typescript
expect(parsed.params["IS"]).toBeCloseTo(6.734e-15, 20);
expect(parsed.params["BF"]).toBeCloseTo(416.4, 5);
expect(capturedModelParams!["IS"]).toBeCloseTo(6.734e-15, 20);
expect(capturedModelParams!["BF"]).toBeCloseTo(416.4, 5);
```
These values are parsed from string literals. Floating-point parsing of `6.734e-15` and `416.4` should produce exact IEEE 754 representations with no rounding. Exact equality (`toBe(6.734e-15)`) should be used. Using `toBeCloseTo` may mask parser precision bugs by allowing deviation.

---

### V6 — minor
**File**: `src/solver/analog/__tests__/spice-subckt-dialog.test.ts:5`
**Rule**: rules.md — no historical-provenance comments
**Evidence** (file-level JSDoc):
```
 * 1. parseSubcircuit() -> buildSpiceSubcircuit() -> produces a valid Circuit
```
The test file JSDoc states the first goal is "parseSubcircuit() -> buildSpiceSubcircuit() -> produces a valid Circuit." The production apply flow (`applySpiceSubcktImportResult`) does not use `buildSpiceSubcircuit()`. The comment documents a code path that does not correspond to how the production implementation works.

---

## Gaps

### G1 — W6.3: `internalNetCount` and `netlist` connectivity not computed
**Spec requirement**: `MnaSubcircuitNetlist` is "a compiled netlist — just connectivity + model references + parameters." The `netlist` field is "Net connectivity: netlist[elementIndex][pinIndex] -> net index. Net indices 0..ports.length-1 are external ports. Net indices ports.length.. are internal nets." `internalNetCount` is "Number of internal nets (nodes that are not ports)."

**What was found**: Both `spice-subckt-dialog.ts` and `spice-model-library-dialog.ts` always produce `internalNetCount: 0` and `netlist: parsed.elements.map(() => [])` — every element has an empty pin-to-net mapping. No actual connectivity is derived from the parsed subcircuit topology.

**File**: `src/app/spice-subckt-dialog.ts:118-119`, `src/app/spice-model-library-dialog.ts:430-431`

---

### G2 — W6.3: No MCP or E2E surface test for `subcircuitBindings` assignment
**Spec requirement**: CLAUDE.md three-surface testing rule — MCP surface test and E2E surface test required for every user-facing feature.

**What was found**: `spice-model-library.test.ts` only tests the direct-write storage path (setting `circuit.metadata.subcircuitBindings` directly without going through the dialog). There is no MCP surface test verifying that `subcircuitBindings` integrates with the circuit compilation path, and no E2E test for the assign dialog flow. The use of `window.prompt()` makes the assignment code path inherently untestable through the actual UI function.

**File**: `src/solver/analog/__tests__/spice-model-library.test.ts`

---

## Weak Tests

### WT1
**Test path**: `src/solver/analog/__tests__/spice-subckt-dialog.test.ts::spice-subckt-dialog: applySpiceSubcktImportResult::registers the netlist in SubcircuitModelRegistry under the subcircuit name`
**Issue**: `toBeDefined()` used as a standalone guard before content checks — redundant since the subsequent field checks (`stored!.ports`, `stored!.elements`) would produce clear failures if `stored` were undefined.
**Evidence**: `expect(stored).toBeDefined();` (line 226)

---

### WT2
**Test path**: `src/solver/analog/__tests__/spice-subckt-dialog.test.ts::spice-subckt-dialog: applySpiceSubcktImportResult::full flow: parse -> make netlist -> apply -> simulationModel set and netlist registered`
**Issue**: Same redundant `toBeDefined()` guard pattern before content checks.
**Evidence**: `expect(stored).toBeDefined();` (line 291)

---

### WT3
**Test path**: `src/solver/analog/__tests__/spice-subckt-dialog.test.ts::spice-subckt-dialog: applySpiceSubcktImportResult::stores MnaSubcircuitNetlist in circuit.metadata.modelDefinitions`
**Issue**: Two consecutive redundant `toBeDefined()` guards followed by field-specific assertions.
**Evidence**:
```typescript
expect(defs).toBeDefined();           // line 311
expect(defs!["MYBJT"]).toBeDefined(); // line 312
```

---

### WT4
**Test path**: `src/solver/analog/__tests__/spice-model-library.test.ts::spice-model-library: namedParameterSets::adds a parsed .MODEL entry to circuit.metadata.namedParameterSets`
**Issue**: Two redundant `toBeDefined()` guards followed by specific field assertions that make the guards superfluous.
**Evidence**:
```typescript
expect(sets).toBeDefined();            // line 81
expect(sets!["2N2222"]).toBeDefined(); // line 82
```

---

### WT5
**Test path**: `src/solver/analog/__tests__/spice-model-library.test.ts::spice-model-library: namedParameterSets::removing a .MODEL entry does not affect other entries`
**Issue**: `toBeDefined()` guard where the meaningful assertion is the `params["BF"]` check on the next line.
**Evidence**: `expect(sets["BC547"]).toBeDefined();` (line 110)

---

### WT6
**Test path**: `src/solver/analog/__tests__/spice-model-library.test.ts::spice-model-library: modelDefinitions::adds a parsed .SUBCKT definition to circuit.metadata.modelDefinitions`
**Issue**: Two redundant `toBeDefined()` guards.
**Evidence**:
```typescript
expect(defs).toBeDefined();           // line 152
expect(defs!["MYBJT"]).toBeDefined(); // line 153
```

---

### WT7
**Test path**: `src/solver/analog/__tests__/spice-model-library.test.ts::spice-model-library: modelDefinitions::registers the circuit in SubcircuitModelRegistry when adding a subcircuit`
**Issue**: Standalone `toBeDefined()` with NO follow-up content check whatsoever. The test only asserts existence, not that the registered netlist has correct ports, element count, or any field value.
**Evidence**: `expect(registry.get("RDIV")).toBeDefined();` (line 168)

---

### WT8
**Test path**: `src/solver/analog/__tests__/spice-model-library.test.ts::spice-model-library: combined::circuit can hold both namedParameterSets and modelDefinitions simultaneously`
**Issue**: Both assertions are standalone `toBeDefined()` with no content verification — only existence is checked, not correctness.
**Evidence**:
```typescript
expect(circuit.metadata.namedParameterSets!["2N2222"]).toBeDefined(); // line 249
expect(circuit.metadata.modelDefinitions!["RDIV"]).toBeDefined();     // line 250
```

---

### WT9
**Test path**: `src/solver/analog/__tests__/spice-model-library.test.ts::spice-model-library: unresolved model refs::modelRef in subcircuit that is not in namedParameterSets is detectable as unresolved`
**Issue**: Redundant `toBeDefined()` guard before field access.
**Evidence**: `expect(netlist).toBeDefined();` (line 324)

---

## Legacy References

### LR1
**File**: `src/app/spice-subckt-dialog.ts:9`
**Evidence**:
```
 *   - Builds a Circuit from the parsed subcircuit via buildSpiceSubcircuit()
```
The module-level JSDoc references `buildSpiceSubcircuit()` — a function this module no longer imports or calls. The actual W6 implementation constructs `MnaSubcircuitNetlist` objects directly inline without going through `buildSpiceSubcircuit`. This is a stale reference to a removed code path.
