/**
 * Arithmetic expression parser and evaluator for analog simulation.
 *
 * Implements a recursive descent parser producing an AST (ExprNode discriminated
 * union). The evaluator walks the AST with a variable environment.
 *
 * Operator precedence (lowest to highest):
 *   1. Additive:       + -
 *   2. Multiplicative: * /
 *   3. Power:          ^ (right-associative)
 *   4. Unary:          - (prefix)
 *   5. Primary:        number, variable, function call, parenthesized
 *
 * Built-in constants: pi, e
 * Built-in functions: sin, cos, tan, asin, acos, atan, atan2, exp, log,
 *                     log10, sqrt, abs, min, max, floor, ceil, round, pow
 */

import { compileBSource } from "./expression-evaluate.js";
import type { ExpressionContext } from "./expression-evaluate.js";
import { differentiateBSource } from "./expression-differentiate.js";

// ---------------------------------------------------------------------------
// AST node types
// ---------------------------------------------------------------------------

export type ExprNode =
  | { kind: "number"; value: number }
  | { kind: "variable"; name: string }
  | { kind: "unary"; op: "-"; operand: ExprNode }
  | { kind: "binary"; op: "+" | "-" | "*" | "/" | "^"; left: ExprNode; right: ExprNode }
  | { kind: "call"; fn: string; args: ExprNode[] }
  | { kind: "circuit-voltage"; label: string }
  | { kind: "circuit-current"; label: string }
  | { kind: "builtin-var"; name: "time" | "freq" | "temper" }
  | { kind: "builtin-func"; name: "random" }
  // Ternary `cond ? then : else`. Selects a branch by `cond != 0`, matching
  // ngspice PT_TERN (ifeval.c:145 `(r1 != 0.0) ? arg2 : arg3`).
  | { kind: "ternary"; cond: ExprNode; then: ExprNode; else: ExprNode }
  // Transient time-derivative ddt(arg). Carries a 7-slot history buffer
  // (inpptree.c:1096 `thing->vals = TMALLOC(double, 7)`); the evaluator mutates
  // it per accepted timestep (ptfuncs.c:430-465). Derivative is 0 (inpptree.c:570-573).
  | { kind: "ddt"; arg: ExprNode; history: Float64Array; counter: { n: number } }
  // Piecewise-linear lookup pwl(arg, x1,y1,...). `points` is the parsed constant
  // breakpoint array [x0,y0,x1,y1,...] (inpptree.c:1022-1087). `derivative` flips
  // the evaluator to the bracketing-segment slope (ptfuncs.c:370-392); the pwl
  // derivative is the slope sibling (inpptree.c:561-564), its own derivative 0.
  | { kind: "pwl"; arg: ExprNode; points: number[]; derivative: boolean };

// ---------------------------------------------------------------------------
// AST constructor helpers
// ---------------------------------------------------------------------------

export function numNode(value: number): ExprNode {
  return { kind: "number", value };
}

export function varNode(name: string): ExprNode {
  return { kind: "variable", name };
}

export function binOp(
  op: "+" | "-" | "*" | "/" | "^",
  left: ExprNode,
  right: ExprNode,
): ExprNode {
  return { kind: "binary", op, left, right };
}

export function unaryOp(op: "-", operand: ExprNode): ExprNode {
  return { kind: "unary", op, operand };
}

export function callNode(fn: string, args: ExprNode[]): ExprNode {
  return { kind: "call", fn, args };
}

export function circuitVoltageNode(label: string): ExprNode {
  return { kind: "circuit-voltage", label };
}

export function circuitCurrentNode(label: string): ExprNode {
  return { kind: "circuit-current", label };
}

export function builtinVarNode(name: "time" | "freq" | "temper"): ExprNode {
  return { kind: "builtin-var", name };
}

export function builtinFuncNode(name: "random"): ExprNode {
  return { kind: "builtin-func", name };
}

export function ternaryNode(cond: ExprNode, thenE: ExprNode, elseE: ExprNode): ExprNode {
  return { kind: "ternary", cond, then: thenE, else: elseE };
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class ExprParseError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(`${message} (at position ${position})`);
    this.name = "ExprParseError";
    this.position = position;
  }
}

