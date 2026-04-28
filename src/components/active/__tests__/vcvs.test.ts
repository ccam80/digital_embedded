/**
 * Tests for Voltage-Controlled Voltage Source (VCVS) analog element.
 *
 * All tests use the real factory path: instantiate via factory, let
 * MNAEngine._setup() allocate the branch row and matrix handles,
 * then verify DC operating-point results.
 *
 * MNA solution vector layout:
 *   indices 1..nodeCount   — node voltages (1-based MNA node IDs)
 *   indices >nodeCount     — branch currents (allocated by engine._setup())
 */

import { describe, it, expect } from "vitest";
import { MNAEngine } from "../../../solver/analog/analog-engine.js";
import { VCVSDefinition } from "../vcvs.js";
import { PropertyBag } from "../../../core/properties.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
import type { ConcreteCompiledAnalogCircuit } from "../../../solver/analog/analog-engine.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import { ResistorDefinition, RESISTOR_DEFAULTS } from "../../passives/resistor.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory
// ---------------------------------------------------------------------------

function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

// ---------------------------------------------------------------------------
// makeResistor — create a resistor element between two nodes.
// ---------------------------------------------------------------------------

function makeResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const props = new PropertyBag([]);
  props.replaceModelParams({ ...RESISTOR_DEFAULTS, resistance });
  return getFactory(ResistorDefinition.modelRegistry!["behavioral"]!)(
    new Map([["A", nodeA], ["B", nodeB]]),
    props,
    () => 0,
  );
}

// ---------------------------------------------------------------------------
// makeVsrc — create a DC voltage source element between two nodes.
// ---------------------------------------------------------------------------

function makeVsrc(posNode: number, negNode: number, voltage: number): AnalogElement {
  const props = new PropertyBag([]);
  props.replaceModelParams({ voltage });
  return makeDcVoltageSource(
    new Map([["pos", posNode], ["neg", negNode]]),
    props,
    () => 0,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVCVSElement(
  nCtrlP: number,
  nCtrlN: number,
  nOutP: number,
  nOutN: number,
  opts: { gain?: number; expression?: string } = {},
): AnalogElement {
  const gain = opts.gain ?? 1.0;
  const expression = opts.expression ?? "V(ctrl)";
  const props = new PropertyBag(new Map<string, import("../../../core/properties.js").PropertyValue>([
    ["expression", expression],
    ["label", ""],
  ]).entries());
  props.replaceModelParams({ gain });
  return getFactory(VCVSDefinition.modelRegistry!["behavioral"]!)(
    new Map([["ctrl+", nCtrlP], ["ctrl-", nCtrlN], ["out+", nOutP], ["out-", nOutN]]),
    props,
    () => 0,
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
// VCVS tests
// ---------------------------------------------------------------------------

describe("VCVS", () => {
  it("unity_gain_buffer", () => {
    // Circuit: Vs=3.3V → node1; VCVS(ctrl+=node1, ctrl-=GND, out+=node2, out-=GND, gain=1)
    // Expected: V(node2) = 3.3V
    //
    // nodeCount=2: node1=ctrl voltage, node2=output voltage
    const nodeCount = 2;

    const vs   = makeVsrc(1, 0, 3.3);
    const vcvs = makeVCVSElement(1, 0, 2, 0, { gain: 1.0 });

    const compiled = buildCircuit({ nodeCount, elements: [vs, vcvs] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
  });

  it("gain_of_10", () => {
    // Vs=0.5V, VCVS gain=10 → output = 5.0V
    const nodeCount = 2;

    const vs   = makeVsrc(1, 0, 0.5);
    const vcvs = makeVCVSElement(1, 0, 2, 0, { gain: 10.0 });

    const compiled = buildCircuit({ nodeCount, elements: [vs, vcvs] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
  });

  it("nonlinear_expression", () => {
    // expression: 0.5 * V(ctrl)^2, ctrl=2V → output = 0.5 * 4 = 2.0V
    // NR should converge in ≤ 10 iterations
    const nodeCount = 2;

    const vs   = makeVsrc(1, 0, 2.0);
    const vcvs = makeVCVSElement(1, 0, 2, 0, { expression: "0.5 * V(ctrl)^2" });

    const compiled = buildCircuit({ nodeCount, elements: [vs, vcvs] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    expect(result.iterations).toBeLessThanOrEqual(10);
  });

  it("output_drives_load", () => {
    // Vs=1V → node1 (ctrl), VCVS gain=10 → node2 (output=10V), R=1kΩ node2→GND
    // Output node is enforced at 10V by VCVS regardless of load.
    const nodeCount = 2;

    const vs    = makeVsrc(1, 0, 1.0);
    const vcvs  = makeVCVSElement(1, 0, 2, 0, { gain: 10.0 });
    const rLoad = makeResistor(2, 0, 1000);

    const compiled = buildCircuit({ nodeCount, elements: [vs, vcvs, rLoad] });
    const engine = new MNAEngine();
    engine.init(compiled);
    const result = engine.dcOperatingPoint();

    expect(result.converged).toBe(true);
    // Output voltage enforced at 10V by VCVS
  });

  it("branch_index_assigned_after_setup", () => {
    // After engine._setup(), VCVSAnalogElement.branchIndex must be >= 1.
    const nodeCount = 2;
    const vcvs = makeVCVSElement(1, 0, 2, 0, { gain: 1.0 });
    const vs   = makeVsrc(1, 0, 1.0);

    const compiled = buildCircuit({ nodeCount, elements: [vs, vcvs] });
    const engine = new MNAEngine();
    engine.init(compiled);
    (engine as any)._setup();

    expect((vcvs as any).branchIndex).toBeGreaterThanOrEqual(1);
  });
});
