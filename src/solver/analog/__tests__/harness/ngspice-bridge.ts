/**
 * Node FFI bridge to ngspice shared library (extended).
 *
 * Loads ngspice.dll via koffi, registers both the per-iteration
 * instrumentation callback and the one-time topology callback,
 * runs a SPICE netlist, and converts ngspice data into our
 * CaptureSession format with full device-state unpacking.
 *
 * IMPORTANT: This module is test-only and requires native addons.
 * It is not bundled into the browser application. Tests that use
 * this bridge should be in a separate test file with a guard:
 *
 *   import.meta.env?.NGSPICE_DLL_PATH || describe.skip(...)
 *
 * Environment variable:
 *   NGSPICE_DLL_PATH- absolute path to ngspice.dll with instrumentation
 */

import type {
  CaptureSession,
  TopologySnapshot,
  StepSnapshot,
  NRAttempt,
  NRPhase,
  AttemptRole,
  NRAttemptOutcome,
  IterationSnapshot,
  ElementStateSnapshot,
  NgspiceTopology,
  NgspiceDeviceInfo,
  RawNgspiceIterationEx,
  RawNgspiceOuterEvent,
  RawNgspiceAcPoint,
  AcCaptureSession,
  AcCapturePoint,
  RawNgspiceTopology,
  IntegrationCoefficients,
  MatrixEntry,
} from "./types.js";
import type { IntegrationMethod } from "../../integration.js";
import type { LimitingEvent } from "../../newton-raphson.js";
import { bitsToName } from "../../ckt-mode.js";
import { DEVICE_MAPPINGS, projectPinCurrents } from "./device-mappings.js";
import { assertNgspiceDllHasAc, resolveNgspiceCodemodelPaths } from "./ngspice-dll-path.js";

// ---------------------------------------------------------------------------
// CKTmode constants (from ref/ngspice/src/include/ngspice/cktdefs.h:166-182)
// ---------------------------------------------------------------------------
const MODETRAN       = 0x0001;
const MODEDCOP       = 0x0010;
const MODETRANOP     = 0x0020;
const MODEINITFLOAT  = 0x0100;
const MODEINITJCT    = 0x0200;
const MODEINITFIX    = 0x0400;
const MODEINITTRAN   = 0x1000;
const MODEINITPRED   = 0x2000;

// phaseFlags bits (from ni_set_phase_flags; see ref/ngspice cktop.c NI_PHASE_*)
const PF_GMIN_DYN = 0x1;
const PF_SRC_STEP = 0x2;
const PF_GMIN_SP3 = 0x4;
const PF_GMIN_NEW = 0x8;

function cktModeToPhase(mode: number, phaseFlags: number): NRPhase {
  const inGminDyn = (phaseFlags & PF_GMIN_DYN) !== 0;
  const inSrcStep = (phaseFlags & PF_SRC_STEP) !== 0;
  const inGminSp3 = (phaseFlags & PF_GMIN_SP3) !== 0;
  const inGminNew = (phaseFlags & PF_GMIN_NEW) !== 0;

  // Standalone `op`: CKTop(firstmode=MODEDCOP|MODEINITJCT, continuemode=MODEDCOP|MODEINITFLOAT).
  // Transient's DC OP: dctran.c uses MODETRANOP|MODEINITJCT → MODETRANOP|MODEINITFLOAT.
  // Treat both as DCOP phases; stepping sub-solves are distinguished by phaseFlags.
  const isDcOpFamily = (mode & (MODEDCOP | MODETRANOP)) !== 0;
  if (isDcOpFamily) {
    if (inSrcStep) return "dcopSrcSweep";
    if (inGminSp3) return "dcopGminSpice3";
    if (inGminNew) return "dcopGminNew";
    if (inGminDyn) return "dcopGminDynamic";
    if (mode & MODEINITJCT)   return "dcopInitJct";
    if (mode & MODEINITFIX)   return "dcopInitFix";
    if (mode & MODEINITFLOAT) return "dcopInitFloat";
    // MODEDCOP|MODETRANOP only (no init flag): pure DC-OP direct iteration.
    return "dcopDirect";
  }
  if (mode & MODEINITPRED)  return "tranPredictor";
  if (mode & MODEINITTRAN)  return "tranInit";
  if (mode & MODETRAN)      return "tranNR";
  if (mode & MODEINITFLOAT) return "tranNR";
  return "tranNR";
}

function cktModeToRole(
  mode: number,
  phaseFlags: number,
  attemptIndexInStep: number,
): AttemptRole | undefined {
  const phase = cktModeToPhase(mode, phaseFlags);
  if (phase === "dcopInitJct")    return "junctionPrime";
  if (phase === "dcopDirect")     return "mainSolve";
  // dcopInitFloat at index 0 is a cold-start; finalVerify is assigned retroactively
  // in flushStep after the full attempt list is known.
  if (phase === "dcopInitFloat" && attemptIndexInStep === 0) return "coldStart";
  return undefined;
}

/**
 * Classify a `cktMode` bitfield into the coarse analysisPhase bucket used by
 * StepSnapshot. DCOP init ladder stages (MODEDCOP / MODETRANOP, plus the
 * MODEINITJCT/FIX/FLOAT/SMSIG sub-phases) collapse to "dcop". MODEINITTRAN
 * is the first transient NR call after DCOP → "tranInit". Anything else
 * running under MODETRAN is free-running transient → "tranFloat".
 *
 * Cite cktdefs.h:166-182 for the bit assignments.
 */
function cktModeToAnalysisPhase(cktMode: number): "dcop" | "tranInit" | "tranFloat" {
  if (cktMode & (MODEDCOP | MODETRANOP)) return "dcop";
  if (cktMode & MODEINITTRAN) return "tranInit";
  return "tranFloat";
}

/** Extract only the ngspice-side integration coefficients from a raw iteration. */
function _ngspiceIntegCoeff(raw: RawNgspiceIterationEx | undefined): IntegrationCoefficients["ngspice"] {
  if (!raw) {
    return { ag0: 0, ag1: 0, method: "trapezoidal", order: 1 };
  }
  // ngspice CKTintegrateMethod (cktintegrate.c): MIF_TRAP=1, MIF_GEAR=2. No MIF_BE.
  const methodMap: Record<number, IntegrationMethod> = { 1: "trapezoidal", 2: "gear" };
  return {
    ag0: raw.ag0 ?? 0,
    ag1: raw.ag1 ?? 0,
    method: methodMap[raw.integrateMethod ?? 1] ?? "trapezoidal",
    order: raw.order ?? 1,
  };
}

/** Junction ID to string name mapping for limiting events. */
const JUNCTION_ID_MAP: Record<number, string> = {
  0: "AK", 1: "BE", 2: "BC", 3: "GS", 4: "DS",
  5: "GD", 6: "BS", 7: "BD", 8: "CS",
};

// ---------------------------------------------------------------------------
// Internal grouping state
// ---------------------------------------------------------------------------

interface PendingAttempt {
  phase: NRPhase;
  phaseFlags: number;
  iterations: IterationSnapshot[];
  firstRaw: RawNgspiceIterationEx;
}

interface PendingStep {
  stepStartTime: number;
  attempts: NRAttempt[];
  pendingAttempt: PendingAttempt | null;
}

// ---------------------------------------------------------------------------
// Pure capture-session builder
//
// The conversion from raw ngspice FFI data to a CaptureSession is a pure
// function of (iterations, outerEvents, topology). Hosted at module scope so
// unit tests can drive the grouping state machine + lteDt mapping with
// synthetic inputs without standing up an NgspiceBridge / DLL.
// ---------------------------------------------------------------------------

function canonicalizeNgspiceDeviceType(ngspiceType: string): string | null {
  const lower = ngspiceType.toLowerCase();
  const map: Record<string, string> = {
    "capacitor": "capacitor", "inductor": "inductor",
    "diode": "diode", "bjt": "bjt",
    "mos1": "mosfet", "mosfet": "mosfet", "jfet": "jfet",
    // mos3init.c:12 .name="Mos3"; mos3defs.h state layout is identical to
    // mos1defs.h (17 states, vbd=0..cqbs=16) so MOS3 reuses MOSFET_MAPPING.
    "mos3": "mosfet",
    // jfet2init.c:12 .name="JFET2" (Parker-Skellern); mesinit.c:12 .name="MES".
    "jfet2": "jfet2", "mes": "mes",
    // ngspice VDMOSinfo.name = "VDMOS" (vdmosinit.c:12), lowercased here.
    "vdmos": "vdmos",
    "switch": "vswitch",
    // cswinit.c:14 CSWinfo.name="CSwitch" (the relay-contact current switch).
    "cswitch": "csw",
  };
  return map[lower] ?? null;
}

