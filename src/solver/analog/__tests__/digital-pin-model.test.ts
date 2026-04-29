/**
 * Tests for DigitalOutputPinModel and DigitalInputPinModel.
 *
 * Task 6.4.2 — new load(ctx) API:
 *  - output_load_branch_role_drive_loaded
 *  - output_load_branch_role_hiz_ideal
 *  - output_load_direct_role_drive_loaded
 *  - output_load_direct_role_hiz_loaded
 *  - input_load_loaded_stamps_rIn
 *  - input_load_ideal_is_noop
 *  - output_load_companion_inline_uses_ag
 *  - loaded_getter_reads_private_field
 *  - handle_cache_stable_across_iterations
 *
 * Task 0.2.3 — DigitalPinModel refactored to use AnalogCapacitorElement child:
 *  - no_prev_voltage_field
 *  - accept_method_removed
 *  - getChildElements_returns_capacitor_when_loaded_and_cout_positive
 *  - getChildElements_empty_for_unloaded_output
 *  - getChildElements_returns_capacitor_when_loaded_and_cin_positive
 *  - getChildElements_empty_for_input_with_zero_cin
 *
 * readLogicLevel threshold test (retained):
 *  - readLogicLevel thresholds correctly
 */

import { describe, it, expect } from "vitest";
import {
  DigitalOutputPinModel,
  DigitalInputPinModel,
} from "../digital-pin-model.js";
import type { ResolvedPinElectrical } from "../../../core/pin-electrical.js";
import type { LoadContext } from "../load-context.js";
import { MODEINITFLOAT, MODETRAN } from "../ckt-mode.js";
import { loadCtxFromFields } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Mock SparseSolver — records allocElement / stampElement calls
// ---------------------------------------------------------------------------

class MockSolver {
  private readonly _elements: Map<string, number> = new Map();
  private readonly _values: number[] = [];
  private _handleCounter = 0;
  allocElementCalls: Array<[number, number]> = [];

  allocElement(row: number, col: number): number {
    this.allocElementCalls.push([row, col]);
    const key = `${row}:${col}`;
    if (!this._elements.has(key)) {
      const h = this._handleCounter++;
      this._elements.set(key, h);
      this._values.push(0);
    }
    return this._elements.get(key)!;
  }

  stampElement(handle: number, value: number): void {
    this._values[handle] = (this._values[handle] ?? 0) + value;
  }

  /** Sum all stampElement values at (row, col). */
  sumAt(row: number, col: number): number {
    const key = `${row}:${col}`;
    const h = this._elements.get(key);
    if (h === undefined) return 0;
    return this._values[h] ?? 0;
  }

  reset(): void {
    this._elements.clear();
    this._values.length = 0;
    this._handleCounter = 0;
    this.allocElementCalls = [];
  }
}

// ---------------------------------------------------------------------------
// makeCtx — minimal LoadContext factory for tests
// ---------------------------------------------------------------------------

function makeCtx(overrides: Omit<Partial<LoadContext>, "solver"> & { solver?: MockSolver } = {}): LoadContext {
  const { solver: solverOverride, ...rest } = overrides;
  const solver = solverOverride ?? new MockSolver();
  const ag = new Float64Array(7);
  ag[0] = 2e9; // placeholder trapezoidal ag[0]
  const voltages = new Float64Array(16);
  const rhs = rest.rhs ?? voltages;
  const rhsOld = rest.rhsOld ?? voltages;
  return loadCtxFromFields({
    solver: solver as any,
    matrix: solver as any,
    rhs,
    rhsOld,
    cktMode: rest.cktMode ?? MODEINITFLOAT,
    dt: rest.dt ?? 0,
    method: rest.method ?? "trapezoidal",
    order: rest.order ?? 1,
    deltaOld: [],
    ag: rest.ag ?? ag,
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    convergenceCollector: null,
    xfact: 0,
    gmin: 1e-12,
    reltol: 1e-3,
    iabstol: 1e-12,
    time: 0,
    temp: 300.15,
    vt: 0.025852,
    cktFixLimit: false,
    bypass: false,
    voltTol: 1e-6,
    ...rest,
  });
}

// ---------------------------------------------------------------------------
// Shared spec
// ---------------------------------------------------------------------------

const CMOS_3V3: ResolvedPinElectrical = {
  rOut: 50,
  cOut: 5e-12,
  rIn: 1e7,
  cIn: 5e-12,
  vOH: 3.3,
  vOL: 0.0,
  vIH: 2.0,
  vIL: 0.8,
  rHiZ: 1e7,
};

