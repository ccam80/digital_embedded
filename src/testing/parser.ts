/**
 * Truth Table Parser for Digital's test vector syntax.
 *
 * Parses test data strings embedded in Testcase components or provided
 * externally. Pure function, no side effects, no browser dependencies.
 *
 * Supported syntax:
 *   - Signal name headers (first non-comment, non-empty line)
 *   - Values: binary (0, 1), hex (0xFF), decimal (255), X (don't care), C (clock), Z (high-Z)
 *   - loop(var, N) / end loop  for repetition with named variable
 *   - repeat(N) <row>          for repeating a single row
 *   - bits(N, expr)            to expand an expression into N individual bits
 *   - Comments: lines starting with # (or mid-line via # character)
 *   - Whitespace-separated columns
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TestValue =
  | { kind: 'value'; value: bigint }
  | { kind: 'dontCare' }
  | { kind: 'clock' }
  | { kind: 'highZ' };

export interface ParsedVector {
  inputs: Map<string, TestValue>;
  outputs: Map<string, TestValue>;
}

export interface ParsedTestData {
  inputNames: string[];
  outputNames: string[];
  vectors: ParsedVector[];
}

// ---------------------------------------------------------------------------
// Internal tokenizer
// ---------------------------------------------------------------------------

const enum TK {
  EOF,
  EOL,
  IDENT,
  NUMBER,
  OPEN,     // (
  CLOSE,    // )
  COMMA,    // ,
  SEMICOLON,// ;
  AND, OR, XOR,
  ADD, SUB, MUL, DIV, MOD,
  SHIFT_LEFT, SHIFT_RIGHT,
  EQUAL, NOT_EQUAL,
  GREATER, GREATER_EQUAL, SMALLER, SMALLER_EQUAL,
  BIN_NOT, LOG_NOT,
  // keywords
  KW_LOOP, KW_END, KW_REPEAT, KW_BITS,
  KW_LET, KW_DECLARE, KW_WHILE, KW_INIT, KW_MEMORY, KW_PROGRAM, KW_RESETRANDOM,
}

const KEYWORDS: Record<string, TK> = {
  loop:        TK.KW_LOOP,
  end:         TK.KW_END,
  repeat:      TK.KW_REPEAT,
  bits:        TK.KW_BITS,
  let:         TK.KW_LET,
  declare:     TK.KW_DECLARE,
  while:       TK.KW_WHILE,
  init:        TK.KW_INIT,
  memory:      TK.KW_MEMORY,
  program:     TK.KW_PROGRAM,
  resetRandom: TK.KW_RESETRANDOM,
};

interface TokenInfo {
  type: TK;
  text: string;
  line: number;
}

class Tokenizer {
  private readonly src: string;
  private pos: number = 0;
  private line: number = 1;
  private peeked: TokenInfo | null = null;

  constructor(src: string) {
    this.src = src;
  }

  peek(): TokenInfo {
    if (this.peeked !== null) return this.peeked;
    this.peeked = this.readToken();
    return this.peeked;
  }

  next(): TokenInfo {
    const t = this.peek();
    this.peeked = null;
    return t;
  }

  consume(): void {
    this.peeked = null;
  }

  getLine(): number {
    return this.peeked?.line ?? this.line;
  }

  /** Skip empty/comment-only lines at start of input. */
  skipEmptyLines(): void {
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\r') {
        this.pos++;
      } else if (c === '\n') {
        this.pos++;
        this.line++;
      } else if (c === '#') {
        // skip comment line
        while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++;
      } else {
        break;
      }
    }
  }

  /**
   * Read a signal name from the header line. Header names may contain any
   * non-whitespace, non-newline character.
   */
  nextHeaderIdent(): TokenInfo {
    const startLine = this.line;
    // skip spaces/tabs only (not newlines)
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t') {
        this.pos++;
      } else {
        break;
      }
    }
    if (this.pos >= this.src.length) return { type: TK.EOF, text: '', line: startLine };
    const c = this.src[this.pos];
    if (c === '\r') {
      this.pos++;
      if (this.src[this.pos] === '\n') this.pos++;
      this.line++;
      return { type: TK.EOL, text: '', line: startLine };
    }
    if (c === '\n') {
      this.pos++;
      this.line++;
      return { type: TK.EOL, text: '', line: startLine };
    }
    if (c === '#') {
      // comment until EOL
      while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++;
      return { type: TK.EOL, text: '', line: startLine };
    }
    // read until whitespace or EOL
    let text = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break;
      text += ch;
      this.pos++;
    }
    return { type: TK.IDENT, text, line: startLine };
  }

  private readToken(): TokenInfo {
    // skip whitespace (not newlines)
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\r') {
        this.pos++;
      } else {
        break;
      }
    }

    const startLine = this.line;

    if (this.pos >= this.src.length) return { type: TK.EOF, text: '', line: startLine };

    const c = this.src[this.pos];

    // comments: skip to end of line, then return EOL
    if (c === '#') {
      while (this.pos < this.src.length && this.src[this.pos] !== '\n') this.pos++;
      // don't consume the newline — it will be picked up as EOL on next call
      return this.readToken();
    }

    if (c === '\n') {
      this.pos++;
      this.line++;
      return { type: TK.EOL, text: '\n', line: startLine };
    }

    this.pos++;

    switch (c) {
      case '(': return { type: TK.OPEN,      text: c, line: startLine };
      case ')': return { type: TK.CLOSE,     text: c, line: startLine };
      case ',': return { type: TK.COMMA,     text: c, line: startLine };
      case ';': return { type: TK.SEMICOLON, text: c, line: startLine };
      case '&': return { type: TK.AND,       text: c, line: startLine };
      case '|': return { type: TK.OR,        text: c, line: startLine };
      case '^': return { type: TK.XOR,       text: c, line: startLine };
      case '+': return { type: TK.ADD,       text: c, line: startLine };
      case '-': return { type: TK.SUB,       text: c, line: startLine };
      case '*': return { type: TK.MUL,       text: c, line: startLine };
      case '/': return { type: TK.DIV,       text: c, line: startLine };
      case '%': return { type: TK.MOD,       text: c, line: startLine };
      case '~': return { type: TK.BIN_NOT,   text: c, line: startLine };
      case '=': return { type: TK.EQUAL,     text: c, line: startLine };
      case '!': {
        if (this.src[this.pos] === '=') { this.pos++; return { type: TK.NOT_EQUAL, text: '!=', line: startLine }; }
        return { type: TK.LOG_NOT, text: c, line: startLine };
      }
      case '<': {
        if (this.src[this.pos] === '<') { this.pos++; return { type: TK.SHIFT_LEFT,    text: '<<', line: startLine }; }
        if (this.src[this.pos] === '=') { this.pos++; return { type: TK.SMALLER_EQUAL, text: '<=', line: startLine }; }
        return { type: TK.SMALLER, text: c, line: startLine };
      }
      case '>': {
        if (this.src[this.pos] === '>') { this.pos++; return { type: TK.SHIFT_RIGHT,   text: '>>', line: startLine }; }
        if (this.src[this.pos] === '=') { this.pos++; return { type: TK.GREATER_EQUAL, text: '>=', line: startLine }; }
        return { type: TK.GREATER, text: c, line: startLine };
      }
    }

    // numbers
    if (c >= '0' && c <= '9') {
      let text = c;
      while (this.pos < this.src.length) {
        const nc = this.src[this.pos];
        if (
          (nc >= '0' && nc <= '9') ||
          (nc >= 'a' && nc <= 'f') ||
          (nc >= 'A' && nc <= 'F') ||
          nc === 'x' || nc === 'X' ||
          nc === 'e' || nc === 'E' ||
          nc === '.' || nc === ':'
        ) {
          text += nc;
          this.pos++;
        } else {
          break;
        }
      }
      return { type: TK.NUMBER, text, line: startLine };
    }

    // identifiers / keywords
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      let text = c;
      while (this.pos < this.src.length) {
        const nc = this.src[this.pos];
        if (
          (nc >= 'a' && nc <= 'z') ||
          (nc >= 'A' && nc <= 'Z') ||
          (nc >= '0' && nc <= '9') ||
          nc === '_'
        ) {
          text += nc;
          this.pos++;
        } else {
          break;
        }
      }
      const kw = KEYWORDS[text];
      if (kw !== undefined) return { type: kw, text, line: startLine };
      return { type: TK.IDENT, text, line: startLine };
    }

    throw new ParseError(`Unexpected character '${c}'`, startLine);
  }
}

