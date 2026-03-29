# Review Report: Wave 0 v2 — Foundation Types

## Summary

| Field | Value |
|-------|-------|
| Tasks reviewed | 5 (W0.1, W0.2, W0.3, W0.4, W0.5) |
| Violations — critical | 0 |
| Violations — major | 1 |
| Violations — minor | 0 |
| Gaps | 2 |
| Weak tests | 0 |
| Legacy references | 0 |
| Verdict | **has-violations** |

---

## Violations

### V1 — Incorrect JSDoc semantics on `subcircuitBindings` (major)

**File**: `src/core/circuit.ts`, line 182

**Rule violated**: Code hygiene — comments exist only to explain complicated code to future developers. A comment describing incorrect semantics actively misleads and is worse than no comment.

**Evidence**:
```typescript
/** Maps component instance IDs to their resolved subcircuit model name. */
subcircuitBindings?: Record<string, string>;
```

**Spec definition** (`spec/model-unification-v2.md`, circuit metadata section and plan W0.4):
```
subcircuitBindings?: Record<string, string>;  // "ComponentType:modelKey" → definition name
```

The spec is explicit: keys are `"ComponentType:modelKey"` strings (e.g., `"And:74hc"`), not component instance IDs. The implementation comment describes a completely different mapping — instance-ID-to-model-name — which is wrong. The type `Record<string, string>` is correct but the documented contract is inverted. Code written against this comment will implement the wrong behavior. The spec also states: "circuit-local: component type + model key → definition name" — this matches the `"ComponentType:modelKey"` format, not instance IDs.

**Severity**: major

---

## Gaps

### G1 — No test for `getActiveModelKey` resolving via `subcircuitRefs`

**Spec requirement** (`spec/plan-v2.md`, W0.3): `subcircuitRefs` added to `ComponentDefinition`; `getActiveModelKey` must resolve keys found in `subcircuitRefs`.

**Implementation**: `registry.ts` lines 308–309 correctly adds:
```typescript
if (def.subcircuitRefs?.[prop]) return prop;
```

**What was found**: The `getActiveModelKey` describe block in `src/core/__tests__/registry.test.ts` has 7 tests covering digital model resolution, mnaModels key resolution, defaultModel fallback, and error paths. No test covers the case where `simulationModel` is set to a key present in `subcircuitRefs` (e.g., `"cmos"`). This new code path, added specifically for Wave 0 v2, is entirely untested.

**File**: `src/core/__tests__/registry.test.ts`

---

### G2 — No test for `availableModels` including `subcircuitRefs` keys

**Spec requirement** (`spec/plan-v2.md`, W0.3): `availableModels()` must include keys from `subcircuitRefs`.

**Implementation**: `registry.ts` lines 281–286:
```typescript
if (def.subcircuitRefs) {
  for (const k of Object.keys(def.subcircuitRefs)) {
    if (!keys.includes(k)) keys.push(k);
  }
}
```

**What was found**: The three `availableModels` tests (lines 370–398) test digital-only, mnaModels-only, and digital+mnaModels combinations only. No test covers a component with `subcircuitRefs` set — the new branch added for Wave 0 v2 is entirely untested.

**File**: `src/core/__tests__/registry.test.ts`

---

## Weak Tests

None found.

---

## Legacy References

None found.

Searches performed across all five Wave 0 v2 changed files for:
- `subcircuitModel`, `requiresBranchRow`, `logical`, `analog-pins`, `analog-internals`, `engineType`
- `TODO`, `FIXME`, `HACK`, `workaround`, `temporary`, `for now`, `legacy`, `backwards compat`
- `previously`, `migrated from`, `replaced`, `fallback`, `shim`, `as unknown`

All returned zero hits.

---

## Per-Task Findings

### W0.1 — `MnaSubcircuitNetlist` type (`src/core/mna-subcircuit-netlist.ts`)

**Result: clean**

Both `SubcircuitElement` and `MnaSubcircuitNetlist` interfaces are present and match the spec exactly:
- `ports: string[]` — present
- `params?: Record<string, number>` — present
- `elements: SubcircuitElement[]` — present
- `internalNetCount: number` — present
- `netlist: number[][]` — present
- `SubcircuitElement.typeId: string` — present
- `SubcircuitElement.modelRef?: string` — present
- `SubcircuitElement.params?: Record<string, number | string>` — present

Both interfaces are exported at module top level. Consumed correctly by 13 downstream importers.

### W0.2 — `PinDeclaration.kind` required field (`src/core/pin.ts`)

**Result: clean**

`kind: "signal" | "power"` is a required (non-optional) field on both `PinDeclaration` (line 44) and `Pin` (line 29). The `makePin` function (line 100) correctly propagates `decl.kind` to the produced `Pin`. The `standardGatePinLayout` helper hard-codes `kind: "signal"` on all generated declarations (lines 337, 351), which is correct for signal pins.

### W0.3 — `MnaModel` updates in `src/core/registry.ts`

**Result: has-gaps (G1, G2 in tests)**

- `factory` is required (no `?`) — confirmed at line 183
- `subcircuitModel` field — absent (correctly deleted)
- `requiresBranchRow` field — absent (correctly deleted)
- `branchCount?: number` — present at line 195
- `subcircuitRefs?: Record<string, string>` on `ComponentDefinition` — present at line 259
- `getActiveModelKey` updated to resolve via `subcircuitRefs` — present at lines 308–309
- `availableModels` updated to include `subcircuitRefs` keys — present at lines 281–286
- Test coverage for both new code paths: absent (see G1, G2)

### W0.4 — `CircuitMetadata` updates (`src/core/circuit.ts`)

**Result: has-violations (V1)**

- `subcircuitBindings?: Record<string, string>` — present at line 183
- JSDoc comment is semantically incorrect (see V1 above)
- `modelDefinitions` field — already present from earlier phase (W11.3), now typed as `Record<string, MnaSubcircuitNetlist>` via inline import — correct

### W0.5 — `DiagnosticCode` addition (`src/compile/types.ts`)

**Result: clean**

`| 'unresolved-model-ref'` is present at line 38 of the `DiagnosticCode` union. No other changes were made to the file beyond this addition.
