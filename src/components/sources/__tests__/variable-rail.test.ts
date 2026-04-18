/**
 * Tests for the Variable Rail source component.
 */

import { describe, it, expect, vi } from "vitest";
import { makeVariableRailElement, VariableRailDefinition } from "../variable-rail.js";
import { runDcOp } from "../../../solver/analog/__tests__/test-helpers.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import { PropertyBag } from "../../../core/properties.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";

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
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    setSourceScale: () => {},
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_v: Float64Array): number[] { return []; },
    stamp(solver: SparseSolver): void {
      if (nodeA !== 0) solver.stampElement(solver.allocElement(nodeA - 1, nodeA - 1), G);
      if (nodeB !== 0) solver.stampElement(solver.allocElement(nodeB - 1, nodeB - 1), G);
      if (nodeA !== 0 && nodeB !== 0) {
        solver.stampElement(solver.allocElement(nodeA - 1, nodeB - 1), -G);
        solver.stampElement(solver.allocElement(nodeB - 1, nodeA - 1), -G);
      }
    },
  };
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
  it("dc_output_matches_voltage — 12V rail into open circuit; output = 12V ± 0.01V", () => {
    // Circuit: variable rail 12V between node1(+) and ground(0).
    // Internal resistance modeled as nodeInt between voltage source and output terminal.
    // Node layout: node1 = pos terminal (output), nodeInt = internal junction, branchIdx=1
    // No load → open circuit. Output voltage (node1) should be ≈ 12V.
    // nodePos=2 (external positive), nodeInt=1 (internal), nodeNeg=0 (ground)
    // branchIdx=2 (absolute row in augmented MNA: rows 0..nodeCount-1 are nodes, then branches)
    // Matrix size: nodeCount=2 (nodes 1,2) + branchCount=1 (voltage source) = 3×3

    const nodeInt = 1; // internal node (after voltage source, before R_int)
    const nodeOut = 2; // output terminal (positive pin to external circuit)
    const nodeNeg = 0; // ground
    const branchIdx = 2; // absolute row index for voltage source branch

    const rail = makeVariableRailElement(nodeOut, nodeNeg, nodeInt, branchIdx, 12, 0.01);

    // No load — add a large bleed resistor to ground to ensure solvability (1MΩ)
    const bleed = makeResistorElement(nodeOut, 0, 1e6);

    const solution = solveCircuit([rail as unknown as AnalogElement, bleed], 2, 1);
    // solution[0] = node1 (internal), solution[1] = node2 (output), solution[2] = branch current
    const vOut = solution[nodeOut - 1]; // node2 = index 1
    expect(vOut).toBeCloseTo(12, 1); // ± 0.01V
  });

  it("voltage_change_updates_output — 5V then 10V; new output = 10V", () => {
    const nodeInt = 1;
    const nodeOut = 2;
    const nodeNeg = 0;
    const branchIdx = 2;

    const rail = makeVariableRailElement(nodeOut, nodeNeg, nodeInt, branchIdx, 5, 0.01);
    const bleed = makeResistorElement(nodeOut, 0, 1e6);

    const sol1 = solveCircuit([rail as unknown as AnalogElement, bleed], 2, 1);
    expect(sol1[nodeOut - 1]).toBeCloseTo(5, 1);

    rail.setVoltage(10);
    const sol2 = solveCircuit([rail as unknown as AnalogElement, bleed], 2, 1);
    expect(sol2[nodeOut - 1]).toBeCloseTo(10, 1);
  });

  it("internal_resistance_limits_current — 12V rail with R_int=0.1Ω into 1Ω load; output ≈ 10.9V", () => {
    // Expected: V_out = 12 * R_load / (R_load + R_int) = 12 * 1/(1+0.1) = 10.909V
    const nodeInt = 1;
    const nodeOut = 2;
    const nodeNeg = 0;
    const branchIdx = 2;

    const rail = makeVariableRailElement(nodeOut, nodeNeg, nodeInt, branchIdx, 12, 0.1);
    const load = makeResistorElement(nodeOut, 0, 1.0);

    const solution = solveCircuit([rail as unknown as AnalogElement, load], 2, 1);
    const vOut = solution[nodeOut - 1];
    const expected = 12 * 1.0 / (1.0 + 0.1);
    expect(vOut).toBeCloseTo(expected, 3);
  });

  it("setVoltage_currentVoltage_updates", () => {
    const rail = makeVariableRailElement(1, 0, 2, 3, 5, 0.01);
    expect(rail.currentVoltage).toBe(5);
    rail.setVoltage(15);
    expect(rail.currentVoltage).toBe(15);
  });

  it("is_not_nonlinear_or_reactive", () => {
    const rail = makeVariableRailElement(1, 0, 2, 3, 5, 0.01);
    expect(rail.isNonlinear).toBe(false);
    expect(rail.isReactive).toBe(false);
  });

  it("definition_has_requires_branch_row", () => {
    expect((VariableRailDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory;branchCount?:number}|undefined)?.branchCount).toBe(1);
  });

  it("definition_engine_type_analog", () => {
    expect(VariableRailDefinition.modelRegistry?.behavioral).toBeDefined();
  });

  it("analogFactory_creates_element", () => {
    const props = new PropertyBag();
    props.setModelParam("voltage", 7);
    props.setModelParam("resistance", 0.05);
    const el = getFactory(VariableRailDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1]]),
      [2],
      3,
      props,
      () => 0,
    );
    expect(el).toBeDefined();
    expect(el.isNonlinear).toBe(false);
  });
});

