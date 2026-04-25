/**
 * NR-retry grouping tests (spec §10.2 test 4).
 *
 * Verifies that when an NR attempt fails and is retried at the same stepStartTime,
 * the capture hook correctly groups both attempts under the same step:
 *   - step.attempts[0].outcome === "nrFailedRetry"
 *   - step.attempts[1].outcome === "accepted" (or "dcopSubSolveConverged")
 *   - Both attempts share the same step (step.stepStartTime is the same)
 *
 * Uses the low-level hook API directly (no DLL, no .dts file needed).
 */

import { describe, it, expect } from "vitest";
import { MNAEngine } from "../../analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../../compiled-analog-circuit.js";
import { isPoolBacked } from "../../element.js";
import type { AnalogElementCore } from "../../element.js";
import { StatePool } from "../../state-pool.js";
import { makeResistor, makeVoltageSource, makeDiode } from "../test-helpers.js";
import {
  buildElementLabelMap,
  createStepCaptureHook,
} from "./capture.js";
import type { IntegrationCoefficients, NRPhase, NRAttemptOutcome } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TRAN_INTEG_COEFF: IntegrationCoefficients = {
  ours: { ag0: 2e9, ag1: 2e9, method: "trapezoidal", order: 2 },
  ngspice: { ag0: 2e9, ag1: 2e9, method: "trapezoidal", order: 2 },
};

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

