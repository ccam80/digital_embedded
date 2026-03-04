# Review Report: Phase 1 — Foundation & Type System (all 3 waves)

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 10 |
| Violations — critical | 2 |
| Violations — major | 5 |
| Violations — minor | 3 |
| Gaps | 2 |
| Weak tests | 11 |
| Legacy references | 0 |

**Verdict**: has-violations

---

## Violations

### V-01 — Critical — Duplicate `CircuitElement` interface definition

**File**: `src/core/circuit.ts` lines 41–77
**Also**: `src/core/element.ts` lines 55–146
**Rule violated**: Architectural consistency (spec/author_instructions.md priority 1); single-definition principle; creates two incompatible types with the same name in the codebase.

`CircuitElement` is defined twice — once in `src/core/element.ts` (the canonical file for task 1.3.1) and again in `src/core/circuit.ts` (task 1.3.4). These are two separate TypeScript interface declarations with the same name but living in different modules. The `registry.ts` and both test files `circuit.test.ts` and `registry.test.ts` import `CircuitElement` from `circuit.ts`, not from `element.ts`. The `element.ts` file additionally exports `AbstractCircuitElement` which implements its own `CircuitElement`. This means there are two independent structural types that happen to be identical today but will drift.

```typescript
// src/core/circuit.ts line 41
export interface CircuitElement {
  // ...
}

// src/core/element.ts line 55
export interface CircuitElement {
  // ...
}
```

The spec specifies a single file per task. Task 1.3.1 creates `src/core/element.ts`. Task 1.3.4 creates `src/core/circuit.ts` and `src/core/registry.ts`. The `CircuitElement` interface belongs exclusively in `element.ts` (task 1.3.1). `circuit.ts` should import it from there, not re-declare it.

Additionally, `SerializedElement` is also declared in both files:
- `src/core/element.ts` line 33: `export interface SerializedElement` — `properties: Record<string, number | string | boolean | number[]>` (bigint excluded)
- `src/core/circuit.ts` line 23: `export interface SerializedElement` — `properties: Record<string, PropertyValue>` (bigint included)

These are structurally different. The `AbstractCircuitElement.serialize()` implementation silently drops bigint values from properties (with a comment explaining why), yet the `circuit.ts` `SerializedElement` claims bigint is acceptable. This is an inconsistency introduced by having two declarations.

**Severity**: critical

---

### V-02 — Critical — `AbstractCircuitElement.serialize()` silently drops bigint properties with a justification comment

**File**: `src/core/element.ts` lines 199–215
**Rule violated**: Rules.md: "No historical-provenance comments." The comment explicitly documents a deliberate omission and justifies it. Rules.md: "Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour."

```typescript
serialize(): SerializedElement {
  const properties: Record<string, number | string | boolean | number[]> = {};
  for (const [k, v] of this._properties.entries()) {
    // bigint is not JSON-safe; skip it here — callers that need bigint
    // serialization must use propertyBagToJson() from properties.ts directly.
    if (typeof v !== "bigint") {
      properties[k] = v;
    }
  }
```

The comment "bigint is not JSON-safe; skip it here — callers that need bigint serialization must use propertyBagToJson() from properties.ts directly" is a justification comment explaining a known limitation. It describes what the code intentionally omits and instructs callers to use a different path. This is exactly the pattern banned by the rules. The implementation should either fully handle bigint via `propertyBagToJson()` internally, or the spec's `SerializedElement` should exclude bigint from its properties field altogether — not silently drop it at runtime with an explanatory comment.

**Severity**: critical

---

### V-03 — Major — `PinDirection` uses runtime enum instead of `const enum`

**File**: `src/core/pin.ts` lines 12–16
**Rule violated**: `spec/author_instructions.md` TS idiom guide: "Enum with methods/fields → `const enum` for values, lookup Map or plain functions for behavior."

```typescript
export enum PinDirection {
  INPUT = "INPUT",
  OUTPUT = "OUTPUT",
  BIDIRECTIONAL = "BIDIRECTIONAL",
}
```

The idiom guide explicitly states enums should be `const enum` for values. `PinDirection` is a pure-value enum with no methods or fields. Using a runtime enum generates extra JS objects and is contrary to the stated idiom. This pattern appears throughout: `PropertyType` in `properties.ts` lines 7–19 and `ComponentCategory` in `registry.ts` lines 17–30 also use runtime `enum` rather than `const enum`.

**Severity**: major

---