// ===========================================================================
// Task C4.4 — Variable Rail srcFact parity
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
  // solver.stampElement(handle, value), and solver.stampRHS(row, value).
  // The capture solver implements the same three-method surface the production
  // sibling sources (dc-voltage-source.test.ts et al) use, so it covers every
  // method variable-rail.ts touches.
  function makeCaptureSolver() {
    const stamps: Array<{ row: number; col: number; value: number }> = [];
    const rhs: Array<{ row: number; value: number }> = [];
    return {
      allocElement: vi.fn((row: number, col: number) => {
        stamps.push({ row, col, value: 0 });
        return stamps.length - 1;
      }),
      stampElement: vi.fn((h: number, v: number) => {
        stamps[h].value += v;
      }),
      stampRHS: vi.fn((row: number, value: number) => {
        rhs.push({ row, value });
      }),
      _stamps: stamps,
      _rhs: rhs,
    };
  }

  function makeCtx(solver: unknown, srcFact: number) {
    return {
      solver: solver as SparseSolverType,
      voltages: new Float64Array(4),
      iteration: 0,
      initMode: "initFloat" as const,
      dt: 0,
      method: "trapezoidal" as const,
      order: 1,
      deltaOld: [0, 0, 0, 0, 0, 0, 0],
      ag: new Float64Array(8),
      srcFact,
      noncon: { value: 0 },
      limitingCollector: null,
      isDcOp: true,
      isTransient: false,
      xfact: 1,
      gmin: 1e-12,
      uic: false,
      reltol: 1e-3,
      iabstol: 1e-12,
    };
  }

  it("srcfact_05_rhs_ignores_srcfact_bit_exact", () => {
    // nodePos=2 (output), nodeNeg=0 (ground), nodeInt=1, branch=2.
    const VOLTAGE = 12;
    const rail = makeVariableRailElement(2, 0, 1, 2, VOLTAGE, 0.01);
    const solver = makeCaptureSolver();

    rail.load(makeCtx(solver, 0.5));

    // Variable rail by contract ignores srcFact — RHS stamp is the raw voltage.
    const NGSPICE_REF = VOLTAGE; // no srcFact multiplier in variable-rail.ts load()
    const branchRhs = solver._rhs.find((e) => e.row === 2);
    expect(branchRhs).not.toBeUndefined();
    expect(branchRhs!.value).toBe(NGSPICE_REF);
  });

  it("srcfact_0_still_delivers_full_voltage", () => {
    // Source stepping at srcFact=0 would kill an ordinary DC voltage source.
    // Variable rail must still stamp its full nominal voltage.
    const VOLTAGE = 7.5;
    const rail = makeVariableRailElement(2, 0, 1, 2, VOLTAGE, 0.01);
    const solver = makeCaptureSolver();

    rail.load(makeCtx(solver, 0));

    const branchRhs = solver._rhs.find((e) => e.row === 2);
    expect(branchRhs).not.toBeUndefined();
    expect(branchRhs!.value).toBe(VOLTAGE);
  });

  it("srcfact_1_delivers_full_voltage", () => {
    const VOLTAGE = 5;
    const rail = makeVariableRailElement(2, 0, 1, 2, VOLTAGE, 0.01);
    const solver = makeCaptureSolver();

    rail.load(makeCtx(solver, 1));

    const branchRhs = solver._rhs.find((e) => e.row === 2);
    expect(branchRhs).not.toBeUndefined();
    expect(branchRhs!.value).toBe(VOLTAGE);
  });
});
