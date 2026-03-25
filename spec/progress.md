# Unified Component Architecture — Progress

## Phase 0: Complete node identity and current readout

| Task | Title | Complexity | Status |
|------|-------|------------|--------|
| P0-1 | Rename nodeIndices → pinNodeIds, add allNodeIds | M | complete |
| P0-2 | Update all consumers (getElementPower, getElementPinCurrents, detectWeakNodes, etc.) | M | complete |
| P0-3 | Make getPinCurrents mandatory on AnalogElement | S | complete |
| P0-4 | Remove getCurrent from AnalogElement interface | S | complete |
| P0-5 | Remove engine fallback cascade (getElementPinCurrents and getElementPower) | M | complete |
| P0-6 | Run full test suite, verify green | S | complete |

## Phase 1: models bag on ComponentDefinition

| Task | Title | Complexity | Status |
|------|-------|------------|--------|
| P1-1 | Define DigitalModel, AnalogModel, ComponentModels types | S | complete |
| P1-2 | Add optional models field to ComponentDefinition | S | complete |
| P1-3 | Auto-populate models from flat fields in register() | M | complete |
| P1-4 | Add hasDigitalModel(), hasAnalogModel(), availableModels() utilities | S | complete |
| P1-5 | Migrate getByEngineType() internals to use models presence | M | complete |
| P1-6 | Run full test suite, verify green | S | complete |

## Task P1-1: Define DigitalModel, AnalogModel, ComponentModels types
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/core/registry.ts, src/core/__tests__/registry.test.ts
- **Tests**: 43/43 passing (16 new tests added across P1-1 through P1-5)

## Task P1-2: Add optional models field to ComponentDefinition
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/core/registry.ts
- **Tests**: 43/43 passing

## Task P1-3: Auto-populate models from flat fields in register()
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/core/registry.ts
- **Tests**: 43/43 passing

## Task P1-4: Add hasDigitalModel(), hasAnalogModel(), availableModels() utilities
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/core/registry.ts, src/core/__tests__/registry.test.ts
- **Tests**: 43/43 passing

## Task P1-5: Migrate getByEngineType() internals to use models presence
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/core/registry.ts, src/core/__tests__/registry.test.ts
- **Tests**: 43/43 passing; full suite 7402/7402 passing (327 test files)

## Task P0-3: Make getPinCurrents mandatory on AnalogElement
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/analog/element.ts
- **Tests**: 7402/7402 passing

## Task P0-4: Remove getCurrent from AnalogElement interface and implementations
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/analog/element.ts, src/components/passives/resistor.ts, src/components/passives/capacitor.ts, src/analog/test-elements.ts (removed getCurrent, added getPinCurrents), src/analog/controlled-source-base.ts (added abstract getPinCurrents), src/analog/behavioral-remaining.ts (added getPinCurrents to SegmentDiodeElement), src/components/semiconductors/varactor.ts (added getPinCurrents), src/components/passives/transmission-line.ts (added allNodeIds + getPinCurrents to all segment classes), src/components/io/clock.ts (added getPinCurrents to createAnalogClockElement), src/analog/dc-operating-point.ts (added allNodeIds + getPinCurrents to makeGminShunt), src/analog/compiler.ts (added allNodeIds + getPinCurrents to makeVddSource)
- **Tests**: 7402/7402 passing

## Task P0-5: Remove engine fallback cascade in getElementPinCurrents and getElementPower
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/analog/analog-engine.ts (simplified getElementCurrent, getElementPinCurrents, getElementPower), src/core/analog-engine-interface.ts (updated getElementPinCurrents return type to number[]), src/editor/wire-current-resolver.ts (removed null check, removed fallback branch), src/editor/__tests__/wire-current-resolver.test.ts (updated mock to return [I, -I] instead of null)
- **Tests**: 7402/7402 passing

---
## Wave 0.1 Summary (Phase 0)
- **Status**: complete
- **Tasks completed**: 6/6
- **Rounds**: 2 (P0-1/P0-2 in round 1, P0-3/P0-4/P0-5 in round 2)

---
## Wave 1.1 Summary (Phase 1)
- **Status**: complete
- **Tasks completed**: 6/6
- **Rounds**: 1

