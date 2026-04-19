/**
 * Unit tests for boot-step capture (spec §10.2 test 2).
 *
 * runDcOp() must produce exactly 1 step:
 *   - stepStartTime === 0
 *   - stepEndTime === 0
 *   - dt === 0
 *   - attempts reflect DCOP path (phase = "dcopDirect" or variant)
 *   - accepted === true
 *
 * No DLL required — uses our engine only via the low-level hook API.
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
// Test helpers
// ---------------------------------------------------------------------------

const ZERO_INTEG_COEFF: IntegrationCoefficients = {
  ours: { ag0: 0, ag1: 0, method: "backwardEuler", order: 1 },
  ngspice: { ag0: 0, ag1: 0, method: "backwardEuler", order: 1 },
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

/** Run DCOP with phase/iteration hooks and return the captured steps. */
function runDcopCapture() {
  const { circuit, pool } = makeHWRCircuit();
  const engine = new MNAEngine();
  engine.init(circuit);

  const elementLabels = buildElementLabelMap(circuit);
  const sc = createStepCaptureHook(engine.solver!, engine.elements, pool, elementLabels);

  engine.postIterationHook = sc.iterationHook;
  engine.stepPhaseHook = {
    onAttemptBegin(phase: string, dt: number) { sc.beginAttempt(phase as NRPhase, dt); },
    onAttemptEnd(outcome: string, converged: boolean) { sc.endAttempt(outcome as NRAttemptOutcome, converged); },
  };

  sc.setStepStartTime(0);
  engine.dcOperatingPoint();
  sc.endStep({
    stepEndTime: 0,
    integrationCoefficients: ZERO_INTEG_COEFF,
    analysisPhase: "dcop",
    acceptedAttemptIndex: -1,
    order: engine.integrationOrder,
    delta: engine.currentDt,
  });

  engine.stepPhaseHook = null;
  engine.postIterationHook = null;

  return sc.getSteps();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("boot-step: runDcOp() produces exactly 1 step at time 0", () => {

  it("produces exactly 1 step", () => {
    const steps = runDcopCapture();
    expect(steps.length).toBe(1);
  });

  it("step has stepStartTime === 0", () => {
    const steps = runDcopCapture();
    expect(steps[0].stepStartTime).toBe(0);
  });

  it("step has stepEndTime === 0", () => {
    const steps = runDcopCapture();
    expect(steps[0].stepEndTime).toBe(0);
  });

  it("step dt === 0 (boot step is DCOP, no timestepping)", () => {
    const steps = runDcopCapture();
    expect(steps[0].dt).toBe(0);
  });

  it("step has at least one attempt with a DCOP phase", () => {
    const steps = runDcopCapture();
    expect(steps[0].attempts.length).toBeGreaterThanOrEqual(1);

    const dcopPhases: NRPhase[] = ["dcopInitJct", "dcopInitFix", "dcopInitFloat", "dcopDirect", "dcopGminDynamic", "dcopGminSpice3", "dcopSrcSweep"];
    const hasDcopPhase = steps[0].attempts.some((a) => dcopPhases.includes(a.phase));
    expect(hasDcopPhase).toBe(true);
  });

  it("step analysisPhase === 'dcop'", () => {
    const steps = runDcopCapture();
    expect(steps[0].analysisPhase).toBe("dcop");
  });

  it("step accepted === true and converged === true for a simple converging circuit", () => {
    const steps = runDcopCapture();
    expect(steps[0].converged).toBe(true);
    expect(steps[0].accepted).toBe(true);
  });

  it("step has at least 1 NR iteration captured", () => {
    const steps = runDcopCapture();
    expect(steps[0].iterationCount).toBeGreaterThanOrEqual(1);
    expect(steps[0].iterations.length).toBeGreaterThanOrEqual(1);
  });
});
