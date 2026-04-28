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
import type { AnalogElement } from "../../element.js";
import { makeDcVoltageSource, DC_VOLTAGE_SOURCE_DEFAULTS } from "../../../../components/sources/dc-voltage-source.js";
import { PropertyBag } from "../../../../core/properties.js";
import { makeTestSetupContext, setupAll, allocateStatePool } from "../test-helpers.js";
import { SparseSolver } from "../../sparse-solver.js";
import { NGSPICE_LOAD_ORDER } from "../../element.js";
import type { SetupContext } from "../../setup-context.js";
import type { LoadContext } from "../../load-context.js";
import {
  buildElementLabelMap,
  createStepCaptureHook,
} from "./capture.js";
import type { IntegrationCoefficients, NRPhase, NRAttemptOutcome } from "./types.js";

// ---------------------------------------------------------------------------
// Minimal inline factories (production pattern per §A.13)
// ---------------------------------------------------------------------------

function makeResistor(
  pinNodes: ReadonlyMap<string, number>,
  resistance: number,
): AnalogElement {
  let _hAA = -1, _hBB = -1, _hAB = -1, _hBA = -1;
  const el: AnalogElement = {
    label: "",
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.RES,
    _pinNodes: new Map(pinNodes),
    _stateBase: -1,
    branchIndex: -1,
    setup(ctx: SetupContext): void {
      const a = el._pinNodes.get("A")!;
      const b = el._pinNodes.get("B")!;
      _hAA = ctx.solver.allocElement(a, a);
      _hBB = ctx.solver.allocElement(b, b);
      _hAB = ctx.solver.allocElement(a, b);
      _hBA = ctx.solver.allocElement(b, a);
    },
    load(ctx: LoadContext): void {
      const G = 1.0 / Math.max(resistance, 1e-12);
      ctx.solver.stampElement(_hAA, G);
      ctx.solver.stampElement(_hBB, G);
      ctx.solver.stampElement(_hAB, -G);
      ctx.solver.stampElement(_hBA, -G);
    },
    getPinCurrents(rhs: Float64Array): number[] {
      const a = el._pinNodes.get("A")!;
      const b = el._pinNodes.get("B")!;
      const Vab = rhs[a] - rhs[b];
      const I = Vab / Math.max(resistance, 1e-12);
      return [I, -I];
    },
    setParam(key: string, value: number): void {
      if (key === "resistance") resistance = value;
    },
  };
  return el;
}

function makeDiode(
  pinNodes: ReadonlyMap<string, number>,
  Is: number,
  n: number,
): AnalogElement {
  const VT = 0.025852;
  let _hAA = -1, _hKK = -1, _hAK = -1, _hKA = -1;
  const el: AnalogElement = {
    label: "",
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.DIO,
    _pinNodes: new Map(pinNodes),
    _stateBase: -1,
    branchIndex: -1,
    setup(ctx: SetupContext): void {
      const a = el._pinNodes.get("anode")!;
      const k = el._pinNodes.get("cathode")!;
      _hAA = ctx.solver.allocElement(a, a);
      _hKK = ctx.solver.allocElement(k, k);
      _hAK = ctx.solver.allocElement(a, k);
      _hKA = ctx.solver.allocElement(k, a);
    },
    load(ctx: LoadContext): void {
      const a = el._pinNodes.get("anode")!;
      const k = el._pinNodes.get("cathode")!;
      const Vd = ctx.rhsOld[a] - ctx.rhsOld[k];
      const Vd_clamped = Math.min(Vd, 0.8);
      const Id = Is * (Math.exp(Vd_clamped / (n * VT)) - 1);
      const Gd = Is * Math.exp(Vd_clamped / (n * VT)) / (n * VT);
      const Ieq = Id - Gd * Vd_clamped;
      ctx.solver.stampElement(_hAA, Gd);
      ctx.solver.stampElement(_hKK, Gd);
      ctx.solver.stampElement(_hAK, -Gd);
      ctx.solver.stampElement(_hKA, -Gd);
      ctx.rhs[a] -= Ieq;
      ctx.rhs[k] += Ieq;
    },
    getPinCurrents(rhs: Float64Array): number[] {
      const a = el._pinNodes.get("anode")!;
      const k = el._pinNodes.get("cathode")!;
      const Vd = rhs[a] - rhs[k];
      const Id = Is * (Math.exp(Math.min(Vd, 0.8) / (n * VT)) - 1);
      return [Id, -Id];
    },
    setParam(key: string, value: number): void {
      if (key === "Is") Is = value;
      if (key === "n") n = value;
    },
  };
  return el;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TRAN_INTEG_COEFF: IntegrationCoefficients = {
  ours: { ag0: 2e9, ag1: 2e9, method: "trapezoidal", order: 2 },
  ngspice: { ag0: 2e9, ag1: 2e9, method: "trapezoidal", order: 2 },
};

function makeVsrc(posNode: number, negNode: number, voltage: number) {
  const props = new PropertyBag();
  props.replaceModelParams({ ...DC_VOLTAGE_SOURCE_DEFAULTS, voltage });
  return makeDcVoltageSource(new Map([["pos", posNode], ["neg", negNode]]), props, () => 0);
}

function makeHWRCircuit(): { circuit: ConcreteCompiledAnalogCircuit; pool: ReturnType<typeof allocateStatePool> } {
  const solver = new SparseSolver();
  const vs = makeVsrc(1, 0, 5.0);
  const r = makeResistor(new Map([["A", 1], ["B", 2]]), 1000);
  const diode = makeDiode(new Map([["anode", 2], ["cathode", 0]]), 1e-14, 1.0);
  const elements = [vs, r, diode];

  vs.label = "Vs";
  r.label = "R1";
  diode.label = "D1";

  const ctx = makeTestSetupContext({
    solver,
    startBranch: 3,
    startNode: 10,
    elements,
  });
  setupAll(elements, ctx);

  const pool = allocateStatePool(elements);
  return {
    circuit: {
      netCount: 2, componentCount: 3, nodeCount: 2,
      elements,
      labelToNodeId: new Map([["Vs", 1], ["R1:B", 2]]),
      statePool: pool,
    } as unknown as ConcreteCompiledAnalogCircuit,
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
