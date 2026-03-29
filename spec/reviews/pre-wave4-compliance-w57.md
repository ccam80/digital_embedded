# Review Report: Waves 5 and 7 -- Spec Compliance Audit

## Summary

| Field | Value |
|-------|-------|
| Tasks reviewed | Wave 5 (W5.1 / W12.1-W12.3 serialization), Wave 7 (W7.1 weak tests, W7.2 three-surface tests) |
| Violations | 7 |
| Gaps | 6 |
| Weak tests | 27 |
| Legacy references | 0 |
| Verdict | **has-violations** |

---

## Violations

### V1 (CRITICAL): modelDefinitions in CircuitMetadata stores { ports, elementCount } stub, NOT MnaSubcircuitNetlist

- **File**: src/core/circuit.ts:181-186
- **Rule violated**: Spec section "Serialization" and "End State" require modelDefinitions to store MnaSubcircuitNetlist format (ports, params, elements, internalNetCount, netlist)
- **Evidence**: The type is Record<string, { ports: string[]; elementCount: number }> instead of Record<string, MnaSubcircuitNetlist>
- **Spec says** (line 97-130, 405-429): modelDefinitions should be Record<string, MnaSubcircuitNetlist> where MnaSubcircuitNetlist has ports, params?, elements: SubcircuitElement[], internalNetCount, netlist: number[][]
- **Severity**: CRITICAL -- this is the core data model for v2 serialization and the entire subcircuit compilation pipeline depends on it

### V2 (CRITICAL): dts-serializer.ts serializes modelDefinitions as DtsCircuit objects, NOT MnaSubcircuitNetlist

- **File**: src/io/dts-serializer.ts:170-207
- **Rule violated**: Spec section "Serialization > New format" and Plan verification measure #8 ("No DtsCircuit references in modelDefinitions schema")
- **Evidence**: Line 177: const modelDefinitions: Record<string, DtsCircuit> = {}; Line 181: circuitToDtsCircuit(fullCircuit) -- serializes as DtsCircuit with wire coords, pixel positions
- **Severity**: CRITICAL

### V3 (CRITICAL): dts-deserializer.ts deserializes modelDefinitions as DtsCircuit and stores { ports, elementCount } stubs

- **File**: src/io/dts-deserializer.ts:241-268
- **Rule violated**: Spec section "Serialization > Load path"
- **Evidence**: Line 242: Record<string, { ports: string[]; elementCount: number }>. Line 245: checks dtsDef.elements.length > 0 (DtsCircuit fields). Line 249: deserializeDtsCircuit -- reconstructs Circuit object. Line 265: stores { ports, elementCount } stub.
- **Severity**: CRITICAL

### V4 (CRITICAL): DtsDocument.modelDefinitions type is MnaSubcircuitNetlist in schema but DtsCircuit in serializer

- **File**: src/io/dts-schema.ts:102 vs src/io/dts-serializer.ts:177
- **Rule violated**: Type inconsistency -- schema declares Record<string, MnaSubcircuitNetlist> but serializer writes Record<string, DtsCircuit>
- **Evidence**: Schema line 102 vs Serializer line 177 -- contradictory types
- **Severity**: CRITICAL -- a round-trip through validate -> serialize -> validate would fail

### V5 (MAJOR): subcircuitBindings not serialized or deserialized

- **File**: src/io/dts-serializer.ts (absent), src/io/dts-deserializer.ts (absent)
- **Rule violated**: Spec section "Serialization > New format" requires subcircuitBindings in DTS; Plan W5.1 requires serializer/deserializer handle subcircuitBindings
- **Evidence**: grep for subcircuitBindings in both files returns no matches. Schema and validator handle it, but serializer never writes and deserializer never reads.
- **Severity**: MAJOR -- data loss on save/load cycle

### V6 (MAJOR): dts-model-roundtrip.test.ts tests validate "stub" fallback path that should not exist

- **File**: src/io/__tests__/dts-model-roundtrip.test.ts:200,294,306
- **Rule violated**: spec/.context/rules.md "No fallbacks. No backwards compatibility shims."
- **Evidence**: Line 200: test named "modelDefinitions stub (no topology) does not register...". Line 294: test named "falls back to metadata stub when registry does not have matching model". These validate wrong behavior.
- **Severity**: MAJOR

### V7 (MINOR): dts-schema.ts re-exports MnaSubcircuitNetlist

