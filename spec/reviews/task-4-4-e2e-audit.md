# Task 4.4 — E2E Test Audit

## Audit Date: 2026-03-31

## Methodology

Hostile verification — every claim verified by reading actual test files and running tests.
Tests run: `npx vitest run <file>` for headless/MCP, targeted playwright for E2E.

---

## Feature Coverage Matrix

| Feature | Headless API | MCP Surface | E2E/UI |
|---------|-------------|-------------|--------|
| Unified import dialog | PRESENT | PRESENT | PRESENT |
| Model dropdown with runtime entries | N/A | N/A | PRESENT |
| Model switch in property panel | N/A | N/A | PRESENT |
| Delta serialization round-trip | PRESENT | PARTIAL | MISSING |
| Bridge behavior — all three modes | PRESENT | PRESENT | PARTIAL |
| Hot-loading pin electrical params via setParam | PRESENT | N/A | N/A |
| Hot-loading model params via setParam | PRESENT | N/A | N/A |

---

## Feature-by-Feature Findings

### 1. Unified import dialog

**Headless API**: `src/solver/analog/__tests__/spice-import-dialog.test.ts`
- 15 tests covering parseModelCard, applySpiceImportResult, compile integration, auto-detect format.
- All 15 pass.

**MCP Surface**: `src/headless/__tests__/spice-import-roundtrip-mcp.test.ts`
- 9 tests covering parse, apply, compile, serialize/deserialize via DefaultSimulatorFacade.
- All 9 pass.

**E2E**: `e2e/gui/spice-import-flows.spec.ts`
- 7 tests: menu item visibility, dialog open, parse preview, apply stores overrides, subcircuit dialog.
- Coverage is complete for the browser surface.

**Status: FULLY COVERED across all three surfaces.**

---

### 2. Model dropdown with runtime entries

**E2E**: `e2e/gui/model-selector.spec.ts`
- 3 tests: dual-model component shows dropdown with human-readable labels, single-model hides dropdown, selecting behavioral shows SPICE panel.

**Status: FULLY COVERED (E2E only — dropdown is UI-only feature).**

---

### 3. Model switch in property panel

**E2E**: `e2e/gui/model-selector.spec.ts` test "selecting Behavioral model shows SPICE parameter panel"
- Exercises model switch via the dropdown in the property popup, verifies SPICE section appears.

`e2e/gui/spice-model-panel.spec.ts` — covers SPICE panel display, edit, and effect on simulation.

**Status: ADEQUATELY COVERED.**

---

### 4. Delta serialization round-trip

**Headless API**: `src/io/__tests__/dts-model-roundtrip.test.ts`
- 8 tests: metadata.models round-trip, per-element modelParamDeltas round-trip (BF=250 delta), delta-only-saves-modified-params, no delta when no model set, old-format crash detection.
- All 8 pass.

**MCP Surface**: `src/headless/__tests__/spice-import-roundtrip-mcp.test.ts` (partial)
- Tests serialize/deserialize of `circuit.metadata.models` via DefaultSimulatorFacade.
- MISSING: No test verifies per-element `modelParamDeltas` survive through `facade.serialize()` / `facade.deserialize()`.

**E2E**: No test exercises DTS round-trip via the postMessage API.
- MISSING: No parity-style test that exports a circuit via `sim-get-circuit`, reimports via `sim-load-data`, and verifies circuit state survives.

**Gaps: MCP surface missing modelParamDeltas test; E2E surface missing DTS round-trip test.**

---

### 5. Bridge behavior in all three modes

**Headless API**:
- `src/solver/analog/__tests__/digital-pin-model.test.ts` — 11 tests. All pass.
- `src/solver/analog/__tests__/bridge-adapter.test.ts` — 11 tests. All pass.
- `src/solver/analog/__tests__/bridge-compilation.test.ts` — 9 tests for none/cross-domain modes and per-net ideal override. All pass.

**MCP Surface**: `src/headless/__tests__/digital-pin-loading-mcp.test.ts`
- 4 tests: "all", "none", "cross-domain" modes via DefaultSimulatorFacade.compile(). All pass.

