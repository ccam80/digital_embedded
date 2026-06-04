/**
 * Runtime evaluator for the extended expression AST.
 *
 * Handles the full ExprNode union including circuit-voltage, circuit-current,
 * builtin-var (time, freq), and builtin-func (random) nodes introduced in
 * Phase 5. Provides both a tree-walking interpreter and a compiled closure
 * for hot-path evaluation.
 */

import type { ExprNode } from "./expression.js";
import { UnknownNodeKindError, BUILTIN_FUNCTIONS, BSOURCE_FUNCTIONS } from "./expression.js";

/** ngspice CONSTCtoK (const.h): Celsius↔Kelvin offset used by `temper`
 *  (ifeval.c:177 `CKTtemp - CONSTCtoK`). */
export const CONSTCtoK = 273.15;

// ---------------------------------------------------------------------------
// ExpressionContext
// ---------------------------------------------------------------------------

/**
 * Runtime binding context supplied to the evaluator during simulation.
 * Resolves circuit quantities and simulation state for V(), I(), time, freq.
 */
export interface ExpressionContext {
  /** Returns the voltage at the node identified by label. */
  getNodeVoltage(label: string): number;
  /** Returns the branch current flowing through the element identified by label. */
  getBranchCurrent(label: string): number;
  /** Current simulation time in seconds. */
  time: number;
  /** Frequency for AC analysis in Hz. Undefined during transient/DC. */
  freq?: number;
  /**
   * Optional map of plain named variables (e.g. parameter sweeps, symbolic
   * differentiation evaluation). Looked up for `variable` nodes after
   * built-in constants.
   */
  variables?: Record<string, number>;
  /**
   * Circuit temperature in Kelvin (ngspice CKTtemp). Read by the `temper`
   * builtin-var as `temp - CONSTCtoK` (ifeval.c:177). Undefined ⇒ 0 K fallback;
   * only the B-source eval path sets it.
   */
  temp?: number;
  /**
   * The `/`-operator perturbation floor (ngspice PTfudge_factor = gmin*1e-20,
   * ptfuncs.c:54-66). Defaults to 0 outside a B-source eval, so a non-B `/`
   * is the bare IEEE divide bit-identically. Only `buildBSourceTree`'s eval
   * sets it.
   */
  bsourceFudge?: number;
  /**
   * True when MODETRAN is active (ngspice CKTmode & MODETRAN). Gates the `ddt`
   * transient-derivative (ptfuncs.c:437); 0 outside transient.
   */
  modeTran?: boolean;
}

/**
 * ngspice PTdivide (ptfuncs.c:54-66): perturb the denominator away from zero by
 * `fudge` (PTfudge_factor) before dividing; an exact zero after the
 * perturbation returns HUGE (IEEE +∞). With `fudge === 0` this is the bare
 * IEEE divide, so non-B-source `/` is unchanged.
 */
function ptDivide(num: number, den: number, fudge: number): number {
  const d = den >= 0.0 ? den + fudge : den - fudge;
  if (d === 0.0) return Number.POSITIVE_INFINITY;
  return num / d;
}

// ---------------------------------------------------------------------------
// Built-in constants (math functions resolve through the shared, clamped
// BUILTIN_FUNCTIONS imported from expression.ts)
// ---------------------------------------------------------------------------

const BUILTIN_CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

/**
 * Evaluate an ExprNode AST given a runtime context.
 *
 * Handles all node types including the Phase 5 extensions (circuit-voltage,
 * circuit-current, builtin-var, builtin-func). Built-in constants (pi, e) are
 * always available; variable nodes look up in BUILTIN_CONSTANTS first.
 *
 * Throws UnknownNodeKindError for any unrecognized node kind.
 */
