## Summary

This spec defines exact file changes and new file contents for a per-NR-iteration comparison harness between our MNA engine and ngspice. Every change is grounded in actual code with verified line numbers. The spec is organized into three phases: (1) exposing engine internals via new accessors, (2) the TypeScript harness modules, and (3) ngspice instrumentation and FFI bridge.

## Phase 1: Engine Accessor Changes

---

### Phase 1a: `src/solver/analog/sparse-solver.ts`

The file ends at line 983. The last public method is `get cooCount()` at line 422. The best insertion point is after `get cooCount()` (line 424) and before the private `_growCOO()` at line 430.

```
FILE: src/solver/analog/sparse-solver.ts
PHASE: 1a
CHANGE: Add three new public accessors for harness instrumentation
LINE: 425 (insert after line 424, before the blank line at 425)
OLD: (blank line between cooCount getter and "// =========== COO growth" section)
NEW:
```

```typescript
  // =========================================================================
  // Harness instrumentation accessors (zero-cost when unused)
  // =========================================================================

  /** Current MNA matrix dimension. */
  get dimension(): number {
    return this._n;
  }

  /**
   * Return a snapshot (copy) of the current RHS vector.
   * The returned array is owned by the caller — mutations do not
   * affect the solver's internal state.
   */
  getRhsSnapshot(): Float64Array {
    return this._rhs.slice(0, this._n);
  }

  /**
   * Return the assembled matrix as an array of CSC non-zero entries.
   * Each entry contains { row, col, value } in original (un-permuted)
   * node ordering. Used by the comparison harness to diff against
   * ngspice's matrix dump.
   *
   * Performance: O(nnz) — allocates one object per non-zero. Not for
   * hot-path use; intended for offline comparison only.
   */
  getCSCNonZeros(): Array<{ row: number; col: number; value: number }> {
    const n = this._n;
    const result: Array<{ row: number; col: number; value: number }> = [];
    for (let col = 0; col < n; col++) {
      const p0 = this._cscColPtr[col];
      const p1 = this._cscColPtr[col + 1];
      for (let p = p0; p < p1; p++) {
        result.push({ row: this._cscRowIdx[p], col, value: this._cscVals[p] });
      }
    }
    return result;
  }
```

**RATIONALE:** The harness needs to snapshot the MNA matrix and RHS at each NR iteration to compare against ngspice's matrix. `dimension` is needed for topology snapshot. All three are read-only and allocate only when called, so zero overhead when harness is disabled.

---

### Phase 1b: `src/solver/analog/newton-raphson.ts`

The `NROptions` interface spans lines 20-79. The `preIterationHook` field is the last field at line 78. Insert the new `postIterationHook` field after it, at line 79 (before the closing `}`).

The NR convergence check completes at line 447 (`elemConverged = assembler.checkAllConverged(...)`). The convergence return is at line 471-473. The hook should fire between the blame tracking block (line 468) and the convergence return (line 471).

```
FILE: src/solver/analog/newton-raphson.ts
PHASE: 1b
CHANGE 1: Add postIterationHook to NROptions interface
LINE: 79 (insert before the closing brace of NROptions)
OLD:
  /** Hook for per-iteration companion recomputation. Called on iteration > 0 before re-stamping. */
  preIterationHook?: (iteration: number, voltages: Float64Array) => void;
}
NEW:
  /** Hook for per-iteration companion recomputation. Called on iteration > 0 before re-stamping. */
  preIterationHook?: (iteration: number, voltages: Float64Array) => void;
  /**
   * Hook called after each NR iteration's convergence check, before the
   * convergence return. Receives the full iteration state for external
   * instrumentation (comparison harness, convergence logging, etc.).
   *
   * Called unconditionally on every iteration (not just converged ones).
   * The hook must not mutate voltages or prevVoltages.
   */
  postIterationHook?: (
    iteration: number,
    voltages: Float64Array,
    prevVoltages: Float64Array,
    noncon: number,
    globalConverged: boolean,
    elemConverged: boolean,
  ) => void;
}
```

```
CHANGE 2: Call the postIterationHook after blame tracking, before convergence return
LINE: 469 (insert after the closing brace of the blame-tracking block at line 468, before "// 10. Return on convergence")
OLD:
    }

    // 10. Return on convergence
    if (globalConverged && elemConverged) {
NEW:
    }

    // 9a. Post-iteration hook for external instrumentation
    opts.postIterationHook?.(iteration, voltages, prevVoltages, assembler.noncon, globalConverged, elemConverged);

    // 10. Return on convergence
    if (globalConverged && elemConverged) {
```

**RATIONALE:** The hook fires after all convergence checks are complete and blame has been computed, providing the most complete snapshot of each iteration. Placing it before the convergence return means it fires on both converging and non-converging iterations. The `?.` optional chaining means zero cost when no hook is registered.

---

### Phase 1c: `src/solver/analog/analog-engine.ts`

The `MNAEngine` class starts at line 74. Private fields are declared lines 78-122. The last public accessor before the lifecycle methods is `convergenceLog` at line 839. The best insertion point for the new accessors is after the `convergenceLog` getter (line 841) and before the breakpoints section (line 845).

The NR call site is in `step()` at lines 349-371 where `newtonRaphson({...})` is called. The `postIterationHook` needs to be wired into that options object.

```
FILE: src/solver/analog/analog-engine.ts
PHASE: 1c
CHANGE 1: Add public accessors for harness instrumentation
LINE: 842 (insert after convergenceLog getter, before "// --- Breakpoints ---" comment at line 845)
OLD:
  /** Convergence log for post-mortem analysis. Enable via convergenceLog.enabled = true. */
  get convergenceLog(): ConvergenceLog {
    return this._convergenceLog;
  }

  // -------------------------------------------------------------------------
  // AnalogEngine interface — Breakpoints
  // -------------------------------------------------------------------------
NEW:
  /** Convergence log for post-mortem analysis. Enable via convergenceLog.enabled = true. */
  get convergenceLog(): ConvergenceLog {
    return this._convergenceLog;
  }

  // -------------------------------------------------------------------------
  // Harness instrumentation accessors
  // -------------------------------------------------------------------------

  /** Expose the sparse solver for matrix/RHS snapshots. Null before init(). */
  get solver(): SparseSolver | null {
    return this._compiled ? this._solver : null;
  }

  /** Expose the shared state pool for device-state snapshots. Null before init(). */
  get statePool(): StatePool | null {
    return (this._compiled as CompiledWithBridges | undefined)?.statePool ?? null;
  }

  /** Expose the compiled element array. Empty before init(). */
  get elements(): readonly AnalogElement[] {
    return this._elements;
  }

  /** Expose the compiled circuit for topology inspection. Null before init(). */
  get compiled(): ConcreteCompiledAnalogCircuit | null {
    return this._compiled;
  }

  /**
   * Optional post-NR-iteration hook. When set, passed through to every
   * newtonRaphson() call in step() and dcOperatingPoint(). The harness
   * sets this to capture per-iteration snapshots.
   */
  postIterationHook: ((
    iteration: number,
    voltages: Float64Array,
    prevVoltages: Float64Array,
    noncon: number,
    globalConverged: boolean,
    elemConverged: boolean,
  ) => void) | null = null;

  // -------------------------------------------------------------------------
  // AnalogEngine interface — Breakpoints
  // -------------------------------------------------------------------------
```