### V-04 — Major — `PropertyType` uses runtime enum instead of `const enum`

**File**: `src/core/properties.ts` lines 7–19
**Rule violated**: `spec/author_instructions.md` TS idiom guide: "Enum with methods/fields → `const enum` for values."

```typescript
export enum PropertyType {
  INT = 'INT',
  STRING = 'STRING',
  ...
}
```

Same violation as V-03. `PropertyType` is a pure-value enum with no behaviour. Should be `const enum PropertyType`.

**Note**: `const enum` with string values and `z.nativeEnum()` (used in `PropertyDefinitionSchema`) are compatible — `z.nativeEnum()` works with runtime enum objects, not const enums. This would require changing the Zod validation approach (e.g. `z.enum([...])` with explicit values). This is a design consequence that the implementer should have flagged to the orchestrator rather than choosing the Java-idiomatic runtime enum. The rules say to flag conflicts, not resolve them by choosing the easier path.

**Severity**: major

---

### V-05 — Major — `ComponentCategory` uses runtime enum instead of `const enum`

**File**: `src/core/registry.ts` lines 17–30
**Rule violated**: `spec/author_instructions.md` TS idiom guide: "Enum with methods/fields → `const enum` for values."

```typescript
export enum ComponentCategory {
  LOGIC = "LOGIC",
  IO = "IO",
  ...
}
```

Same violation as V-03 and V-04.

**Severity**: major

---

### V-06 — Major — `EngineState` uses string union instead of the `enum` the spec requires, but the spec also says to use `const enum` — implementation chose a third option

**File**: `src/core/engine-interface.ts` line 42
**Rule**: Spec task 1.3.2 states: "**`EngineState` enum**: `STOPPED`, `RUNNING`, `PAUSED`, `ERROR`". The idiom guide says use `const enum`.

```typescript
export type EngineState = "STOPPED" | "RUNNING" | "PAUSED" | "ERROR";
```

The implementation chose a string union type rather than an enum (runtime or const). While this is arguably more TypeScript-idiomatic for pure-value discriminants, it directly contradicts the spec which says "`EngineState` enum". The idiom guide says convert Java enums to `const enum`. The implementation did neither — it chose a string union, which is a different design. The implementer should have followed the spec or flagged the discrepancy to the orchestrator rather than silently taking a third approach.

**Severity**: major

---

### V-07 — Major — `Rotation` defined in `pin.ts` but re-exported from `element.ts` and `circuit.ts` as a re-export shim

**File**: `src/core/element.ts` lines 16, 21
**Also**: `src/core/circuit.ts` line 214
**Rule violated**: Rules.md: "No fallbacks. No backwards compatibility shims." and "All replaced or edited code is removed entirely."

```typescript
// element.ts line 16-17
import type { Pin } from "./pin.js";
import type { Rotation } from "./pin.js";
// element.ts line 20-21
export type { Point, Rect, RenderContext };
export type { Pin, Rotation };
```

```typescript
// circuit.ts line 214
export type { Pin, PinDeclaration, Rotation };
```

Both `element.ts` and `circuit.ts` re-export `Rotation`, `Pin`, and other types that were defined in `pin.ts` and `renderer-interface.ts`. These are re-export aliases. The rule prohibits backwards-compatibility shims and re-exports. Consumers should import `Rotation` from `pin.ts` directly. The re-exports create an implicit shim layer — if `Rotation` ever moves or changes in `pin.ts`, the re-exports mask the breakage.

The same pattern applies to `Point`, `Rect`, `RenderContext`, `PropertyBag`, `PropertyValue` being re-exported from `element.ts`:
```typescript
// element.ts lines 19-21
export type { Point, Rect, RenderContext };
export type { Pin, Rotation };
export type { PropertyBag, PropertyValue };
```

**Severity**: major

---

### V-08 — Minor — `isClock` on `Pin` is set unconditionally from `isClockCapable` without accounting for actual clock designation

**File**: `src/core/pin.ts` lines 64–78
**Rule**: Spec task 1.2.2 spec for `Pin.isClock` states "draw clock triangle" — this is a per-instance flag. The `PinDeclaration` has `isClockCapable`. The `makePin` function sets `isClock: decl.isClockCapable`, which means every clock-capable pin is always drawn with a clock triangle regardless of whether the component has designated it as a clock pin.

```typescript
export function makePin(
  decl: PinDeclaration,
  position: Point,
  inverterConfig: InverterConfig,
  bitWidth?: number,
): Pin {
  return {
    ...
    isClock: decl.isClockCapable,   // always true if capable — ignores per-instance designation
  };
}
```

