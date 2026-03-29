# Review Report: Wave 7 v2

## Summary

- **Tasks reviewed**: 2 (W7.1, W7.2)
- **Violations**: 3 (1 critical, 1 major, 1 minor)
- **Gaps**: 10
- **Weak tests**: 20
- **Legacy references**: 0
- **Verdict**: has-violations

---

## Violations

### V-1 (Critical) — Dead-code test body: bridge assertions never execute

**File**: `src/headless/__tests__/digital-pin-loading-mcp.test.ts`, lines 167, 189, 211

**Rule violated**: Rules — Testing: "Test the specific: exact values, exact types, exact error messages where applicable." The assertions that were supposed to replace weak guards are completely unreachable.

**Evidence**: The implementer changed `expect(bridges.length).toBeGreaterThan(0)` to `expect(bridges.length).toBe(0)` at lines 167, 189, and 211. But the `for (const bridge of bridges)` loop bodies immediately following each of these lines (lines 169–173, 191–195, 213–217) still contain the specific-value assertions for `rIn`, `rOut`, and `isFinite(rIn)`. Because `bridges.length` is asserted to be 0, the arrays are empty and the loop bodies are never entered. The assertions for `rIn=Infinity`, `rOut=0`, and `isFinite(bridge.rIn)` silently pass without exercising anything.

### V-2 (Major) — Debug console.log scaffolding left in production test file

**File**: `src/__tests__/diag-rc-step.test.ts`, lines 25–50

**Rule violated**: CLAUDE.md / Code Hygiene: No commented-out code, no debug scaffolding; Rules — Code Hygiene: all replaced or edited code is removed entirely.

**Evidence**: 12 `console.log` calls were left in the test:
- `console.log('Elements:', circuit.elements.length);`
- `console.log('Wires:', circuit.wires.length);`
- `console.log('resolveModelAssignments result:', JSON.stringify(...));`
- `console.log('compiled.analog:', compiled.analog);`
- `console.log('diagnostics:', compiled.analog?.diagnostics);`
- etc.

These are diagnostic scaffolding from the development session and constitute noise in CI output.

### V-3 (Minor) — Residual `not.toBeNull()` guard at line 124 of digital-pin-loading-mcp.test.ts

**File**: `src/headless/__tests__/digital-pin-loading-mcp.test.ts`, line 124

**Rule violated**: Rules — Testing: "Test the specific." The spec (W7.1 table) required all 8 weak assertions in this file to be replaced with specific values.

**Evidence**:
```
expect(compiled.analog).not.toBeNull();
```
This is a weak guard assertion that survives from the original file. The spec listed 8 replacements for this file; only 3 (the `toBeGreaterThan(0)` ones at lines 167/189/211) were touched.

---

## Gaps

### G-1 — W7.1: digital-pin-loading-mcp.test.ts — 5 of 8 required replacements not made

**Spec requirement**: W7.1 table specifies 8 weak-assertion replacements in `src/headless/__tests__/digital-pin-loading-mcp.test.ts`.

**What was found**: Only 3 replacements were made (lines 167, 189, 211 — `toBeGreaterThan(0)` → `toBe(0)`). Lines 116, 124, 163, 164, 185, 186, 207, 208 still contain `not.toBeNull()` or `not.toBeUndefined()` guards that the spec required to be replaced with specific assertions about compiled structure.

**File**: `src/headless/__tests__/digital-pin-loading-mcp.test.ts`

### G-2 — W7.1: spice-model-overrides-mcp.test.ts — 2 of 2 required replacements not made

**Spec requirement**: W7.1 table specifies 2 weak-assertion replacements in `src/headless/__tests__/spice-model-overrides-mcp.test.ts`.

**What was found**: Lines 124, 125, 128, 145, 146, 152 still contain `not.toBeNull()` guards. The spec required replacing these with assertions on compiled structure (e.g. specific diagnostic counts, specific model param values).

**File**: `src/headless/__tests__/spice-model-overrides-mcp.test.ts`

### G-3 — W7.1: behavioral-combinational.test.ts — 3 of 3 required replacements not made

**Spec requirement**: W7.1 table specifies 3 weak-assertion replacements in `src/solver/analog/__tests__/behavioral-combinational.test.ts`.

**What was found**: Lines 347, 348, 353, 354, 359, 360 still assert `.models?.digital` and `.models?.mnaModels?.behavioral` with `toBeDefined()` only. The spec required these to assert specific property values.

**File**: `src/solver/analog/__tests__/behavioral-combinational.test.ts`

### G-4 — W7.1: behavioral-flipflop.test.ts — required replacements not made

**Spec requirement**: W7.1 table specifies 1 weak-assertion replacement in `src/solver/analog/__tests__/behavioral-flipflop.test.ts`.

