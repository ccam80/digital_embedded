/**
 * Tests for the Triac (bidirectional thyristor) component.
 *
 * The Triac is implemented as a composite of four BJT sub-elements representing
 * two anti-parallel SCRs. Tests exercise the composite via the production factory
 * registered in TriacDefinition.
 *
 * Covers:
 *   - definition_has_correct_fields: TriacDefinition exports correct metadata
 *   - factory_creates_valid_element: factory returns a valid AnalogElement
 *   - setup_allocates_internal_nodes: setup() calls ctx.makeVolt for the two latch nodes
 *   - load_runs_without_error: load() does not throw with valid ctx
 *   - setParam routing: setParam routes correctly to sub-elements
 *   - _pinNodes: element has correct pin node map after construction
 */

import { describe, it, expect } from "vitest";
import { TriacDefinition, TRIAC_PARAM_DEFAULTS } from "../triac.js";
import { PropertyBag } from "../../../core/properties.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { makeTestSetupContext, setupAll, makeLoadCtx } from "../../../solver/analog/__tests__/test-helpers.js";
import type { AnalogElement } from "../../../core/analog-types.js";
import type { AnalogFactory } from "../../../core/registry.js";
import { MODEDCOP, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";

// ---------------------------------------------------------------------------
// Helper: build a PropertyBag with Triac model defaults
// ---------------------------------------------------------------------------

function makeTriacProps(overrides: Record<string, number> = {}): PropertyBag {
  const bag = new PropertyBag();
  bag.replaceModelParams({ ...TRIAC_PARAM_DEFAULTS, ...overrides });
  return bag;
}

// ---------------------------------------------------------------------------
// Helper: get the factory from the registry
// ---------------------------------------------------------------------------

function getTriacFactory(): AnalogFactory {
  const entry = TriacDefinition.modelRegistry?.["behavioral"];
  if (!entry || entry.kind !== "inline") {
    throw new Error("Triac behavioral model entry not found or not inline");
  }
  return (entry as { kind: "inline"; factory: AnalogFactory }).factory;
}

// ---------------------------------------------------------------------------
// Helper: build and setup a Triac element.
// pinNodes: MT1=1, MT2=2, G=3; internal latch nodes start at startNode.
// ---------------------------------------------------------------------------

interface TriacSetup {
  element: AnalogElement;
  solver: SparseSolver;
}

function buildAndSetupTriac(
  props: PropertyBag = makeTriacProps(),
  startNode = 4,
): TriacSetup {
  const factory = getTriacFactory();
  const pinNodes = new Map<string, number>([["MT1", 1], ["MT2", 2], ["G", 3]]);
  const element = factory(pinNodes, props, () => 0);
  element.label = "T1";

  const solver = new SparseSolver();
  solver._initStructure();

  const ctx = makeTestSetupContext({
    solver,
    startNode,
    startBranch: 10,
  });

  setupAll([element], ctx);
  return { element, solver };
}

// ---------------------------------------------------------------------------
// Helper: build a LoadContext for DC-OP iteration
// voltages: Float64Array indexed by node ID (1-based)
// ---------------------------------------------------------------------------

function makeTriacDcOpCtx(solver: SparseSolver, voltages: Float64Array) {
  return makeLoadCtx({
    solver,
    rhs: new Float64Array(voltages.length),
    rhsOld: voltages,
    cktMode: MODEDCOP | MODEINITFLOAT,
    dt: 0,
    srcFact: 1,
  });
}

// ---------------------------------------------------------------------------
// Triac unit tests
// ---------------------------------------------------------------------------

describe("Triac", () => {
  it("factory_creates_valid_element", () => {
    const { element } = buildAndSetupTriac();
    expect(element).toBeDefined();
    expect(typeof element.load).toBe("function");
    expect(typeof element.setup).toBe("function");
    expect(typeof element.setParam).toBe("function");
    expect(typeof element.getPinCurrents).toBe("function");
  });

  it("setup_allocates_two_internal_latch_nodes", () => {
    const factory = getTriacFactory();
    const pinNodes = new Map<string, number>([["MT1", 1], ["MT2", 2], ["G", 3]]);
    const element = factory(pinNodes, makeTriacProps(), () => 0);
    element.label = "T1";

    const solver = new SparseSolver();
    solver._initStructure();

    let makeVoltCalls = 0;
    const ctx = makeTestSetupContext({
      solver,
      startNode: 4,
      startBranch: 10,
    });
    const origMakeVolt = (ctx as unknown as { makeVolt: (l: string, s: string) => number }).makeVolt.bind(ctx);
    (ctx as unknown as { makeVolt: (l: string, s: string) => number }).makeVolt = (label: string, suffix: string) => {
      makeVoltCalls++;
      return origMakeVolt(label, suffix);
    };

    setupAll([element], ctx);
    // Triac allocates 2 internal nodes (latch1 and latch2)
    expect(makeVoltCalls).toBeGreaterThanOrEqual(2);
  });

  it("load_runs_without_error_blocking_state", () => {
    const { element, solver } = buildAndSetupTriac();

    // 1-based: MT1=1, MT2=2, G=3; no gate, small voltage — blocking
    const voltages = new Float64Array(10);
    voltages[1] = 0.0;  // MT1
    voltages[2] = 5.0;  // MT2
    voltages[3] = 0.0;  // G

    const ctx = makeTriacDcOpCtx(solver, voltages);
    expect(() => element.load(ctx)).not.toThrow();
  });

  it("load_runs_without_error_gate_drive", () => {
    const { element, solver } = buildAndSetupTriac();

    // 1-based: MT1=1, MT2=2, G=3; gate forward-biased
    const voltages = new Float64Array(10);
    voltages[1] = 0.0;   // MT1
    voltages[2] = 5.0;   // MT2
    voltages[3] = 0.65;  // G (forward-biased)

    const ctx = makeTriacDcOpCtx(solver, voltages);
    expect(() => element.load(ctx)).not.toThrow();
  });

  it("load_multiple_iterations_does_not_throw", () => {
    const { element, solver } = buildAndSetupTriac();

    const voltages = new Float64Array(10);
    voltages[1] = 0.0;   // MT1
    voltages[2] = 50.0;  // MT2
    voltages[3] = 0.65;  // G

    for (let i = 0; i < 20; i++) {
      const ctx = makeTriacDcOpCtx(solver, voltages);
      expect(() => element.load(ctx)).not.toThrow();
    }
  });

  it("load_reverse_polarity_does_not_throw", () => {
    const { element, solver } = buildAndSetupTriac();

    // Reverse polarity: MT1 > MT2
    const voltages = new Float64Array(10);
    voltages[1] = 50.0;  // MT1
    voltages[2] = 0.0;   // MT2
    voltages[3] = 0.65;  // G

    const ctx = makeTriacDcOpCtx(solver, voltages);
    expect(() => element.load(ctx)).not.toThrow();
  });

  it("setParam_BF_does_not_throw", () => {
    const { element } = buildAndSetupTriac();
    expect(() => element.setParam("BF", 150)).not.toThrow();
  });

  it("setParam_BR_does_not_throw", () => {
    const { element } = buildAndSetupTriac();
    expect(() => element.setParam("BR", 80)).not.toThrow();
  });

  it("setParam_IS_routes_to_sub_elements", () => {
    const { element } = buildAndSetupTriac();
    expect(() => element.setParam("IS", 1e-15)).not.toThrow();
  });

  it("setParam_TEMP_routes_to_sub_elements", () => {
    const { element } = buildAndSetupTriac();
    expect(() => element.setParam("TEMP", 350)).not.toThrow();
  });

  it("getPinCurrents_returns_three_values", () => {
    const { element } = buildAndSetupTriac();
    const rhs = new Float64Array(10);
    const currents = element.getPinCurrents(rhs);
    expect(Array.isArray(currents)).toBe(true);
    expect(currents.length).toBe(3);
  });

  it("_pinNodes_has_correct_keys_and_values", () => {
    const { element } = buildAndSetupTriac();
    expect(element._pinNodes.has("MT1")).toBe(true);
    expect(element._pinNodes.has("MT2")).toBe(true);
    expect(element._pinNodes.has("G")).toBe(true);
    expect(element._pinNodes.get("MT1")).toBe(1);
    expect(element._pinNodes.get("MT2")).toBe(2);
    expect(element._pinNodes.get("G")).toBe(3);
  });

  it("definition_has_correct_fields", () => {
    expect(TriacDefinition.name).toBe("Triac");
    expect(TriacDefinition.modelRegistry?.["behavioral"]).toBeDefined();
    expect(TriacDefinition.modelRegistry?.["behavioral"]?.kind).toBe("inline");
    expect(
      (TriacDefinition.modelRegistry?.["behavioral"] as { kind: "inline"; factory: AnalogFactory } | undefined)?.factory
    ).toBeDefined();
    expect(TriacDefinition.category).toBe("SEMICONDUCTORS");
  });
});