This conflates capability with state. `isNegated` correctly consults an `InverterConfig` to determine the per-instance state, but `isClock` just copies `isClockCapable`. A component could have a clock-capable pin that is not currently designated as a clock (e.g. a flip-flop used in level-sensitive mode). This is an incomplete implementation of the pin model.

**Severity**: minor

---

### V-09 — Minor — `isAllUndefined` function is a permanent stub that always returns `false`

**File**: `src/core/signal.ts` lines 495–500
**Rule violated**: Rules.md: "Never mark work as deferred, TODO, or 'not implemented.'" The function is named `isAllUndefined` but always returns `false`. The comment explains why:

```typescript
function isAllUndefined(_rawValue: number, _rawHighZ: number, _width: number): boolean {
  // In the flat representation, UNDEFINED and HIGH_Z are identical.
  // The engine sets isUndefined=false when writing HIGH_Z, true when writing UNDEFINED.
  // When reading back via fromRaw we cannot recover the distinction, so we default to false.
  return false;
}
```

This is a permanently non-functional function with a comment explaining its own incompleteness. The design decision (UNDEFINED cannot be round-tripped through the flat representation) is defensible, but the implementation should either: remove the function (since it does nothing useful) and inline `false` at the call site in `fromRaw`, or redesign the flat representation to carry the UNDEFINED/HIGH_Z distinction. Instead, it creates a named function that misleads readers into thinking it performs a real check.

The comment at the top of `signal.ts` also documents this limitation:
> "The distinction between 'all HIGH_Z' and 'UNDEFINED' is carried only in BitVector.isUndefined. In the flat representation they are identical."

This documents a known design gap in the interface contract. The spec requires UNDEFINED tracking in the flat representation path.

**Severity**: minor

---

### V-10 — Minor — Justification comment in `engine-interface.ts` describes what the code replaced

**File**: `src/core/engine-interface.ts` lines 63–65
**Rule violated**: Rules.md: "No historical-provenance comments."

```typescript
 * The Worker-mode engine implementation receives these via `onmessage` and
 * dispatches to the appropriate method. The main-thread fallback engine
 * ignores this type entirely — callers invoke methods directly.
```

The phrase "The main-thread fallback engine ignores this type entirely" is a historical/contextual description of behaviour in a different execution mode. Combined with "fallback" (a flagged word per rules.md), this is a comment that describes architectural context rather than explaining complicated code. It tells the reader what the code replaced or what an alternative path does, not what this code does.

**Severity**: minor

---

## Gaps

### G-01 — Task 1.1.1: `@vite-plugin-basic-ssl` or COOP/COEP documentation missing from build output

**Spec requirement**: Task 1.1.1 item 3 states: "Configure for `SharedArrayBuffer` support (COOP/COEP headers in dev server)."

**What was found**: `vite.config.ts` correctly adds COOP/COEP headers to the dev server:
```typescript
server: {
  headers: {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  },
},
```
However, the spec's requirement that production builds also work with SharedArrayBuffer is not addressed. The `build` section has no corresponding header configuration. In static file hosting (the stated deployment model — "purely static files, no server"), the headers must be set by the host server, not Vite. This is a known gap in the implementation: production hosting requires documentation or a service-worker-based approach (e.g. `coi-serviceworker`). The implementation addresses dev-server mode only.

**File**: `vite.config.ts`

---

### G-02 — Task 1.3.4: `Circuit.elements` and `Circuit.wires` are mutable public arrays, not encapsulated

**Spec requirement**: Task 1.3.4 defines `Circuit` with `addElement`, `removeElement`, `addWire`, `removeWire` methods — implying controlled mutation. The spec shows:
```typescript
class Circuit {
  elements: CircuitElement[];
  wires: Wire[];
```

**What was found**: The implementation exposes `elements` and `wires` as `readonly` arrays in the type declaration (`readonly elements: CircuitElement[] = []`) but they are not truly immutable — callers can call `.push()`, `.splice()`, etc. on them directly, bypassing `addElement`/`removeElement`. The `readonly` keyword only prevents reassignment of the array reference, not mutation of its contents. The tests only exercise the `addElement`/`removeElement` path and do not catch direct mutation:

```typescript
// circuit.ts line 167-168
readonly elements: CircuitElement[] = [];
readonly wires: Wire[] = [];
```