```
CHANGE 2: Wire postIterationHook into the NR call in step()
LINE: 349-371 (the newtonRaphson({...}) call)
OLD:
      const nrResult = newtonRaphson({
        solver: this._solver,
        elements,
        matrixSize,
        nodeCount,
        maxIterations: params.transientMaxIterations,
        reltol: params.reltol,
        abstol: params.abstol,
        iabstol: params.iabstol,
        initialGuess: this._voltages,
        diagnostics: this._diagnostics,
        voltagesBuffer: this._nrVoltages,
        prevVoltagesBuffer: this._nrPrevVoltages,
        enableBlameTracking: logging,
        preIterationHook: (_iteration, iterVoltages) => {
NEW:
      const nrResult = newtonRaphson({
        solver: this._solver,
        elements,
        matrixSize,
        nodeCount,
        maxIterations: params.transientMaxIterations,
        reltol: params.reltol,
        abstol: params.abstol,
        iabstol: params.iabstol,
        initialGuess: this._voltages,
        diagnostics: this._diagnostics,
        voltagesBuffer: this._nrVoltages,
        prevVoltagesBuffer: this._nrPrevVoltages,
        enableBlameTracking: logging,
        postIterationHook: this.postIterationHook ?? undefined,
        preIterationHook: (_iteration, iterVoltages) => {
```

Note: The `StatePool` import already exists via `CompiledWithBridges` (line 32: `import type { StatePool } from "./state-pool.js"`). No new import needed.

**RATIONALE:** These accessors give the harness read access to all engine internals needed for snapshot capture. The `postIterationHook` is wired through as a passthrough field so the harness can register once on the engine and capture every NR iteration in both step() and dcOperatingPoint().

---

### Phase 1d: `src/solver/analog/convergence-log.ts`

The `NRAttemptRecord` interface spans lines 20-35. Insert the new optional field at the end, before the closing brace at line 35.

```
FILE: src/solver/analog/convergence-log.ts
PHASE: 1d
CHANGE: Extend NRAttemptRecord with per-iteration detail array
LINE: 35 (insert before the closing brace)
OLD:
  /** Trigger: "initial" | "nr-retry" | "lte-retry" */
  trigger: "initial" | "nr-retry" | "lte-retry";
}
NEW:
  /** Trigger: "initial" | "nr-retry" | "lte-retry" */
  trigger: "initial" | "nr-retry" | "lte-retry";
  /**
   * Optional per-NR-iteration convergence detail. Populated only when the
   * comparison harness postIterationHook is active alongside convergence
   * logging. Absent in normal (non-harness) operation.
   */
  iterationDetails?: Array<{
    iteration: number;
    maxDelta: number;
    maxDeltaNode: number;
    noncon: number;
    converged: boolean;
  }>;
}
```

**RATIONALE:** Adding the detail array as optional means zero impact on existing logging code paths. The harness can populate it via the postIterationHook when both features are active.

---

### Phase 1e: Remove dead `getLteEstimate` interface method

After verifying all usages:
- `src/solver/analog/element.ts:202` -- interface declaration
- `src/core/analog-types.ts:151` -- interface declaration  
- `src/solver/analog/element.ts:274` -- doc comment reference ("stampCompanion and getLteEstimate")
- `src/solver/analog/timestep.ts:182` -- doc comment ("elements that implement getLteEstimate")
- `src/components/semiconductors/bjt.ts:1056` -- doc comment ("stored by stampCompanion for getLteEstimate")

The method is declared but **never implemented** by any element. All elements use `getLteTimestep` (the CKTterr-based replacement) instead. The timestep controller at `timestep.ts:221` only calls `getLteTimestep`. The old comment at `timestep.ts:182` is stale.

```
FILE: src/solver/analog/element.ts
PHASE: 1e
CHANGE 1: Remove getLteEstimate declaration
LINE: 189-203 (remove the entire getLteEstimate method declaration)
OLD:
  /**
   * Compute and return the local truncation error estimate for adaptive
   * timestepping, together with a reference magnitude used by the engine
   * to form a relative tolerance (ngspice-style).
   *
   * The engine accepts or rejects the step by computing
   *   local_tol = trtol · (reltol · |toleranceReference| + chargeTol)
   *   ratio     = truncationError / local_tol
   * and rejecting if any element's `ratio > 1`. `toleranceReference` is the
   * "natural" stored quantity of the element — charge (C·v) for capacitors,
   * flux (L·i) for inductors — at the most recent accepted step.
   *
   * @param dt - Current timestep in seconds
   * @returns `truncationError` and `toleranceReference`, both in charge
   *          (or flux) units; returning zero for both is equivalent to
   *          "no opinion" and never triggers rejection.
   */
  getLteEstimate?(dt: number): { truncationError: number; toleranceReference: number };
NEW:
  (remove entirely — no replacement)
```

```
CHANGE 2: Update isReactive doc comment
LINE: 274 (fix stale reference)
OLD:
   * The timestep controller reads this flag to decide whether to call
   * `stampCompanion` and `getLteEstimate` for reactive element handling.
NEW:
   * The timestep controller reads this flag to decide whether to call
   * `stampCompanion` and `getLteTimestep` for reactive element handling.
```

```
FILE: src/core/analog-types.ts
PHASE: 1e
CHANGE 3: Remove getLteEstimate declaration
LINE: 146-151 (remove entire getLteEstimate declaration)
OLD:
  /**
   * Compute and return the local truncation error estimate for adaptive
   * timestepping. See `AnalogElementCore` in solver/analog/element.ts for
   * the full contract; both fields are in charge/flux units, and the engine
   * forms an ngspice-style relative tolerance from `toleranceReference`.
   */
  getLteEstimate?(dt: number): { truncationError: number; toleranceReference: number };
NEW:
  (remove entirely)
```

```
CHANGE 4: Update getLteTimestep doc in analog-types.ts
LINE: 155-159 (fix stale reference)
OLD:
   * Elements implementing this method call `cktTerr()` internally for each
   * reactive junction. The controller calls this in preference to
   * `getLteEstimate` when present.
NEW:
   * Elements implementing this method call `cktTerr()` internally for each
   * reactive junction, passing charge values as individual scalars (not arrays)
   * to avoid hot-path allocations.
```

```
FILE: src/solver/analog/timestep.ts
PHASE: 1e
CHANGE 5: Fix stale doc comment
LINE: 182
OLD:
   * Iterates all reactive elements that implement `getLteEstimate`, takes the
NEW:
   * Iterates all reactive elements that implement `getLteTimestep`, takes the
```

```
FILE: src/components/semiconductors/bjt.ts
PHASE: 1e
CHANGE 6: Fix stale doc comment
LINE: 1056
OLD:
  // Total capacitance per junction (stored by stampCompanion for getLteEstimate)
NEW:
  // Total capacitance per junction (stored by stampCompanion for getLteTimestep)
```

**RATIONALE:** `getLteEstimate` was the original LTE interface, superseded by the CKTterr-based `getLteTimestep`. No element implements it. Removing it prevents confusion and eliminates a dead interface method from the contract.

---

## Phase 2: Harness TypeScript Modules (New Files)

All files live under `src/solver/analog/__tests__/harness/`.

---

### Phase 2a: `src/solver/analog/__tests__/harness/types.ts`

```
FILE: src/solver/analog/__tests__/harness/types.ts
PHASE: 2a
CHANGE: NEW FILE
```