export class UnknownNodeKindError extends Error {
  constructor(kind: string) {
    super(`Unknown ExprNode kind: "${kind}". Use the extended evaluator for this node type.`);
    this.name = "UnknownNodeKindError";
  }
}

// ---------------------------------------------------------------------------
// Built-in constants and functions
// ---------------------------------------------------------------------------

const BUILTIN_CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

/**
 * PTexp overflow ceiling (`ptfuncs.c:273-281`): for arg above 227.9559242 the
 * exponential is pinned to 1e99 rather than overflowing to Infinity. Below the
 * threshold it is the library exp.
 */
function ptExp(arg: number): number {
  if (arg > 227.9559242)
    return 1e99;
  else
    return Math.exp(arg);
}

/**
 * PTlog domain clamp (`ptfuncs.c:286-294`): negative argument returns HUGE
 * (IEEE +Infinity), a zero argument returns -1e99 (the iteration-start guard
 * for op/dc), and the positive domain is the library log.
 */
function ptLog(arg: number): number {
  if (arg < 0.0)
    return Number.POSITIVE_INFINITY;
  if (arg === 0)
    return -1e99;
  return Math.log(arg);
}

/**
 * PTlog10 domain clamp (`ptfuncs.c:296-304`): same negative/zero guards as
 * ptLog, positive domain is the library log10.
 */
function ptLog10(arg: number): number {
  if (arg < 0.0)
    return Number.POSITIVE_INFINITY;
  if (arg === 0)
    return -1e99;
  return Math.log10(arg);
}

/**
 * PTsqrt domain clamp (`ptfuncs.c:318-324`): a negative argument returns HUGE
 * (IEEE +Infinity), the non-negative domain is the library sqrt.
 */
function ptSqrt(arg: number): number {
  if (arg < 0.0)
    return Number.POSITIVE_INFINITY;
  return Math.sqrt(arg);
}

/**
 * The `MODULUS(NUM,LIMIT)` range reduction ngspice applies before sin/cos/tan
 * (`ptfuncs.c:22` `((NUM) - ((int)((NUM)/(LIMIT)))*(LIMIT))`). The cast to `int`
 * truncates toward zero; `Math.trunc` reproduces it.
 */
function ptModulus(num: number, limit: number): number {
  return num - Math.trunc(num / limit) * limit;
}

const TWO_PI = 2 * Math.PI;

/** PTsin: sin after the 2π range reduction (`ptfuncs.c:307-310`). */
function ptSin(arg: number): number {
  return Math.sin(ptModulus(arg, TWO_PI));
}

/** PTcos: cos after the 2π range reduction (`ptfuncs.c:258-261`). */
function ptCos(arg: number): number {
  return Math.cos(ptModulus(arg, TWO_PI));
}

/** PTtan: tan after the π range reduction (`ptfuncs.c:327-330`). */
function ptTan(arg: number): number {
  return Math.tan(ptModulus(arg, Math.PI));
}

/**
 * PTpower (`ptfuncs.c:68-89`) at default compat (`!newcompat.lt`):
 * `pow(fabs(arg1), arg2)` (`ptfuncs.c:87`). The `^` operator dispatches to
 * PTpowerH (`ptfuncs.c:92-124`); at default compat (`!newcompat.hs &&
 * !newcompat.lt`) PTpowerH is the same `pow(fabs(arg1), arg2)`
 * (`ptfuncs.c:122`), so `^` and `pow` share this value.
 */
function ptPower(arg1: number, arg2: number): number {
  return Math.pow(Math.abs(arg1), arg2);
}

/**
 * PTpwr (`ptfuncs.c:127-138`) at default compat (`!newcompat.ps`): a negative
 * base flips the sign, `arg1 < 0 ? -pow(-arg1, arg2) : pow(arg1, arg2)`
 * (`ptfuncs.c:134-137`).
 */
function ptPwr(arg1: number, arg2: number): number {
  if (arg1 < 0.0)
    return -Math.pow(-arg1, arg2);
  return Math.pow(arg1, arg2);
}