The spec's intent is to provide controlled mutation via the four named methods. The current implementation allows bypassing those methods entirely. This is not a critical gap (the spec does show `elements: CircuitElement[]` as the field type), but the access control is incomplete relative to the stated intent.

**File**: `src/core/circuit.ts`

---

## Weak Tests

### WT-01 — `engine-interface.test.ts::SimulationEngine interface compliance::MockEngine satisfies SimulationEngine at the type level`

**File**: `src/core/__tests__/engine-interface.test.ts` line 43–45
**Problem**: Trivially true. The test asserts `toBeDefined()` on a freshly constructed `MockEngine`. This tests nothing about interface compliance — it only verifies the constructor does not throw.

```typescript
it("MockEngine satisfies SimulationEngine at the type level", () => {
  const engine: SimulationEngine = new MockEngine();
  expect(engine).toBeDefined();
});
```

The actual interface compliance is enforced at compile time by the TypeScript assignment `const engine: SimulationEngine = new MockEngine()`. At runtime, `toBeDefined()` on any constructed object is trivially true. This test would pass even if `MockEngine` were completely empty.

---

### WT-02 — `engine-interface.test.ts::SimulationEngine interface compliance::all required methods exist on MockEngine`

**File**: `src/core/__tests__/engine-interface.test.ts` lines 47–63
**Problem**: Checking `typeof method === "function"` is an implementation-detail assertion, not a behaviour assertion. This test verifies that methods exist by name, not that they behave correctly. It would pass even if every method were `() => undefined`. The real interface compliance is verified by TypeScript at compile time. These runtime checks add no value beyond what the type system already guarantees.

```typescript
expect(typeof engine.init).toBe("function");
expect(typeof engine.reset).toBe("function");
// ... (12 more)
```

---

### WT-03 — `engine-interface.test.ts::EngineState::has all four required values`

**File**: `src/core/__tests__/engine-interface.test.ts` lines 71–78
**Problem**: The test constructs its own array of strings and then asserts `toContain` on that same array. It does not verify anything about the exported `EngineState` type. Since `EngineState` is a string union type, there is no runtime object to inspect. The test is tautologically checking that an array it just built contains what it just put in.

```typescript
it("has all four required values", () => {
  const states: EngineState[] = ["STOPPED", "RUNNING", "PAUSED", "ERROR"];
  expect(states).toHaveLength(4);
  expect(states).toContain("STOPPED");
  // ...
});
```

This test cannot fail unless there is a TypeScript compile error (which would be caught by `tsc --noEmit`, not by this test). The assertions are trivially true.

---

### WT-04 — `engine-interface.test.ts::EngineMessage discriminated union` (all 8 tests)

**File**: `src/core/__tests__/engine-interface.test.ts` lines 85–141
**Problem**: Every test in this describe block constructs an `EngineMessage` literal and then asserts on the literal's own property. For example:

```typescript
it("covers step command", () => {
  const msg: EngineMessage = { type: "step" };
  expect(msg.type).toBe("step");
});
```

These are trivially true — `msg.type` will always be `"step"` because it was set to `"step"` one line above. TypeScript type-checks the assignment at compile time. The runtime `expect` adds nothing. Eight tests in this describe block share this same weakness.

---

### WT-05 — `engine-interface.test.ts::EngineResponse discriminated union` (tests 1–3)

**File**: `src/core/__tests__/engine-interface.test.ts` lines 147–168
**Problem**: Same pattern as WT-04. Each test constructs a response literal and then reads back its own properties.

```typescript
it("covers stateChange response", () => {
  const resp: EngineResponse = { type: "stateChange", state: "RUNNING" };
  expect(resp.type).toBe("stateChange");
  if (resp.type === "stateChange") {
    expect(resp.state).toBe("RUNNING");
  }
});
```

Trivially true. All three tests in this describe block share the same weakness.

---

### WT-06 — `engine-interface.test.ts::MockEngine lifecycle::dispose clears circuit reference and listeners`

**File**: `src/core/__tests__/engine-interface.test.ts` line 225
**Problem**: `expect(engine.circuit).toBeNull()` is a weak assertion. It asserts that a private-implementation detail (`circuit` getter returns `null` after dispose) rather than testing observable behaviour. After `dispose()`, the observable behaviour is that signal access and state transitions no longer work correctly. A more meaningful test would attempt `engine.getSignalRaw(0)` or `engine.start()` and assert on the result.

