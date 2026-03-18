# Review Report: Wave 4c.1 — Compiler Transistor Expansion

## Summary

| Field | Value |
|-------|-------|
| Tasks reviewed | 1 (Task 4c.1.1) |
| Violations | 3 |
| Gaps | 2 |
| Weak tests | 1 |
| Legacy references | 0 |
| **Verdict** | **has-violations** |

---

## Violations

### V1 — Historical-provenance comment in `transistor-expansion.ts`

- **File**: `src/analog/transistor-expansion.ts`, lines 307–317
- **Rule violated**: rules.md — "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned."
- **Severity**: major
- **Quoted evidence**:
  ```
  // Analog factory registry — maps typeId strings to inline analog factories.
  //
  // This minimal registry covers the leaf analog components that transistor
  // model subcircuits may contain. It is separate from ComponentRegistry to
  // avoid circular dependencies during compilation.
  //
  // Populated lazily using dynamic imports when needed. For the transistor
  // expansion use case, we hard-code the MOSFET factories since those are the
  // only components used in CMOS transistor models.
  ```
  The phrase "Populated lazily using dynamic imports when needed" describes an approach that is **not what the code does** — the registry is populated via `registerAnalogFactory()` call-time registration, not dynamic imports. This comment describes a discarded design intent. The phrase "hard-code the MOSFET factories since those are the only components used in CMOS transistor models" is a historical-provenance justification comment explaining the scope limit of the current implementation. This is the exact class of comment the rules ban: it describes what was decided and why, not how the code works.

---

### V2 — Historical-provenance comment describing code limitation as acceptable

- **File**: `src/analog/transistor-expansion.ts`, lines 197–202
- **Rule violated**: rules.md — "No historical-provenance comments. […] Read these as a signal that the agent knowingly failed to implement the new functionality cleanly and included a comment to make a shortcut seem acceptable."
- **Severity**: major
- **Quoted evidence**:
  ```typescript
  // Check if this is an analog component — we need an analog factory to stamp it
  // We can't directly look up the ComponentRegistry here, but we can check by
  // attempting to expand. The spec says we should emit invalid-transistor-model
  // when the model contains non-analog components. We detect this by checking
  // if the element has a known non-analog typeId pattern (digital flip-flops, etc.)
  // The caller (compiler) validates this more thoroughly; here we rely on the
  // analogFactory being present when getAnalogFactory is called.
  ```
  This comment:
  1. States "We can't directly look up the ComponentRegistry here" — describes an architectural constraint used to justify not using the registry, which is a historical-provenance justification.
  2. States "The caller (compiler) validates this more thoroughly" — describes responsibility delegation to a caller, justifying incomplete validation here. This is a shortcut justification comment.
  3. References what the "spec says" should happen as distinct from what the code does — a flag that the implementation differs from the spec intent.

---

### V3 — `transistor-expansion.ts` exports `registerAnalogFactory`/`getAnalogFactory` — out-of-spec scope creep with no specification basis

- **File**: `src/analog/transistor-expansion.ts`, lines 319–343
- **Rule violated**: Implementation rules — no features outside spec; rules.md "Never mark work as deferred, TODO, or 'not implemented.'" (inverse: no scope creep either)
- **Severity**: minor
- **Quoted evidence**:
  ```typescript
  type AnalogFactory = (
    nodeIds: number[],
    branchIdx: number,
    props: PropertyBag,
    getTime: () => number,
  ) => AnalogElement;

  const _analogFactoryRegistry = new Map<string, AnalogFactory>();

  export function registerAnalogFactory(typeId: string, factory: AnalogFactory): void {
    _analogFactoryRegistry.set(typeId, factory);
  }

  export function getAnalogFactory(typeId: string): AnalogFactory | undefined {
    return _analogFactoryRegistry.get(typeId);
  }
  ```
  The spec for Task 4c.1.1 specifies `TransistorExpansionResult`, `expandTransistorModel()`, and `TransistorModelRegistry`. It does not specify a second factory registry (`registerAnalogFactory`/`getAnalogFactory`) exported from `transistor-expansion.ts`. These are **scope creep** — new exported API surface not in the spec. The spec says expansion gets `AnalogElement` instances from `analogFactory` on `ComponentDefinition` objects already in the registry. The `registerAnalogFactory`/`getAnalogFactory` infrastructure is an alternative undocumented registry layer that bypasses the spec's intended path through `ComponentDefinition.analogFactory`.

  Note: this directly affects correctness — in `transistor-expansion.ts` line 203, `getAnalogFactory(el.typeId)` is called instead of looking up the component's `analogFactory` via the `ComponentRegistry`. The spec states: "Create `AnalogElement` instances for each internal component (resistor, MOSFET, etc.) using their `analogFactory`". The `ComponentRegistry` is not passed to `expandTransistorModel` at all, so the function cannot reach the registered `ComponentDefinition.analogFactory` for internal subcircuit elements. Instead it uses its own parallel registry. This is an architectural deviation from the spec.

