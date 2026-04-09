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
    type: string;
    isNonlinear: boolean;
    isReactive: boolean;
    pinNodeIds: readonly number[];
  }>;
  /** Node label map for display. */
  nodeLabels: Map<number, string>;
  /** Row index → label (voltage node or branch current). */
  matrixRowLabels: Map<number, string>;
  /** Column index → label. */
  matrixColLabels: Map<number, string>;
}

// ---------------------------------------------------------------------------
// Limiting event — captured per junction per NR iteration
// ---------------------------------------------------------------------------

/** Voltage limiting event for one junction in one NR iteration. */
export interface LimitingEvent {
  /** Element index in compiled.elements[]. */
  elementIndex: number;
  /** Element label. */
  label: string;
  /** Junction name: "BE", "BC", "GS", "DS", "AK", etc. */
  junction: string;
  /** Limiting function applied. */
  limitType: "pnjlim" | "fetlim" | "limvds";
  /** Input voltage before limiting. */
  vBefore: number;
  /** Output voltage after limiting. */
  vAfter: number;
  /** Whether limiting was actually applied (vAfter differs from vBefore). */
  wasLimited: boolean;
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
  /** RHS after stamp assembly, before factorization and solve. */
  preSolveRhs: Float64Array;
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
  /** Limiting events recorded during this iteration. */
  limitingEvents: LimitingEvent[];
  /** Our element labels that failed convergence this iteration. Empty on converged iteration. */
  convergenceFailedElements: string[];
  /** ngspice device names that failed convergence this iteration (from C callback). */
  ngspiceConvergenceFailedDevices: string[];
}

