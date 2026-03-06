# Review Report: Phase 6 Part 1 (Waves 6.1 & 6.2)

## Summary

| Item | Value |
|------|-------|
| Tasks reviewed | 6 (6.1.1, 6.1.2, 6.2.1, 6.2.2, 6.2.3, 6.2.4) |
| Violations | 3 |
| Gaps | 4 |
| Weak tests | 4 |
| Legacy references | 1 |
| Verdict | **has-violations** |

---

## Violations

### V1 — Historical-provenance comment (critical)

**File**: `src/io/subcircuit-loader.ts`, lines 45–48

**Rule violated**: rules.md — "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned."

**Quoted evidence**:
```
 * This serves as the element type for dynamically registered subcircuits
 * until the full SubcircuitElement from task 6.2.1 is available. The
 * subcircuit definition (the loaded Circuit) is stored as a property so
 * the flattener (6.2.3) and renderer (6.2.1) can retrieve it.
```

**Severity**: critical

The comment is a phased-delivery provenance note: it describes `SubcircuitHolderElement` as a temporary stand-in that exists only "until the full SubcircuitElement from task 6.2.1 is available." This is exactly the pattern the rules ban. The class `SubcircuitHolderElement` either belongs in the final design or it does not. If it is needed, document what it is; if it is a stepping stone, it should not exist. The comment is proof the implementer knowingly introduced a phased-delivery artefact with a justification comment.

---

### V2 — Spec API signature mismatch on `EditorBinding.bind()` (major)

**File**: `src/integration/editor-binding.ts`, lines 31–34

**Rule violated**: Phase-6 spec adherence — the spec defines `bind()` as:
```typescript
bind(circuit: Circuit, engine: SimulationEngine, wireNetMap: Map<Wire, number>, pinNetMap: Map<string, number>): void;
```

**Quoted evidence** (actual implementation):
```typescript
bind(
  engine: SimulationEngine,
  wireNetMap: Map<Wire, number>,
  pinNetMap: Map<string, number>,
): void;
```

**Severity**: major

The `circuit: Circuit` parameter specified in the spec is missing from the `bind()` signature (both the interface and the implementation). The spec explicitly includes it as the first parameter: `bind(circuit: Circuit, engine: SimulationEngine, ...)`. The tests also omit the `circuit` argument and pass only `(engine, wireNetMap, pinNetMap)`, so the tests are written to match the broken signature rather than the spec.

---

### V3 — `SubcircuitHolderElement` registered with wrong `ComponentCategory` (minor)

**File**: `src/io/subcircuit-loader.ts`, line 264

**Rule violated**: Phase-6 spec, task 6.2.1 — "category: ComponentCategory.SUBCIRCUIT"

**Quoted evidence**:
```typescript
const def: ComponentDefinition = {
  name,
  typeId: -1,
  factory: (props: PropertyBag) =>
    new SubcircuitHolderElement(name, definition, props),
  executeFn: () => {
    // Subcircuits are flattened before simulation — no-op execute
  },
  pinLayout: [],
  propertyDefs: [],
  attributeMap: [],
  category: ComponentCategory.MISC,   // ← MISC, not SUBCIRCUIT
  helpText: `Subcircuit: ${name}`,
};
```

**Severity**: minor

The spec states dynamically registered subcircuits must use `category: ComponentCategory.SUBCIRCUIT`. The `registerSubcircuitDefinition()` helper in `subcircuit-loader.ts` registers using `ComponentCategory.MISC`. The `registerSubcircuit()` function in `subcircuit.ts` (task 6.2.1) correctly uses `ComponentCategory.SUBCIRCUIT`, but the two paths are inconsistent. Circuits loaded via `loadWithSubcircuits()` will have their subcircuits categorised as MISC, not SUBCIRCUIT.

---

## Gaps

### G1 — Task 6.1.1: `facadeIntegration` test bypasses facade; tests `CircuitBuilder` directly

**Spec requirement** (task 6.1.1):
> `src/io/__tests__/dig-loader.test.ts::facadeIntegration` — `facade.loadDig(xmlString)` returns a valid `Circuit`

**What was found** (`dig-loader.test.ts`, lines 531–542):
```typescript
it("facadeIntegration", () => {
  const xml = readCircuit("and-gate.dig");
  const registry = buildAndGateRegistry();
  const builder = new CircuitBuilder(registry);
  const circuit = builder.loadDig(xml);
  ...
});
```

The test calls `CircuitBuilder.loadDig()`, not `SimulatorFacade.loadDig()`. The spec explicitly names `facade.loadDig(xmlString)` — the `SimulatorFacade` interface, not the builder. If `SimulatorFacade` and `CircuitBuilder` are separate surfaces (as implied by the spec separating `src/headless/facade.ts` from `src/headless/builder.ts`), the test does not satisfy the acceptance criterion.

**File**: `src/io/__tests__/dig-loader.test.ts`

---

### G2 — Task 6.1.2: `redraw-coordinator.ts` has no tests

**Spec requirement** (task 6.1.2):
> `src/integration/__tests__/editor-binding.test.ts` — five binding tests
> `src/integration/__tests__/speed-control.test.ts` — six speed control tests

The spec lists only two test files. No tests were written for `redraw-coordinator.ts`. The spec acceptance criteria state "All tests pass" with no specific test list for the coordinator, but the coordinator contains non-trivial logic (rAF loop management, state-change dispatch, frame-rate throttling). The absence of any test for this file leaves the rAF loop, `attach()`, `detach()`, and `_frame()` logic completely untested.

**File**: `src/integration/redraw-coordinator.ts` (no corresponding test file)

