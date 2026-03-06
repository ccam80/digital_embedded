# Review Report: Phase 4 — .dig Parser, File I/O & HGS

## Summary

| Item | Count |
|------|-------|
| Tasks in scope | 14 (4.1.1, 4.1.2, 4.2.1, 4.2.2, 4.3.1, 4.3.2, 4.3.3, 4.3.4, 4.3.5, 4.3.6, 4.4.1, 4.4.2, 4.4.3, 4.5.1) |
| Violations — critical | 4 |
| Violations — major | 3 |
| Violations — minor | 3 |
| Gaps | 12 |
| Weak tests | 7 |
| Legacy references | 0 |
| Verdict | has-violations |

---

## Violations

### V-001 — Critical: "For now" comment justifying semantically incorrect `isPresent` implementation

- **File**: `src/hgs/builtins.ts`, lines 250–254
- **Rule violated**: rules.md — "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned." Also: "Never mark work as deferred, TODO, or 'not implemented.'" The phrase "For now" is on the explicit red-flag list in reviewer.md.
- **Quoted evidence**:
  ```typescript
  // (The HGS semantics require lazy evaluation, but our evaluator evaluates
  // args eagerly. For now return true if the value is non-null.)
  return _args.length > 0 && _args[0] !== null;
  ```
- **Severity**: critical

The comment explicitly states the implementation does not match HGS semantics and defers fixing it. The phrase "For now" is a banned pattern that signals intentional rule-breaking. The implementation is also semantically incorrect: `isPresent(undeclaredVar)` must return `false` in correct HGS; this implementation causes an evaluation error before the function is called, making `isPresent` non-functional for its primary use case.

---

### V-002 — Critical: `src/io/data-field.ts` absent — spec-required file never created

- **File**: not present
- **Rule violated**: rules.md — "Never mark work as deferred, TODO, or 'not implemented.'"
- **Quoted evidence**: Task 4.3.5 specifies:
  ```
  src/io/data-field.ts:
    DataField class: { data: bigint[]; getWord(addr): bigint; setWord(addr, val): void; size(): number; trim(): DataField }
    parseDataFieldString(s: string): DataField
    serializeDataField(df: DataField): string
  ```
  File confirmed absent via glob. `builtins.ts` line 316 contains `await import("../io/hex-import")` which itself requires `DataField`. The module does not exist; any call to `loadHex()` at runtime will throw a module-not-found error.
- **Severity**: critical

---

### V-003 — Critical: `src/io/hex-import.ts` absent — spec-required file never created

- **File**: not present
- **Rule violated**: rules.md — completeness rule
- **Quoted evidence**: Task 4.3.5 specifies:
  ```
  src/io/hex-import.ts:
    importHex(data: Uint8Array, dataBits: number, bigEndian: boolean): DataField
    parseLogisimHex(text: string): DataField
    parseIntelHex(text: string, dataBits: number, bigEndian: boolean): DataField
    parseBinaryFile(data: Uint8Array, dataBits: number, bigEndian: boolean): DataField
  ```
  File confirmed absent. `builtins.ts` line 316 performs `const { importHex } = await import("../io/hex-import")` — this dynamic import will fail at runtime, breaking the entire `loadHex()` HGS built-in.
- **Severity**: critical

---

### V-004 — Critical: `src/hgs/refs.ts` absent — spec-required file never created

- **File**: not present
- **Rule violated**: rules.md — completeness rule
- **Quoted evidence**: Task 4.3.4 specifies:
  ```
  src/hgs/refs.ts:
    Reference interface: { get(ctx): Promise<HGSValue>; set(ctx, value): Promise<void>; declare(ctx, value): Promise<void> }
    ReferenceToVar class
    ReferenceToArray class (wraps parent Reference + index Expression)
    ReferenceToStruct class (wraps parent Reference + field name)
    ReferenceToFunc class (wraps parent Reference + argument Expressions)
  ```
  File confirmed absent via glob. Task 4.3.4 is entirely unimplemented; no progress.md entry exists for it.
- **Severity**: critical

---

### V-005 — Major: `resolveXStreamReference` renamed to `resolveDigReference` — spec API contract violated

