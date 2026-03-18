/**
 * Tests for Current-Controlled Current Source (CCCS) analog element.
 *
 * Circuit pattern:
 *   Vs → R_sense → sense+ → GND    (sets I_sense = Vs/R_sense)
 *   CCCS out+ → R_load → GND       (converts I_out to V_out = I_out * R_load)
 *
 * CCCS allocates ONE branch row (sense branch) at senseBranchIdx.
 * No output branch variable (Norton stamp).
 *
 * Node layout:
 *   1 = Vs+
 *   2 = R_sense bottom / sense+
 *   3 = out+
 *   sense- = GND (0), out- = GND (0)
 *
 * Branch rows (absolute):
 *   nodeCount+0 = Vs branch
 *   nodeCount+1 = CCCS sense branch (0V source)
 */

import { describe, it, expect } from "vitest";
import { ConcreteCompiledAnalogCircuit } from "../../../analog/compiled-analog-circuit.js";
import { MNAEngine } from "../../../analog/analog-engine.js";
import { makeResistor, makeVoltageSource } from "../../../analog/test-elements.js";
import { CCCSDefinition } from "../cccs.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../../../analog/element.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCCCSElement(
  nSenseP: number,
  nSenseN: number,
  nOutP: number,
  nOutN: number,
  senseBranchIdx: number,
  opts: { currentGain?: number; expression?: string } = {},
): AnalogElement {
  const gain = opts.currentGain ?? 1.0;
  const expression = opts.expression ?? "I(sense)";
  const props = new PropertyBag(new Map<string, import("../../../core/properties.js").PropertyValue>([
    ["expression", expression],
    ["currentGain", gain],
    ["label", ""],
  ]).entries());
  return CCCSDefinition.analogFactory!([nSenseP, nSenseN, nOutP, nOutN], senseBranchIdx, props);
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

/**
 * Standard CCCS test circuit:
 *   Vs=vsVoltage → node1
 *   R_sense=rSense: node1 → node2 (sets I_sense)
 *   CCCS: sense+(node2)→GND, out+(node3)→GND, gain=gain
 *   R_load=rLoad: node3 → GND  (V_out = I_out * R_load)
 *
 * I_sense = vsVoltage/rSense (since sense port has 0V drop)
 * I_out   = gain * I_sense
 * V_out   = I_out * R_load
 */
function makeGainCircuit(
  vsVoltage: number,
  rSense: number,
  rLoad: number,
  opts: { currentGain?: number; expression?: string } = {},
): ConcreteCompiledAnalogCircuit {
  const nodeCount = 3;
  const branchCount = 2; // Vs + sense branch
  const vsBranch    = nodeCount + 0; // 3
  const senseBranch = nodeCount + 1; // 4

  const vs    = makeVoltageSource(1, 0, vsBranch, vsVoltage);
  const rS    = makeResistor(1, 2, rSense);
  const cccs  = makeCCCSElement(2, 0, 3, 0, senseBranch, opts);
  const rL    = makeResistor(3, 0, rLoad);

  return buildCircuit({ nodeCount, branchCount, elements: [vs, rS, cccs, rL] });
}

// ---------------------------------------------------------------------------
// CCCS tests
// ---------------------------------------------------------------------------

describe("CCCS", () => {
  it("current_mirror_gain_1", () => {
    // I_sense = 5mA (Vs=5V, R_sense=1kΩ), gain=1 → I_out=5mA
    // V_out = 5mA * 1kΩ = 5V
    const compiled = makeGainCircuit(5.0, 1000, 1000, { currentGain: 1 });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    // V_out = I_out * R_load = 5mA * 1000 = 5V
    expect(result.nodeVoltages[2]).toBeCloseTo(5.0, 2);
  });

  it("current_gain_10", () => {
    // I_sense = 1mA (Vs=1V, R_sense=1kΩ), gain=10 → I_out=10mA
    // V_out = 10mA * 1kΩ = 10V
    const compiled = makeGainCircuit(1.0, 1000, 1000, { currentGain: 10 });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(result.nodeVoltages[2]).toBeCloseTo(10.0, 2);
  });

  it("nonlinear_expression", () => {
    // expression: 0.1 * I(sense)^2; I_sense = 10mA (Vs=10V, R_sense=1kΩ)
    // I_out = 0.1 * (0.01)^2 = 0.1 * 1e-4 = 1e-5 A = 10µA
    // V_out = 10µA * 1kΩ = 0.01V
    const compiled = makeGainCircuit(10.0, 1000, 1000, { expression: "0.1 * I(sense)^2" });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    // I_sense ≈ 10mA, I_out = 0.1 * (0.01)^2 = 10µA, V_out = 10µA * 1kΩ = 0.01V
    expect(result.nodeVoltages[2]).toBeCloseTo(0.01, 4);
  });
});
