# Review Report: Wave 4 — Heuristic Site Rewrites H1-H15

## Summary

- **Tasks reviewed**: 3 (W4.1, W4.2, W4.3)
- **Files reviewed**: src/app/menu-toolbar.ts, src/app/test-bridge.ts, src/app/canvas-popup.ts, src/compile/partition.ts, src/compile/__tests__/partition.test.ts, src/solver/analog/compiler.ts, src/compile/__tests__/compile-integration.test.ts
- **Violations**: 1 major, 1 minor
- **Gaps**: 1
- **Weak tests**: 3
- **Legacy references**: 0
- **Verdict**: has-violations

---

## Violations

### V-001 — Major

**File**: `src/compile/__tests__/compile-integration.test.ts:971`
**Rule violated**: Rules — "Test the specific: exact values, exact types, exact error messages where applicable."
**Evidence**:
```typescript
expect(result.analog!.elements.length).toBeGreaterThan(0);
```
**Severity**: major

The test `dual-model component with simulationModel="analog" produces analog domain with elements` uses `toBeGreaterThan(0)` to assert element count. The circuit is deterministic: a single `DualAnd` component with an analog factory stub that creates a 2-node resistor element. The expected element count is exactly 1. The `toBeGreaterThan(0)` assertion is trivially satisfied by any non-empty result and would pass even if the compiler produced incorrect element counts.

---

### V-002 — Minor

**File**: `src/compile/__tests__/compile-integration.test.ts:1009`
**Rule violated**: Rules — "Test the specific: exact values, exact types, exact error messages where applicable."
**Evidence**:
```typescript
expect(result.analog!.nodeCount).toBeGreaterThan(0);
```
**Severity**: minor

The test `neutral Ground component touching analog net produces non-null analog domain` uses `toBeGreaterThan(0)` for node count. The circuit has one AnalogR (2-pin) and one Ground — the node count is deterministic (1 non-ground node). The assertion does not verify the specific expected topology.

---

## Gaps

### G-001

**Spec requirement**: `spec/model-unification.md:424` — canvas-popup H5 rewrite uses `def.models.mnaModels?.[activeKey]` to look up the active MNA model for SPICE panel visibility.

**What was found**: The implementation at `src/app/canvas-popup.ts:92` correctly uses `def.models.mnaModels?.[activeKey]`. However, the current component registry still stores analog models under `def.models.analog` (old structure), not `def.models.mnaModels`. For any real component, `def.models.mnaModels?.[activeKey]` will always be `undefined` because components declare `models.analog`, not `models.mnaModels`. This means the SPICE panel will never display for real components via the canvas-popup path — only test fixtures that use the new structure would trigger it.

**File**: `src/app/canvas-popup.ts:92-95`

This is a gap between the canvas-popup rewrite (which correctly targets the new `mnaModels` structure) and the component declarations (which still use `models.analog`). The H5 rewrite is spec-compliant in isolation, but the path is dead in practice until component declarations are migrated. No components have been migrated to `mnaModels` as part of Wave 4, which leaves H5 correct in form but non-functional in substance.

**Note**: If the component migration is a deliberately deferred task in a future wave, this gap should be flagged as a tracking item rather than a blocking defect. The spec does describe a future `mnaModels` migration but does not assign it to Wave 4. Recording as a gap for phase-completion review.

---

## Weak Tests

### WT-001

**Test path**: `src/compile/__tests__/compile-integration.test.ts::compileUnified — model resolution via getActiveModelKey::dual-model component with simulationModel="analog" produces analog domain with elements`
**What is wrong**: `toBeGreaterThan(0)` does not verify the exact number of compiled elements. For a single `DualAnd` component with a deterministic analog factory, the count should be exactly 1. A compiler bug that produced 3 spurious elements would still pass this assertion.
**Evidence**:
```typescript
expect(result.analog!.elements.length).toBeGreaterThan(0);
```

---

### WT-002

**Test path**: `src/compile/__tests__/compile-integration.test.ts::compileUnified — model resolution via getActiveModelKey::neutral Ground component touching analog net produces non-null analog domain`
**What is wrong**: `toBeGreaterThan(0)` for `nodeCount` is a near-trivially-weak assertion. The circuit has a known topology — one AnalogR connecting two positions and one Ground. The non-ground node count should be exactly 1. The `toBeGreaterThan(0)` check would pass for any positive node count.
**Evidence**:
```typescript
expect(result.analog!.nodeCount).toBeGreaterThan(0);
```

---

### WT-003

**Test path**: `src/compile/__tests__/partition.test.ts::electrical spec on bridge::returns empty spec when no analog electrical override is present`
**What is wrong**: The assertion checks only that `electricalSpec` is defined, not what it contains. The test title says "returns empty spec" but the assertion does not verify the spec has no electrical overrides set. A spec with arbitrary values would still pass.
**Evidence**:
```typescript
// electricalSpec is a plain object — just check it's defined
expect(result.bridges[0].electricalSpec).toBeDefined();
```
The comment itself acknowledges the assertion is weak (`just check it's defined`), which makes this a deliberate choice to avoid specifying expected content — a rule violation.

---

## Legacy References

None found in Wave 4 changed files.

---

## Additional Notes (informational, not violations)

**runPassA_partition still reads `def.models?.analog`**: `src/solver/analog/compiler.ts` lines 604, 611, 616 still access `def.models?.analog?.transistorModel`, `def.models?.analog?.requiresBranchRow`, and `def.models?.analog?.getInternalNodeCount`. These accesses are to read model *properties* (not for domain routing classification), so they do not represent H12/H13 heuristic violations. The spec H12/H13 rewrites targeted the `hasAnalog`/`hasBothModels` predicate variables used for skip/continue decisions — those have been correctly replaced with `pc.model === null` and `'executeFn' in pc.model`. The `def.models?.analog` reads that remain are for consuming model configuration values and are correct until the `mnaModels` migration is complete.

**Pass B H14/H15**: The main Pass B loop at `src/solver/analog/compiler.ts:962` correctly uses `meta.pc.model === null || 'executeFn' in meta.pc.model` as the skip guard, replacing the old `hasAnalogModel`/`hasBothModels` variables. Line 1225 uses `def.models?.digital !== undefined && def.models?.analog?.factory !== undefined` for the bridge adapter path — this is a structural property check, not a domain routing heuristic, and is appropriate until the `mnaModels` migration.

**H2/H3 menu-toolbar.ts**: Both rewrites correctly use `modelKeyToDomain(getActiveModelKey(el, def), def) === 'mna'` with `try/catch` wrapping to handle components with no models. Spec-compliant.

**H4 test-bridge.ts**: `getCircuitDomain()` correctly iterates elements and uses `modelKeyToDomain(getActiveModelKey(el, def), def) === 'mna'`. Spec-compliant.

**H6/H7 partition.ts**: Neutral routing unified to `touchesAnalog` check using `g.domains.has("analog")`. Spec-compliant.

**H8 partition.ts**: Unknown keys now route via `modelKeyToDomain()` in the `else` branch. Spec-compliant. Tests in `partition.test.ts` verify the new behavior with specific component counts.

**W4.3 partition.test.ts new tests**: The four H6/H7 neutral routing tests (lines 533-633) use `toBe(true)`/`toBe(false)` on presence in partitions — these are appropriately specific for boolean membership tests.

**W4.3 compile-integration.test.ts new tests**: The three model-resolution tests (lines 939-1011) cover dual-model digital default, dual-model analog override, and neutral-touching-analog cases. Two of the three use weak `toBeGreaterThan(0)` assertions (see WT-001 and WT-002 above).