**E2E**: `e2e/gui/pin-loading-wire-override.spec.ts`
- PARTIAL: Covers UI context menu but does not verify simulation output differs across modes.
- Bridge mode is set via circuit.metadata.digitalPinLoading (compiler option), not a postMessage command. A postMessage-based mode-switch E2E test would require extending the API beyond its specified surface.

**Decision**: The three-mode behavioral coverage at MCP surface (full compilation + solver path) is sufficient. No new E2E simulation test is warranted without a postMessage API extension.

---

### 6. Hot-loading pin electrical params via setParam

**Headless API**:
- `src/solver/analog/__tests__/digital-pin-model.test.ts`: setParam("rOut"), setParam("vOH"), setParam("rIn") tests.
- `src/solver/analog/__tests__/bridge-adapter.test.ts`: setParam hot-update tests for both adapter types.
- `src/core/__tests__/analog-types-setparam.test.ts`: TypeScript interface enforcement.
- All pass.

**Status: FULLY COVERED. Pin electrical params are solver internals — no MCP or E2E surface exposure required.**

---

### 7. Hot-loading model params via setParam

**Headless API**:
- `src/core/__tests__/model-params.test.ts` — defineModelParams structure and fixture validation.
- `src/core/__tests__/analog-types-setparam.test.ts` — AnalogElementCore.setParam interface enforcement.
- All pass.

**Status: FULLY COVERED at headless level.**

---

## Tests to Create

### Gap 1: DTS modelParamDeltas — MCP surface

**File**: `src/headless/__tests__/dts-delta-mcp.test.ts` (new)

Tests:
- `per-element modelParamDeltas survive facade.serialize() / facade.deserialize()` — create circuit with BJT, set per-element BF=250 delta, serialize via facade, deserialize, verify BF=250 on the element.
- `delta_only_modified_params_in_mcp_roundtrip` — verify only changed params appear in delta after round-trip.

### Gap 2: DTS round-trip — E2E parity surface

**File**: `e2e/parity/dts-delta-roundtrip.spec.ts` (new)

Tests:
- `sim-get-circuit round-trip: export then reimport via sim-load-data preserves simulation` — load an AND gate, run tests, export, reimport, run same tests again (already tested in load-and-simulate.spec.ts). This already exists.
- The gap is specifically modelParamDeltas in a BJT circuit — but this requires loading a BJT .dig file with modelParamDeltas serialized. This is adequately covered by the headless dts-model-roundtrip tests which do not depend on the browser transport.

**Revised Decision**: The E2E surface `sim-get-circuit` + `sim-load-data` round-trip IS already tested in `e2e/parity/load-and-simulate.spec.ts` (test "get-circuit round-trip — export then reimport"). What is missing is a test that specifically verifies modelParamDeltas survive the postMessage round-trip. This requires a .dts file with deltas.

---

## Final Gap List

| Gap | File to Create | Priority |
|-----|---------------|----------|
| MCP: modelParamDeltas survive facade round-trip | `src/headless/__tests__/dts-delta-mcp.test.ts` | HIGH — completes MCP surface |
| E2E: modelParamDeltas survive postMessage round-trip | `e2e/parity/dts-delta-roundtrip.spec.ts` | MEDIUM — browser transport coverage |

---

## Current Test Counts (verified passing)

| File | Tests | Status |
|------|-------|--------|
| `src/solver/analog/__tests__/digital-pin-model.test.ts` | 11 | all pass |
| `src/solver/analog/__tests__/bridge-adapter.test.ts` | 11 | all pass |
| `src/solver/analog/__tests__/bridge-compilation.test.ts` | 9 | all pass |
| `src/solver/analog/__tests__/spice-import-dialog.test.ts` | 15 | all pass |
| `src/core/__tests__/analog-types-setparam.test.ts` | 2 | all pass |
| `src/core/__tests__/model-params.test.ts` | 9 | all pass |
| `src/io/__tests__/dts-model-roundtrip.test.ts` | 8 | all pass |
| `src/headless/__tests__/spice-import-roundtrip-mcp.test.ts` | 9 | all pass |
| `src/headless/__tests__/digital-pin-loading-mcp.test.ts` | 4 | all pass |
