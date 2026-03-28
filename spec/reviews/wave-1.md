# Review Report: Wave 1 — Core Resolution Functions (Model System Unification)

## Summary

| Item | Count |
|------|-------|
| Tasks reviewed | 3 (W1.1, W1.2, W1.3) |
| Violations | 7 |
| Gaps | 5 |
| Weak tests | 3 |
| Legacy references | 4 |
| **Verdict** | **has-violations** |

---

## Violations

### V1 — `derivedEngineType` bootstrapping NOT removed (critical)

- **File:** `src/compile/compile.ts:96–124`
- **Rule violated:** Spec Wave 1 deliverable (Implementation Priority table, Wave 1 column): "move `pinElectrical`/`pinElectricalOverrides` from `AnalogModel` to `ComponentDefinition`" is listed alongside `getActiveModelKey()` and `modelKeyToDomain()`. The `derivedEngineType` block and `forceAnalogDomain` override are explicitly listed for removal: spec line 363 `| H1 | src/compile/compile.ts:105 | Derive derivedEngineType | Delete entire block |` and spec line 981 `src/compile/extract-connectivity.ts:96-101 — forceAnalogDomain (to be removed)`. The spec is unambiguous that Wave 1 introduces the resolution functions that make this block redundant, and the References section at spec:977 explicitly says `src/compile/compile.ts:96-129 — derivedEngineType bootstrapping (to be removed)`.
- **Evidence:**
  ```typescript
  // compile.ts:96–106
  let hasAnalogOnlyComponent = false;
  for (const el of circuit.elements) {
    const def = registry.get(el.typeId);
    if (def === undefined) continue;
    if (hasAnalogModel(def) && !hasDigitalModel(def)) {
      hasAnalogOnlyComponent = true;
      break;
    }
  }
  const derivedEngineType = hasAnalogOnlyComponent ? "analog" : "digital";
  // ...
  const flatModelAssignments = resolveModelAssignments(circuit.elements, registry, derivedEngineType);
  ```
- **Severity:** Major — The spec explicitly lists this as dead code to be removed as part of Wave 1 (H1). The block is still present in its entirety and `derivedEngineType` continues to be passed to `resolveModelAssignments`, perpetuating the heuristic override that Wave 1 was supposed to eliminate.

---

### V2 — `forceAnalogDomain` override NOT removed (critical)

- **File:** `src/compile/extract-connectivity.ts:53–111`
- **Rule violated:** Spec line 363 (`| H1 | ... | Delete entire block |`), spec line 296 (`forceAnalogDomain override | extract-connectivity.ts:96-101 | Per-instance choice is authoritative`), spec line 981 (`src/compile/extract-connectivity.ts:96-101 — forceAnalogDomain (to be removed)`).
- **Evidence:**
  ```typescript
  // extract-connectivity.ts:53–55 (JSDoc comment describes the feature):
  * When `forceAnalogDomain` is true, dual-model components that would otherwise
  * default to "digital" are overridden to "analog" so the analog partition
  * receives them.

  // extract-connectivity.ts:62:
  const forceAnalogDomain = engineType === 'analog';

  // extract-connectivity.ts:105–111:
  if (
    forceAnalogDomain &&
    modelKey === 'digital' &&
    def.models?.analog !== undefined
  ) {
    modelKey = 'analog';
  }
  ```
- **Severity:** Major — `forceAnalogDomain` is the override that `getActiveModelKey()` was supposed to make obsolete. Per spec: "Per-instance choice is authoritative." This circuit-wide domain forcing logic was explicitly scheduled for removal in Wave 1. It remains fully operational.

---

### V3 — `AnalogModel` interface retains `transistorModel` field that should be `subcircuitModel` on `MnaModel` (major)

- **File:** `src/core/registry.ts:181–193`
- **Rule violated:** Spec line 742 describes the codemod rule E: `transistorModel` key is "renamed to `subcircuitModel` on `cmos` model." The `MnaModel` interface at registry.ts:209 correctly defines `subcircuitModel?: string`. However, the `AnalogModel` interface at registry.ts:192 still carries `transistorModel?: string` — the old field that `subcircuitModel` replaces.
- **Evidence:**
  ```typescript
  // registry.ts:181–193 — AnalogModel still present with old transistorModel field:
  export interface AnalogModel {
    factory?: (...) => AnalogElementCore;
    requiresBranchRow?: boolean;
    getInternalNodeCount?: (props: PropertyBag) => number;
    deviceType?: DeviceType;
    transistorModel?: string;   // ← this field belongs to the OLD model, replaced by MnaModel.subcircuitModel
  }
  ```
  The `MnaModel` interface (registry.ts:199–223) correctly defines the replacement `subcircuitModel?: string`. Retaining `transistorModel` on `AnalogModel` is scope creep in reverse — it keeps the old interface field alive alongside the new one.