/** PTsgn (`ptfuncs.c:30-34`): the signum, `arg>0?1:arg<0?-1:0`. */
function ptSgn(arg: number): number {
  return arg > 0.0 ? 1.0 : arg < 0.0 ? -1.0 : 0.0;
}

/** PTustep (`ptfuncs.c:188-197`): unit step, 0.5 exactly at the origin. */
function ptUstep(arg: number): number {
  if (arg < 0.0) return 0.0;
  if (arg > 0.0) return 1.0;
  return 0.5;
}

/** PTustep2 (`ptfuncs.c:201-210`): the clamped ramp uramp(x)-uramp(x-1). */
function ptUstep2(arg: number): number {
  if (arg <= 0.0) return 0.0;
  if (arg <= 1.0) return arg;
  return 1.0;
}

/** PTuramp (`ptfuncs.c:248-255`): the unit ramp, `arg<0 ? 0 : arg`. */
function ptUramp(arg: number): number {
  return arg < 0.0 ? 0.0 : arg;
}

/** PTeq0 (`ptfuncs.c:212-216`). */
function ptEq0(arg: number): number { return arg === 0.0 ? 1.0 : 0.0; }
/** PTne0 (`ptfuncs.c:218-222`). */
function ptNe0(arg: number): number { return arg !== 0.0 ? 1.0 : 0.0; }
/** PTgt0 (`ptfuncs.c:224-228`). */
function ptGt0(arg: number): number { return arg > 0.0 ? 1.0 : 0.0; }
/** PTlt0 (`ptfuncs.c:230-234`). */
function ptLt0(arg: number): number { return arg < 0.0 ? 1.0 : 0.0; }
/** PTge0 (`ptfuncs.c:236-240`). */
function ptGe0(arg: number): number { return arg >= 0.0 ? 1.0 : 0.0; }
/** PTle0 (`ptfuncs.c:242-246`). */
function ptLe0(arg: number): number { return arg <= 0.0 ? 1.0 : 0.0; }

/**
 * PTnint (`ptfuncs.c:406-414`): round-half-to-even, the default IEEE 754
 * rounding mode `nearbyint`. JavaScript has no banker's-rounding primitive, so
 * reproduce it: round to nearest, ties to the even integer.
 */
function ptNint(arg: number): number {
  const r = Math.round(arg);
  // Math.round breaks ties toward +Infinity; correct the .5 case to even.
  if (Math.abs(arg - Math.trunc(arg)) === 0.5) {
    const lower = Math.floor(arg);
    return lower % 2 === 0 ? lower : lower + 1;
  }
  return r;
}

/** PTmin (`ptfuncs.c:141-144`): `arg1>arg2 ? arg2 : arg1`. */
function ptMin(arg1: number, arg2: number): number {
  return arg1 > arg2 ? arg2 : arg1;
}

/** PTmax (`ptfuncs.c:147-150`): `arg1>arg2 ? arg1 : arg2`. */
function ptMax(arg1: number, arg2: number): number {
  return arg1 > arg2 ? arg1 : arg2;
}

/**
 * Single source of truth for every runtime expression-function lookup. Both
 * runtime evaluators (`evaluateExpression` here, and `evaluate` /
 * `compileExpression` in `expression-evaluate.ts`) and the constant-fold pass
 * in `expression-differentiate.ts` resolve functions from this one map.
 *
 * `exp`/`log`/`log10` carry the ngspice PTexp/PTlog/PTlog10 clamps
 * (`ptfuncs.c:273-304`). `sinh`/`cosh`/`tanh` are the bare library hyperbolics
 * matching PTsinh/PTcosh/PTtanh (`ptfuncs.c:263-267,312-316,332-336`).
 */
export const BUILTIN_FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  exp: ptExp,
  log: ptLog,
  log10: ptLog10,
  sqrt: Math.sqrt,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  pow: Math.pow,
};

