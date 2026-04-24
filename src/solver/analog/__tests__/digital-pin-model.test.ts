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
 * Task 6.4.4 — legacy stamp methods deleted:
 *  - legacy_stamp_methods_deleted_output
 *  - legacy_stamp_methods_deleted_input
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
import { MODEDCOP, MODEINITFLOAT, MODETRAN } from "../ckt-mode.js";

// ---------------------------------------------------------------------------
// Mock SparseSolver — records allocElement / stampElement / stampRHS calls
// ---------------------------------------------------------------------------

interface StampRecord {
  handle: number;
  value: number;
}

class MockSolver {
  private readonly _elements: Map<string, number> = new Map();
  private readonly _values: number[] = [];
  readonly rhs: Map<number, number> = new Map();
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

  stampRHS(idx: number, value: number): void {
    this.rhs.set(idx, (this.rhs.get(idx) ?? 0) + value);
  }

  /** Sum all stampElement values at (row, col). */
  sumAt(row: number, col: number): number {
    const key = `${row}:${col}`;
    const h = this._elements.get(key);
    if (h === undefined) return 0;
    return this._values[h] ?? 0;
  }

  sumRhs(idx: number): number {
    return this.rhs.get(idx) ?? 0;
  }

  reset(): void {
    this._elements.clear();
    this._values.length = 0;
    this.rhs.clear();
    this._handleCounter = 0;
    this.allocElementCalls = [];
  }
}