**What was found**: Line 317 `expect(DDefinition.models?.mnaModels?.behavioral?.factory).toBeDefined()` remains; lines 322, 323, 327, 328 also have `toBeDefined()` on model structure. The spec required replacing with assertions on the factory's behaviour or a specific non-undefined property value.

**File**: `src/solver/analog/__tests__/behavioral-flipflop.test.ts`

### G-5 — W7.1: behavioral-sequential.test.ts — required replacements not made

**Spec requirement**: W7.1 table specifies 1 weak-assertion replacement in `src/solver/analog/__tests__/behavioral-sequential.test.ts`.

**What was found**: Registration tests at lines 366–402 still use `toBeDefined()` on model presence checks. The spec required replacing with specific assertions.

**File**: `src/solver/analog/__tests__/behavioral-sequential.test.ts`

### G-6 — W7.1: pin-loading-menu.test.ts — required replacement not made

**Spec requirement**: W7.1 table specifies 1 weak-assertion replacement in `src/compile/__tests__/pin-loading-menu.test.ts`.

**What was found**: Line 362 still has `expect(result.analog).not.toBeNull()`. The spec required replacing with a specific assertion on compiled analog structure contents.

**File**: `src/compile/__tests__/pin-loading-menu.test.ts`

### G-7 — W7.1: analog-compiler.test.ts — required replacement not made

**Spec requirement**: W7.1 table specifies 2 weak-assertion replacements in `src/solver/analog/__tests__/analog-compiler.test.ts`.

**What was found**: Line 508 `expect(bridge.compiledInner).toBeDefined()` remains. The spec required replacing with a specific assertion on the compiled inner structure.

**File**: `src/solver/analog/__tests__/analog-compiler.test.ts`

### G-8 — W7.2: E2E test for pin-loading menu affecting simulation behavior — absent

**Spec requirement**: W7.2 requires an E2E Playwright test that exercises the Simulation menu's pin-loading setting and verifies that the resulting simulation behaviour changes (bridge adapter synthesized / not synthesized, signals differ).

**What was found**: `e2e/gui/pin-loading-wire-override.spec.ts` tests the wire right-click context menu UI for per-wire pin-loading overrides — not the Simulation menu setting that controls the circuit-level `digitalPinLoading` metadata. This does not satisfy the W7.2 requirement.

**File**: No file matches the W7.2 E2E requirement.

### G-9 — W7.2: MCP test for circuit_describe reflecting named models — absent

**Spec requirement**: W7.2 requires an MCP tool test exercising `circuit_describe` and verifying that `namedParameterSets` / `modelDefinitions` appear in the describe output after a SPICE import.

**What was found**: No test file exercises `circuit_describe` in conjunction with named model sets. The existing `spice-model-overrides-mcp.test.ts` does not call `circuit_describe` and does not check model-library output fields.

**File**: No file matches the W7.2 MCP circuit_describe requirement.

### G-10 — W7.2: MCP SPICE .MODEL → patch → compile round-trip test — absent

**Spec requirement**: W7.2 requires an MCP tool test that issues a SPICE `.MODEL` card via the patch operation, compiles, and verifies the model parameters are applied in the compiled result.

**What was found**: `spice-model-overrides-mcp.test.ts` tests some SPICE flows but does not exercise the `.MODEL` → `patch` → `compile` round-trip via the MCP tool handler interface.

**File**: No file matches the W7.2 MCP round-trip requirement.

---

## Weak Tests

### WT-1
**Path**: `src/headless/__tests__/digital-pin-loading-mcp.test.ts` (line 116)
**Problem**: `not.toBeNull()` guard — does not assert specific structure of compiled analog result.
**Evidence**: `expect(compiled.analog).not.toBeNull();`

### WT-2
**Path**: `src/headless/__tests__/digital-pin-loading-mcp.test.ts` (line 124)
**Problem**: `not.toBeNull()` guard — does not assert specific structure.
**Evidence**: `expect(compiled.analog).not.toBeNull();`

### WT-3
**Path**: `src/headless/__tests__/digital-pin-loading-mcp.test.ts` (lines 163–164)
**Problem**: Two `not.toBeNull()` guards on bridge array elements without content check.
**Evidence**: `expect(bridges[0]).not.toBeNull(); expect(bridges[1]).not.toBeNull();`

### WT-4
**Path**: `src/headless/__tests__/digital-pin-loading-mcp.test.ts` (lines 185–186)
**Problem**: Same `not.toBeNull()` guards as WT-3 in second test case.
**Evidence**: `expect(bridges[0]).not.toBeNull(); expect(bridges[1]).not.toBeNull();`

### WT-5
**Path**: `src/headless/__tests__/digital-pin-loading-mcp.test.ts` (lines 207–208)
**Problem**: Same `not.toBeNull()` guards as WT-3 in third test case.
**Evidence**: `expect(bridges[0]).not.toBeNull(); expect(bridges[1]).not.toBeNull();`