/**
 * The B-source (`IFeval`) function table — the v41 `funcs[]` set
 * (`inpptree.c:135-175`), dispatched only inside `buildBSourceTree`'s compiled
 * value/derivative closures, never by the legacy editor-facing evaluators. This
 * carries the ngspice value semantics that diverge from the bare library
 * functions in `BUILTIN_FUNCTIONS`: `sin`/`cos`/`tan` with the `MODULUS` range
 * reduction (`ptfuncs.c:258-330`), `sqrt`/`exp`/`log`/`log10` HUGE/1e99 clamps,
 * `pow`/`^` as `pow(fabs(a),b)` and `pwr` as the sign-flipping power, plus the
 * comparison / step / hyperbolic-inverse functions. `^` is keyed under the
 * internal name `"__pow_caret"` so the `^` binary operator can route to PTpowerH
 * while a literal `pow(...)` call routes to PTpower; at default compat both are
 * `pow(fabs(a),b)`, so they share `ptPower`.
 */
export const BSOURCE_FUNCTIONS: Record<string, (...args: number[]) => number> = {
  // Trig with ngspice range reduction (ptfuncs.c:258-330).
  sin: ptSin,
  cos: ptCos,
  tan: ptTan,
  // Hyperbolics (ptfuncs.c:263-267,312-316,332-336).
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  // Inverse trig / hyperbolic (ptfuncs.c:152-186).
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  asinh: Math.asinh,
  acosh: Math.acosh,
  atanh: Math.atanh,
  atan2: Math.atan2,
  // Clamped transcendentals (ptfuncs.c:273-324).
  exp: ptExp,
  log: ptLog,
  ln: ptLog,           // PTF_LOG alias `ln` (inpptree.c:146).
  log10: ptLog10,
  sqrt: ptSqrt,
  // Power forms (ptfuncs.c:68-138). `^` shares ptPower at default compat.
  pow: ptPower,
  pwr: ptPwr,
  __pow_caret: ptPower,
  // abs / signum / steps / comparisons (ptfuncs.c:24-255,406-414).
  abs: Math.abs,
  sgn: ptSgn,
  u: ptUstep,
  u2: ptUstep2,
  uramp: ptUramp,
  eq0: ptEq0,
  ne0: ptNe0,
  gt0: ptGt0,
  lt0: ptLt0,
  ge0: ptGe0,
  le0: ptLe0,
  nint: ptNint,
  floor: Math.floor,
  ceil: Math.ceil,
  // PTmin/PTmax use the ngspice `>` tie-break (ptfuncs.c:141-150).
  min: ptMin,
  max: ptMax,
};

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

const enum TokenKind {
  Number,
  Ident,
  Plus,
  Minus,
  Star,
  Slash,
  Caret,
  LParen,
  RParen,
  Comma,
  Question,
  Colon,
  EOF,
}

interface Token {
  kind: TokenKind;
  value?: number;
  name?: string;
  pos: number;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    // Whitespace
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    // Number: integer or decimal, optional exponent
    if (ch >= "0" && ch <= "9" || (ch === "." && i + 1 < input.length && input[i + 1] >= "0" && input[i + 1] <= "9")) {
      const start = i;
      while (i < input.length && ((input[i] >= "0" && input[i] <= "9") || input[i] === ".")) {
        i++;
      }
      // Optional exponent: e or E followed by optional sign and digits
      if (i < input.length && (input[i] === "e" || input[i] === "E")) {
        i++;
        if (i < input.length && (input[i] === "+" || input[i] === "-")) {
          i++;
        }
        while (i < input.length && input[i] >= "0" && input[i] <= "9") {
          i++;
        }
      }
      tokens.push({ kind: TokenKind.Number, value: parseFloat(input.slice(start, i)), pos: start });
      continue;
    }

