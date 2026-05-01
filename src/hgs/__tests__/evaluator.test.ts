/**
 * HGS Evaluator tests- task 4.3.3
 *
 * Tests cover all HGS language features: arithmetic, control flow, functions,
 * closures, arrays, structs, template output, and runtime errors.
 */

import { describe, it, expect } from "vitest";
import { parse, parseTemplate } from "../parser";
import { createRootContext } from "../context";
import { registerBuiltins } from "../builtins";
import { evaluate } from "../evaluator";


// ---------------------------------------------------------------------------
// Helper: run HGS code and return the root context (to inspect variables)
// ---------------------------------------------------------------------------

async function run(code: string): Promise<{ ctx: ReturnType<typeof createRootContext>; output: string }> {
  const ctx = createRootContext();
  registerBuiltins(ctx);
  const ast = parse(code);
  const output = await evaluate(ast, ctx);
  return { ctx, output };
}

async function runTemplate(source: string): Promise<string> {
  const ctx = createRootContext();
  registerBuiltins(ctx);
  const ast = parseTemplate(source);
  return await evaluate(ast, ctx);
}

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

describe("Evaluator", () => {
  it("arithmetic", async () => {
    const { ctx } = await run("x := 3 + 4 * 2;");
    expect(ctx.getVar("x")).toBe(11n);
  });

  it("bitwiseOps", async () => {
    const { ctx } = await run("x := 0xFF & 0x0F;");
    expect(ctx.getVar("x")).toBe(15n);
  });

  it("bitwiseOr", async () => {
    const { ctx } = await run("x := 0xF0 | 0x0F;");
    expect(ctx.getVar("x")).toBe(255n);
  });

  it("bitwiseXor", async () => {
    const { ctx } = await run("x := 0xFF ^ 0x0F;");
    expect(ctx.getVar("x")).toBe(0xF0n);
  });

  it("shiftLeft", async () => {
    const { ctx } = await run("x := 1 << 4;");
    expect(ctx.getVar("x")).toBe(16n);
  });

  it("shiftRight", async () => {
    const { ctx } = await run("x := 256 >>> 4;");
    expect(ctx.getVar("x")).toBe(16n);
  });

  it("stringConcat", async () => {
    const { ctx } = await run('x := "hello" + 42;');
    expect(ctx.getVar("x")).toBe("hello42");
  });

  it("stringConcatLeft", async () => {
    const { ctx } = await run('x := 42 + " world";');
    expect(ctx.getVar("x")).toBe("42 world");
  });

  it("floatArithmetic", async () => {
    const { ctx } = await run("x := 1.5 + 2.5;");
    expect(ctx.getVar("x")).toBe(4);
  });

  it("unaryNegation", async () => {
    const { ctx } = await run("x := -5;");
    expect(ctx.getVar("x")).toBe(-5n);
  });

  it("bitwiseNotUnary", async () => {
    const { ctx } = await run("x := ~0;");
    expect(ctx.getVar("x")).toBe(-1n);
  });

  // ---------------------------------------------------------------------------
  // Control flow
  // ---------------------------------------------------------------------------

  it("ifElse- true branch", async () => {
    const { ctx } = await run("x := 0; if (1 = 1) x = 1; else x = 2;");
    expect(ctx.getVar("x")).toBe(1n);
  });

  it("ifElse- false branch", async () => {
    const { ctx } = await run("x := 0; if (1 = 2) x = 1; else x = 2;");
    expect(ctx.getVar("x")).toBe(2n);
  });

  it("forLoop", async () => {
    const { ctx } = await run("sum := 0; for (i := 0; i < 5; i++) sum = sum + i;");
    expect(ctx.getVar("sum")).toBe(10n);
  });

  it("whileLoop", async () => {
    const { ctx } = await run("x := 10; while (x > 0) x = x - 1;");
    expect(ctx.getVar("x")).toBe(0n);
  });

  it("repeatUntil", async () => {
    const { ctx } = await run("x := 0; repeat x = x + 1; until x = 5;");
    expect(ctx.getVar("x")).toBe(5n);
  });

  it("blockStatement", async () => {
    const { ctx } = await run("x := 0; { x = 1; x = x + 1; }");
    expect(ctx.getVar("x")).toBe(2n);
  });

  // ---------------------------------------------------------------------------
  // Functions
  // ---------------------------------------------------------------------------

  it("functionDeclAndCall", async () => {
    const { ctx } = await run("func add(a, b) return a + b; x := add(3, 4);");
    expect(ctx.getVar("x")).toBe(7n);
  });

  it("closures", async () => {
    const { ctx } = await run(`
      base := 10;
      func addBase(n) return n + base;
      x := addBase(5);
    `);
    expect(ctx.getVar("x")).toBe(15n);
  });

  it("closureModifiesCapture", async () => {
    const { ctx } = await run(`
      counter := 0;
      func inc() counter = counter + 1;
      inc();
      inc();
      x := counter;
    `);
    expect(ctx.getVar("x")).toBe(2n);
  });

  it("recursion- factorial", async () => {
    const { ctx } = await run(`
      func fact(n) {
        if (n = 0) return 1;
        return n * fact(n - 1);
      }
      x := fact(5);
    `);
    expect(ctx.getVar("x")).toBe(120n);
  });

  it("firstClassFunction", async () => {
    const { ctx } = await run(`
      double := func(x) { return x * 2; };
      y := double(7);
    `);
    expect(ctx.getVar("y")).toBe(14n);
  });

  // ---------------------------------------------------------------------------
  // Arrays
  // ---------------------------------------------------------------------------

  it("arrays- creation and access", async () => {
    const { ctx } = await run("a := [1, 2, 3]; x := a[1];");
    expect(ctx.getVar("x")).toBe(2n);
  });

  it("arrays- assignment", async () => {
    const { ctx } = await run("a := [10, 20, 30]; a[1] = 99; x := a[1];");
    expect(ctx.getVar("x")).toBe(99n);
  });

  it("arrays- sizeOf", async () => {
    const { ctx } = await run("a := [1, 2, 3, 4]; x := sizeOf(a);");
    expect(ctx.getVar("x")).toBe(4n);
  });

  // ---------------------------------------------------------------------------
  // Structs / maps
  // ---------------------------------------------------------------------------

  it("structs- creation and field access", async () => {
    const { ctx } = await run('m := {width: 8}; x := m.width;');
    expect(ctx.getVar("x")).toBe(8n);
  });

  it("structFieldAssign", async () => {
    const { ctx } = await run('m := {width: 8}; m.width = 16; x := m.width;');
    expect(ctx.getVar("x")).toBe(16n);
  });

  it("struct- multiple fields", async () => {
    const { ctx } = await run('m := {a: 1, b: 2}; x := m.a + m.b;');
    expect(ctx.getVar("x")).toBe(3n);
  });

  // ---------------------------------------------------------------------------
  // Built-ins
  // ---------------------------------------------------------------------------

  it("bitsNeededFor", async () => {
    const { ctx } = await run("x := bitsNeededFor(255);");
    expect(ctx.getVar("x")).toBe(8n);
  });

  it("bitsNeededFor- 256", async () => {
    const { ctx } = await run("x := bitsNeededFor(256);");
    expect(ctx.getVar("x")).toBe(9n);
  });

  it("bitsNeededFor- 1", async () => {
    const { ctx } = await run("x := bitsNeededFor(1);");
    expect(ctx.getVar("x")).toBe(1n);
  });

  it("ceil", async () => {
    const { ctx } = await run("x := ceil(2.3);");
    expect(ctx.getVar("x")).toBe(3n);
  });

  it("floor", async () => {
    const { ctx } = await run("x := floor(2.9);");
    expect(ctx.getVar("x")).toBe(2n);
  });

  it("round", async () => {
    const { ctx } = await run("x := round(2.5);");
    expect(ctx.getVar("x")).toBe(3n);
  });

  it("abs- negative", async () => {
    const { ctx } = await run("x := abs(-5);");
    expect(ctx.getVar("x")).toBe(5n);
  });

  it("min", async () => {
    const { ctx } = await run("x := min(3, 1, 2);");
    expect(ctx.getVar("x")).toBe(1n);
  });

  it("max", async () => {
    const { ctx } = await run("x := max(3, 1, 2);");
    expect(ctx.getVar("x")).toBe(3n);
  });

  it("sizeOf", async () => {
    const { ctx } = await run("a := [10, 20]; x := sizeOf(a);");
    expect(ctx.getVar("x")).toBe(2n);
  });

  it("splitString", async () => {
    const { ctx } = await run('a := splitString("a b c"); x := a[0];');
    expect(ctx.getVar("x")).toBe("a");
  });

  it("format", async () => {
    const { ctx } = await run('x := format("val=%d", 42);');
    expect(ctx.getVar("x")).toBe("val=42");
  });

  it("int- converts float to bigint", async () => {
    const { ctx } = await run("x := int(3.7);");
    expect(ctx.getVar("x")).toBe(3n);
  });

  it("float- converts bigint to number", async () => {
    const { ctx } = await run("x := float(5);");
    expect(ctx.getVar("x")).toBe(5);
  });

  it("startsWith", async () => {
    const { ctx } = await run('x := startsWith("hello world", "hello");');
    expect(ctx.getVar("x")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  it("exportToRoot", async () => {
    const { ctx } = await run("export x := 42;");
    expect(ctx.getVar("x")).toBe(42n);
  });

  it("export from nested scope reaches root", async () => {
    const { ctx } = await run(`
      func setup() {
        export result := 99;
      }
      setup();
    `);
    expect(ctx.getVar("result")).toBe(99n);
  });

  // ---------------------------------------------------------------------------
  // Template output
  // ---------------------------------------------------------------------------

  it("templateOutput- basic", async () => {
    const output = await runTemplate("Width is <? = 8; ?> bits");
    expect(output).toBe("Width is 8 bits");
  });

  it("templateOutput- multiple blocks", async () => {
    const output = await runTemplate("a=<? = 1; ?>, b=<? = 2; ?>");
    expect(output).toBe("a=1, b=2");
  });

  it("templateOutput- code block", async () => {
    const output = await runTemplate("Hello <? x := \"World\"; = x; ?>!");
    expect(output).toBe("Hello World!");
  });

  it("print builtin", async () => {
    const { output } = await run('print("hello");');
    expect(output).toBe("hello");
  });

  it("println builtin", async () => {
    const { output } = await run('println("hello");');
    expect(output).toBe("hello\n");
  });

  // ---------------------------------------------------------------------------
  // Runtime errors
  // ---------------------------------------------------------------------------

  it("runtimeErrorHasLine- undefined variable", async () => {
    const ctx = createRootContext();
    registerBuiltins(ctx);
    const ast = parse("x := 1;\ny := z + 1;");
    await expect(evaluate(ast, ctx)).rejects.toThrow(/variable not found: z/i);
  });

  it("runtimeErrorHasLine- division by zero", async () => {
    const ctx = createRootContext();
    registerBuiltins(ctx);
    // Construct a 3-line program so the error is on line 3
    const ast = parse("a := 1;\nb := 2;\nc := a / 0;");
    let caught: Error | null = null;
    try {
      await evaluate(ast, ctx);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/division by zero/i);
    expect(caught!.message).toMatch(/line/i);
  });

  it("runtimeErrorHasLine- array out of bounds", async () => {
    const ctx = createRootContext();
    registerBuiltins(ctx);
    const ast = parse("a := [1, 2];\nx := a[5];");
    await expect(evaluate(ast, ctx)).rejects.toThrow(/array index out of bounds/i);
  });

  it("panic builtin throws", async () => {
    const ctx = createRootContext();
    registerBuiltins(ctx);
    const ast = parse('panic("something went wrong");');
    await expect(evaluate(ast, ctx)).rejects.toThrow(/something went wrong/i);
  });

  // ---------------------------------------------------------------------------
  // Comparison operators
  // ---------------------------------------------------------------------------

  it("comparison- equal returns boolean", async () => {
    const { ctx } = await run("x := 1 = 1;");
    expect(ctx.getVar("x")).toBe(true);
  });

  it("comparison- not equal", async () => {
    const { ctx } = await run("x := 1 != 2;");
    expect(ctx.getVar("x")).toBe(true);
  });

  it("comparison- less than", async () => {
    const { ctx } = await run("x := 3 < 5;");
    expect(ctx.getVar("x")).toBe(true);
  });

  it("comparison- greater than equal", async () => {
    const { ctx } = await run("x := 5 >= 5;");
    expect(ctx.getVar("x")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Decrement operator
  // ---------------------------------------------------------------------------

  it("decrement operator", async () => {
    const { ctx } = await run("x := 5; x--;");
    expect(ctx.getVar("x")).toBe(4n);
  });

  it("increment operator", async () => {
    const { ctx } = await run("x := 5; x++;");
    expect(ctx.getVar("x")).toBe(6n);
  });
});