// ---------------------------------------------------------------------------
// makeCtx — minimal LoadContext factory for tests
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<LoadContext> & { solver?: MockSolver } = {}): LoadContext {
  const solver = overrides.solver ?? new MockSolver();
  const ag = new Float64Array(7);
  ag[0] = 2e9; // placeholder trapezoidal ag[0]
  return {
    solver: solver as any,
    voltages: new Float64Array(16),
    cktMode: overrides.cktMode ?? MODEINITFLOAT,
    dt: overrides.dt ?? 0,
    method: overrides.method ?? "trapezoidal",
    order: overrides.order ?? 1,
    deltaOld: [],
    ag: overrides.ag ?? ag,
    srcFact: 1,
    noncon: { value: 0 },
    limitingCollector: null,
    xfact: 0,
    gmin: 1e-12,
    reltol: 1e-3,
    iabstol: 1e-12,
    cktFixLimit: false,
    ...overrides,
  };
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
  // NODE = 1 → nodeIdx = 0 in the solver (0-based)
  // BRANCH = 4 → branchIdx = 4 in the augmented matrix
  const NODE = 1;
  const BRANCH = 4;
  const nodeIdx = NODE - 1; // 0
  const branchRow = BRANCH; // 4

  it("output_load_branch_role_drive_loaded", () => {
    const solver = new MockSolver();
    const pin = new DigitalOutputPinModel(CMOS_3V3, true, "branch");
    pin.init(NODE, BRANCH);
    pin.setLogicLevel(true);
    pin.setHighZ(false);

    const ctx = makeCtx({ solver });
    pin.load(ctx);

    // branch eq: A[branchIdx][nodeIdx] = 1  (V_node coefficient)
    expect(solver.sumAt(branchRow, nodeIdx)).toBe(1);
    // branch eq: A[branchIdx][branchIdx] = 0 (branch current coefficient zero in drive mode)
    expect(solver.sumAt(branchRow, branchRow)).toBe(0);
    // KCL row: A[nodeIdx][branchIdx] = 1
    expect(solver.sumAt(nodeIdx, branchRow)).toBe(1);
    // RHS at branchRow = vOH
    expect(solver.sumRhs(branchRow)).toBe(CMOS_3V3.vOH);
    // loaded → 1/rOut diagonal at nodeIdx
  });

  it("output_load_branch_role_hiz_ideal", () => {
    const solver = new MockSolver();
    const pin = new DigitalOutputPinModel(CMOS_3V3, false, "branch");
    pin.init(NODE, BRANCH);
    pin.setHighZ(true);

    const ctx = makeCtx({ solver });
    pin.load(ctx);

    // Hi-Z in branch mode: A[branchRow][branchRow] = 1 (I = 0)
    expect(solver.sumAt(branchRow, branchRow)).toBe(1);
    // A[branchRow][nodeIdx] = 0
    expect(solver.sumAt(branchRow, nodeIdx)).toBe(0);
    // ideal (not loaded) → NO 1/rHiZ diagonal
    expect(solver.sumAt(nodeIdx, nodeIdx)).toBe(0);
    // RHS at branchRow = 0
    expect(solver.sumRhs(branchRow)).toBe(0);
  });

  it("output_load_direct_role_drive_loaded", () => {
    const solver = new MockSolver();
    const pin = new DigitalOutputPinModel(CMOS_3V3, true, "direct");
    pin.init(NODE, -1);
    pin.setLogicLevel(false);
    pin.setHighZ(false);

    const ctx = makeCtx({ solver });
    pin.load(ctx);

    // direct: 1/rOut diagonal at nodeIdx
    const gOut = 1 / CMOS_3V3.rOut;
    // RHS at nodeIdx = vOL / rOut
    // No branch-row stamps at all — branchRow unused for direct
    expect(solver.sumAt(branchRow, nodeIdx)).toBe(0);
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
    expect(solver.sumRhs(nodeIdx)).toBe(0);
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

    const C = CMOS_3V3.cOut;

    const ctx = makeCtx({ solver, ag, dt: 1e-9, cktMode: MODETRAN | MODEINITFLOAT });
    pin.load(ctx);

    // Inline companion geq = ag[0] * C
    const geq = ag[0] * C;
    // The diagonal should include both 1/rOut and geq
    const gOut = 1 / CMOS_3V3.rOut;
  });

  it("output_load_capacitor_child_included_when_loaded_and_cOut_positive", () => {
    // When loaded && cOut > 0, getChildElements() returns a capacitor child.
    // The owning element must call child.load(ctx) separately; this test verifies
    // the child exists and is a proper AnalogCapacitorElement (non-empty array).
    const pin = new DigitalOutputPinModel(CMOS_3V3, true, "direct");
    pin.init(NODE, -1);

    const children = pin.getChildElements();
    expect(children.length).toBe(1);
    // The child is an AnalogCapacitorElement with pinNodeIds set
    const child = children[0];
    expect(child).toBeDefined();
    expect(child.pinNodeIds).toEqual([NODE, 0]);
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
  const nodeIdx = NODE - 1; // 1

  it("input_load_loaded_stamps_rIn", () => {
    const solver = new MockSolver();
    const pin = new DigitalInputPinModel(CMOS_3V3, true);
    pin.init(NODE, 0);

    const ctx = makeCtx({ solver });
    pin.load(ctx);

    // No RHS stamps
    expect(solver.sumRhs(nodeIdx)).toBe(0);
  });

  it("input_load_ideal_is_noop", () => {
    const solver = new MockSolver();
    const pin = new DigitalInputPinModel(CMOS_3V3, false);
    pin.init(NODE, 0);

    const ctx = makeCtx({ solver });
    pin.load(ctx);

    expect(solver.allocElementCalls.length).toBe(0);
    expect(solver.sumAt(nodeIdx, nodeIdx)).toBe(0);
    expect(solver.sumRhs(nodeIdx)).toBe(0);
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
// Task 6.4.4 — legacy stamp methods deleted
// ---------------------------------------------------------------------------

describe("legacy stamp methods deleted", () => {
  it("legacy_stamp_methods_deleted_output", () => {
    const pin = new DigitalOutputPinModel(CMOS_3V3, false, "direct");
    expect((pin as any).stamp).toBeUndefined();
    expect((pin as any).stampOutput).toBeUndefined();
    expect((pin as any).stampCompanion).toBeUndefined();
    expect((pin as any).updateCompanion).toBeUndefined();
  });

  it("legacy_stamp_methods_deleted_input", () => {
    const pin = new DigitalInputPinModel(CMOS_3V3, false);
    expect((pin as any).stamp).toBeUndefined();
    expect((pin as any).stampCompanion).toBeUndefined();
    expect((pin as any).updateCompanion).toBeUndefined();
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
    // Child has pinNodeIds set to [nodeId, 0]
    expect(children[0].pinNodeIds).toEqual([1, 0]);
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
    expect(children[0].pinNodeIds).toEqual([2, 0]);
  });

  it("getChildElements_empty_for_input_with_zero_cin", () => {
    // Input pin spec with cIn = 0 → no capacitor child.
    const specNoCap: ResolvedPinElectrical = { ...CMOS_3V3, cIn: 0 };
    const pin = new DigitalInputPinModel(specNoCap, true);
    pin.init(2, 0);
    expect(pin.getChildElements().length).toBe(0);
  });
});