    // Identifier or keyword
    if ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_") {
      const start = i;
      while (i < input.length && ((input[i] >= "a" && input[i] <= "z") || (input[i] >= "A" && input[i] <= "Z") || (input[i] >= "0" && input[i] <= "9") || input[i] === "_")) {
        i++;
      }
      tokens.push({ kind: TokenKind.Ident, name: input.slice(start, i), pos: start });
      continue;
    }

    // Operators and punctuation
    const pos = i;
    i++;
    switch (ch) {
      case "+": tokens.push({ kind: TokenKind.Plus,   pos }); break;
      case "-": tokens.push({ kind: TokenKind.Minus,  pos }); break;
      case "*": tokens.push({ kind: TokenKind.Star,   pos }); break;
      case "/": tokens.push({ kind: TokenKind.Slash,  pos }); break;
      case "^": tokens.push({ kind: TokenKind.Caret,  pos }); break;
      case "(": tokens.push({ kind: TokenKind.LParen, pos }); break;
      case ")": tokens.push({ kind: TokenKind.RParen, pos }); break;
      case ",": tokens.push({ kind: TokenKind.Comma,  pos }); break;
      case "?": tokens.push({ kind: TokenKind.Question, pos }); break;
      case ":": tokens.push({ kind: TokenKind.Colon, pos }); break;
      default:
        throw new ExprParseError(`Unexpected character '${ch}'`, pos);
    }
  }

  tokens.push({ kind: TokenKind.EOF, pos: input.length });
  return tokens;
}

// ---------------------------------------------------------------------------
// Recursive descent parser
// ---------------------------------------------------------------------------

class Parser {
  private readonly _tokens: Token[];
  private _pos = 0;

  constructor(tokens: Token[]) {
    this._tokens = tokens;
  }

  private _peek(): Token {
    return this._tokens[this._pos];
  }

  private _advance(): Token {
    const tok = this._tokens[this._pos];
    if (tok.kind !== TokenKind.EOF) this._pos++;
    return tok;
  }

  private _expect(kind: TokenKind, description: string): Token {
    const tok = this._peek();
    if (tok.kind !== kind) {
      throw new ExprParseError(`Expected ${description}`, tok.pos);
    }
    return this._advance();
  }

  parseExpression(): ExprNode {
    const node = this._parseTernary();
    if (this._peek().kind !== TokenKind.EOF) {
      throw new ExprParseError("Unexpected token", this._peek().pos);
    }
    return node;
  }

  // ternary: additive ('?' ternary ':' ternary)?  (right-associative, lowest
  // precedence). ngspice's `a ? b : c` (inpptree.c:1125-1146, lexer tokens
  // inpptree.c:1366-1367). When no '?' follows, this is a plain additive — so
  // expressions without a ternary parse bit-identically to the prior grammar.
  private _parseTernary(): ExprNode {
    const cond = this._parseAdditive();
    if (this._peek().kind === TokenKind.Question) {
      this._advance(); // consume '?'
      const thenE = this._parseTernary();
      this._expect(TokenKind.Colon, "':'");
      const elseE = this._parseTernary();
      return ternaryNode(cond, thenE, elseE);
    }
    return cond;
  }

  // additive: multiplicative (('+' | '-') multiplicative)*
  private _parseAdditive(): ExprNode {
    let left = this._parseMultiplicative();
    while (true) {
      const tok = this._peek();
      if (tok.kind === TokenKind.Plus || tok.kind === TokenKind.Minus) {
        this._advance();
        const op = tok.kind === TokenKind.Plus ? "+" : "-";
        const right = this._parseMultiplicative();
        left = binOp(op, left, right);
      } else {
        break;
      }
    }
    return left;
  }

  // multiplicative: power (('*' | '/') power)*
  private _parseMultiplicative(): ExprNode {
    let left = this._parsePower();
    while (true) {
      const tok = this._peek();
      if (tok.kind === TokenKind.Star || tok.kind === TokenKind.Slash) {
        this._advance();
        const op = tok.kind === TokenKind.Star ? "*" : "/";
        const right = this._parsePower();
        left = binOp(op, left, right);
      } else {
        break;
      }
    }
    return left;
  }

  // power: unary ('^' power)?   (right-associative)
  private _parsePower(): ExprNode {
    const base = this._parseUnary();
    if (this._peek().kind === TokenKind.Caret) {
      this._advance();
      const exp = this._parsePower(); // right-recursive for right-associativity
      return binOp("^", base, exp);
    }
    return base;
  }

  // unary: '-' unary | primary
  private _parseUnary(): ExprNode {
    if (this._peek().kind === TokenKind.Minus) {
      this._advance();
      const operand = this._parseUnary();
      return unaryOp("-", operand);
    }
    return this._parsePrimary();
  }

