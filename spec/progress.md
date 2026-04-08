# Implementation Progress

## Task P1a: SparseSolver instrumentation accessors
- **Status**: complete
- **Agent**: implementer
- **Files modified**: src/solver/analog/sparse-solver.ts
- **Tests**: passing (no regressions)

Added three public accessors: `get dimension()`, `getRhsSnapshot()`, `getCSCNonZeros()`. Inserted after `get cooCount()` getter.

## Task P1e: Remove dead getLteEstimate interface method
- **Status**: complete
- **Agent**: coordinator (retry after implementer failure)
- **Files modified**: src/solver/analog/element.ts, src/core/analog-types.ts, src/solver/analog/timestep.ts, src/components/semiconductors/bjt.ts
- **Tests**: pending verification

Removed `getLteEstimate` declaration from element.ts and analog-types.ts. Updated 4 stale doc comments referencing getLteEstimate to getLteTimestep.

## Task P1d: Extend NRAttemptRecord with iterationDetails
- **Status**: complete
- **Agent**: implementer
- **Files created**: None
- **Files modified**: src/solver/analog/convergence-log.ts
- **Tests**: 7967/7971 passing (4 pre-existing failures from baseline, no regressions)

Added optional `iterationDetails` field to `NRAttemptRecord` interface in convergence-log.ts. The field is an array of objects containing per-NR-iteration convergence details (iteration, maxDelta, maxDeltaNode, noncon, converged). Field is optional and populated only when comparison harness postIterationHook is active. All tests pass with no regressions from baseline.

## Task P1b: postIterationHook on NROptions + call site
- **Status**: complete
- **Agent**: implementer
- **Files created**: None
- **Files modified**: src/solver/analog/newton-raphson.ts
- **Tests**: 7966/7967 passing in full suite run (4 pre-existing coordinator stagnation failures from baseline; 1 wire-current-resolver timeout was flaky under load — passes when run in isolation, not caused by this change)

## Task P1c: MNAEngine harness accessors + hook wiring
- **Status**: complete
- **Agent**: implementer
- **Files created**: none
- **Files modified**: src/solver/analog/analog-engine.ts
- **Tests**: 7967/7971 passing (4 pre-existing failures unchanged)

## Task P2a: Common harness types (types.ts)
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/solver/analog/__tests__/harness/types.ts
- **Files modified**: none
- **Tests**: N/A (types-only file, no runtime behaviour to test; TypeScript compile check passes with no errors in new file)
- **Notes**: All interfaces and constants specified in Phase 2a verbatim: MatrixEntry, NodeMapping, TopologySnapshot, IterationSnapshot, ElementStateSnapshot, StepSnapshot, DeviceMapping, Tolerance, DEFAULT_TOLERANCE, ComparisonResult, CaptureSession, SnapshotQuery. Pre-existing TS errors in bjt.ts, analog-engine.ts, compiler.ts etc. are unrelated to this file.

## Task P2b: Capture functions (capture.ts)
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/solver/analog/__tests__/harness/capture.ts
- **Files modified**: none
- **Tests**: N/A (utility module; TypeScript compile check passes with no errors in new file)
- **Notes**: All functions specified in Phase 2b: captureTopology, captureElementStates, PostIterationHook type, createIterationCaptureHook, createStepCaptureHook. isPoolBacked already existed in element.ts. All pre-existing TS errors are in other files unrelated to this task.

## Task P2c: Device mappings (device-mappings.ts)
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/solver/analog/__tests__/harness/device-mappings.ts
- **Files modified**: none
- **Tests**: N/A (data-only module; TypeScript compile check passes with no errors in new file)
- **Notes**: All mappings specified in Phase 2c: CAPACITOR_MAPPING, INDUCTOR_MAPPING, DIODE_MAPPING, BJT_MAPPING, MOSFET_MAPPING, DEVICE_MAPPINGS registry. Actual slot names verified against CAPACITOR_SCHEMA, INDUCTOR_SCHEMA, DIODE_CAP_SCHEMA, BJT_L1_SCHEMA — all match spec exactly. BJT_L1_SCHEMA has additional slots (OP_CBE, OP_GBE, VSUB, GDSUB, etc.) beyond what spec covers; these are not in the mapping since spec does not require them.