// ---------------------------------------------------------------------------
// Expression evaluator (for loop counts and bits() expressions)
// ---------------------------------------------------------------------------

type Expr = (vars: Map<string, bigint>) => bigint;

function parseNumericValue(text: string): bigint {
  const t = text.trim();
  if (t.startsWith('0x') || t.startsWith('0X')) {
    return BigInt('0x' + t.slice(2));
  }
  // scientific notation like 1e6
  if (/[eE]/.test(t) && !/[a-fA-F]/.test(t.replace(/[eE]/g, ''))) {
    return BigInt(Math.round(Number(t)));
  }
  return BigInt(t);
}

class ExprParser {
  constructor(private readonly tok: Tokenizer) {}

  parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.tok.peek().type === TK.OR) {
      this.tok.consume();
      const r = this.parseAnd();
      const l = left;
      left = (v) => l(v) | r(v);
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseXor();
    while (this.tok.peek().type === TK.AND) {
      this.tok.consume();
      const r = this.parseXor();
      const l = left;
      left = (v) => l(v) & r(v);
    }
    return left;
  }

  private parseXor(): Expr {
    let left = this.parseEquality();
    while (this.tok.peek().type === TK.XOR) {
      this.tok.consume();
      const r = this.parseEquality();
      const l = left;
      left = (v) => l(v) ^ r(v);
    }
    return left;
  }

  private parseEquality(): Expr {
    let left = this.parseCompare();
    while (true) {
      const t = this.tok.peek().type;
      if (t === TK.EQUAL) {
        this.tok.consume();
        const r = this.parseCompare();
        const l = left;
        left = (v) => l(v) === r(v) ? 1n : 0n;
      } else if (t === TK.NOT_EQUAL) {
        this.tok.consume();
        const r = this.parseCompare();
        const l = left;
        left = (v) => l(v) !== r(v) ? 1n : 0n;
      } else break;
    }
    return left;
  }

  private parseCompare(): Expr {
    let left = this.parseShift();
    while (true) {
      const t = this.tok.peek().type;
      if (t === TK.GREATER) {
        this.tok.consume(); const r = this.parseShift(); const l = left;
        left = (v) => l(v) > r(v) ? 1n : 0n;
      } else if (t === TK.GREATER_EQUAL) {
        this.tok.consume(); const r = this.parseShift(); const l = left;
        left = (v) => l(v) >= r(v) ? 1n : 0n;
      } else if (t === TK.SMALLER) {
        this.tok.consume(); const r = this.parseShift(); const l = left;
        left = (v) => l(v) < r(v) ? 1n : 0n;
      } else if (t === TK.SMALLER_EQUAL) {
        this.tok.consume(); const r = this.parseShift(); const l = left;
        left = (v) => l(v) <= r(v) ? 1n : 0n;
      } else break;
    }
    return left;
  }

  private parseShift(): Expr {
    let left = this.parseAdd();
    while (true) {
      const t = this.tok.peek().type;
      if (t === TK.SHIFT_LEFT) {
        this.tok.consume(); const r = this.parseAdd(); const l = left;
        left = (v) => l(v) << r(v);
      } else if (t === TK.SHIFT_RIGHT) {
        this.tok.consume(); const r = this.parseAdd(); const l = left;
        left = (v) => l(v) >> r(v);
      } else break;
    }
    return left;
  }

  private parseAdd(): Expr {
    let left = this.parseMul();
    while (true) {
      const t = this.tok.peek().type;
      if (t === TK.ADD) {
        this.tok.consume(); const r = this.parseMul(); const l = left;
        left = (v) => l(v) + r(v);
      } else if (t === TK.SUB) {
        this.tok.consume(); const r = this.parseMul(); const l = left;
        left = (v) => l(v) - r(v);
      } else break;
    }
    return left;
  }

  private parseMul(): Expr {
    let left = this.parseUnary();
    while (true) {
      const t = this.tok.peek().type;
      if (t === TK.MUL) {
        this.tok.consume(); const r = this.parseUnary(); const l = left;
        left = (v) => l(v) * r(v);
      } else if (t === TK.DIV) {
        this.tok.consume(); const r = this.parseUnary(); const l = left;
        left = (v) => l(v) / r(v);
      } else if (t === TK.MOD) {
        this.tok.consume(); const r = this.parseUnary(); const l = left;
        left = (v) => l(v) % r(v);
      } else break;
    }
    return left;
  }

  private parseUnary(): Expr {
    const t = this.tok.peek();
    if (t.type === TK.SUB) {
      this.tok.consume();
      const e = this.parseUnary();
      return (v) => -e(v);
    }
    if (t.type === TK.BIN_NOT) {
      this.tok.consume();
      const e = this.parseUnary();
      return (v) => ~e(v);
    }
    if (t.type === TK.LOG_NOT) {
      this.tok.consume();
      const e = this.parseUnary();
      return (v) => e(v) === 0n ? 1n : 0n;
    }
    return this.parseAtom();
  }

  private parseAtom(): Expr {
    const t = this.tok.next();
    if (t.type === TK.NUMBER) {
      const val = parseNumericValue(t.text);
      return () => val;
    }
    if (t.type === TK.IDENT) {
      const name = t.text;
      return (v) => {
        const val = v.get(name);
        if (val === undefined) return 0n;
        return val;
      };
    }
    if (t.type === TK.OPEN) {
      const e = this.parseExpr();
      expectToken(this.tok, TK.CLOSE, t.line);
      return e;
    }
    throw new ParseError(`Expected expression, got '${t.text}'`, t.line);
  }
}