function makeHWRCircuit(): { circuit: ConcreteCompiledAnalogCircuit; pool: StatePool } {
  const vs = makeVoltageSource(1, 0, 2, 5.0);
  const r = makeResistor(1, 2, 1000);
  const diode = makeDiode(2, 0, 1e-14, 1.0);
  const elements = [vs, r, diode];
  const pool = buildStatePool(elements);
  return {
    circuit: {
      netCount: 2, componentCount: 3, nodeCount: 2, branchCount: 1, matrixSize: 3,
      elements,
      labelToNodeId: new Map([["Vs", 1], ["R1:B", 2]]),
      statePool: pool,
    } as ConcreteCompiledAnalogCircuit,
    pool,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("nr-retry-grouping: failed attempt + retry grouped in same step", () => {

  it("two attempts with nrFailedRetry then accepted → 1 step, 2 attempts", () => {
    const { circuit, pool } = makeHWRCircuit();
    const engine = new MNAEngine();
    engine.init(circuit);

    const elementLabels = buildElementLabelMap(circuit);
    const sc = createStepCaptureHook(engine.solver!, engine.elements, pool, elementLabels);
    engine.postIterationHook = sc.iterationHook;

    // Simulate: at stepStartTime=1e-9, first attempt fails NR, second succeeds
    sc.setStepStartTime(1e-9);

    // Attempt 1: failed NR (manually inject via begin/end without calling engine)
    sc.beginAttempt("tranNR" as NRPhase, 1e-9);
    // Inject a fake iteration by calling the hook directly
    (engine.postIterationHook as any)(
      0,
      new Float64Array(3),
      new Float64Array(3),
      1,   // noncon > 0 → not converged
      false,
      false,
      [],
      [], engine.cktContext!);
    sc.endAttempt("nrFailedRetry" as NRAttemptOutcome, false);

    // Attempt 2: accepted with half-dt
    sc.beginAttempt("tranPredictor" as NRPhase, 5e-10);
    (engine.postIterationHook as any)(
      0,
      new Float64Array(3),
      new Float64Array(3),
      0,   // noncon == 0 → converged
      true,
      true,
      [],
      [], engine.cktContext!);
    sc.endAttempt("accepted" as NRAttemptOutcome, true);

    sc.endStep({
      stepEndTime: 1e-9,
      integrationCoefficients: TRAN_INTEG_COEFF,
      analysisPhase: "tranFloat",
      acceptedAttemptIndex: 1,
      order: engine.integrationOrder,
      delta: engine.currentDt,
    });

    engine.postIterationHook = null;

    const steps = sc.getSteps();
    expect(steps.length).toBe(1);
    expect(steps[0].attempts.length).toBe(2);
  });

  it("failed attempt has outcome === 'nrFailedRetry'", () => {
    const { circuit, pool } = makeHWRCircuit();
    const engine = new MNAEngine();
    engine.init(circuit);

    const elementLabels = buildElementLabelMap(circuit);
    const sc = createStepCaptureHook(engine.solver!, engine.elements, pool, elementLabels);
    engine.postIterationHook = sc.iterationHook;

    sc.setStepStartTime(1e-9);

    sc.beginAttempt("tranNR" as NRPhase, 1e-9);
    (engine.postIterationHook as any)(0, new Float64Array(3), new Float64Array(3), 1, false, false, [], [], engine.cktContext!);
    sc.endAttempt("nrFailedRetry" as NRAttemptOutcome, false);

    sc.beginAttempt("tranPredictor" as NRPhase, 5e-10);
    (engine.postIterationHook as any)(0, new Float64Array(3), new Float64Array(3), 0, true, true, [], [], engine.cktContext!);
    sc.endAttempt("accepted" as NRAttemptOutcome, true);

    sc.endStep({
      stepEndTime: 1e-9,
      integrationCoefficients: TRAN_INTEG_COEFF,
      analysisPhase: "tranFloat",
      acceptedAttemptIndex: 1,
      order: engine.integrationOrder,
      delta: engine.currentDt,
    });

    engine.postIterationHook = null;

    const steps = sc.getSteps();
    expect(steps[0].attempts[0].outcome).toBe("nrFailedRetry");
    expect(steps[0].attempts[0].converged).toBe(false);
  });

  it("accepted attempt has outcome === 'accepted' and converged === true", () => {
    const { circuit, pool } = makeHWRCircuit();
    const engine = new MNAEngine();
    engine.init(circuit);

    const elementLabels = buildElementLabelMap(circuit);
    const sc = createStepCaptureHook(engine.solver!, engine.elements, pool, elementLabels);
    engine.postIterationHook = sc.iterationHook;

    sc.setStepStartTime(1e-9);

    sc.beginAttempt("tranNR" as NRPhase, 1e-9);
    (engine.postIterationHook as any)(0, new Float64Array(3), new Float64Array(3), 1, false, false, [], [], engine.cktContext!);
    sc.endAttempt("nrFailedRetry" as NRAttemptOutcome, false);

    sc.beginAttempt("tranPredictor" as NRPhase, 5e-10);
    (engine.postIterationHook as any)(0, new Float64Array(3), new Float64Array(3), 0, true, true, [], [], engine.cktContext!);
    sc.endAttempt("accepted" as NRAttemptOutcome, true);

    sc.endStep({
      stepEndTime: 1e-9,
      integrationCoefficients: TRAN_INTEG_COEFF,
      analysisPhase: "tranFloat",
      acceptedAttemptIndex: 1,
      order: engine.integrationOrder,
      delta: engine.currentDt,
    });

    engine.postIterationHook = null;

    const steps = sc.getSteps();
    expect(steps[0].attempts[1].outcome).toBe("accepted");
    expect(steps[0].attempts[1].converged).toBe(true);
  });

  it("both attempts share the same stepStartTime", () => {
    const { circuit, pool } = makeHWRCircuit();
    const engine = new MNAEngine();
    engine.init(circuit);

    const elementLabels = buildElementLabelMap(circuit);
    const sc = createStepCaptureHook(engine.solver!, engine.elements, pool, elementLabels);
    engine.postIterationHook = sc.iterationHook;

    sc.setStepStartTime(1e-9);

    sc.beginAttempt("tranNR" as NRPhase, 1e-9);
    (engine.postIterationHook as any)(0, new Float64Array(3), new Float64Array(3), 1, false, false, [], [], engine.cktContext!);
    sc.endAttempt("nrFailedRetry" as NRAttemptOutcome, false);

    sc.beginAttempt("tranPredictor" as NRPhase, 5e-10);
    (engine.postIterationHook as any)(0, new Float64Array(3), new Float64Array(3), 0, true, true, [], [], engine.cktContext!);
    sc.endAttempt("accepted" as NRAttemptOutcome, true);

    sc.endStep({
      stepEndTime: 1e-9,
      integrationCoefficients: TRAN_INTEG_COEFF,
      analysisPhase: "tranFloat",
      acceptedAttemptIndex: 1,
      order: engine.integrationOrder,
      delta: engine.currentDt,
    });

    engine.postIterationHook = null;

    const steps = sc.getSteps();
    // Both attempts are in step 0 — stepStartTime applies to the whole step
    expect(steps[0].stepStartTime).toBe(1e-9);
    // The accepted attempt has the smaller dt (half-step retry)
    expect(steps[0].attempts[0].dt).toBe(1e-9);
    expect(steps[0].attempts[1].dt).toBe(5e-10);
  });

  it("acceptedAttemptIndex correctly points at the accepted attempt", () => {
    const { circuit, pool } = makeHWRCircuit();
    const engine = new MNAEngine();
    engine.init(circuit);

    const elementLabels = buildElementLabelMap(circuit);
    const sc = createStepCaptureHook(engine.solver!, engine.elements, pool, elementLabels);
    engine.postIterationHook = sc.iterationHook;

    sc.setStepStartTime(1e-9);

    sc.beginAttempt("tranNR" as NRPhase, 1e-9);
    (engine.postIterationHook as any)(0, new Float64Array(3), new Float64Array(3), 1, false, false, [], [], engine.cktContext!);
    sc.endAttempt("nrFailedRetry" as NRAttemptOutcome, false);

    sc.beginAttempt("tranPredictor" as NRPhase, 5e-10);
    (engine.postIterationHook as any)(0, new Float64Array(3), new Float64Array(3), 0, true, true, [], [], engine.cktContext!);
    sc.endAttempt("accepted" as NRAttemptOutcome, true);

    sc.endStep({
      stepEndTime: 1e-9,
      integrationCoefficients: TRAN_INTEG_COEFF,
      analysisPhase: "tranFloat",
      acceptedAttemptIndex: 1,
      order: engine.integrationOrder,
      delta: engine.currentDt,
    });

    engine.postIterationHook = null;

    const steps = sc.getSteps();
    expect(steps[0].acceptedAttemptIndex).toBe(1);
    expect(steps[0].attempts[steps[0].acceptedAttemptIndex].outcome).toBe("accepted");
  });

  it("step accepted === true even though first attempt failed", () => {
    const { circuit, pool } = makeHWRCircuit();
    const engine = new MNAEngine();
    engine.init(circuit);

    const elementLabels = buildElementLabelMap(circuit);
    const sc = createStepCaptureHook(engine.solver!, engine.elements, pool, elementLabels);
    engine.postIterationHook = sc.iterationHook;

    sc.setStepStartTime(1e-9);

    sc.beginAttempt("tranNR" as NRPhase, 1e-9);
    (engine.postIterationHook as any)(0, new Float64Array(3), new Float64Array(3), 1, false, false, [], [], engine.cktContext!);
    sc.endAttempt("nrFailedRetry" as NRAttemptOutcome, false);

    sc.beginAttempt("tranPredictor" as NRPhase, 5e-10);
    (engine.postIterationHook as any)(0, new Float64Array(3), new Float64Array(3), 0, true, true, [], [], engine.cktContext!);
    sc.endAttempt("accepted" as NRAttemptOutcome, true);

    sc.endStep({
      stepEndTime: 1e-9,
      integrationCoefficients: TRAN_INTEG_COEFF,
      analysisPhase: "tranFloat",
      acceptedAttemptIndex: 1,
      order: engine.integrationOrder,
      delta: engine.currentDt,
    });

    engine.postIterationHook = null;

    const steps = sc.getSteps();
    expect(steps[0].accepted).toBe(true);
    expect(steps[0].converged).toBe(true);
  });

  it("multiple NR retries before acceptance → all grouped in 1 step", () => {
    const { circuit, pool } = makeHWRCircuit();
    const engine = new MNAEngine();
    engine.init(circuit);

    const elementLabels = buildElementLabelMap(circuit);
    const sc = createStepCaptureHook(engine.solver!, engine.elements, pool, elementLabels);
    engine.postIterationHook = sc.iterationHook;

    sc.setStepStartTime(2e-9);

    // Three failed attempts then one success
    for (let i = 0; i < 3; i++) {
      sc.beginAttempt("tranNR" as NRPhase, 1e-9 / (2 ** i));
      (engine.postIterationHook as any)(0, new Float64Array(3), new Float64Array(3), 1, false, false, [], [], engine.cktContext!);
      sc.endAttempt("nrFailedRetry" as NRAttemptOutcome, false);
    }

    sc.beginAttempt("tranPredictor" as NRPhase, 1e-10);
    (engine.postIterationHook as any)(0, new Float64Array(3), new Float64Array(3), 0, true, true, [], [], engine.cktContext!);
    sc.endAttempt("accepted" as NRAttemptOutcome, true);

    sc.endStep({
      stepEndTime: 2e-9,
      integrationCoefficients: TRAN_INTEG_COEFF,
      analysisPhase: "tranFloat",
      acceptedAttemptIndex: 3,
      order: engine.integrationOrder,
      delta: engine.currentDt,
    });

    engine.postIterationHook = null;

    const steps = sc.getSteps();
    expect(steps.length).toBe(1);
    expect(steps[0].attempts.length).toBe(4);
    expect(steps[0].acceptedAttemptIndex).toBe(3);
    expect(steps[0].attempts[3].outcome).toBe("accepted");
    // First 3 attempts all failed
    for (let i = 0; i < 3; i++) {
      expect(steps[0].attempts[i].outcome).toBe("nrFailedRetry");
    }
  });
});
