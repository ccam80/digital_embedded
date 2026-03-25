# Review Report: Phase 3 — Unified Netlist Extraction and Partitioning

## Summary

| Field | Value |
|-------|-------|
| Tasks reviewed | P3-1, P3-2, P3-3, P3-4, P3-5, P3-6, P3-7, P3-8, P3-9, P3-10, P3-11, P3-12, remove-compile-exports |
| Violations — critical | 1 |
| Violations — major | 2 |
| Violations — minor | 0 |
| Gaps | 3 |
| Weak tests | 7 |
| Legacy references | 0 |
| **Verdict** | **has-violations** |

---

## Violations

### V1 — Interleaved import statement inside module body (MAJOR)

**File**: `src/analog/compiler.ts`, lines 45–50

**Rule violated**: Code hygiene — all imports must appear at the top of the module. A function definition (`compileInnerDigitalCircuit`) is declared at line 45, followed by two more `import type` statements at lines 49–50. This is syntactically valid TypeScript but violates module-level ordering discipline. The function was inserted mid-file without its dependency imports being moved to the top. This is an artefact of an agent splicing code without restructuring the file.

**Evidence**:
```typescript
function compileInnerDigitalCircuit(circuit: Circuit, registry: ComponentRegistry): CompiledCircuitImpl {
  const unified = compileUnified(circuit, registry);
  return unified.digital! as CompiledCircuitImpl;
}
import type { LogicFamilyConfig } from "../core/logic-family.js";
import type { SolverPartition, PartitionedComponent } from "../compile/types.js";
```

**Severity**: major

---

### V2 — Historical-provenance comment referencing line numbers of another function (MAJOR)

**File**: `src/analog/compiler.ts`, line 1801

**Rule violated**: Code hygiene — no historical-provenance comments. The comment `// matching the same pattern as compileAnalogCircuit (lines 731-745)` describes the code in terms of what it was derived from and where a related function lives. It is a direct historical-provenance remark: it explains that this code was written by matching a pattern from another function by name and by line number. The spec rules state: "Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour."

**Evidence**:
```typescript
  // Model library: populate from outerCircuit.metadata.models when provided,
  // matching the same pattern as compileAnalogCircuit (lines 731-745).
  const modelLibrary = new ModelLibrary();
```

**Severity**: major

---

### V3 — `fallback` in production comment describing a known-incorrect silent default (CRITICAL)

**File**: `src/compile/compile.ts`, lines 234–237

**Rule violated**: Code hygiene — no fallbacks / no backwards-compatibility shims. The comment explicitly labels the behaviour as a "fallback" to node 0 (ground) when no wire-based mapping is found for an analog group. The rules state "No fallbacks." The code silently maps any unmapped analog group to node 0 (ground), which is a data-corruption path: if an analog group genuinely has no wires but does have pins, it will silently be assigned node 0 (the ground node) instead of emitting a diagnostic or failing visibly. The comment even acknowledges this is not the correct resolution: "fall back to pin-based lookup via labelToNodeId matching is not possible here; use 0 (ground) as fallback". A correct implementation either resolves the node from pin positions or emits a diagnostic.

**Evidence**:
```typescript
      // If no wires, fall back to pin-based lookup via labelToNodeId matching
      // is not possible here; use 0 (ground) as fallback
      if (!groupIdToAnalogNodeId.has(group.groupId)) {
        groupIdToAnalogNodeId.set(group.groupId, 0);
      }
```

**Severity**: critical

---

## Gaps

### G1 — P3-9: 2 integration tests remain failing (partial completion)

**Spec requirement**: Task P3-9 — "All integration tests pass. Results match old pipeline for equivalent circuits."

**What was found**: `spec/progress.md` explicitly records this task as `partial`, with 2 of the 20 tests still failing at the time of recording:
- "wireSignalMap has analog addresses for all wires"
- "wireSignalMap contains entries for both domain wires in mixed circuit"