function unpackElementStates(
  state0: Float64Array,
  state1: Float64Array,
  state2: Float64Array,
  state3: Float64Array,
  topology: NgspiceTopology | null,
): ElementStateSnapshot[] {
  if (!topology || topology.devices.length === 0) return [];
  const snapshots: ElementStateSnapshot[] = [];

  for (const dev of topology.devices) {
    const deviceType = canonicalizeNgspiceDeviceType(dev.typeName);
    const mapping = deviceType ? DEVICE_MAPPINGS[deviceType] : undefined;
    if (!deviceType || !mapping) continue;

    const slots: Record<string, number> = {};
    const state1Slots: Record<string, number> = {};
    const state2Slots: Record<string, number> = {};
    const state3Slots: Record<string, number> = {};

    for (const [offsetStr, slotName] of Object.entries(mapping.ngspiceToSlot)) {
      const offset = Number(offsetStr);
      const absOffset = dev.stateBase + offset;
      if (absOffset < state0.length) slots[slotName] = state0[absOffset];
      if (absOffset < state1.length) state1Slots[slotName] = state1[absOffset];
      if (absOffset < state2.length) state2Slots[slotName] = state2[absOffset];
      if (absOffset < state3.length) state3Slots[slotName] = state3[absOffset];
    }

    if (Object.keys(slots).length > 0) {
      const pinCurrents = projectPinCurrents(mapping, slots);
      snapshots.push({
        elementIndex: -1,
        label: dev.name.toUpperCase(),
        // Record the canonical device type so the comparator routes slot
        // mapping by type rather than label prefix (VDMOS/MOSFET share `M`).
        deviceType,
        slots, state1Slots, state2Slots, state3Slots,
        pinCurrents,
      });
    }
  }
  return snapshots;
}

function buildTopologySnapshot(
  topology: NgspiceTopology | null,
  firstIterationMatrixSize: number,
): TopologySnapshot {
  if (!topology) {
    return {
      matrixSize: firstIterationMatrixSize,
      nodeCount: 0, elementCount: 0,
      elements: [],
      nodeLabels: new Map(), matrixRowLabels: new Map(), matrixColLabels: new Map(),
    };
  }

  const nodeLabels = new Map<number, string>();
  topology.nodeNames.forEach((nodeNum, nodeName) => {
    nodeLabels.set(nodeNum, nodeName);
  });

  const matrixRowLabels = new Map<number, string>();
  const matrixColLabels = new Map<number, string>();
  nodeLabels.forEach((label, nodeId) => {
    const row = nodeId - 1;
    if (row >= 0) { matrixRowLabels.set(row, label); matrixColLabels.set(row, label); }
  });

  const elements = topology.devices.map((d, i) => ({
    index: i, label: d.name, type: d.typeName,
    pinNodeIds: d.nodeIndices as readonly number[],
  }));

  // nodeNames includes both voltage-node entries (numeric names like "1",
  // "2", ...) and branch-row entries that ngspice exposes as `<elem>#branch`
  // (current-variable rows created via CKTmkCur — vsources, inductors, etc.).
  // Our convention's `nodeCount` is voltage nodes ONLY (branches live in the
  // matrix beyond `nodeCount` and `slice.ts:116` relies on that gating).
  // Filter the branch rows out here so the snapshot's nodeCount lines up
  // with what `captureTopology` produces for our engine.
  let voltageNodeCount = 0;
  topology.nodeNames.forEach((_, name) => {
    if (!name.endsWith("#branch")) voltageNodeCount++;
  });
  return {
    matrixSize: topology.matrixSize,
    nodeCount: voltageNodeCount,
    elementCount: topology.devices.length,
    elements, nodeLabels, matrixRowLabels, matrixColLabels,
  };
}

/**
 * Convert raw ngspice FFI data into a CaptureSession.
 *
 * Grouping algorithm (spec ss6.1):
 *   - Keyed on simTimeStart from each raw iteration.
 *   - New step when simTimeStart changes.
 *   - New attempt when: iteration resets OR phase changes.
 *   - Outer callback events (ni_outer_cb) set attempt outcomes deterministically.
 *
 * Pure function — unit tests drive the state machine with synthetic
 * iteration / outer-event arrays directly.
 */
