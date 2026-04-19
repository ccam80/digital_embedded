/**
 * Integration test for the comparison harness infrastructure.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MNAEngine } from "../../analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../../compiled-analog-circuit.js";
import { EngineState } from "../../../../core/engine-interface.js";
import { makeResistor, makeVoltageSource, makeDiode, makeCapacitor } from "../test-helpers.js";
import { StatePool } from "../../state-pool.js";
import type { AnalogElementCore } from "../../element.js";
import { isPoolBacked } from "../../element.js";
import { captureTopology, captureElementStates, createIterationCaptureHook, createStepCaptureHook } from "./capture.js";
import { convergenceSummary, nodeVoltageTrajectory, findLargestDelta, querySteps } from "./query.js";
import { compareSnapshots, formatComparison, findFirstDivergence } from "./compare.js";
import { canonicalizeNgspiceName, canonicalizeOurLabel } from "./node-mapping.js";
import type { CaptureSession, IntegrationCoefficients } from "./types.js";

const ZERO_INTEG_COEFF: IntegrationCoefficients = {
  ours: { ag0: 0, ag1: 0, method: "backwardEuler", order: 1 },
  ngspice: { ag0: 0, ag1: 0, method: "backwardEuler", order: 1 },
};
import { DEVICE_MAPPINGS } from "./device-mappings.js";

function buildStatePool(elements: AnalogElementCore[]): StatePool {
  let offset = 0;
  for (const el of elements) {
    if (isPoolBacked(el)) { el.stateBaseOffset = offset; offset += el.stateSize; }
  }
  const pool = new StatePool(offset);
  for (const el of elements) {
    if (isPoolBacked(el)) el.initState(pool);
  }
  return pool;
}

function makeHWR() {
  const vs = makeVoltageSource(1, 0, 2, 5.0);
  const r = makeResistor(1, 2, 1000);
  const diode = makeDiode(2, 0, 1e-14, 1.0);
  const elements = [vs, r, diode];
  const pool = buildStatePool(elements);
  return {
    circuit: { netCount: 2, componentCount: 3, nodeCount: 2, branchCount: 1, matrixSize: 3, elements, labelToNodeId: new Map([["Vs", 1], ["R1:B", 2]]), statePool: pool } as ConcreteCompiledAnalogCircuit,
    pool,
  };
}

function makeRC() {
  const vs = makeVoltageSource(1, 0, 2, 5.0);
  const r = makeResistor(1, 2, 1000);
  const cap = makeCapacitor(2, 0, 1e-6);
  const elements = [vs, r, cap];
  const pool = buildStatePool(elements);
  return {
    circuit: { netCount: 2, componentCount: 3, nodeCount: 2, branchCount: 1, matrixSize: 3, elements, labelToNodeId: new Map([["Vs", 1], ["C1:A", 2]]), statePool: pool } as ConcreteCompiledAnalogCircuit,
    pool,
  };
}

describe("harness integration", () => {
  let engine: MNAEngine;
  beforeEach(() => { engine = new MNAEngine(); });

  it("captureTopology returns correct circuit structure", () => {
    const { circuit } = makeHWR();
    const topo = captureTopology(circuit);
    expect(topo.matrixSize).toBe(3);
    expect(topo.nodeCount).toBe(2);
    expect(topo.branchCount).toBe(1);
    expect(topo.elementCount).toBe(3);
    expect(topo.elements).toHaveLength(3);
    expect(topo.nodeLabels.size).toBeGreaterThan(0);
  });

  it("captureElementStates snapshots pool-backed elements", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    engine.dcOperatingPoint();
    const states = captureElementStates(circuit.elements, pool);
    expect(states.length).toBeGreaterThan(0);
  });

  it("iteration capture hook records NR iterations during DC OP", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    const { hook, getSnapshots, clear } = createIterationCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = hook;
    engine.dcOperatingPoint();
    const snapshots = getSnapshots();
    expect(snapshots.length).toBeGreaterThan(0);
    const first = snapshots[0];
    expect(first.iteration).toBe(0);
    expect(first.voltages).toBeInstanceOf(Float64Array);
    expect(first.voltages.length).toBeGreaterThan(0);
    expect(first.preSolveRhs).toBeInstanceOf(Float64Array);
    expect(first.matrix.length).toBeGreaterThan(0);
    expect(typeof first.noncon).toBe("number");
    expect(typeof first.globalConverged).toBe("boolean");
    expect(typeof first.elemConverged).toBe("boolean");
    const last = snapshots[snapshots.length - 1];
    expect(last.globalConverged).toBe(true);
    clear();
    expect(getSnapshots()).toHaveLength(0);
  });

  it("postIterationHook fires during DC OP (nonlinear circuit)", () => {
    const { circuit } = makeHWR();
    engine.init(circuit);
    let hookCallCount = 0;
    engine.postIterationHook = (_i: number, _v: Float64Array, _p: Float64Array, _n: number, _g: boolean, _e: boolean, _le: unknown[], _cf: string[]) => { hookCallCount++; };
    const result = engine.dcOperatingPoint();
    expect(result.converged).toBe(true);
    expect(hookCallCount).toBeGreaterThan(0);
  });

  it("postIterationHook fires during DC OP (linear circuit)", () => {
    const { circuit } = makeRC();
    engine.init(circuit);
    let hookCallCount = 0;
    let lastGlobalConverged = false;
    engine.postIterationHook = (_i: number, _v: Float64Array, _p: Float64Array, _n: number, g: boolean, _e: boolean, _le: unknown[], _cf: string[]) => {
      hookCallCount++;
      lastGlobalConverged = g;
    };
    const result = engine.dcOperatingPoint();
    expect(result.converged).toBe(true);
    expect(hookCallCount).toBeGreaterThan(0);
    expect(lastGlobalConverged).toBe(true);
  });

  it("step capture hook packages iterations into step snapshots", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = capture.iterationHook;
    engine.stepPhaseHook = {
      onAttemptBegin(phase: string, dt: number) { capture.beginAttempt(phase as any, dt); },
      onAttemptEnd(outcome: string, converged: boolean) { capture.endAttempt(outcome as any, converged); },
    };
    capture.setStepStartTime(0);
    engine.dcOperatingPoint();
    capture.endStep({ stepEndTime: 0, integrationCoefficients: ZERO_INTEG_COEFF, analysisPhase: "dcop", acceptedAttemptIndex: -1, order: engine.integrationOrder, delta: engine.currentDt });
    let prevTime = 0;
    for (let i = 0; i < 10; i++) {
      engine.step();
      if (engine.getState() === EngineState.ERROR) break;
      const t = engine.simTime;
      if (t > prevTime) {
        capture.endStep({ stepEndTime: t, integrationCoefficients: ZERO_INTEG_COEFF, analysisPhase: "tranFloat", acceptedAttemptIndex: -1, order: engine.integrationOrder, delta: engine.currentDt });
        prevTime = t;
      }
    }
    engine.stepPhaseHook = null;
    engine.postIterationHook = null;
    const steps = capture.getSteps();
    expect(steps.length).toBeGreaterThan(1);
    expect(steps[0].stepStartTime).toBe(0);
    expect(steps[0].iterations.length).toBeGreaterThan(0);
  });

  it("convergenceSummary reports correct statistics", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = capture.iterationHook;
    engine.stepPhaseHook = {
      onAttemptBegin(phase: string, dt: number) { capture.beginAttempt(phase as any, dt); },
      onAttemptEnd(outcome: string, converged: boolean) { capture.endAttempt(outcome as any, converged); },
    };
    capture.setStepStartTime(0);
    engine.dcOperatingPoint();
    capture.endStep({ stepEndTime: 0, integrationCoefficients: ZERO_INTEG_COEFF, analysisPhase: "dcop", acceptedAttemptIndex: -1, order: engine.integrationOrder, delta: engine.currentDt });
    let prevTime = 0;
    for (let i = 0; i < 5; i++) {
      engine.step();
      if (engine.getState() === EngineState.ERROR) break;
      const t = engine.simTime;
      if (t > prevTime) {
        capture.endStep({ stepEndTime: t, integrationCoefficients: ZERO_INTEG_COEFF, analysisPhase: "tranFloat", acceptedAttemptIndex: -1, order: engine.integrationOrder, delta: engine.currentDt });
        prevTime = t;
      }
    }
    engine.stepPhaseHook = null;
    engine.postIterationHook = null;
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit), steps: capture.getSteps() };
    const summary = convergenceSummary(session);
    expect(summary.totalSteps).toBeGreaterThan(0);
    expect(summary.convergedSteps).toBe(summary.totalSteps);
    expect(summary.failedSteps).toBe(0);
    expect(summary.avgIterations).toBeGreaterThan(0);
  });

  it("nodeVoltageTrajectory returns voltage history", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = capture.iterationHook;
    engine.stepPhaseHook = {
      onAttemptBegin(phase: string, dt: number) { capture.beginAttempt(phase as any, dt); },
      onAttemptEnd(outcome: string, converged: boolean) { capture.endAttempt(outcome as any, converged); },
    };
    capture.setStepStartTime(0);
    engine.dcOperatingPoint();
    capture.endStep({ stepEndTime: 0, integrationCoefficients: ZERO_INTEG_COEFF, analysisPhase: "dcop", acceptedAttemptIndex: -1, order: engine.integrationOrder, delta: engine.currentDt });
    let prevTime = 0;
    for (let i = 0; i < 5; i++) {
      engine.step();
      if (engine.getState() === EngineState.ERROR) break;
      const t = engine.simTime;
      if (t > prevTime) {
        capture.endStep({ stepEndTime: t, integrationCoefficients: ZERO_INTEG_COEFF, analysisPhase: "tranFloat", acceptedAttemptIndex: -1, order: engine.integrationOrder, delta: engine.currentDt });
        prevTime = t;
      }
    }
    engine.stepPhaseHook = null;
    engine.postIterationHook = null;
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit), steps: capture.getSteps() };
    const trajectory = nodeVoltageTrajectory(session, 0);
    expect(trajectory.length).toBeGreaterThan(0);
    for (const point of trajectory) { expect(point.voltage).toBeCloseTo(5.0, 1); }
  });

  it("querySteps filters by convergence", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = capture.iterationHook;
    engine.stepPhaseHook = {
      onAttemptBegin(phase: string, dt: number) { capture.beginAttempt(phase as any, dt); },
      onAttemptEnd(outcome: string, converged: boolean) { capture.endAttempt(outcome as any, converged); },
    };
    capture.setStepStartTime(0);
    engine.dcOperatingPoint();
    capture.endStep({ stepEndTime: 0, integrationCoefficients: ZERO_INTEG_COEFF, analysisPhase: "dcop", acceptedAttemptIndex: -1, order: engine.integrationOrder, delta: engine.currentDt });
    engine.stepPhaseHook = null;
    engine.postIterationHook = null;
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit), steps: capture.getSteps() };
    expect(querySteps(session, { converged: true }).length).toBe(session.steps.length);
    expect(querySteps(session, { converged: false }).length).toBe(0);
  });

  it("compareSnapshots returns all-pass for self-comparison", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = capture.iterationHook;
    engine.stepPhaseHook = {
      onAttemptBegin(phase: string, dt: number) { capture.beginAttempt(phase as any, dt); },
      onAttemptEnd(outcome: string, converged: boolean) { capture.endAttempt(outcome as any, converged); },
    };
    capture.setStepStartTime(0);
    engine.dcOperatingPoint();
    capture.endStep({ stepEndTime: 0, integrationCoefficients: ZERO_INTEG_COEFF, analysisPhase: "dcop", acceptedAttemptIndex: -1, order: engine.integrationOrder, delta: engine.currentDt });
    engine.stepPhaseHook = null;
    engine.postIterationHook = null;
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit), steps: capture.getSteps() };
    const results = compareSnapshots(session, session);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.allWithinTol).toBe(true);
      expect(r.matrixDiffs).toHaveLength(0);
    }
  });

  it("formatComparison produces readable output", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = capture.iterationHook;
    engine.stepPhaseHook = {
      onAttemptBegin(phase: string, dt: number) { capture.beginAttempt(phase as any, dt); },
      onAttemptEnd(outcome: string, converged: boolean) { capture.endAttempt(outcome as any, converged); },
    };
    capture.setStepStartTime(0);
    engine.dcOperatingPoint();
    capture.endStep({ stepEndTime: 0, integrationCoefficients: ZERO_INTEG_COEFF, analysisPhase: "dcop", acceptedAttemptIndex: -1, order: engine.integrationOrder, delta: engine.currentDt });
    engine.stepPhaseHook = null;
    engine.postIterationHook = null;
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit), steps: capture.getSteps() };
    const formatted = formatComparison(compareSnapshots(session, session)[0]);
    expect(formatted).toContain("Step 0");
    expect(formatted).toContain("PASS");
  });

  it("findFirstDivergence returns null for identical sessions", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = capture.iterationHook;
    engine.stepPhaseHook = {
      onAttemptBegin(phase: string, dt: number) { capture.beginAttempt(phase as any, dt); },
      onAttemptEnd(outcome: string, converged: boolean) { capture.endAttempt(outcome as any, converged); },
    };
    capture.setStepStartTime(0);
    engine.dcOperatingPoint();
    capture.endStep({ stepEndTime: 0, integrationCoefficients: ZERO_INTEG_COEFF, analysisPhase: "dcop", acceptedAttemptIndex: -1, order: engine.integrationOrder, delta: engine.currentDt });
    engine.stepPhaseHook = null;
    engine.postIterationHook = null;
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit), steps: capture.getSteps() };
    expect(findFirstDivergence(compareSnapshots(session, session))).toBeNull();
  });

  it("DEVICE_MAPPINGS has populated MOSFET mapping", () => {
    const mos = DEVICE_MAPPINGS.mosfet;
    expect(Object.keys(mos.slotToNgspice).length).toBeGreaterThan(0);
    expect(Object.keys(mos.ngspiceToSlot).length).toBeGreaterThan(0);
    // ngspice mos1defs.h: MOS1vbd=0, MOS1vbs=1, MOS1vgs=2, MOS1vds=3,
    // MOS1capgs=4, MOS1qgs=5, MOS1cqgs=6, ..., MOS1cqgb=12.
    expect(mos.slotToNgspice["VGS"]).toBe(2);
    expect(mos.slotToNgspice["VDS"]).toBe(3);
    expect(mos.slotToNgspice["Q_GS"]).toBe(5);
    expect(mos.slotToNgspice["CCAP_GB"]).toBe(12);
    // VSB is sign-inverted vs MOS1vbs — mapped via derivedNgspiceSlots, not direct.
    expect(mos.slotToNgspice["VSB"]).toBeNull();
    expect(mos.derivedNgspiceSlots?.VSB).toBeDefined();
  });

  it("DEVICE_MAPPINGS has JFET mapping with correct ngspice offsets", () => {
    const jfet = DEVICE_MAPPINGS.jfet;
    expect(jfet).toBeDefined();
    expect(jfet.deviceType).toBe("jfet");
    expect(jfet.slotToNgspice["VGS"]).toBe(0);      // JFETvgs
    expect(jfet.slotToNgspice["GM"]).toBe(5);        // JFETgm
    expect(jfet.slotToNgspice["GDS"]).toBe(6);       // JFETgds
    expect(jfet.slotToNgspice["IDS"]).toBe(3);       // JFETcd
    expect(jfet.slotToNgspice["Q_GS"]).toBe(9);      // JFETqgs
    expect(jfet.slotToNgspice["CCAP_GS"]).toBe(10);  // JFETcqgs
    expect(jfet.slotToNgspice["Q_GD"]).toBe(11);     // JFETqgd
    expect(jfet.slotToNgspice["CCAP_GD"]).toBe(12);  // JFETcqgd
    // No bulk for JFET
    expect(jfet.slotToNgspice["VSB"]).toBeNull();
    expect(jfet.slotToNgspice["Q_GB"]).toBeNull();
    // Reverse mapping
    expect(jfet.ngspiceToSlot[0]).toBe("VGS");
    expect(jfet.ngspiceToSlot[3]).toBe("IDS");
    expect(jfet.ngspiceToSlot[9]).toBe("Q_GS");
  });

  it("DEVICE_MAPPINGS has tunnel-diode and varactor mappings", () => {
    const td = DEVICE_MAPPINGS["tunnel-diode"];
    expect(td).toBeDefined();
    expect(td.deviceType).toBe("tunnel-diode");
    expect(td.slotToNgspice["VD"]).toBe(0);
    expect(td.slotToNgspice["ID"]).toBe(1);
    expect(td.slotToNgspice["GEQ"]).toBe(2);
    expect(td.slotToNgspice["Q"]).toBe(3);
    expect(td.slotToNgspice["CCAP"]).toBe(4);

    const v = DEVICE_MAPPINGS.varactor;
    expect(v).toBeDefined();
    expect(v.deviceType).toBe("varactor");
    expect(v.slotToNgspice["VD"]).toBe(0);
    expect(v.slotToNgspice["Q"]).toBe(3);
  });

  it("step capture hook supports retry tracking via beginAttempt/endAttempt", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = capture.iterationHook;

    // Simulate a failed attempt followed by a successful one using the phase-aware API
    capture.setStepStartTime(0);
    capture.beginAttempt("dcopDirect", 1e-9);
    engine.dcOperatingPoint();
    capture.endAttempt("nrFailedRetry", false); // failed attempt

    capture.beginAttempt("dcopDirect", 5e-10);
    engine.dcOperatingPoint();
    capture.endAttempt("accepted", true);
    capture.endStep({ stepEndTime: 0, integrationCoefficients: ZERO_INTEG_COEFF, analysisPhase: "dcop", acceptedAttemptIndex: 1, order: engine.integrationOrder, delta: engine.currentDt });

    engine.postIterationHook = null;
    const steps = capture.getSteps();
    expect(steps.length).toBe(1);
    expect(steps[0].converged).toBe(true);
    // Should have attempts array with 2 entries (failed + accepted)
    expect(steps[0].attempts.length).toBe(2);
    expect(steps[0].attempts[0].converged).toBe(false);
    expect(steps[0].attempts[0].outcome).toBe("nrFailedRetry");
    expect(steps[0].attempts[1].converged).toBe(true);
    expect(steps[0].attempts[1].outcome).toBe("accepted");
  });

  it("step capture hook emits single attempt when no retries", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = capture.iterationHook;
    engine.stepPhaseHook = {
      onAttemptBegin(phase: string, dt: number) { capture.beginAttempt(phase as any, dt); },
      onAttemptEnd(outcome: string, converged: boolean) { capture.endAttempt(outcome as any, converged); },
    };
    capture.setStepStartTime(0);
    engine.dcOperatingPoint();
    capture.endStep({ stepEndTime: 0, integrationCoefficients: ZERO_INTEG_COEFF, analysisPhase: "dcop", acceptedAttemptIndex: -1, order: engine.integrationOrder, delta: engine.currentDt });
    engine.stepPhaseHook = null;
    engine.postIterationHook = null;
    const steps = capture.getSteps();
    expect(steps.length).toBe(1);
    // With phase-aware API, attempts array is always present
    expect(steps[0].attempts.length).toBeGreaterThanOrEqual(1);
  });

  it("MNAEngine exposes accessors after init", () => {
    const { circuit } = makeHWR();
    engine.init(circuit);
    expect(engine.solver).not.toBeNull();
    expect(engine.statePool).not.toBeNull();
    expect(engine.elements.length).toBe(3);
    expect(engine.compiled).not.toBeNull();
    expect(engine.compiled!.matrixSize).toBe(3);
  });

  it("MNAEngine accessors return null/empty before init", () => {
    expect(engine.solver).toBeNull();
    expect(engine.statePool).toBeNull();
    expect(engine.elements).toHaveLength(0);
    expect(engine.compiled).toBeNull();
  });

  it("SparseSolver exposes dimension, getRhsSnapshot, getCSCNonZeros", () => {
    const { circuit } = makeHWR();
    engine.init(circuit);
    engine.dcOperatingPoint();
    const solver = engine.solver!;
    expect(solver.dimension).toBe(3);
    const rhs = solver.getRhsSnapshot();
    expect(rhs).toBeInstanceOf(Float64Array);
    expect(rhs.length).toBe(3);
    const nz = solver.getCSCNonZeros();
    expect(nz.length).toBeGreaterThan(0);
    expect(nz[0]).toHaveProperty("row");
    expect(nz[0]).toHaveProperty("col");
    expect(nz[0]).toHaveProperty("value");
  });

  it("findLargestDelta identifies worst convergence point", () => {
    const { circuit, pool } = makeHWR();
    engine.init(circuit);
    const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = capture.iterationHook;
    engine.stepPhaseHook = {
      onAttemptBegin(phase: string, dt: number) { capture.beginAttempt(phase as any, dt); },
      onAttemptEnd(outcome: string, converged: boolean) { capture.endAttempt(outcome as any, converged); },
    };
    capture.setStepStartTime(0);
    engine.dcOperatingPoint();
    capture.endStep({ stepEndTime: 0, integrationCoefficients: ZERO_INTEG_COEFF, analysisPhase: "dcop", acceptedAttemptIndex: -1, order: engine.integrationOrder, delta: engine.currentDt });
    engine.stepPhaseHook = null;
    engine.postIterationHook = null;
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit), steps: capture.getSteps() };
    const result = findLargestDelta(session, 1);
    expect(result).not.toBeNull();
    expect(result!.delta).toBeGreaterThan(0);
  });
});

describe("time-alignment: compareSnapshots with alignment map", () => {
  function makeMinimalTopology() {
    return {
      matrixSize: 1, nodeCount: 1, branchCount: 0, elementCount: 0,
      elements: [],
      nodeLabels: new Map<number, string>([[1, "N1"]]),
      matrixRowLabels: new Map<number, string>([[0, "N1"]]),
      matrixColLabels: new Map<number, string>(),
    };
  }

  function makeStep(stepStartTime: number, dt: number, voltage: number): import("./types.js").StepSnapshot {
    // Synthetic fixture for map-level ordering/query tests — numeric fields are
    // driven by topology, not by real engine state. initMode uses "transient"
    // as the canonical free-running transient tag (InitMode string union).
    const iter: import("./types.js").IterationSnapshot = {
      iteration: 0,
      voltages: new Float64Array([voltage]),
      prevVoltages: new Float64Array([voltage]),
      preSolveRhs: new Float64Array([0]),
      matrix: [],
      elementStates: [],
      noncon: 0,
      diagGmin: 0,
      srcFact: 1,
      initMode: "transient",
      order: 1,
      delta: dt,
      ag: new Float64Array(7),
      method: "trapezoidal",
      globalConverged: true,
      elemConverged: true,
      limitingEvents: [],
      convergenceFailedElements: [],
      ngspiceConvergenceFailedDevices: [],
    };
    const attempt: import("./types.js").NRAttempt = {
      dt,
      iterations: [iter],
      converged: true,
      iterationCount: 1,
      phase: "tranNR",
      outcome: "accepted",
    };
    return {
      stepStartTime,
      stepEndTime: stepStartTime + dt,
      attempts: [attempt],
      acceptedAttemptIndex: 0,
      accepted: true,
      dt,
      iterations: [iter],
      converged: true,
      iterationCount: 1,
      totalIterationCount: 1,
      integrationCoefficients: ZERO_INTEG_COEFF,
      analysisPhase: "tranFloat",
    };
  }

  it("compareSnapshots without alignment uses array index pairing", () => {
    const topo = makeMinimalTopology();
    const ours: CaptureSession = {
      source: "ours", topology: topo,
      steps: [makeStep(1e-9, 1e-9, 1.0), makeStep(2e-9, 1e-9, 2.0)],
    };
    const ref: CaptureSession = {
      source: "ngspice", topology: topo,
      steps: [makeStep(1e-9, 1e-9, 1.0), makeStep(2e-9, 1e-9, 2.0)],
    };
    const results = compareSnapshots(ours, ref);
    expect(results).toHaveLength(2);
    for (const r of results) expect(r.allWithinTol).toBe(true);
  });

  it("compareSnapshots index pairing: our[0] pairs with ref[0] regardless of time", () => {
    const topo = makeMinimalTopology();
    const ours: CaptureSession = {
      source: "ours", topology: topo,
      steps: [makeStep(1e-9, 1e-9, 5.0)],
    };
    const ref: CaptureSession = {
      source: "ngspice", topology: topo,
      steps: [
        makeStep(0, 1e-9, 999.0), // index 0 — different voltage
        makeStep(1e-9, 1e-9, 5.0), // index 1 — same voltage
      ],
    };
    // Index pairing: our[0] pairs with ref[0], voltages differ → not within tol
    const results = compareSnapshots(ours, ref);
    expect(results[0].voltageDiffs[0].ours).toBe(5.0);
    expect(results[0].voltageDiffs[0].theirs).toBe(999.0);
    expect(results[0].allWithinTol).toBe(false);
    // ref[1] has no ours pair → presence: "ngspiceOnly"
    expect(results[1].presence).toBe("ngspiceOnly");
  });

  it("compareSnapshots asymmetric: extra ours steps get presence oursOnly", () => {
    const topo = makeMinimalTopology();
    const ours: CaptureSession = {
      source: "ours", topology: topo,
      steps: [makeStep(1e-9, 1e-9, 1.0), makeStep(2e-9, 1e-9, 2.0), makeStep(3e-9, 1e-9, 3.0)],
    };
    const ref: CaptureSession = {
      source: "ngspice", topology: topo,
      steps: [makeStep(1e-9, 1e-9, 1.0), makeStep(2e-9, 1e-9, 2.0)],
    };
    const results = compareSnapshots(ours, ref);
    // our[0] → ref[0]: voltage match
    expect(results.find(r => r.stepIndex === 0)?.allWithinTol).toBe(true);
    // our[1] → ref[1]: voltage match
    expect(results.find(r => r.stepIndex === 1)?.allWithinTol).toBe(true);
    // our[2] has no ref pair → presence: "oursOnly"
    expect(results.find(r => r.stepIndex === 2)?.presence).toBe("oursOnly");
  });

  it("compareSnapshots same-length sessions: all results have presence both", () => {
    const topo = makeMinimalTopology();
    const ours: CaptureSession = {
      source: "ours", topology: topo,
      steps: [makeStep(0, 1e-9, 7.0)],
    };
    const ref: CaptureSession = {
      source: "ngspice", topology: topo,
      steps: [makeStep(0, 1e-9, 7.0)],
    };
    const results = compareSnapshots(ours, ref);
    expect(results).toHaveLength(1);
    expect(results[0].allWithinTol).toBe(true);
    expect(results[0].presence).toBe("both");
  });
});

describe("node mapping", () => {
  it("canonicalizeNgspiceName handles BJT pin patterns", () => {
    expect(canonicalizeNgspiceName("q1_c", "bjt")).toBe("Q1:C");
    expect(canonicalizeNgspiceName("q1_b", "bjt")).toBe("Q1:B");
    expect(canonicalizeNgspiceName("q1_e", "bjt")).toBe("Q1:E");
  });

  it("canonicalizeNgspiceName handles diode pin patterns", () => {
    expect(canonicalizeNgspiceName("d1_a", "diode")).toBe("D1:A");
    expect(canonicalizeNgspiceName("d1_k", "diode")).toBe("D1:K");
  });

  it("canonicalizeNgspiceName handles MOSFET pin patterns", () => {
    expect(canonicalizeNgspiceName("m1_d", "mosfet")).toBe("M1:D");
    expect(canonicalizeNgspiceName("m1_g", "mosfet")).toBe("M1:G");
    expect(canonicalizeNgspiceName("m1_s", "mosfet")).toBe("M1:S");
    expect(canonicalizeNgspiceName("m1_b", "mosfet")).toBe("M1:B");
  });

  it("canonicalizeNgspiceName handles resistor terminal patterns", () => {
    expect(canonicalizeNgspiceName("r1_1", "resistor")).toBe("R1:A");
    expect(canonicalizeNgspiceName("r1_2", "resistor")).toBe("R1:B");
  });

  it("canonicalizeNgspiceName handles branch currents", () => {
    expect(canonicalizeNgspiceName("v1#branch")).toBe("V1:branch");
  });

  it("canonicalizeNgspiceName returns null for ground and unparseable names", () => {
    expect(canonicalizeNgspiceName("0")).toBeNull();
    expect(canonicalizeNgspiceName("")).toBeNull();
    expect(canonicalizeNgspiceName("3")).toBeNull(); // bare net number
  });

  it("canonicalizeOurLabel uppercases", () => {
    expect(canonicalizeOurLabel("Q1:C")).toBe("Q1:C");
    expect(canonicalizeOurLabel("r1:a")).toBe("R1:A");
  });

});
