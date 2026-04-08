# Phase 2: Harness TypeScript Modules

Full specification with exact file contents: `docs/harness-implementation-spec.md` § Phase 2

All files are NEW and live under `src/solver/analog/__tests__/harness/`.

## Task P2a: Common harness types (`types.ts`)

**File:** `src/solver/analog/__tests__/harness/types.ts` (NEW)

Create the common type definitions file. Contains:
- `MatrixEntry` interface
- `NodeMapping` interface
- `TopologySnapshot` interface
- `IterationSnapshot` interface
- `ElementStateSnapshot` interface
- `StepSnapshot` interface
- `DeviceMapping` interface
- `Tolerance` interface + `DEFAULT_TOLERANCE` constant
- `ComparisonResult` interface
- `CaptureSession` interface
- `SnapshotQuery` interface

See spec Phase 2a for the complete file contents. Copy the entire TypeScript block verbatim.

## Task P2b: Capture functions (`capture.ts`)

**File:** `src/solver/analog/__tests__/harness/capture.ts` (NEW)

Create capture functions that read engine internal state into the common snapshot format. Contains:
- `captureTopology(compiled)` — once per compile
- `captureElementStates(elements, statePool)` — per iteration
- `createIterationCaptureHook(solver, elements, statePool)` — returns hook + getSnapshots + clear
- `createStepCaptureHook(solver, elements, statePool)` — step-level wrapper

Imports from: `../../sparse-solver.js`, `../../element.js` (including `isPoolBacked`), `../../state-pool.js`, `../../compiled-analog-circuit.js`, `./types.js`

See spec Phase 2b for the complete file contents.

**IMPORTANT:** The import `isPoolBacked` from `../../element.js` may not exist yet. If it doesn't exist, you must create it. `isPoolBacked(el)` should return true if the element has `stateSchema` and `stateBaseOffset >= 0`. Check `src/solver/analog/element.ts` for the current state and add the function if missing.

## Task P2c: Device mappings (`device-mappings.ts`)

**File:** `src/solver/analog/__tests__/harness/device-mappings.ts` (NEW)

Create hand-written device mappings from our state-pool slot names to ngspice CKTstate0 offsets. Contains mappings for:
- `CAPACITOR_MAPPING`
- `INDUCTOR_MAPPING`
- `DIODE_MAPPING`
- `BJT_MAPPING`
- `MOSFET_MAPPING` (placeholder)
- `DEVICE_MAPPINGS` registry object

See spec Phase 2c for the complete file contents.

**IMPORTANT:** Before creating, verify the actual slot names in our schemas match what the spec expects. Check `CAPACITOR_SCHEMA` in `src/components/passives/capacitor.ts`, `INDUCTOR_SCHEMA` in `src/components/passives/inductor.ts`, `DIODE_CAP_SCHEMA` in `src/components/semiconductors/diode.ts`, and `BJT_L1_SCHEMA` in `src/components/semiconductors/bjt.ts`. If slot names differ from the spec, use the ACTUAL slot names from the codebase.

## Task P2d: Comparison engine (`compare.ts`)

**File:** `src/solver/analog/__tests__/harness/compare.ts` (NEW)

Create the comparison engine that diffs two CaptureSession objects. Contains:
- `withinTol(ours, theirs, absTol, relTol)` — tolerance check helper
- `compareSnapshots(ours, ref, tolerance?)` — main comparison function
- `formatComparison(result)` — human-readable diff output
- `findFirstDivergence(results, threshold?)` — locate first deviation

See spec Phase 2d for the complete file contents.

## Task P2e: Query API (`query.ts`)

**File:** `src/solver/analog/__tests__/harness/query.ts` (NEW)

Create filtering/projection/aggregation over captured snapshots. Contains:
- `querySteps(session, query)` — filter steps by predicates
- `nodeVoltageTrajectory(session, nodeIndex)` — voltage time series
- `elementStateTrajectory(session, elementLabel, slotName)` — state slot time series
- `convergenceSummary(session)` — aggregate convergence stats
- `findLargestDelta(session, nodeIndex)` — identify worst convergence point

See spec Phase 2e for the complete file contents.
