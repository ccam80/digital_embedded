/**
 * Tests for the AnalogGround component.
 */

import { describe, it, expect, vi } from "vitest";
import { AnalogGroundDefinition, AnalogGroundElement } from "../ground.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import type { SparseSolver } from "../../../analog/sparse-solver.js";

// ---------------------------------------------------------------------------
// Mock SparseSolver
// ---------------------------------------------------------------------------

function makeMockSolver() {
  return {
    stamp: vi.fn(),
    stampRHS: vi.fn(),
  } as unknown as SparseSolver;
}

// ---------------------------------------------------------------------------
// Ground tests
// ---------------------------------------------------------------------------

describe("Ground", () => {
  it("stamp_is_noop", () => {
    const props = new PropertyBag();
    const element = AnalogGroundDefinition.analogFactory!(
      [3],
      -1,
      props,
      () => 0,
    );
    const solver = makeMockSolver();

    element.stamp(solver);

    expect((solver.stamp as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect((solver.stampRHS as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("pin_layout_single_input", () => {
    const pinLayout = AnalogGroundDefinition.pinLayout;

    expect(pinLayout).toHaveLength(1);
    expect(pinLayout[0].direction).toBe(PinDirection.INPUT);
    expect(pinLayout[0].label).toBe("gnd");
  });

  it("definition_has_engine_type_analog", () => {
    expect(AnalogGroundDefinition.engineType).toBe("analog");
  });

  it("definition_has_analog_factory", () => {
    expect(AnalogGroundDefinition.analogFactory).toBeDefined();
  });

  it("element_is_not_nonlinear_and_not_reactive", () => {
    const props = new PropertyBag();
    const element = AnalogGroundDefinition.analogFactory!(
      [0],
      -1,
      props,
      () => 0,
    );

    expect(element.isNonlinear).toBe(false);
    expect(element.isReactive).toBe(false);
  });

  it("element_branch_index_is_minus_one", () => {
    const props = new PropertyBag();
    const element = AnalogGroundDefinition.analogFactory!(
      [2],
      -1,
      props,
      () => 0,
    );

    expect(element.branchIndex).toBe(-1);
  });

  it("element_node_indices_matches_input", () => {
    const props = new PropertyBag();
    const element = AnalogGroundDefinition.analogFactory!(
      [5],
      -1,
      props,
      () => 0,
    );

    expect(element.nodeIndices).toEqual([5]);
  });
});