  // primary: number | ident ('(' args ')')? | '(' expression ')'
  private _parsePrimary(): ExprNode {
    const tok = this._peek();

    if (tok.kind === TokenKind.Number) {
      this._advance();
      return numNode(tok.value!);
    }

    if (tok.kind === TokenKind.Ident) {
      this._advance();
      const name = tok.name!;

      // Function call
      if (this._peek().kind === TokenKind.LParen) {
        this._advance(); // consume '('

        // V(label)- circuit node voltage reference
        if (name === "V") {
          const labelTok = this._expect(TokenKind.Ident, "label identifier");
          this._expect(TokenKind.RParen, "')'");
          return circuitVoltageNode(labelTok.name!);
        }

        // I(label)- circuit branch current reference
        if (name === "I") {
          const labelTok = this._expect(TokenKind.Ident, "label identifier");
          this._expect(TokenKind.RParen, "')'");
          return circuitCurrentNode(labelTok.name!);
        }

        // random()- white noise
        if (name === "random") {
          this._expect(TokenKind.RParen, "')'");
          return builtinFuncNode("random");
        }

        const args: ExprNode[] = [];
        if (this._peek().kind !== TokenKind.RParen) {
          args.push(this._parseTernary());
          while (this._peek().kind === TokenKind.Comma) {
            this._advance();
            args.push(this._parseTernary());
          }
        }
        this._expect(TokenKind.RParen, "')'");

        // ternary_fcn(cond, then, else) — the functional ternary surface
        // (inpptree.c:1125-1146); same node as the `?:` operator.
        if (name === "ternary_fcn") {
          if (args.length !== 3) {
            throw new ExprParseError("ternary_fcn expects exactly 3 arguments", tok.pos);
          }
          return ternaryNode(args[0]!, args[1]!, args[2]!);
        }

        // ddt(arg) — transient time-derivative (ptfuncs.c:422-466). The 7-slot
        // history (inpptree.c:1096) and the accepted-step counter live on the
        // node; the evaluator mutates them.
        if (name === "ddt") {
          if (args.length !== 1) {
            throw new ExprParseError("ddt expects exactly 1 argument", tok.pos);
          }
          return { kind: "ddt", arg: args[0]!, history: new Float64Array(7), counter: { n: 0 } };
        }

        // pwl(arg, x1,y1, x2,y2, ...) — piecewise-linear lookup. The trailing
        // (x,y) pairs are compile-time constants stripped into `points`
        // (inpptree.c:1022-1087, ascending-abscissa check inpptree.c:1072-1076).
        if (name === "pwl") {
          if (args.length < 3 || (args.length - 1) % 2 !== 0) {
            throw new ExprParseError("pwl expects arg followed by (x,y) breakpoint pairs", tok.pos);
          }
          const points: number[] = [];
          for (let p = 1; p < args.length; p++) {
            const a = args[p]!;
            if (a.kind !== "number") {
              throw new ExprParseError("pwl breakpoints must be constants", tok.pos);
            }
            points.push(a.value);
          }
          for (let k = 2; k < points.length; k += 2) {
            if (points[k]! <= points[k - 2]!) {
              throw new ExprParseError("pwl abscissas must be strictly ascending", tok.pos);
            }
          }
          return { kind: "pwl", arg: args[0]!, points, derivative: false };
        }

        return callNode(name, args);
      }

      // time, freq and temper are builtin simulation variables
      if (name === "time") return builtinVarNode("time");
      if (name === "freq") return builtinVarNode("freq");
      if (name === "temper") return builtinVarNode("temper");

      // Variable or constant
      return varNode(name);
    }

    if (tok.kind === TokenKind.LParen) {
      this._advance(); // consume '('
      const inner = this._parseTernary();
      this._expect(TokenKind.RParen, "')'");
      return inner;
    }

    throw new ExprParseError(`Unexpected token`, tok.pos);
  }
}

// ---------------------------------------------------------------------------
// Public parse entry point
// ---------------------------------------------------------------------------

/**
 * Parse a mathematical expression string into an ExprNode AST.
 *
 * Throws ExprParseError with position information on syntax errors.
 */