---

### G3 — Task 6.2.1: `drawDefault` test uses weak structural assertion for pin labels

*(See also Weak Tests section — W2)*

---

### G4 — Task 6.2.4: Spec requires `resolveGeneric(template, args, hgsContext)` signature; implementation has different signature

**Spec requirement** (task 6.2.4):
> Files to create: `src/io/resolve-generics.ts` — `resolveGeneric(template: Circuit, args: PropertyBag, hgsContext: HgsContext): Circuit`

**What was found** (`src/io/resolve-generics.ts`, line 58):
```typescript
export async function resolveGenericCircuit(
  circuit: Circuit,
  args: Map<string, HGSValue>,
  registry: ComponentRegistry,
  fileResolver?: FileResolver,
): Promise<Circuit>
```

The spec names the function `resolveGeneric` and specifies `(template: Circuit, args: PropertyBag, hgsContext: HgsContext): Circuit`. The implementation is named `resolveGenericCircuit`, takes `Map<string, HGSValue>` instead of `PropertyBag`, takes `ComponentRegistry` instead of `HgsContext`, and returns `Promise<Circuit>` (async) rather than `Circuit` (sync). While the async approach is more complete, the exported name and the parameter types do not match the spec, making any caller that follows the spec unable to use the API as written.

Similarly, the spec requires a separate `src/io/generic-cache.ts` — `GenericCache` class only. The implementation also added `GenericResolutionCache` inside `resolve-generics.ts`, which is scope creep not listed in the spec.

**File**: `src/io/resolve-generics.ts`, `src/io/generic-cache.ts`

---

## Weak Tests

### W1 — `dig-loader.test.ts::facadeIntegration` — trivially-true guard assertion

**Test path**: `src/io/__tests__/dig-loader.test.ts::DigLoader::facadeIntegration`

**What is wrong**: Line 537 contains `expect(circuit).toBeDefined()`. This is a trivially-true guard: the function either returns a `Circuit` or throws; if it throws the test fails for the wrong reason. The assertion adds no information and is a weak-assertion pattern the rules prohibit.

**Quoted evidence**:
```typescript
expect(circuit).toBeDefined();
expect(circuit.elements).toHaveLength(5);
expect(circuit.wires).toHaveLength(5);
```

The first assertion is redundant — the next two assertions already prove the circuit is defined. Weak assertion should be removed.

---

### W2 — `subcircuit.test.ts::drawDefault` — `toBeGreaterThanOrEqual(1)` does not verify content

**Test path**: `src/components/subcircuit/__tests__/subcircuit.test.ts::drawDefault::renders a rectangle and pin labels in DEFAULT mode`

**What is wrong**: Lines 186–187:
```typescript
const rects = ctx.callsOfKind("rect");
expect(rects.length).toBeGreaterThanOrEqual(1);
```

`toBeGreaterThanOrEqual(1)` passes if even a single rectangle is drawn anywhere for any reason. The spec requires the DEFAULT shape to render "labeled rectangle with pin names." The test does not verify the rectangle's position, dimensions, or that it bounds the chip. This is a pattern the rules flag: `len(x) > 0` without content checks.

---

### W3 — `subcircuit.test.ts::drawDIL` — bare count assertions without geometry checks

**Test path**: `src/components/subcircuit/__tests__/subcircuit.test.ts::drawDIL::renders a DIP IC package appearance in DIL mode`

**What is wrong**: Lines 251–254:
```typescript
const arcs = ctx.callsOfKind("arc");
expect(arcs.length).toBeGreaterThanOrEqual(1);
const rects = ctx.callsOfKind("rect");
expect(rects.length).toBeGreaterThanOrEqual(1);
```

Both assertions use `toBeGreaterThanOrEqual(1)` — they pass as long as at least one arc and one rect are drawn. This does not verify the DIP package appearance, the notch position, or pin count. Any drawing code that emits one arc and one rect anywhere would pass this test.

---

### W4 — `editor-binding.test.ts::getWireValue` — call-record assertion is an implementation detail

**Test path**: `src/integration/__tests__/editor-binding.test.ts::EditorBinding::getWireValue`

**What is wrong**: Lines 90–93:
```typescript
const rawCall = engine.calls.find(
  (c) => c.method === "getSignalRaw" && c.netId === 3,
);
expect(rawCall).toBeDefined();
```

The test checks that the internal `calls` record array contains a specific method name (`"getSignalRaw"`) — this is asserting the implementation detail of how `getWireValue` is implemented (it must call `getSignalRaw` specifically), rather than the desired behaviour (the correct value is returned). The value `42` is already verified by `expect(value).toBe(42)` on line 87. The additional call-record check is testing internals. The spec says "assert `getWireValue(wire)` returns that value" — not that it calls a specific internal method.

---

## Legacy References

### L1 — `subcircuit-loader.ts` references task identifiers as code documentation

**File**: `src/io/subcircuit-loader.ts`, lines 46–48

**Quoted evidence**:
```
 * until the full SubcircuitElement from task 6.2.1 is available. The
 * subcircuit definition (the loaded Circuit) is stored as a property so
 * the flattener (6.2.3) and renderer (6.2.1) can retrieve it.
```

Task numbers (`6.2.1`, `6.2.3`) embedded in production code comments are stale references to the implementation plan, not references to code. They describe the phased-delivery origin of this code and tie the implementation to an external planning document. These will become meaningless legacy references once the implementation is complete. Comments in production code must only explain complicated logic to future developers, not document which planning task introduced a class.

---

*Report written: Phase 6, Waves 6.1 and 6.2 only.*
