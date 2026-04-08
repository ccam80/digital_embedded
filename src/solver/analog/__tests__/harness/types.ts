/**
 * Common types for the ngspice comparison harness.
 *
 * These types define the neutral interchange format used to compare
 * our MNA engine's per-NR-iteration state against ngspice's. Both
 * sides produce data in these types; the comparator operates on them.
 */

// ---------------------------------------------------------------------------
// Compared value — the fundamental triple for side-by-side comparison
// ---------------------------------------------------------------------------

/** A single numeric value from both engines, with computed delta. */
export interface ComparedValue {
  ours: number;
  ngspice: number;
  delta: number;       // ours - ngspice (signed)
  absDelta: number;    // |delta|
  relDelta: number;    // |delta| / max(|ours|, |ngspice|), 0 if both zero
  withinTol: boolean;
}

// ---------------------------------------------------------------------------
// Topology snapshot — captured once per compile
// ---------------------------------------------------------------------------

/** MNA matrix non-zero entry. */
export interface MatrixEntry {
  row: number;
  col: number;
  value: number;
}

/**
 * Maps a single node between our engine and ngspice.
 *
 * Built by the structural node-mapping pass which canonicalizes
 * ngspice node names ("q1_c", "v1#branch") to our labels ("Q1:C", "V1:branch").
 */
export interface NodeMapping {
  /** Our MNA node index (0-based, solver row). */
  ourIndex: number;
  /** ngspice node number (from CKTnodes linked list, 0-based). */
  ngspiceIndex: number;
  /** Canonical label in our format (e.g. "Q1:C", "R1:A"). */
  label: string;
  /** Original ngspice node name (e.g. "q1_c", "r1_1"). */
  ngspiceName: string;
}

/**
 * Maps a single device's state base offset in the ngspice CKTstate0 vector.
 * Received from the ngspice topology callback.
 */
export interface NgspiceDeviceInfo {
  /** Device instance name in ngspice (e.g. "q1", "d1"). */
  name: string;
  /** Device type name in ngspice (e.g. "BJT", "Diode", "Capacitor"). */
  typeName: string;
  /** Base offset of this device's state in CKTstate0. */
  stateBase: number;
  /** Node indices connected to this device (from the ngspice CKT). */
  nodeIndices: number[];
}

/**
 * Full topology from ngspice, received via the one-time topology callback.
 * Used to build NodeMapping[] and unpack CKTstate0 into per-device slots.
 */