export function parseExpression(text: string): ExprNode {
  const tokens = tokenize(text);
  const parser = new Parser(tokens);
  return parser.parseExpression();
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate an ExprNode AST with a variable binding environment.
 *
 * Built-in constants (pi, e) are always available. User-supplied variables
 * in `env` override nothing (constants take no name from env).
 *
 * Throws ExprParseError when a variable is missing from `env`.
 * Throws UnknownNodeKindError for unrecognized node kinds (e.g. Phase 5 extensions).
 * Division by zero and other IEEE 754 edge cases return Infinity/NaN per standard.
 */
export function evaluateExpression(expr: ExprNode, env: Record<string, number>): number {
  switch (expr.kind) {
    case "number":
      return expr.value;

    case "variable": {
      const name = expr.name;
      if (name in BUILTIN_CONSTANTS) {
        return BUILTIN_CONSTANTS[name];
      }
      if (name in env) {
        return env[name];
      }
      throw new ExprParseError(`Undefined variable "${name}"`, 0);
    }

    case "unary":
      return -evaluateExpression(expr.operand, env);

    case "binary": {
      const left = evaluateExpression(expr.left, env);
      const right = evaluateExpression(expr.right, env);
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
        throw new ExprParseError(`Unknown function "${fn}"`, 0);
      }
      const args = expr.args.map((a) => evaluateExpression(a, env));
      return impl(...args);
    }

    case "ternary": {
      // ngspice PT_TERN selects by `cond != 0` (ifeval.c:145).
      const c = evaluateExpression(expr.cond, env);
      return c !== 0
        ? evaluateExpression(expr.then, env)
        : evaluateExpression(expr.else, env);
    }

    case "circuit-voltage":
    case "circuit-current":
    case "builtin-var":
    case "builtin-func":
    case "ddt":
    case "pwl":
      throw new ExprParseError(`Cannot evaluate ${expr.kind} without runtime context`, 0);

    default:
      throw new UnknownNodeKindError((expr as { kind: string }).kind);
  }
}

// ---------------------------------------------------------------------------
// B-source IFeval tree (Part 0.A) — the asrc unit's parse-tree contract
// ---------------------------------------------------------------------------

/** One controlling variable of a B-source parse tree, in first-encounter order. */
export interface BSourceVar {
  /** `IF_NODE` ↔ `"node"` (circuit-voltage); `IF_INSTANCE` ↔ `"branch"` (circuit-current). */
  kind: "node" | "branch";
  /** The node-net / sense-source label the controlling quantity references. */
  label: string;
  /** `vals[valueIndex]` position, assigned by first-encounter order. */
  valueIndex: number;
}

/**
 * Extra binding inputs the asrc element threads into each `eval`: the
 * controlling values plus the time / temperature / mode / gmin context the
 * `temper`, `ddt`, and `/`-fudge paths read. `vals` is ordered `0..numVars-1`
 * matching `vars[].valueIndex` (asrcload.c:77-78).
 */
export interface BSourceEvalEnv {
  /** Per-controller values from the prior NR iterate (ngspice CKTrhsOld[ASRCvars[i]]). */
  vals: ArrayLike<number>;
  /** ngspice CKTgmin — feeds the `/`-operator fudge `gmin*1e-20` (ptfuncs.c:54-66). */
  gmin: number;
  /** Simulation time in seconds (ngspice CKTtime). */
  time: number;
  /** Circuit temperature in Kelvin (ngspice CKTtemp); read by `temper`. */
  temp: number;
  /** True when MODETRAN is active (gates `ddt`). */
  modeTran: boolean;
}

/** The combined IFeval result (ifeval.c:46-69): the value plus ∂f/∂var_i. */
export interface BSourceEvalResult {
  rhs: number;
  derivs: number[];
}

/**
 * The compiled B-source parse tree — the digiTS counterpart of ngspice's
 * `IFparseTree` (asrcdefs.h:34, ifeval.c). `eval` runs PTeval on the value
 * tree then on each pre-built per-variable derivative tree (ifeval.c:46-69),
 * returning `{ rhs, derivs[] }` of length `numVars`.
 */
export interface CompiledBSourceTree {
  numVars: number;
  vars: BSourceVar[];
  eval(env: BSourceEvalEnv): BSourceEvalResult;
}

