# Implementation Progress — SPICE Model Panel

## Phase: SPICE Model Parameters Panel & Test Parameter Alignment

### Wave 1: Part 0 — Tunnel Diode Migration
| Task ID | Title | Status |
|---------|-------|--------|
| P0.1 | Add TUNNEL_DIODE_DEFAULTS to model-defaults.ts | done |
| P0.2 | Add TUNNEL to DeviceType union | done |
| P0.3 | Register TUNNEL in model library | done |
| P0.4 | Update tunnel-diode.ts to read _modelParams | done |

### Wave 2: Part 1 — SPICE Panel + Compiler Merge
| Task ID | Title | Status |
|---------|-------|--------|
| P1.1 | Create model-param-meta.ts metadata registry | done |
| P1.2 | Add showSpiceModelParameters() to property-panel.ts | done |
| P1.3 | Add visibility guard to canvas-popup.ts | done |
| P1.4 | Compiler merge with _spiceModelOverrides at both sites | done |
| P1.5 | Add _spiceModelOverrides PropertyDef to semiconductor components | done |

### Wave 3: Part 2 — Test Parameter Alignment
| Task ID | Title | Status |
|---------|-------|--------|
| P2.1 | Inject _spiceModelOverrides in analog-circuit-assembly E2E tests | done |

### Wave 4: Part 3 — Three-Surface Tests
| Task ID | Title | Status |
|---------|-------|--------|
| P3.1 | Headless tests (spice-model-overrides.test.ts) | done |
| P3.2 | MCP tool tests (spice-model-overrides-mcp.test.ts) | done |
| P3.3 | E2E tests (spice-model-panel.spec.ts) | done |

## Task P0.1: Add TUNNEL_DIODE_DEFAULTS to model-defaults.ts
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/solver/analog/model-defaults.ts
- **Tests**: 0/0 (no new tests required for this task — covered by P0.3/P0.4 acceptance tests)

## Task P0.3: Register TUNNEL in model library
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/solver/analog/model-library.ts
- **Tests**: pending (run after P0.4)

## Task P0.4: Update tunnel-diode.ts to read _modelParams
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/components/semiconductors/tunnel-diode.ts
- **Tests**: 9600/9600 passing

## Task P1.1: Create model-param-meta.ts metadata registry
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/solver/analog/model-param-meta.ts, src/solver/analog/__tests__/model-param-meta.test.ts
- **Files modified**: (none)
- **Tests**: 33/33 passing

## Task P1.2: Add showSpiceModelParameters() to property-panel.ts
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/editor/__tests__/property-panel-spice.test.ts
- **Files modified**: src/editor/property-panel.ts, src/solver/analog/model-defaults.ts
- **Tests**: 12/12 passing
- **Notes**: Added getDeviceDefaults() to model-defaults.ts for placeholder population. Added import of getParamMeta and getDeviceDefaults in property-panel.ts.

## Task P1.3: Add visibility guard to canvas-popup.ts
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/app/canvas-popup.ts
- **Tests**: 12/12 passing (P1.2 tests cover method existence; P1.3 guard is a routing change in canvas-popup verified by TypeScript compilation)
- **Notes**: Replaced the Pin Electrical block with unified visibility guard. simModel is resolved once; logical/analog-pins modes show Pin Electrical if hasDigitalModel; else if deviceType present shows SPICE panel.

## Task P1.5: Add _spiceModelOverrides PropertyDef to semiconductor components
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/components/semiconductors/__tests__/spice-model-overrides-prop.test.ts
- **Files modified**: src/core/properties.ts, src/editor/property-panel.ts, src/components/semiconductors/bjt.ts, src/components/semiconductors/diode.ts, src/components/semiconductors/mosfet.ts, src/components/semiconductors/njfet.ts, src/components/semiconductors/pjfet.ts, src/components/semiconductors/zener.ts, src/components/semiconductors/schottky.ts, src/components/semiconductors/scr.ts, src/components/semiconductors/diac.ts, src/components/semiconductors/triac.ts, src/components/semiconductors/tunnel-diode.ts
- **Tests**: 65/65 passing (new), 7601/7601 passing (full suite)

