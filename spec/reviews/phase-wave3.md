# Review Report: Wave 3 -- Runtime Features (Tasks 3.1-3.5)

## Summary

| Field | Value |
|-------|-------|
| Tasks reviewed | 5 (3.1, 3.2, 3.3, 3.4, 3.5) |
| Violations | 4 |
| Gaps | 4 |
| Weak tests | 6 |
| Legacy references | 1 |
| Verdict | **has-violations** |

---

## Violations

### V1 -- validateModel stub returns empty array (no-op function)

- **File**: src/app/spice-import-dialog.ts, lines 44-51
- **Rule violated**: Completeness -- Never mark work as deferred, TODO, or not implemented. Never write pass or raise NotImplementedError in production code.
- **Severity**: major
- **Evidence**: The function validateModel accepts a _model parameter (underscore prefix = unused) and always returns []. It is called at line 219 to populate warnings but never produces any. The entire validation pass is dead code. This is functionally equivalent to a stub.

### V2 -- isInverted used instead of isNegated in test file

- **File**: src/solver/analog/__tests__/spice-import-dialog.test.ts, line 40
- **Rule violated**: Code Hygiene -- stale field reference to removed API
- **Severity**: major
- **Evidence**: The makePin function at line 36 returns an object with isInverted: false. The Pin interface in src/core/pin.ts line 27 defines isNegated: boolean. The field isInverted does not exist on the Pin interface. This is a reference to a removed field name.

### V3 -- spice-import-dialog.test.ts missing setAttribute on element stubs

- **File**: src/solver/analog/__tests__/spice-import-dialog.test.ts, lines 64-77
- **Rule violated**: Code Hygiene -- incomplete stub element
- **Severity**: minor
- **Evidence**: The makeElement function returns an object literal as CircuitElement but does not include setAttribute method. The CircuitElement interface requires it. This suggests the test was written against an older version of the interface.

### V4 -- spice-import-dialog.test.ts missing kind field on Pin

- **File**: src/solver/analog/__tests__/spice-import-dialog.test.ts, lines 36-43
- **Rule violated**: Code Hygiene -- incomplete Pin construction
- **Severity**: minor
- **Evidence**: The makePin function does not include the kind: "signal" field that is present in the canonical Pin interface. The test in src/solver/analog/__tests__/spice-model-apply.test.ts correctly includes kind: "signal" in its makePin at line 47.

---

## Gaps

### G1 -- Task 3.1: Missing MCP tool test surface

- **Spec requirement**: Tests: Headless API (create model entry, verify in registry), MCP tool (import via tool, verify), E2E (import dialog flow)
- **What was found**: Headless API tests exist in src/solver/analog/__tests__/spice-model-apply.test.ts (16 tests). MCP surface tests exist in src/headless/__tests__/spice-import-roundtrip-mcp.test.ts and spice-model-overrides-mcp.test.ts. However, the MCP tests do not exercise the MCP server tool handlers -- they call applySpiceImportResult directly.
- **File paths**: src/solver/analog/__tests__/spice-model-apply.test.ts, src/headless/__tests__/spice-import-roundtrip-mcp.test.ts

### G2 -- Task 3.1/3.4/3.5: Missing E2E tests

- **Spec requirement**: All three tasks specify E2E tests as part of the three-surface testing requirement.
- **What was found**: progress.md explicitly states E2E tests were NOT RUN (E2E tests blocked). No E2E tests were written or verified for Wave 3 tasks.
- **File paths**: N/A (tests do not exist)

### G3 -- Task 3.5: ModelSwitchCommand not wired in canvas-popup.ts

- **Spec requirement**: src/app/canvas-popup.ts -- wire dropdown selection to ModelSwitchCommand
- **What was found**: canvas-popup.ts calls propertyPopup.showModelSelector() (line 70) which internally creates and executes a ModelSwitchCommand within property-panel.ts. But canvas-popup.ts itself does not import or directly reference ModelSwitchCommand. The wiring happens indirectly through PropertyPanel.
- **File paths**: src/app/canvas-popup.ts, src/editor/property-panel.ts

### G4 -- Task 3.4: canvas-popup.ts not listed as modified in progress.md

- **Spec requirement**: src/app/canvas-popup.ts -- single Import Model button replacing any old split buttons
- **What was found**: Progress.md for Task 3.4 lists only src/app/spice-import-dialog.ts and the test file as modified. canvas-popup.ts is not listed. The spec explicitly says canvas-popup.ts should have a single Import Model button.
- **File paths**: src/app/canvas-popup.ts

