/**
 * Common types for the ngspice comparison harness.
 *
 * These types define the neutral interchange format used to compare
 * our MNA engine's per-NR-iteration state against ngspice's. Both
 * sides produce data in these types; the comparator operates on them.
 */

import type { PostIterationHook } from "./capture.js";
import type { MNAEngine } from "../../analog-engine.js";
import type { IntegrationMethod } from "../../integration.js";

// ---------------------------------------------------------------------------
// Asymmetric step presence (Goal B)
// ---------------------------------------------------------------------------

/** Indicates which side(s) actually produced a step at a given index. */
export type SidePresence = "both" | "oursOnly" | "ngspiceOnly";

/** Side selector for time-based queries. Disjoint from SidePresence. */
export type Side = "ours" | "ngspice";

/** Compact summary of one NR attempt- used in shape reports. */
export interface AttemptShapeSummary {
  phase: NRPhase;
  outcome: NRAttemptOutcome;
  dt: number;
  iterationCount: number;
  converged: boolean;
}

/** Counts of attempts grouped by phase / outcome- used for fast diff. */
export interface AttemptCounts {
  byPhase: Partial<Record<NRPhase, number>>;
  byOutcome: Partial<Record<NRAttemptOutcome, number>>;
  total: number;
}

/** Per-step shape descriptor. Always populated for both sides where present. */
export interface StepShape {
  stepIndex: number;
  presence: SidePresence;
  /** stepStartTime as reported by each side; null when that side is absent. */
  stepStartTime: { ours: number | null; ngspice: number | null };
  stepEndTime:   { ours: number | null; ngspice: number | null };
  /** Difference of stepStartTime in seconds (ours - ngspice). null if any side absent. */
  stepStartTimeDelta: number | null;
  /** Per-side attempt counts. Each is null when that side is absent. */
  attemptCounts: { ours: AttemptCounts | null; ngspice: AttemptCounts | null };
  /** Per-side attempt summaries (length-limited; full detail is on the StepSnapshot). */
  attempts: { ours: AttemptShapeSummary[] | null; ngspice: AttemptShapeSummary[] | null };
  /** Final integration method per side; null when absent. */
  integrationMethod: { ours: IntegrationMethod | null; ngspice: IntegrationMethod | null };
}

/** Whole-session shape descriptor. */
export interface SessionShape {
  analysis: "dcop" | "tran";
  stepCount: { ours: number; ngspice: number; max: number };
  presenceCounts: { both: number; oursOnly: number; ngspiceOnly: number };
  steps: StepShape[];
  /** Indices where stepStartTimeDelta exceeds tolerance (reported, not filtered). */
  largeTimeDeltas: Array<{ stepIndex: number; delta: number }>;
}

/** Bundle of all instrumentation hooks the comparison harness needs. */
export interface PhaseAwareCaptureHook {
  /** Per-NR-iteration hook (fires inside newton-raphson.ts loop). */
  iterationHook: PostIterationHook;
  /**
   * Optional pre-factor hook. Fires between cktLoad and solver.preorder()/factor()
   * (newton-raphson.ts STEP B+; ngspice niiter.c:704). Window where the
   * assembled MNA still holds post-load, pre-LU values- only place a
   * harness can read the matrix solver.factor() is about to overwrite.
   */
  preFactorHook?: (ctx: import("../../ckt-context.js").CKTCircuitContext) => void;
  /** Phase begin/end hook (fires from analog-engine and dc-operating-point). */
  phaseHook: MNAEngine["stepPhaseHook"];
}

// ---------------------------------------------------------------------------
// Compared value- the fundamental triple for side-by-side comparison
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
// Topology snapshot- captured once per compile
// ---------------------------------------------------------------------------

/** MNA matrix non-zero entry. */
export interface MatrixEntry {
  row: number;
  col: number;
  value: number;
}

/**
 * Maps a single node between our engine and ngspice.
 */
export interface NodeMapping {
  ourIndex: number;
  ngspiceIndex: number;
  label: string;
  ngspiceName: string;
}

/**
 * Maps a single device's state base offset in the ngspice CKTstate0 vector.
 */
export interface NgspiceDeviceInfo {
  name: string;
  typeName: string;
  stateBase: number;
  nodeIndices: number[];
}

/**
 * Full topology from ngspice, received via the one-time topology callback.
 */
