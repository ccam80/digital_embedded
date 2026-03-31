# Implementation Progress

## Phase 1: Master 1 — Digital Logic Assertions
| Task | Status | Notes |
|------|--------|-------|
| 1.1.1 | pending | Sequential logic assertions |
| 1.1.2 | pending | CMOS model switch |

## Phase 2: Master 2 — Analog Assertions
| Task | Status | Notes |
|------|--------|-------|
| 2.1.1 | pending | DC operating point |
| 2.1.2 | pending | Modify R1 resistance |
| 2.1.3 | pending | Modify BJT BF |
| 2.1.4 | pending | Trace/scope expansion |
| 2.1.5 | pending | Pin loading |

## Phase 3: Master 3 — Mixed-Signal Assertions
| Task | Status | Notes |
|------|--------|-------|
| 3.1.1 | pending | DC operating point |
| 3.1.2 | pending | Modify Vref |
| 3.1.3 | pending | Modify R1 |
| 3.1.4 | pending | Trace/scope expansion |
| 3.1.5 | pending | Pin electrical / rOut override |

## Task 1.1.1: Sequential Logic Assertions (Phase B)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: e2e/gui/master-circuit-assembly.spec.ts
- **Tests**: 1/1 passing

## Task 1.1.2: CMOS Model Switch (Phase C)
- **Status**: partial
- **Agent**: implementer
- **Files created**: none
- **Files modified**: e2e/gui/master-circuit-assembly.spec.ts
- **Tests**: 0/1 passing
- **If partial — remaining work**:
  The test assertions are written correctly per the spec:
  1. `runViaUI()` to start simulation (required so onPropertyChange triggers recompile)
  2. `setComponentProperty('G_AND', 'Model', 'cmos')` — switches to CMOS subcircuit model
  3. `verifyNoErrors()` — checks status bar
  4. `stepToTimeViaUI('1m')` → `getAnalogState()` — reads CMOS analog state
  5. Asserts `AND_Y` voltage > 4.995V and < 5.005V (0.1% of 5V ngspice ref)

  **Blocker**: `src/solver/analog/compiler.ts` has a bug in `resolveSubcircuitModels()` (line 131).
  The function looks for the inline netlist in `runtimeModels[defName]` (from circuit.metadata),
  but the CMOS AND gate's netlist is defined inline as `entry.netlist` in the component's
  `modelRegistry` (in `src/components/gates/and.ts`). The fix is: in `resolveSubcircuitModels`,
  use `entry.netlist` directly when available (it already has the correct `MnaSubcircuitNetlist`),
  falling back to `runtimeModels[defName]` only for runtime-registered netlists.

  Fix location: `src/solver/analog/compiler.ts`, function `resolveSubcircuitModels`, line 131:
  ```
  const netlist = runtimeModels[defName];
  ```
  Should become:
  ```
  const netlist = entry.netlist ?? runtimeModels[defName];
  ```

  **Secondary issue**: The `waitForTimeout(200)` in the test is a timing dependency to allow
  the simulation to start before changing the model. A cleaner approach would add a bridge
  method to poll for EngineState.RUNNING, but this is acceptable for now.

  **Note**: `compiler.ts` was locked by task `4.4-voltage-diag` during implementation.
  Once that task completes, apply the one-line fix above, then run the test again.