- **File**: src/io/dts-schema.ts:11
- **Rule violated**: Unnecessary re-export
- **Evidence**: export type { MnaSubcircuitNetlist };
- **Severity**: MINOR

---

## Gaps

### G1: modelDefinitions on CircuitMetadata is not MnaSubcircuitNetlist type

- **Spec requirement**: circuit.metadata.modelDefinitions should be Record<string, MnaSubcircuitNetlist>
- **Actual**: Record<string, { ports: string[]; elementCount: number }>
- **File**: src/core/circuit.ts:181-186

### G2: subcircuitBindings not in serialization pipeline

- **Spec requirement**: Plan W5.1: serialize CircuitMetadata.subcircuitBindings -> subcircuitBindings and deserialize back
- **Actual**: Neither serializer nor deserializer read or write subcircuitBindings
- **Files**: src/io/dts-serializer.ts, src/io/dts-deserializer.ts

### G3: Missing three-surface test -- E2E test for pin loading menu

- **Spec requirement**: W7.2 requires "E2E test for pin loading menu affecting simulation behavior"
- **Actual**: e2e/gui/pin-loading-wire-override.spec.ts exists for per-wire overrides but no E2E test for Simulation menu pin loading mode selector

### G4: Missing three-surface test -- MCP test for circuit_describe reflecting named models

- **Spec requirement**: W7.2 requires "MCP test for circuit_describe reflecting named models"
- **Actual**: No such test found in src/headless/__tests__/

### G5: Missing three-surface test -- MCP surface test for SPICE import round-trip

- **Spec requirement**: W7.2 requires "MCP surface test for SPICE import: parsed .MODEL -> patch -> compile round-trip"
- **Actual**: No such test found in src/headless/__tests__/

### G6: Weak assertions in behavioral-combinational/flipflop/sequential test files NOT fixed

- **Spec requirement**: W7.1 requires replacing toBeDefined() assertions with specific value assertions
- **Actual**: Progress notes claim "no changes needed" but files still have 6x, 5x, and 13x toBeDefined() at flagged locations
- **Files**: behavioral-combinational.test.ts:347-360, behavioral-flipflop.test.ts:317-328, behavioral-sequential.test.ts:366-402

---

## Weak Tests

### WT1-WT7: dts-model-roundtrip.test.ts -- 7x toBeDefined() guards (lines 72, 94, 99, 151, 193, 257, 289)

### WT8-WT12: digital-pin-loading-mcp.test.ts -- 4x not.toBeNull() guard pairs + 1x toBeGreaterThan(0) (lines 116-117, 124, 164-165, 186-187, 207-208)

### WT13: analog-compiler.test.ts:508 -- toBeDefined() guard

### WT14-WT20: spice-model-overrides-mcp.test.ts -- 7x not.toBeNull() / toBeDefined() / toBeGreaterThan(0) (lines 124-128, 145-152, 188, 222, 230-267)

### WT21-WT25: spice-model-library.test.ts -- 5x toBeDefined() (lines 71-72, 100, 142-143, 158, 239-240)

### WT26: behavioral-combinational.test.ts:347-360 -- 6x toBeDefined() not replaced per W7.1

### WT27: behavioral-sequential.test.ts:366-402 -- 13x toBeDefined() not replaced per W7.1

---

## Legacy References

None found.

---

## Per-Wave Verdicts

### Wave 5 (Serialization): FAIL

The implementation fundamentally diverges from the spec:
1. CircuitMetadata.modelDefinitions stores { ports, elementCount } stubs instead of MnaSubcircuitNetlist
2. Serializer writes DtsCircuit objects (wire coordinates, pixel positions) instead of MnaSubcircuitNetlist
3. Deserializer reconstructs Circuit objects and stores stubs instead of MnaSubcircuitNetlist
4. subcircuitBindings never serialized or deserialized
5. The dts-schema.ts type and validator are correct (MnaSubcircuitNetlist), but serializer/deserializer completely ignore them

### Wave 7 (Test Fixes): FAIL

- W7.1: Only partial fixes applied. diag-rc-step.test.ts and analog-compiler.test.ts (2 guards) fixed. But behavioral-combinational/flipflop/sequential, spice-model-overrides-mcp, digital-pin-loading-mcp, and SPICE test files still contain flagged weak assertions.
- W7.2: All three required three-surface tests are missing.
