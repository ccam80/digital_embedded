/**
 * LTE-retry grouping tests (spec §10.2 test 5).
 *
 * Verifies that when an NR attempt converges but is rejected by the LTE check
 * and retried at the same stepStartTime, the capture hook correctly groups both
 * attempts under the same step:
 *   - step.attempts[0].outcome === "lteRejectedRetry"  (converged === true!)
 *   - step.attempts[1].outcome === "accepted"
 *   - Both attempts share the same step (step.stepStartTime is constant)
 *
 * Key distinction from NR retry: LTE-rejected attempts ARE converged (the NR
 * solve succeeded) but the timestep error is too large → roll back and halve dt.
 *
 * Uses the low-level hook API directly (no DLL, no .dts file needed).
 */

import { describe, it, expect } from "vitest";
import { MNAEngine } from "../../analog-engine.js";
import type { ConcreteCompiledAnalogCircuit } from "../../compiled-analog-circuit.js";
import { isPoolBacked } from "../../element.js";
import type { AnalogElementCore } from "../../element.js";
import { StatePool } from "../../state-pool.js";
import { makeResistor, makeVoltageSource, makeCapacitor } from "../test-helpers.js";
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

function makeRCCircuit(): { circuit: ConcreteCompiledAnalogCircuit; pool: StatePool } {
  const vs = makeVoltageSource(1, 0, 2, 5.0);
  const r = makeResistor(1, 2, 1000);
  const cap = makeCapacitor(2, 0, 1e-6);
  const elements = [vs, r, cap];
  const pool = buildStatePool(elements);
  return {
    circuit: {
      netCount: 2, componentCount: 3, nodeCount: 2, matrixSize: 3,
      elements,
      labelToNodeId: new Map([["Vs", 1], ["C1:A", 2]]),
      statePool: pool,
    } as ConcreteCompiledAnalogCircuit,
    pool,
  };
}