- **Severity:** Major — The `AnalogModel` interface was meant to be replaced by `MnaModel` (spec:995 "AnalogModel interface (to be replaced by MnaModel)"). Wave 1 adds `MnaModel` but does not remove `transistorModel` from `AnalogModel`, leaving a stale field.

---

### V4 — `resolveModelAssignments` does not use `getActiveModelKey()` (major)

- **File:** `src/compile/extract-connectivity.ts:81–100`
- **Rule violated:** Code hygiene — the function `getActiveModelKey()` was added in W1.1 specifically to centralise model key resolution. `resolveModelAssignments` duplicates the same three-step resolution chain instead of calling it. Two implementations of the same logic is an immediate divergence risk.
- **Evidence:**
  ```typescript
  // extract-connectivity.ts:86–100 — duplicated resolution chain:
  const simulationModelProp = el.getAttribute('simulationModel');
  const models = def.models as Record<string, ...>;
  let modelKey: string;
  if (typeof simulationModelProp === 'string' && simulationModelProp.length > 0
      && models[simulationModelProp] !== undefined) {
    modelKey = simulationModelProp;
  } else if (def.defaultModel !== undefined) {
    modelKey = def.defaultModel;
  } else {
    const keys = availableModels(def);
    modelKey = keys.length > 0 ? keys[0]! : 'neutral';
  }

  // getActiveModelKey() in registry.ts:314–333 — identical logic:
  const prop = el.getAttribute('simulationModel');
  if (typeof prop === 'string' && prop.length > 0) {
    if (prop === 'digital' && def.models.digital) return prop;
    if (def.models.mnaModels?.[prop]) return prop;
    throw new Error(...);
  }
  if (def.defaultModel !== undefined) return def.defaultModel;
  // ...
  ```
  Additionally, `resolveModelAssignments` accesses `def.models.mnaModels` indirectly (via cast to `Record<string, ...>`) while `getActiveModelKey()` accesses `def.models.mnaModels` directly. The cast at line 87 (`def.models as Record<string, DigitalModel | AnalogModel | undefined>`) does not include `mnaModels` keys in the type, meaning the lookup at line 92 (`models[simulationModelProp] !== undefined`) will silently miss `mnaModels` keys because `def.models` as typed only exposes `digital`, `analog`, and `mnaModels` as top-level keys — not the keys within `mnaModels`.
- **Severity:** Major — `resolveModelAssignments` will fail to find `mnaModels` entries (e.g., `"behavioral"`, `"ideal"`, `"real"`) via the cast lookup because `def.models["behavioral"]` is `undefined` — the actual model is at `def.models.mnaModels["behavioral"]`. This is a functional bug: components with `mnaModels` but no `analog` key will be routed to `neutral` domain rather than `mna`.

---

### V5 — `ModelAssignment.model` type still references `AnalogModel` (minor)

- **File:** `src/compile/extract-connectivity.ts:40`
- **Rule violated:** Code hygiene / type accuracy. Wave 1 introduces `MnaModel` as the named model type. The `ModelAssignment` interface still types `model` as `DigitalModel | AnalogModel | null`, excluding `MnaModel` instances.
- **Evidence:**
  ```typescript
  // extract-connectivity.ts:40:
  model: import('../core/registry.js').DigitalModel | import('../core/registry.js').AnalogModel | null;
  ```
  With `mnaModels` entries being `MnaModel` instances, this type is already inaccurate.
- **Severity:** Minor

---

### V6 — Weak assertion: `electricalSpec` checked only for existence, not content (minor)

- **File:** `src/compile/__tests__/partition.test.ts:504–505`
- **Rule violated:** Rules.md — "Test the specific: exact values, exact types, exact error messages where applicable." The test checks `toBeDefined()` on `electricalSpec` when the expected value is an empty object `{}` and the actual behaviour could be verified specifically.
- **Evidence:**
  ```typescript
  // partition.test.ts:504–505:
  // electricalSpec is a plain object — just check it's defined
  expect(result.bridges[0].electricalSpec).toBeDefined();
  ```
  The comment explicitly acknowledges the weak assertion. `makeAnalogDef` in the same file (line 59) sets `pinElectrical: { vOH: 3.3, vOL: 0, vIH: 2.0, vIL: 0.8 }`. The test should verify that when the component has no per-pin overrides, the returned spec equals the component-level `pinElectrical`.
- **Severity:** Minor

---

### V7 — Weak assertion: `AnalogModel no longer carries pinElectrical` is a trivially-true no-op test (minor)

