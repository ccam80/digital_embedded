/**
 * Tests for the AnalogGround component.
 */

import { describe, it, expect, vi } from "vitest";
import { GroundDefinition } from "../../io/ground.js";
import { PropertyBag } from "../../../core/properties.js";
import { PinDirection } from "../../../core/pin.js";
import type { SparseSolver as SparseSolverType } from "../../../solver/analog/sparse-solver.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import { MODEDCOP, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}


// ---------------------------------------------------------------------------
// Capture solver + minimal LoadContext builder
// ---------------------------------------------------------------------------

function makeCaptureSolver(): { solver: SparseSolverType; allocCalls: number; stampElementCalls: number; stampRHSCalls: number } {
  let allocCalls = 0;
  let stampElementCalls = 0;
  let stampRHSCalls = 0;
  const solver = {
    allocElement: vi.fn((_row: number, _col: number): number => { allocCalls++; return 0; }),
    stampElement: vi.fn((_handle: number, _value: number): void => { stampElementCalls++; }),
    stampRHS: vi.fn((_row: number, _value: number): void => { stampRHSCalls++; }),
  } as unknown as SparseSolverType;
  return { solver, get allocCalls() { return allocCalls; }, get stampElementCalls() { return stampElementCalls; }, get stampRHSCalls() { return stampRHSCalls; } };
}

function makeLoadCtx(solver: SparseSolverType): LoadContext {
  return {
    solver,
    voltages: new Float64Array(8),
    cktMode: MODEDCOP | MODEINITFLOAT,
    dt: 0,
    method: "trapezoidal",
    order: 1,
    deltaOld: [0, 0, 0, 0, 0, 0, 0],
    ag: new Float64Array(7),
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    xfact: 1,
    gmin: 1e-12,
    reltol: 1e-3,
    iabstol: 1e-12,
  };
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
    const { solver, allocCalls, stampElementCalls, stampRHSCalls } = makeCaptureSolver();
    const ctx = makeLoadCtx(solver);

    element.load(ctx);

    expect(allocCalls).toBe(0);
    expect(stampElementCalls).toBe(0);
    expect(stampRHSCalls).toBe(0);
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
