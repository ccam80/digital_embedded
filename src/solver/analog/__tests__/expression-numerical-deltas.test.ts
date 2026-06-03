/**
 * ngspice PTexp/PTlog/PTlog10 clamps, hyperbolic function set, and the PTF_TAN /
 * PTF_TANH derivative corrections, asserted directly against the scalar ngspice
 * contract.
 *
 * The clamped exp/log/log10 (ptfuncs.c:273-304) live in one shared
 * BUILTIN_FUNCTIONS map that both runtime evaluators resolve through, so each
 * clamp assertion is checked on both the expression.ts path (evaluateExpression,
 * used by the ASRC sources) and the expression-evaluate.ts path (evaluate).
 */

import { describe, it, expect } from "vitest";
import { parseExpression, evaluateExpression } from "../expression.js";
import { evaluate } from "../expression-evaluate.js";
import { differentiate, simplify } from "../expression-differentiate.js";
import { parseSpiceValue } from "../model-parser.js";

function mkCtx(vars: Record<string, number> = {}) {
  return {
    getNodeVoltage: (label: string) => {
      if (label in vars) return vars[label];
      throw new Error(`Unknown node ${label}`);
    },
    getBranchCurrent: (label: string) => {
      if (label in vars) return vars[label];
      throw new Error(`Unknown branch ${label}`);
    },
    time: vars["time"] ?? 0,
    freq: vars["freq"],
    variables: vars,
  };
}

// ===========================================================================
// Delta 1 — PTexp overflow ceiling (ptfuncs.c:273-281)
// ===========================================================================

describe("PTexp overflow ceiling", () => {
  it("returns 1e99 for arg > 227.9559242 on the expression.ts path", () => {
    expect(evaluateExpression(parseExpression("exp(228)"), {})).toBe(1e99);
    expect(evaluateExpression(parseExpression("exp(300)"), {})).toBe(1e99);
  });

  it("returns 1e99 for arg > 227.9559242 on the expression-evaluate.ts path", () => {
    expect(evaluate(parseExpression("exp(228)"), mkCtx())).toBe(1e99);
    expect(evaluate(parseExpression("exp(300)"), mkCtx())).toBe(1e99);
  });

  it("returns Math.exp below the threshold on both paths", () => {
    expect(evaluateExpression(parseExpression("exp(227)"), {})).toBe(Math.exp(227));
    expect(evaluate(parseExpression("exp(227)"), mkCtx())).toBe(Math.exp(227));
  });
});

// ===========================================================================
// Delta 2 — PTlog / PTlog10 domain clamps (ptfuncs.c:286-304)
// ===========================================================================

describe("PTlog / PTlog10 domain clamps", () => {
  it("log: <0 -> +Infinity, 0 -> -1e99, else library", () => {
    expect(evaluateExpression(parseExpression("log(0)"), {})).toBe(-1e99);
    expect(evaluate(parseExpression("log(0)"), mkCtx())).toBe(-1e99);
    expect(evaluateExpression(parseExpression("log(-1)"), {})).toBe(Number.POSITIVE_INFINITY);
    expect(evaluate(parseExpression("log(-1)"), mkCtx())).toBe(Number.POSITIVE_INFINITY);
    expect(evaluateExpression(parseExpression("log(10)"), {})).toBe(Math.log(10));
  });

  it("log10: <0 -> +Infinity, 0 -> -1e99, else library", () => {
    expect(evaluateExpression(parseExpression("log10(0)"), {})).toBe(-1e99);
    expect(evaluate(parseExpression("log10(0)"), mkCtx())).toBe(-1e99);
    expect(evaluateExpression(parseExpression("log10(-1)"), {})).toBe(Number.POSITIVE_INFINITY);
    expect(evaluate(parseExpression("log10(-1)"), mkCtx())).toBe(Number.POSITIVE_INFINITY);
    expect(evaluateExpression(parseExpression("log10(1000)"), {})).toBe(Math.log10(1000));
  });
});

// ===========================================================================
// Delta 6 — hyperbolic function set sinh / cosh / tanh (ptfuncs.c:263-336)
// ===========================================================================

describe("hyperbolic function set", () => {
  it("sinh/cosh/tanh evaluate as bare library calls on both paths", () => {
    expect(evaluateExpression(parseExpression("sinh(1.3)"), {})).toBe(Math.sinh(1.3));
    expect(evaluate(parseExpression("sinh(1.3)"), mkCtx())).toBe(Math.sinh(1.3));
    expect(evaluateExpression(parseExpression("cosh(1.3)"), {})).toBe(Math.cosh(1.3));
    expect(evaluate(parseExpression("cosh(1.3)"), mkCtx())).toBe(Math.cosh(1.3));
    expect(evaluateExpression(parseExpression("tanh(1.3)"), {})).toBe(Math.tanh(1.3));
    expect(evaluate(parseExpression("tanh(1.3)"), mkCtx())).toBe(Math.tanh(1.3));
  });
});

// ===========================================================================
// Delta 3 / Delta 4 — PTF_TAN and PTF_TANH derivative corrections
// (inpptree.c:508-520)
// ===========================================================================

describe("derivative corrections", () => {
  it("d/dx tan(x) builds and evaluates 1 + tan(x)^2", () => {
    const xs = [0.0, 0.3, 1.0, -0.7];
    for (const x of xs) {
      const d = evaluate(differentiate(parseExpression("tan(x)"), "x"), mkCtx({ x }));
      expect(d).toBe(1 + Math.tan(x) ** 2);
    }
  });

  it("d/dx tanh(x) builds and evaluates 1 - tanh(x)^2", () => {
    const xs = [0.0, 0.3, 1.0, -0.7];
    for (const x of xs) {
      const d = evaluate(differentiate(parseExpression("tanh(x)"), "x"), mkCtx({ x }));
      expect(d).toBe(1 - Math.tanh(x) ** 2);
    }
  });

  it("d/dx sinh(x) = cosh(x), d/dx cosh(x) = sinh(x)", () => {
    const xs = [0.0, 0.3, 1.0, -0.7];
    for (const x of xs) {
      const ds = evaluate(differentiate(parseExpression("sinh(x)"), "x"), mkCtx({ x }));
      expect(ds).toBe(Math.cosh(x));
      const dc = evaluate(differentiate(parseExpression("cosh(x)"), "x"), mkCtx({ x }));
      expect(dc).toBe(Math.sinh(x));
    }
  });
});

// ===========================================================================
// Acceptance criterion 3(iii) — simplify() constant-fold uses the shared clamp
// ===========================================================================

describe("simplify constant-fold through the shared clamped map", () => {
  it("folds exp(300) to 1e99, not Infinity", () => {
    const folded = simplify(parseExpression("exp(300)"));
    expect(folded).toEqual({ kind: "number", value: 1e99 });
  });

  it("folds log(0) to -1e99 and log(-1) to +Infinity", () => {
    expect(simplify(parseExpression("log(0)"))).toEqual({ kind: "number", value: -1e99 });
    expect(simplify(parseExpression("log(-1)"))).toEqual({
      kind: "number",
      value: Number.POSITIVE_INFINITY,
    });
  });
});

// ===========================================================================
// Delta 5 — atto suffix (model-parser.ts SPICE_SUFFIXES)
// ===========================================================================

describe("atto metric suffix", () => {
  it("parseSpiceValue('1a') === 1e-18", () => {
    expect(parseSpiceValue("1a")).toBe(1e-18);
  });
});
