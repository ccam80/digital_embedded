/**
 * HGS recursive-descent parser- port of Digital's hdl/hgs/Parser.java.
 *
 * Produces an AST from HGS source code. Supports both pure-code mode
 * (parse) and template mode (parseTemplate) where text outside `<? ?>` is
 * emitted literally.
 */

import type {
  Statement,
  Expression,
  BlockStmt,
  IfStmt,
  ForStmt,
  WhileStmt,
  RepeatUntilStmt,
  FuncDeclStmt,
  ReturnStmt,
  DeclareStmt,
  ExportStmt,
  AssignStmt,
  IncrementStmt,
  OutputStmt,
  TextStmt,
  LiteralExpr,
  IdentExpr,
  BinaryExpr,
  UnaryExpr,
  ArrayLiteralExpr,
  StructLiteralExpr,
  FuncExpr,
  CallExpr,
  IndexExpr,
  FieldExpr,
} from "./ast";
import { Tokenizer, TokenType } from "./tokenizer";
import { ParserError } from "./parser-error";

// ---------------------------------------------------------------------------
// Operator precedence levels (lowest = 0, highest = N)
// Matches Digital's OperatorPrecedence enum ordering.
// ---------------------------------------------------------------------------

const PREC: Record<string, number> = {
  OR: 1,
  XOR: 2,
  AND: 3,
  EQUAL: 4,
  NOTEQUAL: 4,
  LESS: 5,
  LESSEQUAL: 5,
  GREATER: 5,
  GREATEREQUAL: 5,
  SHIFTLEFT: 6,
  SHIFTRIGHT: 6,
  ADD: 7,
  SUB: 7,
  MUL: 8,
  DIV: 8,
  MOD: 8,
};

type BinaryOp = BinaryExpr["op"];
const TOKEN_TO_BINOP = new Map<TokenType, BinaryOp>([
  [TokenType.ADD, "+"],
  [TokenType.SUB, "-"],
  [TokenType.MUL, "*"],
  [TokenType.DIV, "/"],
  [TokenType.MOD, "%"],
  [TokenType.AND, "&"],
  [TokenType.OR, "|"],
  [TokenType.XOR, "^"],
  [TokenType.EQUAL, "="],
  [TokenType.NOTEQUAL, "!="],
  [TokenType.LESS, "<"],
  [TokenType.LESSEQUAL, "<="],
  [TokenType.GREATER, ">"],
  [TokenType.GREATEREQUAL, ">="],
  [TokenType.SHIFTLEFT, "<<"],
  [TokenType.SHIFTRIGHT, ">>>"],
]);

// ---------------------------------------------------------------------------
// Exported parse functions
// ---------------------------------------------------------------------------

/**
 * Parse a pure HGS program (no template text, just code).
 */
export function parse(source: string): Statement {
  const p = new Parser(source);
  return p.parseProgram(false);
}

/**
 * Parse an HGS template: text outside `<? ?>` is emitted as TextStmt nodes.
 */
export function parseTemplate(source: string): Statement {
  const p = new Parser(source);
  return p.parseProgram(true);
}

// ---------------------------------------------------------------------------
// Parser class
// ---------------------------------------------------------------------------

class Parser {
  private readonly tok: Tokenizer;

  constructor(source: string) {
    this.tok = new Tokenizer(source);
  }

  parseProgram(templateMode: boolean): Statement {
    const stmts: Statement[] = [];

    if (templateMode) {
      const text = this.tok.readText();
      if (text.length > 0) {
        stmts.push(this.textStmt(text));
      }
    }

    while (this.tok.peek().type !== TokenType.EOF) {
      stmts.push(this.parseStatement(true));
    }

    return this.block(stmts, 1);
  }

  // ---------------------------------------------------------------------------
  // Statements
  // ---------------------------------------------------------------------------

