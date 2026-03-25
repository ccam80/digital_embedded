/**
 * Symbolic differentiation and algebraic simplification for the expression AST.
 *
 * `differentiate(expr, variable)` produces a new AST representing the symbolic
 * derivative of `expr` with respect to the named variable. The variable string
 * matches against circuit-voltage/circuit-current labels and plain variable
 * names.
 *
 * `simplify(expr)` applies basic algebraic reductions to keep derivative output
 * readable and numerically efficient.
 */

import type { ExprNode } from "./expression.js";
import { numNode, binOp, unaryOp, callNode } from "./expression.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function zero(): ExprNode { return numNode(0); }
function one(): ExprNode  { return numNode(1); }
function two(): ExprNode  { return numNode(2); }

function isZero(e: ExprNode): boolean {
  return e.kind === "number" && e.value === 0;
}

function isOne(e: ExprNode): boolean {
  return e.kind === "number" && e.value === 1;
}

function mul(a: ExprNode, b: ExprNode): ExprNode {
  return binOp("*", a, b);
}

function add(a: ExprNode, b: ExprNode): ExprNode {
  return binOp("+", a, b);
}

function sub(a: ExprNode, b: ExprNode): ExprNode {
  return binOp("-", a, b);
}

function div(a: ExprNode, b: ExprNode): ExprNode {
  return binOp("/", a, b);
}

function pow(base: ExprNode, exp: ExprNode): ExprNode {
  return binOp("^", base, exp);
}

function neg(a: ExprNode): ExprNode {
  return unaryOp("-", a);
}

// ---------------------------------------------------------------------------
// differentiate
// ---------------------------------------------------------------------------

/**
 * Compute the symbolic derivative of `expr` with respect to `variable`.
 *
 * `variable` is matched against:
 *   - `{ kind: "variable", name }` — plain variable (e.g. "x")
 *   - `{ kind: "circuit-voltage", label }` — when variable is `"V(label)"`
 *   - `{ kind: "circuit-current", label }` — when variable is `"I(label)"`
 *
 * For `builtin-var` (time, freq) the variable string is the name directly.
 */
export function differentiate(expr: ExprNode, variable: string): ExprNode {
  switch (expr.kind) {
    case "number":
      return zero();

    case "variable":
      return expr.name === variable ? one() : zero();

    case "builtin-var":
      return expr.name === variable ? one() : zero();

    case "circuit-voltage":
      return `V(${expr.label})` === variable ? one() : zero();

    case "circuit-current":
      return `I(${expr.label})` === variable ? one() : zero();

    case "builtin-func":
      // random() has no meaningful derivative
      return zero();

    case "unary": {
      // d/dx(-f) = -(d/dx(f))
      const df = differentiate(expr.operand, variable);
      return simplify(neg(df));
    }

    case "binary": {
      const { op, left, right } = expr;
      const dl = differentiate(left, variable);
      const dr = differentiate(right, variable);

      switch (op) {
        case "+":
          // d/dx(f + g) = f' + g'
          return simplify(add(dl, dr));

        case "-":
          // d/dx(f - g) = f' - g'
          return simplify(sub(dl, dr));

        case "*":
          // d/dx(f * g) = f'*g + f*g'
          return simplify(add(mul(dl, right), mul(left, dr)));

        case "/": {
          // d/dx(f / g) = (f'*g - f*g') / g²
          const numerator = sub(mul(dl, right), mul(left, dr));
          const denominator = pow(right, two());
          return simplify(div(numerator, denominator));
        }

        case "^": {
          // Generalized power rule: d/dx(f^g) = g * f^(g-1) * f'
          // (assuming g is constant w.r.t. variable; full log-derivative for non-const exponents)
          if (right.kind === "number") {
            const n = right.value;
            // d/dx(f^n) = n * f^(n-1) * f'
            const nMinus1 = numNode(n - 1);
            return simplify(mul(mul(numNode(n), pow(left, nMinus1)), dl));
          }
          // General case: d/dx(f^g) = f^g * (g' * ln(f) + g * f'/f)
          const lnF = callNode("log", [left]);
          const term1 = mul(dr, lnF);
          const term2 = div(mul(right, dl), left);
          return simplify(mul(expr, add(term1, term2)));
        }
      }
    }

    case "call": {
      const { fn, args } = expr;
      // All supported single-argument math functions use chain rule: d/dx(f(g)) = f'(g) * g'
      if (args.length === 1) {
        const g = args[0];
        const dg = differentiate(g, variable);

        let fPrimeG: ExprNode;
        switch (fn) {
          case "sin":
            // d/dx(sin(g)) = cos(g) * g'
            fPrimeG = callNode("cos", [g]);
            break;
          case "cos":
            // d/dx(cos(g)) = -sin(g) * g'
            fPrimeG = neg(callNode("sin", [g]));
            break;
          case "tan":
            // d/dx(tan(g)) = 1/cos²(g) * g'
            fPrimeG = div(one(), pow(callNode("cos", [g]), two()));
            break;
          case "asin":
            // d/dx(asin(g)) = 1/sqrt(1-g²) * g'
            fPrimeG = div(one(), callNode("sqrt", [sub(one(), pow(g, two()))]));
            break;
          case "acos":
            // d/dx(acos(g)) = -1/sqrt(1-g²) * g'
            fPrimeG = neg(div(one(), callNode("sqrt", [sub(one(), pow(g, two()))])));
            break;
          case "atan":
            // d/dx(atan(g)) = 1/(1+g²) * g'
            fPrimeG = div(one(), add(one(), pow(g, two())));
            break;
          case "exp":
            // d/dx(exp(g)) = exp(g) * g'
            fPrimeG = callNode("exp", [g]);
            break;
          case "log":
            // d/dx(ln(g)) = 1/g * g'
            fPrimeG = div(one(), g);
            break;
          case "log10":
            // d/dx(log10(g)) = 1/(g * ln(10)) * g'
            fPrimeG = div(one(), mul(g, callNode("log", [numNode(10)])));
            break;
          case "sqrt":
            // d/dx(sqrt(g)) = 1/(2*sqrt(g)) * g'
            fPrimeG = div(one(), mul(two(), callNode("sqrt", [g])));
            break;
          case "abs":
            // d/dx(|g|) = sign(g) * g'  (undefined at 0, we return 0 there)
            // sign(g) = g / |g| — represented as a conditional approximation
            // Use: abs'(g) = g / abs(g) (same as sign, undefined at 0)
            fPrimeG = div(g, callNode("abs", [g]));
            break;
          case "floor":
          case "ceil":
          case "round":
            // Derivative is 0 almost everywhere (Dirac spikes at integers, ignored)
            return zero();
          default:
            // Unknown function: treat as having zero derivative
            return zero();
        }
        return simplify(mul(fPrimeG, dg));
      }

      // Multi-argument functions — only atan2 and pow are common
      if (fn === "atan2" && args.length === 2) {
        // atan2(y, x): d/dy(atan2(y,x)) = x/(x²+y²), d/dx(atan2(y,x)) = -y/(x²+y²)
        // For general variable differentiation we approximate via total derivative
        const y = args[0];
        const x = args[1];
        const dy = differentiate(y, variable);
        const dx = differentiate(x, variable);
        const denom = add(pow(x, two()), pow(y, two()));
        const term1 = mul(div(x, denom), dy);
        const term2 = mul(div(neg(y), denom), dx);
        return simplify(add(term1, term2));
      }

      if (fn === "pow" && args.length === 2) {
        // pow(f, g) — same as f^g binary node
        const f = args[0];
        const g = args[1];
        const df = differentiate(f, variable);
        const dg = differentiate(g, variable);
        if (g.kind === "number") {
          const n = g.value;
          return simplify(mul(mul(numNode(n), pow(f, numNode(n - 1))), df));
        }
        const lnF = callNode("log", [f]);
        const term1 = mul(dg, lnF);
        const term2 = div(mul(g, df), f);
        return simplify(mul(callNode("pow", args), add(term1, term2)));
      }

      // min, max, and other multi-arg functions: zero derivative (approximation)
      return zero();
    }

    default: {
      const exhaustive: never = expr;
      void exhaustive;
      return zero();
    }
  }
}

