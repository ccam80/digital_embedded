/**
 * Integration test for the comparison harness infrastructure.
 */
import { describe, it, expect } from "vitest";
import { EngineState } from "../../../../core/engine-interface.js";
import { captureTopology, captureElementStates, createIterationCaptureHook, createStepCaptureHook } from "./capture.js";
import { convergenceSummary, nodeVoltageTrajectory, findLargestDelta, querySteps } from "./query.js";
import { compareSnapshots, formatComparison, findFirstDivergence } from "./compare.js";
import { canonicalizeNgspiceName, canonicalizeOurLabel } from "./node-mapping.js";
import type { CaptureSession, IntegrationCoefficients } from "./types.js";
import { buildHwrFixture } from "./hwr-fixture.js";
import { buildFixture } from "../fixtures/build-fixture.js";

const ZERO_INTEG_COEFF: IntegrationCoefficients = {
  ours: { ag0: 0, ag1: 0, method: "trapezoidal", order: 1 },
  ngspice: { ag0: 0, ag1: 0, method: "trapezoidal", order: 1 },
};


describe("harness integration", () => {

  it("captureTopology returns correct circuit structure", () => {
    const { circuit } = buildHwrFixture();
    const topo = captureTopology(circuit, 3);
    expect(topo.matrixSize).toBe(3);
    expect(topo.nodeCount).toBe(2);
    expect(topo.elementCount).toBe(3);
    expect(topo.elements).toHaveLength(3);
    expect(topo.nodeLabels.size).toBeGreaterThan(0);
  });

  it("captureElementStates snapshots pool-backed elements", () => {
    const { circuit, pool, engine } = buildHwrFixture();
    engine.dcOperatingPoint();
    const states = captureElementStates(circuit.elements, pool);
    expect(states.length).toBeGreaterThan(0);
  });

  it("iteration capture hook records NR iterations during DC OP", () => {
    const { pool, engine } = buildHwrFixture();
    const { hook, preFactorHook, getSnapshots, clear } = createIterationCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = hook;
    engine.preFactorHook = preFactorHook;
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
    const { engine } = buildHwrFixture();
    let hookCallCount = 0;
    engine.postIterationHook = (_i: number, _v: Float64Array, _p: Float64Array, _n: number, _g: boolean, _e: boolean, _le: unknown[], _cf: string[]) => { hookCallCount++; };
    const result = engine.dcOperatingPoint();
    expect(result.converged).toBe(true);
    expect(hookCallCount).toBeGreaterThan(0);
  });

  it("postIterationHook fires during DC OP (linear circuit)", () => {
    const { engine } = buildFixture({
      build: (_registry, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { voltage: 5.0 } },
          { id: "r1",  type: "Resistor",        props: { resistance: 1000 } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos", "r1:pos"],
          ["r1:neg", "gnd:out"],
          ["vs:neg", "gnd:out"],
        ],
      }),
    });
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
    const { pool, engine } = buildHwrFixture();
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
    const { circuit, pool, engine } = buildHwrFixture();
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
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit, 3), steps: capture.getSteps() };
    const summary = convergenceSummary(session);
    expect(summary.totalSteps).toBeGreaterThan(0);
    expect(summary.convergedSteps).toBe(summary.totalSteps);
    expect(summary.failedSteps).toBe(0);
    expect(summary.avgIterations).toBeGreaterThan(0);
  });

  it("nodeVoltageTrajectory returns voltage history", () => {
    const { circuit, pool, engine } = buildHwrFixture();
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
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit, 3), steps: capture.getSteps() };
    const trajectory = nodeVoltageTrajectory(session, 0);
    expect(trajectory.length).toBeGreaterThan(0);
  });

  it("querySteps filters by convergence", () => {
    const { circuit, pool, engine } = buildHwrFixture();
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
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit, 3), steps: capture.getSteps() };
    expect(querySteps(session, { converged: true }).length).toBe(session.steps.length);
    expect(querySteps(session, { converged: false }).length).toBe(0);
  });

  it("compareSnapshots returns all-pass for self-comparison", () => {
    const { circuit, pool, engine } = buildHwrFixture();
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
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit, 3), steps: capture.getSteps() };
    const results = compareSnapshots(session, session);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.allWithinTol).toBe(true);
      expect(r.matrixDiffs).toHaveLength(0);
    }
  });

  it("formatComparison produces readable output", () => {
    const { circuit, pool, engine } = buildHwrFixture();
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
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit, 3), steps: capture.getSteps() };
    const formatted = formatComparison(compareSnapshots(session, session)[0]);
    expect(formatted).toContain("Step 0");
    expect(formatted).toContain("PASS");
  });

  it("findFirstDivergence returns null for identical sessions", () => {
    const { circuit, pool, engine } = buildHwrFixture();
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
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit, 3), steps: capture.getSteps() };
    expect(findFirstDivergence(compareSnapshots(session, session))).toBeNull();
  });

  it("step capture hook supports retry tracking via beginAttempt/endAttempt", () => {
    const { pool, engine } = buildHwrFixture();
    const capture = createStepCaptureHook(engine.solver!, engine.elements, pool);
    engine.postIterationHook = capture.iterationHook;

    capture.setStepStartTime(0);
    capture.beginAttempt("dcopDirect", 1e-9);
    engine.dcOperatingPoint();
    capture.endAttempt("nrFailedRetry", false);

    capture.beginAttempt("dcopDirect", 5e-10);
    engine.dcOperatingPoint();
    capture.endAttempt("accepted", true);
    capture.endStep({ stepEndTime: 0, integrationCoefficients: ZERO_INTEG_COEFF, analysisPhase: "dcop", acceptedAttemptIndex: 1, order: engine.integrationOrder, delta: engine.currentDt });

    engine.postIterationHook = null;
    const steps = capture.getSteps();
    expect(steps.length).toBe(1);
    expect(steps[0].converged).toBe(true);
    expect(steps[0].attempts.length).toBe(2);
    expect(steps[0].attempts[0].converged).toBe(false);
    expect(steps[0].attempts[0].outcome).toBe("nrFailedRetry");
    expect(steps[0].attempts[1].converged).toBe(true);
    expect(steps[0].attempts[1].outcome).toBe("accepted");
  });

  it("step capture hook emits single attempt when no retries", () => {
    const { pool, engine } = buildHwrFixture();
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
    expect(steps[0].attempts.length).toBeGreaterThanOrEqual(1);
  });

  it("MNAEngine exposes accessors after first dcop", () => {
    const { engine } = buildHwrFixture();
    engine.dcOperatingPoint();
    expect(engine.solver).not.toBeNull();
    expect(engine.statePool).not.toBeNull();
    expect(engine.elements.length).toBe(3);
    expect(engine.compiled).not.toBeNull();
  });

  it("SparseSolver exposes dimension, getCSCNonZeros", () => {
    const { engine } = buildHwrFixture();
    const solver = engine.solver!;
    engine.dcOperatingPoint();
    expect(solver.dimension).toBe(3);
    const nz = solver.getCSCNonZeros();
    expect(nz.length).toBeGreaterThan(0);
    expect(nz[0]).toHaveProperty("row");
    expect(nz[0]).toHaveProperty("col");
    expect(nz[0]).toHaveProperty("value");
  });

  it("findLargestDelta identifies worst convergence point", () => {
    const { circuit, pool, engine } = buildHwrFixture();
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
    const session: CaptureSession = { source: "ours", topology: captureTopology(circuit, 3), steps: capture.getSteps() };
    // Node 2 is the diode anode- it changes between NR iterations as the nonlinear diode converges.
    const result = findLargestDelta(session, 2);
    expect(result).not.toBeNull();
    // stepIndex must be 0 (only one step- DCOP)
    expect(result!.stepIndex).toBe(0);
    // iterationIndex must be 0 (largest delta is always on the first NR iteration from zero initial conditions)
    expect(result!.iterationIndex).toBe(0);
    // Node 2 (diode anode) starts at 0V; first iteration drives it toward the diode drop (~0.6â€“0.7V),
    // so the largest delta is in the range (0, 5].
    expect(result!.delta).toBeGreaterThan(0);
    expect(result!.delta).toBeLessThanOrEqual(5.0);
  });
});