- **File**: `src/io/dig-parser.ts`, line 75
- **Rule violated**: spec adherence — the implementation must export the function name stated in the spec
- **Quoted evidence**: Spec (Task 4.1.2) mandates:
  ```
  resolveXStreamReference(refPath: string, contextElement: Element, rootElement: Element): Element
  ```
  Actual export:
  ```typescript
  export function resolveDigReference(
    refPath: string,
    contextElement: Element,
    _rootElement: Element,   // ← third parameter unused, underscore-prefixed
  ): Element {
  ```
  The `_rootElement` parameter is also deliberately unused (underscore prefix), meaning the spec's third parameter is silently dropped from use.
- **Severity**: major

---

### V-006 — Major: `dom-parser.ts` uses CommonJS `require()` suppressed with ESLint disable comment

- **File**: `src/io/dom-parser.ts`, lines 29–31
- **Rule violated**: rules.md — no ESLint suppression without explicit justification; project uses ESM modules
- **Quoted evidence**:
  ```typescript
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DOMParser } = require("@xmldom/xmldom") as {
    DOMParser: new () => { parseFromString(xml: string, mimeType: string): Document };
  };
  ```
  The ESLint suppression hides the rule violation rather than fixing it. The correct pattern for an ESM project is `await import("@xmldom/xmldom")`.
- **Severity**: major

---

### V-007 — Major: Two incompatible `FileResolver` interfaces exist — structural type conflict

- **Files**: `src/hgs/context.ts` lines 15–17; `src/io/file-resolver.ts` lines 30–34
- **Rule violated**: rules.md — "No fallbacks. No backwards compatibility shims." Duplicate interface definitions with incompatible signatures represent a type-level shim.
- **Quoted evidence**:
  `src/hgs/context.ts`:
  ```typescript
  export interface FileResolver {
    resolve(filename: string, rootPath: string): Promise<Uint8Array>;
  }
  ```
  `src/io/file-resolver.ts`:
  ```typescript
  export interface FileResolver {
    resolve(name: string, relativeTo?: string): Promise<string>;
  }
  ```
  These return incompatible types (`Uint8Array` vs `string`). `builtins.ts` `loadFile` calls `resolver.resolve()` and passes the result to `new TextDecoder().decode(data)` — but IO-layer resolvers return `string`, not `Uint8Array`. `resolve-generics.ts` imports `FileResolver` from `hgs/context.ts` (line 26) but receives resolvers from `io/file-resolver.ts` at call sites, causing type incompatibility.
- **Severity**: major

---

### V-008 — Minor: `isPresent` built-in uses incorrect semantics with no test coverage

- **File**: `src/hgs/builtins.ts`, lines 247–255
- **Rule violated**: rules.md — "Never mark work as deferred." (This is a distinct violation from V-001 which covers the comment; this violation covers the incorrect implementation being accepted as complete.)
- **Quoted evidence**:
  ```typescript
  function builtinIsPresent(): HGSFunction {
    return new HGSFunction(async (_args) => {
      // isPresent evaluates its argument — since args are already evaluated
      // by the time the built-in is called, we just return true if we got here.
      return _args.length > 0 && _args[0] !== null;
    }, "isPresent");
  }
  ```
  There is no test in `evaluator.test.ts` that covers `isPresent`. The function always returns `true` for any non-null argument, regardless of whether evaluation succeeded or failed.
- **Severity**: minor

---

### V-009 — Minor: `src/io/resolve-generics.ts` imports `FileResolver` from wrong module

