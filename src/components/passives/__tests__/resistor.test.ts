/**
 * Tests for the AnalogResistor component and voltage divider integration.
 */

import { describe, it, expect, vi } from "vitest";
import { ResistorDefinition } from "../resistor.js";
import { PropertyBag } from "../../../core/properties.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import { DiagnosticCollector } from "../../../solver/analog/diagnostics.js";
import { solveDcOperatingPoint } from "../../../solver/analog/dc-operating-point.js";
import { DEFAULT_SIMULATION_PARAMS } from "../../../core/analog-engine-interface.js";
import { makeDcVoltageSource } from "../../sources/dc-voltage-source.js";
import type { AnalogElement } from "../../../solver/analog/element.js";
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
// Mock SparseSolver
// ---------------------------------------------------------------------------

function makeMockSolver() {
  return {
    stamp: vi.fn(),
    stampRHS: vi.fn(),
  } as unknown as SparseSolverType;
}

// ---------------------------------------------------------------------------
// Resistor unit tests
// ---------------------------------------------------------------------------

describe("Resistor", () => {
  it("stamp_places_four_conductance_entries", () => {
    const props = new PropertyBag(); props.replaceModelParams({ resistance: 1000 });
    const element = getFactory(ResistorDefinition.modelRegistry!.behavioral!)(new Map([["A", 1], ["B", 2]]), [], -1, props, () => 0);
    const solver = makeMockSolver();

    element.stamp(solver);

    const calls = (solver.stamp as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(4);

    const G = 1e-3;
    // Node IDs are 1-based; factory converts to 0-based solver indices (nodeId - 1)
    expect(calls).toContainEqual([0, 0, G]);
    expect(calls).toContainEqual([1, 1, G]);
    expect(calls).toContainEqual([0, 1, -G]);
    expect(calls).toContainEqual([1, 0, -G]);
  });

  it("resistance_from_props", () => {
    const props = new PropertyBag(); props.replaceModelParams({ resistance: 470 });
    const element = getFactory(ResistorDefinition.modelRegistry!.behavioral!)(new Map([["A", 1], ["B", 2]]), [], -1, props, () => 0);
    const solver = makeMockSolver();

    element.stamp(solver);

    const calls = (solver.stamp as ReturnType<typeof vi.fn>).mock.calls;
    const G = 1 / 470;
    expect(calls).toContainEqual([0, 0, G]);
    expect(calls).toContainEqual([1, 1, G]);
    expect(calls).toContainEqual([0, 1, -G]);
    expect(calls).toContainEqual([1, 0, -G]);
  });

  it("minimum_resistance_clamped", () => {
    const props = new PropertyBag(); props.replaceModelParams({ resistance: 0 });
    const element = getFactory(ResistorDefinition.modelRegistry!.behavioral!)(new Map([["A", 1], ["B", 2]]), [], -1, props, () => 0);
    const solver = makeMockSolver();

    element.stamp(solver);

    const calls = (solver.stamp as ReturnType<typeof vi.fn>).mock.calls;
    const G = 1 / 1e-9;
    expect(calls).toContainEqual([0, 0, G]);
    expect(calls).toContainEqual([1, 1, G]);
    expect(calls).toContainEqual([0, 1, -G]);
    expect(calls).toContainEqual([1, 0, -G]);
  });

  it("is_not_nonlinear_and_not_reactive", () => {
    const props = new PropertyBag(); props.replaceModelParams({ resistance: 1000 });
    const element = getFactory(ResistorDefinition.modelRegistry!.behavioral!)(new Map([["A", 1], ["B", 2]]), [], -1, props, () => 0);

    expect(element.isNonlinear).toBe(false);
    expect(element.isReactive).toBe(false);
  });

  it("branch_index_is_minus_one", () => {
    const props = new PropertyBag(); props.replaceModelParams({ resistance: 1000 });
    const element = getFactory(ResistorDefinition.modelRegistry!.behavioral!)(new Map([["A", 1], ["B", 2]]), [], -1, props, () => 0);

    expect(element.branchIndex).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Minimal resistor element (stamps 4 conductance entries, ground-safe)
// ---------------------------------------------------------------------------

function makeResistor(nodeA: number, nodeB: number, resistance: number): AnalogElement {
  const G = 1 / resistance;
  return {
    pinNodeIds: [nodeA, nodeB],
    allNodeIds: [nodeA, nodeB],
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_v: Float64Array): number[] { return []; },
    stamp(solver: SparseSolver): void {
      if (nodeA !== 0) solver.stamp(nodeA - 1, nodeA - 1,  G);
      if (nodeB !== 0) solver.stamp(nodeB - 1, nodeB - 1,  G);
      if (nodeA !== 0 && nodeB !== 0) {
        solver.stamp(nodeA - 1, nodeB - 1, -G);
        solver.stamp(nodeB - 1, nodeA - 1, -G);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Integration: Voltage divider DC operating point
// ---------------------------------------------------------------------------

describe("Integration", () => {
  it("voltage_divider_dc_op", () => {
    // Circuit: 10V source → R1=1kΩ → node 1 → R2=2kΩ → ground
    //
    // Analytical solution:
    //   V(node1) = 10 × 2000/3000 = 6.6667 V
    //   I_source = 10 / 3000 = 3.3333 mA
    //
    // MNA node assignment:
    //   node 1 = R1–R2 junction
    //   node 2 = positive terminal of the voltage source
    //   ground = node 0
    //   branch row = absolute solver index 2 (after the 2 node rows)
    //
    // matrixSize = 2 (nodes) + 1 (branch) = 3

    const matrixSize = 3;
    const branchRow = 2; // absolute 0-based solver row for branch current

    const vs = makeDcVoltageSource(2, 0, branchRow, 10) as unknown as AnalogElement; // 10V: node2(+) to gnd(-)
    const r1 = makeResistor(1, 2, 1000);                  // 1kΩ: node1 ↔ node2
    const r2 = makeResistor(1, 0, 2000);                  // 2kΩ: node1 ↔ ground

    const solver = new SparseSolver();
    const diagnostics = new DiagnosticCollector();

    const result = solveDcOperatingPoint({
      solver,
      elements: [vs, r1, r2],
      matrixSize,
      nodeCount: 2,
      params: DEFAULT_SIMULATION_PARAMS,
      diagnostics,
    });

    expect(result.converged).toBe(true);

    // Solution vector layout: [V(node1), V(node2), I_branch]
    const vJunction  = result.nodeVoltages[0]; // V at R1–R2 junction
    const vSourcePos = result.nodeVoltages[1]; // V at voltage source positive terminal
    const iBranch    = result.nodeVoltages[2]; // branch current (A)

    // Voltage source enforces V(node2) = 10 V
    expect(vSourcePos).toBeCloseTo(10, 4);

    // Junction voltage: 10 × (2000/3000) ≈ 6.6667 V, tolerance 1e-4
    expect(vJunction).toBeCloseTo(10 * 2000 / 3000, 4);

    // Source current: 10/3000 ≈ 3.333 mA, tolerance 1e-6 A
    expect(Math.abs(iBranch)).toBeCloseTo(10 / 3000, 6);
  });
});
