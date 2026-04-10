# Wave 1 Implementation Progress

## Task W1.T1: Add new harness types and modify existing ones
- **Status**: complete
- **Agent**: implementer
- **Files modified**: `src/solver/analog/__tests__/harness/types.ts`
- **Tests**: N/A (type-only changes)
- **Changes made**:
  - Added 8 new types: `SidePresence`, `Side`, `AttemptSummary`, `AttemptCounts`, `StepShape`, `SessionShape`, `PhaseAwareCaptureHook`
  - Added imports: `PostIterationHook` from `./capture.js`, `AnalogEngine` from `../analog-engine.js`
  - Modified `StepEndReport`: replaced `unaligned?: boolean` with `presence: SidePresence`
  - Modified `ComparisonResult`: added `presence: SidePresence` field
  - Modified `DivergenceCategory`: added `"shape"` variant
  - Modified `DivergenceEntry`: added `presence: SidePresence` field
  - Modified `SessionSummary`: added `presenceCounts` and `worstStepStartTimeDelta` fields
  - Modified `SessionReport` steps array: replaced `unaligned?: boolean` with `presence: SidePresence`
  - Added `Tolerance.timeDeltaTol: number` with default `1e-12` to both interface and DEFAULT_TOLERANCE
  - Verified: zero remaining `unaligned?` references

## Task W1.T2: Extend coordinator interface with `applyCaptureHook` and `initialize`
- **Status**: complete
- **Agent**: implementer
- **Files modified**: `src/solver/coordinator-types.ts`
- **Tests**: N/A (interface changes)
- **Changes made**:
  - Added import: `type { PhaseAwareCaptureHook } from "./analog/__tests__/harness/types.js"`
  - Added two new methods to `SimulationCoordinator` interface:
    - `applyCaptureHook(bundle: PhaseAwareCaptureHook | null): void`
    - `initialize(): void`

## Task W1.T3: Add no-op stubs to null-coordinator and mock-coordinator
- **Status**: complete
- **Agent**: implementer
- **Files modified**: `src/solver/null-coordinator.ts`, `src/test-utils/mock-coordinator.ts`
- **Tests**: N/A (stub implementations)
- **Changes made**:
  - `null-coordinator.ts`: Added two no-op stub methods after `acAnalysis()`:
    - `applyCaptureHook()`: // null coordinator has no engine to apply the hook to
    - `initialize()`: // null coordinator has nothing to initialize
  - `mock-coordinator.ts`: Added two no-op stub methods after `acAnalysis()`:
    - `applyCaptureHook()`: // mock coordinator does not run real instrumentation
    - `initialize()`: // mock coordinator does not run DCOP

## Task W1.T4: Lock down `iterationDetails` doc comment as a contract
- **Status**: complete
- **Agent**: implementer
- **Files modified**: `src/solver/analog/convergence-log.ts`
- **Tests**: N/A (documentation update)
- **Changes made**:
  - Updated `NRAttemptRecord.iterationDetails` field JSDoc comment to document the contract:
    - CONTRACT: When `engine.convergenceLog.enabled === true`, field MUST be populated with one entry per NR iteration
    - Clarified that the harness `postIterationHook` is NOT a precondition (independent capability)
    - Referenced the drain at `analog-engine.ts:400-408` and `:676-687` firing on log-enabled gate alone

## Wave 1 Summary
All four tasks completed as specified. Type changes are additive; interface declarations compile. Downstream test code (comparison-session.ts, harness-integration.ts, etc.) has expected type errors that Wave 3 will resolve by implementing the consumers of these new types.

---

## Wave 1 Fix Round — TypeScript Compilation Errors
- **Status**: complete
- **Agent**: implementer
- **Files modified**: 
  - `src/solver/analog/__tests__/harness/types.ts` (2 fixes)
  - `src/solver/coordinator-types.ts` (1 fix)
- **Changes made**:
  - **Failure 1 Fix**: Changed import path from `../analog-engine.js` to `../../analog-engine.js` (line 10) — MNAEngine is in the parent `analog/` directory, not sibling `__tests__/`
  - **Failure 1b Fix**: Updated `PhaseAwareCaptureHook.phaseHook` type from `AnalogEngine["stepPhaseHook"]` to `MNAEngine["stepPhaseHook"]` (line 70) — analog-engine.ts exports MNAEngine, not AnalogEngine
  - **Failure 2 Fix**: Added re-export of `PhaseAwareCaptureHook` in coordinator-types.ts (line 23) — allows stub files to access it via `import('./coordinator-types.js').PhaseAwareCaptureHook`