The progress entry states both failures involve point wires (start == end) that `Circuit.addWire()` silently drops, so `compileUnified` never sees them. The task was left in partial state, and the spec acceptance criterion is "All integration tests pass."

**File**: `src/compile/__tests__/compile-integration.test.ts`

---

### G2 — P3-6: `compileDigitalPartition` SCC test known to fail for SR latch

**Spec requirement**: Task P3-6 — "New `compileDigitalPartition()` produces identical `CompiledCircuitImpl` for the same circuit." The integration test for SR latch feedback SCC is "detects feedback SCC in unified path matching reference compiler."

**What was found**: `spec/progress.md` records a "Bug 2" fix for the SCC issue during the bug-fix task, but the progress entry for that bug fix says "23/25 passing in compile-integration.test.ts + compile.test.ts" — 2 still failing. The SR latch SCC test ("detects feedback SCC in unified path matching reference compiler") compares `compileUnified().digital!` against itself (since the legacy compiler was removed in P3-10). The test at line 408 calls `compileUnified(circuit, registry).digital!` as the "reference", then calls `compileUnified` again as "unified". Since both calls use the same function, this test now only verifies internal consistency of the unified path against itself, not against the old pipeline. The spec requirement to "verify net IDs and wiring table match" the old compiler is no longer verifiable and is not tested.

**File**: `src/compile/__tests__/compile-integration.test.ts`, lines 392–439

---

### G3 — P3-8: `compileUnified` signature differs from spec

**Spec requirement**: Task P3-8 — the spec declares the function signature as:
```typescript
function compileUnified(
  circuit: Circuit,
  registry: ComponentRegistry,
  transistorModels?: TransistorModelRegistry,
): CompiledCircuitUnified;
```

**What was found**: The actual implementation accepts a union type `Circuit | FlattenResult` as the first argument:
```typescript
export function compileUnified(
  circuitOrResult: Circuit | FlattenResult,
  registry: ComponentRegistry,
  transistorModels?: TransistorModelRegistry,
): CompiledCircuitUnified
```

The spec does not authorize this overloaded first parameter. This is scope creep on the public API surface. Accepting a `FlattenResult` as input is not specified and adds an implicit contract on callers that the spec did not define.

**File**: `src/compile/compile.ts`, lines 56–60

---

## Weak Tests

### WT1 — Trivially-passing assertion: `bridges[0].electricalSpec` only checks `toBeDefined()`

**Test path**: `src/compile/__tests__/partition.test.ts::partitionByDomain::electrical spec on bridge::returns empty spec when no analog electrical override is present`

**Problem**: The assertion `expect(result.bridges[0].electricalSpec).toBeDefined()` does not verify the content of the spec object. The function returns an empty object `{}` in this case, and the test passes for any object reference including `undefined` (which would fail `toBeDefined`) but does not distinguish `{}` from `{ vOH: 99 }`. The test does not assert the specific content expected.

**Evidence**:
```typescript
      // electricalSpec is a plain object — just check it's defined
      expect(result.bridges[0].electricalSpec).toBeDefined();
```

---

### WT2 — Trivially-weak assertion: `wireSignalMap.size` only checks `toBeGreaterThan(0)`

**Test path**: `src/compile/__tests__/compile.test.ts::compileUnified::populates wireSignalMap for digital circuit with wires`

**Problem**: `expect(result.wireSignalMap.size).toBeGreaterThan(0)` does not verify that specific wire objects are present in the map, or that the correct number of wires are mapped. A map with one spurious entry would satisfy this assertion even if the actual test wires were absent.

**Evidence**:
```typescript
    expect(result.wireSignalMap.size).toBeGreaterThan(0);
```

---

### WT3 — Weak assertion: `digitalOnlyGroups.length` only checks `toBeGreaterThan(0)`

**Test path**: `src/compile/__tests__/extract-connectivity.test.ts::extractConnectivityGroups — mixed circuit::pure digital groups have only digital domain`