export interface NgspiceTopology {
  matrixSize: number;
  numStates: number;
  nodeNames: Map<string, number>;
  devices: NgspiceDeviceInfo[];
}

/** Captured once after compile- describes the circuit structure. */
export interface TopologySnapshot {
  matrixSize: number;
  nodeCount: number;
  elementCount: number;
  elements: Array<{
    index: number;
    label: string;
    type: string;
    pinNodeIds: readonly number[];
  }>;
  nodeLabels: Map<number, string>;
  matrixRowLabels: Map<number, string>;
  matrixColLabels: Map<number, string>;
}

// ---------------------------------------------------------------------------
// Limiting event- captured per junction per NR iteration
// ---------------------------------------------------------------------------

// Single source of truth lives at src/solver/analog/newton-raphson.ts.
// Re-exported here so harness consumers can import LimitingEvent from this
// barrel without taking a direct dependency on the NR module.
export type { LimitingEvent } from "../../newton-raphson.js";

// ---------------------------------------------------------------------------
// Per-iteration snapshot
// ---------------------------------------------------------------------------

/** State captured at a single NR iteration. */
export interface IterationSnapshot {
  iteration: number;
  /**
   * ngspice setup-counter convention. ngspice initializes `CKTmaxEqNum = 1`
   * (cktinit.c:43) and post-increments it for every CKTmkVolt/CKTmkCur call
   * (cktlnkeq.c:32). After N active equations CKTmaxEqNum = 1 + N, and
   * `matrixSize = CKTmaxEqNum + 1 = N + 2`- one slot for ground (idx 0),
   * N slots for active equations (idx 1..N), plus 1 post-inc tracker slot.
   * The post-inc slot is NOT an actual rhs/matrix entry- it's setup
   * bookkeeping. Real rhs allocation is rhsBufSize.
   *
   * Both sides report this same N+2 convention so the structural-parity
   * gate (ComparisonSession._assertMatrixStructuralParity) can compare like
   * for like. Carried per-iteration because the gate runs at every step-
   * a session-level constant would mask intra-run drift, which would itself
   * be an architectural bug.
   */
  matrixSize: number;
  /**
   * Actual allocation length of the rhs / rhsOld / preSolveRhs buffers.
   * - Our engine: `voltages.length` (no TrashCan equivalent).
   * - ngspice: `SMPmatSize(CKTmatrix) + 1`. Can be smaller than matrixSize
   *   when devices stamp into ground via TrashCan (niiter.c).
   * Both sides should equal N+1 for circuits with no TrashCan folding.
   */
  rhsBufSize: number;
  voltages: Float64Array;
  prevVoltages: Float64Array;
  preSolveRhs: Float64Array;
  matrix: MatrixEntry[];
  elementStates: ElementStateSnapshot[];
  noncon: number;
  diagGmin: number;
  srcFact: number;
  /**
   * Human-readable decoded `cktMode` label, produced by `bitsToName(cktMode)`
   * from ckt-mode.ts (cktdefs.h:165-185). Example values:
   *   - "MODEDCOP|MODEINITJCT"
   *   - "MODETRAN|MODEINITFLOAT"
   *   - "MODETRAN"
   *   - "MODE_NONE"
   */
  initMode: string;
  /**
   * Integration order active at this NR iteration (1 = order-1 trap/gear, 2 = order-2 trap/gear).
   * Set per-iteration from `ctx.loadCtx.order` for our engine and from the
   * ngspice NiIterationData.order FFI field. Populated by createIterationCaptureHook
   * and ngspice-bridge at iteration time- no longer painted at step-end.
   */
  order: number;
  delta: number;
  /**
   * Integration coefficients (CKTag[]) active at this NR iteration. Length 7,
   * matching ngspice MAXORDER+1. Only slots 0 and 1 are populated on the
   * ngspice side (FFI marshals ag0/ag1 only); remaining slots are 0.
   * A fresh copy is taken per iteration- ctx.ag is a live buffer.
   */
  ag: Float64Array;
  /**
   * Integration method active at this NR iteration ("trapezoidal" | "gear").
   * Captured from `ctx.loadCtx.method` (our engine) or derived from
   * ngspice's NiIterationData.integrateMethod code.
   */
  method: IntegrationMethod;
  globalConverged: boolean;
  elemConverged: boolean;
  limitingEvents: LimitingEvent[];
  convergenceFailedElements: string[];
  ngspiceConvergenceFailedDevices: string[];
  /**
   * LTE-proposed next timestep (seconds) as computed after this iteration's
   * accepted step. Populated on the final accepted iteration of each step
   * from our TimestepController (our engine) or from RawNgspiceOuterEvent.nextDelta
   * (ngspice side). Undefined for non-accepted or DC-OP iterations.
   */
  lteDt?: number;
}

