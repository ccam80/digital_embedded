# Unified Component Architecture — Progress

## Phase 0: Complete node identity and current readout

| Task | Title | Complexity | Status |
|------|-------|------------|--------|
| P0-1 | Rename nodeIndices → pinNodeIds, add allNodeIds | M | complete |
| P0-2 | Update all consumers (getElementPower, getElementPinCurrents, detectWeakNodes, etc.) | M | complete |
| P0-3 | Make getPinCurrents mandatory on AnalogElement | S | pending |
| P0-4 | Remove getCurrent from AnalogElement interface | S | pending |
| P0-5 | Remove engine fallback cascade (getElementPinCurrents and getElementPower) | M | pending |
| P0-6 | Run full test suite, verify green | S | pending |

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
