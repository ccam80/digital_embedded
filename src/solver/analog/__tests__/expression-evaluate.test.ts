/**
 * Tests for the extended expression evaluator (ExpressionContext, evaluate, compileExpression).
 */

import { describe, it, expect } from "vitest";
import { parseExpression } from "../expression.js";
import { evaluate, compileExpression } from "../expression-evaluate.js";
import type { ExpressionContext } from "../expression-evaluate.js";

// ---------------------------------------------------------------------------
// Helper: build a minimal ExpressionContext
// ---------------------------------------------------------------------------

function mkCtx(opts: {
  voltages?: Record<string, number>;
  currents?: Record<string, number>;
  time?: number;
  freq?: number;
}): ExpressionContext {
  const ctx: ExpressionContext = {
    getNodeVoltage: (label) => {
      const v = opts.voltages?.[label];
      if (v === undefined) throw new Error(`Unknown node voltage: ${label}`);
      return v;
    },
    getBranchCurrent: (label) => {
      const i = opts.currents?.[label];
      if (i === undefined) throw new Error(`Unknown branch current: ${label}`);
      return i;
    },
    time: opts.time ?? 0,
  };
  if (opts.freq !== undefined) ctx.freq = opts.freq;
  return ctx;
}

// ===========================================================================
// Evaluate tests
// ===========================================================================

describe("Evaluate", () => {
  it("v_function_resolves — V(R1)*2 with V(R1)=3.3 gives 6.6", () => {
    const expr = parseExpression("V(R1) * 2");
    const ctx = mkCtx({ voltages: { R1: 3.3 } });
  });

  it("i_function_resolves — I(R1) with I(R1)=0.005 gives 0.005", () => {
    const expr = parseExpression("I(R1)");
    const ctx = mkCtx({ currents: { R1: 0.005 } });
  });

  it("time_variable — sin(2*pi*1000*time) at time=0.00025 ≈ 1.0", () => {
    const expr = parseExpression("sin(2 * pi * 1000 * time)");
    const ctx = mkCtx({ time: 0.00025 });
  });

  it("freq_variable — freq at 1kHz gives 1000", () => {
    const expr = parseExpression("freq");
    const ctx = mkCtx({ freq: 1000 });
    expect(evaluate(expr, ctx)).toBe(1000);
  });

  it("freq_undefined_defaults_to_zero — freq with no freq in context gives 0", () => {
    const expr = parseExpression("freq");
    const ctx = mkCtx({});
    expect(evaluate(expr, ctx)).toBe(0);
  });

  it("compiled_matches_interpreted — same result from evaluate and compileExpression", () => {
    const exprText = "V(in) * 2 + sin(time * 1000)";
    const expr = parseExpression(exprText);
    const ctx = mkCtx({ voltages: { in: 1.5 }, time: 0.001 });
    const interpreted = evaluate(expr, ctx);
    const compiled = compileExpression(expr);
  });

  it("arithmetic_still_works — 2+3*4 = 14 via extended evaluator", () => {
    const expr = parseExpression("2 + 3 * 4");
    const ctx = mkCtx({});
    expect(evaluate(expr, ctx)).toBe(14);
  });

  it("builtin_constants_available — pi evaluates to Math.PI", () => {
    const expr = parseExpression("pi");
    const ctx = mkCtx({});
  });

  it("builtin_functions_available — sin(pi/2) = 1", () => {
    const expr = parseExpression("sin(pi / 2)");
    const ctx = mkCtx({});
  });

  it("circuit_voltage_in_complex_expr — 0.01 * V(ctrl)^2 at V(ctrl)=3 gives 0.09", () => {
    const expr = parseExpression("0.01 * V(ctrl) ^ 2");
    const ctx = mkCtx({ voltages: { ctrl: 3 } });
  });

  it("circuit_current_in_complex_expr — 100 * I(sense) at I(sense)=0.02 gives 2", () => {
    const expr = parseExpression("100 * I(sense)");
    const ctx = mkCtx({ currents: { sense: 0.02 } });
  });
});

// ===========================================================================
// compileExpression tests
// ===========================================================================

describe("compileExpression", () => {
  it("returns a function", () => {
    const expr = parseExpression("1 + 2");
    expect(typeof compileExpression(expr)).toBe("function");
  });

  it("compiled_constant — 42 compiles to function returning 42", () => {
    const fn = compileExpression(parseExpression("42"));
    const ctx = mkCtx({});
    expect(fn(ctx)).toBe(42);
  });

  it("compiled_v_function — V(A) resolves via context each call", () => {
    const fn = compileExpression(parseExpression("V(A)"));
    const ctx1 = mkCtx({ voltages: { A: 1.0 } });
    const ctx2 = mkCtx({ voltages: { A: 5.0 } });
    expect(fn(ctx1)).toBe(1.0);
    expect(fn(ctx2)).toBe(5.0);
  });

  it("compiled_time — time variable resolves from context each call", () => {
    const fn = compileExpression(parseExpression("time"));
    expect(fn(mkCtx({ time: 0.001 }))).toBe(0.001);
    expect(fn(mkCtx({ time: 0.002 }))).toBe(0.002);
  });

  it("compiled_matches_interpreted_for_all_ops", () => {
    const exprs = [
      "2 + 3 * 4",
      "sin(pi / 2)",
      "exp(1)",
      "sqrt(16)",
      "V(x) ^ 2",
    ];
    const ctx = mkCtx({ voltages: { x: 3.0 }, time: 0.5 });
    for (const text of exprs) {
      const expr = parseExpression(text);
      const interpreted = evaluate(expr, ctx);
      const compiled = compileExpression(expr);
    }
  });
});