/**
 * Walk the AST in source order, appending each distinct controlling quantity
 * (`circuit-voltage`→node, `circuit-current`→branch) the first time it is seen,
 * comparing by `(kind, label)`. Mirrors ngspice mkvnode/mkinode first-encounter
 * dedup (inpptree.c:1195-1239): `numVars = vars.length`.
 */
function collectBSourceVars(ast: ExprNode, out: BSourceVar[]): void {
  switch (ast.kind) {
    case "circuit-voltage": {
      if (!out.some((v) => v.kind === "node" && v.label === ast.label)) {
        out.push({ kind: "node", label: ast.label, valueIndex: out.length });
      }
      return;
    }
    case "circuit-current": {
      if (!out.some((v) => v.kind === "branch" && v.label === ast.label)) {
        out.push({ kind: "branch", label: ast.label, valueIndex: out.length });
      }
      return;
    }
    case "number":
    case "variable":
    case "builtin-var":
    case "builtin-func":
      return;
    case "unary":
      collectBSourceVars(ast.operand, out);
      return;
    case "binary":
      collectBSourceVars(ast.left, out);
      collectBSourceVars(ast.right, out);
      return;
    case "call":
      for (const a of ast.args) collectBSourceVars(a, out);
      return;
    case "ternary":
      collectBSourceVars(ast.cond, out);
      collectBSourceVars(ast.then, out);
      collectBSourceVars(ast.else, out);
      return;
    case "ddt":
      collectBSourceVars(ast.arg, out);
      return;
    case "pwl":
      collectBSourceVars(ast.arg, out);
      return;
    default: {
      const exhaustive: never = ast;
      void exhaustive;
      return;
    }
  }
}

/**
 * Build the v41 IFeval surface (Part 0.A) from an expression string:
 *   1. parse → AST (`parseExpression`);
 *   2. collect `vars[]` in first-encounter order (`collectBSourceVars`);
 *   3. for each var, build `differentiateBSource(ast, kind, label)` and compile
 *      it with `compileBSource` — the derivative trees are built ONCE at parse
 *      time, matching ngspice's `derivs[i] = PTdifferentiate(p, i)`
 *      (inpptree.c:234-235);
 *   4. compile the value AST with `compileBSource`.
 *
 * `eval(env)` sets the `/`-fudge floor `gmin*1e-20` (ifeval.c:86), binds each
 * var's value into the context keyed by `(kind, label)`, evaluates the value
 * closure for `rhs`, then each derivative closure for `derivs[i]` — value
 * first, derivatives `0..numVars-1` (ifeval.c:46-69).
 */
export function buildBSourceTree(exprText: string): CompiledBSourceTree {
  const ast = parseExpression(exprText);
  const vars: BSourceVar[] = [];
  collectBSourceVars(ast, vars);

  const valueClosure = compileBSource(ast);
  const derivClosures = vars.map((v) => compileBSource(differentiateBSource(ast, v.kind, v.label)));

  return {
    numVars: vars.length,
    vars,
    eval(env: BSourceEvalEnv): BSourceEvalResult {
      const voltageByLabel = new Map<string, number>();
      const currentByLabel = new Map<string, number>();
      for (const v of vars) {
        const bound = env.vals[v.valueIndex] ?? 0;
        if (v.kind === "node") voltageByLabel.set(v.label, bound);
        else currentByLabel.set(v.label, bound);
      }
      const ctx: ExpressionContext = {
        getNodeVoltage: (label) => voltageByLabel.get(label) ?? 0,
        getBranchCurrent: (label) => currentByLabel.get(label) ?? 0,
        time: env.time,
        temp: env.temp,
        // ngspice PTfudge_factor = gmin * 1e-20 (ifeval.c:86).
        bsourceFudge: env.gmin * 1.0e-20,
        modeTran: env.modeTran,
      };
      const rhs = valueClosure(ctx);
      const derivs = new Array<number>(vars.length);
      for (let i = 0; i < derivClosures.length; i++) {
        derivs[i] = derivClosures[i]!(ctx);
      }
      return { rhs, derivs };
    },
  };
}
