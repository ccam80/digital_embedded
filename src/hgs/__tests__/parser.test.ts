/**
 * Parser tests- task 4.3.2.
 *
 * Verifies the AST structure produced by the parser. Tests check node kinds
 * and key structural properties without exhaustively comparing every field.
 */

import { describe, it, expect } from "vitest";
import { parse, parseTemplate } from "../parser";
import type {
  BlockStmt,
  DeclareStmt,
  AssignStmt,
  IncrementStmt,
  IfStmt,
  ForStmt,
  WhileStmt,
  RepeatUntilStmt,
  FuncDeclStmt,
  ReturnStmt,
  ExportStmt,
  BinaryExpr,
  UnaryExpr,
  LiteralExpr,
  IdentExpr,
  ArrayLiteralExpr,
  StructLiteralExpr,
  FuncExpr,
  CallExpr,
  IndexExpr,
  FieldExpr,
  TextStmt,
} from "../ast";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function block(code: string): BlockStmt {
  const stmt = parse(code);
  if (stmt.kind === "block") return stmt;
  return { kind: "block", body: [stmt], line: stmt.line };
}

function first(code: string) {
  return block(code).body[0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Parser", () => {
  describe("declarations", () => {
    it("declare statement", () => {
      const stmt = first("x := 5;") as DeclareStmt;
      expect(stmt.kind).toBe("declare");
      expect(stmt.name).toBe("x");
      expect((stmt.init as LiteralExpr).value).toBe(5n);
    });

    it("export statement", () => {
      const stmt = first("export x := 5;") as ExportStmt;
      expect(stmt.kind).toBe("export");
      expect(stmt.name).toBe("x");
    });

    it("assignment statement", () => {
      const stmt = first("x = 10;") as AssignStmt;
      expect(stmt.kind).toBe("assign");
      expect((stmt.target as IdentExpr).name).toBe("x");
      expect((stmt.value as LiteralExpr).value).toBe(10n);
    });

    it("increment statement", () => {
      const stmt = first("x++;") as IncrementStmt;
      expect(stmt.kind).toBe("increment");
      expect(stmt.delta).toBe(1);
    });

    it("decrement statement", () => {
      const stmt = first("x--;") as IncrementStmt;
      expect(stmt.kind).toBe("increment");
      expect(stmt.delta).toBe(-1);
    });
  });

  describe("expressions", () => {
    it("integer literal", () => {
      const stmt = first("x := 42;") as DeclareStmt;
      const lit = stmt.init as LiteralExpr;
      expect(lit.kind).toBe("literal");
      expect(lit.value).toBe(42n);
    });

    it("hex literal parsed as bigint", () => {
      const stmt = first("x := 0xFF;") as DeclareStmt;
      const lit = stmt.init as LiteralExpr;
      expect(lit.value).toBe(255n);
    });

    it("float literal", () => {
      const stmt = first("x := 3.14;") as DeclareStmt;
      const lit = stmt.init as LiteralExpr;
      expect(lit.kind).toBe("literal");
      expect(typeof lit.value).toBe("number");
    });

    it("string literal", () => {
      const stmt = first('x := "hello";') as DeclareStmt;
      const lit = stmt.init as LiteralExpr;
      expect(lit.value).toBe("hello");
    });

    it("true/false literals", () => {
      const t = (first("x := true;") as DeclareStmt).init as LiteralExpr;
      const f = (first("x := false;") as DeclareStmt).init as LiteralExpr;
      expect(t.value).toBe(true);
      expect(f.value).toBe(false);
    });

    it("binary expression", () => {
      const stmt = first("x := 1 + 2;") as DeclareStmt;
      const bin = stmt.init as BinaryExpr;
      expect(bin.kind).toBe("binary");
      expect(bin.op).toBe("+");
    });

    it("operator precedence- multiply before add", () => {
      const stmt = first("x := 1 + 2 * 3;") as DeclareStmt;
      const bin = stmt.init as BinaryExpr;
      expect(bin.op).toBe("+");
      expect((bin.right as BinaryExpr).op).toBe("*");
    });

    it("unary negation", () => {
      const stmt = first("x := -5;") as DeclareStmt;
      const u = stmt.init as UnaryExpr;
      expect(u.kind).toBe("unary");
      expect(u.op).toBe("-");
    });

    it("unary bitwise not", () => {
      const stmt = first("x := ~0;") as DeclareStmt;
      const u = stmt.init as UnaryExpr;
      expect(u.op).toBe("~");
    });

    it("array literal", () => {
      const stmt = first("x := [1, 2, 3];") as DeclareStmt;
      const arr = stmt.init as ArrayLiteralExpr;
      expect(arr.kind).toBe("array");
      expect(arr.elements.length).toBe(3);
    });

    it("struct literal", () => {
      const stmt = first("x := {a: 1, b: 2};") as DeclareStmt;
      const s = stmt.init as StructLiteralExpr;
      expect(s.kind).toBe("struct");
      expect(s.fields.length).toBe(2);
      expect(s.fields[0].key).toBe("a");
    });

    it("function expression", () => {
      const stmt = first("x := func(a, b) { return a + b; };") as DeclareStmt;
      const fn = stmt.init as FuncExpr;
      expect(fn.kind).toBe("func");
      expect(fn.params).toEqual(["a", "b"]);
    });

    it("call expression", () => {
      const stmt = first("f(1, 2);") as { kind: string; expr: CallExpr };
      expect(stmt.kind).toBe("exprStmt");
      expect(stmt.expr.kind).toBe("call");
      expect((stmt.expr.callee as IdentExpr).name).toBe("f");
      expect(stmt.expr.args.length).toBe(2);
    });

    it("index expression", () => {
      const stmt = first("x := a[0];") as DeclareStmt;
      const idx = stmt.init as IndexExpr;
      expect(idx.kind).toBe("index");
      expect((idx.target as IdentExpr).name).toBe("a");
    });

    it("field expression", () => {
      const stmt = first("x := a.b;") as DeclareStmt;
      const field = stmt.init as FieldExpr;
      expect(field.kind).toBe("field");
      expect(field.name).toBe("b");
    });

    it("chained postfix- a.b[0]()", () => {
      const stmt = first("x := a.b[0]();") as DeclareStmt;
      const call = stmt.init as CallExpr;
      expect(call.kind).toBe("call");
      const idx = call.callee as IndexExpr;
      expect(idx.kind).toBe("index");
      const field = idx.target as FieldExpr;
      expect(field.kind).toBe("field");
      expect(field.name).toBe("b");
    });
  });

  describe("control flow", () => {
    it("if statement", () => {
      const stmt = first("if (x) y = 1;") as IfStmt;
      expect(stmt.kind).toBe("if");
      expect(stmt.alternate).toBeNull();
    });

    it("if-else statement", () => {
      const stmt = first("if (x) y = 1; else y = 2;") as IfStmt;
      expect(stmt.kind).toBe("if");
      expect(stmt.alternate).not.toBeNull();
    });

    it("for statement", () => {
      const stmt = first("for (i := 0; i < 10; i++) {}") as ForStmt;
      expect(stmt.kind).toBe("for");
      expect((stmt.init as DeclareStmt).name).toBe("i");
    });

    it("while statement", () => {
      const stmt = first("while (x > 0) x = x - 1;") as WhileStmt;
      expect(stmt.kind).toBe("while");
    });

    it("repeat-until statement", () => {
      const stmt = first("repeat x = x + 1; until x = 5;") as RepeatUntilStmt;
      expect(stmt.kind).toBe("repeatUntil");
    });

    it("block statement", () => {
      const stmt = parse("{ x = 1; y = 2; }") as BlockStmt;
      expect(stmt.kind).toBe("block");
      expect(stmt.body.length).toBe(2);
    });

    it("return statement", () => {
      const stmt = first("func f() return 1; x := 0;");
      const fn = stmt as FuncDeclStmt;
      const ret = fn.body as ReturnStmt;
      expect(ret.kind).toBe("return");
    });

    it("func declaration", () => {
      const stmt = first("func add(a, b) return a + b;") as FuncDeclStmt;
      expect(stmt.kind).toBe("funcDecl");
      expect(stmt.name).toBe("add");
      expect(stmt.params).toEqual(["a", "b"]);
    });
  });

  describe("templateMode", () => {
    it("text-only template", () => {
      const stmt = parseTemplate("Hello World!");
      expect(stmt.kind).toBe("text");
      expect((stmt as TextStmt).text).toBe("Hello World!");
    });

    it("template with code block", () => {
      const stmt = parseTemplate("Hello <? x := 1; ?> World") as BlockStmt;
      expect(stmt.kind).toBe("block");
    });

    it("output statement in template", () => {
      const result = parseTemplate("<? = 42; ?>");
      if (result.kind === "block") {
        const output = result.body.find(s => s.kind === "output");
        expect(output).toBeDefined();
      } else {
        expect(result.kind).toBe("output");
      }
    });

    it("brace delimiters for code blocks", () => {
      const stmt = parseTemplate("{? x := 1; ?}");
      expect(stmt).toBeDefined();
    });
  });

  describe("errorCases", () => {
    it("throws on missing semicolon after declaration", () => {
      expect(() => parse("x := 5")).toThrow();
    });

    it("throws on incomplete binary expression", () => {
      expect(() => parse("x := 1 +;")).toThrow();
    });

    it("throws on unclosed parenthesis", () => {
      expect(() => parse("x := (1 + 2;")).toThrow();
    });

    it("throws on unknown token", () => {
      expect(() => parse("x := @5;")).toThrow();
    });
  });
});