---

## Weak Tests

### WT1 -- Guard assertions without immediate content check

- **Test path**: src/headless/__tests__/spice-import-roundtrip-mcp.test.ts :: applySpiceImportResult writes to circuit.metadata.models
- **Issue**: Line 108 uses expect(q1).toBeDefined() as a standalone guard with no deeper assertion on q1 itself.

### WT2 -- not.toBeNull followed by non-null assertion pattern

- **Test path**: src/headless/__tests__/spice-import-roundtrip-mcp.test.ts :: circuit with applySpiceImportResult compiles without errors
- **Issue**: Lines 167-168 assert compiled and compiled!.analog are not null as guards before the real assertion. The null-checks are trivially-true guards.

### WT3 -- toBeCloseTo with precision 20 (effectively exact match)

- **Test path**: src/headless/__tests__/spice-import-roundtrip-mcp.test.ts (multiple tests)
- **Issue**: toBeCloseTo(1e-14, 20) with precision=20 is testing for exact equality to 20 decimal places. If the intent is exact match, use toBe(). If approximate, 20 is meaningless.

### WT4 -- toBeCloseTo with precision 20 in spice-model-apply test

- **Test path**: src/solver/analog/__tests__/spice-model-apply.test.ts (multiple tests)
- **Issue**: Same toBeCloseTo(1e-14, 20) pattern at lines 119, 146-147. Either use toBe() for exact match or a reasonable precision.

### WT5 -- Auto-detect tests reimplement detection logic instead of testing detectFormat()

- **Test path**: src/solver/analog/__tests__/spice-import-dialog.test.ts :: spice-import-dialog: auto-detect format (all 5 tests)
- **Issue**: The auto-detect tests reimplement the detection logic inline (extracting first non-blank line, applying regex) and assert the regex result. They then call parseSubcircuit or parseModelCard directly. They do NOT test detectFormat() or openSpiceImportDialog(). The actual auto-detect code path in spice-import-dialog.ts is never exercised.

### WT6 -- property-panel-model.test.ts StubElement naming confusion

- **Test path**: src/editor/__tests__/property-panel-model.test.ts lines 13-33
- **Issue**: The test file defines a StubElement class (DOM stub) that collides in name with the circuit-element StubElement pattern checked by Task 4.3. While this is a DOM element stub (not a circuit element stub), the naming collision could cause false negatives in automated grep-based audits.

---

## Legacy References

### LR1 -- isInverted field name (removed from Pin interface)

- **File**: src/solver/analog/__tests__/spice-import-dialog.test.ts, line 40
- **Reference**: isInverted: false -- The Pin interface was migrated from isInverted to isNegated. This test file still uses the old field name.

---

## Per-Task Summary

### Task 3.1: Rewrite runtime model registry
- **Spec adherence**: Mostly complete. applySpiceImportResult creates kind: "inline" entries with factory from behavioral. applySpiceSubcktImportResult creates kind: "netlist" entries. Storage path is correct.
- **Missing**: E2E tests. MCP tests call functions directly rather than through MCP tool handlers.

### Task 3.2: Delta serialization migration
- **Spec adherence**: Complete. DTS schema does NOT define namedParameterSets, modelDefinitions, subcircuitBindings as schema fields. Guard code throws on old-format documents (lines 156-173 of dts-schema.ts). Serializer uses getModelParam()/getModelParamKeys(). Deserializer uses replaceModelParams(). The "done in prior phases" claim is verified as accurate.

### Task 3.3: ModelSwitchCommand
- **Spec adherence**: Complete. Uses replaceModelParams() in execute/undo. Zero _spiceModelOverrides references. Property panel triggers ModelSwitchCommand from dropdown change. The "done in prior phase" claim is verified as accurate.

### Task 3.4: Unified import dialog
- **Spec adherence**: Mostly complete. Single dialog handles both formats. Auto-detect works. spice-subckt-dialog has zero references.
- **Issues**: validateModel is a no-op stub. Auto-detect tests do not test detectFormat() directly. Missing E2E tests. canvas-popup.ts modification not tracked in progress.md.

### Task 3.5: Model dropdown from modelRegistry
- **Spec adherence**: Complete. Dropdown reads from modelRegistry keys + digital + runtime models. availableModels() has zero hits in property-panel.ts. Selection triggers ModelSwitchCommand.
- **Issues**: Missing E2E tests. canvas-popup.ts does not directly wire to ModelSwitchCommand (delegated through PropertyPanel).