// ---------------------------------------------------------------------------
// simplify
// ---------------------------------------------------------------------------

/**
 * Apply basic algebraic simplification to reduce constant sub-expressions and
 * eliminate identity elements. Runs one pass (not iterative).
 *
 * Rules applied:
 *   0 + x  →  x         x + 0  →  x
 *   0 - x  →  -x        x - 0  →  x
 *   0 * x  →  0         x * 0  →  0
 *   1 * x  →  x         x * 1  →  x
 *   x / 1  →  x
 *   x ^ 0  →  1         x ^ 1  →  x
 *   0 ^ n  →  0         1 ^ n  →  1
 *   -(0)   →  0
 *   Fold numeric sub-expressions entirely
 */
export function simplify(expr: ExprNode): ExprNode {
  switch (expr.kind) {
    case "number":
    case "variable":
    case "circuit-voltage":
    case "circuit-current":
    case "builtin-var":
    case "builtin-func":
      return expr;

    case "unary": {
      const operand = simplify(expr.operand);
      if (isZero(operand)) return zero();
      if (operand.kind === "number") return numNode(-operand.value);
      return unaryOp("-", operand);
    }

    case "binary": {
      const left = simplify(expr.left);
      const right = simplify(expr.right);

      // Constant folding
      if (left.kind === "number" && right.kind === "number") {
        const l = left.value;
        const r = right.value;
        switch (expr.op) {
          case "+": return numNode(l + r);
          case "-": return numNode(l - r);
          case "*": return numNode(l * r);
          case "/": return numNode(l / r);
          case "^": return numNode(Math.pow(l, r));
        }
      }

      switch (expr.op) {
        case "+":
          if (isZero(left))  return right;
          if (isZero(right)) return left;
          break;
        case "-":
          if (isZero(right)) return left;
          if (isZero(left))  return simplify(unaryOp("-", right));
          break;
        case "*":
          if (isZero(left) || isZero(right)) return zero();
          if (isOne(left))  return right;
          if (isOne(right)) return left;
          break;
        case "/":
          if (isZero(left))  return zero();
          if (isOne(right))  return left;
          break;
        case "^":
          if (isZero(right)) return one();
          if (isOne(right))  return left;
          if (isZero(left))  return zero();
          if (isOne(left))   return one();
          break;
      }

      return binOp(expr.op, left, right);
    }

    case "call": {
      const args = expr.args.map(simplify);
      // Constant fold single-arg math functions
      if (args.length === 1 && args[0].kind === "number") {
        const v = args[0].value;
        const mathFns: Record<string, (x: number) => number> = {
          sin: Math.sin, cos: Math.cos, tan: Math.tan,
          asin: Math.asin, acos: Math.acos, atan: Math.atan,
          exp: Math.exp, log: Math.log, log10: Math.log10,
          sqrt: Math.sqrt, abs: Math.abs,
          floor: Math.floor, ceil: Math.ceil, round: Math.round,
        };
        if (expr.fn in mathFns) return numNode(mathFns[expr.fn](v));
      }
      return callNode(expr.fn, args);
    }

    default: {
      const exhaustive: never = expr;
      void exhaustive;
      return expr as ExprNode;
    }
  }
}