/** Device state for one element at one iteration. */
export interface ElementStateSnapshot {
  elementIndex: number;
  label: string;
  slots: Record<string, number>;
  state1Slots: Record<string, number>;
  state2Slots: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Integration coefficients- captured per step for both engines
// ---------------------------------------------------------------------------

/** Integration coefficients ag0/ag1 for a single timestep, from both engines. */
export interface IntegrationCoefficients {
  ours: { ag0: number; ag1: number; method: IntegrationMethod; order: number };
  ngspice: { ag0: number; ag1: number; method: string; order: number };
}

// ---------------------------------------------------------------------------
// NR phase and outcome enumerations (spec ss3)
// ---------------------------------------------------------------------------

/**
 * Semantic role of a single NR solve attempt- orthogonal to phase name.
 * Two attempts can share a phase name (e.g. "dcopInitFloat") but represent
 * entirely different operations; role disambiguates them for pairing.
 */
export type AttemptRole =
  // DC OP (existing)
  | "coldStart"      // first iterate with zero/default initial guess (our dcopInitFloat)
  | "mainSolve"      // the real NR refinement pass (both sides' dcopDirect)
  | "finalVerify"    // 1-iter verification after converged state (ngspice's last dcopInitFloat)
  | "junctionPrime"  // ngspice MODEINITJCT priming pass
  // Tran
  | "predictorPass"  // ngspice MODEINITPRED retry- always fails by design
  | "tranSolve";     // the NR pass that produces the accepted step result (both sides)

/**
 * Identifies the algorithmic phase of a single NR solve attempt.
 */
export type NRPhase =
  | "dcopInitJct"
  | "dcopInitFix"
  | "dcopInitFloat"
  | "dcopDirect"
  | "dcopGminDynamic"
  | "dcopGminSpice3"
  | "dcopSrcSweep"
  | "tranInit"
  | "tranPredictor"
  | "tranNR";

/**
 * Outcome of a single NR solve attempt.
 */
export type NRAttemptOutcome =
  | "accepted"
  | "nrFailedRetry"
  | "lteRejectedRetry"
  | "dcopSubSolveConverged"
  | "dcopPhaseHandoff"
  | "tranPhaseHandoff"
  | "finalFailure";

// ---------------------------------------------------------------------------
// Per-step snapshot (aggregates NR attempts within one timestep)
// ---------------------------------------------------------------------------

/**
 * A single NR solve attempt within a step.
 */
export interface NRAttempt {
  dt: number;
  iterations: IterationSnapshot[];
  converged: boolean;
  iterationCount: number;
  phase: NRPhase;
  outcome: NRAttemptOutcome;
  phaseParameter?: number;
  role?: AttemptRole;
}

/**
 * All NR attempts for one conceptual timestep.
 * Canonical identifier: stepStartTime (simTime BEFORE any NR attempt).
 */
export interface StepSnapshot {
  stepStartTime: number;
  stepEndTime: number;
  attempts: NRAttempt[];
  acceptedAttemptIndex: number;
  accepted: boolean;
  dt: number;
  iterations: IterationSnapshot[];
  converged: boolean;
  iterationCount: number;
  totalIterationCount: number;
  cktMode?: number;
  integrationCoefficients: IntegrationCoefficients;
  analysisPhase: "dcop" | "tranInit" | "tranFloat";
}

// ---------------------------------------------------------------------------
// Device mapping- maps our state slots to ngspice state offsets
// ---------------------------------------------------------------------------

export interface DeviceMapping {
  deviceType: string;
  slotToNgspice: Record<string, number | null>;
  ngspiceToSlot: Record<number, string>;
}

// ---------------------------------------------------------------------------
// Comparison result
// ---------------------------------------------------------------------------

/** One comparison between our snapshot and ngspice's at one iteration. */
export interface ComparisonResult {
  stepIndex: number;
  iterationIndex: number;
  stepStartTime: number;
  presence: SidePresence;
  voltageDiffs: Array<{
    nodeIndex: number;
    label: string;
    ours: number;
    theirs: number;
    absDelta: number;
    relDelta: number;
    withinTol: boolean;
  }>;
  rhsDiffs: Array<{
    index: number;
    ours: number;
    theirs: number;
    absDelta: number;
    withinTol: boolean;
  }>;
  matrixDiffs: Array<{
    row: number;
    col: number;
    ours: number;
    theirs: number;
    absDelta: number;
    withinTol: boolean;
  }>;
  stateDiffs: Array<{
    elementLabel: string;
    slotName: string;
    ours: number;
    theirs: number;
    absDelta: number;
    withinTol: boolean;
  }>;
  allWithinTol: boolean;
  /** True when our stepEndTime and ngspice stepEndTime differ by more than timeDeltaTol- these steps represent different physical moments and should not be treated as real divergences. */
  timeMismatched: boolean;
}

// ---------------------------------------------------------------------------
// Capture session- holds all snapshots for one simulation run
// ---------------------------------------------------------------------------

/** Complete capture from one simulation run. */
export interface CaptureSession {
  source: "ours" | "ngspice";
  topology: TopologySnapshot;
  steps: StepSnapshot[];
}

// ---------------------------------------------------------------------------
// Query API types
// ---------------------------------------------------------------------------

/** Query predicate for filtering snapshots. */
export interface SnapshotQuery {
  stepRange?: { from: number; to: number };
  timeRange?: { from: number; to: number };
  converged?: boolean;
  minIterations?: number;
  elementLabel?: string;
  nodeIndex?: number;
}

// ---------------------------------------------------------------------------
// ComparisonSession query result types
// ---------------------------------------------------------------------------

/** Step-end report: converged values from both engines, keyed by label. */
export interface StepEndReport {
  stepIndex: number;
  ourStepIndex: number;
  ngspiceStepIndex: number;
  presence: SidePresence;
  stepStartTime: ComparedValue;
  stepEndTime: ComparedValue;
  dt: ComparedValue;
  converged: { ours: boolean; ngspice: boolean };
  iterationCount: ComparedValue;
  nodes: Record<string, ComparedValue>;
  branches: Record<string, ComparedValue>;
  components: Record<string, StepEndComponentEntry>;
}

/** Per-iteration report: intermediate NR state from both engines. */
export interface IterationReport {
  stepIndex: number;
  iteration: number;
  stepStartTime: number;
  noncon: ComparedValue;
  nodes: Record<string, ComparedValue>;
  rhs: Record<string, ComparedValue>;
  matrixDiffs: Array<{
    row: number;
    col: number;
    ours: number;
    ngspice: number;
    absDelta: number;
  }>;
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
    stepStartTime: number;
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
    stepStartTime: number;
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
  presenceCounts: { both: number; oursOnly: number; ngspiceOnly: number };
  worstStepStartTimeDelta: number;
  convergence: {
    ours: { totalSteps: number; convergedSteps: number; failedSteps: number; avgIterations: number; maxIterations: number };
    ngspice: { totalSteps: number; convergedSteps: number; failedSteps: number; avgIterations: number; maxIterations: number };
  };
  firstDivergence: { stepIndex: number; iterationIndex: number; stepStartTime: number; worstLabel: string; absDelta: number } | null;
  totals: { compared: number; passed: number; failed: number };
  perDeviceType: Record<string, { divergenceCount: number; worstAbsDelta: number }>;
  integrationMethod: IntegrationMethod | null;
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
 */
export interface RawNgspiceIterationEx {
  iteration: number;
  matrixSize: number;
  /**
   * SMPmatSize+1- actual rhs/rhsOld/preSolveRhs slot count on the ngspice side.
   * Can be smaller than matrixSize when CKTmaxEqNum > SMPmatSize (devices stamp
   * into ground row/col via TrashCan). The bridge clamps the FFI decode to this
   * value to prevent OOB reads that surface as NaN bit-pattern garbage.
   */
  rhsBufSize: number;
  rhs: Float64Array;
  rhsOld: Float64Array;
  preSolveRhs: Float64Array;
  state0: Float64Array;
  state1: Float64Array;
  state2: Float64Array;
  numStates: number;
  noncon: number;
  converged: boolean;
  simTime: number;
  simTimeStart: number;
  dt: number;
  cktMode: number;
  ag0: number;
  ag1: number;
  integrateMethod: number;
  order: number;
  phaseFlags: number;
  phaseGmin: number;
  phaseSrcFact: number;
  matrix: MatrixEntry[];
  ngspiceConvergenceFailedDevices: string[];
  limitingEvents: Array<{
    deviceName: string;
    junction: string;
    vBefore: number;
    vAfter: number;
    wasLimited: boolean;
  }>;
}

/**
 * Raw data from the ngspice outer-loop callback (ni_outer_cb).
 */
export interface RawNgspiceOuterEvent {
  simTimeStart: number;
  delta: number;
  lteRejected: number;
  nrFailed: number;
  accepted: number;
  finalFailure: number;
  nextDelta: number;
}

/**
 * One-time topology data from ngspice (sent before first NR iteration).
 */
export interface RawNgspiceTopology {
  matrixSize: number;
  numStates: number;
  nodes: Array<{ name: string; number: number }>;
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
  offset?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Discovery types
// ---------------------------------------------------------------------------

export interface ComponentInfo {
  label: string;
  deviceType: string;
  slotNames: string[];
  pinLabels: string[];
}

export interface NodeInfo {
  label: string;
  ourIndex: number;
  ngspiceIndex: number;
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
  stepStartTime: number;
  slots: Record<string, ComparedValue>;
  matchedSlots: string[];
  totalSlots: number;
}

/** Trace mode: all steps, converged values only. */
export interface ComponentSlotsTrace {
  mode: "trace";
  label: string;
  totalSteps: number;
  matchedSlots: string[];
  steps: Array<{
    stepIndex: number;
    stepStartTime: number;
    slots: Record<string, ComparedValue>;
  }>;
}

export type ComponentSlotsResult = ComponentSlotsSnapshot | ComponentSlotsTrace;

// ---------------------------------------------------------------------------
// Divergence report types
// ---------------------------------------------------------------------------

export type DivergenceCategory = "voltage" | "state" | "rhs" | "matrix" | "shape";

export interface DivergenceEntry {
  stepIndex: number;
  iteration: number;
  stepStartTime: number;
  category: DivergenceCategory;
  label: string;
  ours: number;
  ngspice: number;
  absDelta: number;
  relDelta: number;
  withinTol: boolean;
  componentLabel: string | null;
  slotName: string | null;
  presence: SidePresence;
}

export interface DivergenceReport {
  totalCount: number;
  worstByCategory: Record<DivergenceCategory, DivergenceEntry | null>;
  entries: DivergenceEntry[];
}

// ---------------------------------------------------------------------------
// Slot trace
// ---------------------------------------------------------------------------

export interface SlotTrace {
  label: string;
  slotName: string;
  totalSteps: number;
  steps: Array<{
    stepIndex: number;
    stepStartTime: number;
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
  state0: Record<string, number>;
  state1: Record<string, number>;
  state2: Record<string, number>;
  ngspiceState0: Record<string, number>;
  ngspiceState1: Record<string, number>;
  ngspiceState2: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Labeled matrix / RHS
// ---------------------------------------------------------------------------

export type MatrixEntrySentinel =
  | { kind: "engineSpecific"; presentSide: "ngspice" }
  | { kind: "captureMissing"; side: "ours" | "ngspice" };

export interface LabeledMatrixEntry {
  row: number;
  col: number;
  rowLabel: string;
  colLabel: string;
  entryKind: "both" | "engineSpecific" | "captureMissing";
  ours: number | MatrixEntrySentinel;
  ngspice: number | MatrixEntrySentinel;
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
// Paired session-shape API
// ---------------------------------------------------------------------------

export interface AttemptShapeRow {
  index: number;
  phase: NRPhase;
  outcome: NRAttemptOutcome;
  iterationCount: number;
  phaseParameter?: number;
  accepted: boolean;
}

export interface StepShapeRow {
  index: number;
  stepStartTime: number;
  stepEndTime: number;
  converged: boolean;
  iterationCount: number;        // accepted attempt
  totalIterationCount: number;   // sum over attempts
  analysisPhase: "dcop" | "tranInit" | "tranFloat";
  attempts: AttemptShapeRow[];
}

export interface SessionMap {
  analysis: "dcop" | "tran";
  ours:    { stepCount: number; steps: StepShapeRow[] };
  ngspice: { stepCount: number; steps: StepShapeRow[] };
}

export interface AttemptSummary {
  index: number;
  phase: NRPhase;
  role?: AttemptRole;
  outcome: NRAttemptOutcome;
  iterationCount: number;
  phaseParameter?: number;
  accepted: boolean;
  endNodeNorm: number;    // L2 norm over final iter rows [1, nodeCount]
  endBranchNorm: number;  // L2 norm over final iter rows [nodeCount, matrixSize]
}

export interface PairedAttempt {
  phase: NRPhase;
  role?: AttemptRole;
  ourIndex: number | null;
  ngspiceIndex: number | null;
  divergenceNorm: number;   // L2 norm of (ours.voltages - ngspice.voltages) over matching rows; NaN if either side null
}

export interface StepDetail {
  stepIndex: number;
  ourStepIndex: number;
  ngspiceStepIndex: number;
  stepStartTime: ComparedValue;
  stepEndTime: ComparedValue;
  dt: ComparedValue;
  ours: AttemptSummary[];
  ngspice: AttemptSummary[];
  pairing: PairedAttempt[];
}

export type StepQuery =
  | { index: number }
  | { time: number; side?: "ours" | "ngspice" };

export interface IterationSideData {
  rawIteration: number;
  globalConverged: boolean;
  /**
   * Element-level convergence flag at the end of this iteration.
   * Distinct from `globalConverged`- the latter additionally requires
   * `noncon === 0` whereas this is the per-element predicate alone.
   */
  elemConverged: boolean;
  noncon: number;
  /**
   * Element labels that flunked the per-element convergence predicate at
   * this iteration. Same namespace as `elementStates` keys.
   */
  convergenceFailedElements: string[];
  /**
   * ngspice-side counterpart of `convergenceFailedElements`. Only populated
   * on the ngspice `IterationSideData`; absent on our side.
   */
  ngspiceConvergenceFailedDevices?: string[];
  /** Node voltages AFTER this iteration's linear solve (post-solve result). */
  nodeVoltages: Record<string, number>;
  /**
   * Node voltages BEFORE this iteration's linear solve (iter.prevVoltages).
   * For iter 0 this is the initial guess (DC-OP seed for tranInit).
   * Used when computing the residual A·v_input − b.
   */
  nodeVoltagesBefore: Record<string, number>;
  branchValues: Record<string, number>;
  /** Element state slots at state0 (current step). Keyed by element label. */
  elementStates: Record<string, Record<string, number>>;
  /**
   * Element state slots at state1 (previous accepted step). Keyed by element
   * label. Required for diagnosing LTE divided-difference divergences, since
   * `cktTerr` reads q1 = state1[Q] for every reactive junction. Same shape
   * as `elementStates` (state0).
   */
  elementStates1Slots: Record<string, Record<string, number>>;
  /**
   * Element state slots at state2 (two steps ago). Keyed by element label.
   * Used by order-2 LTE (3rd divided difference of Q). Same shape as
   * `elementStates` (state0).
   */
  elementStates2Slots: Record<string, Record<string, number>>;
  limitingEvents: LimitingEvent[];
  /**
   * RHS vector b at the start of this iteration (before the linear solve).
   * Sliced to K entries when a slice filter is active; full N entries otherwise.
   */
  rhs: number[];
  /**
   * A·v_input − b, computed from the captured sparse matrix, input voltages, and RHS.
   * Sliced to K entries when a slice filter is active; full N entries otherwise.
   */
  residual: number[];
  /**
   * Infinity norm (max-abs) of residual.
   * Recomputed over the sliced residual when a slice filter is active.
   */
  residualInfinityNorm: number;
  /**
   * Dense N×N matrix (row-major flat array) at full dimension.
   * Null only when sparse capture was empty (no matrix entries recorded).
   */
  matrix: number[] | null;
  /** Labels for each row/col of the sliced matrix, in matrix order. Length equals K. Populated only when a slice filter is active. */
  nodeLabels?: string[];
  /** 0-based matrix indices in the original full matrix. Length equals K. Populated only when a slice filter is active. */
  nodeIndices?: number[];
  /**
   * Integration coefficients active at this NR iteration. Length 7, matching
   * ngspice MAXORDER+1. On the ngspice side only slots 0 and 1 are populated
   * (FFI marshals ag0/ag1 only). Enables per-iteration discrimination of
   * capacitor integration behaviour (H1 vs H2 vs H3).
   */
  ag: number[];
  /**
   * Integration method active at this iteration ("trapezoidal" | "gear" on our
   * side; mapped to the same vocabulary on the ngspice side via ngspice-bridge). Kept as
   * `string` to accommodate raw ngspice values before mapping.
   */
  method: string;
  /** Integration order active at this iteration (1 = order-1 trap/gear, 2 = order-2 trap/gear). */
  order: number;
  /**
   * `matrixSize` from the underlying `IterationSnapshot`- ngspice
   * `CKTmaxEqNum + 1`, our engine reports `voltages.length + 1`. Both
   * sides should agree on the N+2 convention; mismatch flags a structural
   * setup divergence.
   */
  matrixSize: number;
  /**
   * `rhsBufSize` from the underlying `IterationSnapshot`- actual
   * allocation of rhs/rhsOld/preSolveRhs. ngspice's bridge reports `1`
   * during DCOP-init while CKTmatrix is being sized incrementally; outside
   * that window both sides should equal N+1.
   */
  rhsBufSize: number;
  /**
   * Human-readable cktMode label produced by `bitsToName(cktMode)` from
   * ckt-mode.ts (cktdefs.h:165-185). Examples:
   *   - "MODEDCOP|MODEINITJCT"
   *   - "MODETRAN|MODEINITFLOAT"
   * The single most useful field for "what NR phase is this iteration in".
   */
  initMode: string;
  /**
   * Active CKTdelta for this iteration (seconds). Distinct from the
   * step-level `dt` because the harness paints each iteration with the dt
   * the engine had when it called NIiter- for an LTE-rejected step the
   * iterations BEFORE the rejection ran with the original dt, the
   * iterations AFTER with the recovery dt.
   */
  delta: number;
  /** Diagonal Gmin value during gmin-stepping sub-solves (0 outside DCOP gmin phases). */
  diagGmin: number;
  /** Source-stepping factor during source-sweep DCOP (0 outside the dcopSrcSweep phase). */
  srcFact: number;
  /**
   * LTE-proposed next dt (seconds). Populated only on the final accepted
   * iteration of each step- undefined elsewhere. From our
   * `TimestepController.computeNewDt()` on our side, from
   * `RawNgspiceOuterEvent.nextDelta` on the ngspice side.
   */
  lteDt?: number;
}

export interface PairedIteration {
  iterationIndex: number;   // position within attempt
  ours: IterationSideData | null;
  ngspice: IterationSideData | null;
  divergenceNorm: number;   // L2 norm of node-voltage delta at this iteration
}

export interface AttemptDetail {
  stepIndex: number;
  phase: NRPhase;
  phaseAttemptIndex: number;
  ourAttempt: AttemptSummary | null;
  ngspiceAttempt: AttemptSummary | null;
  iterations: PairedIteration[];
}

export interface AttemptQuery {
  stepIndex: number;
  phase: NRPhase;
  phaseAttemptIndex: number;
  iterationRange?: [number, number];
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Integration coefficients
// ---------------------------------------------------------------------------

export interface IntegrationCoefficientsReport {
  stepIndex: number;
  ours: { ag0: number; ag1: number; method: string; order: number };
  ngspice: { ag0: number; ag1: number; method: string; order: number };
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
  limitingDiff: number;
}

export interface LimitingComparisonReport {
  label: string;
  stepIndex: number;
  iteration: number;
  junctions: JunctionLimitingEntry[];
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
  worstDelta: number;
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
  disagreementCount: number;
}

// ---------------------------------------------------------------------------
// Enhanced StepEndReport component entry
// ---------------------------------------------------------------------------

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
      stepStartTime: number;
      worstLabel: string;
      absDelta: number;
    } | null;
    perDeviceType: Record<string, { divergenceCount: number; worstAbsDelta: number }>;
    integrationMethod: IntegrationMethod | null;
    stateHistoryIssues: { state1Mismatches: number; state2Mismatches: number };
  };
  steps: Array<{
    stepIndex: number;
    stepStartTime: number;
    stepEndTime: number;
    dt: number;
    presence: SidePresence;
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
