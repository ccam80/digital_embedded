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
import type { LimitingEvent } from "../../newton-raphson.js";

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

/**
 * Per-frequency-point shape descriptor for AC sweeps.
 *
 * Frequency-axis sanity surface. A frequency-count or per-index frequency
 * mismatch means the two sides ran different sweeps- every downstream
 * solution / matrix comparison would be measuring noise, so this surface is
 * the first thing Phase 3 divergence tooling consults.
 */
export interface AcPointShape {
  pointIndex: number;
  presence: SidePresence;
  /** Frequency in Hz as reported by each side; null when absent. */
  freq: { ours: number | null; ngspice: number | null };
  /** Angular frequency in rad/s, parallel to `freq`. */
  omega: { ours: number | null; ngspice: number | null };
  /** Relative frequency delta |ng-ours|/max(|ours|,|ng|); null if any side absent. */
  freqRelDelta: number | null;
  /** Equation count as reported by each side; null when absent. */
  matrixSize: { ours: number | null; ngspice: number | null };
}

/**
 * Whole-AC-session shape descriptor. Mirror of `SessionShape` for the
 * frequency-axis analysis kind. `analysis` is fixed to `"ac"` so a single
 * consumer can union over `SessionShape | AcSessionShape` and branch on it.
 */
export interface AcSessionShape {
  analysis: "ac";
  pointCount: { ours: number; ngspice: number; max: number };
  presenceCounts: { both: number; oursOnly: number; ngspiceOnly: number };
  points: AcPointShape[];
  /** Indices where freqRelDelta exceeds tolerance (reported, not filtered). */
  largeFreqDeltas: Array<{ pointIndex: number; freqRelDelta: number }>;
}

/**
 * First per-MNA-row complex solution mismatch between paired AC sessions.
 *
 * Carries the complex value from both sides plus the magnitude- and
 * relative-delta. Strict bit-exact is the project bar (see CLAUDE.md), so
 * `absDelta > 0` is the threshold; the magnitudes are surfaced for
 * diagnostic classification.
 */
export interface AcSolutionDivergenceEntry {
  pointIndex: number;
  freq: number;
  /** MNA row index (0 = ground, always 0 by spClear). */
  row: number;
  ours: { re: number; im: number };
  ngspice: { re: number; im: number };
  /** |ours - ngspice| in the complex plane (Euclidean). */
  absDelta: number;
  /** absDelta / max(|ours|, |ngspice|, MIN_VALUE). */
  relDelta: number;
}

/**
 * First per-frequency-point shape mismatch between paired AC sessions.
 *
 * Mirror of the DC/TRAN shape-divergence concept for the frequency axis.
 * `kind` distinguishes presence (one side missing the point), frequency
 * mismatch (both present, freq differs past floating-point noise), and
 * matrix-size mismatch (both present, engines disagreed on equation count-
 * structural, almost always upstream of any per-row solution disagreement).
 * `freq` / `matrixSize` carry both sides' values when present so the report
 * is self-contained.
 */
export interface AcShapeDivergenceEntry {
  pointIndex: number;
  kind: "ours-missing" | "ngspice-missing" | "frequency-mismatch" | "matrix-size-mismatch";
  freq: { ours: number | null; ngspice: number | null };
  matrixSize: { ours: number | null; ngspice: number | null };
}

/**
 * First per-cell complex Jacobian mismatch between paired AC sessions.
 *
 * Cells are addressed by (row, col) in external (MNA) coordinates,
 * matching ngspice's pre-LU CSC capture in niiter.c. `kind` distinguishes
 * the three structural/value cases:
 *   - "ours-only": cell present in ours' CSC but absent from ngspice's.
 *   - "ngspice-only": cell present in ngspice's CSC but absent from ours'.
 *   - "value-mismatch": cell present on both sides with differing complex
 *     values (bit-exact bar; absDelta > 0 in the complex plane).
 *
 * For value-mismatch, both sides' values are carried. For presence kinds,
 * only the present side's value is non-null.
 */
export interface AcMatrixDivergenceEntry {
  pointIndex: number;
  freq: number;
  row: number;
  col: number;
  kind: "ours-only" | "ngspice-only" | "value-mismatch";
  ours: { re: number; im: number } | null;
  ngspice: { re: number; im: number } | null;
  /** |ours - ngspice| in the complex plane; 0 for presence kinds (one side null). */
  absDelta: number;
  /** absDelta / max(|ours|, |ngspice|, MIN_VALUE); 0 for presence kinds. */
  relDelta: number;
}