```typescript
/**
 * Common types for the ngspice comparison harness.
 *
 * These types define the neutral interchange format used to compare
 * our MNA engine's per-NR-iteration state against ngspice's. Both
 * sides produce data in these types; the comparator operates on them.
 */

// ---------------------------------------------------------------------------
// Topology snapshot — captured once per compile
// ---------------------------------------------------------------------------

/** MNA matrix non-zero entry. */
export interface MatrixEntry {
  row: number;
  col: number;
  value: number;
}

/** Maps our MNA node IDs to ngspice node numbers. */
export interface NodeMapping {
  /** Our MNA node index (0-based, solver row). */
  ourIndex: number;
  /** ngspice node number (from CKTnodes linked list). */
  ngspiceIndex: number;
  /** Human-readable label (e.g. "R1:A", "Q1:C"). */
  label: string;
}

/** Captured once after compile — describes the circuit structure. */
export interface TopologySnapshot {
  /** MNA matrix dimension (nodeCount + branchCount). */
  matrixSize: number;
  /** Number of non-ground voltage nodes. */
  nodeCount: number;
  /** Number of branch-current rows. */
  branchCount: number;
  /** Element count. */
  elementCount: number;
  /** Per-element summary: index, label, type, pin node IDs. */
  elements: Array<{
    index: number;
    label: string;
    isNonlinear: boolean;
    isReactive: boolean;
    pinNodeIds: readonly number[];
  }>;
  /** Node label map for display. */
  nodeLabels: Map<number, string>;
}

// ---------------------------------------------------------------------------
// Per-iteration snapshot
// ---------------------------------------------------------------------------

/** State captured at a single NR iteration. */
export interface IterationSnapshot {
  /** 0-based iteration number within this NR solve. */
  iteration: number;
  /** Node voltages after solve (copy). */
  voltages: Float64Array;
  /** Node voltages from previous iteration (copy). */
  prevVoltages: Float64Array;
  /** RHS vector snapshot (copy). */
  rhs: Float64Array;
  /** Assembled matrix non-zeros. */
  matrix: MatrixEntry[];
  /** Per-element device state (if pool-backed). */
  elementStates: ElementStateSnapshot[];
  /** NR noncon counter. */
  noncon: number;
  /** Global convergence flag. */
  globalConverged: boolean;
  /** Element convergence flag. */
  elemConverged: boolean;
}

/** Device state for one element at one iteration. */
export interface ElementStateSnapshot {
  /** Element index in compiled.elements[]. */
  elementIndex: number;
  /** Element label. */
  label: string;
  /** Named state values (slot name -> value). */
  slots: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Per-step snapshot (aggregates iterations within one timestep attempt)
// ---------------------------------------------------------------------------

/** All iterations for one NR solve (one timestep attempt). */
export interface StepSnapshot {
  /** Simulation time at step entry. */
  simTime: number;
  /** Timestep dt. */
  dt: number;
  /** All NR iterations. */
  iterations: IterationSnapshot[];
  /** Whether NR converged. */
  converged: boolean;
  /** Total iteration count. */
  iterationCount: number;
}

// ---------------------------------------------------------------------------
// Device mapping — maps our state slots to ngspice state offsets
// ---------------------------------------------------------------------------

/** Maps one element type's internal state to ngspice state vector offsets. */
export interface DeviceMapping {
  /** Element type name (e.g. "capacitor", "diode", "bjt"). */
  deviceType: string;
  /**
   * Maps our slot name (from StateSchema) to ngspice state offset.
   * The ngspice offset is relative to the device's base in CKTstate0.
   * null means "no corresponding ngspice state" (skip comparison).
   */
  slotToNgspice: Record<string, number | null>;
  /**
   * Maps ngspice state offset (relative) to our slot name.
   * Inverse of slotToNgspice for entries where the mapping exists.
   */
  ngspiceToSlot: Record<number, string>;
}

// ---------------------------------------------------------------------------
// Comparison result
// ---------------------------------------------------------------------------

/** Tolerance specification for comparison. */
export interface Tolerance {
  /** Absolute tolerance for voltage comparisons (V). */
  vAbsTol: number;
  /** Absolute tolerance for current comparisons (A). */
  iAbsTol: number;
  /** Relative tolerance (dimensionless). */
  relTol: number;
  /** Absolute tolerance for charge/capacitance (C or F). */
  qAbsTol: number;
}

/** Default tolerances matching ngspice SPICE3 defaults. */
export const DEFAULT_TOLERANCE: Tolerance = {
  vAbsTol: 1e-6,
  iAbsTol: 1e-12,
  relTol: 1e-3,
  qAbsTol: 1e-14,
};

/** One comparison between our snapshot and ngspice's at one iteration. */
export interface ComparisonResult {
  /** Step index. */
  stepIndex: number;
  /** Iteration index within step. */
  iterationIndex: number;
  /** Simulation time. */
  simTime: number;
  /** Node voltage differences (node index -> {ours, theirs, delta, withinTol}). */
  voltageDiffs: Array<{
    nodeIndex: number;
    label: string;
    ours: number;
    theirs: number;
    absDelta: number;
    relDelta: number;
    withinTol: boolean;
  }>;
  /** RHS differences. */
  rhsDiffs: Array<{
    index: number;
    ours: number;
    theirs: number;
    absDelta: number;
    withinTol: boolean;
  }>;
  /** Matrix entry differences. */
  matrixDiffs: Array<{
    row: number;
    col: number;
    ours: number;
    theirs: number;
    absDelta: number;
    withinTol: boolean;
  }>;
  /** Device state differences. */
  stateDiffs: Array<{
    elementLabel: string;
    slotName: string;
    ours: number;
    theirs: number;
    absDelta: number;
    withinTol: boolean;
  }>;
  /** Overall pass/fail. */
  allWithinTol: boolean;
}

// ---------------------------------------------------------------------------
// Capture session — holds all snapshots for one simulation run
// ---------------------------------------------------------------------------

/** Complete capture from one simulation run. */
export interface CaptureSession {
  /** Source identifier ("ours" or "ngspice"). */
  source: "ours" | "ngspice";
  /** Circuit topology. */
  topology: TopologySnapshot;
  /** Per-step snapshots in chronological order. */
  steps: StepSnapshot[];
}

// ---------------------------------------------------------------------------
// Query API types
// ---------------------------------------------------------------------------

/** Query predicate for filtering snapshots. */
export interface SnapshotQuery {
  /** Filter by step index range. */
  stepRange?: { from: number; to: number };
  /** Filter by simulation time range. */
  timeRange?: { from: number; to: number };
  /** Filter by convergence status. */
  converged?: boolean;
  /** Filter by minimum iteration count. */
  minIterations?: number;
  /** Filter by element label (returns only that element's state). */
  elementLabel?: string;
  /** Filter by node index (returns only that node's voltages). */
  nodeIndex?: number;
}
```

---

### Phase 2b: `src/solver/analog/__tests__/harness/capture.ts`

```
FILE: src/solver/analog/__tests__/harness/capture.ts
PHASE: 2b
CHANGE: NEW FILE
```

