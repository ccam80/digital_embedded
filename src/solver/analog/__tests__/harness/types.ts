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
