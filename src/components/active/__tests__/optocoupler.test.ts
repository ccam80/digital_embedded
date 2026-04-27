/**
 * Optocoupler tests — A1 post-composition survivors.
 *
 * All hand-computed expected-value tests from the pre-composition PWL
 * implementation deleted per A1 §Test handling rule: those tests encoded
 * the inline PWL LED model (vForward/rLed params) and the cross-port Jacobian
 * of the shortcut implementation. The composition now delegates to diode.ts
 * (dioload.c) and bjt.ts (bjtload.c); the expected values must come from
 * the ngspice harness, not hand computation.
 *
 * What survives (per §A1 "Test handling during A1 execution"):
 *   1. Parameter plumbing — ctr, Is, n params accepted and stored.
 *   2. Engine-agnostic interface contracts — poolBacked, stateSize, initState.
 */

import { describe, it, expect } from "vitest";
import { OptocouplerDefinition } from "../optocoupler.js";
import { PropertyBag } from "../../../core/properties.js";
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

function makeOptocouplerCore(
  nAnode: number,
  nCathode: number,
  nCollector: number,
  nEmitter: number,
  _nBase: number,
  opts: { ctr?: number; Is?: number; n?: number } = {},
) {
  const ctr = opts.ctr ?? 1.0;
  const Is  = opts.Is  ?? 1e-14;
  const n   = opts.n   ?? 1.0;
  const props = new PropertyBag(new Map<string, import("../../../core/properties.js").PropertyValue>([
    ["vceSat",    0.3],
    ["bandwidth", 50000],
    ["label",     ""],
  ]).entries());
  props.replaceModelParams({ ctr, Is, n });
  return getFactory(OptocouplerDefinition.modelRegistry!["behavioral"]!)(
    new Map([
      ["anode", nAnode], ["cathode", nCathode],
      ["collector", nCollector], ["emitter", nEmitter],
    ]),
    props,
    () => 0,
  );
}

// ---------------------------------------------------------------------------
// Parameter plumbing
// ---------------------------------------------------------------------------

describe("Optocoupler parameter plumbing", () => {
  it("accepts ctr, Is, n params without throwing", () => {
    expect(() =>
      makeOptocouplerCore(1, 2, 3, 4, 5, { ctr: 0.5, Is: 2e-14, n: 1.5 }),
    ).not.toThrow();
  });

  it("default params produce a valid element", () => {
    const el = makeOptocouplerCore(1, 2, 3, 4, 5);
    expect(el).toBeDefined();
    expect(el.branchIndex).toBe(-1);
    expect(el.isNonlinear).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Engine-agnostic interface contracts
// ---------------------------------------------------------------------------

describe("Optocoupler composite interface (PB-OPTO)", () => {
  it("is not pool-backed at the composite level (state delegated to sub-elements)", () => {
    const el = makeOptocouplerCore(1, 2, 3, 4, 5);
    // The composite delegates all state management to DIO and BJT sub-elements.
    // The composite itself has no stateSize or poolBacked flag.
    expect((el as any).poolBacked).toBeFalsy();
  });

  it("branchIndex is -1 (no extra MNA row at composite level)", () => {
    const el = makeOptocouplerCore(1, 2, 3, 4, 5);
    expect(el.branchIndex).toBe(-1);
  });

  it("isNonlinear is true (DIO and BJT sub-elements are nonlinear)", () => {
    const el = makeOptocouplerCore(1, 2, 3, 4, 5);
    expect(el.isNonlinear).toBe(true);
  });

  it("modelRegistry behavioral entry has mayCreateInternalNodes=true", () => {
    const entry = OptocouplerDefinition.modelRegistry!["behavioral"]!;
    if (entry.kind !== "inline") throw new Error("Expected inline");
    expect(entry.mayCreateInternalNodes).toBe(true);
  });
});