```typescript
/**
 * Capture functions that read our engine's internal state into the
 * common snapshot format defined in types.ts.
 */

import type { SparseSolver } from "../../sparse-solver.js";
import type { AnalogElement } from "../../element.js";
import { isPoolBacked } from "../../element.js";
import type { StatePool } from "../../state-pool.js";
import type { ConcreteCompiledAnalogCircuit } from "../../compiled-analog-circuit.js";
import type {
  TopologySnapshot,
  IterationSnapshot,
  StepSnapshot,
  ElementStateSnapshot,
} from "./types.js";

// ---------------------------------------------------------------------------
// Topology capture (once per compile)
// ---------------------------------------------------------------------------

/**
 * Capture the circuit topology from a compiled circuit.
 * Called once after compile, before simulation starts.
 */
export function captureTopology(
  compiled: ConcreteCompiledAnalogCircuit,
): TopologySnapshot {
  const nodeLabels = new Map<number, string>();
  for (const [label, nodeId] of compiled.labelToNodeId) {
    nodeLabels.set(nodeId, label);
  }

  return {
    matrixSize: compiled.matrixSize,
    nodeCount: compiled.nodeCount,
    branchCount: compiled.branchCount,
    elementCount: compiled.elements.length,
    elements: compiled.elements.map((el, i) => ({
      index: i,
      label: el.label ?? `element_${i}`,
      isNonlinear: el.isNonlinear,
      isReactive: el.isReactive,
      pinNodeIds: el.pinNodeIds,
    })),
    nodeLabels,
  };
}

// ---------------------------------------------------------------------------
// Element state capture
// ---------------------------------------------------------------------------

/**
 * Capture the current state-pool slots for all pool-backed elements.
 */
export function captureElementStates(
  elements: readonly AnalogElement[],
  statePool: StatePool | null,
): ElementStateSnapshot[] {
  if (!statePool) return [];
  const snapshots: ElementStateSnapshot[] = [];
  const s0 = statePool.state0;

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!isPoolBacked(el)) continue;

    const schema = el.stateSchema;
    const base = el.stateBaseOffset;
    const slots: Record<string, number> = {};

    for (let s = 0; s < schema.slots.length; s++) {
      slots[schema.slots[s].name] = s0[base + s];
    }

    snapshots.push({
      elementIndex: i,
      label: el.label ?? `element_${i}`,
      slots,
    });
  }

  return snapshots;
}

// ---------------------------------------------------------------------------
// Per-iteration capture hook factory
// ---------------------------------------------------------------------------

/**
 * Post-iteration hook signature matching NROptions.postIterationHook.
 */
export type PostIterationHook = (
  iteration: number,
  voltages: Float64Array,
  prevVoltages: Float64Array,
  noncon: number,
  globalConverged: boolean,
  elemConverged: boolean,
) => void;

/**
 * Create a postIterationHook that captures every NR iteration into
 * an IterationSnapshot array. Returns the hook function and a getter
 * for the accumulated snapshots.
 *
 * @param solver    - SparseSolver instance (for matrix/RHS snapshots)
 * @param elements  - Element array (for device state capture)
 * @param statePool - State pool (for device state capture)
 */
export function createIterationCaptureHook(
  solver: SparseSolver,
  elements: readonly AnalogElement[],
  statePool: StatePool | null,
): { hook: PostIterationHook; getSnapshots: () => IterationSnapshot[]; clear: () => void } {
  let snapshots: IterationSnapshot[] = [];

  const hook: PostIterationHook = (
    iteration, voltages, prevVoltages, noncon, globalConverged, elemConverged,
  ) => {
    snapshots.push({
      iteration,
      voltages: voltages.slice(),
      prevVoltages: prevVoltages.slice(),
      rhs: solver.getRhsSnapshot(),
      matrix: solver.getCSCNonZeros(),
      elementStates: captureElementStates(elements, statePool),
      noncon,
      globalConverged,
      elemConverged,
    });
  };

  return {
    hook,
    getSnapshots: () => snapshots,
    clear: () => { snapshots = []; },
  };
}

/**
 * Create a step-level capture wrapper that uses createIterationCaptureHook
 * internally and packages iteration snapshots into StepSnapshot objects.
 *
 * Usage:
 *   const capture = createStepCaptureHook(solver, elements, statePool);
 *   engine.postIterationHook = capture.hook;
 *   // ... run simulation steps ...
 *   capture.finalizeStep(simTime, dt, converged);
 *   const steps = capture.getSteps();
 */
export function createStepCaptureHook(
  solver: SparseSolver,
  elements: readonly AnalogElement[],
  statePool: StatePool | null,
): {
  hook: PostIterationHook;
  finalizeStep: (simTime: number, dt: number, converged: boolean) => void;
  getSteps: () => StepSnapshot[];
  clear: () => void;
} {
  const iterCapture = createIterationCaptureHook(solver, elements, statePool);
  const steps: StepSnapshot[] = [];

  return {
    hook: iterCapture.hook,
    finalizeStep: (simTime: number, dt: number, converged: boolean) => {
      const iterations = iterCapture.getSnapshots();
      if (iterations.length > 0) {
        steps.push({
          simTime,
          dt,
          iterations: [...iterations],
          converged,
          iterationCount: iterations.length,
        });
      }
      iterCapture.clear();
    },
    getSteps: () => steps,
    clear: () => {
      steps.length = 0;
      iterCapture.clear();
    },
  };
}
```

---

### Phase 2c: `src/solver/analog/__tests__/harness/device-mappings.ts`

```
FILE: src/solver/analog/__tests__/harness/device-mappings.ts
PHASE: 2c
CHANGE: NEW FILE
```

