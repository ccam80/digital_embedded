# Phase 1: Engine Accessor Changes

Full specification with exact code changes: `docs/harness-implementation-spec.md` § Phase 1

## Task P1a: SparseSolver instrumentation accessors

**File:** `src/solver/analog/sparse-solver.ts`

Add three new public accessors after `get cooCount()` (line ~424):

1. `get dimension(): number` — returns `this._n`
2. `getRhsSnapshot(): Float64Array` — returns `this._rhs.slice(0, this._n)`
3. `getCSCNonZeros(): Array<{ row, col, value }>` — iterates CSC arrays, returns non-zero entries

Insert after the `cooCount` getter, before `_growCOO()`. See spec Phase 1a for exact code.

## Task P1b: postIterationHook on NROptions + call site

**File:** `src/solver/analog/newton-raphson.ts`

**Change 1:** Add `postIterationHook` field to `NROptions` interface (insert before closing brace).

Signature:
```typescript
postIterationHook?: (
  iteration: number,
  voltages: Float64Array,
  prevVoltages: Float64Array,
  noncon: number,
  globalConverged: boolean,
  elemConverged: boolean,
) => void;
```

**Change 2:** Call the hook after blame tracking, before convergence return:
```typescript
opts.postIterationHook?.(iteration, voltages, prevVoltages, assembler.noncon, globalConverged, elemConverged);
```

Insert between the blame-tracking block closing brace and "// 10. Return on convergence". See spec Phase 1b for exact context.

## Task P1c: MNAEngine harness accessors + hook wiring

**File:** `src/solver/analog/analog-engine.ts`

**Change 1:** Add public accessors after `convergenceLog` getter, before breakpoints section:
- `get solver(): SparseSolver | null`
- `get statePool(): StatePool | null`
- `get elements(): readonly AnalogElement[]`
- `get compiled(): ConcreteCompiledAnalogCircuit | null`
- `postIterationHook` field (function | null, default null)

**Change 2:** Wire `postIterationHook` into the NR call in `step()`:
Add `postIterationHook: this.postIterationHook ?? undefined` to the `newtonRaphson({...})` options object.

Also wire into `dcOperatingPoint()` NR call if present.

See spec Phase 1c for exact code and type imports needed.

## Task P1d: Extend NRAttemptRecord with iterationDetails

**File:** `src/solver/analog/convergence-log.ts`

Add optional `iterationDetails` array to `NRAttemptRecord` interface:
```typescript
iterationDetails?: Array<{
  iteration: number;
  maxDelta: number;
  maxDeltaNode: number;
  noncon: number;
  converged: boolean;
}>;
```

Insert before the closing brace, after the `trigger` field. See spec Phase 1d.

## Task P1e: Remove dead getLteEstimate interface method

**Files:** Multiple (6 changes across 4 files)

1. `src/solver/analog/element.ts:189-203` — Remove entire `getLteEstimate` declaration
2. `src/solver/analog/element.ts:274` — Update doc: `getLteEstimate` → `getLteTimestep`
3. `src/core/analog-types.ts:146-151` — Remove entire `getLteEstimate` declaration
4. `src/core/analog-types.ts:155-159` — Update doc comment (remove "in preference to getLteEstimate")
5. `src/solver/analog/timestep.ts:182` — Update doc: `getLteEstimate` → `getLteTimestep`
6. `src/components/semiconductors/bjt.ts:1056` — Update comment: `getLteEstimate` → `getLteTimestep`

**IMPORTANT:** Line numbers in spec may have shifted from prior work. Use grep to find the exact text before editing. The OLD text patterns are the reliable anchors, not the line numbers.

See spec Phase 1e for exact OLD/NEW text for each change.