describe("time-alignment: compareSnapshots with alignment map", () => {
  function makeMinimalTopology() {
    return {
      matrixSize: 1, nodeCount: 1, elementCount: 0,
      elements: [],
      nodeLabels: new Map<number, string>([[1, "N1"]]),
      matrixRowLabels: new Map<number, string>([[0, "N1"]]),
      matrixColLabels: new Map<number, string>(),
    };
  }

  function makeStep(stepStartTime: number, dt: number, voltage: number): import("./types.js").StepSnapshot {
    const iter: import("./types.js").IterationSnapshot = {
      iteration: 0,
      matrixSize: 1,
      rhsBufSize: 1,
      voltages: new Float64Array([voltage]),
      prevVoltages: new Float64Array([voltage]),
      preSolveRhs: new Float64Array([0]),
      matrix: [],
      elementStates: [],
      noncon: 0,
      diagGmin: 0,
      srcFact: 1,
      initMode: "MODETRAN",
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
        makeStep(0, 1e-9, 999.0),
        makeStep(1e-9, 1e-9, 5.0),
      ],
    };
    const results = compareSnapshots(ours, ref);
    expect(results[0].voltageDiffs[0].ours).toBe(5.0);
    expect(results[0].voltageDiffs[0].theirs).toBe(999.0);
    expect(results[0].allWithinTol).toBe(false);
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
    expect(results.find(r => r.stepIndex === 0)?.allWithinTol).toBe(true);
    expect(results.find(r => r.stepIndex === 1)?.allWithinTol).toBe(true);
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
    expect(canonicalizeNgspiceName("r1_1", "resistor")).toBe("R1:pos");
    expect(canonicalizeNgspiceName("r1_2", "resistor")).toBe("R1:neg");
  });

  it("canonicalizeNgspiceName handles branch currents", () => {
    expect(canonicalizeNgspiceName("v1#branch")).toBe("V1:branch");
  });

  it("canonicalizeNgspiceName returns null for ground and unparseable names", () => {
    expect(canonicalizeNgspiceName("0")).toBeNull();
    expect(canonicalizeNgspiceName("")).toBeNull();
    expect(canonicalizeNgspiceName("3")).toBeNull();
  });

  it("canonicalizeOurLabel uppercases", () => {
    expect(canonicalizeOurLabel("Q1:C")).toBe("Q1:C");
    expect(canonicalizeOurLabel("r1:pos")).toBe("R1:POS");
  });

});