```typescript
/**
 * Hand-written device mappings from our state-pool slot names to
 * ngspice CKTstate0 offsets.
 *
 * ngspice state offsets are from the device's `here->...` state base.
 * Our offsets are the slot index in the StateSchema (0-based).
 *
 * Sources:
 *   Capacitor: ngspice src/spicelib/devices/cap/capdefs.h
 *   Inductor:  ngspice src/spicelib/devices/ind/inddefs.h
 *   Diode:     ngspice src/spicelib/devices/dio/diodefs.h
 *   BJT:       ngspice src/spicelib/devices/bjt/bjtdefs.h
 *   MOSFET:    ngspice src/spicelib/devices/mos1/mos1defs.h (Level 1)
 */

import type { DeviceMapping } from "./types.js";

// ---------------------------------------------------------------------------
// Capacitor
// ---------------------------------------------------------------------------
// Our slots (CAPACITOR_SCHEMA):
//   0: GEQ, 1: IEQ, 2: V, 3: Q, 4: CCAP
// ngspice cap state offsets (capdefs.h):
//   qcap=0, ccap=1  (charge, companion current)

export const CAPACITOR_MAPPING: DeviceMapping = {
  deviceType: "capacitor",
  slotToNgspice: {
    GEQ: null,    // companion conductance — computed, not stored in ngspice state
    IEQ: null,    // companion current — computed, not stored in ngspice state
    V: null,      // terminal voltage — read from CKTrhs, not state
    Q: 0,         // qcap — charge
    CCAP: 1,      // ccap — companion current
  },
  ngspiceToSlot: {
    0: "Q",
    1: "CCAP",
  },
};

// ---------------------------------------------------------------------------
// Inductor
// ---------------------------------------------------------------------------
// Our slots (INDUCTOR_SCHEMA):
//   0: GEQ, 1: IEQ, 2: I, 3: PHI, 4: CCAP
// ngspice ind state offsets (inddefs.h):
//   flux=0, ccap=1  (flux linkage, companion current)

export const INDUCTOR_MAPPING: DeviceMapping = {
  deviceType: "inductor",
  slotToNgspice: {
    GEQ: null,
    IEQ: null,
    I: null,      // branch current — read from solution vector
    PHI: 0,       // flux
    CCAP: 1,      // ccap
  },
  ngspiceToSlot: {
    0: "PHI",
    1: "CCAP",
  },
};

// ---------------------------------------------------------------------------
// Diode (with capacitance)
// ---------------------------------------------------------------------------
// Our slots (DIODE_CAP_SCHEMA):
//   0: VD, 1: GEQ, 2: IEQ, 3: ID,
//   4: CAP_GEQ, 5: CAP_IEQ, 6: V, 7: Q, 8: CCAP
// ngspice dio state offsets (diodefs.h):
//   DIOvoltage=0, DIOcurrent=1, DIOconduct=2,
//   DIOcapCharge=3, DIOcapCurrent=4,
//   DIOinitCond=5 (not compared)

export const DIODE_MAPPING: DeviceMapping = {
  deviceType: "diode",
  slotToNgspice: {
    VD: 0,        // junction voltage
    GEQ: 2,       // conductance
    IEQ: null,    // Norton current — derived, not directly stored
    ID: 1,        // diode current
    CAP_GEQ: null,
    CAP_IEQ: null,
    V: null,
    Q: 3,         // junction charge
    CCAP: 4,      // junction cap current
  },
  ngspiceToSlot: {
    0: "VD",
    1: "ID",
    2: "GEQ",
    3: "Q",
    4: "CCAP",
  },
};

// ---------------------------------------------------------------------------
// BJT (SPICE L1 — Gummel-Poon)
// ---------------------------------------------------------------------------
// Our slots (BJT_L1_SCHEMA) — first 10 match simple, then extended:
//   0: VBE, 1: VBC, 2: GPI, 3: GMU, 4: GM, 5: GO,
//   6: IC, 7: IB, 8: IC_NORTON, 9: IB_NORTON, 10: RB_EFF,
//   11: IE_NORTON, 12: GEQCB,
//   13-20: CAP_GEQ/IEQ for BE/BC_INT/BC_EXT/CS,
//   21: V_BE, 22: V_BC, 23: V_CS,
//   24: Q_BE, 25: Q_BC, 26: Q_CS,
//   27: CTOT_BE, 28: CTOT_BC, 29: CTOT_CS, ...
// ngspice bjt state offsets (bjtdefs.h):
//   BJTvbe=0, BJTvbc=1, BJTcc=2, BJTcb=3, BJTgpi=4, BJTgmu=5,
//   BJTgm=6, BJTgo=7, BJTqbe=8, BJTcqbe=9, BJTqbc=10, BJTcqbc=11,
//   BJTqcs=12, BJTcqcs=13, BJTqbx=14, BJTcqbx=15, BJTgx=16,
//   BJTcexbc=17, BJTgeqcb=18, BJTgccs=19, BJTgeqbx=20

export const BJT_MAPPING: DeviceMapping = {
  deviceType: "bjt",
  slotToNgspice: {
    VBE: 0,       // BJTvbe
    VBC: 1,       // BJTvbc
    GPI: 4,       // BJTgpi
    GMU: 5,       // BJTgmu
    GM: 6,        // BJTgm
    GO: 7,        // BJTgo
    IC: 2,        // BJTcc (collector current)
    IB: 3,        // BJTcb (base current)
    IC_NORTON: null,
    IB_NORTON: null,
    RB_EFF: null, // computed from gx = 1/RB_EFF → ngspice BJTgx=16
    IE_NORTON: null,
    GEQCB: 18,    // BJTgeqcb
    CAP_GEQ_BE: null,
    CAP_IEQ_BE: null,
    CAP_GEQ_BC_INT: null,
    CAP_IEQ_BC_INT: null,
    CAP_GEQ_BC_EXT: null,
    CAP_IEQ_BC_EXT: null,
    CAP_GEQ_CS: null,
    CAP_IEQ_CS: null,
    V_BE: null,
    V_BC: null,
    V_CS: null,
    Q_BE: 8,      // BJTqbe
    Q_BC: 10,     // BJTqbc
    Q_CS: 12,     // BJTqcs
    CTOT_BE: null,
    CTOT_BC: null,
    CTOT_CS: null,
    CEXBC_NOW: 17,  // BJTcexbc
    CEXBC_PREV: null,
    CEXBC_PREV2: null,
    DT_PREV: null,
  },
  ngspiceToSlot: {
    0: "VBE",
    1: "VBC",
    2: "IC",
    3: "IB",
    4: "GPI",
    5: "GMU",
    6: "GM",
    7: "GO",
    8: "Q_BE",
    10: "Q_BC",
    12: "Q_CS",
    17: "CEXBC_NOW",
    18: "GEQCB",
  },
};

// ---------------------------------------------------------------------------
// MOSFET Level 1 — placeholder
// ---------------------------------------------------------------------------
// Our MOSFET does not yet use the pool-backed state schema (no
// defineStateSchema call found in mosfet.ts). This mapping is a
// placeholder for when pool migration is complete.
// ngspice mos1 state offsets (mos1defs.h):
//   MOS1vbs=0, MOS1vgs=1, MOS1vds=2, MOS1capgs=3, MOS1qgs=4,
//   MOS1cqgs=5, MOS1capgd=6, MOS1qgd=7, MOS1cqgd=8,
//   MOS1capgb=9, MOS1qgb=10, MOS1cqgb=11, MOS1qbd=12,
//   MOS1cqbd=13, MOS1qbs=14, MOS1cqbs=15

export const MOSFET_MAPPING: DeviceMapping = {
  deviceType: "mosfet",
  slotToNgspice: {},   // populated after pool migration
  ngspiceToSlot: {},
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** All device mappings keyed by device type. */
export const DEVICE_MAPPINGS: Record<string, DeviceMapping> = {
  capacitor: CAPACITOR_MAPPING,
  inductor: INDUCTOR_MAPPING,
  diode: DIODE_MAPPING,
  bjt: BJT_MAPPING,
  mosfet: MOSFET_MAPPING,
};
```

---

### Phase 2d: `src/solver/analog/__tests__/harness/compare.ts`

```
FILE: src/solver/analog/__tests__/harness/compare.ts
PHASE: 2d
CHANGE: NEW FILE
```