---

## Gaps

### G1 — `ComponentRegistry` not passed to `expandTransistorModel`; spec-mandated path (ComponentDefinition.analogFactory) not used

- **Spec requirement**: Task 4c.1.1, Files to create — `expandTransistorModel(componentDef, outerPinNodeIds, modelRegistry, vddNodeId, gndNodeId, nextNodeId)` — "Create `AnalogElement` instances for each internal component (resistor, MOSFET, etc.) using their `analogFactory`". The `analogFactory` field is on `ComponentDefinition`, looked up via `ComponentRegistry`. The spec does not include a `componentRegistry` parameter but the implied lookup path is through the registered definitions.
- **What was found**: `expandTransistorModel` uses its own internal `_analogFactoryRegistry` map (populated by `registerAnalogFactory()`), completely bypassing `ComponentDefinition.analogFactory`. The `ComponentRegistry` is never consulted for internal subcircuit element factories. The spec does not define `registerAnalogFactory` or `_analogFactoryRegistry`; these are invented infrastructure.
- **Impact**: Any analog component with an `analogFactory` registered only via `ComponentRegistry` (e.g. resistors, voltage sources added in Phase 2) will NOT be found by `getAnalogFactory()` during expansion unless explicitly re-registered via `registerAnalogFactory()`. This silently drops elements from expansion — the `if (!factory) continue;` at line 234 skips them without emitting a diagnostic.
- **File**: `src/analog/transistor-expansion.ts`, lines 192–238

---

### G2 — `analog-compiler.test.ts`: spec requires test name `transistor_mode_emits_stub_diagnostic` be updated, but the test was renamed

- **Spec requirement**: Task 4c.1.1, Files to modify — `src/analog/__tests__/analog-compiler.test.ts` — "updated `transistor_mode_emits_stub_diagnostic` test to assert new `missing-transistor-model` error behavior". The spec refers to updating a test by its original name.
- **What was found**: The test was renamed to `transistor_mode_without_registry_emits_diagnostic`. The progress.md confirms: "updated `transistor_mode_emits_stub_diagnostic` test to assert new `missing-transistor-model` error behavior". The test in the file has a different name (`transistor_mode_without_registry_emits_diagnostic`). While the behaviour tested is correct, the test identifier changed. This is a minor deviation — the spec says to update the existing test, not rename it. If any external test runner references the original name (e.g., CI filters, spec selectors), this rename breaks it.
- **File**: `src/analog/__tests__/analog-compiler.test.ts`, line 388

---

## Weak Tests

### W1 — `expands_inverter_to_two_mosfets`: weak assertion on diagnostics filter, no content check on elements

- **Test path**: `src/analog/__tests__/transistor-expansion.test.ts::Expansion::expands_inverter_to_two_mosfets`
- **What is wrong**: The test asserts `expect(result.elements).toHaveLength(2)` — this verifies count only, not that the two elements are actually MOSFETs or have valid node connectivity. A factory that returns stub elements with no nodeIndices would pass this test. The spec requires "assert 2 MOSFET analog elements created". The test does not verify that the elements are MOSFETs (e.g., checking `el.isNonlinear === true` or that `el.nodeIndices.length === 3` for D/G/S). A trivial assertion on count alone is insufficient to verify MOSFET expansion.
- **Quoted evidence**:
  ```typescript
  expect(result.diagnostics.filter((d) => d.severity === "error")).toHaveLength(0);
  expect(result.elements).toHaveLength(2);
  ```
  No assertion on element type, pin count, or non-linearity property. (The `interface_pins_mapped_correctly` test does check node connectivity, but `expands_inverter_to_two_mosfets` is the primary count-only test and is therefore weak in isolation.)

---

## Legacy References

None found.

---

## Notes on Scope

Wave 4c.1 covers only Task 4c.1.1. Tasks 4c.2.1 and 4c.3.1 are not in scope for this wave review.

The spec's acceptance criteria are partially met:
- "Transistor model subcircuits are expanded into leaf analog elements at compile time" — **met in the happy path**, but the analog factory lookup bypasses `ComponentDefinition.analogFactory` (Gap G1).
- "Interface pins are correctly wired to the outer circuit's nodes" — **met** (verified by test).
- "Internal nodes get unique IDs that don't collide with outer circuit or other expansions" — **met** (verified by test).
- "Missing or invalid transistor models produce clear diagnostics" — **met** (verified by tests).
- "Non-transistor components in the same circuit are unaffected" — **met** (compiler skip logic is correct).