export interface NgspiceTopology {
  /** Matrix dimension (CKTmaxEqNum + 1). */
  matrixSize: number;
  /** Number of state entries (CKTnumStates). */
  numStates: number;
  /** Node name → node number mapping. */
  nodeNames: Map<string, number>;
  /** Per-device info for state unpacking. */
  devices: NgspiceDeviceInfo[];
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
    type?: string;
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
  /** RHS vector snapshot (copy) — the loaded RHS before solve (stamp contributions). */
  rhs: Float64Array;
  /** Pre-solve RHS (if available from ngspice extended callback). */
  preSolveRhs?: Float64Array;
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

/**
 * A single NR solve attempt. A step may have multiple attempts if the
 * timestep is cut after NR failure. Each attempt has its own dt and
 * iteration history.
 */
export interface NRAttempt {
  /** Attempted timestep dt. */
  dt: number;
  /** All NR iterations in this attempt. */
  iterations: IterationSnapshot[];
  /** Whether NR converged in this attempt. */
  converged: boolean;
  /** Total iteration count in this attempt. */
  iterationCount: number;
}

/** All iterations for one timestep (may include failed attempts before the accepted one). */
export interface StepSnapshot {
  /** Simulation time at step entry. */
  simTime: number;
  /** Timestep dt (of the accepted attempt). */
  dt: number;
  /** All NR iterations of the accepted attempt (shortcut into attempts[last]). */
  iterations: IterationSnapshot[];
  /** Whether NR converged (for the accepted attempt). */
  converged: boolean;
  /** Total iteration count (for the accepted attempt). */
  iterationCount: number;
  /**
   * All NR attempts for this step, including failed ones where dt was cut.
   * The last entry is the accepted attempt. Undefined means legacy data
   * where only the accepted attempt was captured (use iterations/converged directly).
   */
  attempts?: NRAttempt[];
  /**
   * ngspice CKTmode at this step (if available from extended callback).
   * Useful for distinguishing DC OP phases, transient init, float, etc.
   */
  cktMode?: number;
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

// ---------------------------------------------------------------------------
// ComparisonSession query result types
// ---------------------------------------------------------------------------

/** Step-end report: converged values from both engines, keyed by label. */
export interface StepEndReport {
  stepIndex: number;
  simTime: ComparedValue;
  dt: ComparedValue;
  converged: { ours: boolean; ngspice: boolean };
  iterationCount: ComparedValue;
  /** Node voltages keyed by canonical label ("Q1:C", "R1:A"). */
  nodes: Record<string, ComparedValue>;
  /** Branch currents keyed by label ("V1:branch"). */
  branches: Record<string, ComparedValue>;
  /** Device states keyed by component label, then slot name. */
  components: Record<string, Record<string, ComparedValue>>;
}

/** Per-iteration report: intermediate NR state from both engines. */
export interface IterationReport {
  stepIndex: number;
  iteration: number;
  simTime: number;
  noncon: ComparedValue;
  /** Node voltages keyed by canonical label. */
  nodes: Record<string, ComparedValue>;
  /** RHS values keyed by node label. */
  rhs: Record<string, ComparedValue>;
  /** Matrix entry differences (only mismatches). */
  matrixDiffs: Array<{
    row: number;
    col: number;
    ours: number;
    ngspice: number;
    absDelta: number;
  }>;
  /** Device states keyed by component label, then slot name. */
  components: Record<string, Record<string, ComparedValue>>;
}

/** Full trace for one component across all steps and iterations. */
export interface ComponentTrace {
  label: string;
  deviceType: string;
  steps: Array<{
    stepIndex: number;
    simTime: number;
    iterations: Array<{
      iteration: number;
      states: Record<string, ComparedValue>;
      pinVoltages: Record<string, ComparedValue>;
    }>;
  }>;
}

/** Full trace for one node across all steps and iterations. */
export interface NodeTrace {
  label: string;
  ourIndex: number;
  ngspiceIndex: number;
  steps: Array<{
    stepIndex: number;
    simTime: number;
    iterations: Array<{
      iteration: number;
      voltage: ComparedValue;
    }>;
  }>;
}

/** Aggregate session summary. */
export interface SessionSummary {
  analysis: "dcop" | "tran";
  stepCount: ComparedValue;
  convergence: {
    ours: { totalSteps: number; convergedSteps: number; failedSteps: number; avgIterations: number; maxIterations: number };
    ngspice: { totalSteps: number; convergedSteps: number; failedSteps: number; avgIterations: number; maxIterations: number };
  };
  /** First iteration where any value exceeds tolerance. */
  firstDivergence: { stepIndex: number; iterationIndex: number; simTime: number; worstLabel: string; absDelta: number } | null;
  /** Total comparison count and pass/fail breakdown. */
  totals: { compared: number; passed: number; failed: number };
}

// ---------------------------------------------------------------------------
// Raw ngspice callback data (extended)
// ---------------------------------------------------------------------------

/**
 * Extended raw data from the ngspice NR instrumentation callback.
 * Matches the C typedef in niiter.c after the callback is expanded
 * to include time, dt, mode, and pre-solve RHS.
 */
export interface RawNgspiceIterationEx {
  iteration: number;
  matrixSize: number;
  /** Post-solve voltages (CKTrhs after SMPsolve). */
  rhs: Float64Array;
  /** Previous voltages (CKTrhsOld). */
  rhsOld: Float64Array;
  /** Pre-solve RHS (copy of CKTrhs after CKTload, before SMPsolve). */
  preSolveRhs: Float64Array;
  /** Full CKTstate0 flat array. */
  state0: Float64Array;
  numStates: number;
  noncon: number;
  converged: boolean;
  /** Simulation time (CKTtime). */
  simTime: number;
  /** Current timestep (CKTdelta). */
  dt: number;
  /** CKTmode flags. */
  cktMode: number;
}

/**
 * One-time topology data from ngspice (sent before first NR iteration).
 */
export interface RawNgspiceTopology {
  matrixSize: number;
  numStates: number;
  /** Node name → node number. */
  nodes: Array<{ name: string; number: number }>;
  /** Per-device state base offsets. */
  devices: Array<{
    name: string;
    typeName: string;
    stateBase: number;
    nodeIndices: number[];
  }>;
}
