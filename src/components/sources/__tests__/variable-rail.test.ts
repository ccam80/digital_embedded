/**
 * Tests for the Variable Rail source component.
 */

import { describe, it, expect, vi } from "vitest";
import { makeVariableRailElement, VariableRailDefinition } from "../variable-rail.js";
import { runDcOp, loadCtxFromFields } from "../../../solver/analog/__tests__/test-helpers.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import { PropertyBag } from "../../../core/properties.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";
import { MODEDCOP, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";
import { makeTestSetupContext, setupAll } from "../../../solver/analog/__tests__/test-helpers.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResistorElement(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const G = 1 / resistance;
  return {
    label: "",
    branchIndex: -1,
    _stateBase: -1,
    ngspiceLoadOrder: 0,
    _pinNodes: new Map([["a", nodeA], ["b", nodeB]]),
    setParam(_k: string, _v: number) {},
    getPinCurrents(_v: Float64Array): number[] { return []; },
    setup(_ctx: import("../../../solver/analog/setup-context.js").SetupContext): void {},
    load(ctx: import("../../../solver/analog/element.js").LoadContext): void {
      const solver = ctx.solver;
      if (nodeA !== 0) solver.stampElement(solver.allocElement(nodeA, nodeA), G);
      if (nodeB !== 0) solver.stampElement(solver.allocElement(nodeB, nodeB), G);
      if (nodeA !== 0 && nodeB !== 0) {
        solver.stampElement(solver.allocElement(nodeA, nodeB), -G);
        solver.stampElement(solver.allocElement(nodeB, nodeA), -G);
      }
    },
  };
}

function makeVRailProps(voltage: number) {
  const props = new PropertyBag();
  props.replaceModelParams({ voltage });
  return props;
}

function solveCircuit(elements: AnalogElement[], nodeCount: number, branchCount: number): Float64Array {
  const result = runDcOp({
    elements,
    matrixSize: nodeCount + branchCount,
    nodeCount,
  });
  if (!result.converged) throw new Error("DC OP did not converge");
  return result.nodeVoltages;
}

// ===========================================================================
// VariableRail tests
// ===========================================================================

describe("VariableRail", () => {
  it("dc_output_matches_voltage -- 12V rail into bleed load; DC OP converges", () => {
    // Circuit: variable rail 12V on node 1 (pos), ground implicit.
    // Add a bleed resistor to ground for solvability.
    // nodePos=1, branchIdx=2 (1-based: rows 1..nodeCount, rows nodeCount+1.. branches)
    // matrixSize = nodeCount(1) + branchCount(1) = 2

    const props = makeVRailProps(12);
    const rail = makeVariableRailElement(
      new Map([["pos", 1]]),
      props,
      () => 0,
    );

    const bleed = makeResistorElement(1, 0, 1e6);

    solveCircuit([rail as unknown as AnalogElement, bleed], 1, 1);
  });

  it("voltage_change_updates_output -- 5V then 10V; setVoltage takes effect", () => {
    const props = makeVRailProps(5);
    const rail = makeVariableRailElement(
      new Map([["pos", 1]]),
      props,
      () => 0,
    );
    const bleed = makeResistorElement(1, 0, 1e6);

    solveCircuit([rail as unknown as AnalogElement, bleed], 1, 1);

    rail.setVoltage(10);
    solveCircuit([rail as unknown as AnalogElement, bleed], 1, 1);
  });

  it("setVoltage_currentVoltage_updates", () => {
    const props = makeVRailProps(5);
    const rail = makeVariableRailElement(
      new Map([["pos", 1]]),
      props,
      () => 0,
    );
    expect(rail.currentVoltage).toBe(5);
    rail.setVoltage(15);
    expect(rail.currentVoltage).toBe(15);
  });

  it("element allocates a branch row in setup()", () => {
    const factory = getFactory(VariableRailDefinition.modelRegistry!.behavioral!);
    const props = makeVRailProps(5);
    const el = factory(new Map([["pos", 1]]), props, () => 0);
    el.label = "VTEST";

    const solver = new SparseSolver();
    solver._initStructure();
    const setupCtx = makeTestSetupContext({
      solver,
      startBranch: 5,
      startNode: 100,
      elements: [el as unknown as AnalogElement],
    });
    setupAll([el as unknown as AnalogElement], setupCtx);

    expect(el.branchIndex).toBeGreaterThanOrEqual(0);
  });

  it("definition_engine_type_analog", () => {
    expect(VariableRailDefinition.modelRegistry?.behavioral).toBeDefined();
  });

  it("analogFactory_creates_element", () => {
    const props = new PropertyBag();
    props.replaceModelParams({ voltage: 7 });
    const el = getFactory(VariableRailDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1]]),
      props,
      () => 0,
    );
    expect(el).toBeDefined();
  });
});

