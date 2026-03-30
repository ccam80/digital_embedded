/**
 * Tests for the DC voltage source component.
 */

import { describe, it, expect, vi } from "vitest";
import { makeDcVoltageSource, DcVoltageSourceDefinition } from "../dc-voltage-source.js";
import { PropertyBag } from "../../../core/properties.js";
import type { SparseSolver } from "../../../solver/analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


// ---------------------------------------------------------------------------
// Mock solver
// ---------------------------------------------------------------------------

function makeMockSolver() {
  const stamps: Array<{ row: number; col: number; value: number }> = [];
  const rhs: Record<number, number> = {};

  const solver = {
    stamp: vi.fn((row: number, col: number, value: number) => {
      stamps.push({ row, col, value });
    }),
    stampRHS: vi.fn((row: number, value: number) => {
      rhs[row] = (rhs[row] ?? 0) + value;
    }),
    _stamps: stamps,
    _rhs: rhs,
  };

  return solver;
}

// ---------------------------------------------------------------------------
// DcVoltageSource unit tests
// ---------------------------------------------------------------------------

describe("DcVoltageSource", () => {
  it("stamp_incidence_and_rhs", () => {
    // 10V source between nodes 1 (pos) and 2 (neg), branch at absolute row 3
    // matrixSize = 4 (3 nodes + 1 branch)
    const src = makeDcVoltageSource(1, 2, 3, 10);
    const solver = makeMockSolver();

    src.stamp(solver as unknown as SparseSolver);

    // Should produce 4 matrix stamps:
    // B[1,3] = solver.stamp(0, 3,  1)  — nodePos row, branch col
    // B[2,3] = solver.stamp(1, 3, -1)  — nodeNeg row, branch col
    // C[3,1] = solver.stamp(3, 0,  1)  — branch row, nodePos col
    // C[3,2] = solver.stamp(3, 1, -1)  — branch row, nodeNeg col
    expect(solver.stamp).toHaveBeenCalledTimes(4);

    expect(solver.stamp).toHaveBeenCalledWith(0, 3,  1);
    expect(solver.stamp).toHaveBeenCalledWith(1, 3, -1);
    expect(solver.stamp).toHaveBeenCalledWith(3, 0,  1);
    expect(solver.stamp).toHaveBeenCalledWith(3, 1, -1);

    // RHS at branch row 3: RHS[3] = 10
    expect(solver.stampRHS).toHaveBeenCalledTimes(1);
    expect(solver.stampRHS).toHaveBeenCalledWith(3, 10);
  });

  it("set_scale_modifies_rhs", () => {
    const src = makeDcVoltageSource(1, 2, 3, 10);
    src.setSourceScale!(0.5);

    const solver = makeMockSolver();
    src.stamp(solver as unknown as SparseSolver);

    // Incidence stamps are always ±1
    expect(solver.stamp).toHaveBeenCalledTimes(4);

    // RHS = 10 * 0.5 = 5
    expect(solver.stampRHS).toHaveBeenCalledWith(3, 5);
  });

  it("ground_node_stamps_suppressed", () => {
    // Positive at node 1, negative at ground (0), branch at row 2
    const src = makeDcVoltageSource(1, 0, 2, 5);
    const solver = makeMockSolver();

    src.stamp(solver as unknown as SparseSolver);

    // Only 2 matrix stamps (neg is ground — B[0,k] and C[k,0] suppressed)
    expect(solver.stamp).toHaveBeenCalledTimes(2);
    expect(solver.stamp).toHaveBeenCalledWith(0, 2, 1);
    expect(solver.stamp).toHaveBeenCalledWith(2, 0, 1);
    expect(solver.stampRHS).toHaveBeenCalledWith(2, 5);
  });

  it("branch_index_stored", () => {
    const src = makeDcVoltageSource(1, 2, 5, 10);
    expect(src.branchIndex).toBe(5);
  });

  it("is_not_nonlinear_or_reactive", () => {
    const src = makeDcVoltageSource(1, 2, 3, 10);
    expect(src.isNonlinear).toBe(false);
    expect(src.isReactive).toBe(false);
  });

  it("definition_has_requires_branch_row", () => {
    expect((DcVoltageSourceDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory;branchCount?:number}|undefined)?.branchCount).toBe(1);
  });

  it("definition_engine_type_analog", () => {
    expect(DcVoltageSourceDefinition.modelRegistry?.behavioral).toBeDefined();
  });

  it("default_voltage_from_analog_factory", () => {
    const props = new PropertyBag();
    props.replaceModelParams({ voltage: 5 });
    const el = getFactory(DcVoltageSourceDefinition.modelRegistry!.behavioral!)(
      new Map([["pos", 1], ["neg", 0]]),
      [],
      2,
      props,
      () => 0,
    );

    const solver = makeMockSolver();
    el.stamp(solver as unknown as SparseSolver);

    // Default voltage is 5V, branch at row 2, nodeNeg=0 so only 2 stamps
    expect(solver.stampRHS).toHaveBeenCalledWith(2, 5);
  });
});