export function evaluate(expr: ExprNode, ctx: ExpressionContext): number {
  switch (expr.kind) {
    case "number":
      return expr.value;

    case "variable": {
      const name = expr.name;
      if (name in BUILTIN_CONSTANTS) {
        return BUILTIN_CONSTANTS[name];
      }
      if (ctx.variables !== undefined && name in ctx.variables) {
        return ctx.variables[name];
      }
      throw new Error(`Undefined variable "${name}"- use ExpressionContext for runtime bindings`);
    }

    case "unary":
      return -evaluate(expr.operand, ctx);

    case "binary": {
      const left = evaluate(expr.left, ctx);
      const right = evaluate(expr.right, ctx);
      switch (expr.op) {
        case "+": return left + right;
        case "-": return left - right;
        case "*": return left * right;
        case "/": return left / right;
        case "^": return Math.pow(left, right);
      }
    }

    case "call": {
      const fn = expr.fn;
      const impl = BUILTIN_FUNCTIONS[fn];
      if (impl === undefined) {
        throw new Error(`Unknown function "${fn}"`);
      }
      const args = expr.args.map((a) => evaluate(a, ctx));
      return impl(...args);
    }

    case "circuit-voltage":
      return ctx.getNodeVoltage(expr.label);

    case "circuit-current":
      return ctx.getBranchCurrent(expr.label);

    case "builtin-var":
      if (expr.name === "time") return ctx.time;
      if (expr.name === "freq") return ctx.freq ?? 0;
      // ngspice PT_TEMPERATURE: CKTtemp (Kelvin) minus CONSTCtoK (ifeval.c:177).
      if (expr.name === "temper") return (ctx.temp ?? 0) - CONSTCtoK;
      throw new UnknownNodeKindError((expr as { name: string }).name);

    case "builtin-func":
      if (expr.name === "random") return Math.random();
      throw new UnknownNodeKindError((expr as { name: string }).name);

    case "ternary": {
      // ngspice PT_TERN selects by `cond != 0` (ifeval.c:145).
      return evaluate(expr.cond, ctx) !== 0
        ? evaluate(expr.then, ctx)
        : evaluate(expr.else, ctx);
    }

    case "ddt":
      return evalDdt(expr, evaluate(expr.arg, ctx), ctx);

    case "pwl":
      return evalPwl(expr.points, evaluate(expr.arg, ctx), expr.derivative);

    default: {
      const exhaustive: never = expr;
      throw new UnknownNodeKindError((exhaustive as ExprNode).kind);
    }
  }
}

/**
 * PTddt (ptfuncs.c:422-466): the transient backward-difference time derivative.
 * Returns 0 at `time==0` or outside transient. Otherwise, on each strictly-
 * advancing timestep it shifts the (t,v) history and returns the
 * `(v1-v3)/(t2-t4)` slope (ptfuncs.c:454). The 7-slot buffer layout matches
 * ngspice: vals[0]=t_now, [1]=v_now, [2]=t_prev, [3]=v_prev, [4]=t_prev2,
 * [5]=v_prev2, [6]=last slope.
 */
function evalDdt(
  node: { history: Float64Array; counter: { n: number } },
  arg: number,
  ctx: ExpressionContext,
): number {
  const v = node.history;
  const time = ctx.time;
  if (time === 0) {
    v[3] = arg;
    return 0;
  }
  if (!ctx.modeTran) return 0;
  if (time > v[0]!) {
    v[4] = v[2]!;
    v[5] = v[3]!;
    v[2] = v[0]!;
    v[3] = v[1]!;
    v[0] = time;
    v[1] = arg;
    if (node.counter.n > 1) {
      v[6] = (v[1]! - v[3]!) / (v[2]! - v[4]!);
    } else {
      v[6] = 0;
      v[3] = arg;
    }
    node.counter.n += 1;
  }
  return v[6]!;
}

/**
 * PTpwl / PTpwl_derivative (ptfuncs.c:345-392). `points` is the flat
 * [x0,y0,x1,y1,...] breakpoint array. A binary search locates the bracketing
 * segment [k0,k1]; the value path interpolates linearly (ptfuncs.c:362-364),
 * the derivative path returns the segment slope (ptfuncs.c:387-389).
 */
