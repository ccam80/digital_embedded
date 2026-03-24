# Review Report: Waves 0.1 and 1.1 (Phase 0 + Phase 1)

## Summary

- **Tasks reviewed**: 12 (P0-1 through P0-6, P1-1 through P1-6)
- **Violations**: 5 (1 critical, 2 major, 2 minor)
- **Gaps**: 3
- **Weak tests**: 2
- **Legacy references**: 2
- **Verdict**: has-violations

---

## Violations

### V1 — CRITICAL

**File**: `src/analog/compiler.ts`, line 898–900

**Rule violated**: "All replaced or edited code is removed entirely. Scorched earth." (rules.md Code Hygiene) and spec requirement (unified-component-architecture.md, "Remaining work: explicit node identity", compiler construction block)

**Evidence**:
```typescript
const element: AnalogElement = Object.assign(core, {
  pinNodeIds: pinNodeIds,
});
```

**The spec explicitly requires** the compiler to set *both* `pinNodeIds` and `allNodeIds`:

```typescript
// spec/unified-component-architecture.md lines 157–160
const element: AnalogElement = Object.assign(core, {
  pinNodeIds: pinNodeIds,
  allNodeIds: [...pinNodeIds, ...internalNodeIds],
});
```

The `allNodeIds` assignment is absent. The `internalNodeIds` array is built immediately above at line 820–823 but never combined into the element. This means `AnalogElement.allNodeIds` is never set by the compiler on elements constructed via `analogFactory`. Elements that declare their own `allNodeIds` on their core return value (transmission-line, makeVddSource in compiler.ts, makeGminShunt in dc-operating-point.ts) are not affected, but any element that relies on the compiler to set `allNodeIds` will be missing it.

The `AnalogElementCore` type (element.ts line 59) is defined as `Omit<AnalogElement, 'pinNodeIds' | 'allNodeIds'>`, meaning factories explicitly do not set `allNodeIds`. The compiler is the **sole place** responsible for setting it. Failing to do so leaves the field undefined at runtime on all compiler-produced elements.

**Severity**: Critical

---

### V2 — MAJOR

**File**: `src/analog/compiler.ts`, line 930

**Rule violated**: Spec acceptance criterion for P0-1/P0-2 — topology validators must use `allNodeIds` (spec section "Remaining work: explicit node identity", Consumer migration table)

**Evidence**:
```typescript
topologyInfo.push({
  nodeIds: pinNodeIds,   // line 930
  isBranch: meta.branchIdx >= 0,
  ...
});
```

The spec Consumer migration table states:

> `detectWeakNodes` compiler.ts:924 | `topologyInfo.nodeIds` (pin only) | `el.allNodeIds` (pins + internals)
> `detectVoltageSourceLoops` compiler.ts:628 | `topologyInfo.nodeIds` | `el.allNodeIds`

The `topologyInfo` entry here still uses only `pinNodeIds`, not `[...pinNodeIds, ...internalNodeIds]`. The topology validators (`detectWeakNodes`, `detectVoltageSourceLoops`, `detectInductorLoops`) therefore remain blind to internal nodes, which is exactly the bug the spec declares must be fixed.

**Severity**: Major

---

### V3 — MAJOR

**File**: `src/analog/dc-operating-point.ts`, line 339

**Rule violated**: Spec acceptance criterion for P0-2 — `_inferNodeCount` must use `allNodeIds` (spec section Consumer migration table)

**Evidence**:
```typescript
function _inferNodeCount(elements: readonly AnalogElement[], matrixSize: number): number {
  let maxNode = 0;
  for (const el of elements) {
    for (const n of (el.pinNodeIds ?? [])) {   // line 339: still pin-only
```

The spec Consumer migration table states:

> `_inferNodeCount` dc-operating-point.ts:333 | `el.nodeIndices` (pin only) | `el.allNodeIds` (pins + internals)

The implementation iterates `el.pinNodeIds` (renamed from the old `nodeIndices`), not `el.allNodeIds`. This leaves the "latent" internal-node undercount bug described in the spec (section "Concrete bugs / fragilities", item 2) unresolved. Internal nodes exceeding all pin node IDs will still cause matrix undercount.

The `?? []` guard is also notable — `pinNodeIds` is a required `readonly number[]` on `AnalogElement` (element.ts line 73), not optional. A null-guard on a required field is defensive coding masking a design assumption.

**Severity**: Major

---

### V4 — MINOR

**File**: `src/editor/wire-current-resolver.ts`, lines 328–333

**Rule violated**: "No historical-provenance comments" (rules.md Code Hygiene) and "No fallbacks. No backwards compatibility shims." (rules.md Code Hygiene)

**Evidence**:
```typescript
// Prefer getPinCurrents (covers all elements including nonlinear
// devices like diodes that have no getCurrent or branchIndex).
// Fall back to getElementCurrent for elements that only have
// getCurrent or branchIndex.
const pc = pinCurrents;
const I = (pc !== null && pc.length >= 1) ? pc[0] : engine.getElementCurrent(eIdx);
```

Two issues:
1. The comment references `getCurrent` — a method that was supposed to be **removed** by P0-4. The comment `"elements that only have getCurrent or branchIndex"` documents a state of the world that should not exist after Phase 0 completion. This is a historical-provenance comment describing pre-migration behaviour.
2. The conditional `(pc !== null && pc.length >= 1) ? pc[0] : engine.getElementCurrent(eIdx)` is a backwards-compatibility fallback. After P0-4, `getPinCurrents` is mandatory on `AnalogElement` and `getElementPinCurrents` returns it directly. The fallback branch `engine.getElementCurrent(eIdx)` is dead code that should not exist.

