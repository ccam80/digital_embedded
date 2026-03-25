# Review Report: Phase 3 — Unified Netlist Extraction and Partitioning (All Waves)

## Summary

- **Tasks reviewed**: 12 (P3-1 through P3-12)
- **Violations**: 7 (0 critical, 3 major, 4 minor)
- **Gaps**: 3
- **Weak tests**: 4
- **Legacy references**: 2
- **Verdict**: `has-violations`

---

## Violations

### V1 — major
**File**: `src/engine/compiler.ts` (lines 65–84) and `src/analog/compiler.ts` (lines 664–668)
**Rule**: Code Hygiene — "All replaced or edited code is removed entirely. Scorched earth." / "No backwards compatibility shims."
**Evidence**:

`compileCircuit()` in `src/engine/compiler.ts`:
```typescript
export function compileCircuit(
  circuit: Circuit,
  registry: ComponentRegistry,
): CompiledCircuitImpl {
```
`compileAnalogCircuit()` in `src/analog/compiler.ts`:
```typescript
export function compileAnalogCircuit(
  circuitOrResult: Circuit | FlattenResult,
  registry: ComponentRegistry,
  transistorModels?: TransistorModelRegistry,
): ConcreteCompiledAnalogCircuit {
```

**Assessment**: The spec (Phase 3 overall goal, P3-10 cleanup task, and the known coordinator flag) states that `compileUnified()` is intended to be the single top-level entry point, replacing both `compileCircuit()` and `compileAnalogCircuit()`. The implementation preserved both old signatures as wrappers that internally delegate to the new pipeline. P3-10 spec: "Rewrite `compileCircuit()` internals to delegate to the new partition path" — this was done — but the old public signatures were not removed. The wrappers are backwards-compatibility shims. The coordinator explicitly flagged this. The spec says the old signatures should be removed so that `compileUnified()` is the only top-level entry point.

**Severity**: major

---

### V2 — major
**File**: `src/headless/default-facade.ts` (lines 36–37, 156, 178) and `src/headless/runner.ts` (lines 18, 21, 102, 108)
**Rule**: Code Hygiene — "No backwards compatibility shims."
**Evidence**:

`default-facade.ts` lines 36–37:
```typescript
import { compileCircuit } from '../engine/compiler.js';
import { compileAnalogCircuit } from '../analog/compiler.js';
```
`default-facade.ts` lines 156, 178:
```typescript
const compiledAnalog = compileAnalogCircuit(circuit, this._registry, getTransistorModels());
const compiled = compileCircuit(circuit, this._registry) as ConcreteCompiledCircuit;
```

**Assessment**: `default-facade.ts` and `runner.ts` were listed in P3-10 as files to modify (migrate callers away from the old API). Both still call `compileCircuit` and `compileAnalogCircuit` directly, bypassing the unified pipeline. This is a consequence of V1: since the old entry points remain as public exports, these callers were not migrated. Per the spec, `compileUnified()` should be the entry point used by `default-facade.ts`.

**Severity**: major

---

### V3 — major
**File**: `src/compile/__tests__/compile-integration.test.ts` (line 4–5, and throughout)
**Rule**: Code Hygiene — "No historical-provenance comments."
**Evidence** (file header comment, line 4–5):
```typescript
 * Compares `compileUnified()` output against the legacy `compileCircuit()` and
 * `compileAnalogCircuit()` entry points so regressions are immediately visible.
```

The test file refers to `compileCircuit` and `compileAnalogCircuit` as "legacy" entry points throughout (variable names such as `legacy` on lines 334, 374, 410, 436, 461, 482, 535, 554, 875, and test descriptions like "net count matches compileCircuit for standalone AND gate"). This language describes historical provenance and the relationship between old and new code. The rules ban any such comments or descriptions.

Additionally, the integration test compares against the old APIs as a regression baseline — but if the old APIs are removed (as the spec intends), these tests will need to be rewritten. This test design assumes the continued presence of the old APIs.

**Severity**: major

---

### V4 — minor
**File**: `src/compile/compile.ts` (line 154)
**Rule**: Code Hygiene — No historical-provenance or justification comments that describe design decisions.
**Evidence**:
```typescript
      // is not possible here; use 0 (ground) as fallback
```

This comment (inside the `groupIdToAnalogNodeId` building loop) describes a workaround — "fallback" is a word that signals the comment is describing a shortcut or a known limitation. The code sets analog node ID to 0 (ground) when no wire is found for a group. A comment explaining the fallback is a justification comment for incomplete behaviour.

**Severity**: minor

---

### V5 — minor
**File**: `src/compile/__tests__/compile.test.ts` (lines 246–252)
**Rule**: Code Hygiene — Implementation rules specify no backwards-compatibility shims; test code must be accurate.
**Evidence**:
```typescript
    models: {
      analog: {
        analogFactory,
        pinElectrical: {},
      },
    },
  } as unknown as ComponentDefinition;
```