- **File:** `src/core/__tests__/registry.test.ts:689–693`
- **Rule violated:** Rules.md — test assertions must verify desired behaviour. This test creates an `AnalogModel` object and checks that it has no `pinElectrical` property. Because `AnalogModel` never had `pinElectrical` in this codebase (it was on the separate `AnalogModel` type that was a pre-migration construct), the assertion is trivially true by TypeScript type constraints — the empty literal `{}` will always have `undefined` for any unset key. The test does not verify that code reading `pinElectrical` from the old location now reads it from `ComponentDefinition`.
- **Evidence:**
  ```typescript
  // registry.test.ts:689–693:
  it("AnalogModel no longer carries pinElectrical or pinElectricalOverrides", () => {
    const analogModel: AnalogModel = {};
    expect((analogModel as Record<string, unknown>)["pinElectrical"]).toBeUndefined();
    expect((analogModel as Record<string, unknown>)["pinElectricalOverrides"]).toBeUndefined();
  });
  ```
  An `AnalogModel` typed as `{}` will always return `undefined` for any property access via `as Record<string, unknown>`. This does not test that the compiler, partition.ts, or property-panel.ts read `pinElectrical` from `def` instead of `def.models.analog`.
- **Severity:** Minor

---

## Gaps

### G1 — `getActiveModelKey()` not called from `resolveModelAssignments`; resolution logic duplicated

- **Spec requirement:** Wave 1 (Implementation Priority table): add `getActiveModelKey()` as the single canonical resolution entry point. Spec line 980: `src/compile/extract-connectivity.ts:57-118 — resolveModelAssignments() (to be rewritten)`. The intent is that `resolveModelAssignments` delegates to `getActiveModelKey()`.
- **What was found:** `resolveModelAssignments` contains its own independent resolution chain that does not call `getActiveModelKey()`. See V4 above.
- **File:** `src/compile/extract-connectivity.ts:81–100`

---

### G2 — `resolveModelAssignments` model key lookup does not check `mnaModels` entries

- **Spec requirement:** Wave 1 adds `mnaModels?: Record<string, MnaModel>` to `ComponentModels`. The resolution chain in `resolveModelAssignments` must be able to recognise keys within `mnaModels` (e.g., `"behavioral"`, `"ideal"`, `"real"`) when set as `simulationModel` property, and must fall through to `mnaModels` keys when `defaultModel` is absent.
- **What was found:** The cast at extract-connectivity.ts:87 casts `def.models` to `Record<string, DigitalModel | AnalogModel | undefined>`. This does NOT include `mnaModels` sub-keys. `def.models["behavioral"]` is `undefined` — the entry is at `def.models.mnaModels["behavioral"]`. The fallback via `availableModels(def)` at line 98–99 may also miss `mnaModels` keys if `availableModels` only returns top-level keys of `models`.
- **File:** `src/compile/extract-connectivity.ts:86–100`

---

### G3 — `derivedEngineType` / `forceAnalogDomain` not removed (Wave 1 H1 deliverable)

- **Spec requirement:** Implementation Priority table Wave 1 implicitly includes H1 (spec:363: `| H1 | src/compile/compile.ts:105 | Derive derivedEngineType | Delete entire block |`). The References section (spec:977–978) explicitly marks both `compile.ts:96–129` and `extract-connectivity.ts:96–101` as things "to be removed". Wave 1 introduces the resolution functions that make these blocks obsolete.
- **What was found:** Both `derivedEngineType` (compile.ts:106) and `forceAnalogDomain` (extract-connectivity.ts:62, 105–111) are still fully present. See V1 and V2.
- **Files:** `src/compile/compile.ts:96–124`, `src/compile/extract-connectivity.ts:53–111`

---

### G4 — `AnalogModel.transistorModel` not removed; `MnaModel.subcircuitModel` exists in parallel

- **Spec requirement:** Spec:995 `src/core/registry.ts:181-195 — AnalogModel interface (to be replaced by MnaModel)`. Wave 1 adds `MnaModel` with `subcircuitModel` in place of `transistorModel`. The old field on `AnalogModel` should be removed or the interface replaced.
- **What was found:** Both exist simultaneously. `AnalogModel` at registry.ts:192 still has `transistorModel?: string`. `MnaModel` at registry.ts:210 has `subcircuitModel?: string`. See V3.
- **File:** `src/core/registry.ts:192`

---

### G5 — No tests verifying `getActiveModelKey()` throws `invalid-simulation-model` diagnostic via compiler

- **Spec requirement:** Spec lines 193–197 (Invalid `simulationModel` Handling): "The compiler catches this and emits a diagnostic: `{ severity: "error", code: "invalid-simulation-model" }`. Compilation fails." Wave 1 adds the throwing function; the compiler diagnostic path is required but has no test coverage.
- **What was found:** `registry.test.ts` tests that `getActiveModelKey()` throws an `Error`. There is no test verifying that `compileUnified()` catches this error and produces an `invalid-simulation-model` diagnostic in the result. The wave completion report lists 53 tests for W1.1 — all in the registry unit tests. No compile-level diagnostic test exists.
- **File:** `src/core/__tests__/registry.test.ts` (missing test), `src/compile/__tests__/compile.test.ts` (missing test)

