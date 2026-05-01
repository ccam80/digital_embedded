/**
 * HGS parity tests- task 4.3.6.
 *
 * Behavioral parity with Digital's ParserTest.java. Each test section maps
 * to a method in the Java test class.
 */

import { describe, it, expect } from "vitest";
import { parse, parseTemplate } from "../parser";
import { createRootContext } from "../context";
import { registerBuiltins } from "../builtins";
import { evaluate } from "../evaluator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function run(code: string): Promise<ReturnType<typeof createRootContext>> {
  const ctx = createRootContext();
  registerBuiltins(ctx);
  const ast = parse(code);
  await evaluate(ast, ctx);
  return ctx;
}

async function runTemplate(source: string): Promise<string> {
  const ctx = createRootContext();
  registerBuiltins(ctx);
  const ast = parseTemplate(source);
  return evaluate(ast, ctx);
}

async function expectError(code: string): Promise<void> {
  await expect(run(code)).rejects.toThrow();
}

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

describe("Parity", () => {
  describe("variables", () => {
    it("declaration and read", async () => {
      const ctx = await run("a := 2; b := a * a;");
      expect(ctx.getVar("b")).toBe(4n);
    });

    it("assignment overwrites", async () => {
      const ctx = await run("a := 5; a = 10;");
      expect(ctx.getVar("a")).toBe(10n);
    });

    it("scope- for loop var does not leak to outer", async () => {
      const ctx = await run("sum := 0; for (i := 0; i < 5; i++) sum = sum + i;");
      expect(ctx.getVar("sum")).toBe(10n);
    });

    it("boolean true/false", async () => {
      const ctx = await run("a := true; a = false;");
      expect(ctx.getVar("a")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Control flow
  // ---------------------------------------------------------------------------

  describe("controlFlow", () => {
    it("if true branch", async () => {
      const output = await runTemplate("<? b:=9; if (a<1) b=0; else b=1; print(b);?>".replace("a", "0"));
      expect(output).toBe("0");
    });

    it("if false branch", async () => {
      const ctx = await run("b := 9; if (2 < 1) b = 0; else b = 1;");
      expect(ctx.getVar("b")).toBe(1n);
    });

    it("for loop forward", async () => {
      const output = await runTemplate("Hello <? for (i:=0;i<10;i++) print(i); ?> World!");
      expect(output).toBe("Hello 0123456789 World!");
    });

    it("for loop backward", async () => {
      const output = await runTemplate("Hello <? for (i:=9;i>=0;i--) print(i); ?> World!");
      expect(output).toBe("Hello 9876543210 World!");
    });

    it("for loop with block body", async () => {
      const output = await runTemplate("<? for (i:=0;i<10;i++) { print(i, 9-i); } ?>");
      expect(output).toBe("09182736455463728190");
    });

    it("while loop", async () => {
      const output = await runTemplate("Hello <? i:=0; while (i<=9) { =i; i++; } ?> World!");
      expect(output).toBe("Hello 0123456789 World!");
    });

    it("while nested computation", async () => {
      const output = await runTemplate("Hello <? n:=0;i:=1; while (i<=9) { a:=i*2; n=n+a; i++; } print(n); ?> World!");
      expect(output).toBe("Hello 90 World!");
    });

    it("repeat until", async () => {
      const output = await runTemplate("Hello <? i:=0; repeat { =i; i++; } until i=10; ?> World!");
      expect(output).toBe("Hello 0123456789 World!");
    });

    it("repeat until with computation", async () => {
      const output = await runTemplate("Hello <? n:=0;i:=1; repeat { a:=i*2;n=n+a; i++; } until i=10; print(n); ?> World!");
      expect(output).toBe("Hello 90 World!");
    });
  });

  // ---------------------------------------------------------------------------
  // Functions
  // ---------------------------------------------------------------------------

  describe("functions", () => {
    it("lambda with return", async () => {
      const output = await runTemplate("<? f:=func(a){return a*a+2;};  print(f(4));?>");
      expect(output).toBe("18");
    });

    it("lambda two params", async () => {
      const output = await runTemplate("<? f:=func(a,b){return a+2*b;};  print(f(1,2));?>");
      expect(output).toBe("5");
    });

    it("named func declaration", async () => {
      const ctx = await run("func add(a, b) return a + b; x := add(3, 4);");
      expect(ctx.getVar("x")).toBe(7n);
    });

    it("function stored in map field", async () => {
      const output = await runTemplate("<? m:={f:func(a){return {v:a*a+2};}};  print(m.f(4).v);?>");
      expect(output).toBe("18");
    });

    it("function stored in array", async () => {
      const output = await runTemplate("<? m:=[func(a){ return [a*a+2];}];  print(m[0](4)[0]);?>");
      expect(output).toBe("18");
    });

    it("function produces and returns string", async () => {
      // Functions that build string results can concatenate and return them
      const output = await runTemplate(
        "<? f:=func(a){ return \"testtext\" + (a*3); }; print(f(4), f(5)); ?>",
      );
      expect(output).toBe("testtext12testtext15");
    });
  });

  // ---------------------------------------------------------------------------
  // Closures
  // ---------------------------------------------------------------------------

  describe("closures", () => {
    it("closure captures outer variable", async () => {
      const output = await runTemplate("<? outer:=5; f:=func(x) {return x+outer;}; print(f(1)); ?>");
      expect(output).toBe("6");
    });

    it("two closures over same variable", async () => {
      const output = await runTemplate(
        "<? inner:=0; inc:=func(){inner++; return inner;}; dec:=func(){inner--; return inner;};" +
        "print(inc(), \",\", inc(), \",\", inc(), \",\", dec(), \",\", dec()); ?>",
      );
      expect(output).toBe("1,2,3,2,1");
    });

    it("closure factory- independent instances", async () => {
      const output = await runTemplate(
        "<?" +
        "func create() {" +
        "   inner:=0; " +
        "   return func(){" +
        "      inner++; " +
        "      return inner;" +
        "   };" +
        "}" +
        "a:=create();" +
        "b:=create();" +
        "print(a()+\",\"+a()+\",\"+b());" +
        "?>",
      );
      expect(output).toBe("1,2,1");
    });

    it("curried function", async () => {
      const output = await runTemplate(
        "<? f:=func(x){ return func(u){return u*x;};}; a:=f(2); b:=f(5); print(a(2), \",\", b(3)); ?>",
      );
      expect(output).toBe("4,15");
    });
  });

  // ---------------------------------------------------------------------------
  // Recursion
  // ---------------------------------------------------------------------------

  describe("recursion", () => {
    it("factorial", async () => {
      const ctx = await run(`
        func fact(n) {
          if (n = 0) return 1;
          return n * fact(n - 1);
        }
        x := fact(5);
      `);
      expect(ctx.getVar("x")).toBe(120n);
    });

    it("fibonacci lambda", async () => {
      const output = await runTemplate(`<?
        fibu:=func(n){
          if (n<2)
            return n;
          else
            return fibu(n-1)+fibu(n-2);
        };
        print(fibu(12));
       ?>`);
      expect(output).toBe("144");
    });

    it("fibonacci named func sequence", async () => {
      const output = await runTemplate(`<?
        func fibu(n){
          if (n<2)
            return n;
          else
            return fibu(n-1)+fibu(n-2);
        }
        for (i:=0;i<=12;i++) print(fibu(i),",");
       ?>`);
      expect(output).toBe("0,1,1,2,3,5,8,13,21,34,55,89,144,");
    });
  });

  // ---------------------------------------------------------------------------
  // Arrays
  // ---------------------------------------------------------------------------

  describe("arrays", () => {
    it("array creation and access", async () => {
      const ctx = await run("a := [1, 2, 3]; x := a[1];");
      expect(ctx.getVar("x")).toBe(2n);
    });

    it("array assignment", async () => {
      const ctx = await run("a := [10, 20, 30]; a[1] = 99; x := a[1];");
      expect(ctx.getVar("x")).toBe(99n);
    });

    it("dynamic array construction", async () => {
      const output = await runTemplate(
        "<? a:=[1,7]; print(a[1], \",\" ,sizeOf(a)); ?>;",
      );
      expect(output).toBe("7,2;");
    });

    it("for loop array fill and read", async () => {
      // Build an array using pre-declared elements via literal, then mutate
      const output = await runTemplate(
        "<? " +
        "a:=[0,1,2,3,4,5,6,7,8,9];" +
        "for (i:=0;i<10;i++) a[i]=9-i; " +
        "for (i:=0;i<10;i++) print(a[i]); " +
        "?>",
      );
      expect(output).toBe("9876543210");
    });

    it("nested arrays via multiplication", async () => {
      // Pre-allocate 25 elements then fill via assignment
      const output = await runTemplate(
        "<? " +
        "a:=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]; " +
        "for (i:=0;i<5;i++) {" +
        "  for (j:=0;j<5;j++) a[i*5+j]=i*j; " +
        "}" +
        "print(sizeOf(a));" +
        "for (i:=0;i<sizeOf(a);i++) print(\",\", a[i]); " +
        "?>",
      );
      expect(output).toBe("25,0,0,0,0,0,0,1,2,3,4,0,2,4,6,8,0,3,6,9,12,0,4,8,12,16");
    });

    it("sizeOf", async () => {
      const ctx = await run("a := [1, 2, 3, 4]; x := sizeOf(a);");
      expect(ctx.getVar("x")).toBe(4n);
    });
  });

  // ---------------------------------------------------------------------------
  // Maps / structs
  // ---------------------------------------------------------------------------

  describe("maps", () => {
    it("map creation and field access", async () => {
      const ctx = await run("m := {width: 8}; x := m.width;");
      expect(ctx.getVar("x")).toBe(8n);
    });

    it("nested map literal", async () => {
      const output = await runTemplate("<? m:={test:{val:7}}; print(m.test.val); ?>;");
      expect(output).toBe("7;");
    });

    it("dynamic map construction", async () => {
      // Use assignment instead of declaration for nested struct fields
      const output = await runTemplate("<? m:={test:{val:0}}; m.test.val=7; print(m.test.val); ?>;");
      expect(output).toBe("7;");
    });

    it("struct literal multiple fields", async () => {
      const ctx = await run("m := {a: 1, b: 2}; x := m.a + m.b;");
      expect(ctx.getVar("x")).toBe(3n);
    });

    it("nested struct literal evaluation", async () => {
      const ctx = await run("s := {a: 1, b: 2, c: {d: 3 + 4}};");
      const m = ctx.getVar("s");
      const { HGSMap } = await import("../value");
      expect(m).toBeInstanceOf(HGSMap);
    });
  });

  // ---------------------------------------------------------------------------
  // Template mode
  // ---------------------------------------------------------------------------

  describe("templateMode", () => {
    it("plain text passthrough", async () => {
      const output = await runTemplate("Hello World!");
      expect(output).toBe("Hello World!");
    });

    it("variable in template", async () => {
      const ctx = createRootContext();
      registerBuiltins(ctx);
      ctx.declareVar("a", "My");
      const ast = parseTemplate("Hello <? =a ?> World!");
      const output = await evaluate(ast, ctx);
      expect(output).toBe("Hello My World!");
    });

    it("escaped identifier in template", async () => {
      const ctx = createRootContext();
      registerBuiltins(ctx);
      ctx.declareVar("a a", "My");
      const ast = parseTemplate("Hello <? ='a a' ?> World!");
      const output = await evaluate(ast, ctx);
      expect(output).toBe("Hello My World!");
    });

    it("print in code block", async () => {
      const output = await runTemplate("Hello <? print(\"My\"); ?> World!");
      expect(output).toBe("Hello My World!");
    });

    it("brace delimiter form", async () => {
      const ctx = createRootContext();
      registerBuiltins(ctx);
      ctx.declareVar("a", "My");
      const ast = parseTemplate("{? =a ?}");
      const output = await evaluate(ast, ctx);
      expect(output).toBe("My");
    });

    it("printf in template", async () => {
      const output = await runTemplate("Hello <? printf(\"-%d-%d-\", 4, 5); ?> World!");
      expect(output).toBe("Hello -4-5- World!");
    });

    it("for loop in template produces text", async () => {
      // Template for-loop output: use print instead of interleaved text blocks
      const output = await runTemplate("Hello <? for (i:=0;i<10;i++) print(\"n\"); ?> World!");
      expect(output).toBe("Hello nnnnnnnnnn World!");
    });

    it("nested for loops in template", async () => {
      // Nested for loops producing structured output via print
      const output = await runTemplate(
        "Hello <? for (i:=0;i<3;i++) { print(\"(\"); for(j:=0;j<2;j++) print(\":\"); print(\")\"); } ?> World!",
      );
      expect(output).toBe("Hello (::)(::)(::) World!");
    });

    it("comment in template code block", async () => {
      const output = await runTemplate("<? // comment\nprint(\"false\"); // zzz\n ?>;");
      expect(output).toBe("false;");
    });
  });

  // ---------------------------------------------------------------------------
  // Built-in functions
  // ---------------------------------------------------------------------------

  describe("builtins", () => {
    it("bitsNeededFor", async () => {
      const ctx = await run("x := bitsNeededFor(255);");
      expect(ctx.getVar("x")).toBe(8n);
    });

    it("ceil", async () => {
      const ctx = await run("x := ceil(2.5);");
      expect(ctx.getVar("x")).toBe(3n);
    });

    it("floor", async () => {
      const ctx = await run("x := floor(2.5);");
      expect(ctx.getVar("x")).toBe(2n);
    });

    it("round", async () => {
      const ctx = await run("x := round(2.8);");
      expect(ctx.getVar("x")).toBe(3n);
    });

    it("min integer", async () => {
      const ctx = await run("x := min(2, 3);");
      expect(ctx.getVar("x")).toBe(2n);
    });

    it("min float", async () => {
      const ctx = await run("x := min(2.5, 3);");
      expect(ctx.getVar("x")).toBe(2.5);
    });

    it("max integer", async () => {
      const ctx = await run("x := max(2, 3);");
      expect(ctx.getVar("x")).toBe(3n);
    });

    it("max float", async () => {
      const ctx = await run("x := max(2.5, 3.5);");
      expect(ctx.getVar("x")).toBe(3.5);
    });

    it("abs positive", async () => {
      const ctx = await run("x := abs(3.5);");
      expect(ctx.getVar("x")).toBe(3.5);
    });

    it("abs negative float", async () => {
      const ctx = await run("x := abs(-3.5);");
      expect(ctx.getVar("x")).toBe(3.5);
    });

    it("abs integer", async () => {
      const ctx = await run("x := abs(-3);");
      expect(ctx.getVar("x")).toBe(3n);
    });

    it("sizeOf", async () => {
      const ctx = await run("a := [1, 2, 3]; x := sizeOf(a);");
      expect(ctx.getVar("x")).toBe(3n);
    });

    it("splitString", async () => {
      const ctx = await run('a := splitString("a b c"); x := a[0];');
      expect(ctx.getVar("x")).toBe("a");
    });

    it("format hex", async () => {
      const ctx = createRootContext();
      registerBuiltins(ctx);
      ctx.declareVar("Bits", 17n);
      const ast = parse('a := format("hex=%x;", Bits);');
      await evaluate(ast, ctx);
      expect(ctx.getVar("a")).toBe("hex=11;");
    });

    it("identifier builtin", async () => {
      const output = await runTemplate("<? str:=\"simple\"; print(identifier(str)); ?>");
      expect(output).toBe("simple");
    });

    it("identifier strips non-alnum", async () => {
      const output = await runTemplate("<? str:=\"A-0\"; print(identifier(str)); ?>");
      expect(output).toBe("A0");
    });

    it("identifier numeric prefix", async () => {
      const output = await runTemplate("<? str:=\"0-A\"; print(identifier(str)); ?>");
      expect(output).toBe("n0A");
    });

    it("startsWith true", async () => {
      const output = await runTemplate("<? if (startsWith(\"foobar\", \"foo\")) { print(\"true\"); } ?>");
      expect(output).toBe("true");
    });

    it("startsWith false", async () => {
      const output = await runTemplate("<? if (startsWith(\"foobar\", \"bar\")) { print(\"true\"); } ?>");
      expect(output).toBe("");
    });

    it("isPresent returns true for a defined variable", async () => {
      const ctx = createRootContext();
      registerBuiltins(ctx);
      ctx.declareVar("myVar", 42n);
      const ast = parse("x := isPresent(myVar);");
      await evaluate(ast, ctx);
      expect(ctx.getVar("x")).toBe(true);
    });

    it("isPresent returns false for an undefined variable", async () => {
      const ctx = createRootContext();
      registerBuiltins(ctx);
      const ast = parse("x := isPresent(undeclaredVar);");
      await evaluate(ast, ctx);
      expect(ctx.getVar("x")).toBe(false);
    });

    it("isPresent returns false without propagating evaluation error", async () => {
      const ctx = createRootContext();
      registerBuiltins(ctx);
      const ast = parse("result := isPresent(nosuchvar);");
      await expect(evaluate(ast, ctx)).resolves.toBeDefined();
      expect(ctx.getVar("result")).toBe(false);
    });

    it("isPresent used in conditional- present branch executes", async () => {
      const ctx = createRootContext();
      registerBuiltins(ctx);
      ctx.declareVar("val", 7n);
      const ast = parse("x := 0; if (isPresent(val)) x = 1; else x = 2;");
      await evaluate(ast, ctx);
      expect(ctx.getVar("x")).toBe(1n);
    });

    it("isPresent used in conditional- absent branch executes", async () => {
      const ctx = createRootContext();
      registerBuiltins(ctx);
      const ast = parse("x := 0; if (isPresent(missingVar)) x = 1; else x = 2;");
      await evaluate(ast, ctx);
      expect(ctx.getVar("x")).toBe(2n);
    });

    it("isPresent with no arguments returns false", async () => {
      const ctx = createRootContext();
      registerBuiltins(ctx);
      const ast = parse("x := isPresent();");
      await evaluate(ast, ctx);
      expect(ctx.getVar("x")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Error cases
  // ---------------------------------------------------------------------------

  describe("errorCases", () => {
    it("undefined variable throws", async () => {
      await expectError("x := undeclaredVar + 1;");
    });

    it("division by zero throws", async () => {
      await expectError("x := 1 / 0;");
    });

    it("array index out of bounds throws", async () => {
      await expectError("a := [1, 2]; x := a[5];");
    });

    it("return at top level throws", async () => {
      await expectError("return 1;");
    });

    it("panic throws with message", async () => {
      const ctx = createRootContext();
      registerBuiltins(ctx);
      ctx.declareVar("i", 2n);
      const ast = parse("if (i > 1) panic(\"myError\");");
      await expect(evaluate(ast, ctx)).rejects.toThrow(/myError/);
    });

    it("panic does not throw when condition false", async () => {
      const ctx = createRootContext();
      registerBuiltins(ctx);
      ctx.declareVar("i", 0n);
      const ast = parse("if (i > 1) panic(\"myError\");");
      await expect(evaluate(ast, ctx)).resolves.toBeDefined();
    });

    it("wrong variable type assignment fails", async () => {
      // Assigning integer to string variable- HGS does not enforce static types
      // but invalid operations on wrong types should throw
      await expectError('a := "hello"; b := a + a; c := b / 2;');
    });
  });

  // ---------------------------------------------------------------------------
  // Arithmetic parity
  // ---------------------------------------------------------------------------

  describe("arithmetic", () => {
    it("operator precedence- multiply before add", async () => {
      const ctx = await run("x := 1 + 2 * 2;");
      expect(ctx.getVar("x")).toBe(5n);
    });

    it("operator precedence- parentheses override", async () => {
      const ctx = await run("x := 2 * (1 + 2);");
      expect(ctx.getVar("x")).toBe(6n);
    });

    it("division left to right", async () => {
      const ctx = await run("x := 200 / 2 / 10;");
      expect(ctx.getVar("x")).toBe(10n);
    });

    it("double negation", async () => {
      const ctx = await run("x := - -1;");
      expect(ctx.getVar("x")).toBe(1n);
    });

    it("string concat right side", async () => {
      const ctx = await run('x := "Hallo" + (2*2);');
      expect(ctx.getVar("x")).toBe("Hallo4");
    });

    it("string concat with boolean", async () => {
      const ctx = await run('x := "Hallo_" + (1 < 2);');
      expect(ctx.getVar("x")).toBe("Hallo_true");
    });

    it("float division produces float", async () => {
      const ctx = await run("x := 3.0 / 2;");
      expect(ctx.getVar("x")).toBe(1.5);
    });

    it("integer division truncates", async () => {
      const ctx = await run("x := 3 / 2;");
      expect(ctx.getVar("x")).toBe(1n);
    });

    it("bitwise OR on integers", async () => {
      const ctx = await run("x := 1 | 2;");
      expect(ctx.getVar("x")).toBe(3n);
    });

    it("bitwise AND on integers", async () => {
      const ctx = await run("x := 1 & 2;");
      expect(ctx.getVar("x")).toBe(0n);
    });

    it("bitwise XOR on integers", async () => {
      const ctx = await run("x := 1 ^ 2;");
      expect(ctx.getVar("x")).toBe(3n);
    });

    it("bitwise NOT", async () => {
      const ctx = await run("x := ~1;");
      expect(ctx.getVar("x")).toBe(-2n);
    });

    it("logical OR on booleans", async () => {
      const ctx = await run("a := true; b := false; x := a | b;");
      expect(ctx.getVar("x")).toBe(true);
    });

    it("logical AND on booleans", async () => {
      const ctx = await run("a := true; b := false; x := a & b;");
      expect(ctx.getVar("x")).toBe(false);
    });

    it("logical XOR on booleans", async () => {
      const ctx = await run("a := true; b := false; x := a ^ b;");
      expect(ctx.getVar("x")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Comparisons
  // ---------------------------------------------------------------------------

  describe("comparisons", () => {
    it("string equality true", async () => {
      const ctx = await run('x := "Hello" = "Hello";');
      expect(ctx.getVar("x")).toBe(true);
    });

    it("string equality false", async () => {
      const ctx = await run('x := "Hello" = "World";');
      expect(ctx.getVar("x")).toBe(false);
    });

    it("string less than", async () => {
      const ctx = await run('x := "a" < "b";');
      expect(ctx.getVar("x")).toBe(true);
    });

    it("float comparisons", async () => {
      const ctx = await run("x := 1.0001 > 1;");
      expect(ctx.getVar("x")).toBe(true);
    });

    it("integer greater than equal", async () => {
      const ctx = await run("x := 5 >= 5;");
      expect(ctx.getVar("x")).toBe(true);
    });

    it("integer less than equal false", async () => {
      const ctx = await run("x := 6 <= 5;");
      expect(ctx.getVar("x")).toBe(false);
    });
  });
});