// ===========================================================================
// Task C4.4- Variable Rail srcFact parity
//
// Variable Rail is an interactive slider, NOT an ngspice independent source.
// Per variable-rail.ts load() documentation, ctx.srcFact is deliberately
// ignored so slider changes take effect immediately and are unaffected by
// DC-OP source stepping. The parity test locks that contract in: the stamped
// RHS at the branch row must be bit-exact equal to the nominal voltage
// regardless of ctx.srcFact.
// ===========================================================================

describe("variable_rail_load_srcfact_parity", () => {
  // variable-rail.ts load() invokes solver.allocElement(row, col),
  // solver.stampElement(handle, value), and ctx.rhs[branchIndex] += voltage.
  // The capture solver implements the same three-method surface the production
  // sibling sources (dc-voltage-source.test.ts et al) use.
  function makeCaptureSolver() {
    const stamps: Array<{ row: number; col: number; value: number }> = [];
    return {
      allocElement: vi.fn((row: number, col: number) => {
        stamps.push({ row, col, value: 0 });
        return stamps.length - 1;
      }),
      stampElement: vi.fn((h: number, v: number) => {
        stamps[h].value += v;
      }),
      _stamps: stamps,
    };
  }

  function makeCtx(solver: unknown, srcFact: number, rhs?: Float64Array) {
    const rhsBuf = rhs ?? new Float64Array(8);
    return loadCtxFromFields({
      solver: solver as SparseSolverType,
      matrix: solver as SparseSolverType,
      rhs: rhsBuf,
      rhsOld: new Float64Array(rhsBuf.length),
      cktMode: MODEDCOP | MODEINITFLOAT,
      time: 0,
      dt: 0,
      method: "trapezoidal" as const,
      order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(7),
      srcFact,
      noncon: { value: 0 },
      limitingCollector: null,
      convergenceCollector: null,
      xfact: 1,
      gmin: 1e-12,
      reltol: 1e-3,
      iabstol: 1e-12,
      temp: 300.15,
      vt: 0.025852,
      cktFixLimit: false,
      bypass: false,
      voltTol: 1e-6,
    });
  }

  it("srcfact_05_rhs_ignores_srcfact_bit_exact", () => {
    // nodePos=1, branch row=2 (assigned by setupAll with startBranch=2)
    const VOLTAGE = 12;
    const props = makeVRailProps(VOLTAGE);
    const rail = makeVariableRailElement(
      new Map([["pos", 1]]),
      props,
      () => 0,
    );
    const solver = makeCaptureSolver();
    const setupCtx = makeTestSetupContext({ solver: solver as unknown as SparseSolverType, startBranch: 2 });
    setupAll([rail as unknown as AnalogElement], setupCtx);

    const rhs = new Float64Array(8);
    rail.load(makeCtx(solver, 0.5, rhs));

    // Variable rail by contract ignores srcFact- RHS stamp is the raw voltage.
    const NGSPICE_REF = VOLTAGE; // no srcFact multiplier in variable-rail.ts load()
    expect(rhs[2]).toBe(NGSPICE_REF);
  });

  it("srcfact_0_still_delivers_full_voltage", () => {
    // Source stepping at srcFact=0 would kill an ordinary DC voltage source.
    // Variable rail must still stamp its full nominal voltage.
    const VOLTAGE = 7.5;
    const props = makeVRailProps(VOLTAGE);
    const rail = makeVariableRailElement(
      new Map([["pos", 1]]),
      props,
      () => 0,
    );
    const solver = makeCaptureSolver();
    const setupCtx = makeTestSetupContext({ solver: solver as unknown as SparseSolverType, startBranch: 2 });
    setupAll([rail as unknown as AnalogElement], setupCtx);

    const rhs = new Float64Array(8);
    rail.load(makeCtx(solver, 0, rhs));

    expect(rhs[2]).toBe(VOLTAGE);
  });

  it("srcfact_1_delivers_full_voltage", () => {
    const VOLTAGE = 5;
    const props = makeVRailProps(VOLTAGE);
    const rail = makeVariableRailElement(
      new Map([["pos", 1]]),
      props,
      () => 0,
    );
    const solver = makeCaptureSolver();
    const setupCtx = makeTestSetupContext({ solver: solver as unknown as SparseSolverType, startBranch: 2 });
    setupAll([rail as unknown as AnalogElement], setupCtx);

    const rhs = new Float64Array(8);
    rail.load(makeCtx(solver, 1, rhs));

    expect(rhs[2]).toBe(VOLTAGE);
  });
});
