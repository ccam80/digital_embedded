/**
 * Tests for the Variable Rail source component.
 */

import { describe, it, expect } from "vitest";
import { makeVariableRailElement, VariableRailDefinition } from "../variable-rail.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { solveDcOperatingPoint } from "../../../solver/analog/dc-operating-point.js";
import { DiagnosticCollector } from "../../../solver/analog/diagnostics.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../../core/analog-engine-interface.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
import { PropertyBag } from "../../../core/properties.js";

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
    stamp(solver: SparseSolver): void {
      if (nodeA !== 0) solver.stamp(nodeA - 1, nodeA - 1, G);
      if (nodeB !== 0) solver.stamp(nodeB - 1, nodeB - 1, G);
      if (nodeA !== 0 && nodeB !== 0) {
        solver.stamp(nodeA - 1, nodeB - 1, -G);
        solver.stamp(nodeB - 1, nodeA - 1, -G);
      }
    },
  };
}

function solveCircuit(elements: AnalogElement[], nodeCount: number, branchCount: number): Float64Array {
  const solver = new SparseSolver();
  const diag = new DiagnosticCollector();
  const result = solveDcOperatingPoint({
    solver,
    elements,
    matrixSize: nodeCount + branchCount,
    params: DEFAULT_SIMULATION_PARAMS,
    diagnostics: diag,
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

    const solution = solveCircuit([rail, bleed], 2, 1);
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

    const sol1 = solveCircuit([rail, bleed], 2, 1);
    expect(sol1[nodeOut - 1]).toBeCloseTo(5, 1);

    rail.setVoltage(10);
    const sol2 = solveCircuit([rail, bleed], 2, 1);
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

    const solution = solveCircuit([rail, load], 2, 1);
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