  private parseStatement(isRealStatement: boolean): Statement {
    const t = this.tok.next();
    const line = t.line;

    switch (t.type) {
      case TokenType.EXPORT: {
        const nameTok = this.tok.expect(TokenType.IDENT);
        this.tok.expect(TokenType.COLON);
        this.tok.expect(TokenType.EQUAL);
        const init = this.parseExpression();
        if (isRealStatement) this.tok.expect(TokenType.SEMICOLON);
        const stmt: ExportStmt = { kind: "export", name: nameTok.value, init, line };
        return stmt;
      }

      case TokenType.IDENT: {
        const name = t.value;
        const refExpr = this.parsePostfix({ kind: "ident", name, line } as IdentExpr);
        const next = this.tok.next();
        switch (next.type) {
          case TokenType.COLON: {
            // Declaration: name := expr;
            this.tok.expect(TokenType.EQUAL);
            const init = this.parseExpression();
            if (isRealStatement) this.tok.expect(TokenType.SEMICOLON);
            const declName = this.extractIdentName(refExpr, line);
            const stmt: DeclareStmt = { kind: "declare", name: declName, init, line };
            return stmt;
          }
          case TokenType.EQUAL: {
            // Assignment: target = expr;
            const value = this.parseExpression();
            if (isRealStatement) this.tok.expect(TokenType.SEMICOLON);
            const stmt: AssignStmt = { kind: "assign", target: refExpr, value, line };
            return stmt;
          }
          case TokenType.ADD: {
            // Increment: name++
            this.tok.expect(TokenType.ADD);
            if (isRealStatement) this.tok.expect(TokenType.SEMICOLON);
            const stmt: IncrementStmt = { kind: "increment", target: refExpr, delta: 1, line };
            return stmt;
          }
          case TokenType.SUB: {
            // Decrement: name--
            this.tok.expect(TokenType.SUB);
            if (isRealStatement) this.tok.expect(TokenType.SEMICOLON);
            const stmt: IncrementStmt = { kind: "increment", target: refExpr, delta: -1, line };
            return stmt;
          }
          case TokenType.SEMICOLON: {
            // Expression statement (side effect call)
            return { kind: "exprStmt", expr: refExpr, line };
          }
          default:
            throw new ParserError(`unexpected token after identifier: ${next.type} (${next.value})`, next.line);
        }
      }

      case TokenType.CODEEND: {
        // End of code block in template mode- emit following text
        const text = this.tok.readText();
        const stmts: Statement[] = [];
        if (text.length > 0) {
          stmts.push(this.textStmt(text));
        }
        // Continue parsing more code blocks
        while (this.tok.peek().type !== TokenType.EOF) {
          stmts.push(this.parseStatement(true));
        }
        return this.block(stmts, line);
      }

      case TokenType.EQUAL: {
        // Output statement in template mode: = expr;
        const value = this.parseExpression();
        if (this.tok.peek().type !== TokenType.CODEEND) {
          this.tok.expect(TokenType.SEMICOLON);
        }
        const stmt: OutputStmt = { kind: "output", value, line };
        return stmt;
      }

      case TokenType.IF: {
        this.tok.expect(TokenType.OPEN);
        const condition = this.parseExpression();
        this.tok.expect(TokenType.CLOSE);
        const consequent = this.parseStatement(true);
        let alternate: Statement | null = null;
        if (this.tok.peek().type === TokenType.ELSE) {
          this.tok.next();
          alternate = this.parseStatement(true);
        }
        const stmt: IfStmt = { kind: "if", condition, consequent, alternate, line };
        return stmt;
      }

      case TokenType.FOR: {
        this.tok.expect(TokenType.OPEN);
        const init = this.parseStatement(false);
        this.tok.expect(TokenType.SEMICOLON);
        const condition = this.parseExpression();
        this.tok.expect(TokenType.SEMICOLON);
        const update = this.parseStatement(false);
        this.tok.expect(TokenType.CLOSE);
        const body = this.parseStatement(true);
        const stmt: ForStmt = { kind: "for", init, condition, update, body, line };
        return stmt;
      }

      case TokenType.WHILE: {
        this.tok.expect(TokenType.OPEN);
        const condition = this.parseExpression();
        this.tok.expect(TokenType.CLOSE);
        const body = this.parseStatement(true);
        const stmt: WhileStmt = { kind: "while", condition, body, line };
        return stmt;
      }

      case TokenType.REPEAT: {
        const body = this.parseStatement(true);
        this.tok.expect(TokenType.UNTIL);
        const condition = this.parseExpression();
        if (isRealStatement) this.tok.expect(TokenType.SEMICOLON);
        const stmt: RepeatUntilStmt = { kind: "repeatUntil", body, condition, line };
        return stmt;
      }

      case TokenType.OPENBRACE: {
        const stmts: Statement[] = [];
        while (this.tok.peek().type !== TokenType.CLOSEDBRACE) {
          if (this.tok.peek().type === TokenType.EOF) {
            throw new ParserError("unexpected EOF inside block", line);
          }
          stmts.push(this.parseStatement(true));
        }
        this.tok.next(); // consume }
        return this.block(stmts, line);
      }

      case TokenType.RETURN: {
        const value = this.parseExpression();
        this.tok.expect(TokenType.SEMICOLON);
        const stmt: ReturnStmt = { kind: "return", value, line };
        return stmt;
      }

      case TokenType.FUNC: {
        const nameTok = this.tok.expect(TokenType.IDENT);
        const { params, body } = this.parseFunction(line);
        const stmt: FuncDeclStmt = { kind: "funcDecl", name: nameTok.value, params, body, line };
        return stmt;
      }

      default:
        throw new ParserError(`unexpected token: ${t.type} (${t.value})`, t.line);
    }
  }

