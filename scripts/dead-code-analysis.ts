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
import { readFileSync, readdirSync, statSync } from "fs";

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

/** Recursively collect .ts files under a directory. */
function collectTsFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules") {
        results.push(...collectTsFiles(full));
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        results.push(full);
      }
    }
  } catch { /* skip inaccessible dirs */ }
  return results;
}

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
  // Also include scripts/ files so their imports from src/ are tracked as references
  const scriptFiles = collectTsFiles(join(ROOT, "scripts"));
  const allFiles = [...new Set([...parsed.fileNames, ...scriptFiles])];
  return ts.createProgram(allFiles, parsed.options);
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
  /** Per-file reference counts. Used to distinguish declaration-only from internal usage. */
  fileCounts: Map<string, number>;
}

/**
 * Walk every identifier in every source file once. For each, resolve its
 * symbol (chasing aliases), and record which file referenced it.
 */
function buildGlobalRefMap(): Map<ts.Symbol, RefInfo> {
  console.error("\nBuilding global reference map (single AST walk)...");
  const refMap = new Map<ts.Symbol, RefInfo>();
  let identCount = 0;

  function recordRef(resolved: ts.Symbol, fileRel: string, isTest: boolean): void {
    let info = refMap.get(resolved);
    if (!info) {
      info = { prodFiles: new Set(), testFiles: new Set(), fileCounts: new Map() };
      refMap.set(resolved, info);
    }
    if (isTest) {
      info.testFiles.add(fileRel);
    } else {
      info.prodFiles.add(fileRel);
    }
    info.fileCounts.set(fileRel, (info.fileCounts.get(fileRel) ?? 0) + 1);
  }

  for (const sf of sourceFiles) {
    const fileRel = rel(sf.fileName);
    const isTest = isTestFile(sf.fileName);

    ts.forEachChild(sf, function visit(node) {
      // Track regular identifiers
      if (ts.isIdentifier(node)) {
        identCount++;
        try {
          const nodeSym = checker.getSymbolAtLocation(node);
          if (nodeSym) {
            const resolved =
              nodeSym.flags & ts.SymbolFlags.Alias
                ? checker.getAliasedSymbol(nodeSym)
                : nodeSym;
            recordRef(resolved, fileRel, isTest);
          }
        } catch {
          // Alias resolution can fail on complex expressions
        }
      }
      // Also track type references (e.g. `import type { Foo }` usages in
      // type annotations, return types, generics). The TS checker sometimes
      // fails to resolve these through type-only imports when walking plain
      // identifiers, so we handle TypeReferenceNodes explicitly.
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
        identCount++;
        try {
          const nodeSym = checker.getSymbolAtLocation(node.typeName);
          if (nodeSym) {
            const resolved =
              nodeSym.flags & ts.SymbolFlags.Alias
                ? checker.getAliasedSymbol(nodeSym)
                : nodeSym;
            recordRef(resolved, fileRel, isTest);
          }
        } catch {
          // skip
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

  /**
   * Recursively walk an object literal and mark every identifier reference
   * as reachable. This catches deeply nested structures like:
   *   models: { digital: { executeFn: executeAnd, sampleFn: sampleD } }
   *   modelRegistry: { behavioral: { factory: makeAndAnalogFactory(0) } }
   */
  function walkObjectTree(obj: ts.ObjectLiteralExpression): void {
    for (const prop of obj.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const init = prop.initializer;
        if (ts.isIdentifier(init)) {
          const sym = checker.getSymbolAtLocation(init);
          if (sym) result.add(sym);
        } else if (ts.isObjectLiteralExpression(init)) {
          walkObjectTree(init);
        } else if (ts.isArrayLiteralExpression(init)) {
          for (const el of init.elements) {
            if (ts.isIdentifier(el)) {
              const sym = checker.getSymbolAtLocation(el);
              if (sym) result.add(sym);
            } else if (ts.isObjectLiteralExpression(el)) {
              walkObjectTree(el);
            }
          }
        } else if (ts.isCallExpression(init)) {
          // e.g. factory: makeAndAnalogFactory(0) — mark the called function
          if (ts.isIdentifier(init.expression)) {
            const sym = checker.getSymbolAtLocation(init.expression);
            if (sym) result.add(sym);
          }
          // Also mark any identifier arguments
          for (const arg of init.arguments) {
            if (ts.isIdentifier(arg)) {
              const sym = checker.getSymbolAtLocation(arg);
              if (sym) result.add(sym);
            }
          }
        }
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        const sym = checker.getSymbolAtLocation(prop.name);
        if (sym) result.add(sym);
      } else if (ts.isSpreadAssignment(prop)) {
        if (ts.isIdentifier(prop.expression)) {
          const sym = checker.getSymbolAtLocation(prop.expression);
          if (sym) result.add(sym);
        }
      }
    }
  }

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

          // Walk the entire object tree to find all referenced symbols
          walkObjectTree(decl.initializer);
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

  /**
   * Recursively walk an object literal marking all identifier values as
   * reachable. Handles nested objects, call expressions, shorthand props,
   * spreads, and arrays — the same patterns used in hook objects and
   * options bags passed to constructors and init functions.
   */
  function markHookObject(obj: ts.ObjectLiteralExpression): void {
    for (const prop of obj.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const init = prop.initializer;
        if (ts.isObjectLiteralExpression(init)) {
          markHookObject(init);
        } else if (ts.isIdentifier(init)) {
          const sym = checker.getSymbolAtLocation(init);
          if (sym) { reachableSymbols.add(sym); count++; }
        } else if (ts.isCallExpression(init) && ts.isIdentifier(init.expression)) {
          // { factory: makeFoo(args) } — mark makeFoo as reachable
          const sym = checker.getSymbolAtLocation(init.expression);
          if (sym) { reachableSymbols.add(sym); count++; }
        } else if (ts.isArrayLiteralExpression(init)) {
          for (const el of init.elements) {
            if (ts.isIdentifier(el)) {
              const sym = checker.getSymbolAtLocation(el);
              if (sym) { reachableSymbols.add(sym); count++; }
            } else if (ts.isObjectLiteralExpression(el)) {
              markHookObject(el);
            }
          }
        }
        // inline arrow/fn — anonymous, no symbol to track
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        // { myHandler } shorthand — the name IS the value
        const sym = checker.getSymbolAtLocation(prop.name);
        if (sym) { reachableSymbols.add(sym); count++; }
      } else if (ts.isSpreadAssignment(prop) && ts.isIdentifier(prop.expression)) {
        const sym = checker.getSymbolAtLocation(prop.expression);
        if (sym) { reachableSymbols.add(sym); count++; }
      }
      // shorthand methods — anonymous, skip
    }
  }

  /**
   * Detect whether a function call looks like an initialization / wiring
   * function that receives option bags with callbacks. Heuristic: any
   * function call whose name starts with "init", "setup", "configure",
   * "create", or "register" and receives an object literal argument.
   */
  const INIT_FN_PATTERN = /^(?:init|setup|configure|create|register|build|make)/i;

  for (const sf of sourceFiles) {
    ts.forEachChild(sf, function visit(node) {
      if (ts.isCallExpression(node)) {
        let isSink = false;
        let calleeName: string | undefined;

        if (ts.isPropertyAccessExpression(node.expression)) {
          const name = node.expression.name.text;
          calleeName = name;
          if (CALLBACK_SINKS.has(name) || ON_CALLBACK_PATTERN.test(name)) {
            isSink = true;
          }
        } else if (ts.isIdentifier(node.expression)) {
          calleeName = node.expression.text;
          if (CALLBACK_SINKS.has(calleeName)) {
            isSink = true;
          }
        }

        if (isSink) {
          for (const arg of node.arguments) markExpr(arg);
        }

        // Object-literal args to init/setup/create functions → treat as hook objects
        if (calleeName && INIT_FN_PATTERN.test(calleeName)) {
          for (const arg of node.arguments) {
            if (ts.isObjectLiteralExpression(arg)) {
              markHookObject(arg);
            }
          }
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
      // Resolve export aliases to the underlying declaration symbol so that
      // Set<Symbol> comparisons against registry/callback passes match.
      const resolved =
        exp.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exp)
          : exp;

      const decls = resolved.getDeclarations();
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
          symbol: resolved,
        });
      }
    }
  }

  console.error(`  ${result.length} exported symbols in production code`);
  return result;
}

// ---------------------------------------------------------------------------
// Pass 6: Dead methods on exported classes
//
// For each exported class, enumerate its methods and check whether each one
// is referenced outside its defining file. Skip methods that are interface
// implementations (already covered by the polymorphic dispatch pass).
// ---------------------------------------------------------------------------

interface DeadMethodInfo {
  className: string;
  methodName: string;
  file: string;
  line: number;
  visibility: "public" | "protected" | "private";
  reason: "dead" | "test-only";
  testFiles?: string[];
}

function collectDeadClassMethods(
  globalRefs: Map<ts.Symbol, RefInfo>,
  polyReachable: Set<string>,
  implementsMap: Map<string, Set<string>>,
): { deadMethods: DeadMethodInfo[]; totalChecked: number } {
  console.error("\nPass 6: Dead class methods...");
  const deadMethods: DeadMethodInfo[] = [];
  let totalChecked = 0;

  // Build reverse implements map: className → Set<interfaceName>
  const classInterfaces = new Map<string, Set<string>>();
  for (const [ifaceName, classNames] of implementsMap) {
    for (const cn of classNames) {
      if (!classInterfaces.has(cn)) classInterfaces.set(cn, new Set());
      classInterfaces.get(cn)!.add(ifaceName);
    }
  }

  // Collect all interface method names per interface for quick lookup
  const interfaceMethodNames = new Map<string, Set<string>>();
  for (const sf of sourceFiles) {
    if (!isSrcProd(sf.fileName)) continue;
    ts.forEachChild(sf, function visit(node) {
      if (ts.isInterfaceDeclaration(node)) {
        const methods = new Set<string>();
        for (const member of node.members) {
          if (member.name && ts.isIdentifier(member.name)) {
            methods.add(member.name.text);
          }
        }
        if (methods.size > 0) {
          const existing = interfaceMethodNames.get(node.name.text);
          if (existing) {
            for (const m of methods) existing.add(m);
          } else {
            interfaceMethodNames.set(node.name.text, methods);
          }
        }
      }
      ts.forEachChild(node, visit);
    });
  }

  for (const sf of sourceFiles) {
    if (!isSrcProd(sf.fileName)) continue;
    const fileRel = rel(sf.fileName);

    ts.forEachChild(sf, function visit(node) {
      if (!ts.isClassDeclaration(node) || !node.name) {
        ts.forEachChild(node, visit);
        return;
      }

      // Only check exported classes (non-exported are caught by noUnusedLocals)
      const isExported = node.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (!isExported) return;

      const className = node.name.text;

      // Which interfaces does this class implement?
      const ifaces = classInterfaces.get(className) ?? new Set<string>();

      // Collect all interface method names this class must implement
      const ifaceMethodSet = new Set<string>();
      for (const iface of ifaces) {
        const methods = interfaceMethodNames.get(iface);
        if (methods) {
          for (const m of methods) ifaceMethodSet.add(m);
        }
      }

      for (const member of node.members) {
        // Only check methods (including getters/setters)
        if (
          !ts.isMethodDeclaration(member) &&
          !ts.isGetAccessorDeclaration(member) &&
          !ts.isSetAccessorDeclaration(member)
        ) continue;

        if (!member.name || !ts.isIdentifier(member.name)) continue;
        const methodName = member.name.text;

        // Skip constructor
        if (methodName === "constructor") continue;

        // Skip interface implementations — handled by polymorphic pass
        if (ifaceMethodSet.has(methodName)) continue;

        // Skip if already marked reachable by polymorphic dispatch
        if (polyReachable.has(`${className}.${methodName}`)) continue;

        totalChecked++;

        // Determine visibility
        let visibility: DeadMethodInfo["visibility"] = "public";
        if (member.modifiers) {
          for (const mod of member.modifiers) {
            if (mod.kind === ts.SyntaxKind.PrivateKeyword) visibility = "private";
            else if (mod.kind === ts.SyntaxKind.ProtectedKeyword) visibility = "protected";
          }
        }
        // Also treat JS private fields (#name) and TS private as private
        if (ts.isPrivateIdentifier(member.name)) visibility = "private";

        // Resolve the method's symbol. Call sites like `obj.method()` resolve
        // to the *type property* symbol, not the declaration symbol. We need
        // to check both, plus the symbol obtained via the class type's property.
        const declSym = checker.getSymbolAtLocation(member.name);

        // Also resolve through the class type — this is what call sites see.
        // We need both the static type (ClassName) and instance type (what
        // `this` resolves to inside the class / what `new Class()` produces),
        // since call sites may use either depending on context.
        const typePropSyms: ts.Symbol[] = [];
        try {
          const classType = checker.getTypeAtLocation(node.name!);
          // Static type property (covers ClassName.staticMethod())
          const staticProp = classType.getProperty(methodName);
          if (staticProp) typePropSyms.push(staticProp);
          // Instance type property (covers this.method() and obj.method())
          const ctorSigs = classType.getConstructSignatures();
          if (ctorSigs.length > 0) {
            const instanceType = ctorSigs[0].getReturnType();
            const instanceProp = instanceType.getProperty(methodName);
            if (instanceProp) typePropSyms.push(instanceProp);
          }
          // Also try getDeclaredType for classes without explicit constructors
          const declaredType = checker.getDeclaredTypeOfSymbol(classType.symbol);
          const declaredProp = declaredType.getProperty(methodName);
          if (declaredProp) typePropSyms.push(declaredProp);
        } catch { /* skip */ }

        // Merge refs from all symbol identities
        const prodFiles = new Set<string>();
        const testFiles = new Set<string>();

        for (const sym of [declSym, ...typePropSyms]) {
          if (!sym) continue;
          const refs = globalRefs.get(sym);
          if (!refs) continue;
          for (const f of refs.prodFiles) prodFiles.add(f);
          for (const f of refs.testFiles) testFiles.add(f);
        }

        // Filter self-file references — but for private methods, same-file
        // is the ONLY place they can be called from, so a self-file reference
        // proves they're alive.
        if (visibility !== "private") {
          prodFiles.delete(fileRel);
          testFiles.delete(fileRel);
        }

        const line = sf.getLineAndCharacterOfPosition(member.getStart()).line + 1;

        if (prodFiles.size === 0 && testFiles.size === 0) {
          deadMethods.push({
            className, methodName, file: fileRel, line,
            visibility, reason: "dead",
          });
        } else if (prodFiles.size === 0 && testFiles.size > 0) {
          deadMethods.push({
            className, methodName, file: fileRel, line,
            visibility, reason: "test-only",
            testFiles: [...testFiles],
          });
        }
      }
    });
  }

  const dead = deadMethods.filter((m) => m.reason === "dead").length;
  const testOnly = deadMethods.filter((m) => m.reason === "test-only").length;
  console.error(`  ${totalChecked} methods checked on exported classes`);
  console.error(`  ${dead} dead, ${testOnly} test-only`);

  return { deadMethods, totalChecked };
}

// ---------------------------------------------------------------------------
// Main: combine all passes with O(1) reference lookups
// ---------------------------------------------------------------------------

interface DeadCodeResult {
  genuinelyDead: Array<{ name: string; kind: string; file: string; line: number }>;
  unexportCandidates: Array<{ name: string; kind: string; file: string; line: number }>;
  testOnly: Array<{ name: string; kind: string; file: string; line: number; testFiles: string[] }>;
  deadClassMethods: DeadMethodInfo[];
  totalClassMethodsChecked: number;
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

  // Dead class methods (uses polyResult.reachable and the implementsMap)
  const implementsMap = buildImplementsMap(); // already fast, cached internally
  const classMethodResult = collectDeadClassMethods(
    globalRefs,
    polyResult.reachable,
    implementsMap,
  );

  // Classify each export using O(1) map lookups
  console.error("\nPass 5: Classifying exports...");
  const genuinelyDead: DeadCodeResult["genuinelyDead"] = [];
  const unexportCandidates: DeadCodeResult["unexportCandidates"] = [];
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

    // Filter: remove self-file references for external reachability check
    const prodOther = new Set(refs.prodFiles);
    prodOther.delete(exp.file);
    const testOther = new Set(refs.testFiles);
    testOther.delete(exp.file);

    // Check if this symbol is referenced within its own file beyond its declaration.
    // The declaration itself counts as 1 reference. If the file has >1 refs, the
    // symbol is called/used internally — only the export keyword is dead.
    // For types/interfaces that appear in other declarations in the same file
    // (e.g. as a parameter type), the count will also be >1.
    const sameFileCount = refs.fileCounts.get(exp.file) ?? 0;
    const usedInternally = sameFileCount > 1;

    if (prodOther.size === 0 && testOther.size === 0) {
      if (usedInternally) {
        // Referenced within its own file but nowhere else — the export is dead,
        // but the symbol itself is used internally. Candidate for unexport.
        unexportCandidates.push({ name: exp.name, kind: exp.kind, file: exp.file, line: exp.line });
      } else {
        genuinelyDead.push({ name: exp.name, kind: exp.kind, file: exp.file, line: exp.line });
      }
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

  console.error(`  Done. ${genuinelyDead.length} dead, ${unexportCandidates.length} unexport-candidates, ${testOnly.length} test-only.`);

  return {
    genuinelyDead,
    unexportCandidates,
    testOnly,
    deadClassMethods: classMethodResult.deadMethods,
    totalClassMethodsChecked: classMethodResult.totalChecked,
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

  if (result.unexportCandidates.length > 0) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(`UNEXPORT CANDIDATES (${result.unexportCandidates.length} symbols — used internally, export is dead)`);
    console.log(`${"─".repeat(70)}`);
    for (const u of result.unexportCandidates) {
      console.log(`  [${u.kind}] ${u.name}  →  ${u.file}:${u.line}`);
    }
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

  const deadMethods = result.deadClassMethods.filter((m) => m.reason === "dead");
  const testOnlyMethods = result.deadClassMethods.filter((m) => m.reason === "test-only");

  if (deadMethods.length > 0) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(
      `DEAD CLASS METHODS (${deadMethods.length} — on exported classes, never called)`,
    );
    console.log(`${"─".repeat(70)}`);
    for (const m of deadMethods) {
      const vis = m.visibility !== "public" ? `${m.visibility} ` : "";
      console.log(`  ${vis}${m.className}.${m.methodName}  →  ${m.file}:${m.line}`);
    }
  }

  if (testOnlyMethods.length > 0) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(
      `TEST-ONLY CLASS METHODS (${testOnlyMethods.length} — called only from tests)`,
    );
    console.log(`${"─".repeat(70)}`);
    for (const m of testOnlyMethods) {
      const vis = m.visibility !== "public" ? `${m.visibility} ` : "";
      console.log(`  ${vis}${m.className}.${m.methodName}  →  ${m.file}:${m.line}`);
      if (VERBOSE && m.testFiles) {
        for (const tf of m.testFiles) {
          console.log(`      tested in: ${tf}`);
        }
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
  console.log(`  Unexport candidates:        ${result.unexportCandidates.length}`);
  console.log(`  Test-only exports:          ${result.testOnly.length}`);
  console.log(`  Dead class methods:         ${deadMethods.length} dead, ${testOnlyMethods.length} test-only (of ${result.totalClassMethodsChecked} checked)`);
  console.log(`  Dead interface methods:     ${result.deadInterfaceMethods.length}`);
  console.log(`  False positives eliminated: ${eliminated}`);
  console.log(`    via registry:             ${result.registryReachable}`);
  console.log(`    via polymorphic dispatch: ${result.polymorphicReachable}`);
  console.log(`    via callback sinks:       ${result.callbackReachable}`);
}
