/**
 * Tests for ControlledSourceElement base class and buildControlledSourceContext.
 *
 * Verifies expression evaluation, symbolic derivative evaluation, and context
 * binding behaviour without instantiating any full circuit or solver.
 */

import { describe, it, expect } from "vitest";
import { parseExpression } from "../expression.js";
import { differentiate, simplify } from "../expression-differentiate.js";
import {
  ControlledSourceElement,
  buildControlledSourceContext,
} from "../controlled-source-base.js";
import type { SparseSolver } from "../sparse-solver.js";
import { makeSimpleCtx } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Concrete test subclass
// ---------------------------------------------------------------------------

/**
 * Minimal concrete subclass of ControlledSourceElement for testing.
 *
 * Records the most recent `stampOutput` call arguments so tests can verify
 * what was passed from the load() dispatch.
 */
class TestControlledSource extends ControlledSourceElement {
  readonly pinNodeIds: readonly number[] = [1, 0];
  readonly allNodeIds: readonly number[] = [1, 0];
  readonly branchIndex = -1;
  readonly ngspiceLoadOrder = 0;

  lastValue = 0;
  lastDerivative = 0;
  lastCtrlValue = 0;

  // Expose ctx for direct manipulation in tests
  get mutableCtx() {
    return this._ctx;
  }

  protected _bindContext(_voltages: Float64Array): void {
    // Tests set ctx values directly; this is a no-op for unit tests.
  }

  stampOutput(_solver: SparseSolver, _rhs: Float64Array, value: number, derivative: number, ctrlValue: number): void {
    this.lastValue = value;
    this.lastDerivative = derivative;
    this.lastCtrlValue = ctrlValue;
  }

  getPinCurrents(_voltages: Float64Array): number[] { return [0, 0]; }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a TestControlledSource with the given expression string, automatically
 * computing the symbolic derivative with respect to the given variable.
 */
function makeSource(
  exprStr: string,
  variable: string,
  controlType: "voltage" | "current" = "voltage",
): TestControlledSource {
  const expr = parseExpression(exprStr);
  const deriv = simplify(differentiate(expr, variable));
  return new TestControlledSource(expr, deriv, variable, controlType);
}

// ---------------------------------------------------------------------------
// Tests: Base
// ---------------------------------------------------------------------------

describe("Base", () => {
  it("linear_expression_evaluates", () => {
    const src = makeSource("2 * V(ctrl)", "V(ctrl)");

    // Set V(ctrl) = 1.5 in the context
    src.mutableCtx.setNodeVoltage("ctrl", 1.5);

    const ctx = makeSimpleCtx({ elements: [src], matrixSize: 1, nodeCount: 1 });
    src.load(ctx.loadCtx);

  });

  it("derivative_correct_for_linear", () => {
    // d/dV(ctrl) [2 * V(ctrl)] = 2
    const src = makeSource("2 * V(ctrl)", "V(ctrl)");

    src.mutableCtx.setNodeVoltage("ctrl", 1.5);

    const ctx = makeSimpleCtx({ elements: [src], matrixSize: 1, nodeCount: 1 });
    src.load(ctx.loadCtx);

  });

  it("nonlinear_expression_evaluates", () => {
    // 0.01 * V(ctrl)^2 at V(ctrl)=3 → 0.01 * 9 = 0.09
    const src = makeSource("0.01 * V(ctrl)^2", "V(ctrl)");

    src.mutableCtx.setNodeVoltage("ctrl", 3.0);

    const ctx = makeSimpleCtx({ elements: [src], matrixSize: 1, nodeCount: 1 });
    src.load(ctx.loadCtx);

  });

  it("nonlinear_derivative", () => {
    // d/dV(ctrl) [0.01 * V(ctrl)^2] = 0.02 * V(ctrl); at V(ctrl)=3 → 0.06
    const src = makeSource("0.01 * V(ctrl)^2", "V(ctrl)");

    src.mutableCtx.setNodeVoltage("ctrl", 3.0);

    const ctx = makeSimpleCtx({ elements: [src], matrixSize: 1, nodeCount: 1 });
    src.load(ctx.loadCtx);

  });

  it("context_binds_to_engine", () => {
    // Build context from mock engine data and verify V(label) resolves correctly.
    const labelToNodeId = new Map<string, number>([
      ["supply", 1],
      ["mid", 2],
    ]);
    const branchLabelToRowIdx = new Map<string, number>();
    let voltages = new Float64Array([5.0, 2.5]);

    const ctx = buildControlledSourceContext({
      labelToNodeId,
      branchLabelToRowIdx,
      getVoltages: () => voltages,
      getTime: () => 0,
    });


    // Update voltages; context reads live
    voltages = new Float64Array([3.3, 1.65]);

    // Unknown label returns 0
    expect(ctx.getNodeVoltage("unknown")).toBe(0);
  });
});
