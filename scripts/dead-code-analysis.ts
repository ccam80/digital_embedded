/**
 * dead-code-analysis.ts
 *
 * Uses the TypeScript compiler API to find genuinely dead code by eliminating
 * false positives from three patterns the knowledge-graph indexer misses:
 *
 *   1. Registry pattern — factories referenced via ComponentDefinition objects
 *      registered in register-all.ts
 *   2. Interface polymorphism — methods called through interface types that
 *      dispatch to concrete implementations
 *   3. Framework callbacks — functions passed to addEventListener, on*(),
 *      requestAnimationFrame, setTimeout, Promise.then, and hook objects
 *
 * Architecture: builds a global symbol→references map in a SINGLE AST walk,
 * then does O(1) lookups per exported symbol. Total complexity is
 * O(files × avg_nodes) rather than O(exports × files × nodes).
 *
 * Usage: npx tsx scripts/dead-code-analysis.ts [--json] [--verbose]
 */

import ts from "typescript";
import { resolve, relative, join } from "path";
import { readFileSync } from "fs";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const JSON_OUTPUT = args.includes("--json");
const VERBOSE = args.includes("--verbose");

// ---------------------------------------------------------------------------
// Setup: load the TypeScript program once
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const TSCONFIG_PATH = join(ROOT, "tsconfig.json");

function loadProgram(): ts.Program {
  const configFile = ts.readConfigFile(TSCONFIG_PATH, (p) =>
    readFileSync(p, "utf-8"),
  );
  if (configFile.error) {
    throw new Error(
      `Failed to read tsconfig: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`,
    );
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    ROOT,
  );
  return ts.createProgram(parsed.fileNames, parsed.options);
}