  // ---------------------------------------------------------------------------
  // Expressions- Pratt-style precedence climbing
  // ---------------------------------------------------------------------------

  private parseExpression(minPrec: number = 0): Expression {
    let left = this.parseUnary();

    while (true) {
      const peek = this.tok.peek();
      const prec = PREC[peek.type];
      if (prec === undefined || prec <= minPrec) break;

      const opTok = this.tok.next();
      const op = TOKEN_TO_BINOP.get(opTok.type);
      if (op === undefined) break;

      const right = this.parseExpression(prec);
      const expr: BinaryExpr = { kind: "binary", op, left, right, line: opTok.line };
      left = expr;
    }

    return left;
  }

  private parseUnary(): Expression {
    const peek = this.tok.peek();
    if (peek.type === TokenType.SUB) {
      const t = this.tok.next();
      const operand = this.parseUnary();
      const expr: UnaryExpr = { kind: "unary", op: "-", operand, line: t.line };
      return expr;
    }
    if (peek.type === TokenType.NOT) {
      const t = this.tok.next();
      const operand = this.parseUnary();
      // ~ is bitwise NOT, ! is logical NOT- both map to "~" or "!" based on context
      // The tokenizer maps both `~` and `!` (without =) to NOT token.
      // We store the original character to distinguish.
      const op: "~" | "!" = t.value === "~" ? "~" : "!";
      const expr: UnaryExpr = { kind: "unary", op, operand, line: t.line };
      return expr;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expression {
    const t = this.tok.next();
    const line = t.line;

    switch (t.type) {
      case TokenType.NUMBER: {
        const val = parseLong(t.value);
        const expr: LiteralExpr = { kind: "literal", value: val, line };
        return this.parsePostfix(expr);
      }
      case TokenType.DOUBLE: {
        const val = parseFloat(t.value);
        const expr: LiteralExpr = { kind: "literal", value: val, line };
        return this.parsePostfix(expr);
      }
      case TokenType.STRING: {
        const expr: LiteralExpr = { kind: "literal", value: t.value, line };
        return this.parsePostfix(expr);
      }
      case TokenType.TRUE: {
        const expr: LiteralExpr = { kind: "literal", value: true, line };
        return this.parsePostfix(expr);
      }
      case TokenType.FALSE: {
        const expr: LiteralExpr = { kind: "literal", value: false, line };
        return this.parsePostfix(expr);
      }
      case TokenType.IDENT: {
        const expr: IdentExpr = { kind: "ident", name: t.value, line };
        return this.parsePostfix(expr);
      }
      case TokenType.OPEN: {
        const inner = this.parseExpression();
        this.tok.expect(TokenType.CLOSE);
        return this.parsePostfix(inner);
      }
      case TokenType.OPENSQUARE: {
        return this.parsePostfix(this.parseArrayLiteral(line));
      }
      case TokenType.OPENBRACE: {
        return this.parsePostfix(this.parseStructLiteral(line));
      }
      case TokenType.FUNC: {
        const { params, body } = this.parseFunction(line);
        const expr: FuncExpr = { kind: "func", params, body, line };
        return this.parsePostfix(expr);
      }
      default:
        throw new ParserError(`unexpected token in expression: ${t.type} (${t.value})`, t.line);
    }
  }

  private parsePostfix(expr: Expression): Expression {
    while (true) {
      const peek = this.tok.peek();
      if (peek.type === TokenType.OPENSQUARE) {
        const t = this.tok.next();
        const index = this.parseExpression();
        this.tok.expect(TokenType.CLOSEDSQUARE);
        const indexExpr: IndexExpr = { kind: "index", target: expr, index, line: t.line };
        expr = indexExpr;
      } else if (peek.type === TokenType.OPEN) {
        const t = this.tok.next();
        const args = this.parseArgList();
        const callExpr: CallExpr = { kind: "call", callee: expr, args, line: t.line };
        expr = callExpr;
      } else if (peek.type === TokenType.DOT) {
        const t = this.tok.next();
        const nameTok = this.tok.expect(TokenType.IDENT);
        const fieldExpr: FieldExpr = { kind: "field", target: expr, name: nameTok.value, line: t.line };
        expr = fieldExpr;
      } else {
        break;
      }
    }
    return expr;
  }

  private parseArgList(): Expression[] {
    const args: Expression[] = [];
    if (this.tok.peek().type !== TokenType.CLOSE) {
      args.push(this.parseExpression());
      while (this.tok.peek().type === TokenType.COMMA) {
        this.tok.next();
        args.push(this.parseExpression());
      }
    }
    this.tok.expect(TokenType.CLOSE);
    return args;
  }

  private parseArrayLiteral(line: number): ArrayLiteralExpr {
    const elements: Expression[] = [];
    while (this.tok.peek().type !== TokenType.CLOSEDSQUARE) {
      if (this.tok.peek().type === TokenType.EOF) {
        throw new ParserError("unexpected EOF in array literal", line);
      }
      elements.push(this.parseExpression());
      if (this.tok.peek().type === TokenType.COMMA) {
        this.tok.next();
      }
    }
    this.tok.next(); // consume ]
    return { kind: "array", elements, line };
  }

  private parseStructLiteral(line: number): StructLiteralExpr {
    const fields: Array<{ key: string; value: Expression }> = [];
    while (true) {
      const t = this.tok.next();
      if (t.type === TokenType.CLOSEDBRACE) break;
      if (t.type !== TokenType.IDENT) {
        throw new ParserError(`expected field name, got ${t.type}`, t.line);
      }
      const key = t.value;
      this.tok.expect(TokenType.COLON);
      const value = this.parseExpression();
      fields.push({ key, value });
      if (this.tok.peek().type === TokenType.COMMA) {
        this.tok.next();
        // Allow trailing comma before }
        if (this.tok.peek().type === TokenType.CLOSEDBRACE) {
          this.tok.next();
          break;
        }
      } else if (this.tok.peek().type !== TokenType.CLOSEDBRACE) {
        throw new ParserError(`expected ',' or '}' in struct literal`, this.tok.peek().line);
      }
    }
    return { kind: "struct", fields, line };
  }

  private parseFunction(_line: number): { params: string[]; body: Statement } {
    this.tok.expect(TokenType.OPEN);
    const params: string[] = [];
    if (this.tok.peek().type !== TokenType.CLOSE) {
      params.push(this.tok.expect(TokenType.IDENT).value);
      while (this.tok.peek().type !== TokenType.CLOSE) {
        this.tok.expect(TokenType.COMMA);
        params.push(this.tok.expect(TokenType.IDENT).value);
      }
    }
    this.tok.next(); // consume )
    const body = this.parseStatement(true);
    return { params, body };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private block(stmts: Statement[], line: number): Statement {
    if (stmts.length === 1) return stmts[0];
    const stmt: BlockStmt = { kind: "block", body: stmts, line };
    return stmt;
  }

  private textStmt(text: string): TextStmt {
    return { kind: "text", text, line: 1 };
  }

  /**
   * Extract a plain identifier name from an expression for use in declare statements.
   * Declare (`:=`) only works on simple variable names, not compound references.
   */
  private extractIdentName(expr: Expression, line: number): string {
    if (expr.kind === "ident") return expr.name;
    throw new ParserError("declaration target must be a simple identifier", line);
  }
}

// ---------------------------------------------------------------------------
// Number parsing
// ---------------------------------------------------------------------------

function parseLong(raw: string): bigint {
  try {
    if (raw.startsWith("0x") || raw.startsWith("0X")) {
      return BigInt("0x" + raw.slice(2));
    }
    return BigInt(raw);
  } catch {
    throw new ParserError(`invalid number literal: ${raw}`, 0);
  }
}
