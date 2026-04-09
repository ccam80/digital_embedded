# Implementation Progress

## Task S1-B: comparison-session.ts fixes: DC OP doc (Item 13) + __dirname fix (Item 14)
- **Status**: complete
- **Agent**: implementer
- **Files modified**: src/solver/analog/__tests__/harness/comparison-session.ts
- **Changes**:
  - **Item 13**: Added comprehensive doc comment to `runDcOp()` method (lines 182-189) explaining the two-pass DC OP approach: first pass during compile() without capture hook, second pass with capture hook wired to collect per-iteration data
  - **Item 14**: Replaced `const ROOT = resolve(__dirname, "../../../../..")` with `const ROOT = process.cwd()` on line 71 to fix ESM compatibility (undefined __dirname under Vitest)
- **Tests**: No new tests required — documentation and path resolution fix only
- **Verification**: Changes are syntactically correct and follow the spec exactly. File imports remain valid, path resolution now uses process.cwd() which is guaranteed to be the project root by vitest.config.ts

## Task S1-A: BJT Companion Current Mapping (Item 5) + Netlist Generator (Item 12)
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/solver/analog/__tests__/harness/netlist-generator.ts, src/solver/analog/__tests__/harness/netlist-generator.test.ts
- **Files modified**: src/solver/analog/__tests__/harness/device-mappings.ts
- **Tests**: 28/28 passing

## Task S1-C: Engine instrumentation across 4 independent files
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: 
  - `src/solver/analog/sparse-solver.ts` (Item 6: added `_preSolveRhs`, `_capturePreSolveRhs` fields; `enablePreSolveRhsCapture()` and `getPreSolveRhsSnapshot()` methods; capture logic in `finalize()`)
  - `src/solver/analog/integration.ts` (Item 7: added `computeIntegrationCoefficients()` export function)
  - `src/solver/analog/mna-assembler.ts` (Item 8: added `checkAllConvergedDetailed()` method)
  - `src/solver/analog/analog-engine.ts` (supporting: added `get integrationOrder()` getter used by coordinator)
  - `src/solver/coordinator.ts` (Item 15: added `_analysisPhase` field, `get analysisPhase()` getter, set phase at `dcOperatingPoint()`, `step()` tranInit start, and tranFloat after order-2 promotion)
  - `src/solver/analog/__tests__/sparse-solver.test.ts` (Item 6 tests: 4 tests for pre-solve RHS capture)
  - `src/solver/analog/__tests__/integration.test.ts` (Item 7 tests: 6 tests for computeIntegrationCoefficients)
  - `src/solver/analog/__tests__/mna-assembler.test.ts` (Item 8 tests: 4 tests for checkAllConvergedDetailed)
  - `src/compile/__tests__/coordinator.test.ts` (Item 15 tests: 4 tests for analysisPhase transitions)
- **Tests**: 8048/8052 passing (4 pre-existing failures from baseline, no regressions)

## Task S1-F: niiter.c struct-based callback (C Callback Extension Summary)
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: ref/ngspice/src/maths/ni/niiter.c
- **Tests**: 0/0 (no automated tests — C source file, no test infrastructure per spec)
- **Changes**:
  - Replaced flat `NI_InstrumentCallback` typedef with `NiIterationData` struct + `ni_instrument_cb_v2` typedef
  - Added local `NiMatrixElement` and `NiMatrixFrame` mirror structs for CSC matrix traversal (avoids including spdefs.h which undefines MALLOC/FREE/REALLOC)
  - Updated static `ni_instrument_cb` pointer and `ni_instrument_register()` to use v2 type
  - Callback invocation site: allocates CSC arrays via column list traversal, populates full `NiIterationData` struct (state0/1/2, ag0/ag1, integrateMethod, order, matrix CSC, simTime, dt, cktMode), calls callback with `&ni_data`, frees temporary arrays
  - Convergence/limiting fields (devConvFailed, limitDevIdx, etc.) initialized to NULL/0 per spec — more invasive hooks deferred per spec note

## Task S1-D: All types.ts additions from Items 2,3,6,7,8,9,10,15
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**:
  - `src/solver/analog/__tests__/harness/types.ts` — all type changes per Items 2,3,6,7,8,9,10,15
  - `src/solver/analog/__tests__/harness/capture.ts` — updated to use new types (state1/state2Slots, preSolveRhs required, LimitingEvent, IntegrationCoefficients, matrixRowLabels/matrixColLabels)
  - `src/solver/analog/__tests__/harness/compare.ts` — switched rhs→preSolveRhs
  - `src/solver/analog/__tests__/harness/comparison-session.ts` — switched rhs→preSolveRhs, updated finalizeStep calls with new required args
  - `src/solver/analog/__tests__/harness/node-mapping.ts` — removed rhs, updated preSolveRhs usage
  - `src/solver/analog/__tests__/harness/ngspice-bridge.ts` — updated IterationSnapshot construction, added matrixRowLabels/matrixColLabels to topology, added integrationCoefficients/analysisPhase to steps, added helper functions
  - `src/solver/analog/__tests__/harness/harness-integration.test.ts` — updated rhs→preSolveRhs, hook signatures, finalizeStep calls, TopologySnapshot literal
  - `src/solver/analog/analog-engine.ts` — updated postIterationHook type to include limitingEvents/convergenceFailedElements params
  - `src/solver/analog/dc-operating-point.ts` — updated postIterationHook type to include new params
  - `src/solver/analog/__tests__/buckbjt-nr-probe.test.ts` — switched rhs→preSolveRhs
- **Tests**: 8048/8052 passing (4 pre-existing failures, 0 new failures)