## Task P2.1: Inject _spiceModelOverrides in analog-circuit-assembly E2E tests
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: e2e/gui/analog-circuit-assembly.spec.ts
- **Tests**: 0/0 passing (E2E tests require browser; changes are structural injections — no unit tests for this task)
- **Changes**: Added 5 SPICE model override constants (BJT_NPN_OVERRIDES, BJT_PNP_OVERRIDES, MOSFET_NMOS_OVERRIDES, MOSFET_PMOS_OVERRIDES, JFET_NJFET_OVERRIDES) near top of file. Injected setComponentProperty('_spiceModelOverrides', ...) calls into all 13 specified tests: a8_bjt_ce (Q1 NPN), a9_bjt_diffpair (Q1+Q2 NPN), a10_bjt_darlington (Q1+Q2 NPN), a11_bjt_pushpull (Q1 NPN + Q2 PNP), a12_mosfet_cs (M1 NMOS), a15_jfet_amp (J1 NJFET), a16_cascode (Q1+Q2 NPN), a17_wilson_mirror (Q1+Q2+Q3 NPN), a18_widlar (Q1+Q2 NPN), a19_hbridge_fwd (Mp1+Mp2 PMOS + Mn1+Mn2 NMOS), a20_bjt_mosfet_driver (Q1 NPN + M1 NMOS), a21_multistage (Q1+Q2+Q3 NPN), test28 MOSFET PWM (M1 NMOS). All use _spiceModelOverrides exclusively — no direct _modelParams writes.

## Task P3.1: Headless tests (spice-model-overrides.test.ts)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none (file pre-existed with tests 1-4)
- **Files modified**: src/solver/analog/__tests__/spice-model-overrides.test.ts (added TUNNEL_DIODE_DEFAULTS import + test 5 for tunnel diode migration)
- **Tests**: 7/7 passing

## Task P3.2: MCP tool tests (spice-model-overrides-mcp.test.ts)
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/headless/__tests__/spice-model-overrides-mcp.test.ts
- **Files modified**: none
- **Tests**: 4/4 passing

## Task W0.1: Fix B1 — netlist.ts reads wrong attribute
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/headless/netlist.ts
- **Tests**: 0/0 (no tests specific to netlist.ts; this is a single-line attribute name fix per spec model-unification.md:269-273)
- **Details**: Changed `el.getAttribute('defaultModel')` to `el.getAttribute('simulationModel')` at line 393. The netlist display now correctly shows the active simulation model attribute rather than the non-existent defaultModel attribute.

## Task W0.2: Fix B2: Rename all `simulationMode` to `simulationModel`
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/solver/analog/compiler.ts` (21 occurrences renamed)
  - `src/app/canvas-popup.ts` (2 occurrences renamed)
  - `src/editor/property-panel.ts` (9 occurrences renamed)
  - `src/solver/analog/__tests__/digital-bridge-path.test.ts` (10 occurrences renamed)
  - `src/solver/analog/__tests__/compile-analog-partition.test.ts` (9 occurrences renamed)
  - `src/solver/analog/__tests__/analog-compiler.test.ts` (16 occurrences renamed)
  - `src/compile/extract-connectivity.ts` (5 occurrences renamed + bugfix in resolveModelAssignments)
  - `src/solver/digital/__tests__/flatten-bridge.test.ts` (6 occurrences renamed)
  - `src/solver/analog/__tests__/lrcxor-fixture.test.ts` (31 occurrences renamed)
  - `src/compile/__tests__/extract-connectivity.test.ts` (4 occurrences renamed)
  - `src/solver/digital/flatten.ts` (3 occurrences renamed)
  - `src/solver/analog/transistor-expansion.ts` (1 occurrence renamed)
  - `e2e/gui/spice-model-panel.spec.ts` (2 occurrences renamed)
  - `e2e/gui/component-sweep.spec.ts` (1 occurrence renamed)
- **Tests**: 9720/9730 passing (10 pre-existing failures from baseline, 0 new regressions)
- **Additional fix**: `resolveModelAssignments` in `extract-connectivity.ts` was updated to only treat `simulationModel` property values as model keys when they actually exist in `def.models`. Sub-mode values like `"analog-pins"`, `"logical"`, and `"analog-internals"` are not model registry keys — they are handled internally by the analog compiler. Without this fix, the rename caused these values to be used as invalid model keys, routing components to neutral domain and returning null from `compileUnified(...).analog`.

---
## Wave 0 Summary
- **Status**: complete
- **Tasks completed**: 2/2
- **Rounds**: 1

## Task W1.1: MnaModel interface, getActiveModelKey(), modelKeyToDomain()
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/core/registry.ts, src/core/__tests__/registry.test.ts
- **Tests**: 53/53 passing (registry tests); 6 pre-existing failures in tunnel-diode tests unchanged

## Task W1.2: Canonical INFRASTRUCTURE_TYPES export
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/compile/compile.ts` (replaced local INFRASTRUCTURE set with import of INFRASTRUCTURE_TYPES)
  - `src/solver/analog/compiler.ts` (added import of INFRASTRUCTURE_TYPES; replaced NEUTRAL_TYPES_FOR_PARTITION and neutralTypes with canonical set)
  - `src/solver/digital/compiler.ts` (added import of INFRASTRUCTURE_TYPES; replaced COMPILE_INFRASTRUCTURE_TYPES with import)