/** Inject a single fake iteration snapshot via the postIterationHook. */
function fakeIter(
  hook: ((...args: any[]) => void) | undefined,
  noncon: number,
  converged: boolean,
  engine: MNAEngine,
): void {
  if (!hook) return;
  const ctx = engine.cktContext;
  if (!ctx) throw new Error("fakeIter: engine.cktContext is null — init() must be called first");
  (hook as any)(
    0,
    new Float64Array(3),
    new Float64Array(3),
    noncon,
    converged,
    converged,
    [],
    [],
    ctx,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("lte-retry-grouping: LTE-rejected attempt + retry grouped in same step", () => {

  it("LTE-rejected attempt followed by accepted → 1 step, 2 attempts", () => {
    const { circuit, pool } = makeRCCircuit();
    const engine = new MNAEngine();
    engine.init(circuit);

    const elementLabels = buildElementLabelMap(circuit);
    const sc = createStepCaptureHook(engine.solver!, engine.elements, pool, elementLabels);
    engine.postIterationHook = sc.iterationHook;

    sc.setStepStartTime(1e-9);

    // Attempt 1: NR converges but LTE check fails → lteRejectedRetry
    sc.beginAttempt("tranNR" as NRPhase, 1e-9);
    fakeIter(engine.postIterationHook, 0, true, engine);
    sc.endAttempt("lteRejectedRetry" as NRAttemptOutcome, true);

    // Attempt 2: smaller dt, both NR and LTE pass → accepted
    sc.beginAttempt("tranPredictor" as NRPhase, 5e-10);
    fakeIter(engine.postIterationHook, 0, true, engine);
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

  it("LTE-rejected attempt converged === true (NR solved; LTE check rejected it)", () => {
    const { circuit, pool } = makeRCCircuit();
    const engine = new MNAEngine();
    engine.init(circuit);

    const elementLabels = buildElementLabelMap(circuit);
    const sc = createStepCaptureHook(engine.solver!, engine.elements, pool, elementLabels);
    engine.postIterationHook = sc.iterationHook;

    sc.setStepStartTime(1e-9);

    sc.beginAttempt("tranNR" as NRPhase, 1e-9);
    fakeIter(engine.postIterationHook, 0, true, engine);
    sc.endAttempt("lteRejectedRetry" as NRAttemptOutcome, true);

    sc.beginAttempt("tranPredictor" as NRPhase, 5e-10);
    fakeIter(engine.postIterationHook, 0, true, engine);
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
    // LTE-rejected: NR converged but step rejected
    expect(steps[0].attempts[0].outcome).toBe("lteRejectedRetry");
    expect(steps[0].attempts[0].converged).toBe(true);
  });

  it("accepted attempt has outcome === 'accepted' and converged === true", () => {
    const { circuit, pool } = makeRCCircuit();
    const engine = new MNAEngine();
    engine.init(circuit);

    const elementLabels = buildElementLabelMap(circuit);
    const sc = createStepCaptureHook(engine.solver!, engine.elements, pool, elementLabels);
    engine.postIterationHook = sc.iterationHook;

    sc.setStepStartTime(1e-9);

    sc.beginAttempt("tranNR" as NRPhase, 1e-9);
    fakeIter(engine.postIterationHook, 0, true, engine);
    sc.endAttempt("lteRejectedRetry" as NRAttemptOutcome, true);

    sc.beginAttempt("tranPredictor" as NRPhase, 5e-10);
    fakeIter(engine.postIterationHook, 0, true, engine);
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

  it("LTE-rejected attempt uses larger dt; retry uses smaller dt", () => {
    const { circuit, pool } = makeRCCircuit();
    const engine = new MNAEngine();
    engine.init(circuit);

    const elementLabels = buildElementLabelMap(circuit);
    const sc = createStepCaptureHook(engine.solver!, engine.elements, pool, elementLabels);
    engine.postIterationHook = sc.iterationHook;

    sc.setStepStartTime(1e-9);

    sc.beginAttempt("tranNR" as NRPhase, 1e-9);
    fakeIter(engine.postIterationHook, 0, true, engine);
    sc.endAttempt("lteRejectedRetry" as NRAttemptOutcome, true);

    sc.beginAttempt("tranPredictor" as NRPhase, 5e-10);
    fakeIter(engine.postIterationHook, 0, true, engine);
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
    expect(steps[0].attempts[0].dt).toBe(1e-9);   // original (larger) dt
    expect(steps[0].attempts[1].dt).toBe(5e-10);   // halved dt for retry
  });

  it("both attempts are under the same step (stepStartTime === 1e-9)", () => {
    const { circuit, pool } = makeRCCircuit();
    const engine = new MNAEngine();
    engine.init(circuit);

    const elementLabels = buildElementLabelMap(circuit);
    const sc = createStepCaptureHook(engine.solver!, engine.elements, pool, elementLabels);
    engine.postIterationHook = sc.iterationHook;

    sc.setStepStartTime(1e-9);

    sc.beginAttempt("tranNR" as NRPhase, 1e-9);
    fakeIter(engine.postIterationHook, 0, true, engine);
    sc.endAttempt("lteRejectedRetry" as NRAttemptOutcome, true);

    sc.beginAttempt("tranPredictor" as NRPhase, 5e-10);
    fakeIter(engine.postIterationHook, 0, true, engine);
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
    expect(steps[0].stepStartTime).toBe(1e-9);
  });

  it("acceptedAttemptIndex === 1", () => {
    const { circuit, pool } = makeRCCircuit();
    const engine = new MNAEngine();
    engine.init(circuit);

    const elementLabels = buildElementLabelMap(circuit);
    const sc = createStepCaptureHook(engine.solver!, engine.elements, pool, elementLabels);
    engine.postIterationHook = sc.iterationHook;

    sc.setStepStartTime(1e-9);

    sc.beginAttempt("tranNR" as NRPhase, 1e-9);
    fakeIter(engine.postIterationHook, 0, true, engine);
    sc.endAttempt("lteRejectedRetry" as NRAttemptOutcome, true);

    sc.beginAttempt("tranPredictor" as NRPhase, 5e-10);
    fakeIter(engine.postIterationHook, 0, true, engine);
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
  });

  it("step.converged and step.accepted reflect the accepted attempt", () => {
    const { circuit, pool } = makeRCCircuit();
    const engine = new MNAEngine();
    engine.init(circuit);

    const elementLabels = buildElementLabelMap(circuit);
    const sc = createStepCaptureHook(engine.solver!, engine.elements, pool, elementLabels);
    engine.postIterationHook = sc.iterationHook;

    sc.setStepStartTime(1e-9);

    sc.beginAttempt("tranNR" as NRPhase, 1e-9);
    fakeIter(engine.postIterationHook, 0, true, engine);
    sc.endAttempt("lteRejectedRetry" as NRAttemptOutcome, true);

    sc.beginAttempt("tranPredictor" as NRPhase, 5e-10);
    fakeIter(engine.postIterationHook, 0, true, engine);
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

  it("two sequential steps each with LTE retry → 2 steps total", () => {
    const { circuit, pool } = makeRCCircuit();
    const engine = new MNAEngine();
    engine.init(circuit);

    const elementLabels = buildElementLabelMap(circuit);
    const sc = createStepCaptureHook(engine.solver!, engine.elements, pool, elementLabels);
    engine.postIterationHook = sc.iterationHook;

    // Step 1 at t=1e-9
    sc.setStepStartTime(1e-9);
    sc.beginAttempt("tranNR" as NRPhase, 1e-9);
    fakeIter(engine.postIterationHook, 0, true, engine);
    sc.endAttempt("lteRejectedRetry" as NRAttemptOutcome, true);
    sc.beginAttempt("tranPredictor" as NRPhase, 5e-10);
    fakeIter(engine.postIterationHook, 0, true, engine);
    sc.endAttempt("accepted" as NRAttemptOutcome, true);
    sc.endStep({
      stepEndTime: 1e-9,
      integrationCoefficients: TRAN_INTEG_COEFF,
      analysisPhase: "tranFloat",
      acceptedAttemptIndex: 1,
      order: engine.integrationOrder,
      delta: engine.currentDt,
    });

    // Step 2 at t=2e-9 (stepStartTime auto-advanced from previous stepEndTime)
    sc.beginAttempt("tranNR" as NRPhase, 1e-9);
    fakeIter(engine.postIterationHook, 0, true, engine);
    sc.endAttempt("lteRejectedRetry" as NRAttemptOutcome, true);
    sc.beginAttempt("tranPredictor" as NRPhase, 5e-10);
    fakeIter(engine.postIterationHook, 0, true, engine);
    sc.endAttempt("accepted" as NRAttemptOutcome, true);
    sc.endStep({
      stepEndTime: 2e-9,
      integrationCoefficients: TRAN_INTEG_COEFF,
      analysisPhase: "tranFloat",
      acceptedAttemptIndex: 1,
      order: engine.integrationOrder,
      delta: engine.currentDt,
    });

    engine.postIterationHook = null;

    const steps = sc.getSteps();
    expect(steps.length).toBe(2);
    expect(steps[0].stepStartTime).toBe(1e-9);
    expect(steps[1].stepStartTime).toBe(1e-9); // endStep of step 1 sets next stepStartTime
    expect(steps[0].attempts.length).toBe(2);
    expect(steps[1].attempts.length).toBe(2);
  });
});