export function buildCaptureSession(
  iterations: RawNgspiceIterationEx[],
  outerEvents: RawNgspiceOuterEvent[],
  topology: NgspiceTopology | null,
): CaptureSession {
  const steps: StepSnapshot[] = [];

  if (iterations.length === 0) {
    return { source: "ngspice", topology: buildTopologySnapshot(topology, 0), steps };
  }

  // ngspice fires ni_fire_outer_cb exactly once per transient solve decision
  // (dctran.c:369 accept / 945 LTE reject / 813 nrFail / 960 finalFailure;
  // optran.c mirrors these for the pseudo-transient OP). The events arrive in
  // fire order — one per tranNR solve, in the same order the tranNR attempts are
  // captured (both come off the same ni_iter / dctran walk). They are therefore
  // consumed positionally: a single ordered cursor hands each tranNR attempt the
  // next event in flushAttempt. No time key is used, so a reject-redo's
  // floating-point CKTtime rewind (CKTtime -= CKTdelta, where T+δ−δ != T) cannot
  // split the drifted accept onto a separate key and orphan its solve.
  let outerIdx = 0;
  const nextOuterOutcome = (): { outcome: NRAttemptOutcome; ev: RawNgspiceOuterEvent } | null => {
    // Skip the t=0 operating-point accept (dt==0): ngspice fires an accept for the
    // transient OP before the first real step (dctran.c nextTime fires with
    // CKTdelta==0), but our capture folds the OP into the first transient solve
    // (tranInit+tranNR) and emits no separate tranNR attempt to consume it. dt==0
    // uniquely marks the OP (real timesteps are >= CKTdelmin > 0); skipping it keeps
    // each real tranNR attempt aligned with its own event. Without this, the unpaired
    // OP accept leaves the cursor one event behind for the whole run.
    while (outerIdx < outerEvents.length && outerEvents[outerIdx]!.accepted !== 0 && outerEvents[outerIdx]!.delta === 0) outerIdx++;
    if (outerIdx >= outerEvents.length) return null;
    const ev = outerEvents[outerIdx++]!;
    let outcome: NRAttemptOutcome | null = null;
    if (ev.lteRejected) outcome = "lteRejectedRetry";
    else if (ev.nrFailed) outcome = "nrFailedRetry";
    else if (ev.finalFailure) outcome = "finalFailure";
    else if (ev.accepted) outcome = "accepted";
    if (outcome === null) return null;
    return { outcome, ev };
  };

  let currentStep: PendingStep | null = null;
  let prevIteration = -1;
  let prevPhase: NRPhase | null = null;
  // Structural step-boundary signal: set true inside flushAttempt when the
  // tranNR attempt it just closed was `accepted`. A transient step is
  // (optional rejects)+one accept, and the accept closes it — so the NEXT
  // tranNR attempt after an accepted one opens a new step. A reject-redo's
  // rewound-time accept does NOT trip this until it is itself accepted, so the
  // drifted accept stays inside the current step instead of opening a new one.
  let prevTranAttemptAccepted = false;

  const flushAttempt = (step: PendingStep, outcome: NRAttemptOutcome): void => {
    const pa = step.pendingAttempt;
    if (!pa || pa.iterations.length === 0) {
      step.pendingAttempt = null;
      return;
    }
    // A transient NR solve (tranNR) carries an authoritative verdict from
    // ngspice's ni_fire_outer_cb (dctran.c). Consume the step's outer events in
    // fire order- one per solve- so a reject-redo step labels the rejected
    // solve lteRejectedRetry and the final solve accepted, instead of the
    // phase-derived guess. tranPredictor handoffs and DC-op gmin/source
    // sub-solves fire no outer events and keep the caller-supplied outcome.
    let acceptedEvent: RawNgspiceOuterEvent | null = null;
    if (pa.phase === "tranNR") {
      // Every transient solve fires exactly one accept/reject decision via
      // ni_fire_outer_cb- both the .tran time-stepper (dctran.c:369/945/813/960)
      // and the OPtran pseudo-transient ramp (optran.c, same accept/reject
      // points). The outer event is the authoritative verdict; consume the
      // events positionally in fire order. A missing event means the event
      // stream and the captured solve attempts have desynchronized- fail loudly.
      const ov = nextOuterOutcome();
      if (ov === null) {
        throw new Error(
          `ngspice bridge: tranNR solve at simTimeStart=${step.stepStartTime} has ` +
          `no matching ni_fire_outer_cb event (one accept/reject decision per ` +
          `transient solve is expected; dctran.c / optran.c).`,
        );
      }
      outcome = ov.outcome;
      // The accept closes the transient step (see prevTranAttemptAccepted): the
      // next tranNR attempt after this one opens a new step. A reject keeps the
      // current step open for the redo.
      prevTranAttemptAccepted = outcome === "accepted";
      if (outcome === "accepted") acceptedEvent = ov.ev;
    }
    const lastIter = pa.iterations[pa.iterations.length - 1]!;
    // Populate lteDt on the accepted transient solve's last iteration from the
    // accepted event's nextDelta (the LTE-proposed next timestep). Sourced from
    // the very event whose verdict we just consumed, so no time-keyed lookup.
    if (
      acceptedEvent !== null &&
      typeof acceptedEvent.nextDelta === "number" &&
      isFinite(acceptedEvent.nextDelta) &&
      acceptedEvent.nextDelta > 0
    ) {
      lastIter.lteDt = acceptedEvent.nextDelta;
    }
    const attemptIndexInStep = step.attempts.length;
    const role = cktModeToRole(pa.firstRaw.cktMode, pa.firstRaw.phaseFlags, attemptIndexInStep);
    const attempt: NRAttempt = {
      dt: pa.firstRaw.dt,
      iterations: pa.iterations,
      converged: lastIter.globalConverged,
      iterationCount: pa.iterations.length,
      phase: pa.phase,
      outcome,
      ...(role !== undefined ? { role } : {}),
      ...(pa.phase === "dcopGminDynamic" || pa.phase === "dcopGminSpice3" || pa.phase === "dcopGminNew"
        ? { phaseParameter: pa.firstRaw.phaseGmin }
        : pa.phase === "dcopSrcSweep"
        ? { phaseParameter: pa.firstRaw.phaseSrcFact }
        : {}),
    };
    step.attempts.push(attempt);
    step.pendingAttempt = null;
  };

  const flushStep = (step: PendingStep): void => {
    if (step.attempts.length === 0) return;

    // Find accepted attempt index: last attempt with converged === true
    // and outcome "accepted" or "dcopSubSolveConverged"
    let acceptedIdx = -1;
    for (let i = step.attempts.length - 1; i >= 0; i--) {
      const a = step.attempts[i]!;
      if (a.outcome === "accepted" || a.outcome === "dcopSubSolveConverged") {
        acceptedIdx = i;
        break;
      }
    }
    if (acceptedIdx < 0) acceptedIdx = step.attempts.length - 1;

    const acceptedAttempt = step.attempts[acceptedIdx]!;
    const lastRaw = acceptedAttempt.iterations[acceptedAttempt.iterations.length - 1];
    const ngspiceCoeff = _ngspiceIntegCoeff(
      // Find the raw iteration for the last accepted iteration
      iterations.find(r =>
        r.simTimeStart === step.stepStartTime &&
        r.iteration === lastRaw?._rawIteration
      ) ?? iterations.find(r => r.simTimeStart === step.stepStartTime),
    );
    const integCoeff: IntegrationCoefficients = {
      ours: { ag0: 0, ag1: 0, method: "trapezoidal", order: 1 },
      ngspice: ngspiceCoeff,
    };

    // Derive analysisPhase from the numeric cktMode of the first captured
    // iteration. We look it up via simTimeStart + iteration number rather
    // than re-parsing the diagnostic string label produced by bitsToName().
    const firstRawForPhase = iterations.find(
      r => r.simTimeStart === step.stepStartTime,
    );
    const analysisPhase = firstRawForPhase
      ? cktModeToAnalysisPhase(firstRawForPhase.cktMode)
      : "dcop";

    // stepEndTime: for accepted transient step it is simTime (post-advance);
    // for DCOP it equals stepStartTime.
    const stepEndTime = acceptedAttempt.dt > 0
      ? step.stepStartTime + acceptedAttempt.dt
      : step.stepStartTime;

    const totalIterationCount = step.attempts.reduce((sum, att) => sum + att.iterationCount, 0);

    // Retroactively assign finalVerify: a dcopInitFloat that follows a dcopDirect
    // in the same step is a post-convergence verification pass, not a cold start.
    let sawDcopDirect = false;
    for (const att of step.attempts) {
      if (att.phase === "dcopDirect") sawDcopDirect = true;
      else if (att.phase === "dcopInitFloat" && sawDcopDirect && att.role !== "coldStart") {
        att.role = "finalVerify";
      }
    }

    // Assign tran-phase roles: the accepted tran attempt is the real solve (tranSolve);
    // any tran attempt that failed with nrFailedRetry is a predictor pass (predictorPass).
    const isTranPhase = (p: string) => p === "tranInit" || p === "tranPredictor" || p === "tranNR";
    for (const att of step.attempts) {
      if (!isTranPhase(att.phase)) continue;
      if (att.outcome === "accepted") {
        att.role = "tranSolve";
      } else if (att.outcome === "nrFailedRetry") {
        att.role = "predictorPass";
      }
    }

    // lteDt is set on the accepted transient solve's last iteration inside
    // flushAttempt, directly from the ni_fire_outer_cb event whose accept verdict
    // it consumes (the event's nextDelta is the LTE-proposed next timestep). No
    // time-keyed re-lookup of the step's events is needed here.

    steps.push({
      stepStartTime: step.stepStartTime,
      stepEndTime,
      attempts: step.attempts,
      acceptedAttemptIndex: acceptedIdx,
      accepted: acceptedAttempt.converged,
      dt: acceptedAttempt.dt,
      iterations: acceptedAttempt.iterations,
      converged: acceptedAttempt.converged,
      iterationCount: acceptedAttempt.iterationCount,
      totalIterationCount,
      integrationCoefficients: integCoeff,
      analysisPhase,
    });
  };

  for (const raw of iterations) {
    const attemptPhase = cktModeToPhase(raw.cktMode, raw.phaseFlags);
    const stepStartTimeOfRaw = raw.simTimeStart;

    // 3/4: Open the first step, or detect an attempt boundary within / between
    // steps. Iteration reset: counter goes down (raw.iteration <= prevIteration
    // when prevIteration >= 0) — covers a typical NR retry (e.g. 2→0) and gmin
    // stepping (0→0 between sub-solves). Phase change: cktMode-derived phase
    // differs from the prior raw's. Either marks the end of the pending attempt.
    if (currentStep === null) {
      currentStep = { stepStartTime: stepStartTimeOfRaw, attempts: [], pendingAttempt: null };
    }

    const isIterReset = raw.iteration <= prevIteration && prevIteration >= 0
      && currentStep.pendingAttempt !== null
      && currentStep.pendingAttempt.iterations.length > 0;
    const isPhaseChange = prevPhase !== null && attemptPhase !== prevPhase;

    if (currentStep.pendingAttempt === null || isIterReset || isPhaseChange) {
      if (currentStep.pendingAttempt && (isIterReset || isPhaseChange)) {
        let outcome: NRAttemptOutcome;
        // Transient INITTRAN→FLOAT and INITPRED→FLOAT happen inside one
        // ngspice NIiter call (niiter.c:1072-1076 INITF dispatcher)- the
        // mid-call mode flip is not a NR failure or a sub-solve boundary,
        // it is a phase handoff. Emit "tranPhaseHandoff" so the outcome
        // matches our engine's transient mode-ladder, instead of falsely
        // labeling it "nrFailedRetry" / "dcopSubSolveConverged".
        const isTranHandoff = isPhaseChange &&
          (currentStep.pendingAttempt.phase === "tranInit" ||
           currentStep.pendingAttempt.phase === "tranPredictor") &&
          attemptPhase === "tranNR";
        if (isTranHandoff) {
          outcome = "tranPhaseHandoff";
        } else if (currentStep.pendingAttempt.iterations.length > 0) {
          const lastIter = currentStep.pendingAttempt.iterations[currentStep.pendingAttempt.iterations.length - 1]!;
          if (lastIter.globalConverged) {
            // A converged DC-op gmin/source stepping sub-solve. Transient tranNR
            // solves never reach here- flushAttempt resolves them from the
            // ordered outer events (and throws on a missing one).
            outcome = "dcopSubSolveConverged";
          } else {
            outcome = "nrFailedRetry";
          }
        } else {
          outcome = "nrFailedRetry";
        }
        // flushAttempt resolves a tranNR attempt's verdict from the next ordered
        // outer event and sets prevTranAttemptAccepted when that verdict is an
        // accept.
        flushAttempt(currentStep, outcome);

        // Structural step boundary (no time tolerance): a new step opens only
        // when the attempt just flushed was an accepted tranNR solve
        // (prevTranAttemptAccepted) — the accept closes the transient step, so
        // the attempt now starting belongs to the next step. A reject-redo
        // leaves the flag false, so the redo's (rewound-time) attempt stays in
        // the current step instead of splitting onto its own record.
        //
        // The dcop→tran handoff is NOT a step boundary: dctran.c runs the DC
        // operating point and the first transient solve back-to-back at CKTtime
        // == 0 within one CKT step, and our engine captures the dcop ladder +
        // the first transient NR solve under a SINGLE step() call (step 0). The
        // dcop ladder sub-solves and the tranInit/tranPredictor → tranNR handoff
        // are likewise intra-step attempt boundaries, not new steps.
        if (prevTranAttemptAccepted) {
          flushStep(currentStep);
          currentStep = { stepStartTime: stepStartTimeOfRaw, attempts: [], pendingAttempt: null };
          prevTranAttemptAccepted = false;
        }
      }
      currentStep.pendingAttempt = {
        phase: attemptPhase,
        phaseFlags: raw.phaseFlags,
        iterations: [],
        firstRaw: raw,
      };
    }

    // 6: Build iteration snapshot and push
    const elementStates = unpackElementStates(raw.state0, raw.state1, raw.state2, raw.state3, topology);
    const limitingEvents: LimitingEvent[] = raw.limitingEvents.map(ev => ({
      elementIndex: -1,
      label: ev.deviceName.toUpperCase(),
      junction: ev.junction,
      limitType: "pnjlim" as const,
      vBefore: ev.vBefore,
      vAfter: ev.vAfter,
      wasLimited: ev.wasLimited,
    }));

    // ngspice integrateMethod FFI code (cktdefs.h:107-108) → harness IntegrationMethod.
    // TRAPEZOIDAL=1, GEAR=2. Code 2 → "gear"; all other values → "trapezoidal".
    const ngIntegrateMethod: IntegrationMethod =
      raw.integrateMethod === 2 ? "gear"
      : "trapezoidal";
    // Only ag0/ag1 are marshalled across the FFI (see ss8.1 of ngspice-bridge
    // struct); pad remaining slots with 0 to match the length-7 harness shape.
    const agBuf = new Float64Array(7);
    agBuf[0] = raw.ag0 ?? 0;
    agBuf[1] = raw.ag1 ?? 0;

    const iterSnap: IterationSnapshot = {
      iteration: raw.iteration,
      matrixSize: raw.matrixSize,
      rhsBufSize: raw.rhsBufSize,
      voltages: raw.rhs.slice(),
      prevVoltages: raw.rhsOld.slice(),
      preSolveRhs: raw.preSolveRhs.length > 0 ? raw.preSolveRhs.slice() : new Float64Array(0),
      matrix: raw.matrix ?? [],
      elementStates,
      noncon: raw.noncon,
      diagGmin: raw.phaseGmin,
      srcFact: raw.phaseSrcFact,
      initMode: bitsToName(raw.cktMode),
      order: raw.order,
      delta: raw.dt,
      ag: agBuf,
      method: ngIntegrateMethod,
      globalConverged: raw.converged,
      elemConverged: raw.converged,
      limitingEvents,
      convergenceFailedElements: [],
      ngspiceConvergenceFailedDevices: raw.ngspiceConvergenceFailedDevices ?? [],
    };
    iterSnap._rawIteration = raw.iteration;

    currentStep.pendingAttempt!.iterations.push(iterSnap);

    // 7: Update trackers
    prevIteration = raw.iteration;
    prevPhase = attemptPhase;
  }

  // Flush last step
  if (currentStep !== null) {
    if (currentStep.pendingAttempt) {
      // The tranNR verdict is consumed from the ordered outer events inside
      // flushAttempt. This default covers a non-transient final attempt: a
      // converged one is accepted, otherwise it is the run's final failure.
      const pend = currentStep.pendingAttempt;
      const lastIter = pend.iterations.length > 0
        ? pend.iterations[pend.iterations.length - 1]!
        : undefined;
      const fallback: NRAttemptOutcome =
        lastIter && !lastIter.globalConverged ? "finalFailure" : "accepted";
      flushAttempt(currentStep, fallback);
    }
    flushStep(currentStep);
  }

  return {
    source: "ngspice",
    topology: buildTopologySnapshot(topology, iterations[0]?.matrixSize ?? 0),
    steps,
  };
}

