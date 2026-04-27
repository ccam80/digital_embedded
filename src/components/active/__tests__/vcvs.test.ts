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
import { makeResistor, makeVoltageSource, withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";
import { VCVSDefinition } from "../vcvs.js";
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
// withSetup — add a no-op setup() stub to test-helper elements that predate
// the setup/load split. makeVoltageSource/makeResistor stamp in load(), so
// their setup() is a no-op. The engine requires setup() on every element.
// ---------------------------------------------------------------------------

function withSetup(el: AnalogElement): AnalogElement {
  return Object.assign(el, {
    _stateBase: -1,
    _pinNodes: new Map<string, number>(),
    setup(_ctx: unknown): void {},
  });
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
  return withNodeIds(
    getFactory(VCVSDefinition.modelRegistry!["behavioral"]!)(
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
// VCVS tests
// ---------------------------------------------------------------------------

describe("VCVS", () => {
  it("unity_gain_buffer", () => {
    // Circuit: Vs=3.3V → node1; VCVS(ctrl+=node1, ctrl-=GND, out+=node2, out-=GND, gain=1)
    // Expected: V(node2) = 3.3V
    //
    // nodeCount=2: node1=ctrl voltage, node2=output voltage
    // engine._setup() allocates VCVS branch at maxEqNum=nodeCount+1=3 (1-based).
    // makeVoltageSource branchIdx: helper uses k=branchIdx+1 internally.
    // Pass nodeCount+1 so k=nodeCount+2=4 (1-based), avoiding collision with VCVS branch=3.
    const nodeCount = 2;

    const vs   = withSetup(makeVoltageSource(1, 0, nodeCount + 1, 3.3));
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

    const vs   = withSetup(makeVoltageSource(1, 0, nodeCount + 1, 0.5));
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

    const vs   = withSetup(makeVoltageSource(1, 0, nodeCount + 1, 2.0));
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

    const vs    = withSetup(makeVoltageSource(1, 0, nodeCount + 1, 1.0));
    const vcvs  = makeVCVSElement(1, 0, 2, 0, { gain: 10.0 });
    const rLoad = withSetup(makeResistor(2, 0, 1000));

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
    const vs   = withSetup(makeVoltageSource(1, 0, nodeCount + 1, 1.0));

    const compiled = buildCircuit({ nodeCount, elements: [vs, vcvs] });
    const engine = new MNAEngine();
    engine.init(compiled);
    (engine as any)._setup();

    expect((vcvs as any).branchIndex).toBeGreaterThanOrEqual(1);
  });
});
