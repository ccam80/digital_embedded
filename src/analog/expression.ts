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

// ---------------------------------------------------------------------------
// AST node types
// ---------------------------------------------------------------------------

export type ExprNode =
  | { kind: "number"; value: number }
  | { kind: "variable"; name: string }
  | { kind: "unary"; op: "-"; operand: ExprNode }
  | { kind: "binary"; op: "+" | "-" | "*" | "/" | "^"; left: ExprNode; right: ExprNode }
  | { kind: "call"; fn: string; args: ExprNode[] };

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

const BUILTIN_FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  exp: Math.exp,
  log: Math.log,
  log10: Math.log10,
  sqrt: Math.sqrt,
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  pow: Math.pow,
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
    const node = this._parseAdditive();
    if (this._peek().kind !== TokenKind.EOF) {
      throw new ExprParseError("Unexpected token", this._peek().pos);
    }
    return node;
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
      const pos = this._peek().pos;
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
        const args: ExprNode[] = [];
        if (this._peek().kind !== TokenKind.RParen) {
          args.push(this._parseAdditive());
          while (this._peek().kind === TokenKind.Comma) {
            this._advance();
            args.push(this._parseAdditive());
          }
        }
        this._expect(TokenKind.RParen, "')'");
        return callNode(name, args);
      }

      // Variable or constant
      return varNode(name);
    }

    if (tok.kind === TokenKind.LParen) {
      this._advance(); // consume '('
      const inner = this._parseAdditive();
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

    default: {
      const exhaustive: never = expr;
      throw new UnknownNodeKindError((exhaustive as ExprNode).kind);
    }
  }
}
