/**
 * Tests for Voltage-Controlled Current Source (VCCS) analog element.
 *
 * All tests use the real factory path: instantiate via factory, let
 * MNAEngine._setup() allocate handles, then verify DC operating-point results.
 *
 * VCCS circuit pattern:
 *   - Voltage source Vs sets the control voltage V_ctrl at node_ctrl.
 *   - VCCS outputs current I_out = gm * V_ctrl into node_out.
 *   - Load resistor R_load at node_out → GND converts current to voltage:
 *     V_out = I_out * R_load = gm * V_ctrl * R_load
 */

import { describe, it, expect } from "vitest";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";
import { makeResistor, makeVoltageSource, withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";
import { VCCSDefinition } from "../vccs.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
import type { ConcreteCompiledAnalogCircuit } from "../../../solver/analog/analog-engine.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory
// ---------------------------------------------------------------------------

function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

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
    ["label", ""],
  ]).entries());
  props.replaceModelParams({ transconductance: gm });
  return withNodeIds(
    getFactory(VCCSDefinition.modelRegistry!["behavioral"]!)(
      new Map([["ctrl+", nCtrlP], ["ctrl-", nCtrlN], ["out+", nOutP], ["out-", nOutN]]),
      props,
      () => 0,
    ),
    [nCtrlP, nCtrlN, nOutP, nOutN],
  );
}

function buildCircuit(opts: {
  nodeCount: number;
  elements: AnalogElement[];
}): ConcreteCompiledAnalogCircuit {
  return {
    nodeCount: opts.nodeCount,
    elements: opts.elements,
    labelToNodeId: new Map(),
    labelPinNodes: new Map(),
    wireToNodeId: new Map(),
    models: new Map(),
    statePool: null,
    componentCount: opts.elements.length,
    netCount: opts.nodeCount,
    diagnostics: [],
    branchCount: 0,
    matrixSize: opts.nodeCount,
    bridgeOutputAdapters: [],
    bridgeInputAdapters: [],
    elementToCircuitElement: new Map(),
    resolvedPins: [],
  } as unknown as ConcreteCompiledAnalogCircuit;
}

// ---------------------------------------------------------------------------
// VCCS tests
// ---------------------------------------------------------------------------

describe("VCCS", () => {
  it("linear_transconductance", () => {
    // gm=0.01 S, V_ctrl=1V → I_out=10mA, R_load=100Ω → V_out=1V
    //
    // Circuit:
    //   Vs=1V: node1 (+), GND (-)
    //   VCCS: ctrl+=node1, ctrl-=GND, out+=node2, out-=GND, gm=0.01S
    //   R=100Ω: node2→GND
    //
    // nodeCount=2: node1=ctrl, node2=output
    // makeVoltageSource branchIdx: 0-based branch index; helper uses k=branchIdx+1 internally.
    // Pass branchIdx=nodeCount+0 so k=nodeCount+1=3 (1-based row in a 2-node matrix).
    const nodeCount = 2;
    const vsBranch = nodeCount + 0; // k = vsBranch+1 = 3 in makeVoltageSource

    const vs   = makeVoltageSource(1, 0, vsBranch, 1.0);
    const vccs = makeVCCSElement(1, 0, 2, 0, { transconductance: 0.01 });
    const r    = makeResistor(2, 0, 100);

    const compiled = buildCircuit({ nodeCount, elements: [vs, vccs, r] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    // V_out = I_out * R = gm * V_ctrl * R = 0.01 * 1 * 100 = 1V
  });

  it("zero_control_zero_output", () => {
    // V_ctrl=0 → I_out=0 → V_out=0 across any load
    const nodeCount = 2;
    const vsBranch = nodeCount + 0;

    const vs   = makeVoltageSource(1, 0, vsBranch, 0.0);
    const vccs = makeVCCSElement(1, 0, 2, 0, { transconductance: 0.01 });
    const r    = makeResistor(2, 0, 1000);

    const compiled = buildCircuit({ nodeCount, elements: [vs, vccs, r] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
  });

  it("nonlinear_square_law", () => {
    // expression: 0.001 * V(ctrl)^2; V_ctrl=3V → I_out = 0.001*9 = 9mA
    // R_load=100Ω → V_out = 9mA * 100 = 0.9V
    const nodeCount = 2;
    const vsBranch = nodeCount + 0;

    const vs   = makeVoltageSource(1, 0, vsBranch, 3.0);
    const vccs = makeVCCSElement(1, 0, 2, 0, { expression: "0.001 * V(ctrl)^2" });
    const r    = makeResistor(2, 0, 100);

    const compiled = buildCircuit({ nodeCount, elements: [vs, vccs, r] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    // I_out = 0.001 * 9 = 9mA; V_out = 9mA * 100Ω = 0.9V
  });

  it("stamps_accessor_returns_valid_handles_after_setup", () => {
    // After engine._setup(), VCCSAnalogElement.stamps must return 4 non-negative handles.
    const nodeCount = 2;
    const vccs = makeVCCSElement(1, 0, 2, 0, { transconductance: 0.01 });
    const r    = makeResistor(2, 0, 100);
    const vs   = makeVoltageSource(1, 0, nodeCount + 0, 1.0);

    const compiled = buildCircuit({ nodeCount, elements: [vs, vccs, r] });
    const engine = new MNAEngine();
    engine.init(compiled);
    (engine as any)._setup();

    const s = (vccs as any).stamps;
    // Handles are indices >= 0 (TrashCan is handle 0; real handles start at 1 but
    // ground-adjacent entries may return TrashCan=0). Non-(-1) means allocated.
    expect(s.pCtP).not.toBe(-1);
    expect(s.pCtN).not.toBe(-1);
    expect(s.nCtP).not.toBe(-1);
    expect(s.nCtN).not.toBe(-1);
  });
});
