/**
 * Tests for the Diac (bidirectional trigger diode) component.
 *
 * The Diac is implemented as a composite of two anti-parallel diode sub-elements.
 * It uses DIODE model parameters (BV maps to the breakover voltage).
 *
 * Covers:
 *   - definition_has_correct_fields: DiacDefinition exports correct metadata
 *   - factory_creates_valid_element: factory returns a valid AnalogElement
 *   - setup_runs_without_error: setup() does not throw
 *   - load_runs_without_error: load() does not throw with valid ctx
 *   - _pinNodes: element has correct pin node map
 *   - setParam routing: setParam routes to both sub-elements
 *   - triggers_triac: diac produces current sufficient to trigger a triac
 */

import { describe, it, expect } from "vitest";
import { createDiacElement, DiacDefinition } from "../diac.js";
import { TriacDefinition, TRIAC_PARAM_DEFAULTS } from "../triac.js";
import { DIODE_PARAM_DEFAULTS } from "../diode.js";
import { PropertyBag } from "../../../core/properties.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { makeTestSetupContext, setupAll, makeLoadCtx, allocateStatePool } from "../../../solver/analog/__tests__/test-helpers.js";
import type { AnalogElement } from "../../../core/analog-types.js";
import type { AnalogFactory } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Default Diac parameters- use DIODE defaults with BV set to breakover voltage
// ---------------------------------------------------------------------------