The test constructs `AnalogModel` objects using `analogFactory` as a key, but the actual `AnalogModel` interface (registry.ts line 173–187) defines `factory` as the key. The `as unknown as ComponentDefinition` cast suppresses the TypeScript error. This means the test's analog definitions do not conform to the `AnalogModel` interface and will silently pass even if the field is ignored by the implementation. The correct key is `factory` per the spec (Section 1 "Proposed" `AnalogModel` interface).

**Severity**: minor

---

### V6 — minor
**File**: `src/compile/__tests__/compile.test.ts` (line 16)
**Rule**: Tests must compile against the actual public API.
**Evidence**:
```typescript
import type { ComponentDefinition, ExecuteFunction, AnalogFactory } from "../../core/registry.js";
```

`AnalogFactory` is imported from `registry.ts` but this type is not exported from `registry.ts` (confirmed by grep — no `export.*AnalogFactory` or `type AnalogFactory` in that file). The import is satisfying TypeScript only because it is used in a type position. This is a silent error that indicates the test is building against a type that does not exist in the public API.

**Severity**: minor

---

### V7 — minor
**File**: `src/engine/flatten.ts` (lines 86–103)
**Rule**: Code Hygiene — no code added to production files that is not part of the spec for that file.
**Evidence**:
```typescript
/**
 * Describes one cut point between the analog and digital domains.
 */
export interface InternalCutPoint {
  ...
}

/**
 * A partition of digital-only elements extracted from a mixed circuit.
 */
export interface InternalDigitalPartition {
  internalCircuit: Circuit;
  cutPoints: InternalCutPoint[];
  instanceName: string;
}
```

P3-5 spec for `flatten.ts` was to replace `engineType` comparisons with model-based domain checks. It did not specify adding new exported types. These types (`InternalCutPoint`, `InternalDigitalPartition`) exist only to support the `extractDigitalSubcircuit` function inlined in `src/analog/compiler.ts`. They represent internal implementation concerns of the analog compiler, not the flatten module. Exporting them from `flatten.ts` is scope creep for P3-5. Furthermore, the P3-12 progress notes state these were added during P3-10 (renamed from `MixedModeCutPoint`/`MixedModePartition`), which is not in P3-5 scope.

**Severity**: minor

---

## Gaps

### G1 — Spec requirement not met
**Spec requirement**: P3-10 — "Rewrite `compileCircuit()` internals to delegate to the new partition path... Replace all uses of `detectEngineMode()`... Replace all uses of `partitionMixedCircuit()`... Replace all imports of `UnionFind` from `src/engine/union-find` with `src/compile/union-find`." (The spec adds: the old signatures must ultimately be removed; the spec goal is "`compileUnified()` as the only top-level entry point.")
**What was found**: `compileCircuit()` and `compileAnalogCircuit()` are preserved as public exports and continue to be called by `default-facade.ts`, `runner.ts`, test files, and production code. The spec-mandated goal of `compileUnified()` as the single top-level entry point was not achieved. Both old functions still exist with their original signatures.
**File**: `src/engine/compiler.ts`, `src/analog/compiler.ts`, `src/headless/default-facade.ts`, `src/headless/runner.ts`

---

### G2 — Spec requirement not met
**Spec requirement**: P3-9 task — "All integration tests pass." The task specifies 8 integration test cases and states the acceptance criterion is "All integration tests pass. Results match old pipeline for equivalent circuits."
**What was found**: Progress notes for P3-9 state status as "partial" with 14/20 passing. The subsequent bug-fix pass brought tests to 23/25, but the progress notes for the bug fix still record 2 remaining failures ("wireSignalMap has analog addresses for all wires" and "wireSignalMap contains entries for both domain wires in mixed circuit"). The final P3-10/P3-11 pass reports 7486/7490 total tests, but progress notes do not explicitly state that the 2 remaining integration test failures were resolved. The P3-9 acceptance criterion was not definitively met.
**File**: `src/compile/__tests__/compile-integration.test.ts`

---

### G3 — Spec requirement partially met
**Spec requirement**: P3-6 — "A targeted test: build a simple circuit, extract groups, partition, compile via new path, verify net IDs and wiring table match." The acceptance criterion includes "New `compileDigitalPartition()` produces identical `CompiledCircuitImpl` for the same circuit."
**What was found**: The progress note for P3-9 documents a confirmed bug: "compileDigitalPartition doesn't detect SCCs (1 failure)" — the SR latch feedback test shows `compileDigitalPartition` produces 2 non-feedback single-component groups instead of 1 feedback group with both components, unlike the legacy `compileCircuit`. A bug-fix pass was applied (originalPinIdxToResolvedPos mapping) but the progress note for the bug-fix pass still lists this test as potentially unresolved. If the SCC detection bug remains, P3-6's acceptance criterion "identical `CompiledCircuitImpl`" is not met for feedback circuits.
**File**: `src/engine/compiler.ts` (compileDigitalPartition), `src/compile/__tests__/compile-integration.test.ts`

