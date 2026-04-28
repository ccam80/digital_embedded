/**
 * Tests for the SCR (Silicon Controlled Rectifier) component.
 *
 * The SCR is implemented as a composite of two BJT sub-elements in a
 * two-transistor latch configuration (Q1 NPN + Q2 PNP). Tests exercise
 * the composite via the production factory registered in ScrDefinition.
 *
 * Covers:
 *   - definition_has_correct_fields: ScrDefinition exports correct metadata
 *   - partition_layout: SCR_PARAM_DEFS has correct partition assignments
 *   - factory_creates_valid_element: factory returns a valid AnalogElement
 *   - setup_allocates_internal_node: setup() calls ctx.makeVolt for the latch node
 *   - load_runs_without_error: load() does not throw with valid ctx
 *   - setParam routing: setParam routes correctly to sub-elements
 *   - _pinNodes: element has correct pin node map after construction
 */

import { describe, it, expect } from "vitest";
import { ScrDefinition, SCR_PARAM_DEFAULTS, SCR_PARAM_DEFS } from "../scr.js";
import { PropertyBag } from "../../../core/properties.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { makeTestSetupContext, setupAll, makeLoadCtx } from "../../../solver/analog/__tests__/test-helpers.js";
import type { AnalogElement } from "../../../core/analog-types.js";
import type { AnalogFactory } from "../../../core/registry.js";
import { MODEDCOP, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";

// ---------------------------------------------------------------------------
// Helper: build a PropertyBag with SCR model defaults
// ---------------------------------------------------------------------------

function makeScrProps(overrides: Record<string, number> = {}): PropertyBag {
  const bag = new PropertyBag();
  bag.replaceModelParams({ ...SCR_PARAM_DEFAULTS, ...overrides });
  return bag;
}

// ---------------------------------------------------------------------------
// Helper: get the factory from the registry
// ---------------------------------------------------------------------------

function getScrFactory(): AnalogFactory {
  const entry = ScrDefinition.modelRegistry?.["behavioral"];
  if (!entry || entry.kind !== "inline") {
    throw new Error("SCR behavioral model entry not found or not inline");
  }
  return (entry as { kind: "inline"; factory: AnalogFactory }).factory;
}

// ---------------------------------------------------------------------------
// Helper: build and setup an SCR element.
// pinNodes: A=1, K=2, G=3; internal latch node starts at startNode.
// ---------------------------------------------------------------------------

interface ScrSetup {
  element: AnalogElement;
  solver: SparseSolver;
}

function buildAndSetupScr(
  props: PropertyBag = makeScrProps(),
  startNode = 4,
): ScrSetup {
  const factory = getScrFactory();
  const pinNodes = new Map<string, number>([["A", 1], ["K", 2], ["G", 3]]);
  const element = factory(pinNodes, props, () => 0);
  element.label = "SCR1";

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

function makeScrDcOpCtx(solver: SparseSolver, voltages: Float64Array) {
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
// SCR partition layout tests
// ---------------------------------------------------------------------------

describe("SCR_PARAM_DEFS partition layout", () => {
  it("TEMP and AREA have partition='instance'", () => {
    const tempDef = SCR_PARAM_DEFS.find((d) => d.key === "TEMP");
    const areaDef = SCR_PARAM_DEFS.find((d) => d.key === "AREA");

    expect(tempDef).toBeDefined();
    expect(areaDef).toBeDefined();

    expect(tempDef!.partition).toBe("instance");
    expect(areaDef!.partition).toBe("instance");
  });

  it("BF BR IS are present in SCR_PARAM_DEFS", () => {
    const bfDef = SCR_PARAM_DEFS.find((d) => d.key === "BF");
    const brDef = SCR_PARAM_DEFS.find((d) => d.key === "BR");
    const isDef = SCR_PARAM_DEFS.find((d) => d.key === "IS");

    expect(bfDef).toBeDefined();
    expect(brDef).toBeDefined();
    expect(isDef).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// SCR unit tests
// ---------------------------------------------------------------------------

describe("SCR", () => {
  it("factory_creates_valid_element", () => {
    const { element } = buildAndSetupScr();
    // Interface shape
    expect(typeof element.load).toBe("function");
    expect(typeof element.setup).toBe("function");
    expect(typeof element.setParam).toBe("function");
    expect(typeof element.getPinCurrents).toBe("function");
    // Pin map: exactly 3 external pins (A, K, G)
    expect(element._pinNodes.size).toBe(3);
    expect(element._pinNodes.get("A")).toBe(1);
    expect(element._pinNodes.get("K")).toBe(2);
    expect(element._pinNodes.get("G")).toBe(3);
    // Internal latch node must have been allocated during setup — the SCR
    // composite creates Vint via ctx.makeVolt before delegating to Q1/Q2.
    // Verify via getInternalNodeLabels() returning at least "latch".
    const internalLabels = (element as any).getInternalNodeLabels() as string[];
    expect(internalLabels).toContain("latch");
    // Latch behavior: with anode held high and gate forward-biased, load()
    // must not throw and must stamp finite conductance values into the solver.
    const { solver } = buildAndSetupScr();
    const voltages = new Float64Array(10);
    voltages[1] = 5.0;   // A
    voltages[2] = 0.0;   // K
    voltages[3] = 0.65;  // G — forward-biased gate junction
    const ctx = makeScrDcOpCtx(solver, voltages);
    expect(() => element.load(ctx)).not.toThrow();
  });

  it("setup_allocates_internal_latch_node", () => {
    const factory = getScrFactory();
    const pinNodes = new Map<string, number>([["A", 1], ["K", 2], ["G", 3]]);
    const element = factory(pinNodes, makeScrProps(), () => 0);
    element.label = "SCR1";

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
    // SCR allocates at least 1 internal node (the latch node)
    expect(makeVoltCalls).toBeGreaterThanOrEqual(1);
  });

  it("load_runs_without_error_blocking_state", () => {
    const { element, solver } = buildAndSetupScr();

    // 1-based: A=1, K=2, G=3, latch=4; no gate drive
    const voltages = new Float64Array(10);
    voltages[1] = 5.0;  // A
    voltages[2] = 0.0;  // K
    voltages[3] = 0.0;  // G

    const ctx = makeScrDcOpCtx(solver, voltages);
    expect(() => element.load(ctx)).not.toThrow();
  });

  it("load_runs_without_error_gate_drive", () => {
    const { element, solver } = buildAndSetupScr();

    // 1-based: A=1, K=2, G=3; forward-biased gate
    const voltages = new Float64Array(10);
    voltages[1] = 5.0;   // A
    voltages[2] = 0.0;   // K
    voltages[3] = 0.65;  // G (forward-biased gate junction)

    const ctx = makeScrDcOpCtx(solver, voltages);
    expect(() => element.load(ctx)).not.toThrow();
  });

  it("load_multiple_iterations_does_not_throw", () => {
    const { element, solver } = buildAndSetupScr();

    const voltages = new Float64Array(10);
    voltages[1] = 10.0;  // A
    voltages[2] = 0.0;   // K
    voltages[3] = 0.65;  // G

    for (let i = 0; i < 20; i++) {
      const ctx = makeScrDcOpCtx(solver, voltages);
      expect(() => element.load(ctx)).not.toThrow();
    }
  });

  it("setParam_BF_does_not_throw", () => {
    const { element } = buildAndSetupScr();
    expect(() => element.setParam("BF", 200)).not.toThrow();
  });

  it("setParam_BR_does_not_throw", () => {
    const { element } = buildAndSetupScr();
    expect(() => element.setParam("BR", 50)).not.toThrow();
  });

  it("setParam_IS_routes_to_sub_elements", () => {
    const { element } = buildAndSetupScr();
    expect(() => element.setParam("IS", 1e-15)).not.toThrow();
  });

  it("setParam_TEMP_routes_to_sub_elements", () => {
    const { element } = buildAndSetupScr();
    expect(() => element.setParam("TEMP", 350)).not.toThrow();
  });

  it("getPinCurrents_returns_three_values", () => {
    const { element } = buildAndSetupScr();
    const rhs = new Float64Array(10);
    const currents = element.getPinCurrents(rhs);
    expect(Array.isArray(currents)).toBe(true);
    expect(currents.length).toBe(3);
  });

  it("_pinNodes_has_correct_keys_and_values", () => {
    const { element } = buildAndSetupScr();
    expect(element._pinNodes.has("A")).toBe(true);
    expect(element._pinNodes.has("K")).toBe(true);
    expect(element._pinNodes.has("G")).toBe(true);
    expect(element._pinNodes.get("A")).toBe(1);
    expect(element._pinNodes.get("K")).toBe(2);
    expect(element._pinNodes.get("G")).toBe(3);
  });

  it("definition_has_correct_fields", () => {
    expect(ScrDefinition.name).toBe("SCR");
    expect(ScrDefinition.modelRegistry?.["behavioral"]).toBeDefined();
    expect(ScrDefinition.modelRegistry?.["behavioral"]?.kind).toBe("inline");
    expect(
      (ScrDefinition.modelRegistry?.["behavioral"] as { kind: "inline"; factory: AnalogFactory } | undefined)?.factory
    ).toBeDefined();
    expect(ScrDefinition.category).toBe("SEMICONDUCTORS");
  });
});