```typescript
/**
 * Comparison engine: diffs our CaptureSession against ngspice's
 * CaptureSession and produces ComparisonResult objects.
 */

import type {
  CaptureSession,
  ComparisonResult,
  Tolerance,
  DeviceMapping,
} from "./types.js";
import { DEFAULT_TOLERANCE } from "./types.js";
import { DEVICE_MAPPINGS } from "./device-mappings.js";

// ---------------------------------------------------------------------------
// Tolerance check helpers
// ---------------------------------------------------------------------------

function withinTol(ours: number, theirs: number, absTol: number, relTol: number): boolean {
  const absDelta = Math.abs(ours - theirs);
  const refMag = Math.max(Math.abs(ours), Math.abs(theirs));
  return absDelta <= absTol + relTol * refMag;
}

// ---------------------------------------------------------------------------
// Snapshot comparison
// ---------------------------------------------------------------------------

/**
 * Compare two capture sessions iteration-by-iteration.
 *
 * Both sessions must have the same number of steps. Within each step,
 * iterations are compared pairwise up to the minimum count (if one
 * side converged in fewer iterations, trailing iterations are skipped).
 *
 * @param ours     - Our engine's capture session
 * @param ref      - ngspice reference capture session
 * @param tolerance - Comparison tolerances
 * @returns Array of ComparisonResult, one per compared iteration
 */
export function compareSnapshots(
  ours: CaptureSession,
  ref: CaptureSession,
  tolerance: Tolerance = DEFAULT_TOLERANCE,
): ComparisonResult[] {
  const results: ComparisonResult[] = [];
  const stepCount = Math.min(ours.steps.length, ref.steps.length);

  for (let si = 0; si < stepCount; si++) {
    const ourStep = ours.steps[si];
    const refStep = ref.steps[si];
    const iterCount = Math.min(ourStep.iterations.length, refStep.iterations.length);

    for (let ii = 0; ii < iterCount; ii++) {
      const ourIter = ourStep.iterations[ii];
      const refIter = refStep.iterations[ii];

      // Voltage diffs
      const voltageDiffs: ComparisonResult["voltageDiffs"] = [];
      const nodeCount = Math.min(ourIter.voltages.length, refIter.voltages.length);
      for (let n = 0; n < nodeCount; n++) {
        const o = ourIter.voltages[n];
        const t = refIter.voltages[n];
        const absDelta = Math.abs(o - t);
        const refMag = Math.max(Math.abs(o), Math.abs(t));
        const wt = withinTol(o, t, tolerance.vAbsTol, tolerance.relTol);
        voltageDiffs.push({
          nodeIndex: n,
          label: ours.topology.nodeLabels.get(n + 1) ?? `node_${n}`,
          ours: o,
          theirs: t,
          absDelta,
          relDelta: refMag > 0 ? absDelta / refMag : absDelta,
          withinTol: wt,
        });
      }

      // RHS diffs
      const rhsDiffs: ComparisonResult["rhsDiffs"] = [];
      const rhsLen = Math.min(ourIter.rhs.length, refIter.rhs.length);
      for (let r = 0; r < rhsLen; r++) {
        const o = ourIter.rhs[r];
        const t = refIter.rhs[r];
        const absDelta = Math.abs(o - t);
        rhsDiffs.push({
          index: r,
          ours: o,
          theirs: t,
          absDelta,
          withinTol: withinTol(o, t, tolerance.iAbsTol, tolerance.relTol),
        });
      }

      // Matrix diffs — build maps keyed by "row,col"
      const matrixDiffs: ComparisonResult["matrixDiffs"] = [];
      const ourMap = new Map<string, number>();
      for (const e of ourIter.matrix) ourMap.set(`${e.row},${e.col}`, e.value);
      const refMap = new Map<string, number>();
      for (const e of refIter.matrix) refMap.set(`${e.row},${e.col}`, e.value);
      const allKeys = new Set([...ourMap.keys(), ...refMap.keys()]);
      for (const key of allKeys) {
        const [r, c] = key.split(",").map(Number);
        const o = ourMap.get(key) ?? 0;
        const t = refMap.get(key) ?? 0;
        const absDelta = Math.abs(o - t);
        if (!withinTol(o, t, tolerance.iAbsTol, tolerance.relTol)) {
          matrixDiffs.push({ row: r, col: c, ours: o, theirs: t, absDelta, withinTol: false });
        }
      }

      // Device state diffs
      const stateDiffs: ComparisonResult["stateDiffs"] = [];
      // (State comparison requires device mappings and ngspice-side state capture;
      //  deferred to Phase 3 when ngspice bridge provides state snapshots.)

      const allWithinTol = voltageDiffs.every(d => d.withinTol)
        && rhsDiffs.every(d => d.withinTol)
        && matrixDiffs.length === 0
        && stateDiffs.every(d => d.withinTol);

      results.push({
        stepIndex: si,
        iterationIndex: ii,
        simTime: ourStep.simTime,
        voltageDiffs,
        rhsDiffs,
        matrixDiffs,
        stateDiffs,
        allWithinTol,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Format a ComparisonResult as a human-readable diff string.
 */
export function formatComparison(result: ComparisonResult): string {
  const lines: string[] = [];
  lines.push(`=== Step ${result.stepIndex}, Iteration ${result.iterationIndex} (t=${result.simTime.toExponential(4)}) ===`);
  lines.push(`  Overall: ${result.allWithinTol ? "PASS" : "FAIL"}`);

  const vFails = result.voltageDiffs.filter(d => !d.withinTol);
  if (vFails.length > 0) {
    lines.push(`  Voltage mismatches (${vFails.length}):`);
    for (const d of vFails.slice(0, 10)) {
      lines.push(`    node ${d.nodeIndex} (${d.label}): ours=${d.ours.toExponential(6)} ref=${d.theirs.toExponential(6)} delta=${d.absDelta.toExponential(3)}`);
    }
    if (vFails.length > 10) lines.push(`    ... and ${vFails.length - 10} more`);
  }

  const rFails = result.rhsDiffs.filter(d => !d.withinTol);
  if (rFails.length > 0) {
    lines.push(`  RHS mismatches (${rFails.length}):`);
    for (const d of rFails.slice(0, 10)) {
      lines.push(`    row ${d.index}: ours=${d.ours.toExponential(6)} ref=${d.theirs.toExponential(6)} delta=${d.absDelta.toExponential(3)}`);
    }
  }

  if (result.matrixDiffs.length > 0) {
    lines.push(`  Matrix mismatches (${result.matrixDiffs.length}):`);
    for (const d of result.matrixDiffs.slice(0, 10)) {
      lines.push(`    [${d.row},${d.col}]: ours=${d.ours.toExponential(6)} ref=${d.theirs.toExponential(6)} delta=${d.absDelta.toExponential(3)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Find the first iteration where divergence exceeds a threshold.
 * Useful for pinpointing when our engine starts deviating from ngspice.
 */
export function findFirstDivergence(
  results: ComparisonResult[],
  threshold: number = 1e-3,
): ComparisonResult | null {
  for (const r of results) {
    for (const d of r.voltageDiffs) {
      if (d.absDelta > threshold) return r;
    }
  }
  return null;
}
```

---

### Phase 2e: `src/solver/analog/__tests__/harness/query.ts`

```
FILE: src/solver/analog/__tests__/harness/query.ts
PHASE: 2e
CHANGE: NEW FILE
```

```typescript
/**
 * Query API over a CaptureSession.
 *
 * Provides filtering, projection, and aggregation over captured
 * iteration snapshots for interactive debugging.
 */

import type {
  CaptureSession,
  StepSnapshot,
  IterationSnapshot,
  SnapshotQuery,
} from "./types.js";

/**
 * Filter steps from a capture session matching the query predicates.
 */
export function querySteps(
  session: CaptureSession,
  query: SnapshotQuery,
): StepSnapshot[] {
  let steps = session.steps;

  if (query.stepRange) {
    const { from, to } = query.stepRange;
    steps = steps.filter((_, i) => i >= from && i <= to);
  }

  if (query.timeRange) {
    const { from, to } = query.timeRange;
    steps = steps.filter(s => s.simTime >= from && s.simTime <= to);
  }

  if (query.converged !== undefined) {
    steps = steps.filter(s => s.converged === query.converged);
  }

  if (query.minIterations !== undefined) {
    steps = steps.filter(s => s.iterationCount >= query.minIterations!);
  }

  return steps;
}

/**
 * Extract the voltage trajectory for a specific node across all
 * captured iterations. Returns an array of {simTime, iteration, voltage}.
 */
export function nodeVoltageTrajectory(
  session: CaptureSession,
  nodeIndex: number,
): Array<{ simTime: number; iteration: number; voltage: number }> {
  const result: Array<{ simTime: number; iteration: number; voltage: number }> = [];
  for (const step of session.steps) {
    for (const iter of step.iterations) {
      if (nodeIndex < iter.voltages.length) {
        result.push({
          simTime: step.simTime,
          iteration: iter.iteration,
          voltage: iter.voltages[nodeIndex],
        });
      }
    }
  }
  return result;
}

/**
 * Extract a specific element's state slot values across all iterations.
 * Returns an array of {simTime, iteration, value}.
 */
export function elementStateTrajectory(
  session: CaptureSession,
  elementLabel: string,
  slotName: string,
): Array<{ simTime: number; iteration: number; value: number }> {
  const result: Array<{ simTime: number; iteration: number; value: number }> = [];
  for (const step of session.steps) {
    for (const iter of step.iterations) {
      const es = iter.elementStates.find(e => e.label === elementLabel);
      if (es && slotName in es.slots) {
        result.push({
          simTime: step.simTime,
          iteration: iter.iteration,
          value: es.slots[slotName],
        });
      }
    }
  }
  return result;
}

/**
 * Summarize convergence behavior: total steps, NR failure count,
 * average iterations, worst-case iteration count.
 */
export function convergenceSummary(session: CaptureSession): {
  totalSteps: number;
  convergedSteps: number;
  failedSteps: number;
  avgIterations: number;
  maxIterations: number;
  worstStep: number;
} {
  let converged = 0, failed = 0, totalIter = 0, maxIter = 0, worstStep = -1;
  for (let i = 0; i < session.steps.length; i++) {
    const s = session.steps[i];
    if (s.converged) converged++; else failed++;
    totalIter += s.iterationCount;
    if (s.iterationCount > maxIter) {
      maxIter = s.iterationCount;
      worstStep = i;
    }
  }
  return {
    totalSteps: session.steps.length,
    convergedSteps: converged,
    failedSteps: failed,
    avgIterations: session.steps.length > 0 ? totalIter / session.steps.length : 0,
    maxIterations: maxIter,
    worstStep,
  };
}

/**
 * Find the iteration with the largest voltage delta for a given node.
 * Useful for identifying where convergence is struggling.
 */
export function findLargestDelta(
  session: CaptureSession,
  nodeIndex: number,
): { stepIndex: number; iterationIndex: number; delta: number } | null {
  let best: { stepIndex: number; iterationIndex: number; delta: number } | null = null;
  for (let si = 0; si < session.steps.length; si++) {
    const step = session.steps[si];
    for (let ii = 0; ii < step.iterations.length; ii++) {
      const iter = step.iterations[ii];
      if (nodeIndex < iter.voltages.length && nodeIndex < iter.prevVoltages.length) {
        const delta = Math.abs(iter.voltages[nodeIndex] - iter.prevVoltages[nodeIndex]);
        if (!best || delta > best.delta) {
          best = { stepIndex: si, iterationIndex: ii, delta };
        }
      }
    }
  }
  return best;
}
```

---

## Phase 3: ngspice Integration

---

### Phase 3a: `ref/ngspice/src/maths/ni/niiter.c` Modifications

The file is 279 lines. The key insertion points, verified from the read:

1. **After includes (line 20):** Add the instrumentation callback typedef and global pointer.
2. **After `SMPsolve` (line 164-166):** Insert matrix+RHS+voltage snapshot callback.
3. **After `NIconvTest` (line 195-198):** Insert post-convergence-check callback.
4. **After damping (line 230):** Insert post-damping voltage snapshot.

```
FILE: ref/ngspice/src/maths/ni/niiter.c
PHASE: 3a
CHANGE 1: Add callback infrastructure after includes
LINE: 21 (insert after #include "ngspice/sperror.h")
OLD:
#include "ngspice/sperror.h"
NEW:
#include "ngspice/sperror.h"

/* ---- NR iteration instrumentation ---- */
typedef void (*NI_InstrumentCallback)(
    int iteration,           /* 0-based NR iteration count */
    int matrixSize,          /* CKTmaxEqNum */
    double *rhs,             /* CKTrhs (post-solve voltages) */
    double *rhsOld,          /* CKTrhsOld (previous voltages) */
    double *state0,          /* CKTstate0 */
    int numStates,           /* CKTnumStates */
    int noncon,              /* CKTnoncon */
    int converged            /* 1 if converged, 0 otherwise */
);

static NI_InstrumentCallback ni_instrument_cb = NULL;

/* Called from shared-lib consumer to register the callback. */
void ni_instrument_register(NI_InstrumentCallback cb) {
    ni_instrument_cb = cb;
}
```

```
CHANGE 2: Add callback invocation after convergence check
LINE: 199 (insert after the STEPDEBUG printf("noncon is %d\n",...) block, before the closing brace of the if(1) block at line 202)
OLD:
#ifdef STEPDEBUG
            printf("noncon is %d\n",ckt->CKTnoncon);
#endif
        }
NEW:
#ifdef STEPDEBUG
            printf("noncon is %d\n",ckt->CKTnoncon);
#endif
            /* Instrumentation callback — fires after solve + convergence check */
            if (ni_instrument_cb) {
                ni_instrument_cb(
                    iterno - 1,                /* 0-based */
                    ckt->CKTmaxEqNum + 1,      /* matrix dimension */
                    ckt->CKTrhs,
                    ckt->CKTrhsOld,
                    ckt->CKTstate0,
                    ckt->CKTnumStates,
                    ckt->CKTnoncon,
                    (ckt->CKTnoncon == 0 && iterno != 1) ? 1 : 0
                );
            }
        }