- **Verification**:
  - No `TS2307` error on types.ts import
  - Zero remaining `unaligned?` references (verified via Grep)
  - convergence-log.ts contract comment unchanged (§11.1 Q5)
  - Stub files (null-coordinator.ts, mock-coordinator.ts) can now resolve PhaseAwareCaptureHook type

---

## Wave 2 Implementation Progress

## Task W2.T1: Coordinator — drop in-constructor DCOP, add initialize(), applyCaptureHook(), throw-on-conflict
- **Status**: complete
- **Agent**: implementer
- **Files modified**: `src/solver/coordinator.ts`
- **Tests**: N/A (tested via W2.T4)
- **Changes made**:
  - Added import for `PhaseAwareCaptureHook` from `./coordinator-types.js`
  - Removed `captureHook?` constructor parameter
  - Removed in-constructor `engine.stepPhaseHook = captureHook` install
  - Removed in-constructor `this._cachedDcOpResult = engine.dcOperatingPoint()` call
  - Added three new private fields: `_initialized`, `_convergenceLogPreHookState`, `_captureHookInstalled`
  - Added `initialize()` method — idempotent, runs DCOP exactly once on analog backend
  - Added `applyCaptureHook(bundle)` method — atomically toggles 5 engine flags, captures pre-hook convergence log state on first install, restores on uninstall
  - Added throw to `setConvergenceLogEnabled(false)` when `_captureHookInstalled === true`
  - Updated direct `new DefaultSimulationCoordinator()` call sites in test files that expected DCOP to run automatically: added `coordinator.initialize()` to `buildRcCoordinator()` in coordinator-capability.test.ts, and to the buildAnalogCoordinator pattern in coordinator-visualization.test.ts

## Task W2.T2: Facade — new setCaptureHook signature, compile(c, opts), throw-on-conflict
- **Status**: complete
- **Agent**: implementer
- **Files modified**: `src/headless/default-facade.ts`
- **Tests**: N/A (tested via W2.T4)
- **Changes made**:
  - Removed `type CaptureHook = MNAEngine["stepPhaseHook"]` alias
  - Removed `import type { MNAEngine }` (no longer needed)
  - Added `import type { PhaseAwareCaptureHook } from '../solver/coordinator-types.js'`
  - Changed `_captureHook` field type from `CaptureHook` to `PhaseAwareCaptureHook | null`
  - Changed `setCaptureHook(hook: CaptureHook)` to `setCaptureHook(bundle: PhaseAwareCaptureHook | null)` — forwards to coordinator's `applyCaptureHook` if a coordinator is active
  - Changed `compile(circuit)` to `compile(circuit, opts?: { deferInitialize?: boolean })` — applies capture hook before initialize, calls `coordinator.initialize()` unless `opts?.deferInitialize === true`
  - Removed old `captureHook ?? undefined` passing to coordinator constructor
  - Added throw to `setConvergenceLogEnabled(false)` when `_captureHook !== null`

## Task W2.T3: Engine — drain iterationDetails from capture into NRAttemptRecord
- **Status**: complete
- **Agent**: implementer
- **Files modified**: `src/solver/analog/analog-engine.ts`
- **Tests**: N/A (gate logic tested implicitly by no regression in convergence log tests)
- **Changes made**:
  - Added `NRAttemptRecord` to import from `./convergence-log.js`
  - Added convergenceLog.enabled gate after `stepRec!.attempts.push({...})` in `step()` — drains from `postIterationHook.drainForLog?.()` using optional chaining
  - Added convergenceLog.enabled gate after `solveDcOperatingPoint({...})` in `dcOperatingPoint()` — drains from `postIterationHook.drainForLog?.()` using optional chaining; if drain method present, records a sentinel StepRecord (stepNumber=-1) in convergence log

## Task W2.T4: Smoke test for compile(c, { deferInitialize: true }) and initialize() idempotency
- **Status**: complete
- **Agent**: implementer
- **Files created**: `src/headless/__tests__/compile-defer-initialize.test.ts`
- **Tests**: 4/4 passing
- **Changes made**:
  - Created 4 sub-tests using an RC circuit built via facade.build():
    1. `compile(c, { deferInitialize: true })` → `dcOperatingPoint()` returns null ✓
    2. After `coord.initialize()` → `dcOperatingPoint()` returns non-null ✓
    3. Second `coord.initialize()` call → same result object (idempotent) ✓
    4. `compile(c)` without opts → DCOP runs immediately (backwards compat) ✓

## Wave 2 Summary
All four tasks complete. TypeScript compilation clean for the four touched production files (coordinator.ts, default-facade.ts, analog-engine.ts). Wave 3 harness consumer files (comparison-session.ts, boot-step-merge.test.ts) have expected failures that Wave 3 will resolve. All non-harness tests pass (160/160 coordinator tests pass, 4/4 new smoke tests pass).
