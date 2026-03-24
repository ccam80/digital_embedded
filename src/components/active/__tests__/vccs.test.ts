/**
 * Tests for Voltage-Controlled Current Source (VCCS) analog element.
 *
 * All tests use hand-built ConcreteCompiledAnalogCircuit and drive the
 * MNAEngine directly, verifying DC operating-point results.
 *
 * VCCS circuit pattern:
 *   - Voltage source Vs sets the control voltage V_ctrl at node_ctrl.
 *   - VCCS outputs current I_out = gm * V_ctrl into node_out.
 *   - Load resistor R_load at node_out → GND converts current to voltage:
 *     V_out = I_out * R_load = gm * V_ctrl * R_load
 */

import { describe, it, expect } from "vitest";
import { ConcreteCompiledAnalogCircuit } from "../../../analog/compiled-analog-circuit.js";
import { MNAEngine } from "../../../analog/analog-engine.js";
import { makeResistor, makeVoltageSource } from "../../../analog/test-elements.js";
import { VCCSDefinition } from "../vccs.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../../../analog/element.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVCCSElement(
  nCtrlP: number,
  nCtrlN: number,
  nOutP: number,
  nOutN: number,
  opts: { transconductance?: number; expression?: string } = {},
): AnalogElement {
  const gm = opts.transconductance ?? 0.001;
  const expression = opts.expression ?? "V(ctrl)";
  const props = new PropertyBag(new Map<string, import("../../../core/properties.js").PropertyValue>([
    ["expression", expression],
    ["transconductance", gm],
    ["label", ""],
  ]).entries());
  return VCCSDefinition.analogFactory!(
    new Map([["ctrl+", nCtrlP], ["ctrl-", nCtrlN], ["out+", nOutP], ["out-", nOutN]]),
    [],
    -1,
    props,
    () => 0,
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
// VCCS tests
// ---------------------------------------------------------------------------

describe("VCCS", () => {
  it("linear_transconductance", () => {
    // gm=0.01 S, V_ctrl=1V → I_out=10mA, R_load=100Ω → V_out=1V
    //
    // Circuit:
    //   Vs=1V: node1 (+), GND (-)  [branch row 2]
    //   VCCS: ctrl+=node1, ctrl-=GND, out+=node2, out-=GND, gm=0.01S
    //   R=100Ω: node2→GND
    //
    // nodeCount=2: node1=ctrl, node2=output
    // branchCount=1: row2=Vs branch (VCCS has no branch)
    const nodeCount = 2;
    const branchCount = 1;
    const vsBranch = nodeCount + 0; // absolute row 2

    const vs   = makeVoltageSource(1, 0, vsBranch, 1.0);
    const vccs = makeVCCSElement(1, 0, 2, 0, { transconductance: 0.01 });
    const r    = makeResistor(2, 0, 100);

    const compiled = buildCircuit({ nodeCount, branchCount, elements: [vs, vccs, r] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(result.nodeVoltages[0]).toBeCloseTo(1.0, 2); // V_ctrl = 1V
    // V_out = I_out * R = gm * V_ctrl * R = 0.01 * 1 * 100 = 1V
    expect(result.nodeVoltages[1]).toBeCloseTo(1.0, 2);
  });

  it("zero_control_zero_output", () => {
    // V_ctrl=0 → I_out=0 → V_out=0 across any load
    const nodeCount = 2;
    const branchCount = 1;
    const vsBranch = nodeCount + 0;

    const vs   = makeVoltageSource(1, 0, vsBranch, 0.0);
    const vccs = makeVCCSElement(1, 0, 2, 0, { transconductance: 0.01 });
    const r    = makeResistor(2, 0, 1000);

    const compiled = buildCircuit({ nodeCount, branchCount, elements: [vs, vccs, r] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(result.nodeVoltages[1]).toBeCloseTo(0.0, 4);
  });

  it("nonlinear_square_law", () => {
    // expression: 0.001 * V(ctrl)^2; V_ctrl=3V → I_out = 0.001*9 = 9mA
    // R_load=100Ω → V_out = 9mA * 100 = 0.9V
    const nodeCount = 2;
    const branchCount = 1;
    const vsBranch = nodeCount + 0;

    const vs   = makeVoltageSource(1, 0, vsBranch, 3.0);
    const vccs = makeVCCSElement(1, 0, 2, 0, { expression: "0.001 * V(ctrl)^2" });
    const r    = makeResistor(2, 0, 100);

    const compiled = buildCircuit({ nodeCount, branchCount, elements: [vs, vccs, r] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(result.nodeVoltages[0]).toBeCloseTo(3.0, 2); // V_ctrl = 3V
    // I_out = 0.001 * 9 = 9mA; V_out = 9mA * 100Ω = 0.9V
    expect(result.nodeVoltages[1]).toBeCloseTo(0.9, 2);
  });
});