// ---------------------------------------------------------------------------
// NgspiceBridge
// ---------------------------------------------------------------------------

/**
 * Convert the raw ngspice AC matrix `colPtr` from its START-of-column layout
 * to the canonical END-of-column layout our SparseSolver export and every
 * downstream CSC consumer use.
 *
 * The C-side capture `ni_ac_capture_matrix` (niiter.c:432) builds colPtr with
 * `colPtr[ec+1]++`, yielding a START offset array of length `matrixSize+1`:
 * external column `col`'s non-zeros live at indices [colPtr[col], colPtr[col+1])
 * and the leading entry colPtr[0] is always 0. Our solver's export
 * (ac-analysis.ts:391-398) instead makes colPtr[c] the END of column c, so
 * column c spans [colPtr[c-1], colPtr[c]) with colPtr[0]=0 and colPtr[N]=nnz.
 *
 * The two layouts differ by exactly one position: reading raw column c as
 * [raw[c], raw[c+1]) equals reading the dropped-leading array as
 * [out[c-1], out[c]). So the normalization is `out[k] = raw[k+1]` for all k -
 * drop the leading element. The rowIdx/vals* arrays are already column-major
 * (the C scatter walks columns in order) and are reused verbatim.
 *
 * This mirrors how the DC/TRAN bridge decoder dissolves the same START layout
 * into flat {row,col} triples (ngspice-bridge.ts in the iteration callback):
 * the FFI boundary owns the convention translation so no downstream comparator
 * has to special-case the ngspice CSC.
 */
function normalizeAcColPtr(rawColPtr: Int32Array): Int32Array {
  if (rawColPtr.length <= 1) return rawColPtr;
  const out = new Int32Array(rawColPtr.length - 1);
  for (let k = 0; k < out.length; k++) out[k] = rawColPtr[k + 1];
  return out;
}

/**
 * Build an `AcCaptureSession` from the bridge's per-frequency raw points.
 *
 * Sibling of `buildCaptureSession` for the AC path. The translation is
 * mechanical- each `RawNgspiceAcPoint` becomes an `AcCapturePoint` with
 * the CSC matrix tucked into the optional `matrix` field (its colPtr
 * normalized to the canonical END-of-column convention via
 * `normalizeAcColPtr`), plus the loaded RHS. Topology is caller-supplied
 * (Phase 2 callers pass `emptyTopology()`; Phase 3 wires the proper node-name
 * resolution via NgspiceTopology).
 *
 * Pure function- unit tests drive it with synthetic raw point arrays.
 */
export function buildAcCaptureSession(
  acPoints: RawNgspiceAcPoint[],
  topology: TopologySnapshot,
): AcCaptureSession {
  // matrixSize passes through raw (ngspice's CKTmaxEqNum + 1, niiter.c:480),
  // matching the DC/TRAN per-iteration pass-through at line 522 above. Cell-
  // level comparison routes through `_ngMatrixRowMap`/`_ngMatrixColMap`
  // translation in comparison-session.ts.
  const points: AcCapturePoint[] = acPoints.map((p) => ({
    freq: p.freq,
    omega: p.omega,
    matrixSize: p.matrixSize,
    solRe: p.solRe,
    solIm: p.solIm,
    matrix: {
      nnz: p.nnz,
      colPtr: normalizeAcColPtr(p.colPtr),
      rowIdx: p.rowIdx,
      valsRe: p.valsRe,
      valsIm: p.valsIm,
    },
    rhsRe: p.rhsRe,
    rhsIm: p.rhsIm,
  }));
  return { source: "ngspice", topology, points };
}

export class NgspiceBridge {
  private _dllPath: string;
  private _lib: any;
  private _cmd: any = null;

  private _iterations: RawNgspiceIterationEx[] = [];
  private _outerEvents: RawNgspiceOuterEvent[] = [];
  private _acPoints: RawNgspiceAcPoint[] = [];
  private _rawTopology: RawNgspiceTopology | null = null;
  private _topology: NgspiceTopology | null = null;
  /** Captured [transferFunction, inputResistance, outputResistance] from the last runTf. */
  private _tfOutputs: [number, number, number] | null = null;
  /** Bound `tf_register` export, or null if the DLL predates it (not yet rebuilt). */
  private _tfRegisterFn: any = null;

  constructor(dllPath: string) {
    this._dllPath = dllPath;
  }

