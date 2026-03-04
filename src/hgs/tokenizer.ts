/**
 * HGS tokenizer — port of Digital's hdl/hgs/Tokenizer.java.
 *
 * Produces tokens from HGS source code. Tracks line numbers for error reporting.
 */

import { ParserError } from "./parser-error";

// ---------------------------------------------------------------------------
// Token types
// ---------------------------------------------------------------------------

export const enum TokenType {
  // Literals
  NUMBER = "NUMBER",
  DOUBLE = "DOUBLE",
  STRING = "STRING",
  TRUE = "TRUE",
  FALSE = "FALSE",

  // Identifiers
  IDENT = "IDENT",

  // Operators (binary)
  ADD = "ADD",
  SUB = "SUB",
  MUL = "MUL",
  DIV = "DIV",
  MOD = "MOD",
  AND = "AND",
  OR = "OR",
  XOR = "XOR",
  NOT = "NOT",
  EQUAL = "EQUAL",
  NOTEQUAL = "NOTEQUAL",
  LESS = "LESS",
  LESSEQUAL = "LESSEQUAL",
  GREATER = "GREATER",
  GREATEREQUAL = "GREATEREQUAL",
  SHIFTLEFT = "SHIFTLEFT",
  SHIFTRIGHT = "SHIFTRIGHT",

  // Delimiters
  OPEN = "OPEN",
  CLOSE = "CLOSE",
  OPENBRACE = "OPENBRACE",
  CLOSEDBRACE = "CLOSEDBRACE",
  OPENSQUARE = "OPENSQUARE",
  CLOSEDSQUARE = "CLOSEDSQUARE",
  DOT = "DOT",
  COLON = "COLON",
  SEMICOLON = "SEMICOLON",
  COMMA = "COMMA",

  // Keywords
  IF = "IF",
  ELSE = "ELSE",
  FOR = "FOR",
  WHILE = "WHILE",
  FUNC = "FUNC",
  REPEAT = "REPEAT",
  UNTIL = "UNTIL",
  RETURN = "RETURN",
  EXPORT = "EXPORT",

  // Template
  CODEEND = "CODEEND",

  // End of input
  EOF = "EOF",

  // Unknown / error
  UNKNOWN = "UNKNOWN",
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

export interface Token {
  readonly type: TokenType;
  /** Raw text of the token (identifier name, number digits, string content) */
  readonly value: string;
  readonly line: number;
}

// ---------------------------------------------------------------------------
// Keyword map
// ---------------------------------------------------------------------------

const KEYWORDS = new Map<string, TokenType>([
  ["if", TokenType.IF],
  ["else", TokenType.ELSE],
  ["for", TokenType.FOR],
  ["while", TokenType.WHILE],
  ["func", TokenType.FUNC],
  ["repeat", TokenType.REPEAT],
  ["until", TokenType.UNTIL],
  ["return", TokenType.RETURN],
  ["export", TokenType.EXPORT],
  ["true", TokenType.TRUE],
  ["false", TokenType.FALSE],
]);

// ---------------------------------------------------------------------------
// Tokenizer class
// ---------------------------------------------------------------------------

export class Tokenizer {
  private readonly src: string;
  private pos: number = 0;
  private line: number = 1;
  private peeked: Token | null = null;

  constructor(source: string) {
    this.src = source;
  }

  getLine(): number {
    return this.line;
  }

  /** Look ahead without consuming. */
  peek(): Token {
    if (this.peeked === null) {
      this.peeked = this.readNext();
    }
    return this.peeked;
  }

  /** Consume and return the next token. */
  next(): Token {
    if (this.peeked !== null) {
      const t = this.peeked;
      this.peeked = null;
      return t;
    }
    return this.readNext();
  }

  /** Consume and verify type; throw ParserError on mismatch. */
  expect(type: TokenType): Token {
    const t = this.next();
    if (t.type !== type) {
      throw new ParserError(
        `expected ${type} but found ${t.type} (${t.value || t.type})`,
        t.line,
      );
    }
    return t;
  }

  /**
   * Read raw text up to the start of the next `<?` or `{?` code block.
   * Resets the peeked token since we consumed characters directly.
   * Returns the literal text string.
   */
  readText(): string {
    this.peeked = null;
    let text = "";
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if ((c === "<" || c === "{") && this.src[this.pos + 1] === "?") {
        this.pos += 2; // consume `<?` or `{?`
        return text;
      }
      if (c === "\n") this.line++;
      text += c;
      this.pos++;
    }
    return text;
  }

  // ---------------------------------------------------------------------------
  // Internal lexer
  // ---------------------------------------------------------------------------

  private readNext(): Token {
    while (true) {
      this.skipWhitespace();
      if (this.pos >= this.src.length) {
        return this.tok(TokenType.EOF, "");
      }

      const startLine = this.line;
      const c = this.src[this.pos++];

      switch (c) {
        case "(":
          return this.tok(TokenType.OPEN, c, startLine);
        case ")":
          return this.tok(TokenType.CLOSE, c, startLine);
        case "{":
          return this.tok(TokenType.OPENBRACE, c, startLine);
        case "}":
          return this.tok(TokenType.CLOSEDBRACE, c, startLine);
        case "[":
          return this.tok(TokenType.OPENSQUARE, c, startLine);
        case "]":
          return this.tok(TokenType.CLOSEDSQUARE, c, startLine);
        case ".":
          return this.tok(TokenType.DOT, c, startLine);
        case ":":
          return this.tok(TokenType.COLON, c, startLine);
        case ";":
          return this.tok(TokenType.SEMICOLON, c, startLine);
        case ",":
          return this.tok(TokenType.COMMA, c, startLine);
        case "+":
          return this.tok(TokenType.ADD, c, startLine);
        case "-":
          return this.tok(TokenType.SUB, c, startLine);
        case "*":
          return this.tok(TokenType.MUL, c, startLine);
        case "%":
          return this.tok(TokenType.MOD, c, startLine);
        case "&":
          return this.tok(TokenType.AND, c, startLine);
        case "|":
          return this.tok(TokenType.OR, c, startLine);
        case "^":
          return this.tok(TokenType.XOR, c, startLine);
        case "~":
          return this.tok(TokenType.NOT, c, startLine);
        case "/":
          if (this.src[this.pos] === "/") {
            this.pos++;
            this.skipLine();
            continue;
          }
          return this.tok(TokenType.DIV, c, startLine);
        case "<":
          if (this.src[this.pos] === "<") {
            this.pos++;
            return this.tok(TokenType.SHIFTLEFT, "<<", startLine);
          }
          if (this.src[this.pos] === "=") {
            this.pos++;
            return this.tok(TokenType.LESSEQUAL, "<=", startLine);
          }
          return this.tok(TokenType.LESS, c, startLine);
        case ">":
          if (this.src[this.pos] === ">") {
            this.pos++;
            return this.tok(TokenType.SHIFTRIGHT, ">>>", startLine);
          }
          if (this.src[this.pos] === "=") {
            this.pos++;
            return this.tok(TokenType.GREATEREQUAL, ">=", startLine);
          }
          return this.tok(TokenType.GREATER, c, startLine);
        case "=":
          return this.tok(TokenType.EQUAL, c, startLine);
        case "!":
          if (this.src[this.pos] === "=") {
            this.pos++;
            return this.tok(TokenType.NOTEQUAL, "!=", startLine);
          }
          return this.tok(TokenType.NOT, c, startLine);
        case "?":
          if (this.src[this.pos] === ">" || this.src[this.pos] === "}") {
            this.pos++;
            return this.tok(TokenType.CODEEND, "?>", startLine);
          }
          return this.tok(TokenType.UNKNOWN, c, startLine);
        case '"':
          return this.readString(startLine);
        case "'": {
          // Escaped identifier: 'name'
          let name = "";
          while (this.pos < this.src.length && this.src[this.pos] !== "'") {
            name += this.src[this.pos++];
          }
          if (this.pos >= this.src.length) {
            throw new ParserError("EOF inside escaped identifier", startLine);
          }
          this.pos++; // consume closing '
          return this.tok(TokenType.IDENT, name, startLine);
        }
        default:
          if (isIdentStart(c)) {
            return this.readIdent(c, startLine);
          }
          if (isDigit(c)) {
            return this.readNumber(c, startLine);
          }
          return this.tok(TokenType.UNKNOWN, c, startLine);
      }
    }
  }

  private tok(type: TokenType, value: string, line?: number): Token {
    return { type, value, line: line ?? this.line };
  }

  private skipWhitespace(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === " " || c === "\t" || c === "\r") {
        this.pos++;
      } else if (c === "\n") {
        this.line++;
        this.pos++;
      } else {
        break;
      }
    }
  }

  private skipLine(): void {
    while (this.pos < this.src.length && this.src[this.pos] !== "\n") {
      this.pos++;
    }
  }

  private readString(startLine: number): Token {
    let value = "";
    while (this.pos < this.src.length) {
      const c = this.src[this.pos++];
      if (c === '"') {
        return this.tok(TokenType.STRING, value, startLine);
      }
      if (c === "\n") this.line++;
      if (c === "\\") {
        if (this.pos >= this.src.length) {
          throw new ParserError("EOF in string escape", startLine);
        }
        const esc = this.src[this.pos++];
        switch (esc) {
          case "\\":
            value += "\\";
            break;
          case "n":
            value += "\n";
            break;
          case "r":
            value += "\r";
            break;
          case "t":
            value += "\t";
            break;
          case '"':
            value += '"';
            break;
          default:
            throw new ParserError(`invalid escape: \\${esc}`, startLine);
        }
      } else {
        value += c;
      }
    }
    throw new ParserError("EOF inside string literal", startLine);
  }

  private readIdent(first: string, startLine: number): Token {
    let name = first;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (isIdentStart(c) || isDigit(c)) {
        name += c;
        this.pos++;
      } else {
        break;
      }
    }
    const kwType = KEYWORDS.get(name);
    return this.tok(kwType ?? TokenType.IDENT, name, startLine);
  }

  private readNumber(first: string, startLine: number): Token {
    let raw = first;
    let isDouble = false;
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (isDigit(c) || isHexChar(c) || c === "x" || c === "X") {
        raw += c;
        this.pos++;
      } else if (c === ".") {
        raw += c;
        this.pos++;
        isDouble = true;
      } else {
        break;
      }
    }
    return this.tok(isDouble ? TokenType.DOUBLE : TokenType.NUMBER, raw, startLine);
  }
}

// ---------------------------------------------------------------------------
// Character helpers
// ---------------------------------------------------------------------------

function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isHexChar(c: string): boolean {
  return (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}
