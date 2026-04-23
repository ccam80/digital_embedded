/**
 * Tests for the ZenerElement component.
 *
 * Covers engine-agnostic interface contracts and parameter plumbing only.
 * Hand-computed expected values deleted per A1 §Test handling rule
 * (spec/architectural-alignment.md §A1): assertions whose expected values
 * were computed by hand, not produced by ngspice, are subject to deletion
 * during A1 execution.
 */

import { describe, it, expect } from "vitest";
import { ZenerDiodeDefinition, createZenerElement } from "../zener.js";
import { PropertyBag } from "../../../core/properties.js";
import { withNodeIds } from "../../../solver/analog/__tests__/test-helpers.js";
import { StatePool } from "../../../solver/analog/state-pool.js";
import { SparseSolver } from "../../../solver/analog/sparse-solver.js";
import type { AnalogElementCore } from "../../../core/analog-types.js";
import type { ReactiveAnalogElement } from "../../../solver/analog/element.js";
import type { AnalogFactory } from "../../../core/registry.js";
import type { LoadContext } from "../../../solver/analog/load-context.js";
import { MODEDCOP, MODEINITFLOAT } from "../../../solver/analog/ckt-mode.js";

// ---------------------------------------------------------------------------
// Helper: allocate a StatePool for a single element and call initState
// ---------------------------------------------------------------------------

function withState(core: AnalogElementCore): { element: ReactiveAnalogElement; pool: StatePool } {
  const re = core as ReactiveAnalogElement;
  const pool = new StatePool(Math.max(re.stateSize, 1));
  re.stateBaseOffset = 0;
  re.initState(pool);
  return { element: re, pool };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParamBag(params: Record<string, number>): PropertyBag {
  const bag = new PropertyBag();
  bag.replaceModelParams(params);
  return bag;
}

/**
 * Build a bare LoadContext for a single-element unit test.
 */
function buildUnitCtx(
  solver: SparseSolver,
  voltages: Float64Array,
  overrides: Partial<LoadContext> = {},
): LoadContext {
  return {
    solver,
    voltages,
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
    cktFixLimit: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Engine-agnostic interface contract tests (A1 survivors)
// ---------------------------------------------------------------------------

describe("Zener", () => {
  it("isNonlinear_true", () => {
    const propsObj = makeParamBag({ IS: 1e-14, N: 1, BV: 5.1 });
    const core = createZenerElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);
    const { element } = withState(core);
    expect(element.isNonlinear).toBe(true);
  });

  it("isReactive_false", () => {
    const propsObj = makeParamBag({ IS: 1e-14, N: 1, BV: 5.1 });
    const core = createZenerElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);
    const { element } = withState(core);
    expect(element.isReactive).toBe(false);
  });

  it("definition_has_correct_fields", () => {
    expect(ZenerDiodeDefinition.name).toBe("ZenerDiode");
    expect(ZenerDiodeDefinition.modelRegistry?.["spice"]).toBeDefined();
    expect(ZenerDiodeDefinition.modelRegistry?.["spice"]?.kind).toBe("inline");
    expect((ZenerDiodeDefinition.modelRegistry?.["spice"] as {kind:"inline";factory:AnalogFactory}|undefined)?.factory).toBeDefined();
  });

  it("load_does_not_write_voltages", () => {
    // Verify that load() reads from voltages but does NOT write back.
    const propsObj = makeParamBag({ IS: 1e-14, N: 1, BV: 5.1, IBV: 1e-3 });
    const core = createZenerElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);
    const { element } = withState(core);
    const el = withNodeIds(element, [1, 2]);

    const voltages = new Float64Array([0.7, 0.0]);
    const voltagesBefore = new Float64Array(voltages);

    const solver = new SparseSolver();
    solver.beginAssembly(2);
    const ctx = buildUnitCtx(solver, voltages);
    el.load(ctx);

    // Voltages must be completely unchanged after load()
    expect(voltages[0]).toBe(voltagesBefore[0]);
    expect(voltages[1]).toBe(voltagesBefore[1]);
  });

  it("setParam_accepts_known_keys", () => {
    // Parameter plumbing: setParam must not throw for known keys.
    const propsObj = makeParamBag({ IS: 1e-14, N: 1, BV: 5.1 });
    const core = createZenerElement(new Map([["A", 1], ["K", 2]]), [], -1, propsObj);
    const { element } = withState(core);
    // Engine-agnostic interface: setParam must accept recognised keys silently.
    expect(() => element.setParam("BV", 6.2)).not.toThrow();
    expect(() => element.setParam("IS", 1e-13)).not.toThrow();
    expect(() => element.setParam("N", 1.1)).not.toThrow();
    expect(() => element.setParam("NBV", 1.2)).not.toThrow();
  });
});
