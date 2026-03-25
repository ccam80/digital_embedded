/**
 * Tests for Current-Controlled Voltage Source (CCVS) analog element.
 *
 * Circuit pattern:
 *   Vs → R_sense → sense+ port → GND  (sets I_sense = Vs/R_sense)
 *   CCVS out+ → R_load → GND           (converts V_out to verifiable voltage)
 *
 * CCVS allocates TWO consecutive branch rows starting at senseBranchIdx:
 *   senseBranch = senseBranchIdx     (0V sense source — measures I_sense)
 *   outBranch   = senseBranchIdx + 1 (dependent voltage source)
 */

import { describe, it, expect } from "vitest";
import { ConcreteCompiledAnalogCircuit } from "../../../analog/compiled-analog-circuit.js";
import { MNAEngine } from "../../../analog/analog-engine.js";
import { makeResistor, makeVoltageSource, withNodeIds } from "../../../analog/test-elements.js";
import { CCVSDefinition } from "../ccvs.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../../../analog/element.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCCVSElement(
  nSenseP: number,
  nSenseN: number,
  nOutP: number,
  nOutN: number,
  senseBranchIdx: number,
  opts: { transresistance?: number; expression?: string } = {},
): AnalogElement {
  const rm = opts.transresistance ?? 1000;
  const expression = opts.expression ?? "I(sense)";
  const props = new PropertyBag(new Map<string, import("../../../core/properties.js").PropertyValue>([
    ["expression", expression],
    ["transresistance", rm],
    ["label", ""],
  ]).entries());
  return withNodeIds(
    CCVSDefinition.models!.analog!.factory(
      new Map([["sense+", nSenseP], ["sense-", nSenseN], ["out+", nOutP], ["out-", nOutN]]),
      [],
      senseBranchIdx,
      props,
      () => 0,
    ),
    [nSenseP, nSenseN, nOutP, nOutN],
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
// Circuit setup helper
//
// Nodes:
//   1 = Vs+ (top rail)
//   2 = junction: R_sense bottom / sense+
//   3 = out+
//   sense- = GND (0), out- = GND (0)
//
// Branch rows (absolute):
//   nodeCount+0 = Vs branch
//   nodeCount+1 = CCVS sense branch (0V source)
//   nodeCount+2 = CCVS output branch (dependent voltage source)
//
// With Vs=5V, R_sense=5kΩ:
//   sense port enforces V(node2)=0V (0V source from node2 to GND)
//   I_sense = (Vs - 0) / R_sense = 5/5000 = 1mA
// ---------------------------------------------------------------------------

function makeTransresistanceCircuit(rmOrExpr: { transresistance?: number; expression?: string }) {
  const nodeCount = 3;
  const branchCount = 3; // Vs + sense + output
  const vsBranch    = nodeCount + 0; // 3
  const senseBranch = nodeCount + 1; // 4 → passed as branchIdx to CCVS
  // outBranch = senseBranch + 1 = 5 (allocated by CCVSAnalogElement internally)

  const vs     = makeVoltageSource(1, 0, vsBranch, 5.0);       // Vs=5V
  const rSense = makeResistor(1, 2, 5000);                       // 5kΩ: node1→node2
  const ccvs   = makeCCVSElement(2, 0, 3, 0, senseBranch, rmOrExpr);

  return buildCircuit({ nodeCount, branchCount, elements: [vs, rSense, ccvs] });
}

// ---------------------------------------------------------------------------
// CCVS tests
// ---------------------------------------------------------------------------

describe("CCVS", () => {
  it("transresistance_1k", () => {
    // I_sense = 1mA, rm=1000Ω → V_out = 1V
    const compiled = makeTransresistanceCircuit({ transresistance: 1000 });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    // node3 = out+ should be 1V
    expect(result.nodeVoltages[2]).toBeCloseTo(1.0, 2);
  });

  it("zero_current_zero_output", () => {
    // Vs=0V → I_sense=0 → V_out=0
    const nodeCount = 3;
    const branchCount = 3;
    const vsBranch    = nodeCount + 0;
    const senseBranch = nodeCount + 1;

    const vs     = makeVoltageSource(1, 0, vsBranch, 0.0);
    const rSense = makeResistor(1, 2, 5000);
    const ccvs   = makeCCVSElement(2, 0, 3, 0, senseBranch, { transresistance: 1000 });

    const compiled = buildCircuit({ nodeCount, branchCount, elements: [vs, rSense, ccvs] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(result.nodeVoltages[2]).toBeCloseTo(0.0, 4);
  });

  it("sense_port_zero_voltage_drop", () => {
    // The 0V sense source enforces V(sense+) - V(sense-) = 0V.
    // With sense-=GND, V(node2) must equal 0V.
    const compiled = makeTransresistanceCircuit({ transresistance: 1000 });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    // node2 = sense+ — should be 0V (0V drop across sense port)
    expect(result.nodeVoltages[1]).toBeCloseTo(0.0, 4);
  });
});