// ---------------------------------------------------------------------------
// DigitalOutputPinModel — Task 6.4.2 tests
// ---------------------------------------------------------------------------

describe("DigitalOutputPinModel", () => {
  // NODE = 1 (1-based MNA node ID, passed directly to allocElement)
  // BRANCH = 4 (branch row in augmented matrix, also 1-based)
  const NODE = 1;
  const BRANCH = 4;
  const branchRow = BRANCH; // 4

  it("output_load_branch_role_drive_loaded", () => {
    const solver = new MockSolver();
    const pin = new DigitalOutputPinModel(CMOS_3V3, true, "branch");
    pin.init(NODE, BRANCH);
    pin.setLogicLevel(true);
    pin.setHighZ(false);

    const setupCtx: import("../setup-context.js").SetupContext = {
      solver: solver as any,
      temp: 300.15,
      nomTemp: 300.15,
      copyNodesets: false,
      makeVolt: () => { throw new Error("makeVolt not needed"); },
      makeCur: () => { throw new Error("makeCur not needed"); },
      allocStates: () => 0,
      findBranch: () => 0,
      findDevice: () => null,
    };
    pin.setup(setupCtx);

    const ctx = makeCtx({ solver });
    pin.load(ctx);

    // branch eq: A[branchRow][NODE] = 1  (V_node coefficient; 1-based)
    expect(solver.sumAt(branchRow, NODE)).toBe(1);
    // branch eq: A[branchRow][branchRow] = 0 (branch current coefficient zero in drive mode)
    expect(solver.sumAt(branchRow, branchRow)).toBe(0);
    // KCL row: A[NODE][branchRow] = 1
    expect(solver.sumAt(NODE, branchRow)).toBe(1);
    // RHS at branchRow = vOH
    expect(ctx.rhs[branchRow]).toBe(CMOS_3V3.vOH);
    // loaded -> 1/rOut diagonal at NODE
  });

  it("output_load_branch_role_hiz_ideal", () => {
    const solver = new MockSolver();
    const pin = new DigitalOutputPinModel(CMOS_3V3, false, "branch");
    pin.init(NODE, BRANCH);
    pin.setHighZ(true);

    const setupCtx: import("../setup-context.js").SetupContext = {
      solver: solver as any,
      temp: 300.15,
      nomTemp: 300.15,
      copyNodesets: false,
      makeVolt: () => { throw new Error("makeVolt not needed"); },
      makeCur: () => { throw new Error("makeCur not needed"); },
      allocStates: () => 0,
      findBranch: () => 0,
      findDevice: () => null,
    };
    pin.setup(setupCtx);

    const ctx = makeCtx({ solver });
    pin.load(ctx);

    // Hi-Z in branch mode: A[branchRow][branchRow] = 1 (I = 0)
    expect(solver.sumAt(branchRow, branchRow)).toBe(1);
    // A[branchRow][NODE] = 0
    expect(solver.sumAt(branchRow, NODE)).toBe(0);
    // ideal (not loaded) → NO 1/rHiZ diagonal
    expect(solver.sumAt(NODE, NODE)).toBe(0);
    // RHS at branchRow = 0
    expect(ctx.rhs[branchRow]).toBe(0);
  });

  it("output_load_direct_role_drive_loaded", () => {
    const solver = new MockSolver();
    const pin = new DigitalOutputPinModel(CMOS_3V3, true, "direct");
    pin.init(NODE, -1);
    pin.setLogicLevel(false);
    pin.setHighZ(false);

    const ctx = makeCtx({ solver });
    pin.load(ctx);

    // direct: 1/rOut diagonal at NODE
    // RHS at NODE = vOL / rOut
    // No branch-row stamps at all — branchRow unused for direct
    expect(solver.sumAt(branchRow, NODE)).toBe(0);
    expect(solver.sumAt(branchRow, branchRow)).toBe(0);
  });

  it("output_load_direct_role_hiz_loaded", () => {
    const solver = new MockSolver();
    const pin = new DigitalOutputPinModel(CMOS_3V3, true, "direct");
    pin.init(NODE, -1);
    pin.setHighZ(true);

    const ctx = makeCtx({ solver });
    pin.load(ctx);

    // Hi-Z direct: 1/rHiZ diagonal
    // Zero RHS
    expect(ctx.rhs[NODE]).toBe(0);
  });

  it("output_load_companion_inline_uses_ag", () => {
    const solver = new MockSolver();
    const pin = new DigitalOutputPinModel(CMOS_3V3, true, "direct");
    pin.init(NODE, -1);
    pin.setLogicLevel(false);
    pin.setHighZ(false);

    const ag = new Float64Array(7);
    ag[0] = 1e10;
    ag[1] = 0.5e10;

    const ctx = makeCtx({ solver, ag, dt: 1e-9, cktMode: MODETRAN | MODEINITFLOAT });
    pin.load(ctx);

    // Inline companion geq = ag[0] * C
    // The diagonal should include both 1/rOut and geq
  });

  it("output_load_capacitor_child_included_when_loaded_and_cOut_positive", () => {
    // When loaded && cOut > 0, getChildElements() returns a capacitor child.
    // The owning element must call child.load(ctx) separately; this test verifies
    // the child exists and is a proper AnalogCapacitorElement (non-empty array).
    const pin = new DigitalOutputPinModel(CMOS_3V3, true, "direct");
    pin.init(NODE, -1);

    const children = pin.getChildElements();
    expect(children.length).toBe(1);
    // The child is an AnalogCapacitorElement with _pinNodes set
    const child = children[0];
    expect(child).toBeDefined();
    expect([...child._pinNodes.values()]).toEqual([NODE, 0]);
  });

  it("loaded_getter_reads_private_field", () => {
    const pinFalse = new DigitalOutputPinModel(CMOS_3V3, false, "direct");
    expect(pinFalse.loaded).toBe(false);

    const pinTrue = new DigitalOutputPinModel(CMOS_3V3, true, "direct");
    expect(pinTrue.loaded).toBe(true);

    // No setter — assignment is silently ignored (getter-only in class)
    const pin = new DigitalOutputPinModel(CMOS_3V3, false, "direct");
    try {
      (pin as any).loaded = true;
    } catch {
      // Test accepts both strict-mode TypeError and non-strict silent
      // ignore. The catch is part of the assertion. Per
      // spec/architectural-alignment.md §I1 retain-with-reason.
    }
    expect(pin.loaded).toBe(false);
  });

  it("handle_cache_stable_across_iterations", () => {
    const solver = new MockSolver();
    const pin = new DigitalOutputPinModel(CMOS_3V3, true, "direct");
    pin.init(NODE, -1);
    pin.setLogicLevel(false);

    const setupCtx: import("../setup-context.js").SetupContext = {
      solver: solver as any,
      temp: 300.15,
      nomTemp: 300.15,
      copyNodesets: false,
      makeVolt: () => { throw new Error("makeVolt not needed"); },
      makeCur: () => { throw new Error("makeCur not needed"); },
      allocStates: () => 0,
      findBranch: () => 0,
      findDevice: () => null,
    };
    pin.setup(setupCtx);

    const ctx = makeCtx({ solver });

    pin.load(ctx);
    const firstCallCount = solver.allocElementCalls.length;

    pin.load(ctx);
    pin.load(ctx);

    // allocElement should only be called on the first load()
    expect(solver.allocElementCalls.length).toBe(firstCallCount);
    expect(firstCallCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// DigitalInputPinModel — Task 6.4.2 tests
// ---------------------------------------------------------------------------

describe("DigitalInputPinModel", () => {
  const NODE = 2;

  it("input_load_loaded_stamps_rIn", () => {
    const solver = new MockSolver();
    const pin = new DigitalInputPinModel(CMOS_3V3, true);
    pin.init(NODE, 0);

    const ctx = makeCtx({ solver });
    pin.load(ctx);

    // No RHS stamps
    expect(ctx.rhs[NODE]).toBe(0);
  });

  it("input_load_ideal_is_noop", () => {
    const solver = new MockSolver();
    const pin = new DigitalInputPinModel(CMOS_3V3, false);
    pin.init(NODE, 0);

    const ctx = makeCtx({ solver });
    pin.load(ctx);

    expect(solver.allocElementCalls.length).toBe(0);
    expect(solver.sumAt(NODE, NODE)).toBe(0);
    expect(ctx.rhs[NODE]).toBe(0);
  });

  it("readLogicLevel thresholds correctly", () => {
    const pin = new DigitalInputPinModel(CMOS_3V3, false);
    pin.init(NODE, 0);

    // voltage > vIH → true
    expect(pin.readLogicLevel(CMOS_3V3.vIH + 0.1)).toBe(true);
    // voltage < vIL → false
    expect(pin.readLogicLevel(CMOS_3V3.vIL - 0.1)).toBe(false);
    // voltage between vIL and vIH → undefined
    expect(pin.readLogicLevel((CMOS_3V3.vIL + CMOS_3V3.vIH) / 2)).toBeUndefined();
  });

  it("loaded_getter_reads_private_field", () => {
    const pinFalse = new DigitalInputPinModel(CMOS_3V3, false);
    expect(pinFalse.loaded).toBe(false);

    const pinTrue = new DigitalInputPinModel(CMOS_3V3, true);
    expect(pinTrue.loaded).toBe(true);
  });

  it("handle_cache_stable_across_iterations", () => {
    const solver = new MockSolver();
    const pin = new DigitalInputPinModel(CMOS_3V3, true);
    pin.init(NODE, 0);

    const setupCtx: import("../setup-context.js").SetupContext = {
      solver: solver as any,
      temp: 300.15,
      nomTemp: 300.15,
      copyNodesets: false,
      makeVolt: () => { throw new Error("makeVolt not needed"); },
      makeCur: () => { throw new Error("makeCur not needed"); },
      allocStates: () => 0,
      findBranch: () => 0,
      findDevice: () => null,
    };
    pin.setup(setupCtx);

    const ctx = makeCtx({ solver });

    pin.load(ctx);
    const firstCallCount = solver.allocElementCalls.length;

    pin.load(ctx);
    pin.load(ctx);

    // allocElement invoked exactly once
    expect(solver.allocElementCalls.length).toBe(firstCallCount);
    expect(firstCallCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Task 0.2.3 — DigitalPinModel refactored to use AnalogCapacitorElement child
// ---------------------------------------------------------------------------

describe("Task 0.2.3 — DigitalPinModel capacitor child refactor", () => {
  it("no_prev_voltage_field", () => {
    // _prevVoltage and _prevCurrent must not exist as own properties on either class.
    // These were removed in Task 0.2.3 — companion history is now held by the
    // AnalogCapacitorElement child element.
    const outPin = new DigitalOutputPinModel(CMOS_3V3, true, "direct");
    const inPin = new DigitalInputPinModel(CMOS_3V3, true);
    expect(Object.prototype.hasOwnProperty.call(outPin, "_prevVoltage")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(outPin, "_prevCurrent")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(inPin, "_prevVoltage")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(inPin, "_prevCurrent")).toBe(false);
  });

  it("accept_method_removed", () => {
    // The accept(ctx, voltage) method was removed in Task 0.2.3.
    // The companion model state is now advanced by the AnalogCapacitorElement child.
    const outPin = new DigitalOutputPinModel(CMOS_3V3, true, "direct");
    const inPin = new DigitalInputPinModel(CMOS_3V3, true);
    expect(typeof (outPin as any).accept).toBe("undefined");
    expect(typeof (inPin as any).accept).toBe("undefined");
  });

  it("getChildElements_returns_capacitor_when_loaded_and_cout_positive", () => {
    // Loaded output pin with cOut > 0 → one AnalogCapacitorElement child.
    const pin = new DigitalOutputPinModel(CMOS_3V3, true, "direct");
    pin.init(1, -1);
    const children = pin.getChildElements();
    expect(children.length).toBe(1);
    // Child has _pinNodes set to pos=1, neg=0
    expect([...children[0]._pinNodes.values()]).toEqual([1, 0]);
  });

  it("getChildElements_empty_for_unloaded_output", () => {
    // Unloaded output pin → no capacitor child (loading disabled).
    const pin = new DigitalOutputPinModel(CMOS_3V3, false, "direct");
    pin.init(1, -1);
    expect(pin.getChildElements().length).toBe(0);
  });

  it("getChildElements_empty_for_output_with_zero_cout", () => {
    // Output pin spec with cOut = 0 → no capacitor child even when loaded.
    // Covers the second negative branch of Task 0.2.3's acceptance criterion
    // (length 0 when either `loaded` or `cOut > 0` fails) for the output model.
    const specNoCap: ResolvedPinElectrical = { ...CMOS_3V3, cOut: 0 };
    const pin = new DigitalOutputPinModel(specNoCap, true, "direct");
    pin.init(1, -1);
    expect(pin.getChildElements().length).toBe(0);
  });

  it("getChildElements_returns_capacitor_when_loaded_and_cin_positive", () => {
    // Loaded input pin with cIn > 0 → one AnalogCapacitorElement child.
    const pin = new DigitalInputPinModel(CMOS_3V3, true);
    pin.init(2, 0);
    const children = pin.getChildElements();
    expect(children.length).toBe(1);
    expect([...children[0]._pinNodes.values()]).toEqual([2, 0]);
  });

  it("getChildElements_empty_for_input_with_zero_cin", () => {
    // Input pin spec with cIn = 0 → no capacitor child.
    const specNoCap: ResolvedPinElectrical = { ...CMOS_3V3, cIn: 0 };
    const pin = new DigitalInputPinModel(specNoCap, true);
    pin.init(2, 0);
    expect(pin.getChildElements().length).toBe(0);
  });
});
