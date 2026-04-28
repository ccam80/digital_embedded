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
import { allocateStatePool } from "../test-helpers.js";
import { makeDcVoltageSource, DC_VOLTAGE_SOURCE_DEFAULTS } from "../../../../components/sources/dc-voltage-source.js";
import { PropertyBag } from "../../../../core/properties.js";
import type { AnalogElement } from "../../element.js";
import type { SetupContext } from "../../setup-context.js";
import type { LoadContext } from "../../load-context.js";
import { NGSPICE_LOAD_ORDER } from "../../../../core/analog-types.js";
import {
  buildElementLabelMap,
  createStepCaptureHook,
} from "./capture.js";
import type { IntegrationCoefficients, NRPhase, NRAttemptOutcome } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ZERO_INTEG_COEFF: IntegrationCoefficients = {
  ours: { ag0: 0, ag1: 0, method: "trapezoidal", order: 1 },
  ngspice: { ag0: 0, ag1: 0, method: "trapezoidal", order: 1 },
};

// ---------------------------------------------------------------------------
// Minimal inline element factories — implement the new AnalogElement contract.
// These exist only to give the engine a functioning circuit; they are NOT
// testing element correctness (that is the responsibility of element-specific
// tests).
// ---------------------------------------------------------------------------

function makeResistorEl(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  let _hPP = -1, _hNN = -1, _hPN = -1, _hNP = -1;
  const G = 1 / resistance;
  const el: AnalogElement = {
    label: "",
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.RES,
    _pinNodes: new Map([["A", nodeA], ["B", nodeB]]),
    _stateBase: -1,
    branchIndex: -1,
    setup(ctx: SetupContext) {
      const s = ctx.solver;
      const p = el._pinNodes.get("A")!;
      const n = el._pinNodes.get("B")!;
      _hPP = s.allocElement(p, p);
      _hNN = s.allocElement(n, n);
      _hPN = s.allocElement(p, n);
      _hNP = s.allocElement(n, p);
    },
    load(ctx: LoadContext) {
      ctx.solver.stampElement(_hPP, G);
      ctx.solver.stampElement(_hNN, G);
      ctx.solver.stampElement(_hPN, -G);
      ctx.solver.stampElement(_hNP, -G);
    },
    getPinCurrents(_rhs: Float64Array): number[] {
      return [];
    },
    setParam(_key: string, _value: number): void {},
  };
  return el;
}

function makeDiodeEl(nodeA: number, nodeK: number, IS: number, N: number): AnalogElement {
  let _hAA = -1, _hKK = -1, _hAK = -1, _hKA = -1;
  const VT = 0.025852;
  let _vd = 0;
  const el: AnalogElement = {
    label: "",
    ngspiceLoadOrder: NGSPICE_LOAD_ORDER.DIO,
    _pinNodes: new Map([["A", nodeA], ["K", nodeK]]),
    _stateBase: -1,
    branchIndex: -1,
    setup(ctx: SetupContext) {
      const s = ctx.solver;
      _hAA = s.allocElement(nodeA, nodeA);
      _hKK = s.allocElement(nodeK, nodeK);
      _hAK = s.allocElement(nodeA, nodeK);
      _hKA = s.allocElement(nodeK, nodeA);
    },
    load(ctx: LoadContext) {
      const vA = ctx.rhsOld[nodeA] ?? 0;
      const vK = ctx.rhsOld[nodeK] ?? 0;
      _vd = vA - vK;
      const expArg = Math.min(_vd / (N * VT), 40);
      const Id = IS * (Math.exp(expArg) - 1);
      const Gd = IS * Math.exp(expArg) / (N * VT);
      const Ieq = Id - Gd * _vd;
      ctx.solver.stampElement(_hAA, Gd);
      ctx.solver.stampElement(_hKK, Gd);
      ctx.solver.stampElement(_hAK, -Gd);
      ctx.solver.stampElement(_hKA, -Gd);
      ctx.rhs[nodeA] -= Ieq;
      ctx.rhs[nodeK] += Ieq;
    },
    checkConvergence(ctx: LoadContext): boolean {
      const vA = ctx.rhsOld[nodeA] ?? 0;
      const vK = ctx.rhsOld[nodeK] ?? 0;
      const vdNew = vA - vK;
      return Math.abs(vdNew - _vd) < ctx.voltTol + ctx.reltol * Math.abs(vdNew);
    },
    getPinCurrents(_rhs: Float64Array): number[] {
      return [];
    },
    setParam(_key: string, _value: number): void {},
  };
  return el;
}

// ---------------------------------------------------------------------------
// Helper: create a DC voltage source using the 3-arg production factory.
// ---------------------------------------------------------------------------

function makeVsrc(posNode: number, negNode: number, voltage: number) {
  const props = new PropertyBag();
  props.replaceModelParams({ ...DC_VOLTAGE_SOURCE_DEFAULTS, voltage });
  return makeDcVoltageSource(new Map([["pos", posNode], ["neg", negNode]]), props, () => 0);
}

// ---------------------------------------------------------------------------
// HWR circuit: V1(5V) — R1(1kΩ) — D1 in series
// Node 1: V+ / R-top   Node 2: R-bottom / D-anode   Node 0: ground / D-cathode
// matrixSize=3  (2 nodes + branch row at index 2 for voltage source)
// ---------------------------------------------------------------------------

function makeHWRCircuit(): { circuit: ConcreteCompiledAnalogCircuit; pool: ReturnType<typeof allocateStatePool> } {
  const vs = makeVsrc(1, 0, 5.0);
  vs.label = "Vs";
  const r = makeResistorEl(1, 2, 1000);
  r.label = "R1";
  const diode = makeDiodeEl(2, 0, 1e-14, 1.0);
  diode.label = "D1";

  const elements = [vs, r, diode];
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