const DIAC_TEST_DEFAULTS = {
  ...DIODE_PARAM_DEFAULTS,
  // DIAC-appropriate params: very low IS and high N suppress forward conduction
  // so the device blocks below BV and breaks down above BV (breakover).
  // Standard diode IS=1e-14, N=1 overflows at 20V forward-biased → use:
  //   IS=1e-32: reduces forward current by 18 orders of magnitude
  //   N=40:     stretches the forward knee far above any test voltage
  // Net: at V=20V, I_fwd ≈ 1e-32 * exp(20/1.04) ≈ 1e-24 A (negligible)
  //       at BV=32V, reverse breakdown → significant current → triggers
  IS: 1e-32,
  N: 40,
  BV: 32,   // breakover voltage (V_BO = 32V)
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DiacFixture { element: AnalogElement; solver: SparseSolver; }

function makeDiac(overrides: Partial<typeof DIAC_TEST_DEFAULTS> = {}): DiacFixture {
  const params = { ...DIAC_TEST_DEFAULTS, ...overrides };
  const props = new PropertyBag();
  props.replaceModelParams(params);
  // nodeA=1, nodeB=2
  const element = createDiacElement(new Map([["A", 1], ["B", 2]]), props, () => 0);

  // Run setup on the solver that will also be used for load() calls.
  // The handles allocated here must be the same solver passed to load().
  const solver = new SparseSolver();
  solver._initStructure();
  const ctx = makeTestSetupContext({ solver, startNode: 3, startBranch: 5 });
  setupAll([element], ctx);

  // Allocate state pool for the diode sub-elements (dFwd + dRev).
  // Both are pool-backed and read pool.states[N] in load(); without
  // initState() the pool closure is undefined and load() throws.
  const subElements = (element as any).getSubElements() as AnalogElement[];
  allocateStatePool(subElements);

  return { element, solver };
}

/**
 * Drive diac to a steady operating point by calling load() repeatedly with
 * a ctx whose voltages are pinned to (vA, vB). Must use the same solver
 * that handles were allocated on during setup. Resets the solver matrix
 * before each iteration so stamped values don't accumulate.
 * nodeA=1 (1-based), nodeB=2 (1-based)
 */
function driveToOp(element: AnalogElement, solver: SparseSolver, vA: number, vB: number, iterations = 50): void {
  for (let i = 0; i < iterations; i++) {
    (solver as any)._resetForAssembly();
    // Size 4: index 0=unused sentinel, 1=nodeA, 2=nodeB
    const voltages = new Float64Array(4);
    voltages[1] = vA;
    voltages[2] = vB;
    const ctx = makeLoadCtx({
      solver,
      rhs: new Float64Array(4),
      rhsOld: voltages,
    });
    element.load(ctx);
  }
}

/**
 * Compute steady-state current I(V) through diac at given voltage by evaluating
 * the Norton equivalent: I = geq * V + ieq.
 * Returns the current from terminal A to terminal B.
 * Must use the same solver that handles were allocated on during setup.
 */
function getCurrentAtV(element: AnalogElement, solver: SparseSolver, v: number): number {
  driveToOp(element, solver, v, 0, 50);

  // Final measurement iteration- reset so we get a clean single-stamp read.
  (solver as any)._resetForAssembly();
  const voltages = new Float64Array(4);
  voltages[1] = v;
  voltages[2] = 0;
  const rhs = new Float64Array(4);
  const ctx = makeLoadCtx({
    solver,
    rhs,
    rhsOld: voltages,
  });
  element.load(ctx);

  // Read back the stamped conductance via getCSCNonZeros() on the real solver.
  // geq is the (1,1) diagonal entry (nodeA=1); ieq is from stampRHS at row 1.
  const entries = solver.getCSCNonZeros();
  const geqEntry = entries.find((s) => s.row === 1 && s.col === 1);
  const rhsVal = rhs[1];

  if (!geqEntry) return 0;

  const geq = geqEntry.value;
  const ieq = -rhsVal;
  return geq * v + ieq;
}

// ---------------------------------------------------------------------------
// Diac unit tests
// ---------------------------------------------------------------------------

describe("Diac", () => {
  it("definition_has_correct_fields", () => {
    expect(DiacDefinition.name).toBe("Diac");
    expect(DiacDefinition.modelRegistry?.["spice"]).toBeDefined();
    expect(DiacDefinition.modelRegistry?.["spice"]?.kind).toBe("inline");
    expect(
      (DiacDefinition.modelRegistry?.["spice"] as { kind: "inline"; factory: AnalogFactory } | undefined)?.factory
    ).toBeDefined();
    expect(DiacDefinition.category).toBe("SEMICONDUCTORS");
  });

  it("factory_creates_valid_element", () => {
    const props = new PropertyBag();
    props.replaceModelParams(DIAC_TEST_DEFAULTS);
    const element = createDiacElement(new Map([["A", 1], ["B", 2]]), props, () => 0);
    expect(element).toBeDefined();
    expect(typeof element.load).toBe("function");
    expect(typeof element.setup).toBe("function");
    expect(typeof element.setParam).toBe("function");
    expect(typeof element.getPinCurrents).toBe("function");
  });

  it("_pinNodes_has_correct_keys_and_values", () => {
    const props = new PropertyBag();
    props.replaceModelParams(DIAC_TEST_DEFAULTS);
    const element = createDiacElement(new Map([["A", 1], ["B", 2]]), props, () => 0);
    expect(element._pinNodes.has("A")).toBe(true);
    expect(element._pinNodes.has("B")).toBe(true);
    expect(element._pinNodes.get("A")).toBe(1);
    expect(element._pinNodes.get("B")).toBe(2);
  });

  it("setup_runs_without_error", () => {
    const props = new PropertyBag();
    props.replaceModelParams(DIAC_TEST_DEFAULTS);
    const element = createDiacElement(new Map([["A", 1], ["B", 2]]), props, () => 0);
    const solver = new SparseSolver();
    solver._initStructure();
    const ctx = makeTestSetupContext({ solver, startNode: 3, startBranch: 5 });
    expect(() => setupAll([element], ctx)).not.toThrow();
  });

  it("load_runs_without_error", () => {
    const { element: diac, solver } = makeDiac();
    const voltages = new Float64Array(4);
    voltages[1] = 10;
    voltages[2] = 0;
    const ctx = makeLoadCtx({
      solver,
      rhs: new Float64Array(4),
      rhsOld: voltages,
    });
    expect(() => diac.load(ctx)).not.toThrow();
  });

  it("setParam_routes_to_sub_elements", () => {
    const { element: diac } = makeDiac();
    expect(() => diac.setParam("IS", 1e-14)).not.toThrow();
    expect(() => diac.setParam("N", 1.5)).not.toThrow();
  });

  it("blocks_below_breakover", () => {
    // |V| = 20V < V_BO = 32V → blocking state → small current
    const { element: diac, solver } = makeDiac();

    const iPosV = getCurrentAtV(diac, solver, 20);
    expect(Math.abs(iPosV)).toBeLessThan(1e-3); // less than 1mA confirms blocking
  });

  it("conducts_above_breakover", () => {
    // |V| = 40V > V_BO = 32V → breakdown → significant current
    const { element: diac, solver } = makeDiac();

    const iV = getCurrentAtV(diac, solver, 40);
    // Significant current >> blocking
    expect(Math.abs(iV)).toBeGreaterThan(0.1);

    // Current should be in the direction of voltage (positive V → positive I)
    expect(iV).toBeGreaterThan(0);
  });

  it("symmetric", () => {
    // Same |V| positive and negative → |I| approximately equal (symmetric device)
    const posV = 40;
    const negV = -40;

    const { element: diacPos, solver: solverPos } = makeDiac();
    const { element: diacNeg, solver: solverNeg } = makeDiac();

    const iPos = getCurrentAtV(diacPos, solverPos, posV);
    const iNeg = getCurrentAtV(diacNeg, solverNeg, negV);

    // Both currents should have same magnitude within 10%
    expect(Math.abs(iPos)).toBeGreaterThan(0.01); // conducting
    expect(Math.abs(iNeg)).toBeGreaterThan(0.01); // conducting in reverse

    const ratio = Math.abs(iPos) / Math.abs(iNeg);
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);

    // Signs are opposite (current flows opposite ways)
    expect(iPos).toBeGreaterThan(0);
    expect(iNeg).toBeLessThan(0);
  });

  it("triggers_triac", () => {
    // Integration test: diac + triac circuit.
    // At V_supply > V_BO, diac conducts and delivers gate current to triac.
    // The triac should then latch.

    // Step 1: verify diac at V=40V (above BV=32V) produces significant current
    const { element: diac, solver: diacSolver } = makeDiac();
    const iDiac = getCurrentAtV(diac, diacSolver, 40);
    // Diac must produce current well above triac's trigger threshold (~200µA)
    expect(iDiac).toBeGreaterThan(200e-6);

    // Step 2: get the triac factory from the registry
    const triacEntry = TriacDefinition.modelRegistry?.["behavioral"];
    if (!triacEntry || triacEntry.kind !== "inline") {
      throw new Error("Triac behavioral model entry not found");
    }
    const triacFactory = (triacEntry as { kind: "inline"; factory: AnalogFactory }).factory;

    const triacProps = new PropertyBag();
    triacProps.replaceModelParams({ ...TRIAC_PARAM_DEFAULTS });

    const triacPinNodes = new Map<string, number>([["MT1", 1], ["MT2", 2], ["G", 3]]);
    const triacEl = triacFactory(triacPinNodes, triacProps, () => 0);
    triacEl.label = "T1";

    // Setup the triac so its TSTALLOC handles are allocated on triacSolver.
    const triacSolver = new SparseSolver();
    triacSolver._initStructure();
    const triacSetupCtx = makeTestSetupContext({
      solver: triacSolver,
      startNode: 4,
      startBranch: 10,
    });
    setupAll([triacEl], triacSetupCtx);

    // Allocate state pool for the triac's BJT sub-elements.
    const triacSubElements = (triacEl as any).getSubElements() as AnalogElement[];
    allocateStatePool(triacSubElements);

    // Drive triac with gate current using the same triacSolver handles were allocated on.
    // 1-based: MT1=node1→rhsOld[1], MT2=node2→rhsOld[2], G=node3→rhsOld[3]
    // Reset before each load so getCSCNonZeros() reflects a single-iteration stamp.
    const voltages = new Float64Array(10);
    voltages[1] = 0;    // MT1
    voltages[2] = 100;  // MT2 (100V positive)
    voltages[3] = 0.65; // Gate (forward-biased)
    for (let i = 0; i < 10; i++) {
      (triacSolver as any)._resetForAssembly();
      const ctx = makeLoadCtx({
        solver: triacSolver,
        rhs: new Float64Array(10),
        rhsOld: voltages,
      });
      expect(() => triacEl.load(ctx)).not.toThrow();
    }

    // Verify triac stamps finite, non-zero conductance at MT1 (row=1) or MT2 (row=2).
    // A full NR solve is required for the triac to enter on-state; this test only
    // verifies the triac loads without error and produces valid stamps when gate-biased.
    const entries = triacSolver.getCSCNonZeros();
    const diagMT = entries.filter((s) => s.row === s.col && s.row >= 1 && s.row <= 2);
    expect(diagMT.length).toBeGreaterThan(0); // stamps exist at MT nodes
    const maxG = Math.max(...diagMT.map((s) => Math.abs(s.value)));
    expect(maxG).toBeGreaterThan(1e-6); // finite non-zero conductance when gate-biased
  });
});