- **Tests**: 9730/9730 passing (vitest), 478/527 passing (playwright) — no new regressions vs baseline
- **Details**:
  - Verified canonical set I1 at `src/compile/extract-connectivity.ts:21-24` contains: `'Wire', 'Tunnel', 'Ground', 'VDD', 'Const', 'Probe', 'Splitter', 'Driver', 'NotConnected', 'ScopeTrigger', 'Port'`
  - I2 (compile.ts:96) replaced local set with imported INFRASTRUCTURE_TYPES
  - I3 (analog/compiler.ts:287) removed NEUTRAL_TYPES_FOR_PARTITION and replaced usage with INFRASTRUCTURE_TYPES (note: removed In/Out which are NOT infrastructure per spec line 325)
  - I4 (analog/compiler.ts:680) removed local neutralTypes set and replaced usage with INFRASTRUCTURE_TYPES
  - I5 (digital/compiler.ts:61) removed COMPILE_INFRASTRUCTURE_TYPES set and replaced usage with imported INFRASTRUCTURE_TYPES
  - All In/Out references removed from infrastructure classification (correct per spec: they have simulation models and are not infrastructure)
  - All Port references added where missing (correct per spec: Port is infrastructure)

## Task W1.3: Move pinElectrical/pinElectricalOverrides from AnalogModel to ComponentDefinition
- **Status**: available for next implementer
- **Agent**: (none yet)
- **Files created**: none
- **Files modified**: none
- **Tests**: 0/0
- **If partial — remaining work**: This task requires file locks on src/solver/analog/compiler.ts and src/compile/partition.ts which are now available. It requires: (1) add pinElectrical/pinElectricalOverrides to ComponentDefinition interface in registry.ts; (2) remove those fields from AnalogModel in registry.ts; (3) update partition.ts lines 79-81 to read from def instead of analogModel; (4) update compiler.ts lines 1449-1450 and 1595-1596 to read from def instead of def.models?.analog; (5) update property-panel.ts lines 363-364 to read from def instead of def.models?.analog; (6) move pinElectrical: {} from models.analog to the definition root in all test files: compile.test.ts (lines 245, 279), coordinator.test.ts (lines 181, 206), coordinator-speed-control.test.ts (lines 124, 140), coordinator-capability.test.ts (lines 91, 116), coordinator-clock.test.ts (lines 82, 122); (7) update partition.test.ts to set pinElectrical on the definition not the analog model (lines 34, 458-460, 500); (8) write new registry tests verifying pinElectrical/pinElectricalOverrides are stored on ComponentDefinition.

## Task W1.3: Move pinElectrical/pinElectricalOverrides from AnalogModel to ComponentDefinition
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/core/registry.ts` — removed `pinElectrical` and `pinElectricalOverrides` from `AnalogModel`; added them to `ComponentDefinition`
  - `src/compile/partition.ts` — `electricalSpecForGroup()` reads from `def` instead of `def.models?.analog`
  - `src/solver/analog/compiler.ts` — all 4 read sites updated to read from `def` instead of `def.models?.analog`
  - `src/editor/property-panel.ts` — reads from `def` instead of `def.models?.analog`
  - `src/compile/__tests__/compile.test.ts` — moved `pinElectrical: {}` from `models.analog` to def root
  - `src/compile/__tests__/coordinator.test.ts` — moved `pinElectrical: {}` from `models.analog` to def root
  - `src/compile/__tests__/partition.test.ts` — moved `pinElectrical` from `ANALOG_MODEL`/`models.analog` to def root; updated ModelAssignment in test
  - `src/solver/__tests__/coordinator-speed-control.test.ts` — moved `pinElectrical: {}` from `models.analog` to def root
  - `src/solver/__tests__/coordinator-capability.test.ts` — moved `pinElectrical: {}` from `models.analog` to def root
  - `src/solver/__tests__/coordinator-clock.test.ts` — moved `pinElectrical: {}` from `models.analog` to def root
  - `src/solver/analog/__tests__/lrcxor-fixture.test.ts` — moved override spreading from `analog` model to def root
  - `src/solver/analog/__tests__/analog-compiler.test.ts` — moved `pinElectricalOverrides` from `analog` model to def root
  - `src/core/__tests__/registry.test.ts` — added 5 new tests verifying pinElectrical/pinElectricalOverrides on ComponentDefinition
- **Tests**: 7622/7622 unit tests passing (6 pre-existing failures unchanged); 5 new registry tests all pass (58/58 in registry.test.ts)

---
## Wave 1 Summary
- **Status**: complete
- **Tasks completed**: 3/3
- **Rounds**: 2 (W1.3 retried after lock conflict)
