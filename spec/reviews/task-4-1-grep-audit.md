# Task 4.1 Zero-Occurrence Grep Audit

**Date**: 2026-03-31  |  **Agent**: implementer (hostile verification pass)

---

## Methodology

Every symbol grepped with: `grep -rn SYMBOL src/ e2e/ scripts/`
PASS = zero or spec-compliant hits. FAIL = real violations requiring fixes.

---

## Symbol Checks

### 1. `_spiceModelOverrides`

Hits: 5 lines, all in `src/solver/analog/__tests__/spice-model-overrides.test.ts`

Line 154: `propsMap.set("_spiceModelOverrides", spiceModelOverrides)` — live code, not a comment.
This test was written against the old P1.4 API and must be deleted or rewritten.

**Verdict: FAIL** — test file uses old property key as live string literal.

---

### 2. `_modelParams`

Hits: 6 lines, all in `src/solver/analog/__tests__/spice-model-overrides.test.ts`

Test names and descriptions reference the old `_modelParams` concept (e.g. "empty_overrides: {}
leaves _modelParams equal to raw defaults"). Tests a deleted mechanism.

**Verdict: FAIL** — test references old `_modelParams` concept; tests deleted mechanism.

---

### 3. `_spiceModelName` — Hits: 0 — **PASS**

---

### 4. `namedParameterSets`

Hits: 9 lines across `src/io/dts-schema.ts` (guard that throws on this field + JSDoc) and
test files `dts-model-roundtrip.test.ts` and `dts-schema.test.ts` (rejection tests).

Guard code throws immediately when this field appears in a document. Tests verify the throw.
Field is never consumed as live data.

**Verdict: CONDITIONAL PASS** — rejection guard is the correct forward-compatibility implementation.
If spec intent is zero literal hits including guard code, this is FAIL. Human decision needed.

---

### 5. `modelDefinitions`

Hits: 7 lines — same guard pattern in `dts-schema.ts` + rejection tests.

**Verdict: CONDITIONAL PASS** — same reasoning as `namedParameterSets`.

---

### 6. `subcircuitBindings`

Hits: 7 lines — same guard pattern in `dts-schema.ts` + rejection tests.

**Verdict: CONDITIONAL PASS** — same reasoning as `namedParameterSets`.

---

### 7. `simulationModel` (as property key) — Hits: 0 — **PASS**

---

### 8. `SubcircuitModelRegistry` — Hits: 0 — **PASS**

---

### 9. `ModelLibrary` (import or reference)

Hits: 0 exact token matches for `ModelLibrary`. Three lines in `menu-toolbar.ts` contain
`buildSpiceModelLibrary` — substring match only, not the `ModelLibrary` token.

**Verdict: PASS**

---

### 10. `DeviceType` (outside model-parser.ts) — Hits: 0 — **PASS**

---

### 11. `models.mnaModels` — Hits: 0 — **PASS**

NOTE: bare `mnaModels` has 230 hits (see Additional section). The dotted accessor is zero.

---

### 12. `ComponentDefinition.subcircuitRefs` — Hits: 0 — **PASS**

---

### 13. `getActiveModelKey` — Hits: 0 — **PASS**

---

### 14. `availableModels` (function name from registry)

Hits: 6 lines in production code:
- `src/headless/netlist-types.ts:86`    `readonly availableModels: string[]`
- `src/headless/netlist.ts:407,418`     `availableModels: models`
- `scripts/mcp/formatters.ts:50,51,52`  `comp.availableModels.includes(...)`

These are a public field on `ComponentDescriptor` (the MCP-facing netlist interface), not the
deleted registry function. Spec says zero. `progress.md` Wave 4 marks this as "deferred (API
contract)" — that framing is not a valid exception to the spec requirement.

**Verdict: FAIL** — 6 hits in production code. Field must be removed from `ComponentDescriptor`.

Files requiring changes:
- `src/headless/netlist-types.ts:86`
- `src/headless/netlist.ts:407, 418`
- `scripts/mcp/formatters.ts:50, 51, 52`

---

### 15. `modelKeyToDomain` — Hits: 0 — **PASS**

---

### 16–22. Import paths (all 7 symbols)

| Import path | Hits | Notes | Verdict |
|-------------|------|-------|---------|
| `model-param-meta` | 0 | | PASS |
| `model-library` | 0 | 2 substring matches inside `spice-model-library-dialog` name, not the path | PASS |
| `subcircuit-model-registry` | 0 | | PASS |
| `default-models` | 0 | | PASS |
| `transistor-expansion` | 0 | | PASS |
| `transistor-models` | 0 | | PASS |
| `spice-subckt-dialog` | 0 | 2 e2e CSS class selectors, not import paths | PASS |