The progress.md entry for P0-5 states: `src/editor/__tests__/wire-current-resolver.test.ts (updated mock to return [I, -I] instead of null)`. The null-guard `pc !== null` in the production code contradicts this: if the mock no longer returns null, the production guard against null is a legacy artefact.

**Severity**: Minor

---

### V5 — MINOR

**File**: `src/analog/dc-operating-point.ts`, line 339 (second issue at same location as V3)

**Rule violated**: "No fallbacks" (rules.md Code Hygiene)

**Evidence**:
```typescript
for (const n of (el.pinNodeIds ?? [])) {
```

`pinNodeIds` is declared `readonly pinNodeIds: readonly number[]` on `AnalogElement` — a required, non-optional field. The `?? []` null-coalescing guard implies the field might be absent, which contradicts the interface contract. This pattern is defensive coding that masks a design failure rather than asserting correctness. If an element ever reaches `_inferNodeCount` without `pinNodeIds` set, the `?? []` silently masks a bug that should be a loud runtime error.

(Also present at `src/analog/newton-raphson.ts` line 232: `for (const ni of (el.pinNodeIds ?? []))` — same pattern, same violation.)

**Severity**: Minor

---

## Gaps

### G1

**Spec requirement**: The compiler must set `allNodeIds: [...pinNodeIds, ...internalNodeIds]` on every element produced via `analogFactory` (spec section "Remaining work: explicit node identity", compiler construction block, P0-1 acceptance criterion).

**What was actually found**: `src/analog/compiler.ts` line 898–900 sets only `pinNodeIds`. `allNodeIds` is absent from the `Object.assign` call.

**File**: `src/analog/compiler.ts`

---

### G2

**Spec requirement**: Topology validation consumers (`detectWeakNodes`, `detectVoltageSourceLoops`, `detectInductorLoops`) must receive `allNodeIds` (pins + internals) via `topologyInfo.nodeIds`. The spec Consumer migration table lists this as part of P0-2.

**What was actually found**: `src/analog/compiler.ts` line 930 passes `pinNodeIds` only to `topologyInfo`. The validators remain blind to internal nodes, leaving the bug described in spec "Concrete bugs / fragilities" item 1 and item 3 unresolved.

**File**: `src/analog/compiler.ts`

---

### G3

**Spec requirement**: `_inferNodeCount` in `dc-operating-point.ts` must iterate `el.allNodeIds` to account for internal nodes with higher IDs than all pin nodes (spec Consumer migration table, P0-2).

**What was actually found**: `src/analog/dc-operating-point.ts` line 339 iterates `el.pinNodeIds`. The spec-described latent undercount bug for high-numbered internal nodes is not resolved.

**File**: `src/analog/dc-operating-point.ts`

---

## Weak Tests

### WT1

**Test**: `src/core/__tests__/registry.test.ts` — `"models field is populated after register() from flat fields"` (line 424)

**Issue**: The assertion `expect(stored.models).toBeDefined()` is a trivially-true weak assertion. `models` being defined could mean an empty object `{}`. The follow-on assertions check `models!.digital` is defined and `models!.digital!.executeFn` is the right function, which are stronger — but the first `toBeDefined()` check adds noise without value.

**Evidence**:
```typescript
expect(stored.models).toBeDefined();
expect(stored.models!.digital).toBeDefined();
expect(stored.models!.digital!.executeFn).toBe(noopExecuteFn);
```

The first line is subsumed by the second. It does not constitute a rule violation on its own (the overall test does verify behaviour), but it is a weak assertion in the sense that it would pass even if `models` were an empty object.

**Severity**: Minor observation; the test overall tests desired behaviour.

---

### WT2

**Test**: `src/core/__tests__/registry.test.ts` — `"register() does not overwrite explicitly supplied models"` (line 467)

**Issue**: The assertion `expect(stored.models).toBe(customModels)` tests object identity (reference equality), not the contents of the models. While identity is correct to assert here (the spec says "not overwrite"), the test does not verify that `customModels.digital.executeFn` is the supplied function. If `_ensureModels` accidentally cloned the object instead of returning it, this test would catch it — but only for identity, not for behavioural correctness of the contents.

**Evidence**:
```typescript
const customModels: ComponentModels = {
  digital: { executeFn: noopExecuteFn },
};
const def: ComponentDefinition = { ...makeDefinition("ExplicitModels"), models: customModels };
registry.register(def);
const stored = registry.get("ExplicitModels")!;
expect(stored.models).toBe(customModels);  // identity only — no content check
```

---

## Legacy References

### LR1

**File**: `src/editor/wire-current-resolver.ts`, lines 329, 331

**Evidence**:
```
// devices like diodes that have no getCurrent or branchIndex).
// Fall back to getElementCurrent for elements that only have
// getCurrent or branchIndex.
```

`getCurrent` is the removed method. After Phase 0 (P0-3/P0-4), no element has `getCurrent` and none lacks `getPinCurrents`. These comments reference the old API that was supposed to be fully removed. They describe the pre-migration world that no longer exists.

---

### LR2

**File**: `src/analog/element.ts`, lines 54–58

**Evidence**:
```typescript
/**
 * The return type of analogFactory — everything except pinNodeIds and allNodeIds.
 * Factories return this; the compiler adds both fields from resolved pins and
 * internal node IDs. This ensures both fields are set in exactly one place (the compiler).
 */
export type AnalogElementCore = Omit<AnalogElement, 'pinNodeIds' | 'allNodeIds'>;
```

The comment states "the compiler adds both fields" — but as documented in V1 above, the compiler currently only adds `pinNodeIds`. The comment is therefore inaccurate with respect to the current implementation state, and constitutes a historical-provenance comment (describing an intended design state rather than actual behaviour). This is a lower-severity reference since the type definition itself is correct, but the comment makes a false claim about what the compiler does.