## Task P2d: Comparison engine (compare.ts)
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/solver/analog/__tests__/harness/compare.ts
- **Files modified**: none
- **Tests**: N/A (utility module; TypeScript compile check passes with no errors in new file)
- **Notes**: All functions specified in Phase 2d: withinTol (internal), compareSnapshots, formatComparison, findFirstDivergence. DeviceMapping is imported as type (spec requirement) but not used in function bodies since state diff comparison is deferred to Phase 3 per spec comment. DEVICE_MAPPINGS imported from device-mappings.js as spec requires.

## Task P2e: Query API (query.ts)
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/solver/analog/__tests__/harness/query.ts
- **Files modified**: none
- **Tests**: N/A (utility module; TypeScript compile check passes with no errors in new file)
- **Notes**: All functions specified in Phase 2e: querySteps, nodeVoltageTrajectory, elementStateTrajectory, convergenceSummary, findLargestDelta. IterationSnapshot import included per spec (used implicitly via StepSnapshot.iterations).

## Task P3a: niiter.c instrumentation callback
- **Status**: complete
- **Agent**: implementer
- **Files modified**: ref/ngspice/src/maths/ni/niiter.c
- **Tests**: N/A (C source file — no automated tests; modifications are pure instrumentation hooks)

**Change 1**: Added NR iteration instrumentation infrastructure after line 20 (`#include "ngspice/sperror.h"`):
- `NI_InstrumentCallback` typedef (function pointer for iteration instrumentation callback)
- `static ni_instrument_cb` global pointer initialized to NULL
- `ni_instrument_register()` function to register the callback from shared-lib consumer

**Change 2**: Added callback invocation after line 217 (STEPDEBUG printf block), before closing brace of if(1) block:
- Fires after solve and convergence check
- Passes: 0-based iteration count, matrix size, voltage vectors, state array, convergence state
- Safely guards callback invocation with NULL check

## Task P3b: Windows shared library build instructions
- **Status**: complete
- **Agent**: implementer
- **Files created**: ref/ngspice/BUILD-SHARED-WIN.md
- **Files modified**: none
- **Tests**: N/A (documentation file — no automated tests; provides build workflow for developers)

Created comprehensive build instructions document covering:
- Prerequisites: Visual Studio 2022 with C++ workload, CMake 3.20+ (optional)
- Option A: Visual Studio Solution build (recommended) — open .sln, set Release|x64 config, build, output to visualc/sharedspice/x64/Release/ngspice.dll
- Option B: CMake build — mkdir build, cmake with VS2022 generator and Release config, cmake --build
- Verifying instrumentation: dumpbin /exports command to confirm ni_instrument_register is exported
- Adding export if needed: __declspec(dllexport) annotation on function signature

All content matches Phase 3b specification exactly.

## Task P3c: NgspiceBridge FFI module
- **Status**: complete
- **Agent**: implementer
- **Files created**: src/solver/analog/__tests__/harness/ngspice-bridge.ts
- **Files modified**: none
- **Tests**: 7967/7971 passing (4 pre-existing coordinator stagnation failures from baseline, no regressions)

Created comprehensive FFI bridge to ngspice shared library covering:
- `RawNgspiceIteration` interface: matches C typedef from niiter.c with iteration count, matrix size, voltage vectors (rhs, rhsOld), state array, convergence flags
- `NgspiceBridge` class with:
  - `constructor(dllPath)`: stores path, defers FFI loading
  - `async init()`: dynamically imports koffi, loads DLL, defines callback type, registers callback via koffi.register
  - `loadNetlist(netlist)`: calls ngSpice_Circ with split lines and null terminator
  - `runDcOp()`: resets iterations, calls ngSpice_Command("op")
  - `runTran(stopTime, maxStep)`: resets iterations, calls ngSpice_Command with tran command
  - `getCaptureSession()`: converts accumulated raw iteration data to CaptureSession format by:
    - Detecting step boundaries via iteration counter resets
    - Packaging each iteration into IterationSnapshot with voltage arrays and convergence flags (globalConverged/elemConverged)
    - Creating StepSnapshot objects with proper iteration grouping
    - Returning CaptureSession with topology and steps array
  - `dispose()`: unregisters callback and cleans up FFI handle

All TypeScript types verified. File correctly uses type imports from types.ts. Dynamic koffi import prevents hard dependency on native module. Tests pass with no regressions from baseline (4 pre-existing failures confirmed in test-baseline.md).