  async init(): Promise<void> {
    // Fail loudly with an actionable message if the resolved DLL is stale
    // (missing the AC-capture export ni_ac_register, niiter.c:334) before the
    // opaque koffi.func throw deep in callback registration below.
    await assertNgspiceDllHasAc(this._dllPath);

    const koffiModule = await import("koffi");
    const koffi = (koffiModule as any).default ?? koffiModule;
    this._lib = koffi.load(this._dllPath);

    const uid = `_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const SendChar = koffi.proto(`int SendCharCb${uid}(char*, int, void*)`);
    const SendStat = koffi.proto(`int SendStatCb${uid}(char*, int, void*)`);
    const ControlledExit = koffi.proto(`int ControlledExitCb${uid}(int, int, int, void*)`);

    // SendChar receives every line ngspice would print to stdout/stderr-
    // including "Warning: parameter X ignored" notices when our netlist
    // contains a model param ngspice's parser doesn't recognise. Silently
    // swallowing them masked netlist bugs that left ngspice in a broken
    // state and crashed the worker fork mid-run. NGSPICE_LOG=1 surfaces the
    // stream so test fixtures can be debugged.
    const logNgspice = process.env.NGSPICE_LOG === "1";
    const charCb = koffi.register((msg: string, _id: number, _ud: any) => {
      if (logNgspice && typeof msg === "string") {
        process.stderr.write(`[ngspice] ${msg}\n`);
      }
      return 0;
    }, koffi.pointer(SendChar));
    const statCb = koffi.register((msg: string, _id: number, _ud: any) => {
      if (logNgspice && typeof msg === "string") {
        process.stderr.write(`[ngspice-stat] ${msg}\n`);
      }
      return 0;
    }, koffi.pointer(SendStat));
    const exitCb = koffi.register((status: number, _unload: number, _quit: number, _ud: any) => {
      if (logNgspice) {
        process.stderr.write(`[ngspice-exit] status=${status}\n`);
      }
      return 0;
    }, koffi.pointer(ControlledExit));

    const initFn = this._lib.func(
      `int ngSpice_Init(SendCharCb${uid}*, SendStatCb${uid}*, ControlledExitCb${uid}*, void*, void*, void*, void*)`,
    );
    initFn(charCb, statCb, exitCb, null, null, null, null);

    this._registerTopologyCallback(koffi, uid);
    this._registerIterationCallback(koffi, uid);
    this._registerOuterCallback(koffi, uid);
    this._registerAcCallback(koffi, uid);
    // .tf capture is optional: a DLL built before the tf_register export
    // (tfanal.c) lacks the symbol, in which case func() throws on resolution.
    // Tolerate it so dcop/tran/ac runs keep working; runTf() reports the gap.
    try {
      this._registerTfCallback(koffi, uid);
    } catch {
      this._tfRegisterFn = null;
    }

    this._cmd = this._lib.func("int ngSpice_Command(str)");

    // Load the XSPICE code-model libraries (analog.cm: hyst, …) so decks that
    // instantiate code models (`a<name> … <model>` + `.model <model> hyst`)
    // resolve the model type. The standalone instrumented ngspice.dll is built
    // with no code models compiled in (how-to-ngspice-vstudio.txt:61-64); they
    // are loadable `.cm` DLLs registered at runtime via the `codemodel` command.
    // Must run before any `circbyline`/`.model` parse. Absent `.cm` files yield
    // an empty list, leaving primitive-only decks unchanged.
    for (const cm of resolveNgspiceCodemodelPaths()) {
      this._cmd(`codemodel ${cm}`);
    }
  }

  /**
   * Register the `.tf` capture callback. ngspice fires this once at the end of
   * TFanal (tfanal.c, `done:` label), passing the three computed scalars
   * (outputs[0..2]: transfer ratio, input resistance, output resistance) by
   * value before OUTpData hands them to the front-end plot. Reads them straight
   * from the C `outputs[]` array, so the comparison is bit-exact with no vector
   * name parsing or plot round-tripping.
   */
  private _registerTfCallback(koffi: any, uid: string): void {
    const TfCb = koffi.proto(`void tf_cb${uid}(double, double, double)`);
    const callback = koffi.register(
      (tf: number, rin: number, rout: number) => {
        this._tfOutputs = [tf, rin, rout];
      },
      koffi.pointer(TfCb),
    );
    const registerFn = this._lib.func(`void tf_register(tf_cb${uid}*)`);
    registerFn(callback);
    this._tfRegisterFn = registerFn;
  }

  /**
   * Register the AC sweep callback. ngspice fires this once per frequency
   * point inside NIacIter (after CKTacLoad + factor + SMPcSolve), passing
   * a `NiAcData*` whose layout matches the C struct in niiter.c. Eager
   * decode of every variable-length array is required- the staging buffers
   * are reused on the next frequency point.
   */
  private _registerAcCallback(koffi: any, uid: string): void {
    const NiAcData = koffi.struct(`NiAcData${uid}`, {
      matrixSize: "int",
      rhsBufSize: "int",
      nnz:        "int",
      colPtr:     koffi.pointer("int"),
      rowIdx:     koffi.pointer("int"),
      valsRe:     koffi.pointer("double"),
      valsIm:     koffi.pointer("double"),
      rhsRe:      koffi.pointer("double"),
      rhsIm:      koffi.pointer("double"),
      solRe:      koffi.pointer("double"),
      solIm:      koffi.pointer("double"),
      omega:      "double",
      freq:       "double",
    });

    const callbackType = koffi.proto(
      `void ni_ac_cb${uid}(_Inout_ NiAcData${uid}*)`,
    );
    const registerFn = this._lib.func(`void ni_ac_register(ni_ac_cb${uid}*)`);

    const callback = koffi.register(
      (dataPtr: any) => {
        const d = koffi.decode(dataPtr, NiAcData);
        const { matrixSize, rhsBufSize, nnz, omega, freq } = d;

        // colPtr length = matrixSize + 1; rowIdx/vals* length = nnz;
        // rhs*/sol* length = rhsBufSize. Eager Float64Array.from / Int32Array.from
        // copies into V8-owned buffers- the C side reuses its statics.
        const colPtr = d.colPtr
          ? Int32Array.from(koffi.decode(d.colPtr, "int", matrixSize + 1))
          : new Int32Array(matrixSize + 1);
        const rowIdx = d.rowIdx && nnz > 0
          ? Int32Array.from(koffi.decode(d.rowIdx, "int", nnz))
          : new Int32Array(0);
        const valsRe = d.valsRe && nnz > 0
          ? Float64Array.from(koffi.decode(d.valsRe, "double", nnz))
          : new Float64Array(0);
        const valsIm = d.valsIm && nnz > 0
          ? Float64Array.from(koffi.decode(d.valsIm, "double", nnz))
          : new Float64Array(0);
        const rhsRe = d.rhsRe
          ? Float64Array.from(koffi.decode(d.rhsRe, "double", rhsBufSize))
          : new Float64Array(rhsBufSize);
        const rhsIm = d.rhsIm
          ? Float64Array.from(koffi.decode(d.rhsIm, "double", rhsBufSize))
          : new Float64Array(rhsBufSize);
        const solRe = d.solRe
          ? Float64Array.from(koffi.decode(d.solRe, "double", rhsBufSize))
          : new Float64Array(rhsBufSize);
        const solIm = d.solIm
          ? Float64Array.from(koffi.decode(d.solIm, "double", rhsBufSize))
          : new Float64Array(rhsBufSize);

        this._acPoints.push({
          matrixSize, rhsBufSize, nnz,
          colPtr, rowIdx,
          valsRe, valsIm,
          rhsRe, rhsIm,
          solRe, solIm,
          omega, freq,
        });
      },
      koffi.pointer(callbackType),
    );

    registerFn(callback);
  }

  private _registerTopologyCallback(koffi: any, uid: string): void {
    const topoCbType = koffi.proto(
      `void ni_topo_cb${uid}(` +
      `str, _Inout_ int*, int, ` +
      `str, str, ` +
      `_Inout_ int*, int, ` +
      `int, int, ` +
      `_Inout_ int*, _Inout_ int*)`,
    );

    const registerFn = this._lib.func(`void ni_topology_register(ni_topo_cb${uid}*)`);

    const callback = koffi.register(
      (nodeNamesJoined: string, nodeNumbersPtr: any, nodeCount: number,
       devNamesJoined: string, devTypesJoined: string,
       devStateBasesPtr: any, devCount: number,
       matrixSize: number, numStates: number,
       devNodeFlatRaw: any, devNodeCountsRaw: any) => {

        const nodeNames = nodeNamesJoined ? nodeNamesJoined.split("|") : [];
        const devNames = devNamesJoined ? devNamesJoined.split("|") : [];
        const devTypes = devTypesJoined ? devTypesJoined.split("|") : [];

        const nodeNumbers: number[] = nodeNumbersPtr
          ? Array.from(koffi.decode(nodeNumbersPtr, "int", nodeCount)) : [];
        const devStateBases: number[] = devStateBasesPtr
          ? Array.from(koffi.decode(devStateBasesPtr, "int", devCount)) : [];

        const nodeCounts: number[] | null = devNodeCountsRaw
          ? Array.from(koffi.decode(devNodeCountsRaw, "int", devCount)) : null;

        const totalNodeIndices = nodeCounts ? nodeCounts.reduce((a, b) => a + b, 0) : 0;
        const devNodeFlat: number[] | null = devNodeFlatRaw && nodeCounts && totalNodeIndices > 0
          ? Array.from(koffi.decode(devNodeFlatRaw, "int", totalNodeIndices)) : null;

        const nodes: RawNgspiceTopology["nodes"] = [];
        for (let i = 0; i < nodeCount; i++) {
          nodes.push({ name: nodeNames[i] ?? "", number: nodeNumbers[i] ?? i });
        }

        const devices: RawNgspiceTopology["devices"] = [];
        let flatOffset = 0;
        for (let i = 0; i < devCount; i++) {
          const count = nodeCounts?.[i] ?? 0;
          const nodeIndices = devNodeFlat ? devNodeFlat.slice(flatOffset, flatOffset + count) : [];
          flatOffset += count;
          devices.push({
            name: devNames[i] ?? "",
            typeName: devTypes[i] ?? "",
            stateBase: devStateBases[i] ?? 0,
            nodeIndices,
          });
        }

        this._rawTopology = { matrixSize, numStates, nodes, devices };
        this._topology = this._parseTopology(this._rawTopology);
      },
      koffi.pointer(topoCbType),
    );

    registerFn(callback);
  }

  private _registerIterationCallback(koffi: any, uid: string): void {
    // NiIterationData struct- extended with simTimeStart + phase fields
    const NiIterationData = koffi.struct(`NiIterationData${uid}`, {
      iteration:        "int",
      matrixSize:       "int",
      // SMPmatSize+1- actual rhs/rhsOld/preSolveRhs slot count. Can be smaller
      // than matrixSize when devices stamp into ground row/col via TrashCan;
      // decoding matrixSize doubles from rhs/rhsOld then reads OOB heap.
      rhsBufSize:       "int",
      rhs:              koffi.pointer("double"),
      rhsOld:           koffi.pointer("double"),
      preSolveRhs:      koffi.pointer("double"),
      state0:           koffi.pointer("double"),
      state1:           koffi.pointer("double"),
      state2:           koffi.pointer("double"),
      state3:           koffi.pointer("double"),
      numStates:        "int",
      noncon:           "int",
      converged:        "int",
      simTime:          "double",
      dt:               "double",
      cktMode:          "int",
      ag0:              "double",
      ag1:              "double",
      integrateMethod:  "int",
      order:            "int",
      matrixColPtr:     koffi.pointer("int"),
      matrixRowIdx:     koffi.pointer("int"),
      matrixVals:       koffi.pointer("double"),
      matrixNnz:        "int",
      devConvFailed:    koffi.pointer("int"),
      devConvCount:     "int",
      numLimitEvents:   "int",
      limitDevIdx:      koffi.pointer("int"),
      limitJunctionId:  koffi.pointer("int"),
      limitVBefore:     koffi.pointer("double"),
      limitVAfter:      koffi.pointer("double"),
      limitWasLimited:  koffi.pointer("int"),
      // New fields (spec ss3.5, ss8.1, ss8.2)
      simTimeStart:     "double",
      phaseGmin:        "double",
      phaseSrcFact:     "double",
      phaseFlags:       "int",
    });

    const callbackType = koffi.proto(
      `void ni_instrument_cb_v2${uid}(_Inout_ NiIterationData${uid}*)`,
    );
    const registerFn = this._lib.func(`void ni_instrument_register(ni_instrument_cb_v2${uid}*)`);

    const callback = koffi.register(
      (dataPtr: any) => {
        const d = koffi.decode(dataPtr, NiIterationData);

        const { iteration, matrixSize, rhsBufSize, numStates, noncon, simTime, simTimeStart,
                dt, cktMode, ag0, ag1, integrateMethod, order,
                matrixNnz, devConvCount, numLimitEvents,
                phaseFlags, phaseGmin, phaseSrcFact } = d;

        // rhs/rhsOld/preSolveRhs are sized SMPmatSize+1 = rhsBufSize on the C
        // side (nireinit.c:31). matrixSize = CKTmaxEqNum+1 may exceed that
        // when devices stamp into ground row/col via TrashCan- decoding
        // matrixSize doubles then reads OOB and returns NaN-shaped garbage.
        // Math.min is defensive; rhsBufSize alone should already be ≤ matrixSize.
        const rhsLen = Math.min(matrixSize, rhsBufSize);

        const rhs = d.rhs
          ? Float64Array.from(koffi.decode(d.rhs, "double", rhsLen))
          : new Float64Array(rhsLen);
        const rhsOld = d.rhsOld
          ? Float64Array.from(koffi.decode(d.rhsOld, "double", rhsLen))
          : new Float64Array(rhsLen);
        const preSolveRhs = d.preSolveRhs
          ? Float64Array.from(koffi.decode(d.preSolveRhs, "double", rhsLen))
          : new Float64Array(rhsLen);
        const state0 = d.state0
          ? Float64Array.from(koffi.decode(d.state0, "double", numStates))
          : new Float64Array(numStates);
        const state1 = d.state1
          ? Float64Array.from(koffi.decode(d.state1, "double", numStates))
          : new Float64Array(numStates);
        const state2 = d.state2
          ? Float64Array.from(koffi.decode(d.state2, "double", numStates))
          : new Float64Array(numStates);
        const state3 = d.state3
          ? Float64Array.from(koffi.decode(d.state3, "double", numStates))
          : new Float64Array(numStates);

        const matrixColPtrArr: number[] | null = matrixNnz > 0 && d.matrixColPtr
          ? Array.from(koffi.decode(d.matrixColPtr, "int", matrixSize + 1)) as number[] : null;
        const matrixRowIdxArr: number[] | null = matrixNnz > 0 && d.matrixRowIdx
          ? Array.from(koffi.decode(d.matrixRowIdx, "int", matrixNnz)) as number[] : null;
        const matrixValsArr: number[] | null = matrixNnz > 0 && d.matrixVals
          ? Array.from(koffi.decode(d.matrixVals, "double", matrixNnz)) as number[] : null;

        const matrix: MatrixEntry[] = [];
        if (matrixColPtrArr && matrixRowIdxArr && matrixValsArr) {
          for (let col = 0; col < matrixSize; col++) {
            for (let p = matrixColPtrArr[col]; p < matrixColPtrArr[col + 1]; p++) {
              matrix.push({ row: matrixRowIdxArr[p], col, value: matrixValsArr[p] });
            }
          }
        }

        const devConvFailedArr = devConvCount > 0 && d.devConvFailed
          ? Array.from(koffi.decode(d.devConvFailed, "int", devConvCount)) : [];
        const ngspiceConvergenceFailedDevices: string[] = (devConvFailedArr as number[]).map((devIdx: number) => {
          const dev = this._topology?.devices[devIdx];
          return dev ? dev.name : `device_${devIdx}`;
        });

        const rawLimitingEvents: RawNgspiceIterationEx["limitingEvents"] = [];
        if (numLimitEvents > 0 && d.limitDevIdx && d.limitJunctionId && d.limitVBefore && d.limitVAfter && d.limitWasLimited) {
          const devIdxArr = Array.from(koffi.decode(d.limitDevIdx, "int", numLimitEvents)) as number[];
          const junctionIdArr = Array.from(koffi.decode(d.limitJunctionId, "int", numLimitEvents)) as number[];
          const vBeforeArr = Array.from(koffi.decode(d.limitVBefore, "double", numLimitEvents)) as number[];
          const vAfterArr = Array.from(koffi.decode(d.limitVAfter, "double", numLimitEvents)) as number[];
          const wasLimitedArr = Array.from(koffi.decode(d.limitWasLimited, "int", numLimitEvents)) as number[];

          for (let i = 0; i < numLimitEvents; i++) {
            const devIdx = devIdxArr[i];
            const dev = this._topology?.devices[devIdx];
            rawLimitingEvents.push({
              deviceName: dev ? dev.name : `device_${devIdx}`,
              junction: JUNCTION_ID_MAP[junctionIdArr[i]] ?? `J${junctionIdArr[i]}`,
              vBefore: vBeforeArr[i],
              vAfter: vAfterArr[i],
              wasLimited: wasLimitedArr[i] !== 0,
            });
          }
        }

        this._iterations.push({
          iteration, matrixSize, rhsBufSize, rhs, rhsOld, preSolveRhs,
          state0, state1, state2, state3,
          numStates, noncon, converged: d.converged !== 0,
          simTime, simTimeStart, dt, cktMode,
          ag0, ag1, integrateMethod, order,
          phaseFlags, phaseGmin, phaseSrcFact,
          matrix,
          ngspiceConvergenceFailedDevices,
          limitingEvents: rawLimitingEvents,
        });
      },
      koffi.pointer(callbackType),
    );

    registerFn(callback);
  }

  /**
   * Register the outer-loop callback (ni_outer_cb) fired from dctran.c
   * after each timestep-loop iteration (accept/lteReject/nrFail/finalFailure).
   */
  private _registerOuterCallback(koffi: any, uid: string): void {
    // NiOuterData struct matching C typedef in niiter.c
    const NiOuterData = koffi.struct(`NiOuterData${uid}`, {
      simTimeStart: "double",
      delta:        "double",
      lteRejected:  "int",
      nrFailed:     "int",
      accepted:     "int",
      finalFailure: "int",
      nextDelta:    "double",
    });

    const outerCbType = koffi.proto(
      `void ni_outer_cb_t${uid}(_Inout_ NiOuterData${uid}*)`,
    );
    const registerFn = this._lib.func(`void ni_outer_register(ni_outer_cb_t${uid}*)`);

    const callback = koffi.register(
      (dataPtr: any) => {
        const d = koffi.decode(dataPtr, NiOuterData);
        this._outerEvents.push({
          simTimeStart: d.simTimeStart,
          delta: d.delta,
          lteRejected: d.lteRejected,
          nrFailed: d.nrFailed,
          accepted: d.accepted,
          finalFailure: d.finalFailure,
          nextDelta: d.nextDelta,
        });
      },
      koffi.pointer(outerCbType),
    );

    registerFn(callback);
  }

  private _parseTopology(raw: RawNgspiceTopology): NgspiceTopology {
    const nodeNames = new Map<string, number>();
    for (const n of raw.nodes) {
      // Filter out ngspice's ground slot ("0" => 0). Our engine eliminates
      // ground from the MNA system; keeping it in nodeNames would cause
      // ngspice's ground-column stamps to surface as spurious engineSpecific
      // rows in the matrix comparison.
      if (n.name && n.name !== "0") nodeNames.set(n.name, n.number);
    }
    const devices: NgspiceDeviceInfo[] = raw.devices.map(d => ({
      name: d.name, typeName: d.typeName, stateBase: d.stateBase, nodeIndices: d.nodeIndices,
    }));
    // Normalize ngspice's matrixSize to our convention (raw active-equation
    // count N). ngspice reports `CKTmaxEqNum + 1` = N + 2: cktinit.c:43 seeds
    // CKTmaxEqNum at 1 (ground sentinel), cktlnkeq.c:32 post-increments on
    // every CKTmkVolt/CKTmkCur (so after N allocs it sits at N+1, one past
    // last), and the public matrixSize getter adds one more. Our sparse
    // solver's `_size` (exposed via engine.matrixSize) is the raw N. Subtract
    // 2 here so `NgspiceTopology.matrixSize` carries the same metric as
    // `TopologySnapshot.matrixSize` and topologyDiff/_buildTopologySnapshot
    // consumers see matching numbers when the physical matrices match.
    const normalizedMatrixSize = raw.matrixSize > 0 ? raw.matrixSize - 2 : 0;
    return { matrixSize: normalizedMatrixSize, numStates: raw.numStates, nodeNames, devices };
  }

  loadNetlist(netlist: string): void {
    for (const line of netlist.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) this._cmd(`circbyline ${trimmed}`);
    }
  }

  runDcOp(): void {
    this._iterations = [];
    this._outerEvents = [];
    this._cmd("op");
  }

  /**
   * Issue the ngspice `optran` command, then run `op`.
   *
   * `optran <noopiter> <ngminsteps> <nsrcsteps> <opstepsize> <opfinaltime>
   * <opramptime>` (com_optran.c:53-69). The first three integers override
   * noopiter / gminsteps / srcsteps for this run; the trailing three floats set
   * opstepsize / opfinaltime / opramptime, clearing the `nooptran` default flag
   * (com_optran.c:110) so CKTop's `OPtran(ckt, converged)` fall-through
   * (cktop.c:104) actually runs. We pass `1 1 1` so direct NR + gmin stepping +
   * source stepping all run first (matching digiTS's static ladder), and OPtran
   * engages only after they exhaust- exactly the cktop.c:101-108 ordering the
   * #4 gate exercises. Issuing `optran` from the control lane is the
   * `.control`/`.spiceinit` route com_optran.c documents (optran.c:66-69).
   */
  runOpTran(opstepsize: string, opfinaltime: string, opramptime: string): void {
    this._iterations = [];
    this._outerEvents = [];
    this._cmd(`optran 1 1 1 ${opstepsize} ${opfinaltime} ${opramptime}`);
    this._cmd("op");
  }

  /**
   * Issue ngspice `.tran TSTEP TSTOP <TSTART <TMAX>>`.
   *
   * Parameter naming matches the .tran spec exactly so callers can't conflate
   * TSTEP (the printing/output interval, → CKTstep) with TMAX (the integration
   * ceiling, → CKTmaxStep). The two govern very different things:
   *   - CKTstep drives `delta = MIN(CKTfinalTime/100, CKTstep)/10` (dctran.c:118).
   *   - CKTmaxStep drives the per-step `MIN(CKTdelta, CKTmaxStep)` clamp at
   *     dctran.c:540 and (when TMAX is omitted) auto-derives via
   *     `CKTmaxStep = MIN(CKTstep, (TSTOP-TSTART)/50)` (traninit.c:23-32).
   * Conflating them silently desyncs `delta` from any digiTS engine config that
   * separately picks `outputStep = tStop/100` and `maxTimeStep = maxStep`.
   */
  runTran(tStop: string, tStep: string, tMax?: string): void {
    this._iterations = [];
    this._outerEvents = [];
    if (tMax !== undefined) {
      // 4-arg form requires TSTART positionally; harness path always uses 0.
      this._cmd(`tran ${tStep} ${tStop} 0 ${tMax}`);
    } else {
      this._cmd(`tran ${tStep} ${tStop}`);
    }
  }

  /**
   * ngspice `stop when time > <t>` (com_stop, breakp.c:88-153). `t` is a
   * space-separated SPICE-time string; ngspice stores the LHS "time" as a
   * vector name and the RHS as a value, comparing with DBC_GT each accepted
   * step. The condition holds for ALL steps past `t`, so it must be cleared
   * (`deleteStops`) before `resume` or it re-trips immediately.
   */
  stopWhenTime(t: string): void { this._cmd(`stop when time > ${t}`); }

  /** ngspice `delete all` — frees every stop condition (com_delete, breakp.c:414-419). */
  deleteStops(): void { this._cmd("delete all"); }

  /**
   * ngspice `alter <dev> <param>=<value>` — instance-parameter hot-load on the
   * live circuit (com_alter_common device.c:1271-1446 → if_setparam, do_model=0).
   * ngspice lowercases the device/param itself (device.c:1376-1377).
   */
  alterDevice(name: string, param: string, value: number): void {
    this._cmd(`alter ${name} ${param}=${value}`);
  }

  /**
   * ngspice `altermod <mod> <param>=<value>` — model-parameter hot-load
   * (com_altermod → com_alter_common, do_model=1); when CKTtime>0 if_setparam
   * re-runs CKTtemp to re-fold derived params (spiceif.c:980).
   */
  alterModel(name: string, param: string, value: number): void {
    this._cmd(`altermod ${name} ${param}=${value}`);
  }

  /** ngspice `resume` — continue the paused transient at the saved CKTtime/order/delta (dctran.c:340-358). */
  resume(): void { this._cmd("resume"); }

  /**
   * Transient run with mid-run parameter hot-loads, mirroring the interactive
   * alter+resume flow. Pauses at each hot-load time via `stop when time >`,
   * applies alter/altermod, clears the stop, and resumes. Capture accumulates
   * across all legs: `runTran` resets `_iterations`/`_outerEvents` once at the
   * start, and each `resume` leg appends to them as the ni_* callbacks re-fire.
   */
  runTranWithHotloads(
    tStop: string,
    tStep: string,
    tMax: string | undefined,
    hotloads: HotloadEvent[],
  ): void {
    const evs = [...hotloads].sort((a, b) => Number(a.atTime) - Number(b.atTime));
    this.stopWhenTime(evs[0]!.atTime);
    this.runTran(tStop, tStep, tMax); // resets capture buffers, runs to first stop
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i]!;
      if (e.isModel) this.alterModel(e.device, e.param, e.value);
      else this.alterDevice(e.device, e.param, e.value);
      this.deleteStops();
      if (i + 1 < evs.length) this.stopWhenTime(evs[i + 1]!.atTime);
      this.resume(); // continue to the next stop, or to tStop on the last leg
    }
  }

  /**
   * Issue ngspice `.ac <type> <n> <fStart> <fStop>`.
   * The deck must contain an AC voltage source (`vX n+ n- ac 1`) for the
   * sweep to do anything- ngspice's `ACan` does a DC operating point then
   * a linear complex solve at each frequency point. The AC callback
   * (registered in `_registerAcCallback`) fires once per frequency.
   *
   * - `type = "dec"`: `n` points per decade
   * - `type = "oct"`: `n` points per octave
   * - `type = "lin"`: `n` total points across the band
   */
  runAc(type: "dec" | "oct" | "lin", n: number, fStart: number, fStop: number): void {
    this._iterations = [];
    this._outerEvents = [];
    this._acPoints = [];
    this._cmd(`ac ${type} ${n} ${fStart} ${fStop}`);
  }

  /** Per-frequency AC capture from the last `runAc` call (in sweep order). */
  getAcPoints(): RawNgspiceAcPoint[] { return this._acPoints.slice(); }

  /**
   * Issue ngspice `tf <output> <insrc>` (com_dctf.c → TFanal).
   *
   * `output` is the output-variable expression in ngspice syntax (`v(node)` or
   * a source current `i(vsrc)`); `insrc` is the input source label. TFanal runs
   * a DC operating point then two RHS-injection re-solves over the factored
   * Jacobian (tfanal.c) and the tf_register callback captures the three scalars.
   */
  runTf(output: string, insrc: string): void {
    if (!this._tfRegisterFn) {
      throw new Error(
        "ngspice DLL lacks the tf_register export (tfanal.c)- rebuild the DLL " +
        "(make-install-vngspice) before running .tf parity.",
      );
    }
    this._iterations = [];
    this._outerEvents = [];
    this._tfOutputs = null;
    // ngspice lowercases device/node identifiers on parse, and CKTfndBranch /
    // CKTfndDev (tfanal.c:49,82) look up the lowercased name; an uppercased
    // source label (e.g. "V1") misses, so TFanal returns E_NOTFOUND before the
    // tf_register fire site and we capture nothing. Lower-case the command
    // tokens to match the stored names (ngspice identifiers are case-insensitive).
    this._cmd(`tf ${output.toLowerCase()} ${insrc.toLowerCase()}`);
  }

  /** The three `.tf` scalars from the last `runTf` call, or null if none ran. */
  getTfOutputs(): [number, number, number] | null { return this._tfOutputs; }

  getTopology(): NgspiceTopology | null { return this._topology; }
  getRawTopology(): RawNgspiceTopology | null { return this._rawTopology; }

  /**
   * Convert accumulated iteration data into a CaptureSession. Thin wrapper
   * over the module-level pure `buildCaptureSession` — unit tests call that
   * directly with synthetic inputs.
   */
  getCaptureSession(): CaptureSession {
    return buildCaptureSession(this._iterations, this._outerEvents, this._topology);
  }

  dispose(): void {
    if (this._lib) {
      this._lib.func("void ni_ac_register(void*)")(null);
      this._lib.func("void ni_outer_register(void*)")(null);
      this._lib.func("void ni_instrument_register(void*)")(null);
      this._lib.func("void ni_topology_register(void*)")(null);
      if (this._tfRegisterFn) this._lib.func("void tf_register(void*)")(null);
      this._lib = null;
    }
  }
}

// ---------------------------------------------------------------------------
// In-process run entry point (single koffi load site)
//
// `runNgspiceInProcess` is the ONLY place in the harness that drives an
// `NgspiceBridge` end to end (init → loadNetlist → run → capture → dispose).
// Both the in-process call path and the out-of-process worker
// (`ngspice-worker.ts`) funnel through it, so the FFI loading + callback
// registration logic lives in exactly one place. The crash-prone callers
// (MCP `harness_run`, `ComparisonSession`) route here through the guard
// (`ngspice-guarded.ts`) which spawns the worker; the worker then calls
// THIS function in its isolated child process.
// ---------------------------------------------------------------------------

/**
 * One mid-transient parameter hot-load, applied on the ngspice side via the
 * interactive `alter`/`altermod` + `resume` flow (com_alter device.c:1249,
 * if_setparam spiceif.c:944; com_resume runcoms2.c:60). `atTime` is a SPICE-time
 * string formatted caller-side (matching the deck's tStop/tStep) so the worker
 * can issue `stop when time > atTime` (com_stop breakp.c:88) without re-parsing
 * a JS number into an engineering-suffix literal.
 */
export interface HotloadEvent {
  atTime: string;
  device: string;
  param: string;
  value: number;
  /** true → altermod (model param; if_setparam re-runs CKTtemp at spiceif.c:980); false → alter (instance). */
  isModel: boolean;
}

/** The analysis to run, plus its parameters, in a serialization-friendly shape. */
export type NgspiceJobAnalysis =
  | { kind: "dcop" }
  | { kind: "optran"; opstepsize: string; opfinaltime: string; opramptime: string }
  | { kind: "tran"; tStop: string; tStep: string; tMax?: string; hotloads?: HotloadEvent[] }
  | { kind: "ac"; type: "dec" | "oct" | "lin"; n: number; fStart: number; fStop: number }
  | { kind: "tf"; output: string; insrc: string };

/**
 * Fully self-describing ngspice run request. Carries everything the worker
 * needs to reproduce one bridge run in an isolated process: the resolved DLL
 * path, the materialized netlist deck (already TEMP-injected / control-stripped
 * by the caller), and the analysis spec. No engine objects, file handles, or
 * closures — it round-trips through JSON unchanged.
 */
export interface NgspiceJobSpec {
  dllPath: string;
  netlist: string;
  analysis: NgspiceJobAnalysis;
}

/**
 * Result of an in-process ngspice run. For DC/TRAN the `session` carries the
 * full `CaptureSession` (with topology). For AC the `acPoints` carry the raw
 * per-frequency points (the caller builds the `AcCaptureSession` via
 * `buildAcCaptureSession`, since topology resolution is caller-owned). The
 * `topology` (raw + parsed) is returned alongside so the AC path can reuse the
 * same node-mapping the DC/TRAN path gets for free inside `CaptureSession`.
 */
export interface NgspiceRunResult {
  analysis: "dcop" | "tran" | "ac" | "tf";
  /** Populated for dcop / tran. */
  session: CaptureSession | null;
  /** Populated for ac. */
  acPoints: RawNgspiceAcPoint[] | null;
  /** Populated for tf: [transferFunction, inputResistance, outputResistance]. */
  tfOutputs: [number, number, number] | null;
  /** Raw + parsed ngspice topology (needed by AC caller for node mapping). */
  ngspiceTopology: NgspiceTopology | null;
  rawNgspiceTopology: RawNgspiceTopology | null;
}

/**
 * Drive one full ngspice bridge run in the CURRENT process.
 *
 * This is the pure FFI work shared by the in-process path and the guarded
 * worker child. It throws on any bridge error (DLL load failure, missing AC
 * symbol, ngspice command failure) — callers wrap it (the worker serializes
 * the throw to an error JSON; the guard surfaces it as a typed error).
 *
 * SAFETY: this loads ngspice via koffi in-process and has NO timeout / memory
 * cap of its own. A runaway native deck (e.g. VDMOS) can exhaust the host. Do
 * not call this directly for untrusted/crash-prone decks — go through
 * `runNgspiceGuarded` (ngspice-guarded.ts) which runs the worker that calls
 * this in an isolated, Job-Object-capped child.
 */
export async function runNgspiceInProcess(spec: NgspiceJobSpec): Promise<NgspiceRunResult> {
  const bridge = new NgspiceBridge(spec.dllPath);
  try {
    await bridge.init();
    bridge.loadNetlist(spec.netlist);
    if (spec.analysis.kind === "dcop") {
      bridge.runDcOp();
      return {
        analysis: "dcop",
        session: bridge.getCaptureSession(),
        acPoints: null,
        tfOutputs: null,
        ngspiceTopology: bridge.getTopology(),
        rawNgspiceTopology: bridge.getRawTopology(),
      };
    } else if (spec.analysis.kind === "optran") {
      bridge.runOpTran(
        spec.analysis.opstepsize,
        spec.analysis.opfinaltime,
        spec.analysis.opramptime,
      );
      // The OPtran run is still an operating-point analysis on the ngspice
      // side- it captures the same iteration/topology session shape as `op`,
      // tagged "dcop" so downstream pairing (runDcOp on our side) lines up.
      return {
        analysis: "dcop",
        session: bridge.getCaptureSession(),
        acPoints: null,
        tfOutputs: null,
        ngspiceTopology: bridge.getTopology(),
        rawNgspiceTopology: bridge.getRawTopology(),
      };
    } else if (spec.analysis.kind === "tran") {
      if (spec.analysis.hotloads?.length) {
        bridge.runTranWithHotloads(
          spec.analysis.tStop,
          spec.analysis.tStep,
          spec.analysis.tMax,
          spec.analysis.hotloads,
        );
      } else {
        bridge.runTran(spec.analysis.tStop, spec.analysis.tStep, spec.analysis.tMax);
      }
      return {
        analysis: "tran",
        session: bridge.getCaptureSession(),
        acPoints: null,
        tfOutputs: null,
        ngspiceTopology: bridge.getTopology(),
        rawNgspiceTopology: bridge.getRawTopology(),
      };
    } else if (spec.analysis.kind === "tf") {
      bridge.runTf(spec.analysis.output, spec.analysis.insrc);
      return {
        analysis: "tf",
        session: null,
        acPoints: null,
        tfOutputs: bridge.getTfOutputs(),
        ngspiceTopology: bridge.getTopology(),
        rawNgspiceTopology: bridge.getRawTopology(),
      };
    } else {
      bridge.runAc(spec.analysis.type, spec.analysis.n, spec.analysis.fStart, spec.analysis.fStop);
      return {
        analysis: "ac",
        session: null,
        acPoints: bridge.getAcPoints(),
        tfOutputs: null,
        ngspiceTopology: bridge.getTopology(),
        rawNgspiceTopology: bridge.getRawTopology(),
      };
    }
  } finally {
    bridge.dispose();
  }
}
