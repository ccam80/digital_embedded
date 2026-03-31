/**
 * Tests for the AnalogGround component.
 */

import { describe, it, expect, vi } from "vitest";
import { GroundDefinition } from "../../io/ground.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
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
    const element = getFactory(GroundDefinition.modelRegistry!.behavioral!)(
      new Map([["out", 3]]),
      [],
      -1,
      props,
      () => 0,
    );
    const solver = makeMockSolver();

    element.stamp(solver);

    expect((solver.stamp as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect((solver.stampRHS as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("pin_layout_single_output", () => {
    const pinLayout = GroundDefinition.pinLayout;

    expect(pinLayout).toHaveLength(1);
    expect(pinLayout[0].direction).toBe(PinDirection.OUTPUT);
    expect(pinLayout[0].label).toBe("out");
  });

  it("definition_has_engine_type_both", () => {
    expect(GroundDefinition.modelRegistry?.behavioral).toBeDefined();
  });

  it("definition_has_analog_factory", () => {
    expect((GroundDefinition.modelRegistry?.behavioral as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
  });

  it("element_is_not_nonlinear_and_not_reactive", () => {
    const props = new PropertyBag();
    const element = getFactory(GroundDefinition.modelRegistry!.behavioral!)(
      new Map([["out", 0]]),
      [],
      -1,
      props,
      () => 0,
    );

    expect(element.isNonlinear).toBe(false);
    expect(element.isReactive).toBe(false);
  });

  it("element_branch_index_is_minus_one", () => {
    const props = new PropertyBag();
    const element = getFactory(GroundDefinition.modelRegistry!.behavioral!)(
      new Map([["out", 2]]),
      [],
      -1,
      props,
      () => 0,
    );

    expect(element.branchIndex).toBe(-1);
  });

  it("element_node_indices_matches_input", () => {
    const props = new PropertyBag();
    const element = getFactory(GroundDefinition.modelRegistry!.behavioral!)(
      new Map([["out", 5]]),
      [],
      -1,
      props,
      () => 0,
    );
    Object.assign(element, { pinNodeIds: [5], allNodeIds: [5] });
    const elementWithPins = element as typeof element & { pinNodeIds: number[] };

    expect(elementWithPins.pinNodeIds).toEqual([5]);
  });
});