```

**RATIONALE:** The callback fires at the same logical point as our `postIterationHook` -- after solve, after convergence check, before damping/mode transitions. The callback receives all data needed to construct an `IterationSnapshot` in our common format.

---

### Phase 3b: Build Instructions for Windows Shared Library

```
FILE: ref/ngspice/BUILD-SHARED-WIN.md
PHASE: 3b
CHANGE: NEW FILE — build instructions document
```

```markdown
# Building ngspice as a Shared Library (Windows)

## Prerequisites

- Visual Studio 2022 (Community or higher) with C++ workload
- CMake 3.20+ (optional, VS solution provided)

## Steps

### Option A: Visual Studio Solution (recommended)

1. Open `ref/ngspice/visualc/sharedspice.sln` in VS2022
2. Set configuration: Release | x64
3. In project properties → C/C++ → Preprocessor:
   - Ensure `SIMULATOR` and `HAS_WINGUI` are defined
4. Build → Build Solution
5. Output: `ref/ngspice/visualc/sharedspice/x64/Release/ngspice.dll`

### Option B: CMake

```bash
cd ref/ngspice
mkdir build && cd build
cmake .. -G "Visual Studio 17 2022" -A x64 \
  -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=ON
cmake --build . --config Release
```

### Verifying Instrumentation

After building, verify `ni_instrument_register` is exported:

```bash
dumpbin /exports ngspice.dll | findstr ni_instrument
```

Should show: `ni_instrument_register`

### Adding the Export

If `ni_instrument_register` is not exported, add to the .def file or
use `__declspec(dllexport)`:

```c
/* In niiter.c, change the function signature to: */
__declspec(dllexport) void ni_instrument_register(NI_InstrumentCallback cb) {
    ni_instrument_cb = cb;
}
```
```

---

### Phase 3c: `src/solver/analog/__tests__/harness/ngspice-bridge.ts`

```
FILE: src/solver/analog/__tests__/harness/ngspice-bridge.ts
PHASE: 3c
CHANGE: NEW FILE
```

```typescript
/**
 * Node FFI bridge to ngspice shared library.
 *
 * Loads ngspice.dll via node-ffi-napi / koffi, registers the
 * instrumentation callback, runs a SPICE netlist, and converts
 * ngspice per-iteration data into our CaptureSession format.
 *
 * IMPORTANT: This module is test-only and requires native addons.
 * It is not bundled into the browser application. Tests that use
 * this bridge should be in a separate test file with a guard:
 *
 *   import.meta.env?.NGSPICE_DLL_PATH || describe.skip(...)
 *
 * Environment variable:
 *   NGSPICE_DLL_PATH — absolute path to ngspice.dll with instrumentation
 */

import type {
  CaptureSession,
  TopologySnapshot,
  StepSnapshot,
  IterationSnapshot,
  ElementStateSnapshot,
} from "./types.js";

// ---------------------------------------------------------------------------
// FFI types (koffi bindings — resolved at runtime)
// ---------------------------------------------------------------------------

/**
 * Raw callback data from ngspice ni_instrument_cb.
 * Matches the C typedef in niiter.c.
 */
interface RawNgspiceIteration {
  iteration: number;
  matrixSize: number;
  rhs: Float64Array;
  rhsOld: Float64Array;
  state0: Float64Array;
  numStates: number;
  noncon: number;
  converged: boolean;
}

// ---------------------------------------------------------------------------
// NgspiceBridge
// ---------------------------------------------------------------------------

/**
 * Bridge to an instrumented ngspice shared library.
 *
 * Usage:
 *   const bridge = new NgspiceBridge(process.env.NGSPICE_DLL_PATH!);
 *   bridge.loadNetlist(spiceNetlist);
 *   bridge.runDcOp();           // or runTran(stopTime, maxStep)
 *   const session = bridge.getCaptureSession();
 *   bridge.dispose();
 */
export class NgspiceBridge {
  private _dllPath: string;
  private _lib: any;  // koffi library handle
  private _iterations: RawNgspiceIteration[] = [];
  private _stepBoundaries: number[] = [];  // iteration indices where steps start
  private _topology: TopologySnapshot | null = null;

  constructor(dllPath: string) {
    this._dllPath = dllPath;
    // Actual FFI loading deferred to init() to allow async import of koffi
  }

