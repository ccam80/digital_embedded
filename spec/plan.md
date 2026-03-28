# Implementation Plan — Model System Unification

## Spec
`spec/model-unification.md`

## Phase Dependency Graph

Single phase with 13 waves (0-12). Sequential core (0-4), then parallel tracks.

```
Wave 0 → Wave 1 → Wave 2 → Wave 3 → Wave 4
                                        ├→ Wave 5 → Wave 10 → Wave 11 → Wave 12
                                        └→ Wave 6 → Wave 7 → Wave 8 → Wave 9
```

## Phase 1: Model System Unification

### Wave 0: Fix B1 + B2 (mechanical rename)
- **Risk**: Low
- **Tasks**:
  - W0.1 (S): Fix B1 — `netlist.ts:393` reads wrong attribute (`defaultModel` → `simulationModel`)
  - W0.2 (M): Fix B2 — Rename all 117 `simulationMode` occurrences across 12 files to `simulationModel`

### Wave 1: Core Resolution Functions
- **Risk**: Low
- **Tasks**:
  - W1.1 (M): Implement `MnaModel` interface, restructure `ComponentModels` with `mnaModels` field, add `getActiveModelKey()` and `modelKeyToDomain()` in registry.ts
  - W1.2 (S): Create canonical `INFRASTRUCTURE_TYPES` export in `extract-connectivity.ts`, replace I2-I5 imports
  - W1.3 (M): Move `pinElectrical`/`pinElectricalOverrides` from `AnalogModel` to `ComponentDefinition`

### Wave 2: Pipeline Reorder
- **Risk**: Medium
- **Tasks**:
  - W2.1 (L): Reorder pipeline: resolveModelAssignments before flatten, delete `resolveCircuitDomain()`, rewrite `flattenCircuitScoped()` cross-engine check to use `modelKeyToDomain()`
  - W2.2 (M): Tests: subcircuit with per-instance override, same-domain inline, cross-domain opaque, "analog wins" label precedence

### Wave 3: Dead Code Removal + Test Rewrite
- **Risk**: Medium
- **Tasks**:
  - W3.1 (L): Delete `extractDigitalSubcircuit`, `compileAnalogCircuit`, `resolveCircuitInput`, infrastructure sets I2-I4
  - W3.2 (M): Rewrite tests: `analog-compiler.test.ts`, `compile-analog-partition.test.ts` to use `compileAnalogPartition` via `compileUnified`

### Wave 4: Heuristic Site Rewrites (H1-H15)
- **Risk**: Medium
- **Tasks**:
  - W4.1 (M): Rewrite H1-H8 (compile pipeline heuristics) to use `getActiveModelKey()` + `modelKeyToDomain()`
  - W4.2 (M): Rewrite H9-H15 (analog/digital compiler heuristics) to use new resolution
  - W4.3 (M): Tests: mixed-circuit compile, partition tests with new resolution

### Wave 5: ComponentModels Restructure (144 files, 159 declarations)
- **Risk**: High
- **Depends on**: Wave 4
- **Tasks**:
  - W5.1 (L): Write and run codemod for patterns B/C/D/E across all component files
  - W5.2 (M): Manual review of edge cases (multi-export files, FET switches, analog fuse)
  - W5.3 (M): Verify component sweep tests + all compile tests pass

### Wave 6: digitalPinLoading Metadata + Bridge Synthesis
- **Risk**: High
- **Depends on**: Wave 4 (parallel track with Wave 5)
- **Tasks**:
  - W6.1 (M): Add `digitalPinLoading` to `CircuitMetadata`, implement bridge synthesis for all three modes
  - W6.2 (M): Implement `stableNetId()` helper and per-net override resolution at compile time
  - W6.3 (M): Tests: three modes produce correct bridge adapter counts

### Wave 7: Model Selector Dropdown + Canvas Popup
- **Risk**: Medium
- **Depends on**: Wave 6
- **Tasks**:
  - W7.1 (M): Replace `showSimulationModeDropdown()` with named model selector, replace `SIMULATION_MODE_LABELS`
  - W7.2 (M): Rewrite canvas popup panel switching to use `getActiveModelKey()` + `modelKeyToDomain()`
  - W7.3 (M): E2E tests: dropdown shows named models, panel switches correctly

### Wave 8: Pin Loading UI
- **Risk**: Medium
- **Depends on**: Wave 7
- **Tasks**:
  - W8.1 (M): Pin loading menu in Simulation menu (cross-domain/all/none)
  - W8.2 (M): Per-net override context menu + visual indicators on wires
  - W8.3 (M): E2E tests: right-click wire, set loading, verify indicator

### Wave 9: Save/Load for Pin Loading
- **Risk**: Medium
- **Depends on**: Wave 8
- **Tasks**:
  - W9.1 (M): Add `digitalPinLoading` + per-net overrides to save schema, serializer, deserializer
  - W9.2 (S): Strip `engineType` from `SavedMetadata` on load
  - W9.3 (M): Tests: round-trip, orphaned override diagnostic

### Wave 10: .SUBCKT Parser
- **Risk**: Medium
- **Depends on**: Wave 5
- **Tasks**:
  - W10.1 (L): Implement `parseSubcircuit()` in `model-parser.ts`
  - W10.2 (M): Implement subcircuit-to-Circuit builder (`spice-model-builder.ts`)
  - W10.3 (M): Tests: parsing, element mapping, port mapping

### Wave 11: SPICE Import UI
- **Risk**: Medium
- **Depends on**: Wave 10
- **Tasks**:
  - W11.1 (M): `.MODEL` import dialog (right-click → "Import SPICE Model")
  - W11.2 (M): `.SUBCKT` import dialog
  - W11.3 (M): Circuit-level model library dialog
  - W11.4 (M): E2E tests for import flows

### Wave 12: SPICE Model Serialization
- **Risk**: Medium
- **Depends on**: Wave 11
- **Tasks**:
  - W12.1 (M): Add `modelDefinitions` and `namedParameterSets` to DTS schema
  - W12.2 (M): Serialize/deserialize: populate ModelLibrary and TransistorModelRegistry on load
  - W12.3 (M): Tests: round-trip save/load with imported models

## Verification Measures
1. `npm run test:q` — all unit/integration tests pass
2. `npx playwright test` — all E2E tests pass
3. `grep -r "simulationMode" src/` returns zero hits (after Wave 0)
4. `grep -r "analog:" src/components/` within `models:` blocks returns zero hits (after Wave 5)
5. No `derivedEngineType`, `forceAnalogDomain`, `resolveCircuitDomain`, `extractDigitalSubcircuit`, `compileAnalogCircuit` references remain (after Wave 3)