---

## Bridge Architecture Checks

### 23. Norton in `bridge-adapter.ts` — 0 hits — **PASS**

### 24. Norton in `digital-pin-model.ts` — 0 hits — **PASS**

NOTE: `stampOutput()` implements a Norton equivalent for behavioral gates but does not use the
word "Norton" in source. Bridge adapters use `stamp()` (ideal voltage source path), not
`stampOutput()`. The two paths are correctly separated.

### 25. `isNonlinear.*true` in `bridge-adapter.ts` — 0 hits — **PASS**

Both adapters declare `readonly isNonlinear: false = false`.

### 26. `branchIndex.*=.*-1` in `bridge-adapter.ts` (BridgeOutputAdapter must be zero)

Hits: 1 line — line 196: `readonly branchIndex: number = -1`

This is on `BridgeInputAdapter` (class starts at line 187). Per spec: "BridgeInputAdapter still
has `branchIndex = -1` (no branch)." This is the correct and expected hit.

`BridgeOutputAdapter` (line 41) declares `readonly branchIndex: number` with no initializer —
set from the constructor parameter at line 67. CORRECT.

**Verdict: PASS** — the only `branchIndex = -1` is on `BridgeInputAdapter` as specified.

### 27. `setParam?` in `analog-types.ts` — 0 hits — **PASS** (setParam is required, not optional)

### 28. `stampNonlinear` in `bridge-adapter.ts` — 0 hits — **PASS**

### 29. `_thresholdVoltage` in `coordinator.ts` — 0 hits — **PASS**

### Bridge stampRHS verification (behavioral)

`digital-pin-model.ts stamp()` method:
- Drive mode: `stampRHS(bIdx, V_target)` — uses **branch index** — CORRECT
- Hi-Z mode:  `stampRHS(bIdx, 0)` — uses **branch index** — CORRECT

`stampOutput()` uses `nodeIdx` — this is the Norton path for behavioral gates only, not bridges.
Bridge adapters call `stamp()`, not `stampOutput()`.

**Verdict: PASS** — bridge output stamps RHS on branch row only.

---

## Task 4.2 Re-verification

### 30. `model-defaults` in `src/` — Hits: 0 — **PASS**

`grep -rn "model-defaults" src/` returns zero hits. All 4 originally-broken test files have
been fixed. Imports in `spice-model-overrides.test.ts`, `mosfet.test.ts`,
`spice-model-overrides-mcp.test.ts`, and `spice-import-dialog.test.ts` are resolved.

---

## Additional Critical Check: `mnaModels`

Total hits: **230 lines**

Production code (non-test):
- `src/compile/extract-connectivity.ts:43,86,90,94` — legacy shim + comments
- 47 component files:
  - `src/components/flipflops/`: d.ts, d-async.ts, jk.ts, jk-async.ts, rs.ts, rs-async.ts, t.ts (7 files)
  - `src/components/gates/`: and.ts, nand.ts, nor.ts, not.ts, or.ts, xnor.ts, xor.ts + 1 more (8 files)
  - `src/components/io/`: button-led.ts, clock.ts, ground.ts, led.ts, probe.ts, seven-seg-hex.ts (6 files)
  - `src/components/memory/`: counter-preset.ts, counter.ts, register.ts (3 files)
  - `src/components/passives/`: capacitor.ts, crystal.ts, inductor.ts, memristor.ts, polarized-cap.ts,
    potentiometer.ts, resistor.ts, tapped-transformer.ts, transformer.ts, transmission-line.ts + 2 (12 files)
  - `src/components/sensors/`: spark-gap.ts (1 file)
  - `src/components/switching/`: fuse.ts, relay-dt.ts, relay.ts, switch-dt.ts, switch.ts (5 files)
  - `src/components/wiring/`: bus-splitter.ts, decoder.ts, demux.ts, driver-inv.ts, driver.ts, mux.ts, splitter.ts (7 files)

Shim at `extract-connectivity.ts:86-94`:
```
// Legacy: some definitions attach mnaModels directly on def.models (test-only pattern).
const mnaModelsObj = def.models ? (def.models as Record<string, unknown>)['mnaModels'] : undefined;
```
This is a backward-compatibility shim, banned by rules.md ("No backwards compatibility shims").

**Verdict: BLOCKER** — 47+ component files + shim need migration. Unfinished Wave T2/T3 work.

---