console.error("Loading TypeScript program...");
const program = loadProgram();
const checker = program.getTypeChecker();
const sourceFiles = program.getSourceFiles().filter((sf) => !sf.isDeclarationFile);
console.error(`  ${sourceFiles.length} source files loaded`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rel(filePath: string): string {
  return relative(ROOT, filePath).replace(/\\/g, "/");
}

function isTestFile(fileName: string): boolean {
  const r = rel(fileName);
  return (
    r.includes("__tests__") ||
    r.includes(".test.") ||
    r.includes(".spec.") ||
    r.includes("test-fixtures") ||
    r.includes("test-utils") ||
    r.startsWith("e2e/")
  );
}

function isSrcProd(fileName: string): boolean {
  const r = rel(fileName);
  return r.startsWith("src/") && !isTestFile(fileName);
}

// ---------------------------------------------------------------------------
// GLOBAL PASS: Build symbol → reference-locations map (single AST walk)
// ---------------------------------------------------------------------------

interface RefInfo {
  prodFiles: Set<string>; // rel paths of prod files that reference this symbol
  testFiles: Set<string>; // rel paths of test files that reference this symbol
}

/**
 * Walk every identifier in every source file once. For each, resolve its
 * symbol (chasing aliases), and record which file referenced it.
 */
function buildGlobalRefMap(): Map<ts.Symbol, RefInfo> {
  console.error("\nBuilding global reference map (single AST walk)...");
  const refMap = new Map<ts.Symbol, RefInfo>();
  let identCount = 0;

  for (const sf of sourceFiles) {
    const fileRel = rel(sf.fileName);
    const isTest = isTestFile(sf.fileName);

    ts.forEachChild(sf, function visit(node) {
      if (ts.isIdentifier(node)) {
        identCount++;
        try {
          const nodeSym = checker.getSymbolAtLocation(node);
          if (nodeSym) {
            const resolved =
              nodeSym.flags & ts.SymbolFlags.Alias
                ? checker.getAliasedSymbol(nodeSym)
                : nodeSym;

            let info = refMap.get(resolved);
            if (!info) {
              info = { prodFiles: new Set(), testFiles: new Set() };
              refMap.set(resolved, info);
            }
            if (isTest) {
              info.testFiles.add(fileRel);
            } else {
              info.prodFiles.add(fileRel);
            }
          }
        } catch {
          // Alias resolution can fail on complex expressions
        }
      }
      ts.forEachChild(node, visit);
    });
  }

  console.error(`  ${identCount.toLocaleString()} identifiers resolved`);
  console.error(`  ${refMap.size.toLocaleString()} unique symbols tracked`);
  return refMap;
}

// ---------------------------------------------------------------------------
// Pass 1: Registry pattern — collect factory symbols from *Definition objects
// ---------------------------------------------------------------------------

function collectRegistryFactories(): Set<ts.Symbol> {
  console.error("\nPass 1: Registry pattern...");
  const result = new Set<ts.Symbol>();

  for (const sf of sourceFiles) {
    if (!isSrcProd(sf.fileName)) continue;

    ts.forEachChild(sf, function visit(node) {
      if (
        ts.isVariableStatement(node) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        for (const decl of node.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          if (!decl.name.text.endsWith("Definition")) continue;
          if (!decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue;

          // The Definition object itself is reachable (imported by register-all)
          const defSym = checker.getSymbolAtLocation(decl.name);
          if (defSym) result.add(defSym);

          // Find the `factory` property and mark the factory fn as reachable
          for (const prop of decl.initializer.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === "factory" &&
              ts.isIdentifier(prop.initializer)
            ) {
              const factSym = checker.getSymbolAtLocation(prop.initializer);
              if (factSym) result.add(factSym);
            }
          }

          // Also mark all other identifier values in the definition as reachable
          // (renders, truth tables, model refs, etc.)
          for (const prop of decl.initializer.properties) {
            if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.initializer)) {
              const sym = checker.getSymbolAtLocation(prop.initializer);
              if (sym) result.add(sym);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    });
  }

  console.error(`  ${result.size} symbols reachable via registry definitions`);
  return result;
}

// ---------------------------------------------------------------------------
// Pass 2: Interface polymorphism
//
// Pre-compute: interfaceName → Set<className> (implements map)
// Then: for each interface method called on the interface type, mark all
// implementing class methods as reachable.
// ---------------------------------------------------------------------------

/** Map interfaceName → Set of class names that implement it (direct or via extends chain) */
function buildImplementsMap(): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();

  for (const sf of sourceFiles) {
    ts.forEachChild(sf, function visit(node) {
      if (ts.isClassDeclaration(node) && node.name && node.heritageClauses) {
        const className = node.name.text;

        for (const clause of node.heritageClauses) {
          if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
            for (const expr of clause.types) {
              try {
                const t = checker.getTypeAtLocation(expr.expression);
                if (t?.symbol?.name) {
                  const ifaceName = t.symbol.name;
                  if (!result.has(ifaceName)) result.set(ifaceName, new Set());
                  result.get(ifaceName)!.add(className);
                }
              } catch { /* skip */ }
            }
          }
          // Walk extends chain to pick up transitive interface implementations
          if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
            for (const expr of clause.types) {
              try {
                const baseType = checker.getTypeAtLocation(expr.expression);
                const baseDecls = baseType?.symbol?.declarations;
                if (!baseDecls) continue;
                for (const bd of baseDecls) {
                  if (ts.isClassDeclaration(bd) && bd.heritageClauses) {
                    for (const hc of bd.heritageClauses) {
                      if (hc.token === ts.SyntaxKind.ImplementsKeyword) {
                        for (const hexpr of hc.types) {
                          try {
                            const ht = checker.getTypeAtLocation(hexpr.expression);
                            if (ht?.symbol?.name) {
                              const ifaceName = ht.symbol.name;
                              if (!result.has(ifaceName)) result.set(ifaceName, new Set());
                              result.get(ifaceName)!.add(className);
                            }
                          } catch { /* skip */ }
                        }
                      }
                    }
                  }
                }
              } catch { /* skip */ }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    });
  }

  return result;
}

interface PolyResult {
  /** "ClassName.methodName" keys that are reachable via interface dispatch */
  reachable: Set<string>;
  /** Interface methods with zero call sites (truly dead across all impls) */
  deadInterfaceMethods: Array<{ interfaceName: string; methodName: string }>;
  stats: { totalInterfaceMethods: number; reachableImplCount: number };
}

function analyzePolymorphicDispatch(): PolyResult {
  console.error("\nPass 2: Interface polymorphism...");

  // Step 1: Collect interface declarations and their method names
  const interfaces = new Map<string, Set<string>>(); // ifaceName → method names
  for (const sf of sourceFiles) {
    if (!isSrcProd(sf.fileName)) continue;
    ts.forEachChild(sf, function visit(node) {
      if (ts.isInterfaceDeclaration(node)) {
        const methods = new Set<string>();
        for (const member of node.members) {
          if (
            (ts.isMethodSignature(member) || ts.isPropertySignature(member)) &&
            member.name &&
            ts.isIdentifier(member.name)
          ) {
            methods.add(member.name.text);
          }
        }
        if (methods.size > 0) {
          // Merge with existing (interface augmentation / re-declaration)
          const existing = interfaces.get(node.name.text);
          if (existing) {
            for (const m of methods) existing.add(m);
          } else {
            interfaces.set(node.name.text, methods);
          }
        }
      }
      ts.forEachChild(node, visit);
    });
  }

  // Step 2: Single walk to collect all obj.method() calls, recording the
  // resolved type name of `obj`
  const calledOnType = new Map<string, Set<string>>(); // "TypeName.method" → call locations
  for (const sf of sourceFiles) {
    ts.forEachChild(sf, function visit(node) {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression)
      ) {
        const methodName = node.expression.name.text;
        try {
          const objType = checker.getTypeAtLocation(node.expression.expression);
          if (objType?.symbol?.name) {
            const key = `${objType.symbol.name}.${methodName}`;
            if (!calledOnType.has(key)) calledOnType.set(key, new Set());
            calledOnType.get(key)!.add(rel(sf.fileName));
          }
          const apparent = checker.getApparentType(objType);
          if (apparent?.symbol && apparent.symbol !== objType?.symbol) {
            const key = `${apparent.symbol.name}.${methodName}`;
            if (!calledOnType.has(key)) calledOnType.set(key, new Set());
            calledOnType.get(key)!.add(rel(sf.fileName));
          }
        } catch { /* skip */ }
      }
      // Also catch property reads (method refs passed as callbacks)
      if (
        ts.isPropertyAccessExpression(node) &&
        !ts.isCallExpression(node.parent)
      ) {
        try {
          const objType = checker.getTypeAtLocation(node.expression);
          if (objType?.symbol?.name) {
            const key = `${objType.symbol.name}.${node.name.text}`;
            if (!calledOnType.has(key)) calledOnType.set(key, new Set());
            calledOnType.get(key)!.add(rel(sf.fileName));
          }
        } catch { /* skip */ }
      }
      ts.forEachChild(node, visit);
    });
  }

  // Step 3: Build implements map
  const implementsMap = buildImplementsMap();

  // Step 4: For each interface method with call sites, mark implementations reachable
  const reachable = new Set<string>();
  const deadInterfaceMethods: PolyResult["deadInterfaceMethods"] = [];
  let totalInterfaceMethods = 0;

  for (const [ifaceName, methods] of interfaces) {
    for (const methodName of methods) {
      totalInterfaceMethods++;
      const key = `${ifaceName}.${methodName}`;

      if (calledOnType.has(key)) {
        // Mark all implementors' methods as reachable
        const impls = implementsMap.get(ifaceName);
        if (impls) {
          for (const className of impls) {
            reachable.add(`${className}.${methodName}`);
          }
        }
      } else {
        deadInterfaceMethods.push({ interfaceName: ifaceName, methodName });
      }
    }
  }

  console.error(`  ${interfaces.size} interfaces with ${totalInterfaceMethods} methods`);
  console.error(`  ${reachable.size} implementation methods reachable via dispatch`);
  console.error(`  ${deadInterfaceMethods.length} interface methods with no call sites`);

  return {
    reachable,
    deadInterfaceMethods,
    stats: { totalInterfaceMethods, reachableImplCount: reachable.size },
  };
}

// ---------------------------------------------------------------------------
// Pass 3: Framework callbacks — functions passed to known callback sinks
// ---------------------------------------------------------------------------

const CALLBACK_SINKS = new Set([
  "addEventListener",
  "removeEventListener",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "setTimeout",
  "setInterval",
  "then",
  "catch",
  "finally",
  "queueMicrotask",
]);

const ON_CALLBACK_PATTERN = /^on[A-Z]/;

function collectCallbackEntryPoints(): {
  reachableSymbols: Set<ts.Symbol>;
  count: number;
} {
  console.error("\nPass 3: Framework callbacks...");
  const reachableSymbols = new Set<ts.Symbol>();
  let count = 0;

  function markExpr(expr: ts.Expression): void {
    if (ts.isIdentifier(expr)) {
      const sym = checker.getSymbolAtLocation(expr);
      if (sym) { reachableSymbols.add(sym); count++; }
    } else if (ts.isPropertyAccessExpression(expr)) {
      const sym = checker.getSymbolAtLocation(expr.name);
      if (sym) { reachableSymbols.add(sym); count++; }
    } else if (
      ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.name.text === "bind"
    ) {
      // fn.bind(this) — mark fn
      markExpr(expr.expression.expression);
    }
    // inline arrow/function expressions are anonymous — no symbol to track
  }

  function markHookObject(obj: ts.ObjectLiteralExpression): void {
    for (const prop of obj.properties) {
      if (ts.isPropertyAssignment(prop)) {
        if (ts.isObjectLiteralExpression(prop.initializer)) {
          markHookObject(prop.initializer); // nested: { hooks: { ... } }
        } else if (ts.isIdentifier(prop.initializer)) {
          const sym = checker.getSymbolAtLocation(prop.initializer);
          if (sym) { reachableSymbols.add(sym); count++; }
        }
        // inline arrow/fn in hook object — anonymous, skip
      }
      // shorthand methods in object literal — anonymous, skip
    }
  }

  for (const sf of sourceFiles) {
    ts.forEachChild(sf, function visit(node) {
      if (ts.isCallExpression(node)) {
        let isSink = false;

        if (ts.isPropertyAccessExpression(node.expression)) {
          const name = node.expression.name.text;
          if (CALLBACK_SINKS.has(name) || ON_CALLBACK_PATTERN.test(name)) {
            isSink = true;
          }
        } else if (ts.isIdentifier(node.expression)) {
          if (CALLBACK_SINKS.has(node.expression.text)) {
            isSink = true;
          }
        }

        if (isSink) {
          for (const arg of node.arguments) markExpr(arg);
        }
      }

      // new Constructor({ hooks: ... }) — mark hook object properties
      if (ts.isNewExpression(node)) {
        for (const arg of node.arguments ?? []) {
          if (ts.isObjectLiteralExpression(arg)) {
            markHookObject(arg);
          }
        }
      }

      ts.forEachChild(node, visit);
    });
  }

  console.error(`  ${reachableSymbols.size} symbols reachable as callbacks`);
  console.error(`  ${count} callback registrations found`);
  return { reachableSymbols, count };
}

// ---------------------------------------------------------------------------
// Pass 4: Collect all exported symbols from production code
// ---------------------------------------------------------------------------

interface ExportedSymbolInfo {
  name: string;
  kind: "function" | "class" | "variable" | "type" | "interface";
  file: string;
  line: number;
  symbol: ts.Symbol;
}

function collectExportedSymbols(): ExportedSymbolInfo[] {
  console.error("\nPass 4: Collecting exports...");
  const result: ExportedSymbolInfo[] = [];

  for (const sf of sourceFiles) {
    if (!isSrcProd(sf.fileName)) continue;
    const sfSymbol = checker.getSymbolAtLocation(sf);
    if (!sfSymbol) continue;

    const exports = checker.getExportsOfModule(sfSymbol);
    for (const exp of exports) {
      const decls = exp.getDeclarations();
      if (!decls || decls.length === 0) continue;
      const decl = decls[0];
      const { line } = sf.getLineAndCharacterOfPosition(decl.getStart());

      let kind: ExportedSymbolInfo["kind"] | undefined;
      if (ts.isFunctionDeclaration(decl)) kind = "function";
      else if (ts.isClassDeclaration(decl)) kind = "class";
      else if (ts.isVariableDeclaration(decl)) kind = "variable";
      else if (ts.isInterfaceDeclaration(decl)) kind = "interface";
      else if (ts.isTypeAliasDeclaration(decl)) kind = "type";

      if (kind) {
        result.push({
          name: exp.name,
          kind,
          file: rel(sf.fileName),
          line: line + 1,
          symbol: exp,
        });
      }
    }
  }

  console.error(`  ${result.length} exported symbols in production code`);
  return result;
}

// ---------------------------------------------------------------------------
// Main: combine all passes with O(1) reference lookups
// ---------------------------------------------------------------------------

interface DeadCodeResult {
  genuinelyDead: Array<{ name: string; kind: string; file: string; line: number }>;
  testOnly: Array<{ name: string; kind: string; file: string; line: number; testFiles: string[] }>;
  registryReachable: number;
  polymorphicReachable: number;
  callbackReachable: number;
  totalExports: number;
  deadInterfaceMethods: Array<{ interfaceName: string; methodName: string }>;
}

function runAnalysis(): DeadCodeResult {
  // Single global walk to build symbol → reference map
  const globalRefs = buildGlobalRefMap();

  // Three elimination passes
  const registrySymbols = collectRegistryFactories();
  const polyResult = analyzePolymorphicDispatch();
  const callbackResult = collectCallbackEntryPoints();

  // Collect what we're checking
  const allExports = collectExportedSymbols();

  // Classify each export using O(1) map lookups
  console.error("\nPass 5: Classifying exports...");
  const genuinelyDead: DeadCodeResult["genuinelyDead"] = [];
  const testOnly: DeadCodeResult["testOnly"] = [];
  let registryReachable = 0;
  let polymorphicReachable = 0;
  let callbackReachable = 0;

  for (const exp of allExports) {
    // Elimination: registry
    if (registrySymbols.has(exp.symbol)) {
      registryReachable++;
      continue;
    }

    // Elimination: callback sinks
    if (callbackResult.reachableSymbols.has(exp.symbol)) {
      callbackReachable++;
      continue;
    }

    // Elimination: polymorphic dispatch (for classes, check their methods)
    // This pass marks "ClassName.methodName" — but exports are classes not methods.
    // We mark a class as reachable if ANY of its methods are dispatched via interface.
    if (exp.kind === "class" && polyResult.reachable.size > 0) {
      const prefix = `${exp.name}.`;
      let anyReachable = false;
      for (const key of polyResult.reachable) {
        if (key.startsWith(prefix)) { anyReachable = true; break; }
      }
      if (anyReachable) {
        polymorphicReachable++;
        continue;
      }
    }

    // O(1) lookup: is this symbol referenced outside its own file?
    const refs = globalRefs.get(exp.symbol);
    if (!refs) {
      // No references anywhere (not even in its own file for re-exports)
      genuinelyDead.push({ name: exp.name, kind: exp.kind, file: exp.file, line: exp.line });
      continue;
    }

    // Filter: remove self-file references
    const prodOther = new Set(refs.prodFiles);
    prodOther.delete(exp.file);
    const testOther = new Set(refs.testFiles);
    testOther.delete(exp.file);

    if (prodOther.size === 0 && testOther.size === 0) {
      genuinelyDead.push({ name: exp.name, kind: exp.kind, file: exp.file, line: exp.line });
    } else if (prodOther.size === 0 && testOther.size > 0) {
      testOnly.push({
        name: exp.name,
        kind: exp.kind,
        file: exp.file,
        line: exp.line,
        testFiles: [...testOther],
      });
    }
    // else: used in prod → alive, skip
  }

  console.error(`  Done. ${genuinelyDead.length} dead, ${testOnly.length} test-only.`);

  return {
    genuinelyDead,
    testOnly,
    registryReachable,
    polymorphicReachable,
    callbackReachable,
    totalExports: allExports.length,
    deadInterfaceMethods: polyResult.deadInterfaceMethods,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const result = runAnalysis();

if (JSON_OUTPUT) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} else {
  console.log("\n" + "=".repeat(70));
  console.log("DEAD CODE ANALYSIS RESULTS");
  console.log("=".repeat(70));

  console.log(`\nTotal exported symbols scanned: ${result.totalExports}`);
  console.log(`Registry-reachable (eliminated):    ${result.registryReachable}`);
  console.log(`Polymorphic-reachable (eliminated):  ${result.polymorphicReachable}`);
  console.log(`Callback-reachable (eliminated):     ${result.callbackReachable}`);

  console.log(`\n${"─".repeat(70)}`);
  console.log(`GENUINELY DEAD (${result.genuinelyDead.length} symbols)`);
  console.log(`${"─".repeat(70)}`);
  for (const d of result.genuinelyDead) {
    console.log(`  [${d.kind}] ${d.name}  →  ${d.file}:${d.line}`);
  }

  console.log(`\n${"─".repeat(70)}`);
  console.log(`TEST-ONLY (${result.testOnly.length} symbols — used only by tests)`);
  console.log(`${"─".repeat(70)}`);
  for (const t of result.testOnly) {
    console.log(`  [${t.kind}] ${t.name}  →  ${t.file}:${t.line}`);
    if (VERBOSE) {
      for (const tf of t.testFiles) {
        console.log(`      tested in: ${tf}`);
      }
    }
  }

  if (result.deadInterfaceMethods.length > 0) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(
      `DEAD INTERFACE METHODS (${result.deadInterfaceMethods.length} — on interface, never called)`,
    );
    console.log(`${"─".repeat(70)}`);
    for (const u of result.deadInterfaceMethods) {
      console.log(`  ${u.interfaceName}.${u.methodName}`);
    }
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log("SUMMARY");
  console.log(`${"=".repeat(70)}`);
  const eliminated = result.registryReachable + result.polymorphicReachable + result.callbackReachable;
  console.log(`  Genuinely dead exports:     ${result.genuinelyDead.length}`);
  console.log(`  Test-only exports:          ${result.testOnly.length}`);
  console.log(`  Dead interface methods:     ${result.deadInterfaceMethods.length}`);
  console.log(`  False positives eliminated: ${eliminated}`);
  console.log(`    via registry:             ${result.registryReachable}`);
  console.log(`    via polymorphic dispatch: ${result.polymorphicReachable}`);
  console.log(`    via callback sinks:       ${result.callbackReachable}`);
}
