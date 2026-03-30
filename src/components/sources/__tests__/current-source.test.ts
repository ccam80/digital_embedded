/**
 * Tests for the current source component.
 */

import { describe, it, expect, vi } from "vitest";
import { makeCurrentSource, CurrentSourceDefinition, CURRENT_SOURCE_DEFAULTS } from "../current-source.js";
import { PropertyBag } from "../../../core/properties.js";
import type { SparseSolver } from "../../../solver/analog/sparse-solver.js";

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
// CurrentSource unit tests
// ---------------------------------------------------------------------------

describe("CurrentSource", () => {
  it("stamp_rhs_only", () => {
    // 10mA source: current flows from nodeNeg(2) to nodePos(1) through source
    const src = makeCurrentSource(1, 2, 0.01);
    const solver = makeMockSolver();

    src.stamp(solver as unknown as SparseSolver);

    // No matrix stamps — current sources are RHS-only
    expect(solver.stamp).toHaveBeenCalledTimes(0);

    // RHS[nodePos-1] += I  → RHS[0] += 0.01
    // RHS[nodeNeg-1] -= I  → RHS[1] -= 0.01
    expect(solver.stampRHS).toHaveBeenCalledTimes(2);
    expect(solver.stampRHS).toHaveBeenCalledWith(0,  0.01);
    expect(solver.stampRHS).toHaveBeenCalledWith(1, -0.01);
  });

  it("set_scale_modifies_current", () => {
    const src = makeCurrentSource(1, 2, 0.01);
    src.setSourceScale!(0.3);

    const solver = makeMockSolver();
    src.stamp(solver as unknown as SparseSolver);

    // No matrix stamps
    expect(solver.stamp).toHaveBeenCalledTimes(0);

    // I * scale = 0.01 * 0.3 = 0.003
    expect(solver.stampRHS).toHaveBeenCalledWith(0,  0.003);
    expect(solver.stampRHS).toHaveBeenCalledWith(1, -0.003);
  });

  it("ground_node_rhs_suppressed", () => {
    // pos at node 1, neg at ground (0)
    const src = makeCurrentSource(1, 0, 0.01);
    const solver = makeMockSolver();

    src.stamp(solver as unknown as SparseSolver);

    // Only one RHS entry (ground row suppressed)
    expect(solver.stampRHS).toHaveBeenCalledTimes(1);
    expect(solver.stampRHS).toHaveBeenCalledWith(0, 0.01);
  });

  it("branch_index_is_minus_one", () => {
    const src = makeCurrentSource(1, 2, 0.01);
    expect(src.branchIndex).toBe(-1);
  });

  it("is_not_nonlinear_or_reactive", () => {
    const src = makeCurrentSource(1, 2, 0.01);
    expect(src.isNonlinear).toBe(false);
    expect(src.isReactive).toBe(false);
  });

  it("definition_engine_type_analog", () => {
    expect(CurrentSourceDefinition.modelRegistry?.behavioral).toBeDefined();
  });

  it("definition_does_not_require_branch_row", () => {
    expect(CurrentSourceDefinition.modelRegistry?.behavioral?.branchCount).toBeFalsy();
  });

  it("default_current_from_analog_factory", () => {
    const props = new PropertyBag();
    props.replaceModelParams(CURRENT_SOURCE_DEFAULTS);
    const el = CurrentSourceDefinition.modelRegistry!.behavioral!.factory(
      new Map([["pos", 1], ["neg", 2]]),
      [],
      -1,
      props,
      () => 0,
    );

    const solver = makeMockSolver();
    el.stamp(solver as unknown as SparseSolver);

    // Default current is 0.01 A
    expect(solver.stampRHS).toHaveBeenCalledWith(0,  0.01);
    expect(solver.stampRHS).toHaveBeenCalledWith(1, -0.01);
  });
});