### WT-6
**Path**: `src/headless/__tests__/spice-model-overrides-mcp.test.ts` (lines 124–125)
**Problem**: `not.toBeNull()` guards that gate specific-value assertions.
**Evidence**: `expect(result).not.toBeNull(); expect(result.analog).not.toBeNull();`

### WT-7
**Path**: `src/headless/__tests__/spice-model-overrides-mcp.test.ts` (line 128)
**Problem**: `not.toBeNull()` guard without asserting specific diagnostic count or structure.
**Evidence**: `expect(compiled).not.toBeNull();`

### WT-8
**Path**: `src/headless/__tests__/spice-model-overrides-mcp.test.ts` (lines 145–146)
**Problem**: `not.toBeNull()` guards in second test case.
**Evidence**: `expect(result).not.toBeNull(); expect(result.analog).not.toBeNull();`

### WT-9
**Path**: `src/headless/__tests__/spice-model-overrides-mcp.test.ts` (line 152)
**Problem**: `not.toBeNull()` guard without asserting specific structure.
**Evidence**: `expect(compiled).not.toBeNull();`

### WT-10
**Path**: `src/solver/analog/__tests__/behavioral-combinational.test.ts` (lines 347–348)
**Problem**: `toBeDefined()` on model sub-objects without checking specific property values.
**Evidence**: `expect(def.models?.digital).toBeDefined(); expect(def.models?.mnaModels?.behavioral).toBeDefined();`

### WT-11
**Path**: `src/solver/analog/__tests__/behavioral-combinational.test.ts` (lines 353–354)
**Problem**: Same `toBeDefined()` pattern as WT-10 for second component.
**Evidence**: `expect(def.models?.digital).toBeDefined(); expect(def.models?.mnaModels?.behavioral).toBeDefined();`

### WT-12
**Path**: `src/solver/analog/__tests__/behavioral-combinational.test.ts` (lines 359–360)
**Problem**: Same `toBeDefined()` pattern for third component.
**Evidence**: `expect(def.models?.digital).toBeDefined(); expect(def.models?.mnaModels?.behavioral).toBeDefined();`

### WT-13
**Path**: `src/solver/analog/__tests__/behavioral-flipflop.test.ts` (line 317)
**Problem**: `toBeDefined()` on `.factory` — does not verify the factory is callable or produces expected output.
**Evidence**: `expect(DDefinition.models?.mnaModels?.behavioral?.factory).toBeDefined();`

### WT-14
**Path**: `src/solver/analog/__tests__/behavioral-sequential.test.ts` (lines 366–402, multiple)
**Problem**: Multiple `toBeDefined()` calls on model registration fields without verifying specific values.
**Evidence**: Pattern `expect(def.models?.mnaModels?.behavioral).toBeDefined();` repeated across registration test cases.

### WT-15
**Path**: `src/compile/__tests__/pin-loading-menu.test.ts` (line 362)
**Problem**: `not.toBeNull()` guard on analog compile result without asserting specific content.
**Evidence**: `expect(result.analog).not.toBeNull();`

### WT-16
**Path**: `src/solver/analog/__tests__/analog-compiler.test.ts` (line 508)
**Problem**: `toBeDefined()` on `compiledInner` without asserting any of its specific properties.
**Evidence**: `expect(bridge.compiledInner).toBeDefined();`

### WT-17
**Path**: `src/solver/analog/__tests__/spice-import-dialog.test.ts` (lines 183–184)
**Problem**: `toBeDefined()` on `namedParameterSets` entry and its sub-fields without asserting specific param values exhaustively.
**Evidence**: `expect(sets).toBeDefined(); expect(sets!["2N2222"]).toBeDefined();`

### WT-18
**Path**: `src/solver/analog/__tests__/spice-subckt-dialog.test.ts` (lines 226, 291, 311–312)
**Problem**: `toBeDefined()` on sub-circuit compile fields without checking specific structural values.
**Evidence**: `expect(result).toBeDefined();` and `expect(inner).toBeDefined();`

### WT-19
**Path**: `src/solver/analog/__tests__/spice-model-library.test.ts` (lines 81–82, 110, 152–153, 168, 249–250, 324)
**Problem**: Multiple `toBeDefined()` calls on model library entries without asserting specific param values.
**Evidence**: `expect(model).toBeDefined(); expect(model!.params).toBeDefined();`

### WT-20
**Path**: `src/headless/__tests__/digital-pin-loading-mcp.test.ts` (lines 169–173, 191–195, 213–217)
**Problem**: Dead-code assertions — loop body never executes because `bridges.length` is asserted to be 0 at lines 167/189/211. The `rIn`, `rOut`, and `isFinite` assertions are structurally present but never evaluated.
**Evidence**: `expect(bridges.length).toBe(0);` immediately followed by `for (const bridge of bridges) { expect(bridge.rIn).toBe(Infinity); ... }` — loop body is unreachable.

---

## Legacy References

None found.