## Task P2-A: Update all consumers to read from models bag + make flat fields optional
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/core/registry.ts` — made `executeFn` optional; updated `_ensureModels` to patch `models.analog` when flat analog override fields (pinElectrical, pinElectricalOverrides, transistorModel) are present on an already-models-populated def; made `update()` call `_ensureModels`
  - `src/engine/compiler.ts` — updated all flat field reads: `def.inputSchema`→`def.models?.digital?.inputSchema`, `def.outputSchema`→`def.models?.digital?.outputSchema`, `def.stateSlotCount`→`def.models?.digital?.stateSlotCount`, `def.executeFn`→`def.models!.digital!.executeFn`, `def.sampleFn`→`def.models!.digital!.sampleFn`, `def.switchPins`→`def.models?.digital?.switchPins`, `def.defaultDelay`→`def.models?.digital?.defaultDelay`; removed unused `ComponentDefinition` import
  - `src/analog/compiler.ts` — updated all flat field reads: `def.transistorModel`→`def.models?.analog?.transistorModel`, `def.requiresBranchRow`→`def.models?.analog?.requiresBranchRow`, `def.getInternalNodeCount`→`def.models?.analog?.getInternalNodeCount`, `def.analogFactory`→`def.models?.analog?.factory` / `def.models!.analog!.factory`, `def.pinElectricalOverrides`→`def.models?.analog?.pinElectricalOverrides`, `def.pinElectrical`→`def.models?.analog?.pinElectrical`, `def.analogDeviceType`→`def.models?.analog?.deviceType` / `def.models!.analog!.deviceType`
  - `src/engine/worker.ts` — updated `def.executeFn`→`def.models!.digital!.executeFn`, `def.sampleFn`→`def.models?.digital?.sampleFn`
  - `src/engine/delay.ts` — updated `def.defaultDelay`→`def.models?.digital?.defaultDelay`
  - `src/analog/__tests__/analog-compiler.test.ts` — updated test setup to use `registry.update()` instead of direct object mutation, so `_ensureModels` is called and `models.analog.transistorModel` is set correctly
- **Tests**: 7402/7402 passing

## Task P2-E: Migrate switching/pld/misc/term/gfx + passives/semiconductors/sources/sensors/active/subcircuit/library-74xx
- **Status**: complete
- **Agent**: implementer
- **Files modified**:
  - src/components/passives/resistor.ts
  - src/components/passives/capacitor.ts
  - src/components/passives/inductor.ts
  - src/components/passives/polarized-cap.ts
  - src/components/passives/potentiometer.ts
  - src/components/passives/crystal.ts
  - src/components/passives/memristor.ts
  - src/components/passives/transformer.ts
  - src/components/passives/tapped-transformer.ts
  - src/components/passives/transmission-line.ts
  - src/components/semiconductors/diode.ts
  - src/components/semiconductors/zener.ts
  - src/components/semiconductors/tunnel-diode.ts
  - src/components/semiconductors/scr.ts
  - src/components/semiconductors/triac.ts
  - src/components/semiconductors/diac.ts
  - src/components/semiconductors/bjt.ts
  - src/components/semiconductors/mosfet.ts
  - src/components/semiconductors/njfet.ts
  - src/components/semiconductors/pjfet.ts
  - src/components/semiconductors/triode.ts
  - src/components/semiconductors/varactor.ts
  - src/components/sources/dc-voltage-source.ts
  - src/components/sources/ac-voltage-source.ts
  - src/components/sources/current-source.ts
  - src/components/sources/variable-rail.ts
  - src/components/sensors/ldr.ts
  - src/components/sensors/ntc-thermistor.ts
  - src/components/sensors/spark-gap.ts
  - src/components/active/opamp.ts
  - src/components/active/real-opamp.ts
  - src/components/active/ota.ts
  - src/components/active/comparator.ts
  - src/components/active/schmitt-trigger.ts
  - src/components/active/vcvs.ts
  - src/components/active/vccs.ts
  - src/components/active/ccvs.ts
  - src/components/active/cccs.ts
  - src/components/active/dac.ts
  - src/components/active/adc.ts
  - src/components/active/timer-555.ts
  - src/components/active/analog-switch.ts
  - src/components/active/optocoupler.ts
  - src/components/subcircuit/subcircuit.ts
  - src/components/library-74xx.ts
  - (plus 44 test files updated to use models.analog.factory, models.analog.deviceType, models.analog.requiresBranchRow, models.analog.getInternalNodeCount)
- **Tests**: 477/477 passing (46 test files in P2-E scope); 31 other test files still failing (P2-B/C/D scope, not caused by P2-E)

## Task batch-fix-test-files-A: Fix failing test files — Batch A
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - src/components/io/__tests__/button.test.ts
  - src/components/io/__tests__/button-led.test.ts
  - src/components/io/__tests__/dip-switch.test.ts
  - src/components/io/__tests__/power-supply.test.ts
  - src/components/io/__tests__/probe.test.ts
  - src/components/io/__tests__/rotary-encoder-motor.test.ts
  - src/components/io/__tests__/scope.test.ts
  - src/components/memory/__tests__/eeprom.test.ts
  - src/components/memory/__tests__/lookup-table.test.ts
  - src/components/memory/__tests__/program-counter.test.ts
  - src/components/memory/__tests__/program-memory.test.ts
  - src/components/memory/__tests__/rom.test.ts
  - src/components/memory/__tests__/two-phase-memory.test.ts
  - src/analog/__tests__/behavioral-combinational.test.ts
  - src/analog/__tests__/behavioral-sequential.test.ts
- **Tests**: 934/934 passing

## Task batch-b-fix: Fix Failing Test Files — Batch B
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - src/components/switching/__tests__/fuse.test.ts
  - src/components/switching/__tests__/relay.test.ts
  - src/components/switching/__tests__/fets.test.ts
  - src/components/switching/__tests__/switches.test.ts
  - src/analog/__tests__/digital-bridge-path.test.ts
  - src/engine/__tests__/mixed-partition.test.ts (source file — fixed detectEngineMode and partitionMixedCircuit to use hasDigitalModel/hasAnalogModel instead of def.engineType)
  - src/headless/__tests__/stress-test-regressions.test.ts
  - src/io/__tests__/subcircuit-loader.test.ts
  - src/engine/mixed-partition.ts (source fix required — def.engineType no longer set on Resistor/DcVoltageSource which use models directly)
- **Tests**: 240/240 passing (all 8 targeted files)
- **Notes**: The mixed-partition.ts source file was also modified because detectEngineMode used def.engineType which is not set on definitions that use models directly (e.g. Resistor). The src/io/__tests__/resolve-generics.test.ts and dig-parser.test.ts failures are pre-existing ENOENT failures caused by missing git submodule (ref/Digital not initialized) — unrelated to these changes.

## Phase 2: Migrate component definitions

| Task | Title | Complexity | Status |
|------|-------|------------|--------|
| P2-1 | Mechanically rewrite each definition to use models bag | L | complete |
| P2-2 | Remove noOpAnalogExecuteFn from production definitions | S | complete |
| P2-3 | Mark flat fields deprecated on ComponentDefinition interface | M | complete |
| P2-4 | Retain _ensureModels shim for test backwards compat | S | complete |
| P2-5 | Remove engineType from production definitions | S | complete |
| P2-6 | Add defaultModel to multi-model components | S | complete |
| P2-7 | Full test suite verification | S | complete |

---
## Wave 2.1 Summary (Phase 2)
- **Status**: complete
- **Tasks completed**: 1/1 (P2-A: update consumers + make executeFn optional)
- **Rounds**: 1

---
## Wave 2.2 Summary (Phase 2)
- **Status**: complete
- **Tasks completed**: 4/4 (migrate all ~140 component definitions + fix analog compiler + fix 31 test files)
- **Rounds**: 3 (initial 4 parallel implementers, then 2 parallel test fix agents)

---
## Wave 2.3 Summary (Phase 2)
- **Status**: complete
- **Tasks completed**: cleanup (mark flat fields deprecated, fix darlington, fix mixed-partition)
- **Rounds**: 2

---
## Phase 2 Summary
- **Status**: complete
- **Test result**: 7405/7409 passing (4 pre-existing failures from missing git submodule)
- **Files changed**: ~290 files across 3 commits
- **Key decisions**:
  - Flat fields retained as @deprecated on ComponentDefinition for test backwards compat
  - _ensureModels shim retained — test code creates ~105 inline definitions with flat fields
  - noOpAnalogExecuteFn retained as @deprecated export (1 test file still imports it)
  - expandTransistorModel still reads flat def.transistorModel (consumer update deferred)
  - Analog compiler now derives component capabilities from models presence, not engineType
