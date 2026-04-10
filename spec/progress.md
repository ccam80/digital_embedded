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