  /**
   * Initialize the FFI binding. Must be called before any other method.
   * Separated from constructor because koffi is an optional dependency
   * that may not be installed in all environments.
   */
  async init(): Promise<void> {
    // Dynamic import to avoid hard dependency
    const koffi = await import("koffi");

    this._lib = koffi.load(this._dllPath);

    // Define callback type
    const callbackType = koffi.proto(
      "void ni_instrument_cb(int, int, double*, double*, double*, int, int, int)",
    );

    // Register our callback
    const registerFn = this._lib.func(
      "void ni_instrument_register(ni_instrument_cb*)",
    );

    const callback = koffi.register(
      (iteration: number, matrixSize: number, rhsPtr: any, rhsOldPtr: any,
       state0Ptr: any, numStates: number, noncon: number, converged: number) => {
        // Copy data out of ngspice buffers into JS-owned arrays
        const rhs = new Float64Array(matrixSize);
        const rhsOld = new Float64Array(matrixSize);
        const state0 = new Float64Array(numStates);

        koffi.decode(rhsPtr, "double", matrixSize, rhs);
        koffi.decode(rhsOldPtr, "double", matrixSize, rhsOld);
        koffi.decode(state0Ptr, "double", numStates, state0);

        this._iterations.push({
          iteration,
          matrixSize,
          rhs,
          rhsOld,
          state0,
          numStates,
          noncon,
          converged: converged !== 0,
        });
      },
      callbackType,
    );

    registerFn(callback);
  }

  /**
   * Load a SPICE netlist into ngspice.
   * The netlist should be a complete .spice file content as a string.
   */
  loadNetlist(netlist: string): void {
    // Use ngspice shared API: ngSpice_Circ(lines)
    const circ = this._lib.func("int ngSpice_Circ(char**)");
    const lines = netlist.split("\n").map(l => l + "\0");
    lines.push("\0"); // null terminator
    circ(lines);
  }

  /**
   * Run DC operating point analysis.
   */
  runDcOp(): void {
    this._iterations = [];
    const cmd = this._lib.func("int ngSpice_Command(char*)");
    cmd("op");
  }

  /**
   * Run transient analysis.
   */
  runTran(stopTime: number, maxStep: number): void {
    this._iterations = [];
    const cmd = this._lib.func("int ngSpice_Command(char*)");
    cmd(`tran ${maxStep} ${stopTime}`);
  }

  /**
   * Convert accumulated iteration data into a CaptureSession.
   *
   * Note: This produces a simplified session without matrix snapshots
   * (ngspice's assembled matrix is not exposed through the callback).
   * Voltage and state comparisons are the primary use case.
   */
  getCaptureSession(): CaptureSession {
    // Group iterations into steps by detecting iteration counter resets
    const steps: StepSnapshot[] = [];
    let currentStepIterations: IterationSnapshot[] = [];
    let lastIteration = -1;

    for (const raw of this._iterations) {
      if (raw.iteration <= lastIteration && currentStepIterations.length > 0) {
        // New step detected (iteration counter reset)
        steps.push({
          simTime: 0, // will need to be populated from ngspice time vector
          dt: 0,
          iterations: currentStepIterations,
          converged: currentStepIterations[currentStepIterations.length - 1]?.converged ?? false,
          iterationCount: currentStepIterations.length,
        });
        currentStepIterations = [];
      }

      currentStepIterations.push({
        iteration: raw.iteration,
        voltages: raw.rhs.slice(),  // ngspice: CKTrhs = new voltages after solve
        prevVoltages: raw.rhsOld.slice(),
        rhs: new Float64Array(0),   // matrix RHS not available from callback
        matrix: [],                 // matrix entries not available
        elementStates: [],          // populated via device mapping + state0
        noncon: raw.noncon,
        globalConverged: raw.converged,
        elemConverged: raw.converged, // ngspice merges both into noncon
      });

      lastIteration = raw.iteration;
    }

    // Flush last step
    if (currentStepIterations.length > 0) {
      steps.push({
        simTime: 0,
        dt: 0,
        iterations: currentStepIterations,
        converged: currentStepIterations[currentStepIterations.length - 1]?.converged ?? false,
        iterationCount: currentStepIterations.length,
      });
    }

    return {
      source: "ngspice",
      topology: this._topology ?? {
        matrixSize: this._iterations[0]?.matrixSize ?? 0,
        nodeCount: 0,
        branchCount: 0,
        elementCount: 0,
        elements: [],
        nodeLabels: new Map(),
      },
      steps,
    };
  }

  /**
   * Clean up FFI resources.
   */
  dispose(): void {
    if (this._lib) {
      // Unregister callback
      const registerFn = this._lib.func(
        "void ni_instrument_register(void*)",
      );
      registerFn(null);
      this._lib = null;
    }
  }
}
```

---

## Phase 1e Verification: Files Touched

For completeness, the files modified by Phase 1e (getLteEstimate removal):

| File | Line(s) | Change |
|------|---------|--------|
| `src/solver/analog/element.ts` | 189-203 | Remove `getLteEstimate` declaration |
| `src/solver/analog/element.ts` | 274 | Update doc: `getLteEstimate` -> `getLteTimestep` |
| `src/core/analog-types.ts` | 146-151 | Remove `getLteEstimate` declaration |
| `src/core/analog-types.ts` | 155-159 | Update doc: remove "in preference to getLteEstimate" |
| `src/solver/analog/timestep.ts` | 182 | Update doc: `getLteEstimate` -> `getLteTimestep` |
| `src/components/semiconductors/bjt.ts` | 1056 | Update comment: `getLteEstimate` -> `getLteTimestep` |

---

## Trade-offs

| Decision | Pros | Cons |
|----------|------|------|
| `postIterationHook` on NROptions (not a global) | Zero cost when unused; no global state; composable | Requires wiring through engine.step() call site |
| Snapshot via `getCSCNonZeros()` (allocating objects) | Clean, safe, no aliasing bugs | O(nnz) allocation per iteration when harness active; not for production hot path |
| Device mappings as hand-written constants | Exact control; documents ngspice offset sources | Must be updated manually when schemas change |
| koffi for FFI (not node-ffi-napi) | Active maintenance; no node-gyp rebuild issues; pure JS loader | Less mature than ffi-napi; API may change |
| MOSFET mapping left as placeholder | Honest about current state (no pool migration yet) | Cannot compare MOSFET state until pool migration completes |
| Callback approach for ngspice (vs. polling) | Captures every iteration automatically | Requires modifying ngspice source; callback stability across threads |

## References

- `src/solver/analog/sparse-solver.ts:422-424` -- insertion point for new accessors (after `get cooCount`)
- `src/solver/analog/newton-raphson.ts:78` -- last field of NROptions before closing brace
- `src/solver/analog/newton-raphson.ts:468-471` -- post-blame, pre-convergence-return (hook insertion point)
- `src/solver/analog/analog-engine.ts:839-841` -- convergenceLog getter (insert accessors after)
- `src/solver/analog/analog-engine.ts:349-371` -- NR call site in step() where postIterationHook must be wired
- `src/solver/analog/convergence-log.ts:34-35` -- end of NRAttemptRecord interface
- `src/solver/analog/element.ts:189-203` -- dead getLteEstimate declaration
- `src/solver/analog/element.ts:274` -- stale doc reference
- `src/core/analog-types.ts:146-151` -- dead getLteEstimate declaration
- `src/solver/analog/timestep.ts:182` -- stale doc reference
- `src/components/semiconductors/bjt.ts:1056` -- stale comment
- `ref/ngspice/src/maths/ni/niiter.c:20-21` -- include section for callback infrastructure
- `ref/ngspice/src/maths/ni/niiter.c:194-201` -- convergence check location for callback insertion
- `src/components/passives/capacitor.ts:138-150` -- CAPACITOR_SCHEMA slot layout
- `src/components/passives/inductor.ts:151-164` -- INDUCTOR_SCHEMA slot layout
- `src/components/semiconductors/diode.ts:66-84` -- DIODE_SCHEMA / DIODE_CAP_SCHEMA
- `src/components/semiconductors/bjt.ts:601-612` -- BJT_SIMPLE_SCHEMA
- `src/components/semiconductors/bjt.ts:1024-1079` -- BJT_L1_SCHEMA