## Behavioral Verification

### `factory:` vs `setParam(` count

- `factory:` hits in `src/components/` non-test: **248**
- `setParam(` hits in `src/components/` non-test: **42**

Spec requires one `setParam` per factory. Gap of 206 = unmigrated components (mnaModels pattern).

**Verdict: FAIL**

### `extends AbstractCircuitElement` in test files

Count: **3** (spec requires ≤5)

**Verdict: PASS**

---

## Summary Table

| # | Symbol | Hits | Verdict |
|---|--------|------|---------|
| 1 | `_spiceModelOverrides` | 5 (test only) | **FAIL** |
| 2 | `_modelParams` | 6 (test only) | **FAIL** |
| 3 | `_spiceModelName` | 0 | PASS |
| 4 | `namedParameterSets` | 9 (guard+tests) | CONDITIONAL PASS |
| 5 | `modelDefinitions` | 7 (guard+tests) | CONDITIONAL PASS |
| 6 | `subcircuitBindings` | 7 (guard+tests) | CONDITIONAL PASS |
| 7 | `simulationModel` | 0 | PASS |
| 8 | `SubcircuitModelRegistry` | 0 | PASS |
| 9 | `ModelLibrary` | 0 | PASS |
| 10 | `DeviceType` (outside model-parser) | 0 | PASS |
| 11 | `models.mnaModels` | 0 | PASS |
| 12 | `ComponentDefinition.subcircuitRefs` | 0 | PASS |
| 13 | `getActiveModelKey` | 0 | PASS |
| 14 | `availableModels` | 6 (production) | **FAIL** |
| 15 | `modelKeyToDomain` | 0 | PASS |
| 16–22 | import paths (all 7) | 0 | PASS |
| 23 | Norton in bridge-adapter | 0 | PASS |
| 24 | Norton in digital-pin-model | 0 | PASS |
| 25 | `isNonlinear.*true` in bridge-adapter | 0 | PASS |
| 26 | `branchIndex.*=.*-1` (BridgeOutput) | 0 | PASS |
| 27 | `setParam?` in analog-types | 0 | PASS |
| 28 | `stampNonlinear` in bridge-adapter | 0 | PASS |
| 29 | `_thresholdVoltage` in coordinator | 0 | PASS |
| 30 | `model-defaults` (Task 4.2) | 0 | PASS |
| — | `mnaModels` (blocker) | 230 | **BLOCKER** |
| — | `factory:` vs `setParam(` ratio | 248 vs 42 | **FAIL** |
| — | `extends AbstractCircuitElement` (tests) | 3 | PASS (≤5) |

---

## Required Actions

### Action 1 (HIGH): Delete or rewrite `spice-model-overrides.test.ts`

`src/solver/analog/__tests__/spice-model-overrides.test.ts` tests the old P1.4 compiler merge
mechanism (`_spiceModelOverrides` → `_modelParams`) that no longer exists. Must be deleted or
completely rewritten to test the current `defineModelParams()`/`getModelParam()` API.

### Action 2 (HIGH): Remove `availableModels` from `ComponentDescriptor`

1. Remove `readonly availableModels: string[]` from `src/headless/netlist-types.ts`
2. Remove population at `src/headless/netlist.ts` lines 407 and 418
3. Update `scripts/mcp/formatters.ts` to derive available models inline

Recommendation: rename to `modelKeys: string[]` populated from `Object.keys(def.modelRegistry ?? {})`.
Since `formatters.ts` only has a `ComponentDescriptor` (not the registry def), the field must be
pre-computed in the netlist builder and stored under a name that does not conflict with the deleted
registry function name.

### Action 3 (BLOCKER): Complete `mnaModels` → `modelRegistry` migration

47+ component files in `src/components/` still use `models: { mnaModels: { behavioral: ... } }`.
All must be migrated to `modelRegistry: { behavioral: { factory, paramDefs, params } }`.
After migration, delete the shim at `src/compile/extract-connectivity.ts:86–94`.

### Action 4 (HIGH): Add `setParam` to all migrated components

After `mnaModels` migration, each component with a factory must implement `setParam(key, value)`.
Current ratio: 248 factories, 42 `setParam` implementations (gap of 206).

### Action 5 (DECISION NEEDED): `namedParameterSets` / `modelDefinitions` / `subcircuitBindings`

Hits are in guard code that rejects old-format documents, plus tests verifying rejection.
Human decision required: accept as necessary guard code (CONDITIONAL PASS) or treat as FAIL
and remove all literal string references (would require detecting old-format via version check alone).