---

## Weak Tests

### WT1 — `toBeDefined()` on `electricalSpec` with no content check

- **Path:** `src/compile/__tests__/partition.test.ts::electrical spec on bridge::returns empty spec when no analog electrical override is present`
- **Problem:** `toBeDefined()` is a trivially-passing assertion. The expected behaviour is that when no override is present, `electricalSpec` returns the component-level `pinElectrical` values (which `makeAnalogDef` sets to `{ vOH: 3.3, vOL: 0, vIH: 2.0, vIL: 0.8 }`). The test should assert the specific expected content.
- **Evidence:** `expect(result.bridges[0].electricalSpec).toBeDefined();` with comment `// electricalSpec is a plain object — just check it's defined`

---

### WT2 — `AnalogModel no longer carries pinElectrical` test is trivially true

- **Path:** `src/core/__tests__/registry.test.ts::pinElectrical on ComponentDefinition::AnalogModel no longer carries pinElectrical or pinElectricalOverrides`
- **Problem:** Creates an `AnalogModel = {}` and checks that property access returns `undefined`. Since `AnalogModel` as typed never had `pinElectrical`, this always passes regardless of whether the migration was done. It does not verify that any call site reads from `ComponentDefinition` instead of `models.analog`.
- **Evidence:** `expect((analogModel as Record<string, unknown>)["pinElectrical"]).toBeUndefined();`

---

### WT3 — `models field is preserved through register()` uses bare `toBeDefined()`

- **Path:** `src/core/__tests__/registry.test.ts::ComponentModels types and utilities (P1-1 through P1-5)::models field is preserved through register()`
- **Problem:** `expect(stored.models).toBeDefined()` and `expect(stored.models.digital).toBeDefined()` — these test presence, not content. `expect(stored.models.digital!.executeFn).toBe(noopExecuteFn)` follows and does test content, but the `toBeDefined()` calls preceding it add no value and match the "trivially true" pattern.
- **Evidence:** Lines 405–406: `expect(stored.models).toBeDefined(); expect(stored.models.digital).toBeDefined();`

---

## Legacy References

### LR1 — `AnalogModel` type reference preserved in `ModelAssignment.model` type

- **File:** `src/compile/extract-connectivity.ts:40`
- **Stale reference:** `import('../core/registry.js').AnalogModel` — the `AnalogModel` type is the pre-Wave-1 model type that `MnaModel` supersedes. This import ties `ModelAssignment` to the old type.

---

### LR2 — `AnalogModel` cast in `resolveModelAssignments`

- **File:** `src/compile/extract-connectivity.ts:87`
- **Stale reference:** `const models = def.models as Record<string, import('../core/registry.js').DigitalModel | import('../core/registry.js').AnalogModel | undefined>;` — casts the models container to the old `DigitalModel | AnalogModel` union, explicitly excluding `MnaModel`.

---

### LR3 — `forceAnalogDomain` comment references old domain-override concept

- **File:** `src/compile/extract-connectivity.ts:53–55` (JSDoc)
- **Stale reference:** `"When forceAnalogDomain is true, dual-model components that would otherwise default to 'digital' are overridden to 'analog' so the analog partition receives them."` — This comment describes the old `forceAnalogDomain` mechanism that the spec marks for deletion. The comment's continued existence documents dead-code intent.

---

### LR4 — `hasAnalogModel` / `hasDigitalModel` still called in `compile.ts` (H1 heuristic sites)

- **File:** `src/compile/compile.ts:99–100, 367`
- **Stale reference:** `hasAnalogModel(def) && !hasDigitalModel(def)` at line 100 — this is the H1 heuristic pattern that spec:363 explicitly says to delete. Line 367: `if (!def || def.models?.analog) continue;` also accesses the old `analog` key directly. Both are callers of the `hasAnalogModel`/`hasDigitalModel` helpers that spec:998 says to delete "after all H1-H15 heuristic sites are rewritten."

---

## Notes on Scope

The following items were confirmed as **not** Wave 1 scope and are not counted as gaps:

- Component declarations migration (patterns A–E, codemod to `mnaModels`) — Wave 5
- `SIMULATION_MODE_LABELS` removal — Wave 7
- `resolveCircuitDomain()` deletion — Wave 2/3
- `extractDigitalSubcircuit()` deletion — Wave 3
- `compileAnalogCircuit()` deletion — Wave 3
- H2–H15 heuristic site rewrites (except H1) — Wave 4

H1 (`derivedEngineType` at compile.ts:105) is explicitly listed in the Wave 1 priority table as work to be done. V1, V2, and G3 above all stem from H1 not being executed.