function evalPwl(points: number[], arg: number, derivative: boolean): number {
  const n = points.length; // == 2 * pointCount
  let k0 = 0;
  let k1 = n / 2 - 1;
  while (k1 - k0 > 1) {
    const k = (k0 + k1) >> 1;
    if (points[2 * k]! > arg) k1 = k;
    else k0 = k;
  }
  const x0 = points[2 * k0]!;
  const y0 = points[2 * k0 + 1]!;
  const x1 = points[2 * k1]!;
  const y1 = points[2 * k1 + 1]!;
  if (derivative) {
    return (y1 - y0) / (x1 - x0);
  }
  return y0 + (y1 - y0) * (arg - x0) / (x1 - x0);
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

/**
 * Compile an ExprNode AST into a closure for repeated evaluation.
 *
 * The returned function avoids repeated tree-walking on the hot path. The
 * compiled closure captures the AST structure at call sites and invokes the
 * same semantics as `evaluate()`.
 */
export function compileExpression(expr: ExprNode): (ctx: ExpressionContext) => number {
  switch (expr.kind) {
    case "number": {
      const v = expr.value;
      return () => v;
    }

    case "variable": {
      const name = expr.name;
      if (name in BUILTIN_CONSTANTS) {
        const v = BUILTIN_CONSTANTS[name];
        return () => v;
      }
      return (ctx) => {
        if (ctx.variables !== undefined && name in ctx.variables) {
          return ctx.variables[name];
        }
        throw new Error(`Undefined variable "${name}"`);
      };
    }

    case "unary": {
      const compiledOperand = compileExpression(expr.operand);
      return (ctx) => -compiledOperand(ctx);
    }

    case "binary": {
      const compiledLeft = compileExpression(expr.left);
      const compiledRight = compileExpression(expr.right);
      switch (expr.op) {
        case "+": return (ctx) => compiledLeft(ctx) + compiledRight(ctx);
        case "-": return (ctx) => compiledLeft(ctx) - compiledRight(ctx);
        case "*": return (ctx) => compiledLeft(ctx) * compiledRight(ctx);
        case "/": return (ctx) => compiledLeft(ctx) / compiledRight(ctx);
        case "^": return (ctx) => Math.pow(compiledLeft(ctx), compiledRight(ctx));
      }
    }

    case "call": {
      const fn = expr.fn;
      const impl = BUILTIN_FUNCTIONS[fn];
      if (impl === undefined) {
        return () => { throw new Error(`Unknown function "${fn}"`); };
      }
      const compiledArgs = expr.args.map(compileExpression);
      return (ctx) => impl(...compiledArgs.map((a) => a(ctx)));
    }

    case "circuit-voltage": {
      const label = expr.label;
      return (ctx) => ctx.getNodeVoltage(label);
    }

    case "circuit-current": {
      const label = expr.label;
      return (ctx) => ctx.getBranchCurrent(label);
    }

    case "builtin-var": {
      if (expr.name === "time") return (ctx) => ctx.time;
      if (expr.name === "freq") return (ctx) => ctx.freq ?? 0;
      if (expr.name === "temper") return (ctx) => (ctx.temp ?? 0) - CONSTCtoK;
      const name = expr.name;
      return () => { throw new UnknownNodeKindError(name); };
    }

    case "builtin-func": {
      if (expr.name === "random") return () => Math.random();
      const name = (expr as { name: string }).name;
      return () => { throw new UnknownNodeKindError(name); };
    }

    case "ternary": {
      const c = compileExpression(expr.cond);
      const t = compileExpression(expr.then);
      const e = compileExpression(expr.else);
      return (ctx) => (c(ctx) !== 0 ? t(ctx) : e(ctx));
    }

    case "ddt": {
      const a = compileExpression(expr.arg);
      const node = expr;
      return (ctx) => evalDdt(node, a(ctx), ctx);
    }

    case "pwl": {
      const a = compileExpression(expr.arg);
      const points = expr.points;
      const derivative = expr.derivative;
      return (ctx) => evalPwl(points, a(ctx), derivative);
    }

    default: {
      const exhaustive: never = expr;
      const kind = (exhaustive as ExprNode).kind;
      return () => { throw new UnknownNodeKindError(kind); };
    }
  }
}

// ---------------------------------------------------------------------------
// B-source compiler — the IFeval value/derivative closure path
// ---------------------------------------------------------------------------

/**
 * Compile an ExprNode for the B-source (`IFeval`) path. Identical tree-shape to
 * `compileExpression`, but routes function calls through `BSOURCE_FUNCTIONS`
 * (ngspice PTfuncs: range-reduced trig, `pow(fabs(a),b)`, the comparison /
 * step set, ...), applies the PTdivide gmin fudge on `/` (ptfuncs.c:54-66),
 * and dispatches `^` to PTpowerH (the `__pow_caret` key). Used by
 * `buildBSourceTree` for both the value tree and each per-variable derivative
 * tree, so the evaluated numbers match ngspice function-for-function.
 */
export function compileBSource(expr: ExprNode): (ctx: ExpressionContext) => number {
  switch (expr.kind) {
    case "number": {
      const v = expr.value;
      return () => v;
    }

    case "variable": {
      const name = expr.name;
      if (name in BUILTIN_CONSTANTS) {
        const v = BUILTIN_CONSTANTS[name];
        return () => v;
      }
      return (ctx) => {
        if (ctx.variables !== undefined && name in ctx.variables) {
          return ctx.variables[name];
        }
        throw new Error(`Undefined variable "${name}"`);
      };
    }

    case "unary": {
      const operand = compileBSource(expr.operand);
      return (ctx) => -operand(ctx);
    }

    case "binary": {
      const l = compileBSource(expr.left);
      const r = compileBSource(expr.right);
      switch (expr.op) {
        case "+": return (ctx) => l(ctx) + r(ctx);
        case "-": return (ctx) => l(ctx) - r(ctx);
        case "*": return (ctx) => l(ctx) * r(ctx);
        // ngspice PTdivide gmin fudge (ptfuncs.c:54-66).
        case "/": return (ctx) => ptDivide(l(ctx), r(ctx), ctx.bsourceFudge ?? 0);
        // ngspice `^` → PTpowerH; default compat = pow(fabs(a),b) (ptfuncs.c:122).
        case "^": {
          const impl = BSOURCE_FUNCTIONS["__pow_caret"]!;
          return (ctx) => impl(l(ctx), r(ctx));
        }
      }
    }

    case "call": {
      const fn = expr.fn;
      const impl = BSOURCE_FUNCTIONS[fn];
      if (impl === undefined) {
        return () => { throw new Error(`Unknown B-source function "${fn}"`); };
      }
      const args = expr.args.map(compileBSource);
      return (ctx) => impl(...args.map((a) => a(ctx)));
    }

    case "circuit-voltage": {
      const label = expr.label;
      return (ctx) => ctx.getNodeVoltage(label);
    }

    case "circuit-current": {
      const label = expr.label;
      return (ctx) => ctx.getBranchCurrent(label);
    }

    case "builtin-var": {
      if (expr.name === "time") return (ctx) => ctx.time;
      if (expr.name === "freq") return (ctx) => ctx.freq ?? 0;
      if (expr.name === "temper") return (ctx) => (ctx.temp ?? 0) - CONSTCtoK;
      const name = expr.name;
      return () => { throw new UnknownNodeKindError(name); };
    }

    case "builtin-func": {
      if (expr.name === "random") return () => Math.random();
      const name = (expr as { name: string }).name;
      return () => { throw new UnknownNodeKindError(name); };
    }

    case "ternary": {
      const c = compileBSource(expr.cond);
      const t = compileBSource(expr.then);
      const e = compileBSource(expr.else);
      return (ctx) => (c(ctx) !== 0 ? t(ctx) : e(ctx));
    }

    case "ddt": {
      const a = compileBSource(expr.arg);
      const node = expr;
      return (ctx) => evalDdt(node, a(ctx), ctx);
    }

    case "pwl": {
      const a = compileBSource(expr.arg);
      const points = expr.points;
      const derivative = expr.derivative;
      return (ctx) => evalPwl(points, a(ctx), derivative);
    }

    default: {
      const exhaustive: never = expr;
      const kind = (exhaustive as ExprNode).kind;
      return () => { throw new UnknownNodeKindError(kind); };
    }
  }
}