// ---------------------------------------------------------------------------
// ParseError
// ---------------------------------------------------------------------------

class ParseError extends Error {
  readonly lineNumber: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'ParseError';
    this.lineNumber = line;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectToken(tok: Tokenizer, expected: TK, contextLine: number): TokenInfo {
  const t = tok.next();
  if (t.type !== expected) {
    throw new ParseError(`Unexpected token '${t.text}' (expected token type ${expected})`, t.line || contextLine);
  }
  return t;
}

function parseTestValue(text: string, line: number): TestValue {
  const upper = text.toUpperCase();
  if (upper === 'X') return { kind: 'dontCare' };
  if (upper === 'C') return { kind: 'clock' };
  if (upper === 'Z') return { kind: 'highZ' };
  try {
    return { kind: 'value', value: parseNumericValue(text) };
  } catch {
    throw new ParseError(`Not a valid test value: '${text}'`, line);
  }
}

// ---------------------------------------------------------------------------
// Intermediate representation for expansion
// ---------------------------------------------------------------------------

type ExpandedRow = Map<number, TestValue>;  // column index → value

interface LoopBlock {
  kind: 'loop';
  varName: string;
  count: number;
  body: Block[];
}

interface RepeatBlock {
  kind: 'repeat';
  count: number;
  row: ExpandedRow;
}

interface RowBlock {
  kind: 'row';
  row: ExpandedRow;
}

type Block = LoopBlock | RepeatBlock | RowBlock;

// ---------------------------------------------------------------------------
// Main parse pass
// ---------------------------------------------------------------------------

/**
 * Parse the header line into signal names.
 * Returns `{ names, separatorIndex }` where `separatorIndex` is the column
 * index of the `|` separator (marks the boundary between inputs and outputs).
 * If no `|` is present, `separatorIndex` is -1.
 */
function parseHeader(tok: Tokenizer): { names: string[]; separatorIndex: number } {
  const names: string[] = [];
  let separatorIndex = -1;
  while (true) {
    const t = tok.nextHeaderIdent();
    if (t.type === TK.EOL || t.type === TK.EOF) return { names, separatorIndex };
    if (t.type === TK.IDENT) {
      if (t.text === '|') {
        if (separatorIndex !== -1) {
          throw new ParseError('Multiple "|" separators in header', t.line);
        }
        separatorIndex = names.length;
        continue;
      }
      if (names.includes(t.text)) {
        throw new ParseError(`Signal name '${t.text}' used twice`, t.line);
      }
      names.push(t.text);
    }
  }
}

function parseRows(tok: Tokenizer, columnCount: number, endKeyword: TK | null): Block[] {
  const blocks: Block[] = [];

  while (true) {
    const t = tok.peek();

    if (t.type === TK.EOL) {
      tok.consume();
      continue;
    }

    if (t.type === TK.EOF) {
      if (endKeyword !== null) {
        throw new ParseError('Unexpected end of input (missing "end")', t.line);
      }
      return blocks;
    }

    if (t.type === TK.KW_END) {
      tok.consume();
      if (endKeyword === null) {
        throw new ParseError('"end" without matching loop or while', t.line);
      }
      // consume optional keyword label (e.g., "end loop")
      const next = tok.peek();
      if (next.type === TK.KW_LOOP || next.type === TK.KW_WHILE || next.type === TK.IDENT) {
        tok.consume();
      }
      return blocks;
    }

    if (t.type === TK.KW_LOOP) {
      tok.consume();
      expectToken(tok, TK.OPEN, t.line);
      const varTok = expectToken(tok, TK.IDENT, t.line);
      expectToken(tok, TK.COMMA, t.line);
      const countExpr = new ExprParser(tok).parseExpr();
      expectToken(tok, TK.CLOSE, t.line);
      const count = Number(countExpr(new Map()));
      // consume the EOL after loop(...)
      if (tok.peek().type === TK.EOL) tok.consume();
      const body = parseRows(tok, columnCount, TK.KW_LOOP);
      blocks.push({ kind: 'loop', varName: varTok.text, count, body });
      continue;
    }

    if (t.type === TK.KW_REPEAT) {
      tok.consume();
      expectToken(tok, TK.OPEN, t.line);
      const countExpr = new ExprParser(tok).parseExpr();
      expectToken(tok, TK.CLOSE, t.line);
      const count = Number(countExpr(new Map()));
      const row = parseDataRow(tok, columnCount);
      blocks.push({ kind: 'repeat', count, row });
      continue;
    }

    // regular data row — starts with NUMBER, IDENT (X/C/Z), OPEN (expr), or BITS
    if (
      t.type === TK.NUMBER ||
      t.type === TK.IDENT ||
      t.type === TK.OPEN ||
      t.type === TK.KW_BITS
    ) {
      const row = parseDataRow(tok, columnCount);
      blocks.push({ kind: 'row', row });
      continue;
    }

    // skip ignorable keywords like LET, DECLARE, INIT, etc. (not needed for basic test parsing)
    if (
      t.type === TK.KW_LET ||
      t.type === TK.KW_DECLARE ||
      t.type === TK.KW_INIT ||
      t.type === TK.KW_MEMORY ||
      t.type === TK.KW_PROGRAM ||
      t.type === TK.KW_RESETRANDOM
    ) {
      // consume until end of statement (semicolon or EOL)
      tok.consume();
      while (tok.peek().type !== TK.SEMICOLON && tok.peek().type !== TK.EOL && tok.peek().type !== TK.EOF) {
        tok.consume();
      }
      if (tok.peek().type === TK.SEMICOLON) tok.consume();
      continue;
    }

    throw new ParseError(`Unexpected token '${t.text}'`, t.line);
  }
}

function parseDataRow(tok: Tokenizer, columnCount: number): ExpandedRow {
  const row: ExpandedRow = new Map();
  let col = 0;
  const startLine = tok.peek().line;

  while (true) {
    const t = tok.peek();

    if (t.type === TK.EOL || t.type === TK.EOF) {
      tok.consume();
      break;
    }

    if (t.type === TK.NUMBER) {
      tok.consume();
      row.set(col++, parseTestValue(t.text, t.line));
      continue;
    }

    if (t.type === TK.IDENT) {
      tok.consume();
      row.set(col++, parseTestValue(t.text, t.line));
      continue;
    }

    if (t.type === TK.OPEN) {
      // expression in parentheses — evaluate and record numeric value
      tok.consume();
      const expr = new ExprParser(tok).parseExpr();
      expectToken(tok, TK.CLOSE, t.line);
      const val = expr(new Map());
      row.set(col++, { kind: 'value', value: val });
      continue;
    }

    if (t.type === TK.KW_BITS) {
      // bits(N, expr) — expand expr into N individual bit columns
      tok.consume();
      expectToken(tok, TK.OPEN, t.line);
      const nExpr = new ExprParser(tok).parseExpr();
      expectToken(tok, TK.COMMA, t.line);
      const valExpr = new ExprParser(tok).parseExpr();
      expectToken(tok, TK.CLOSE, t.line);
      const n = Number(nExpr(new Map()));
      const val = valExpr(new Map());
      for (let i = n - 1; i >= 0; i--) {
        const bit = (val >> BigInt(i)) & 1n;
        row.set(col++, { kind: 'value', value: bit });
      }
      continue;
    }

    throw new ParseError(`Unexpected token '${t.text}' in data row`, t.line);
  }

  if (col !== columnCount) {
    throw new ParseError(
      `Row has ${col} column(s) but header declares ${columnCount} signal(s)`,
      startLine,
    );
  }

  return row;
}

// ---------------------------------------------------------------------------
// Expansion pass: flatten blocks into flat vector list
// ---------------------------------------------------------------------------

function expandBlocks(blocks: Block[], vars: Map<string, bigint>): ExpandedRow[] {
  const rows: ExpandedRow[] = [];
  for (const block of blocks) {
    if (block.kind === 'row') {
      rows.push(block.row);
    } else if (block.kind === 'repeat') {
      for (let i = 0; i < block.count; i++) {
        rows.push(block.row);
      }
    } else if (block.kind === 'loop') {
      for (let i = 0; i < block.count; i++) {
        const childVars = new Map(vars);
        childVars.set(block.varName, BigInt(i));
        const childRows = expandBlocks(block.body, childVars);
        for (const r of childRows) rows.push(r);
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a Digital test vector string.
 *
 * @param text       The test data string (signal header + data rows).
 * @param inputCount Optional: number of leading signal names that are inputs.
 *                   The remaining names are outputs. If omitted, all names
 *                   are treated as inputs and outputNames is empty.
 */
export function parseTestData(text: string, inputCount?: number): ParsedTestData {
  if (text.trim().length === 0) {
    throw new ParseError('Test data is empty — no signal header found', 1);
  }

  const tok = new Tokenizer(text);
  tok.skipEmptyLines();

  const { names, separatorIndex } = parseHeader(tok);

  if (names.length === 0) {
    throw new ParseError('Test data header is empty — no signal names found', 1);
  }

  const columnCount = names.length;
  const blocks = parseRows(tok, columnCount, null);
  const expandedRows = expandBlocks(blocks, new Map());

  // Split names into inputs/outputs.
  // Priority: explicit inputCount > "|" separator > all-inputs fallback.
  const splitAt = inputCount !== undefined
    ? inputCount
    : separatorIndex >= 0
      ? separatorIndex
      : names.length;
  const inputNames  = names.slice(0, splitAt);
  const outputNames = names.slice(splitAt);

  // Build ParsedVector array
  const vectors: ParsedVector[] = expandedRows.map((row) => {
    const inputs  = new Map<string, TestValue>();
    const outputs = new Map<string, TestValue>();
    for (let i = 0; i < names.length; i++) {
      const val = row.get(i) ?? { kind: 'dontCare' as const };
      if (i < splitAt) {
        inputs.set(names[i], val);
      } else {
        outputs.set(names[i], val);
      }
    }
    return { inputs, outputs };
  });

  return { inputNames, outputNames, vectors };
}