**Problem**: `expect(digitalOnlyGroups.length).toBeGreaterThan(0)` verifies that at least one digital-only group exists but not how many. The test builds a fixed topology (AND gate at (0,0), Resistor at (10,0)) with known expected group counts. A precise assertion on the expected count would be more meaningful.

**Evidence**:
```typescript
    expect(digitalOnlyGroups.length).toBeGreaterThan(0);
```

---

### WT4 — Weak assertion: `bridges.length` only checks `toBeGreaterThan(0)`

**Test path**: `src/compile/__tests__/compile-integration.test.ts::compileUnified — mixed digital+analog::bridges array is non-empty when circuit has cross-domain boundary`

**Problem**: `expect(unified.bridges.length).toBeGreaterThan(0)` does not assert the exact number of bridges expected from the fixed circuit topology. With exactly one DABridge element and one boundary group, the expected bridge count is exactly 1.

**Evidence**:
```typescript
    expect(unified.bridges.length).toBeGreaterThan(0);
```

---

### WT5 — Weak assertion: `digitalNetId` and `analogNodeId` only checked for `>= 0`

**Test path**: `src/compile/__tests__/compile-integration.test.ts::compileUnified — mixed digital+analog::bridges array is non-empty when circuit has cross-domain boundary`

**Problem**: `expect(bridge.digitalNetId).toBeGreaterThanOrEqual(0)` and `expect(bridge.analogNodeId).toBeGreaterThanOrEqual(0)` are essentially trivially true since these are non-negative integer fields. Node 0 is the ground node — an analog node ID of 0 for a boundary bridge would in fact be wrong (boundary pins should not be at ground). The test accepts node ID 0, which is one of the known incorrect outputs documented in the V3 fallback violation above.

**Evidence**:
```typescript
      expect(bridge.digitalNetId).toBeGreaterThanOrEqual(0);
      expect(bridge.analogNodeId).toBeGreaterThanOrEqual(0);
```

---

### WT6 — Weak assertion: `widthDiagnostics.length` checks `toBeGreaterThan(0)` rather than `toBe(1)`

**Test path**: `src/compile/__tests__/compile-integration.test.ts::compileUnified — width mismatch diagnostic::emits diagnostic when 1-bit output drives 8-bit input`

**Problem**: The test circuit has exactly one mismatched net. The expected diagnostic count is exactly 1. Using `toBeGreaterThan(0)` allows multiple spurious diagnostics to pass unnoticed. This is a specific scenario with a known exact expected count.

**Evidence**:
```typescript
    expect(widthDiagnostics.length).toBeGreaterThan(0);
```

---

### WT7 — Weak tunnel-merging assertion: net count checked with `toLessThanOrEqual(5)` rather than exact value

**Test path**: `src/compile/__tests__/compile-integration.test.ts::compileUnified — tunnel merging::tunnels at same label are merged into the same net group`

**Problem**: The comment in the test enumerates exactly 4 expected nets after tunnel merging, but the assertion uses `expect(unified.digital!.netCount).toBeLessThanOrEqual(5)`, which accepts any net count from 0 to 5. This masks regressions where tunnel merging fails but the net count happens to be less than 5 for other reasons.

**Evidence**:
```typescript
    // with tunnel merging: AND.out and NOT.in collapse into 1 net → 4 nets
    expect(unified.digital!.netCount).toBeLessThanOrEqual(5);
```

---

## Legacy References

None found.

All 12 grep checklist patterns from P3-12 return zero hits in `src/` TypeScript files:
- `traceNets` — 0 hits
- `buildNodeMap` — 0 hits
- `detectEngineMode` — 0 hits
- `partitionMixedCircuit` — 0 hits
- `MixedModePartition` — 0 hits
- `MixedModeCutPoint` — 0 hits
- `PosUnionFind` — 0 hits
- `from.*engine/union-find` — 0 hits
- `from.*engine/net-trace` — 0 hits
- `from.*analog/node-map` — 0 hits
- `from.*engine/mixed-partition` — 0 hits
- `@deprecated.*traceNets|buildNodeMap|detectEngineMode` — 0 hits
