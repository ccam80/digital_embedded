/**
 * Tests for Voltage-Controlled Voltage Source (VCVS) analog element.
 *
 * All tests use hand-built ConcreteCompiledAnalogCircuit and drive the
 * MNAEngine directly, verifying DC operating-point results.
 *
 * MNA solution vector layout:
 *   indices 0..nodeCount-1      — node voltages (MNA node IDs 1-based)
 *   indices nodeCount..size-1   — branch currents (voltage source / inductor)
 */

import { describe, it, expect } from "vitest";
import { ConcreteCompiledAnalogCircuit } from "../../../solver/analog/compiled-analog-circuit.js";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";
import { makeResistor, makeVoltageSource, withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";
import { VCVSDefinition } from "../vcvs.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../../../solver/analog/element.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVCVSElement(
  nCtrlP: number,
  nCtrlN: number,
  nOutP: number,
  nOutN: number,
  branchIdx: number,
  opts: { gain?: number; expression?: string } = {},
): AnalogElement {
  const gain = opts.gain ?? 1.0;
  const expression = opts.expression ?? "V(ctrl)";
  const props = new PropertyBag(new Map<string, import("../../../core/properties.js").PropertyValue>([
    ["expression", expression],
    ["gain", gain],
    ["label", ""],
  ]).entries());
  return withNodeIds(
    VCVSDefinition.models!.analog!.factory(
      new Map([["ctrl+", nCtrlP], ["ctrl-", nCtrlN], ["out+", nOutP], ["out-", nOutN]]),
      [],
      branchIdx,
      props,
      () => 0,
    ),
    [nCtrlP, nCtrlN, nOutP, nOutN],
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
  });
}

// ---------------------------------------------------------------------------
// VCVS tests
// ---------------------------------------------------------------------------

describe("VCVS", () => {
  it("unity_gain_buffer", () => {
    // Circuit: Vs=3.3V → node1; VCVS(ctrl+=node1, ctrl-=GND, out+=node2, out-=GND, gain=1)
    // Expected: V(node2) = 3.3V
    //
    // nodeCount=2:  node1=ctrl voltage, node2=output voltage
    // branchCount=2: row2=Vs branch, row3=VCVS branch
    const nodeCount = 2;
    const branchCount = 2;
    const vsBranch = nodeCount + 0;   // absolute row 2
    const vcvsBranch = nodeCount + 1; // absolute row 3

    const vs   = makeVoltageSource(1, 0, vsBranch, 3.3);
    const vcvs = makeVCVSElement(1, 0, 2, 0, vcvsBranch, { gain: 1.0 });

    const compiled = buildCircuit({ nodeCount, branchCount, elements: [vs, vcvs] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(result.nodeVoltages[0]).toBeCloseTo(3.3, 2); // node1
    expect(result.nodeVoltages[1]).toBeCloseTo(3.3, 2); // node2 = gain*V(ctrl)
  });

  it("gain_of_10", () => {
    // Vs=0.5V, VCVS gain=10 → output = 5.0V
    const nodeCount = 2;
    const branchCount = 2;
    const vsBranch = nodeCount + 0;
    const vcvsBranch = nodeCount + 1;

    const vs   = makeVoltageSource(1, 0, vsBranch, 0.5);
    const vcvs = makeVCVSElement(1, 0, 2, 0, vcvsBranch, { gain: 10.0 });

    const compiled = buildCircuit({ nodeCount, branchCount, elements: [vs, vcvs] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(result.nodeVoltages[0]).toBeCloseTo(0.5, 2);
    expect(result.nodeVoltages[1]).toBeCloseTo(5.0, 2);
  });

  it("nonlinear_expression", () => {
    // expression: 0.5 * V(ctrl)^2, ctrl=2V → output = 0.5 * 4 = 2.0V
    // NR should converge in ≤ 10 iterations
    const nodeCount = 2;
    const branchCount = 2;
    const vsBranch = nodeCount + 0;
    const vcvsBranch = nodeCount + 1;

    const vs   = makeVoltageSource(1, 0, vsBranch, 2.0);
    const vcvs = makeVCVSElement(1, 0, 2, 0, vcvsBranch, { expression: "0.5 * V(ctrl)^2" });

    const compiled = buildCircuit({ nodeCount, branchCount, elements: [vs, vcvs] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(result.nodeVoltages[1]).toBeCloseTo(2.0, 2);
    expect(result.iterations).toBeLessThanOrEqual(10);
  });

  it("output_drives_load", () => {
    // Vs=1V → node1 (ctrl), VCVS gain=10 → node2 (output=10V), R=1kΩ node2→GND
    // Output node is enforced at 10V by VCVS regardless of load.
    const nodeCount = 2;
    const branchCount = 2;
    const vsBranch = nodeCount + 0;
    const vcvsBranch = nodeCount + 1;

    const vs    = makeVoltageSource(1, 0, vsBranch, 1.0);
    const vcvs  = makeVCVSElement(1, 0, 2, 0, vcvsBranch, { gain: 10.0 });
    const rLoad = makeResistor(2, 0, 1000);

    const compiled = buildCircuit({ nodeCount, branchCount, elements: [vs, vcvs, rLoad] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    // Output voltage enforced at 10V by VCVS
    expect(result.nodeVoltages[1]).toBeCloseTo(10.0, 2);
    // VCVS branch current: I = V_out / R_load = 10 / 1000 = 10mA
    // Branch current sign: positive = current flowing into out+ terminal
    const vcvsBranchCurrent = result.nodeVoltages[vcvsBranch];
    expect(Math.abs(vcvsBranchCurrent)).toBeCloseTo(0.01, 3);
  });
});