- **File**: `src/io/resolve-generics.ts`, line 26
- **Rule violated**: Code hygiene — mismatched type import creating silent incompatibility
- **Quoted evidence**:
  ```typescript
  import type { FileResolver } from "../hgs/context.js";
  ```
  `resolve-generics.ts` is an IO module. It receives `FileResolver` instances from IO-layer callers (which implement `src/io/file-resolver.ts`'s interface returning `string`), but it types them as HGS-layer `FileResolver` (returning `Uint8Array`). This is a structural type incompatibility hidden by TypeScript's structural typing: both interfaces have a `resolve` method so the mismatch is only caught at runtime.
- **Severity**: minor

---

### V-010 — Minor: `src/io/generic-cache.ts` duplicates `GenericResolutionCache` already in `resolve-generics.ts`

- **File**: `src/io/generic-cache.ts` (entire file); also `src/io/resolve-generics.ts` lines 78–105
- **Rule violated**: rules.md — "All replaced or edited code is removed entirely. Scorched earth." Two parallel cache implementations for the same purpose exist in the same codebase.
- **Quoted evidence**: `src/io/generic-cache.ts` exports `GenericCache` and `computeGenericCacheKey`. `src/io/resolve-generics.ts` exports `GenericResolutionCache` with a `static keyFor()` method. The `resolve-generics.test.ts` imports from both (`GenericResolutionCache` from `resolve-generics.ts` and `GenericCache`/`computeGenericCacheKey` from `generic-cache.ts`), using them interchangeably.
- **Severity**: minor

---

## Gaps

### G-001 — Task 4.3.1 (HGS Tokenizer): No dedicated test file

- **Spec requirement**: `src/hgs/__tests__/tokenizer.test.ts` with 8 tests: `identifiers`, `numbers`, `strings`, `operators`, `keywords`, `templateDelimiter`, `skipsComments`, `tracksLineNumbers`
- **Found**: File does not exist (confirmed absent via glob). No tokenizer tests exist anywhere.
- **Missing file**: `src/hgs/__tests__/tokenizer.test.ts`

---

### G-002 — Task 4.3.2 (HGS Parser): No dedicated test file

- **Spec requirement**: `src/hgs/__tests__/parser.test.ts` with 12 tests: `declaration`, `assignment`, `binaryExpression`, `ifElse`, `forLoop`, `functionDecl`, `arrayLiteral`, `structLiteral`, `fieldAccess`, `chainedAccess`, `templateMode`, `syntaxErrorReportsLine`
- **Found**: File does not exist (confirmed absent via glob). No parser unit tests exist anywhere.
- **Missing file**: `src/hgs/__tests__/parser.test.ts`

---

### G-003 — Task 4.3.4 (HGS Reference System): Entire task unimplemented

- **Spec requirement**: `src/hgs/refs.ts` (Reference interface + 4 classes) and `src/hgs/__tests__/refs.test.ts` (4 tests)
- **Found**: Neither file exists (both confirmed absent). No progress.md entry for Task 4.3.4. The evaluator implements l-value assignment inline in `assignTarget()` instead, which handles only simple variable, index, and field targets — not the composable `Reference` abstraction the spec defines.
- **Missing files**: `src/hgs/refs.ts`, `src/hgs/__tests__/refs.test.ts`

---

### G-004 — Task 4.3.5 (File I/O): `src/io/data-field.ts` absent

- **Spec requirement**: `DataField` class with `getWord`, `setWord`, `size`, `trim`; `parseDataFieldString`, `serializeDataField`
- **Found**: File absent. No progress.md entry for Task 4.3.5.
- **Missing file**: `src/io/data-field.ts`

---

### G-005 — Task 4.3.5 (File I/O): `src/io/hex-import.ts` absent

- **Spec requirement**: `importHex`, `parseLogisimHex`, `parseIntelHex`, `parseBinaryFile`
- **Found**: File absent.
- **Missing file**: `src/io/hex-import.ts`

---

### G-006 — Task 4.3.5 (File I/O): `src/hgs/file-resolver.ts` not created as specified

- **Spec requirement**: `src/hgs/file-resolver.ts` with `FileResolver` interface, `NodeFileResolver` (using `fs.readFile()`), `BrowserFileResolver` (with `addFile(name: string, data: Uint8Array)` for pre-loading)
- **Found**: This specific file does not exist. Instead a `FileResolver` interface was added to `src/hgs/context.ts` and a separate incompatible `FileResolver` was created in `src/io/file-resolver.ts`. The `BrowserFileResolver` with `addFile()` was never created.
- **Missing file**: `src/hgs/file-resolver.ts`

---

### G-007 — Task 4.3.5 (File I/O): Test files for data-field, hex-import absent; HGS file-resolver test covers wrong API

- **Spec requirement**: `src/io/__tests__/data-field.test.ts` (4 tests), `src/io/__tests__/hex-import.test.ts` (7 tests), `src/hgs/__tests__/file-resolver.test.ts` with `BrowserFileResolver::findsPreloadedFile` and `BrowserFileResolver::throwsOnMissing`
- **Found**: `data-field.test.ts` absent, `hex-import.test.ts` absent. `src/io/__tests__/file-resolver.test.ts` exists but tests the IO-layer resolver classes, not the HGS-layer `BrowserFileResolver`/`NodeFileResolver` that the spec requires.
- **Missing files**: `src/io/__tests__/data-field.test.ts`, `src/io/__tests__/hex-import.test.ts`

---

### G-008 — Task 4.3.6 (HGS Parity Test Suite): `src/hgs/__tests__/hgs-parity.test.ts` absent

- **Spec requirement**: Parity tests ported from `ParserTest.java` covering variables, controlFlow, functions, closures, recursion, arrays, maps, templateMode, builtins, errorCases
- **Found**: File does not exist (confirmed absent via glob). No progress.md entry for Task 4.3.6.
- **Missing file**: `src/hgs/__tests__/hgs-parity.test.ts`

---

### G-009 — Task 4.1.2: exported function name does not match spec (`resolveDigReference` vs `resolveXStreamReference`)

- **Spec requirement**: `resolveXStreamReference(refPath: string, contextElement: Element, rootElement: Element): Element`
- **Found**: `export function resolveDigReference(refPath, contextElement, _rootElement)` — name differs; third parameter unused
- **File**: `src/io/dig-parser.ts`, line 75

---

### G-010 — Task 4.2.2 absent from progress.md despite implementation existing

- **Spec requirement**: Task 4.2.2 entries in `spec/progress.md` per implementation tracking rules
- **Found**: `src/io/dig-loader.ts` and `src/io/__tests__/dig-loader.test.ts` exist and are substantially implemented, but Task 4.2.2 has no entry in `spec/progress.md`. This means no file list, no test count, and no verification record exist for this task.
- **File**: `spec/progress.md` — Task 4.2.2 entry missing

---

### G-011 — Tasks 4.3.1–4.3.6 and 4.5.1 absent from progress.md

- **Spec requirement**: All completed tasks must be recorded in progress.md with file lists, test counts, and verification
- **Found**: Progress.md contains Phase 4 entries only for 4.1.1, 4.1.2, 4.2.1, 4.4.1, 4.4.2, 4.4.3. Tasks 4.2.2, 4.3.1, 4.3.2, 4.3.3, 4.3.4, 4.3.5, 4.3.6, 4.5.1 have no entries despite files existing for 4.2.2, 4.3.1 (tokenizer.ts), 4.3.2 (parser.ts, ast.ts), 4.3.3 (evaluator.ts, context.ts, value.ts, builtins.ts, parser-error.ts), and 4.5.1 (resolve-generics.ts).
- **File**: `spec/progress.md`

---

### G-012 — Task 4.5.1: `dig-loader.ts` not modified to call `resolveGenericCircuit`

- **Spec requirement**: Task 4.5.1 — "Files to modify: `src/io/dig-loader.ts` — after loading a circuit, check if it's generic. If so, resolve it."
- **Found**: `src/io/dig-loader.ts` contains no call to `isGenericCircuit` or `resolveGenericCircuit`. Functions `loadDigCircuit`, `loadDig`, and `loadDigFromParsed` all return circuits without performing generic resolution. The `isGenericCircuit` and `resolveGenericCircuit` functions in `resolve-generics.ts` are never invoked from the loader.
- **File**: `src/io/dig-loader.ts` — specified modification absent

---

## Weak Tests

### W-001 — `dig-parser.test.ts::DigParser::parsesAndGateCircuit` — bare `not.toBeUndefined()` guards without structural content check

- **Test path**: `src/io/__tests__/dig-parser.test.ts::DigParser::parsesAndGateCircuit`
- **What is wrong**: `expect(andEl).not.toBeUndefined()` and `expect(inA).not.toBeUndefined()` are used as existence guards. If either is undefined the following `!.` dereference throws a `TypeError` rather than producing a legible assertion failure. The `not.toBeUndefined()` assertion itself is satisfied by any value including wrong-typed objects.
- **Quoted evidence**:
  ```typescript
  expect(andEl).not.toBeUndefined();
  const wideShapeEntry = andEl!.elementAttributes.find((e) => e.key === "wideShape");
  expect(wideShapeEntry).not.toBeUndefined();
  ```

---

### W-002 — `resolve-generics.test.ts::Generic::resolvesInitCode` — test asserts only `toBeInstanceOf(Circuit)`

- **Test path**: `src/io/__tests__/resolve-generics.test.ts::Generic::resolvesInitCode`
- **What is wrong**: The test for "resolvesInitCode" — whose stated purpose is verifying that `inputs := 8` is declared by the init code — does not verify that declaration. The test comment explicitly says "we just confirm resolution completes without error". `toBeInstanceOf(Circuit)` is trivially true for any successful return.
- **Quoted evidence**:
  ```typescript
  // Here we just confirm resolution completes without error
  expect(resolved).toBeInstanceOf(Circuit);
  ```

---

### W-003 — `resolve-generics.test.ts::Generic::cachesResults` — cache integration not tested

- **Test path**: `src/io/__tests__/resolve-generics.test.ts::Generic::cachesResults`
- **What is wrong**: The test manually calls `cache.set()` and `cache.get()` on a `GenericResolutionCache` instance without passing the cache to `resolveGenericCircuit`. The spec acceptance criterion requires "second call returns cached result (same reference)" — this test only verifies the cache's own get/set operation, not that the resolver consults it.
- **Quoted evidence**:
  ```typescript
  const resolved1 = await resolveGenericCircuit(circuit, args, registry);
  cache.set(argsKey, resolved1);
  const cached = cache.get(argsKey);
  expect(cached).toBe(resolved1);
  ```

---

### W-004 — `dig-loader.test.ts::DigLoader::facadeIntegration` — `toBeDefined()` on value that cannot be undefined

- **Test path**: `src/io/__tests__/dig-loader.test.ts::DigLoader::facadeIntegration`
- **What is wrong**: `expect(circuit).toBeDefined()` is trivially true — `loadDig` either returns a `Circuit` or throws. There is no code path returning `undefined`. The assertion adds no diagnostic value.
- **Quoted evidence**:
  ```typescript
  expect(circuit).toBeDefined();
  expect(circuit.elements).toHaveLength(5);
  ```

---

### W-005 — `dig-parser.test.ts::DigParser::domParserNodeJs` — `not.toBeNull()` on non-nullable return type

- **Test path**: `src/io/__tests__/dig-parser.test.ts::DigParser::domParserNodeJs`
- **What is wrong**: `expect(doc).not.toBeNull()` asserts something the type system already guarantees — `parse()` returns `Document`, not `Document | null`. Similarly `expect(childEl).not.toBeNull()` is vacuous since the test only reaches that line if `childEl` was set in the preceding loop.
- **Quoted evidence**:
  ```typescript
  expect(doc).not.toBeNull();
  // ...
  expect(childEl).not.toBeNull();
  ```

---

### W-006 — `resolve-generics.test.ts` — repeated `toBeDefined()` pattern before content assertions

- **Test path**: Multiple tests in `src/io/__tests__/resolve-generics.test.ts`
- **What is wrong**: Pattern `expect(andEl).toBeDefined(); ... andEl!.getProperties()...` repeated at lines 242, 309, 404, 540. The `toBeDefined()` check is not a useful assertion here: if `andEl` is `undefined`, the subsequent `!.` dereference throws `TypeError` rather than producing an assertion failure with a helpful message.
- **Quoted evidence** (representative):
  ```typescript
  const andEl = resolved.elements.find((e) => e.typeId === "And");
  expect(andEl).toBeDefined();
  const inputCount = andEl!.getProperties().getOrDefault<number>("inputCount", 2);
  expect(inputCount).toBe(8);
  ```

---

### W-007 — `dig-loader.test.ts::DigLoader::loadsAndGate` — `not.toBeUndefined()` before unsafe `!.` dereferences

- **Test path**: `src/io/__tests__/dig-loader.test.ts::DigLoader::loadsAndGate`
- **What is wrong**: `expect(labelA).not.toBeUndefined()` and `expect(labelB).not.toBeUndefined()` are guards that do not protect the subsequent `!.` dereferences. On failure the test throws `TypeError` instead of reporting a clean assertion message.
- **Quoted evidence**:
  ```typescript
  expect(labelA).not.toBeUndefined();
  // labelA used later with ! assertion operator
  expect(labelB).not.toBeUndefined();
  ```

---

## Legacy References

None found.

---

## Scope-Creep Files (for orchestrator awareness only)

The following files exist in `src/io/` that are not specified anywhere in Phase 4. They appear to have been created by a concurrent agent working on later phases. They are noted here as out-of-scope but not individually counted as violations since phase parallelism may justify their existence:

- `src/io/digb-schema.ts`, `src/io/digb-serializer.ts`, `src/io/digb-deserializer.ts`, `src/io/__tests__/digb-schema.test.ts`
- `src/io/subcircuit-loader.ts`, `src/io/__tests__/subcircuit-loader.test.ts`
- `src/io/postmessage-adapter.ts`, `src/io/__tests__/postmessage-adapter.test.ts`
- `src/io/file-resolver.ts` and `src/io/generic-cache.ts` — substantially different from what Task 4.3.5 specifies, designed for a different architectural purpose (subcircuit resolution rather than HGS file I/O)
