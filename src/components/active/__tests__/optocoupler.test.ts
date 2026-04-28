/**
 * Optocoupler tests — A1 post-composition survivors.
 *
 * All hand-computed expected-value tests from the pre-composition PWL
 * implementation deleted per A1 §Test handling rule: those tests encoded
 * the inline PWL LED model (vForward/rLed params) and the cross-port Jacobian
 * of the shortcut implementation. The composition now delegates to diode.ts
 * (dioload.c) and bjt.ts (bjtload.c); the expected values must come from
 * the ngspice harness, not hand computation.
 *
 * What survives (per §A1 "Test handling during A1 execution"):
 *   1. Parameter plumbing — ctr, Is, n params accepted and stored.
 *   2. Engine-agnostic interface contracts — poolBacked, stateSize, initState.
 */

import { describe, it, expect } from "vitest";
import { OptocouplerDefinition } from "../optocoupler.js";
import { PropertyBag } from "../../../core/properties.js";
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
import { ConcreteCompiledAnalogCircuit } from "../../../solver/analog/compiled-analog-circuit.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";
import { makeResistor, makeVoltageSource, withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";
import type { AnalogElement } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

function makeOptocouplerCore(
  nAnode: number,
  nCathode: number,
  nCollector: number,
  nEmitter: number,
  _nBase: number,
  opts: { ctr?: number; Is?: number; n?: number } = {},
) {
  const ctr = opts.ctr ?? 1.0;
  const Is  = opts.Is  ?? 1e-14;
  const n   = opts.n   ?? 1.0;
  const props = new PropertyBag(new Map<string, import("../../../core/properties.js").PropertyValue>([
    ["vceSat",    0.3],
    ["bandwidth", 50000],
    ["label",     ""],
  ]).entries());
  props.replaceModelParams({ ctr, Is, n });
  return getFactory(OptocouplerDefinition.modelRegistry!["behavioral"]!)(
    new Map([
      ["anode", nAnode], ["cathode", nCathode],
      ["collector", nCollector], ["emitter", nEmitter],
    ]),
    props,
    () => 0,
  );
}

// ---------------------------------------------------------------------------
// Parameter plumbing
// ---------------------------------------------------------------------------

describe("Optocoupler parameter plumbing", () => {
  it("accepts ctr, Is, n params without throwing", () => {
    expect(() =>
      makeOptocouplerCore(1, 2, 3, 4, 5, { ctr: 0.5, Is: 2e-14, n: 1.5 }),
    ).not.toThrow();
  });

  it("default params produce a valid element", () => {
    const el = makeOptocouplerCore(1, 2, 3, 4, 5);
    expect(el).toBeDefined();
    expect(el.branchIndex).toBe(-1);
    expect(el.isNonlinear).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Engine-agnostic interface contracts
// ---------------------------------------------------------------------------

describe("Optocoupler composite interface (PB-OPTO)", () => {
  it("is not pool-backed at the composite level (state delegated to sub-elements)", () => {
    const el = makeOptocouplerCore(1, 2, 3, 4, 5);
    // The composite delegates all state management to DIO and BJT sub-elements.
    // The composite itself has no stateSize or poolBacked flag.
    expect((el as any).poolBacked).toBeFalsy();
  });

  it("branchIndex is -1 (no extra MNA row at composite level)", () => {
    const el = makeOptocouplerCore(1, 2, 3, 4, 5);
    expect(el.branchIndex).toBe(-1);
  });

  it("isNonlinear is true (DIO and BJT sub-elements are nonlinear)", () => {
    const el = makeOptocouplerCore(1, 2, 3, 4, 5);
    expect(el.isNonlinear).toBe(true);
  });

  it("modelRegistry behavioral entry has mayCreateInternalNodes=true", () => {
    const entry = OptocouplerDefinition.modelRegistry!["behavioral"]!;
    if (entry.kind !== "inline") throw new Error("Expected inline");
    expect(entry.mayCreateInternalNodes).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Salvaged behavioural tests (pre-composition: commit 39ab73ca, lines 86-289)
//
// These 5 tests originally validated the inline PWL LED model (vForward/rLed
// params) at the circuit level. The composition now delegates to ngspice
// diode (Is/n) + BJT (default NPN) + CCCS coupler. The conceptual scenarios
// (current transfer, galvanic isolation, off-state, zero-input, CTR scaling)
// still apply post-composition, but the hand-computed expected values were
// derived from the PWL formulas and will fail against the ngspice composition
// until re-derived from the new model.
//
// The pre-gut parity test (optocoupler_load_dcop_parity) was deliberately NOT
// salvaged — it asserted PWL stamp formulas that no longer exist.
// ---------------------------------------------------------------------------

function makeOptocouplerElement(
  nAnode: number,
  nCathode: number,
  nCollector: number,
  nEmitter: number,
  opts: { ctr?: number; Is?: number; n?: number; vForward?: number; rLed?: number } = {},
): AnalogElement {
  // vForward and rLed are pre-composition PWL params; the post-composition
  // model accepts only ctr, Is, n. They are forwarded here for salvage
  // continuity but the new model ignores them.
  return withNodeIds(
    makeOptocouplerCore(nAnode, nCathode, nCollector, nEmitter, 0, opts) as unknown as AnalogElement,
    [nAnode, nCathode, nCollector, nEmitter],
  );
}

function buildCircuit(opts: {
  nodeCount: number;
  branchCount: number;
  elements: AnalogElement[];
}): ConcreteCompiledAnalogCircuit {
  return new ConcreteCompiledAnalogCircuit({
    nodeCount: opts.nodeCount,
    branchCount: opts.branchCount,
    elements: opts.elements,
    labelToNodeId: new Map(),
    wireToNodeId: new Map(),
    models: new Map(),
    elementToCircuitElement: new Map(),
    statePool: new StatePool(0),
  } as unknown as ConstructorParameters<typeof ConcreteCompiledAnalogCircuit>[0]);
}

describe("Optocoupler (salvaged behavioural tests — pre-composition)", () => {
  it("current_transfer", () => {
    // Input: V_in = 1.3V, R_series = 10Ω, V_F = 1.2V → I_LED = (1.3-1.2)/10 = 10mA
    // CTR = 1.0 → I_C = 10mA
    // R_load = 1000Ω from collector to GND → V(node2) = I_C * R_load = 10V
    // (Pre-PWL values — will diverge against ngspice diode law.)
    const nodeCount   = 2;
    const branchCount = 1;
    const vsBranch    = nodeCount + 0; // row 2

    const vIn   = 1.3;
    const rLed  = 10;
    const vF    = 1.2;
    const rLoad = 1000;

    const vs   = makeVoltageSource(1, 0, vsBranch, vIn);
    const opto = makeOptocouplerElement(1, 0, 2, 0, { ctr: 1.0, vForward: vF, rLed });
    const rL   = makeResistor(2, 0, rLoad);

    const compiled = buildCircuit({ nodeCount, branchCount, elements: [vs, opto, rL] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);

    const iLed = (vIn - vF) / rLed;
    const vCollectorExpected = iLed * rLoad;
    expect(result.nodeVoltages[1]).toBeCloseTo(vCollectorExpected, 2);
  });

  it("galvanic_isolation", () => {
    // Same I_C regardless of output-side ground potential (0V vs 100V offset).
    const vF    = 1.2;
    const rLed  = 10;
    const vIn   = 1.3;
    const rLoad = 1000;
    const iLedExpected = (vIn - vF) / rLed; // 10mA

    function runCase1(): number {
      const nodeCount   = 2;
      const branchCount = 1;
      const vsBranch    = nodeCount + 0;

      const vs   = makeVoltageSource(1, 0, vsBranch, vIn);
      const opto = makeOptocouplerElement(1, 0, 2, 0, { ctr: 1.0, vForward: vF, rLed });
      const rL   = makeResistor(2, 0, rLoad);

      const compiled = buildCircuit({ nodeCount, branchCount, elements: [vs, opto, rL] });
      const engine = new MNAEngine();
      engine.init(compiled);
      const result = engine.dcOperatingPoint();
      expect(result.converged).toBe(true);
      return result.nodeVoltages[1] / rLoad;
    }

    function runCase2(): number {
      const nodeCount   = 3;   // 1=anode, 2=collector, 3=emitter
      const branchCount = 2;   // rows: 3=Vs_in, 4=Vs_emitter
      const vsBranchIn      = nodeCount + 0; // row 3
      const vsBranchEmitter = nodeCount + 1; // row 4

      const vsIn      = makeVoltageSource(1, 0, vsBranchIn,      vIn);
      const vsEmitter = makeVoltageSource(3, 0, vsBranchEmitter, 100);
      const opto      = makeOptocouplerElement(1, 0, 2, 3, { ctr: 1.0, vForward: vF, rLed });
      const rL        = makeResistor(2, 3, rLoad);

      const compiled = buildCircuit({ nodeCount, branchCount, elements: [vsIn, vsEmitter, opto, rL] });
      const engine = new MNAEngine();
      engine.init(compiled);
      const result = engine.dcOperatingPoint();
      expect(result.converged).toBe(true);
      const vCollector = result.nodeVoltages[1];
      const vEmitter   = result.nodeVoltages[2];
      return (vCollector - vEmitter) / rLoad;
    }

    const iC1 = runCase1();
    const iC2 = runCase2();

    expect(iC1).toBeCloseTo(iLedExpected, 3);
    expect(iC2).toBeCloseTo(iLedExpected, 3);
  });

  it("led_forward_voltage", () => {
    // V_in = 0.5V < V_F = 1.2V → LED off → I_C ≈ 0 → V(collector) ≈ 0
    const nodeCount   = 2;
    const branchCount = 1;
    const vsBranch    = nodeCount + 0;

    const vsBelow = makeVoltageSource(1, 0, vsBranch, 0.5);
    const opto    = makeOptocouplerElement(1, 0, 2, 0, { ctr: 1.0, vForward: 1.2, rLed: 10 });
    const rLoad   = makeResistor(2, 0, 1000);

    const compiled = buildCircuit({ nodeCount, branchCount, elements: [vsBelow, opto, rLoad] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(result.nodeVoltages[1]).toBeCloseTo(0, 3);
  });

  it("zero_input_zero_output", () => {
    // V_in = 0V → I_LED = 0 → I_C = 0 → V(collector) = 0
    const nodeCount   = 2;
    const branchCount = 1;
    const vsBranch    = nodeCount + 0;

    const vs    = makeVoltageSource(1, 0, vsBranch, 0.0);
    const opto  = makeOptocouplerElement(1, 0, 2, 0, { ctr: 1.0, vForward: 1.2, rLed: 10 });
    const rLoad = makeResistor(2, 0, 1000);

    const compiled = buildCircuit({ nodeCount, branchCount, elements: [vs, opto, rLoad] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(result.nodeVoltages[1]).toBeCloseTo(0, 4);
  });

  it("ctr_scaling", () => {
    // CTR = 0.5; V_in = 1.4V, V_F = 1.2V, R_LED = 10Ω → I_LED = 20mA → I_C = 10mA
    // V(collector) = 10mA * 1000Ω = 10V (PWL-derived expected value).
    const nodeCount   = 2;
    const branchCount = 1;
    const vsBranch    = nodeCount + 0;

    const vIn   = 1.4;
    const vF    = 1.2;
    const rLed  = 10;
    const rLoad = 1000;

    const vs    = makeVoltageSource(1, 0, vsBranch, vIn);
    const opto  = makeOptocouplerElement(1, 0, 2, 0, { ctr: 0.5, vForward: vF, rLed });
    const rL    = makeResistor(2, 0, rLoad);

    const compiled = buildCircuit({ nodeCount, branchCount, elements: [vs, opto, rL] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);

    const iLed = (vIn - vF) / rLed;
    const iC   = 0.5 * iLed;
    const vCollectorExpected = iC * rLoad;

    expect(result.nodeVoltages[1]).toBeCloseTo(vCollectorExpected, 2);
  });
});
