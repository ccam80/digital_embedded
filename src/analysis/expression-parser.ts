/**
 * Recursive descent parser for boolean expressions.
 *
 * Supported syntax:
 *   Variables  : identifiers starting with a letter, e.g. A, B, x0, var_1
 *   AND        : & * ·
 *   OR         : | +
 *   NOT        : ! ~ ¬
 *   Parentheses: ( )
 *   Constants  : 0  1
 *
 * Operator precedence (highest to lowest):
 *   NOT  (prefix unary, right-associative)
 *   AND  (left-associative, binary/n-ary)
 *   OR   (left-associative, binary/n-ary, lowest)
 *
 * Errors include the 0-based character position of the unexpected token.
 */

import {
  type BoolExpr,
  and,
  constant,
  negatedVariable as _negatedVariable,
  not,
  or,
  variable,
} from './expression.js';

// ---------------------------------------------------------------------------
// Public error type
// ---------------------------------------------------------------------------

export class ParseError extends Error {
  /** 0-based character position in the source string where the error occurred. */
  readonly position: number;

  constructor(message: string, position: number) {
    super(`${message} (position ${position})`);
    this.name = 'ParseError';
    this.position = position;
  }
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind =
  | 'VAR'       // identifier or single-char variable
  | 'CONST'     // 0 or 1
  | 'AND'       // & * ·
  | 'OR'        // | +
  | 'NOT'       // ! ~ ¬
  | 'LPAREN'    // (
  | 'RPAREN'    // )
  | 'EOF';

interface Token {
  kind: TokenKind;
  text: string;
  pos: number;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < src.length) {
    const ch = src[i]!;

    // Skip whitespace
    if (/\s/.test(ch)) { i++; continue; }

    // Identifier / variable (starts with letter or underscore)
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_[\]]/.test(src[j]!)) j++;
      tokens.push({ kind: 'VAR', text: src.slice(i, j), pos: i });
      i = j;
      continue;
    }

    // Numeric constant 0 or 1
    if (ch === '0' || ch === '1') {
      tokens.push({ kind: 'CONST', text: ch, pos: i });
      i++;
      continue;
    }

    // AND operators
    if (ch === '&' || ch === '*') {
      tokens.push({ kind: 'AND', text: ch, pos: i });
      i++;
      continue;
    }
    // Middle dot (·) — UTF-8 multi-byte
    if (src.startsWith('·', i)) {
      tokens.push({ kind: 'AND', text: '·', pos: i });
      i += '·'.length;
      continue;
    }

    // OR operators
    if (ch === '|' || ch === '+') {
      tokens.push({ kind: 'OR', text: ch, pos: i });
      i++;
      continue;
    }

    // NOT operators
    if (ch === '!' || ch === '~') {
      tokens.push({ kind: 'NOT', text: ch, pos: i });
      i++;
      continue;
    }
    // NOT: ¬ (UTF-8 multi-byte)
    if (src.startsWith('¬', i)) {
      tokens.push({ kind: 'NOT', text: '¬', pos: i });
      i += '¬'.length;
      continue;
    }

    // Parentheses
    if (ch === '(') { tokens.push({ kind: 'LPAREN', text: ch, pos: i }); i++; continue; }
    if (ch === ')') { tokens.push({ kind: 'RPAREN', text: ch, pos: i }); i++; continue; }

    throw new ParseError(`Unexpected character '${ch}'`, i);
  }

  tokens.push({ kind: 'EOF', text: '', pos: src.length });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  private readonly _tokens: Token[];
  private _pos = 0;

  constructor(tokens: Token[]) {
    this._tokens = tokens;
  }

  private peek(): Token {
    return this._tokens[this._pos]!;
  }

  private consume(): Token {
    return this._tokens[this._pos++]!;
  }

  private expect(kind: TokenKind): Token {
    const tok = this.peek();
    if (tok.kind !== kind) {
      throw new ParseError(
        `Expected ${kind} but got '${tok.text || 'EOF'}'`,
        tok.pos,
      );
    }
    return this.consume();
  }

  /**
   * Top-level entry: parse a full expression.
   * Expects exactly one expression followed by EOF.
   */
  parse(): BoolExpr {
    const expr = this.parseOr();
    const tok = this.peek();
    if (tok.kind !== 'EOF') {
      throw new ParseError(`Unexpected token '${tok.text}'`, tok.pos);
    }
    return expr;
  }

  /**
   * OR expression: term (OR term)*
   * Lowest precedence.
   */
  private parseOr(): BoolExpr {
    const operands: BoolExpr[] = [this.parseAnd()];
    while (this.peek().kind === 'OR') {
      this.consume();
      operands.push(this.parseAnd());
    }
    return or(operands);
  }

  /**
   * AND expression: factor (AND factor)*
   * AND is also implied by juxtaposition of two factors
   * (NOT VAR CONST LPAREN immediately following another factor without an operator).
   */
  private parseAnd(): BoolExpr {
    const operands: BoolExpr[] = [this.parseNot()];
    while (this._isAndOperand()) {
      // Consume explicit AND token if present
      if (this.peek().kind === 'AND') this.consume();
      operands.push(this.parseNot());
    }
    return and(operands);
  }

  /**
   * Returns true if the next token can start a factor (implicit AND)
   * or is an explicit AND operator.
   */
  private _isAndOperand(): boolean {
    const k = this.peek().kind;
    return k === 'AND' || k === 'NOT' || k === 'VAR' || k === 'CONST' || k === 'LPAREN';
  }

  /**
   * NOT expression: NOT* factor
   */
  private parseNot(): BoolExpr {
    if (this.peek().kind === 'NOT') {
      this.consume();
      const operand = this.parseNot();
      return not(operand);
    }
    return this.parsePrimary();
  }

  /**
   * Primary: variable | constant | ( expr )
   */
  private parsePrimary(): BoolExpr {
    const tok = this.peek();

    if (tok.kind === 'VAR') {
      this.consume();
      return variable(tok.text);
    }

    if (tok.kind === 'CONST') {
      this.consume();
      return constant(tok.text === '1');
    }

    if (tok.kind === 'LPAREN') {
      this.consume();
      const inner = this.parseOr();
      this.expect('RPAREN');
      return inner;
    }

    throw new ParseError(
      `Expected expression but got '${tok.text || 'EOF'}'`,
      tok.pos,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a boolean expression string into a BoolExpr AST.
 *
 * @param text  The expression text.
 * @returns     Parsed BoolExpr.
 * @throws      ParseError with position information on syntax errors.
 */
export function parseExpression(text: string): BoolExpr {
  const tokens = tokenize(text);
  const parser = new Parser(tokens);
  return parser.parse();
}