/** Device state for one element at one iteration. */
export interface ElementStateSnapshot {
  /** Element index in compiled.elements[]. */
  elementIndex: number;
  /** Element label. */
  label: string;
  /** Named state values (slot name -> value). State at current timepoint (state0). */
  slots: Record<string, number>;
  /** State at previous timepoint (state1). Empty Record for non-pool elements. */
  state1Slots: Record<string, number>;
  /** State two timepoints ago (state2). Empty Record for non-pool elements. */
  state2Slots: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Integration coefficients — captured per step for both engines
// ---------------------------------------------------------------------------

/** Integration coefficients ag0/ag1 for a single timestep, from both engines. */
export interface IntegrationCoefficients {
  ours: { ag0: number; ag1: number; method: "backwardEuler" | "trapezoidal" | "gear2"; order: number };
  ngspice: { ag0: number; ag1: number; method: string; order: number };
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
   * The last entry is the accepted attempt.
   */
  attempts?: NRAttempt[];
  /**
   * ngspice CKTmode at this step (if available from extended callback).
   * Useful for distinguishing DC OP phases, transient init, float, etc.
   */
  cktMode?: number;
  /** Integration coefficients for this step, populated for both engines. */
  integrationCoefficients: IntegrationCoefficients;
  /** Analysis phase at this step. */
  analysisPhase: "dcop" | "tranInit" | "tranFloat";
}

// ---------------------------------------------------------------------------
// Device mapping — maps our state slots to ngspice state offsets
// ---------------------------------------------------------------------------

/**
 * A slot whose ngspice-side value is SYNTHESIZED from a formula over the
 * device's CKTstate rather than read from a single offset.
 *
 * Use for our-slots that do not correspond 1:1 to an ngspice state-vector
 * entry — e.g. Norton companion currents (ngspice re-computes these inside
 * the device load routine and discards them), or values held by us in a
 * different form than ngspice stores them (RB_EFF = 1/BJTgx).
 *
 * The `compute` callback receives the full state array and the device's
 * base offset; it should return the synthesized scalar for comparison
 * against our corresponding slot.
 */
export interface DerivedNgspiceSlot {
  /** ngspice state offsets this derived value depends on (documentation/debug). */
  sourceOffsets: readonly number[];
  /** Compute the value from the device's slice of a CKTstate array. */
  compute: (state: Float64Array, base: number) => number;
  /** Optional short explanation for diagnostics. */
  doc?: string;
}

/** Maps one element type's internal state to ngspice state vector offsets. */
export interface DeviceMapping {
  /** Element type name (e.g. "capacitor", "diode", "bjt"). */
  deviceType: string;
  /**
   * Maps our slot name (from StateSchema) to ngspice state offset.
   * The ngspice offset is relative to the device's base in CKTstate0.
   * null means "no corresponding ngspice state" (skip direct comparison).
   * Slots also listed in `derivedNgspiceSlots` ARE compared — the derived
   * entry supplies the ngspice-side value.
   */
  slotToNgspice: Record<string, number | null>;
  /**
   * Maps ngspice state offset (relative) to our slot name.
   * Inverse of slotToNgspice for entries where the mapping is a direct read.
   */
  ngspiceToSlot: Record<number, string>;
  /**
   * Our-slot-name → formula for synthesizing the ngspice-side value from
   * raw CKTstate. Applied by the ngspice-bridge unpacker after the direct
   * `ngspiceToSlot` loop, so these values appear in
   * `ElementStateSnapshot.slots` keyed by the our-slot name and are
   * picked up by the normal comparison path.
   *
   * Formulas should mirror ngspice's own computation (e.g. from bjtload.c)
   * so the comparison is meaningful — not a tautology against our engine.
   */
  derivedNgspiceSlots?: Record<string, DerivedNgspiceSlot>;
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
  /** Device states keyed by component label. */
  components: Record<string, StepEndComponentEntry>;
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
  perElementConvergence: Array<{
    label: string;
    deviceType: string;
    converged: boolean;
    worstDelta: number;
  }>;
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
  perDeviceType: Record<string, { divergenceCount: number; worstAbsDelta: number }>;
  integrationMethod: string | null;
  stateHistoryIssues: {
    state1Mismatches: number;
    state2Mismatches: number;
  };
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
  /** Full CKTstate1 flat array (previous timepoint). */
  state1: Float64Array;
  /** Full CKTstate2 flat array (prev-prev timepoint). */
  state2: Float64Array;
  numStates: number;
  noncon: number;
  converged: boolean;
  /** Simulation time (CKTtime). */
  simTime: number;
  /** Current timestep (CKTdelta). */
  dt: number;
  /** CKTmode flags. */
  cktMode: number;
  /** CKTag[0] — integration coefficient ag0. */
  ag0: number;
  /** CKTag[1] — integration coefficient ag1. */
  ag1: number;
  /** CKTintegrateMethod — 0=BE, 1=trap, 2=gear. */
  integrateMethod: number;
  /** CKTorder — integration order (1 or 2). */
  order: number;
  /** Assembled G matrix non-zeros for this iteration. */
  matrix: MatrixEntry[];
  /** ngspice device names that failed convergence this iteration. */
  ngspiceConvergenceFailedDevices: string[];
  /** Voltage limiting events recorded during this iteration. */
  limitingEvents: Array<{
    deviceName: string;
    junction: string;
    vBefore: number;
    vAfter: number;
    wasLimited: boolean;
  }>;
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

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PaginationOpts {
  /** Skip first N results. Default: 0. */
  offset?: number;
  /** Return at most N results. Default: unlimited for discovery methods,
   *  100 for getDivergences. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Discovery types
// ---------------------------------------------------------------------------

export interface ComponentInfo {
  /** Human-readable label (e.g. "Q1", "R2"). */
  label: string;
  /** Canonical device type (e.g. "bjt", "capacitor"). "unknown" if unrecognized. */
  deviceType: string;
  /** Available state slot names for this component. Empty array if not pool-backed. */
  slotNames: string[];
  /** Pin node labels (e.g. ["Q1:B", "Q1:C", "Q1:E"]). */
  pinLabels: string[];
}

export interface NodeInfo {
  /** Canonical label (e.g. "Q1:C", "R1:A/C1:A"). */
  label: string;
  /** Our MNA node index (1-based, matching TopologySnapshot.nodeLabels key). */
  ourIndex: number;
  /** ngspice node number (-1 if no mapping exists). */
  ngspiceIndex: number;
  /** Labels of components connected to this node. */
  connectedComponents: string[];
}

// ---------------------------------------------------------------------------
// Component slot query types
// ---------------------------------------------------------------------------

/** Snapshot mode: one step, one ComparedValue per matched slot. */
export interface ComponentSlotsSnapshot {
  mode: "snapshot";
  label: string;
  stepIndex: number;
  simTime: number;
  /** Matched slot name → ComparedValue from the final (converged) iteration. */
  slots: Record<string, ComparedValue>;
  /** Slot names that matched the glob patterns. */
  matchedSlots: string[];
  /** Total slots available on this component (before pattern filter). */
  totalSlots: number;
}

/** Trace mode: all steps, converged values only. */
export interface ComponentSlotsTrace {
  mode: "trace";
  label: string;
  /** Step count after stepsRange filter (if any). */
  totalSteps: number;
  /** Matched slot names. */
  matchedSlots: string[];
  /** Per-step converged values for each matched slot. */
  steps: Array<{
    stepIndex: number;
    simTime: number;
    /** slot name → ComparedValue (final iteration of this step). */
    slots: Record<string, ComparedValue>;
  }>;
}

export type ComponentSlotsResult = ComponentSlotsSnapshot | ComponentSlotsTrace;

// ---------------------------------------------------------------------------
// Divergence report types
// ---------------------------------------------------------------------------

export type DivergenceCategory = "voltage" | "state" | "rhs" | "matrix";

export interface DivergenceEntry {
  stepIndex: number;
  iteration: number;
  simTime: number;
  category: DivergenceCategory;
  /** For voltage/rhs: node label. For state: "ComponentLabel:slotName". For matrix: "row,col". */
  label: string;
  ours: number;
  ngspice: number;
  absDelta: number;
  relDelta: number;
  withinTol: boolean;
  /** For state entries: component label. Null for voltage/rhs/matrix. */
  componentLabel: string | null;
  /** For state entries: slot name. Null for voltage/rhs/matrix. */
  slotName: string | null;
}

export interface DivergenceReport {
  /** Total out-of-tolerance entries (before pagination). */
  totalCount: number;
  /** Worst entry per category (absDelta). Null if no divergences in that category. */
  worstByCategory: Record<DivergenceCategory, DivergenceEntry | null>;
  /** Paginated entries sorted by absDelta descending. */
  entries: DivergenceEntry[];
}

// ---------------------------------------------------------------------------
// Slot trace
// ---------------------------------------------------------------------------

export interface SlotTrace {
  label: string;
  slotName: string;
  /** Total steps (before pagination). */
  totalSteps: number;
  /** Converged value per accepted step (final iteration). */
  steps: Array<{
    stepIndex: number;
    simTime: number;
    value: ComparedValue;
  }>;
}

// ---------------------------------------------------------------------------
// State history
// ---------------------------------------------------------------------------

export interface StateHistoryReport {
  label: string;
  stepIndex: number;
  iteration: number;
  /** state0 slots from our engine. */
  state0: Record<string, number>;
  /** state1 slots from our engine (previous step accepted values). */
  state1: Record<string, number>;
  /** state2 slots from our engine (two steps back). */
  state2: Record<string, number>;
  /** state0 slots from ngspice. */
  ngspiceState0: Record<string, number>;
  /** state1 slots from ngspice (CKTstate1). */
  ngspiceState1: Record<string, number>;
  /** state2 slots from ngspice (CKTstate2). */
  ngspiceState2: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Labeled matrix / RHS
// ---------------------------------------------------------------------------

export interface LabeledMatrixEntry {
  row: number;
  col: number;
  rowLabel: string;
  colLabel: string;
  ours: number;
  ngspice: number;
  absDelta: number;
  withinTol: boolean;
}

export interface LabeledMatrix {
  stepIndex: number;
  iteration: number;
  matrixSize: number;
  entries: LabeledMatrixEntry[];
}

export interface LabeledRhsEntry {
  index: number;
  label: string;
  ours: number;
  ngspice: number;
  absDelta: number;
  withinTol: boolean;
}

export interface LabeledRhs {
  stepIndex: number;
  iteration: number;
  entries: LabeledRhsEntry[];
}

// ---------------------------------------------------------------------------
// Matrix comparison
// ---------------------------------------------------------------------------

export interface MatrixComparisonEntry {
  row: number;
  col: number;
  rowLabel: string;
  colLabel: string;
  ours: number;
  ngspice: number;
  delta: number;
  absDelta: number;
  withinTol: boolean;
}

export interface MatrixComparison {
  stepIndex: number;
  iteration: number;
  filter: "all" | "mismatches";
  totalEntries: number;
  mismatchCount: number;
  maxAbsDelta: number;
  entries: MatrixComparisonEntry[];
}

// ---------------------------------------------------------------------------
// Integration coefficients
// ---------------------------------------------------------------------------

export interface IntegrationCoefficientsReport {
  stepIndex: number;
  ours: { ag0: number; ag1: number; method: string; order: number };
  ngspice: { ag0: number; ag1: number; method: string; order: number };
  /** True if method and order agree between engines. */
  methodMatch: boolean;
  ag0Compared: ComparedValue;
  ag1Compared: ComparedValue;
}

// ---------------------------------------------------------------------------
// Junction limiting
// ---------------------------------------------------------------------------

export interface JunctionLimitingEntry {
  junction: string;
  ourPreLimit: number;
  ourPostLimit: number;
  ourDelta: number;
  ngspicePreLimit: number;
  ngspicePostLimit: number;
  ngspiceDelta: number;
  /** Signed difference of applied limiting: ourDelta - ngspiceDelta */
  limitingDiff: number;
}

export interface LimitingComparisonReport {
  label: string;
  stepIndex: number;
  iteration: number;
  /** One entry per junction that had a limiting event in either engine. */
  junctions: JunctionLimitingEntry[];
  /** True if no limiting events found for this component at this iteration. */
  noEvents: boolean;
}

// ---------------------------------------------------------------------------
// Convergence detail
// ---------------------------------------------------------------------------

export interface ConvergenceElementEntry {
  label: string;
  deviceType: string;
  ourConverged: boolean;
  ngspiceConverged: boolean;
  /** Worst absDelta across all slots for this component at this iteration. */
  worstDelta: number;
  /** True if both engines agree on convergence status. */
  agree: boolean;
}

export interface ConvergenceDetailReport {
  stepIndex: number;
  iteration: number;
  ourNoncon: number;
  ngspiceNoncon: number;
  ourGlobalConverged: boolean;
  ngspiceGlobalConverged: boolean;
  elements: ConvergenceElementEntry[];
  /** Count of elements where engines disagree on convergence. */
  disagreementCount: number;
}

// ---------------------------------------------------------------------------
// Enhanced StepEndReport component entry
// ---------------------------------------------------------------------------

/** Replaces Record<string, ComparedValue> in StepEndReport.components */
export interface StepEndComponentEntry {
  deviceType: string;
  slots: Record<string, ComparedValue>;
}

// ---------------------------------------------------------------------------
// Session report (toJSON output)
// ---------------------------------------------------------------------------

export interface SessionReport {
  analysis: "dcop" | "tran";
  stepCount: { ours: number; ngspice: number };
  nodeCount: number;
  elementCount: number;
  summary: {
    totalCompared: number;
    passed: number;
    failed: number;
    firstDivergence: {
      stepIndex: number;
      iterationIndex: number;
      simTime: number;
      worstLabel: string;
      absDelta: number;
    } | null;
    perDeviceType: Record<string, { divergenceCount: number; worstAbsDelta: number }>;
    integrationMethod: string | null;
    stateHistoryIssues: { state1Mismatches: number; state2Mismatches: number };
  };
  steps: Array<{
    stepIndex: number;
    simTime: number;
    dt: number;
    converged: { ours: boolean; ngspice: boolean };
    iterationCount: { ours: number; ngspice: number };
    nodes: Record<string, {
      ours: number | null;
      ngspice: number | null;
      absDelta: number | null;
      withinTol: boolean;
    }>;
    components: Record<string, {
      deviceType: string;
      slots: Record<string, {
        ours: number | null;
        ngspice: number | null;
        absDelta: number | null;
        withinTol: boolean;
      }>;
    }>;
  }>;
}
