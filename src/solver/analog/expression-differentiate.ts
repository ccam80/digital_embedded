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
import { numNode, binOp, unaryOp, callNode, ternaryNode, BUILTIN_FUNCTIONS } from "./expression.js";

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
 *   - `{ kind: "variable", name }`- plain variable (e.g. "x")
 *   - `{ kind: "circuit-voltage", label }`- when variable is `"V(label)"`
 *   - `{ kind: "circuit-current", label }`- when variable is `"I(label)"`
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

    case "ternary":
      // d/dx(cond ? a : b) = cond ? D(a) : D(b) (inpptree.c:381-383).
      return ternaryNode(
        expr.cond,
        differentiate(expr.then, variable),
        differentiate(expr.else, variable),
      );

    case "ddt":
      // d/dx(ddt(u)) = 0 (inpptree.c:570-573).
      return zero();

    case "pwl":
      // d/dx(pwl) is the pwl_derivative sibling; its own derivative is 0
      // (inpptree.c:561-568). The editor evaluator never produces pwl nodes,
      // so this arm exists only for union exhaustiveness.
      return expr.derivative
        ? zero()
        : { kind: "pwl", arg: expr.arg, points: expr.points, derivative: true };

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
            // d/dx tan(g) = (1 + tan²(g)) · g'  (inpptree.c:508-513)
            fPrimeG = add(one(), pow(callNode("tan", [g]), two()));
            break;
          case "sinh":
            // d/dx sinh(g) = cosh(g) · g'
            fPrimeG = callNode("cosh", [g]);
            break;
          case "cosh":
            // d/dx cosh(g) = sinh(g) · g'
            fPrimeG = callNode("sinh", [g]);
            break;
          case "tanh":
            // d/dx tanh(g) = (1 − tanh²(g)) · g'  (inpptree.c:515-520)
            fPrimeG = sub(one(), pow(callNode("tanh", [g]), two()));
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
            // sign(g) = g / |g|- represented as a conditional approximation
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

      // Multi-argument functions- only atan2 and pow are common
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
        // pow(f, g)- same as f^g binary node
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
    case "ddt":
    case "pwl":
      return expr;

    case "ternary":
      return {
        kind: "ternary",
        cond: simplify(expr.cond),
        then: simplify(expr.then),
        else: simplify(expr.else),
      };

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
      // Constant fold single-arg math functions through the shared clamped
      // BUILTIN_FUNCTIONS, so a folded exp/log/log10 matches the runtime clamp.
      if (args.length === 1 && args[0].kind === "number") {
        const v = args[0].value;
        const impl = BUILTIN_FUNCTIONS[expr.fn];
        if (impl !== undefined) return numNode(impl(v));
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

// ---------------------------------------------------------------------------
// B-source (IFeval) differentiation — ngspice PTdifferentiate (inpptree.c:256)
// ---------------------------------------------------------------------------

/** Constant-node predicate / reader for the ngspice-faithful builders. */
function isConst(e: ExprNode): e is { kind: "number"; value: number } {
  return e.kind === "number";
}

/**
 * ngspice `mkb` (inpptree.c:772-883): build a binary node with the SAME
 * constant-folding and 0/1 identity pruning ngspice applies while assembling
 * derivative trees. Folds two constants for + - * / ^ (`^` via the signed
 * `pow`, inpptree.c:798), prunes 0/1 per inpptree.c:802-842. Reproducing this
 * exactly keeps the digiTS derivative tree structurally identical to ngspice's,
 * which the bit-exact harness gate requires.
 */
function mkb(op: "+" | "-" | "*" | "/" | "^", left: ExprNode, right: ExprNode): ExprNode {
  if (isConst(left) && isConst(right)) {
    const l = left.value, r = right.value;
    switch (op) {
      case "*": return numNode(l * r);
      case "/": return numNode(l / r);
      case "+": return numNode(l + r);
      case "-": return numNode(l - r);
      case "^": return numNode(Math.pow(l, r));
    }
  }
  switch (op) {
    case "*":
      if (isConst(left) && left.value === 0) return left;
      if (isConst(right) && right.value === 0) return right;
      if (isConst(left) && left.value === 1) return right;
      if (isConst(right) && right.value === 1) return left;
      break;
    case "/":
      if (isConst(left) && left.value === 0) return left;
      if (isConst(right) && right.value === 1) return left;
      break;
    case "+":
      if (isConst(left) && left.value === 0) return right;
      if (isConst(right) && right.value === 0) return left;
      break;
    case "-":
      if (isConst(right) && right.value === 0) return left;
      if (isConst(left) && left.value === 0) return mkfBSource("uminus", right);
      break;
    case "^":
      if (isConst(right) && right.value === 0) return numNode(1.0);
      if (isConst(right) && right.value === 1) return left;
      break;
  }
  return binOp(op, left, right);
}

/**
 * ngspice `mkf` (inpptree.c:885+): build a function-call node. No constant
 * folding (matching ngspice). `uminus` maps to the unary-`-` AST node so it
 * shares the existing evaluator/compiler arm; every other name is a `call`
 * routed through BSOURCE_FUNCTIONS at compile time.
 */
function mkfBSource(fn: string, arg: ExprNode): ExprNode {
  if (fn === "uminus") return unaryOp("-", arg);
  return callNode(fn, [arg]);
}

/**
 * `differentiateBSource(expr, valueIndex, kind, label)` — the ngspice
 * PTdifferentiate (inpptree.c:256-758) counterpart for the B-source tree.
 *
 * Unlike the editor-facing `differentiate`, this produces the EXACT ngspice
 * derivative-tree shapes the bit-exact harness gate needs: `abs'→sgn`
 * (inpptree.c:397-399), `^`/`pow` constant-exp via `pwr(a,b-1)`
 * (inpptree.c:332-340,644-651), `min`/`max` via the comparison ternary
 * (inpptree.c:575-606), and the full added-function rules (Part 0.C).
 *
 * The differentiation variable is identified by `(kind, label)`: a
 * `circuit-voltage` matches when `kind === "node"` and labels match; a
 * `circuit-current` matches when `kind === "branch"`. Every other leaf
 * differentiates to 0.
 */
export function differentiateBSource(
  expr: ExprNode,
  kind: "node" | "branch",
  label: string,
): ExprNode {
  const d = (e: ExprNode): ExprNode => differentiateBSource(e, kind, label);

  switch (expr.kind) {
    case "number":
      return numNode(0);

    // PT_TIME / PT_TEMPERATURE / PT_FREQUENCY → 0 (inpptree.c:261-266).
    case "builtin-var":
    case "builtin-func":
      return numNode(0);

    case "variable":
      // Plain symbolic variables are never B-source controllers.
      return numNode(0);

    case "circuit-voltage":
      return kind === "node" && expr.label === label ? numNode(1.0) : numNode(0);

    case "circuit-current":
      return kind === "branch" && expr.label === label ? numNode(1.0) : numNode(0);

    case "unary":
      // d(-u) = -(du); reuse the uminus builder.
      return mkfBSource("uminus", d(expr.operand));

    case "ternary":
      // d/d (cond ? a : b) = cond ? da : db (inpptree.c:381-383).
      return ternaryNode(expr.cond, d(expr.then), d(expr.else));

    case "ddt":
      // d(ddt(u)) = 0 (inpptree.c:570-573).
      return numNode(0);

    case "pwl":
      // d(pwl(u,...)) = pwl_derivative(u,...) carrying the SAME breakpoints
      // (inpptree.c:561-564). pwl_derivative's own derivative is 0.
      if (expr.derivative) return numNode(0);
      return { kind: "pwl", arg: expr.arg, points: expr.points, derivative: true };

    case "binary": {
      const { op, left, right } = expr;
      switch (op) {
        case "+":
        case "-":
          return mkb(op, d(left), d(right));
        case "*":
          // d(a*b) = da*b + a*db (inpptree.c:288-289).
          return mkb("+", mkb("*", d(left), right), mkb("*", left, d(right)));
        case "/":
          // d(a/b) = (da*b - a*db) / b^2 (inpptree.c:297-301).
          return mkb("/",
            mkb("-", mkb("*", d(left), right), mkb("*", left, d(right))),
            mkb("^", right, numNode(2.0)));
        case "^":
          // `^` : a^b → |a|^b. inpptree.c:330-366.
          if (isConst(right)) {
            // b const: b * pwr(a, b-1) * D(a) (inpptree.c:342-348, default compat).
            return mkb("*",
              mkb("*", numNode(right.value),
                callNode("pwr", [left, numNode(right.value - 1.0)])),
              d(left));
          }
          if (isConst(left)) {
            // a const: pow(a,b) * (D(b) * log(|a|)) (inpptree.c:353-355).
            return mkb("*",
              callNode("pow", [left, right]),
              mkb("*", d(right), callNode("log", [callNode("abs", [left])])));
          }
          // general: pow(a,b) * (b*D(a)/a + D(b)*log(|a|)) (inpptree.c:360-365).
          return mkb("*",
            callNode("pow", [left, right]),
            mkb("+",
              mkb("*", right, mkb("/", d(left), left)),
              mkb("*", d(right), callNode("log", [callNode("abs", [left])]))));
      }
      break;
    }

    case "call": {
      const { fn, args } = expr;

      // Two-argument power forms pow(a,b) / pwr(a,b) (inpptree.c:610-738).
      if ((fn === "pow" || fn === "pwr") && args.length === 2) {
        const a = args[0]!, b = args[1]!;
        if (fn === "pow") {
          if (isConst(b)) {
            // b const: b * pwr(a, b-1) * D(a) (inpptree.c:644-651).
            return mkb("*",
              mkb("*", numNode(b.value), callNode("pwr", [a, numNode(b.value - 1)])),
              d(a));
          }
          if (isConst(a)) {
            // a const: pow(a,b) * (D(b) * log(|a|)) (inpptree.c:652-657).
            return mkb("*", callNode("pow", [a, b]),
              mkb("*", d(b), callNode("log", [callNode("abs", [a])])));
          }
          // general (inpptree.c:658-669).
          return mkb("*", callNode("pow", [a, b]),
            mkb("+",
              mkb("*", b, mkb("/", d(a), a)),
              mkb("*", d(b), callNode("log", [callNode("abs", [a])]))));
        }
        // pwr (inpptree.c:683-728).
        if (isConst(b)) {
          // b const: b * pow(a, b-1) * D(a) (inpptree.c:711-719).
          return mkb("*",
            mkb("*", numNode(b.value), callNode("pow", [a, numNode(b.value - 1.0)])),
            d(a));
        }
        // general: pwr(a,b) * (b*D(a)/a + D(b)*log(|a|)) (inpptree.c:721-728).
        return mkb("*", callNode("pwr", [a, b]),
          mkb("+",
            mkb("*", b, mkb("/", d(a), a)),
            mkb("*", d(b), callNode("log", [callNode("abs", [a])]))));
      }

      // min(a,b) / max(a,b): the comparison ternary (inpptree.c:575-606).
      if ((fn === "min" || fn === "max") && args.length === 2) {
        const a = args[0]!, b = args[1]!;
        const cmp = fn === "min" ? "lt0" : "gt0";
        return ternaryNode(callNode(cmp, [mkb("-", a, b)]), d(a), d(b));
      }

      // atan2(y,x) — the existing engine's total-derivative shape is reused
      // (no ngspice PTF_ATAN2 derivative ships; atan2 is not in funcs[]). Kept
      // for parity with the editor evaluator; B-source decks should not use it.
      if (fn === "atan2" && args.length === 2) {
        const y = args[0]!, x = args[1]!;
        const denom = mkb("+", mkb("^", x, numNode(2)), mkb("^", y, numNode(2)));
        return mkb("+",
          mkb("*", mkb("/", x, denom), d(y)),
          mkb("*", mkb("/", mkfBSource("uminus", y), denom), d(x)));
      }

      // Single-argument functions: chain rule fpr(u) * D(u) (inpptree.c:746-748).
      if (args.length === 1) {
        const u = args[0]!;
        const du = d(u);
        const fpr = bsourceFuncDerivative(fn, u);
        if (fpr === null) return numNode(0); // floor/ceil/nint/u/eq0..le0/sgn → 0
        return mkb("*", fpr, du);
      }

      return numNode(0);
    }

    default: {
      const exhaustive: never = expr;
      void exhaustive;
      return numNode(0);
    }
  }
}

/**
 * Per-function derivative `f'(u)` for the single-argument B-source functions,
 * the chain-rule factor of `differentiateBSource` (ngspice PTdifferentiate's
 * PT_FUNCTION arm, inpptree.c:396-573). Returns null for functions whose
 * derivative is the constant 0 (those that contribute `0 * D(u) = 0`): sgn, u,
 * eq0..le0, floor, ceil, nint. `uminus`'s derivative is the constant −1
 * (inpptree.c:557-559), but the unary `-` AST node is handled directly in
 * `differentiateBSource`, so it never reaches here.
 */
function bsourceFuncDerivative(fn: string, u: ExprNode): ExprNode | null {
  switch (fn) {
    case "abs":   // sgn(u) (inpptree.c:397-399)
      return callNode("sgn", [u]);
    case "sgn":   // 0 (inpptree.c:401-403)
    case "u":     // 0 (inpptree.c:522-530)
    case "eq0": case "ne0": case "gt0": case "lt0": case "ge0": case "le0":
    case "floor": case "ceil": case "nint": // 0 (inpptree.c:536-546)
      return null;
    case "acos":  // -1 / sqrt(1 - u^2) (inpptree.c:405-412)
      return mkb("/", numNode(-1.0), callNode("sqrt", [mkb("-", numNode(1.0), mkb("^", u, numNode(2.0)))]));
    case "acosh": // 1 / sqrt(u^2 - 1) (inpptree.c:414-422)
      return mkb("/", numNode(1.0), callNode("sqrt", [mkb("-", mkb("^", u, numNode(2.0)), numNode(1.0))]));
    case "asin":  // 1 / sqrt(1 - u^2) (inpptree.c:424-431)
      return mkb("/", numNode(1.0), callNode("sqrt", [mkb("-", numNode(1.0), mkb("^", u, numNode(2.0)))]));
    case "asinh": // 1 / sqrt(u^2 + 1) (inpptree.c:433-440)
      return mkb("/", numNode(1.0), callNode("sqrt", [mkb("+", mkb("^", u, numNode(2.0)), numNode(1.0))]));
    case "atan":  // 1 / (1 + u^2) (inpptree.c:442-448)
      return mkb("/", numNode(1.0), mkb("+", mkb("^", u, numNode(2.0)), numNode(1.0)));
    case "atanh": // 1 / (1 - u^2) (inpptree.c:450-456)
      return mkb("/", numNode(1.0), mkb("-", numNode(1.0), mkb("^", u, numNode(2.0))));
    case "cos":   // -sin(u) (inpptree.c:458-460)
      return mkfBSource("uminus", callNode("sin", [u]));
    case "cosh":  // sinh(u) (inpptree.c:462-464)
      return callNode("sinh", [u]);
    case "exp":   // exp(u) (inpptree.c:474-476, default compat)
      return callNode("exp", [u]);
    case "log": case "ln": // 1 / u (inpptree.c:485-487)
      return mkb("/", numNode(1.0), u);
    case "log10": // M_LOG10E / u (inpptree.c:489-491)
      return mkb("/", numNode(Math.LOG10E), u);
    case "sin":   // cos(u) (inpptree.c:493-495)
      return callNode("cos", [u]);
    case "sinh":  // cosh(u) (inpptree.c:497-499)
      return callNode("cosh", [u]);
    case "sqrt":  // 1 / (2 * sqrt(u)) (inpptree.c:501-506)
      return mkb("/", numNode(1.0), mkb("*", numNode(2.0), callNode("sqrt", [u])));
    case "tan":   // 1 + tan(u)^2 (inpptree.c:508-513)
      return mkb("+", numNode(1.0), mkb("^", callNode("tan", [u]), numNode(2.0)));
    case "tanh":  // 1 - tanh(u)^2 (inpptree.c:515-520)
      return mkb("-", numNode(1.0), mkb("^", callNode("tanh", [u]), numNode(2.0)));
    case "uramp": // u(u) (inpptree.c:532-534)
      return callNode("u", [u]);
    case "u2":    // u(u) - u(u-1) (inpptree.c:548-555)
      return mkb("-", callNode("u", [u]), callNode("u", [mkb("-", u, numNode(1.0))]));
    default:
      // Unknown single-arg function: no derivative rule → 0.
      return null;
  }
}