---

## Weak Tests

### WT1
**Test path**: `src/compile/__tests__/compile.test.ts::compileUnified::populates wireSignalMap for digital circuit with wires`
**Issue**: The assertion `expect(result.wireSignalMap.size).toBeGreaterThan(0)` is weak — it verifies the map is non-empty but does not verify that specific wires are mapped to specific correct net IDs. A map containing one entry for only one of the two wires would pass this test.
**Evidence**:
```typescript
expect(result.wireSignalMap.size).toBeGreaterThan(0);
// All signal addresses in the map must be digital for a pure-digital circuit
for (const addr of result.wireSignalMap.values()) {
  expect(addr.domain).toBe("digital");
}
```

---

### WT2
**Test path**: `src/compile/__tests__/compile-integration.test.ts::compileUnified — simple AND gate (digital only)::wireSignalMap has digital addresses for all wires`
**Issue**: The test adds wires and asserts `wireSignalMap.size` equals the wire count, but does not assert the actual net IDs stored in the map — only that the domain is "digital". A implementation that maps all wires to net ID 0 would pass.
**Evidence** (from partial read of integration test around line 343):
```typescript
expect(result.wireSignalMap.size).toBe(circuit.wires.length);
for (const addr of result.wireSignalMap.values()) {
  expect(addr.domain).toBe('digital');
}
```

---

### WT3
**Test path**: `src/compile/__tests__/extract-connectivity.test.ts::resolveModelAssignments::assigns digital modelKey for digital-only components`
**Issue**: The assertion `expect(assignments[0]!.model).not.toBeNull()` is a weak non-null check. It does not verify the model is the correct `DigitalModel` object (e.g., by checking `model.executeFn` exists). Passing `model: {}` would satisfy this assertion.
**Evidence**:
```typescript
expect(assignments[0]!.modelKey).toBe('digital');
expect(assignments[0]!.model).not.toBeNull();
```

---

### WT4
**Test path**: `src/compile/__tests__/partition.test.ts::electrical spec on bridge::returns empty spec when no analog electrical override is present`
**Issue**: The assertion `expect(result.bridges[0].electricalSpec).toBeDefined()` is a trivially weak assertion — any value, including `{}`, satisfies it. The test comment says "just check it's defined" which acknowledges the weakness. The spec requires electrical spec to be populated from the analog model's `pinElectrical`, so a precise assertion should check the actual spec values.
**Evidence**:
```typescript
// electricalSpec is a plain object — just check it's defined
expect(result.bridges[0].electricalSpec).toBeDefined();
```

---

## Legacy References

### LR1
**File**: `src/compile/__tests__/compile-integration.test.ts` (line 4–5, and variable names throughout)
**Stale reference**: The variable name `legacy` is used throughout the integration test to refer to `compileCircuit()` and `compileAnalogCircuit()` results (lines 334, 374, 410, 436, 461, 482, 535, 554, 875). The word "legacy" describes historical provenance — it characterizes the old functions as "legacy" relative to the new unified path. This is a historical-provenance reference banned by the rules.

---

### LR2
**File**: `src/compile/__tests__/compile-integration.test.ts` (lines 4–5)
**Stale reference**:
```
 * Compares `compileUnified()` output against the legacy `compileCircuit()` and
 * `compileAnalogCircuit()` entry points so regressions are immediately visible.
```
The file-level JSDoc describes `compileCircuit()` and `compileAnalogCircuit()` as "legacy" entry points. This is a historical-provenance description in a comment — exactly what the rules ban.

---

## Additional Observations (Non-violation, informational)

**P3-4 `ModelAssignment` duplication**: Progress notes for P3-4 state that `ModelAssignment` was defined locally in `partition.ts` because P3-3 was not yet complete. The final implementation moved the canonical definition to `extract-connectivity.ts` and `partition.ts` imports it from there (confirmed by the import on line 22 of `partition.ts`). This duplication was resolved correctly.

**P3-10 analog compiler inlining**: The analog compiler (`src/analog/compiler.ts`) inlines `extractDigitalSubcircuit`, `PositionUnionFind`, `buildAnalogNodeMap`, and `buildAnalogNodeMapFromPartition` as private functions — these are not exported. This is architecturally correct since these are now internal implementation details. The function names are clean (no old API names).

**P3-12 grep checklist**: All 12 grep patterns from the P3-12 hard-delete verification return zero hits in `src/` (confirmed). The deleted modules (`src/engine/union-find.ts`, `src/engine/mixed-partition.ts`, `src/engine/net-trace.ts`, `src/analog/node-map.ts`) are confirmed absent.

**Test count**: 7486/7490 passing (4 pre-existing submodule failures). Baseline requirement of 7405+ is met by a large margin.