/**
 * Per-class first-divergence report for a paired AC sweep.
 *
 * Modeled on `firstDivergence` for DC/TRAN: each class is independently
 * computed (solution / shape / matrix), plus an `earliestPointIndex`
 * across all populated classes. `null` in any class means "no divergence
 * detected in this class within the paired range."
 *
 * Runs unconditionally- a non-empty `largeFreqDeltas` from
 * `getAcSessionShape()` does not gate this; cross-reference both surfaces
 * for the full picture (mirrors DC/TRAN's largeTimeDeltas
 * reported-not-gated pattern).
 */
export interface AcDivergenceReport {
  /** min(pointIndex) across all populated classes, or null if no divergence. */
  earliestPointIndex: number | null;
  solution: AcSolutionDivergenceEntry | null;
  shape: AcShapeDivergenceEntry | null;
  matrix: AcMatrixDivergenceEntry | null;
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
  /**
   * Raw NR iteration index from the ngspice instrumentation callback. Set only
   * on snapshots produced by the ngspice bridge; used internally by
   * `NgspiceBridge.assembleStep()` to locate the corresponding raw iteration
   * record when computing per-step integration coefficients. Not populated by
   * our-engine snapshots and not exposed in any comparator output.
   */
  _rawIteration?: number;
}

/** Device state for one element at one iteration. */
export interface ElementStateSnapshot {
  elementIndex: number;
  label: string;
  slots: Record<string, number>;
  state1Slots: Record<string, number>;
  state2Slots: Record<string, number>;
  /**
   * State pool slot[3] values at this iteration- the fourth-oldest accepted
   * step's state (rotated in via state-pool.ts:112-119, dctran.c:719-723).
   * Both sides populated: our side from `statePool.state3`, ngspice from
   * `CKTstate3` (added to NiIterationData in niiter.c). Read to verify
   * order-2 LTE inputs: at end of step N, this slot holds the converged
   * state from end of step N-3 if state pool rotation is correct.
   */
  state3Slots: Record<string, number>;
  /**
   * Per-pin terminal current at this iteration, keyed by pin label
   * (matching the component's `pinLayout` labels — e.g. "B"/"C"/"E" for
   * BJT, "A"/"K" for diode). Built from the device's
   * `DeviceMapping.pinCurrents` projection over the slot data already
   * captured. Devices with no projection (MOSFET, whose pin currents
   * live on the per-instance struct rather than in CKTstate; inductor,
   * whose through-current is the MNA branch variable rather than a
   * state slot) emit an empty record.
   */
  pinCurrents: Record<string, number>;
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
  | "dcopGminNew"
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

/**
 * One term in a pin-current projection: a slot name to read, with sign.
 * Pin current = sum over terms of (sign * slot value).
 *
 * KCL-closure pins (e.g. BJT emitter, diode cathode, capacitor P2) are
 * expressed as the negative sum of the directly-readable slot currents on
 * the device. Direct pins are 1-element arrays.
 */
export interface PinCurrentTerm {
  slot: string;
  sign: 1 | -1;
}

export interface DeviceMapping {
  deviceType: string;
  slotToNgspice: Record<string, number | null>;
  ngspiceToSlot: Record<number, string>;
  /**
   * Per-device pin-current projection. Pin name → signed sum of slots that
   * already exist in `slotToNgspice` / `ngspiceToSlot`. Both engines populate
   * `ElementStateSnapshot.pinCurrents` from the same projection so the values
   * being compared are by construction labelled identically.
   *
   * Pin-name keys are the device's component-pin-layout labels (e.g.
   * "B"/"C"/"E" for BJT, "A"/"K" for diode, "pos"/"neg" for cap, "G"/"D"/"S"
   * for JFET). Devices whose per-pin currents do not live in CKTstate
   * (MOSFET — instance-struct fields; inductor — MNA branch variable)
   * omit this field entirely.
   */
  pinCurrents?: Record<string, ReadonlyArray<PinCurrentTerm>>;
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
    ours: { totalSteps: number; convergedSteps: number; failedSteps: number; avgIterations: number; maxIterations: number; worstStep: number };
    ngspice: { totalSteps: number; convergedSteps: number; failedSteps: number; avgIterations: number; maxIterations: number; worstStep: number };
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
  state3: Float64Array;
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
 * Raw data from the ngspice AC sweep callback (ni_ac_cb), fired once per
 * frequency point inside NIacIter (after CKTacLoad, factor, and SMPcSolve).
 *
 * Field layout mirrors the C `NiAcData` struct in
 * `ref/ngspice/src/maths/ni/niiter.c`. Buffers carry external-coords CSC for
 * the loaded complex Jacobian (re+im twin arrays) plus the loaded complex
 * RHS and the complex solution. All arrays are decoded eagerly inside the
 * koffi callback handler- ngspice reuses the staging buffers on the next
 * frequency point.
 *
 * Phase 1b deliverable: this is the raw FFI round-trip type. The Phase 2
 * `"ac"` analysis kind in CaptureSession will consume an array of these.
 */
export interface RawNgspiceAcPoint {
  matrixSize: number;     // CKTmaxEqNum + 1
  rhsBufSize: number;     // SMPmatSize(CKTmatrix) + 1
  nnz: number;            // CSC non-zero count for this frequency
  colPtr: Int32Array;     // length matrixSize+1, CSC column offsets (external coords)
  rowIdx: Int32Array;     // length nnz, external row index per entry
  valsRe: Float64Array;   // length nnz, loaded complex matrix Real
  valsIm: Float64Array;   // length nnz, loaded complex matrix Imag
  rhsRe: Float64Array;    // length rhsBufSize, loaded complex RHS Real
  rhsIm: Float64Array;    // length rhsBufSize, loaded complex RHS Imag
  solRe: Float64Array;    // length rhsBufSize, solution Real (= CKTrhsOld)
  solIm: Float64Array;    // length rhsBufSize, solution Imag (= CKTirhsOld)
  omega: number;          // CKTomega at this frequency point (rad/s)
  freq: number;           // omega / (2π), Hz
}

/**
 * Per-frequency complex snapshot from an AC analysis run, source-agnostic.
 *
 * Captures everything one frequency point of an AC sweep observes: the
 * loaded complex Jacobian, the loaded complex RHS, and the complex
 * solution, with `freq`/`omega` metadata. ngspice fills every field
 * (built from `RawNgspiceAcPoint` via `buildAcCaptureSession`); our side
 * fills `solRe`/`solIm` in Phase 2 and lights up `matrix`/`rhsRe`/`rhsIm`
 * in Phase 3 once the SparseSolver's complex CSC export lands.
 */
export interface AcCapturePoint {
  /** Frequency in Hz. */
  freq: number;
  /** Angular frequency in rad/s. Should equal 2π·freq. */
  omega: number;
  /** Equation count: ngspice CKTmaxEqNum+1, ours matrixSize. */
  matrixSize: number;
  /** Complex solution Real part. Index 0 = ground. */
  solRe: Float64Array;
  /** Complex solution Imag part. Parallel to solRe. */
  solIm: Float64Array;
  /**
   * Loaded complex Jacobian in external-coords CSC. Populated for the
   * ngspice side from day one (built from RawNgspiceAcPoint); populated
   * for ours in Phase 3 once SparseSolver gains a complex CSC export.
   */
  matrix?: {
    nnz: number;
    colPtr: Int32Array;
    rowIdx: Int32Array;
    valsRe: Float64Array;
    valsIm: Float64Array;
  };
  /** Loaded complex RHS Real. Phase-2-optional, ngspice populates. */
  rhsRe?: Float64Array;
  /** Loaded complex RHS Imag. Phase-2-optional, ngspice populates. */
  rhsIm?: Float64Array;
}

/**
 * Paired-comparison container for an AC sweep, parallel to `CaptureSession`
 * for DC/transient. `points` is in sweep order (strictly increasing `freq`).
 * Two `AcCaptureSession`s (ours + ngspice) get paired by frequency index
 * for divergence analysis in Phase 3.
 */
export interface AcCaptureSession {
  source: "ours" | "ngspice";
  /** Topology snapshot- same shape as CaptureSession.topology so MCP/diff
   * tooling can share node-name resolution between AC and DC/TRAN. */
  topology: TopologySnapshot;
  /** Frequency-ordered snapshots. */
  points: AcCapturePoint[];
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
  /**
   * Element state slots at state3 (three steps ago). Keyed by element label.
   * Used by order-2 LTE's 3rd divided difference (`cktTerr` reads
   * q3 = state3[Q]). Same shape as the other state slot maps. Populated on
   * both sides: our side from `statePool.state3`, ngspice from `CKTstate3`
   * (added to NiIterationData; requires DLL rebuild).
   */
  elementStates3Slots: Record<string, Record<string, number>>;
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
  /**
   * Per-pin terminal current paired between engines. Keys are the
   * device's component-pin-layout labels. Empty for devices without a
   * `DeviceMapping.pinCurrents` projection.
   */
  pinCurrents: Record<string, ComparedValue>;
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

// ---------------------------------------------------------------------------
// Diff reports (harness_topology_diff / harness_matrix_diff / harness_first_divergence)
// ---------------------------------------------------------------------------

/**
 * Classification of the matrix-entry diff at one iteration.
 *
 * - `match`: identical (row, col) sets AND identical values.
 * - `value-only`: identical (row, col) sets; ≥1 cell with differing values AND
 *   value multisets DIFFER. Genuine arithmetic divergence at aligned cells.
 * - `value-permutation`: identical (row, col) sets; ≥1 cell with differing
 *   values BUT value multisets match. Same numbers landed at different cells
 *   - a load-order / internal-node-allocation permutation.
 * - `coord-set-differs`: (row, col) sets differ. Per-cell pairing past this
 *   point is undefined — agents should call `harness_topology_diff` to inspect
 *   which elements / nodes are missing or reordered.
 */
export type MatrixDiffClassification =
  | "match"
  | "value-only"
  | "value-permutation"
  | "coord-set-differs";

export interface MatrixDiffCell {
  /** 0-based row in our matrix coordinate space (after ngspice→ours reindex for the ngspice side). */
  row: number;
  /** 0-based col in our matrix coordinate space. */
  col: number;
  rowLabel: string;
  colLabel: string;
  /** Our cell value at the reference iteration; null when absent from ours. */
  ours: number | null;
  /** ngspice cell value at the reference iteration; null when absent from ngspice. */
  ngspice: number | null;
  absDelta: number;
  /** First (step, iter) where the cell first diverged across the session. null when never. */
  firstDivergentStep: number | null;
  firstDivergentIteration: number | null;
}

export interface MatrixDiffReport {
  /** Reference step used to classify and pick the example cells. */
  stepIndex: number;
  /** Reference iteration index within the accepted attempt. */
  iterationIndex: number;
  classification: MatrixDiffClassification;
  ourCellCount: number;
  ngspiceCellCount: number;
  /** Cells present in our matrix at reference but missing from ngspice's. */
  oursOnly: MatrixDiffCell[];
  /** Cells present in ngspice's matrix at reference but missing from ours. */
  ngspiceOnly: MatrixDiffCell[];
  /** Cells present in both but with differing values. Sorted by absDelta desc. */
  valueMismatches: MatrixDiffCell[];
}

export type TopologyElementDiffReason =
  | "ours-only"
  | "ngspice-only"
  | "type-mismatch";

export interface TopologyElementDiff {
  ourLabel: string | null;
  ngspiceLabel: string | null;
  ourType: string | null;
  ngspiceType: string | null;
  reason: TopologyElementDiffReason;
}

export interface TopologyOrderingDiff {
  label: string;
  ourSlotIndex: number;
  ngspiceSlotIndex: number;
  kind: "node" | "branch";
}

export interface TopologyDiffReport {
  ourElementCount: number;
  ngspiceElementCount: number;
  ourNodeCount: number;
  ngspiceNodeCount: number;
  ourMatrixSize: number;
  ngspiceMatrixSize: number;
  /** Per-element correspondence issues (ours-only, ngspice-only, type-mismatch). */
  elementDiffs: TopologyElementDiff[];
  /** Nodes/branches where the matched 1-based slot index differs between sides. */
  orderingDiffs: TopologyOrderingDiff[];
  /** ngspice nodes with no entry in the node mapping (often composite-internal). */
  unmappedNgspiceNodes: Array<{ ngspiceName: string; ngspiceIndex: number }>;
  /**
   * Findings deferred from `_assertMatrixStructuralParity`. Present when the
   * session was created with `deferStructuralAsserts: true` — populated only
   * after `harness_run`. Used so MCP investigation tools can surface the same
   * verdict the assertion would normally throw.
   */
  structuralFindings: Array<{ kind: string; message: string }>;
}

export type DivergenceSignalClass = "voltage" | "matrix" | "state" | "shape";

export interface FirstDivergenceSignal {
  signalClass: DivergenceSignalClass;
  stepIndex: number;
  iterationIndex: number;
  /** Free-form description of the divergent attribute. */
  attribute: string;
  ours: number | string;
  ngspice: number | string;
  absDelta: number;
}

export interface FirstDivergenceReport {
  voltage: FirstDivergenceSignal | null;
  matrix: FirstDivergenceSignal | null;
  state: FirstDivergenceSignal | null;
  shape: FirstDivergenceSignal | null;
  /** Earliest divergence across all classes (lowest stepIndex, then iterationIndex). */
  earliest: FirstDivergenceSignal | null;
}
