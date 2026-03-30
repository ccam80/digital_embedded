# Review Report: Wave 2 -- Core machinery + BJT ref impl + cleanup

## Summary

| Metric | Value |
|--------|-------|
| Tasks reviewed | 5 (T3, T4, T5, T6, bridge cleanup) |
| Violations | 8 |
| Gaps | 2 |
| Weak tests | 12 |
| Legacy references | 2 |
| Verdict | **has-violations** |

---

## Violations

### V1: throw Error("pending reimplementation") in spice-model-apply.ts (CRITICAL)

- **File**: src/app/spice-model-apply.ts, lines 30, 49
- **Rule violated**: Completeness -- "Never mark work as deferred, TODO, or not implemented."
- **Evidence**: applySpiceImportResult and applySpiceSubcktImportResult both throw Error with "pending reimplementation with unified model system"
- **Severity**: critical
- **Notes**: These functions are called from spice-import-dialog.ts and menu-toolbar.ts. Any user attempting to import a SPICE model will get a runtime crash.

### V2: throw Error("pending reimplementation") in spice-model-library-dialog.ts (CRITICAL)

- **File**: src/app/spice-model-library-dialog.ts, line 26
- **Rule violated**: Completeness -- "Never mark work as deferred, TODO, or not implemented."
- **Evidence**: openSpiceModelLibraryDialog throws Error("openSpiceModelLibraryDialog: pending reimplementation with unified model system")
- **Severity**: critical
- **Notes**: Called from menu-toolbar.ts line 1552. Clicking "SPICE Models" button crashes the app.

### V3: Historical-provenance comment in spice-model-library-dialog.ts

- **File**: src/app/spice-model-library-dialog.ts, line 5
- **Rule violated**: Code Hygiene -- "No historical-provenance comments."
- **Evidence**: "Pending reimplementation using the unified model system."
- **Severity**: minor

### V4: Historical-provenance comment in spice-model-apply.ts

- **File**: src/app/spice-model-apply.ts, lines 3-4
- **Rule violated**: Code Hygiene -- "No historical-provenance comments."
- **Evidence**: "Pending reimplementation using the unified model system (model property + modelRegistry + PropertyBag model param partition)."
- **Severity**: minor

### V5: lrcxor-fixture.test.ts not deleted -- references banned symbols

- **File**: src/solver/analog/__tests__/lrcxor-fixture.test.ts, lines 17, 706
- **Rule violated**: Code Hygiene -- "All replaced or edited code is removed entirely." Also violates zero-occurrence check for synthesizeDigitalCircuit and BridgeInstance.
- **Evidence**: Comments referencing "synthesizeDigitalCircuit + BridgeInstance" and "digital bridge path"
- **Severity**: major
- **Notes**: Progress.md lists this file as deleted in the bridge cleanup task, but it still exists on disk.

### V6: compile-integration.test.ts uses simulationModel instead of model

- **File**: src/compile/__tests__/compile-integration.test.ts, line 967
- **Rule violated**: Spec -- simulationModel is a removed concept replaced by model property.
- **Evidence**: new Map([['simulationModel', 'behavioral']]) -- should be 'model' not 'simulationModel'
- **Severity**: major
- **Notes**: Since resolveModelAssignments() reads 'model' not 'simulationModel', this test is testing with the wrong property key. The element resolves to defaultModel instead of the intended "behavioral", so the test may pass for the wrong reason.

### V7: as unknown as type assertion in compiler.ts

- **File**: src/solver/analog/compiler.ts, line 1216
- **Rule violated**: Review focus item #1 -- "ZERO hits required" for as unknown as in compiler.ts.
- **Evidence**: pinElectricalMap as unknown as PropertyValue
- **Severity**: minor
- **Notes**: Pre-existing infrastructure for storing pin electrical data in PropertyBag. Not introduced by Wave 2, but flagged per review focus instructions.

### V8: Undocumented _mp_ prefix delta mechanism in compiler.ts

- **File**: src/solver/analog/compiler.ts, lines 1225-1227
- **Rule violated**: Spec adherence -- The _mp_ prefix convention for storing user deltas in the static property partition is not documented in the spec.
- **Evidence**: Compiler checks props.has("_mp_" + key) and overlays onto model param partition
- **Severity**: major
- **Notes**: The spec says "replaceModelParams(entry.params) then overlay user deltas" but does not define the _mp_ mechanism. This is scope creep if undocumented, or a gap if it should be in the spec.

---

## Gaps

### G1: Three functions throw "pending reimplementation" instead of being reimplemented or deleted

- **Spec requirement**: Removed Concepts table says spice-subckt-dialog.ts is "Deleted -- folded into unified import dialog." The apply functions and library dialog were gutted to throw rather than reimplemented.
- **What was found**: Three functions throw "pending reimplementation" errors instead of being either reimplemented or deleted.
- **Files**: src/app/spice-model-apply.ts, src/app/spice-model-library-dialog.ts

### G2: lrcxor-fixture.test.ts listed as deleted in progress.md but still exists

- **Spec requirement**: Bridge cleanup task lists src/solver/analog/__tests__/lrcxor-fixture.test.ts under "Files deleted".
- **What was found**: File still exists on disk with 700+ lines referencing deleted bridge infrastructure.
- **File**: src/solver/analog/__tests__/lrcxor-fixture.test.ts

---

## Weak Tests

### WT1-WT3: dts-model-roundtrip.test.ts -- toBeDefined() guards

- **Test paths**: roundtrip_inline_model_entry (lines 91, 93), delta_only_saves_modified_params (line 194)
- **Issue**: toBeDefined() guard assertions before specific property checks that would throw anyway if undefined.

### WT4-WT6: bjt.test.ts -- toBeDefined() guards in definition tests

- **Test paths**: npn_definition_fields (lines 403-404), pnp_definition_fields (lines 413-414)
- **Issue**: Guard assertions before modelRegistry property access.

### WT7: bjt.test.ts -- toBeGreaterThan(0) for conductances

- **Test path**: Active region stamp values (lines 210-213)
- **Issue**: toBeGreaterThan(0) is weak. Should assert specific expected values for gm, go, gpi, gmu.

### WT8: bjt.test.ts -- toBeGreaterThan(0) for currents

- **Test path**: Saturation region (lines 240-241, 248)
- **Issue**: toBeGreaterThan(0) for If, Ir, ic. Should assert specific values.

### WT9: bjt.test.ts -- toBeDefined() in PNP polarity test

- **Test path**: PNP polarity reversal (lines 371-372)
- **Issue**: Guard assertions before RHS comparison.

### WT10: bjt.test.ts -- toBeGreaterThan(0) in integration test

- **Test path**: Integration (lines 615-616)
- **Issue**: Weak assertion for collector and base current.

### WT11-WT12: property-panel-model.test.ts -- toBeDefined() guards

- **Test paths**: Multiple tests (lines 117, 125, 140, 147, 160, 190, 210)
- **Issue**: toBeDefined() guard assertions before specific value checks.

---

## Legacy References

### LR1: synthesizeDigitalCircuit and BridgeInstance in lrcxor-fixture.test.ts

- **File**: src/solver/analog/__tests__/lrcxor-fixture.test.ts, lines 17, 706
- **Reference**: Both are deleted symbols that should have zero occurrences.

### LR2: simulationModel property key in compile-integration.test.ts

- **File**: src/compile/__tests__/compile-integration.test.ts, lines 947, 963, 967
- **Reference**: simulationModel is a removed concept per the unified model system spec.