```typescript
expect(engine.circuit).toBeNull();
```

---

### WT-07 — `engine-interface.test.ts::MockEngine signal access::getSignalValue returns a BitVector for the stored value` (and similar)

**File**: `src/core/__tests__/engine-interface.test.ts` lines 259, 265
**Problem**: Two tests use `toBeInstanceOf(BitVector)` as the primary assertion without checking the value.

```typescript
const bv = engine.getSignalValue(3);
expect(bv).toBeInstanceOf(BitVector);
expect(bv.toNumber()).toBe(255);
```

The `toBeInstanceOf` assertion is redundant given that `bv.toNumber()` being callable on the next line already implies `bv` is a `BitVector`. More critically, the second test at line 263–266 uses `toBeInstanceOf(BitVector)` and only then checks `.toNumber() === 0` — the content check is present, but the `toBeInstanceOf` is still a weaker-than-necessary assertion that pads the test count.

---

### WT-08 — `registry.test.ts::register and get::registers a definition and retrieves it by name`

**File**: `src/core/__tests__/registry.test.ts` lines 102–108
**Problem**: Uses `toBeDefined()` as first assertion after retrieving a definition, then only checks `result!.name`.

```typescript
const result = registry.get("And");
expect(result).toBeDefined();
expect(result!.name).toBe("And");
```

`toBeDefined()` is weak — it only confirms the return is not `undefined`. The `result!.name` check on the next line would throw if `result` were undefined, making the `toBeDefined()` redundant and the two assertions effectively the same test. A stronger single assertion would be `expect(result?.name).toBe("And")`.

---

### WT-09 — `registry.test.ts::register and get::registers multiple definitions with distinct names`

**File**: `src/core/__tests__/registry.test.ts` lines 117–122
**Problem**: Both assertions use `toBeDefined()` only. The test confirms the registry returns something for "And" and "Or" but does not verify the content of the returned definitions.

```typescript
registry.register(makeDefinition("And"));
registry.register(makeDefinition("Or"));
expect(registry.get("And")).toBeDefined();
expect(registry.get("Or")).toBeDefined();
```

This does not check that the returned definitions have the correct names, typeIds, or any other property.

---

### WT-10 — `element.test.ts::getHelpText returns a non-empty string`

**File**: `src/core/__tests__/element.test.ts` lines 232–235
**Problem**: `toBeGreaterThan(0)` on `text.length` is a weak assertion. It only verifies the string is non-empty, not that it is the expected text.

```typescript
it("getHelpText returns a non-empty string", () => {
  const text = el.getHelpText();
  expect(typeof text).toBe("string");
  expect(text.length).toBeGreaterThan(0);
});
```

The concrete implementation returns `"A test component."`. The test should assert that exact value, not just that some non-empty string was returned.

---

### WT-11 — `signal.test.ts::arithmetic ops with HIGH_Z produce UNDEFINED` — contains dead assertion

**File**: `src/core/__tests__/signal.test.ts` lines 339–352
**Problem**: Line 348–349 contains a meaningless `expect` that does not assert anything:

```typescript
expect(a.shiftLeft.bind(a)(1));
```

This line calls `expect()` but provides no matcher (no `.toBe()`, `.toEqual()`, etc.). It will always pass regardless of what `shiftLeft` returns. This is a test assertion that does nothing — it is neither a weak assertion nor a passing assertion, it is a non-assertion that should not be there.

---

## Legacy References

None found.

---

## Notes for Orchestrator

The most structurally significant issue is V-01: the dual declaration of `CircuitElement` across `element.ts` and `circuit.ts`. This must be resolved before Phases 2–5 can safely import and extend `CircuitElement`. The canonical definition must be established in `element.ts` and `circuit.ts` must import from there.

V-02 (`AbstractCircuitElement.serialize()` silently dropping bigint with a justification comment) is both a rule violation and a functional gap: bigint `PropertyValue` entries are silently lost through the JSON serialization path on `AbstractCircuitElement`. The `propertyBagToJson` function in `properties.ts` handles bigint correctly; `serialize()` should use it.

The three runtime enum violations (V-03, V-04, V-05) are consistent across the codebase and reflect a systematic pattern choice, not isolated mistakes. All should be resolved together.

The weak tests (WT-01 through WT-11) do not block downstream work but reduce the diagnostic value of the test suite. In particular, WT-04 and WT-05 (EngineMessage/EngineResponse tautological tests) and WT-11 (dead assertion in signal tests) should be corrected.
