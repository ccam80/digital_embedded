# Spec Review: Unified Model System — Design Section

## Verdict: needs-revision

---

## Plan Coverage

This assignment covers only the Design section of `spec/unified-model-params.md`. There is no separate plan file for this spec — the wave/task plan is embedded in the same document. Coverage is evaluated against the tasks declared in the embedded Migration section.

| Design Concept | Addressed in Design Section? | Notes |
|----------------|------------------------------|-------|
| `ModelEntry` discriminated union | yes | Fully specified with both variants |
| `ParamDef` type | yes | All fields listed |
| `defineModelParams()` helper | yes | Signature and return shape described |
| `ComponentDefinition.modelRegistry` / `defaultModel` | yes | Replaces `models.mnaModels` + `subcircuitRefs` |
| Partitioned `PropertyBag` | yes | `getModelParam()` / `setModelParam()` contract described |
| `defaultSource: "model"` on PropertyDefs | yes | Described in "Model parameter defaults" section |
| Compiler resolution flow | yes | Five-step sequence described |
| Runtime model registry (`circuit.metadata.models`) | yes | Structure shown with code examples |
| Serialization | yes | Factories-never-serialized rule, delta serialization |
| Unified import dialog | yes | Auto-detect, `.MODEL` vs `.SUBCKT` flow |
| `deviceType` as import-boundary-only | yes | `SPICE_TYPE_TO_COMPONENT` table shown |
| Property panel | yes | Model dropdown, primary/secondary split, rebuild on switch |
| Removed Concepts table | yes | 19-entry table present |
| No-Legacy policy + verification conditions | yes | Zero-occurrence list provided |

---

## Internal Consistency Issues

### Issue 1: `AnalogFactory` type is used but never defined in the spec

**Section:** "ModelEntry — the unified type"

The spec defines:
```typescript
type ModelEntry =
  | { kind: "inline"; factory: AnalogFactory; paramDefs: ParamDef[]; params: Record<string, number> }
  | { kind: "netlist"; netlist: MnaSubcircuitNetlist; paramDefs: ParamDef[]; params: Record<string, number> };
```

`AnalogFactory` is referenced as if it is an established type. Searching the codebase shows it is imported in two test files (`coordinator-current-resolver.test.ts`, `coordinator-clock.test.ts`) from `../../core/registry.js`, but it does **not appear in `src/core/registry.ts`** as a named export. The actual factory type used in `MnaModel` (the current type being replaced) is inline in the `MnaModel` interface. The spec never states what the `AnalogFactory` signature is, what module it comes from, or whether it needs to be newly exported from `src/core/registry.ts` alongside the new types.

An implementer of T1 must either find `AnalogFactory` somewhere or invent the type signature. If the type doesn't exist as a named export in `registry.ts`, T1's "Add new types" task is under-specified.

**What concrete would look like:** State the full function signature for `AnalogFactory` (matching `MnaModel.factory`) and which file it is or will be exported from.

---

### Issue 2: `defineModelParams()` return shape is inconsistently described

**Section:** "`defineModelParams()` helper"

The spec states: "Returns both the `ParamDef[]` (schema) and a `Record<string, number>` of default values extracted from the declaration, so model entries can reference both from the same source."

But the BJT example at the top of the spec assigns the result to `BJT_PARAM_DEFS`:
```typescript
const BJT_PARAM_DEFS: ParamDef[] = defineModelParams({ ... });
```
This annotation types the return as `ParamDef[]` only — not a tuple or object containing both `ParamDef[]` and `Record<string, number>`.

Then in the wave plan (T1), the same helper is described as returning both a schema and defaults. These two descriptions are contradictory: either the function returns `ParamDef[]`, or it returns a compound object. An implementer cannot reconcile them without guessing. The modelRegistry examples show `paramDefs: BJT_PARAM_DEFS` and `params: { IS: 1e-14, BF: 100, ... }` separately, which suggests the params are extracted manually — but the helper description says they are returned together.

**What concrete would look like:** Show the exact return type. For example:
```typescript
function defineModelParams(spec: { primary: {...}; secondary: {...} }): {
  paramDefs: ParamDef[];
  defaults: Record<string, number>;
}
```
And update all usage examples consistently.

---

### Issue 3: Factory signature in `ModelEntry` contradicts the factory signature in `MnaModel`

**Section:** "ModelEntry — the unified type" vs. "Compiler resolves ModelEntry to factory"

The existing `MnaModel.factory` signature (in `src/core/registry.ts`) is:
```typescript
factory: (
  pinNodes: ReadonlyMap<string, number>,
  internalNodeIds: readonly number[],
  branchIdx: number,
  props: PropertyBag,
  getTime: () => number,
) => AnalogElementCore
```

The compiler (step 5 in the design section) states "Call factory — it reads model params via `props.getModelParam()`, guaranteed populated." This implies the factory in `ModelEntry` also accepts a `PropertyBag`. But the spec does not explicitly state that the new `AnalogFactory` type has this same five-parameter signature. Meanwhile, `compileSubcircuitToMnaModel()` in `compiler.ts` calls sub-element factories with a different three-argument signature: `factory(remappedNodes, subBranchIdx, subProps, getTime)` — matching a different `AnalogFactory` type referenced in the test files. These signatures are not reconciled in the spec.

The implementer of T3 (Compiler resolution) faces this concrete ambiguity: what is the factory call signature that T1's `ModelEntry` carries?

---

### Issue 4: Compiler engine-routing logic references digital factories but the detection mechanism is unspecified

**Section:** "Digital engine routing" (under "One model list per component")

The spec states: "The compiler inspects the resolved ModelEntry and routes `inline` entries with a digital factory to the event-driven engine and `inline`/`netlist` entries with an analog factory to the MNA engine."

But `ModelEntry` has no `domain` field and no `engineType` tag. The only way to distinguish digital from analog factories is to inspect the factory function itself (e.g., duck-typing `'executeFn' in ...`) — but `ModelEntry.factory` is typed as `AnalogFactory`, which is defined as a MNA factory. Where does the digital `ExecuteFunction` live in the new model? The AND gate example shows:
```typescript
"digital": { kind: "inline", factory: createDigitalAndElement, paramDefs: ..., params: ... }
```
But `createDigitalAndElement` would be an `ExecuteFunction`, not an `AnalogFactory`. If both are stored in `factory: AnalogFactory`, the type is wrong. If there is a union type, the spec omits it. The routing mechanism — how the compiler distinguishes digital vs. analog ModelEntries — is entirely unspecified.

---

### Issue 5: `circuit.metadata.models` structure conflicts with the "Removed Concepts" table for `modelDefinitions`

**Section:** "Runtime model registry" vs. "Removed Concepts"

The Removed Concepts table says `modelDefinitions` (circuit metadata) is replaced by `circuit.metadata.models`. However, the runtime registry section shows:
```typescript
// circuit.metadata.models: Record<string, Record<string, ModelEntry>>
// Keyed by component typeId, then model name
```

The comment says "keyed by component typeId" but the examples show string keys like `"NpnBJT"` which are type *names*, not numeric `typeId`s. This is an ambiguity: the spec's comment says one thing, the examples show another. Numeric typeIds are "never serialized" (per `ComponentDefinition.typeId` doc), so using them as serialization keys would be wrong. But using type names is also not explicitly stated.

---

### Issue 6: "Model switch" undo compound operation details missing from T13, present only in Design

**Section:** "Partitioned PropertyBag" (design) vs. T13 wave plan

The design section specifies that model switch is "a single compound undo operation — undo restores the previous model selection and its entire param state in one step." T13 is listed as "Compound undo for model switch" with three bullet points. However, the design section says undo should "Apply any user deltas (for undo/redo round-trips)" as step 3 of model switch. What "user deltas" means in the undo context — specifically how the undo stack stores and replays them — is not specified. The implementer of T13 cannot know what data structure the undo history entry holds.

---

## Completeness Gaps

### Gap 1: `PropertyBag.getModelParam()` and `setModelParam()` signatures are never shown

**Section:** "Partitioned PropertyBag"

The spec names these two methods and describes their semantics but never shows their signatures. The existing `PropertyBag` class is in `src/core/properties.ts` and has `get<T>()`, `set()`, `getOrDefault<T>()`. The spec says T1 adds the model param partition. An implementer must invent:
- What `getModelParam<T>(key: string): T` looks like (same as `get` but reads from the partition?)
- What `setModelParam(key: string, value: PropertyValue): void` looks like
- How `wholesale replacement` of the partition works (a method? `clearModelParams()` + batch set?)
- Whether `PropertyBag` grows a second internal `Map` or uses namespaced keys

None of these implementation details are specified. The partition boundary is described conceptually but never as a concrete API.

---

### Gap 2: `defaultSource: "model"` on `PropertyDefinition` is described but the field is not added to the `PropertyDefinition` interface

**Section:** "Model parameter defaults — single source of truth"

The spec states: "Model-param PropertyDefs (ParamDefs) declare `defaultSource: 'model'`." But the existing `PropertyDefinition` interface (in `src/core/properties.ts`) has no `defaultSource` field. The spec does not show the updated `PropertyDefinition` interface with this field added. T1 covers "Add new types" but does not list `PropertyDefinition` as a file to modify. The Files Changed table lists `src/core/properties.ts` only for "Partitioned PropertyBag" — not for the `defaultSource` change.

---

### Gap 3: `ParamDef` type lacks `type` field specification relative to `PropertyType`

**Section:** "ModelEntry — the unified type"

`ParamDef` declares `type: PropertyType`. But `PropertyType` (from `src/core/properties.ts`) includes `INT`, `FLOAT`, `STRING`, `ENUM`, `BOOLEAN`, `BIT_WIDTH`, `HEX_DATA`, `COLOR`, `LONG`, `FILE`, `ROTATION`, `INTFORMAT`. Model parameters are exclusively numeric. The spec does not state which `PropertyType` values are valid for model params, nor whether a new `PropertyType.NUMBER` is needed, nor what happens if a non-numeric type is used. All spec examples show number params only, but the type field accepts the full union.

---

### Gap 4: No file path or module location given for `defineModelParams()`

**Section:** "`defineModelParams()` helper"

The spec describes the helper's signature and purpose but never states where it lives. The Files Changed table does not list a file that would contain it. `src/core/registry.ts` is listed for adding `ParamDef`, `ModelEntry`, `modelRegistry` — but `defineModelParams()` is not mentioned there. `src/solver/analog/model-defaults.ts` is listed as "Becomes source data for `defineModelParams()`" — implying the helper wraps that data, but the helper itself could live in `registry.ts`, `properties.ts`, or a new file. The implementer of T1 cannot determine where to put this function.

---

### Gap 5: The "Removed Concepts" table omits `model-param-meta.ts` which already holds param metadata

**Section:** "Removed Concepts"

The file `src/solver/analog/model-param-meta.ts` currently exists and is imported by `src/editor/property-panel.ts` (confirmed: `import { getParamMeta } from "../solver/analog/model-param-meta.js"`). This file stores SPICE parameter metadata (display names, units, etc.) for the existing property panel. The new design subsumes this with `ParamDef.label`, `ParamDef.unit`, and `ParamDef.description` on every model entry. But `model-param-meta.ts` is neither listed in the Removed Concepts table nor in the Files Changed table. The implementer of T5 (property panel) will encounter this import and be uncertain whether to keep, remove, or migrate it.

---

### Gap 6: No test fixture file paths specified for the shared fixture requirement

**Section:** "Test fixture rule" (Migration section)

The spec states: "All test files must import model entries, paramDefs, and PropertyBag construction from shared fixture modules (`src/test-fixtures/` or co-located `__tests__/fixtures/`)." These directories do not currently exist (confirmed by checking the codebase). T1 is supposed to create "Shared test fixtures for `ModelEntry` and `ParamDef` construction" but the spec gives no file path, no interface, and no example of what the fixture module exports. Implementers of every wave-3 task must use these fixtures but cannot know what they look like.

---

### Gap 7: `circuit.metadata.models` type is shown in a comment but never as a TypeScript type

**Section:** "Runtime model registry"

The spec shows:
```typescript
// circuit.metadata.models: Record<string, Record<string, ModelEntry>>
// Keyed by component typeId, then model name
```
This is a comment, not a type declaration. `CircuitMetadata` in `src/core/circuit.ts` must grow a `models` field, but the spec never shows the updated `CircuitMetadata` interface. The serializable vs. runtime forms of `ModelEntry` also differ (factories are stripped for serialization), but `circuit.metadata.models` holds the runtime form — so it is unclear whether this field holds runtime `ModelEntry` objects (with function references) or the serializable form. The circuit object is a runtime model, so presumably runtime — but this directly conflicts with the serialization section which says `circuit.metadata.models` stores serializable data only (for `netlist` entries, the netlist is plain data). The distinction between the runtime circuit object's `models` field and the serialized `DtsDocument.models` field is never drawn.

---

### Gap 8: No specification for how the property panel determines which component's `modelRegistry` to read

**Section:** "Property panel"

The property panel section says "Model dropdown at top — lists all available models for this component." It does not specify how the panel receives the `modelRegistry`. Currently the panel works with `ComponentDefinition` passed to `showProperties()`. If the registry lookup now returns the `modelRegistry` from `ComponentDefinition`, the panel needs the registry at display time. But the panel section gives no API or call pattern for this. When migrating T5, the implementer must guess whether `showProperties(element, definition, runtimeModels?)` or some other signature change is needed.

---

## Concreteness Issues

### Concreteness Issue 1: "Primary params shown by default / Secondary in collapsed 'Advanced Parameters'" — no DOM or render spec

**Section:** "Property panel"

The spec states secondary params are in a "collapsed 'Advanced Parameters'" section. The current property panel (`src/editor/property-panel.ts`) has no such collapsible section. The spec gives no information about the DOM structure, the collapse/expand mechanism, or how the section heading is rendered. An implementer cannot build this from the spec alone.

---

### Concreteness Issue 2: "Modified indicator" comparison semantics are vague

**Section:** "Property panel" and "Model parameter defaults"

The spec says: "Modified indicator on params that differ from the active model entry's defaults." It does not state:
- What UI element constitutes a "modified indicator" (CSS class? asterisk? colored dot?)
- What "differ" means for floating-point numbers (exact equality? epsilon?)
- Whether the indicator appears on the label, the input, or both

Without this, two implementers would build entirely different UIs.

---

### Concreteness Issue 3: `.SUBCKT` import "primary vs secondary assignment step" is underspecified

**Section:** "Unified 'Import Model' dialog"

The spec states: "After parsing a `.SUBCKT`, an assignment step lets the user designate which params are primary vs secondary." This is a UI workflow step with no further description:
- Is it a second dialog? A list with radio buttons per param? Checkboxes?
- What is the default (all primary? all secondary?)
- Is this step required or skippable?
- Where does the result go before the `ModelEntry` is stored?

T14 lists "`.SUBCKT` imports: paramDefs derived from subcircuit declarations, primary/secondary assignment step" as a single bullet — which is not enough detail to implement the UI.

---

### Concreteness Issue 4: Serialization delta format is described but not typed

**Section:** "Serialization" and T12

The spec says per-element serialization saves: `model: "2N2222"` plus "only user-modified params (values that differ from the model entry's defaults)." But it does not show:
- The JSON shape for the per-element properties object in the saved `.dts` format
- How the deserializer distinguishes a model-param key from a static-property key in the `DtsElement.properties` bag
- What happens when the referenced model entry (`"2N2222"`) no longer exists in the circuit's runtime registry on load

T12 ("Delta serialization") depends on these details to implement correctly.

---

### Concreteness Issue 5: Engine routing for digital `ModelEntry` uses no typed discriminant

**Section:** "One model list per component" — AND gate example

The AND gate example shows `"digital": { kind: "inline", factory: createDigitalAndElement, ... }`. The compiler routing section says to inspect ModelEntry and route by engine. But `kind: "inline"` is identical for both digital and analog entries. There is no field like `engine: "digital" | "mna"` that makes routing unambiguous. The only way to know a factory is digital is to know what `createDigitalAndElement` is — which requires knowledge outside the `ModelEntry`. This makes the compiler routing algorithm impossible to implement as written without either (a) adding a discriminant field the spec omits, or (b) duck-typing the factory function.

---

### Concreteness Issue 6: `SPICE_TYPE_TO_COMPONENT` table is incomplete as shown

**Section:** "`deviceType` becomes import-boundary-only"

The table maps SPICE device type codes to component registry names. It shows `NPN: "NpnBJT"`, `PMOS: "PMOS"`, etc. The current `DeviceType` union in `src/core/analog-types.ts` is: `"NPN" | "PNP" | "NMOS" | "PMOS" | "NJFET" | "PJFET" | "D" | "TUNNEL"`. The spec's table adds `R`, `C`, `L` and `TUNNEL` (which already exists). But the spec omits `NJFET` and `PJFET` from the table even though they are in the current `DeviceType` union and presumably still need mapping. The Removed Concepts table also lists `DeviceType` as replaced by a parser-internal constant, but the spec's `SPICE_TYPE_TO_COMPONENT` table doesn't include all entries. An implementer would have to guess whether `NJFET`/`PJFET` were intentionally omitted (i.e., not supported for import) or accidentally left out.

---

## Implementability Concerns

### Concern 1: T1 deletes old infrastructure before new PropertyBag API is stable — but T1 says "add alongside old code"

**Section:** Wave 1 tasks

T1 says "Add as pure additions alongside the old code (old code is deleted in T2)." T2 immediately deletes old infrastructure. But the new `PropertyBag.getModelParam()` and `setModelParam()` methods are part of T1. The problem: every analog factory currently reads params via `props.has("_modelParams")` and `props.get<Record<string, number>>("_modelParams")` (confirmed in `src/components/semiconductors/bjt.ts`, lines 173–191). T2 deletes `_modelParams` injection from compiler.ts (line item in the T2 table). But the factories that read `_modelParams` are not updated until T4 (BJT) and T7–T8 (all others). After T2 executes, there will be factories that call `props.get("_modelParams")` on a `PropertyBag` that no longer has that key — causing runtime throws during any simulation. The spec acknowledges "nothing compiles" after Wave 1, but this is a deeper problem: deletion of `_modelParams` injection means all existing analog component tests break before the new factories are in place. T3+T4 are the same agent, but T7 and T8 are separate. The spec's instruction "Agents cannot defer work by pointing at 'obviously intended cleanup'" applies here — the ordering creates a genuine gap.

---

### Concern 2: The existing `compiler.ts` `compileSubcircuitToMnaModel()` uses `ModelLibrary` and `SubcircuitModelRegistry` — both scheduled for deletion in T2

**Section:** T2 deletions, T3 compiler rewrite

The current `compiler.ts` imports `SubcircuitModelRegistry` (line 26) and `ModelLibrary` (line 33, with `registerDefaultNamedModels` and `validateModel`). T2 deletes both `model-library.ts` and `subcircuit-model-registry.ts`. The compiler itself must then be rewritten in T3. But T2's deletion table does not list `compiler.ts` as a modified file — it only lists the `_modelParams` injection block for deletion. This means after T2, `compiler.ts` will have broken imports (`SubcircuitModelRegistry` and `ModelLibrary` no longer exist) that are not addressed until T3. The spec says "nothing compiles" is the intent, but T3 must reconstruct the compiler from scratch without specifying what the new `compileAnalogPartition()` function signature looks like after the `ModelLibrary` and `SubcircuitModelRegistry` are gone. The new compiler must resolve `ModelEntry` from `ComponentDefinition.modelRegistry` and `circuit.metadata.models`, but the integration point — how the compiler receives `circuit.metadata.models` — is not specified.

---

### Concern 3: `model-param-meta.ts` is currently imported by `property-panel.ts` — no migration path given

**Section:** Files Changed table, T5

`src/editor/property-panel.ts` currently imports `getParamMeta` from `src/solver/analog/model-param-meta.ts`. The spec does not mention `model-param-meta.ts` in its Removed Concepts table or Files Changed table. The implementer of T5 must decide whether to delete `model-param-meta.ts` (its data is superseded by `ParamDef` on each `ModelEntry`) or keep it. If kept, two systems provide metadata for the same params. If deleted, the import breaks. The spec is silent on this.

---

### Concern 4: The "AND gate example" shows `kind: "netlist"` for `cmos` but `params: {}` — the sub-element params are not explained

**Section:** "One model list per component" — AND gate example

The CMOS entry shows `params: {}` with the comment "MOSFET params come from sub-element defaults." This is conceptually understandable but creates a concrete implementability problem: when a user imports a `.SUBCKT`-based CMOS model and the paramDefs are "derived from the subcircuit's parameter declarations," where do those declarations come from? The CMOS netlists in `src/solver/analog/transistor-models/cmos-gates.ts` are hardcoded `MnaSubcircuitNetlist` objects with no parameter declarations. The spec does not address how existing hardcoded CMOS netlists acquire `paramDefs` or what their `params: {}` means for the compiler's "populate model param partition" step (step 4). If params are empty and paramDefs are empty, does the compiler skip the partition population step? This is unspecified.

---

### Concern 5: The `DtsDocument` serialization changes conflict with the "crash on old-format fields" policy

**Section:** Serialization, T6

The spec says the deserializer should "crash on old-format fields." The existing `DtsDocument` interface (in `src/io/dts-schema.ts`) has `modelDefinitions`, `namedParameterSets`, and `subcircuitBindings` as optional fields. Existing saved `.dts` files (and the `circuits/debug/` `.dig` files mentioned in T2) may carry these fields. The spec says these debug `.dig` files should be deleted. But `.dts` files carrying old-format fields: the spec instructs the deserializer to crash on them. This means any previously-saved `.dts` files become unreadable. The spec acknowledges "There is no installed base of .dts files to migrate" — but this claim should be verified. The spec also says `.dig` files are external imports only and old concepts must not appear in `.dig` import/export code — but the `.dig` deserializer (`src/io/dts-deserializer.ts`) currently reads `namedParameterSets` and `subcircuitBindings` from `.dts` format documents and would need to be updated for the `.dts` crash behavior. The spec does not distinguish between `.dig` import path and `.dts` load path for the crash-on-old-fields rule.

---

### Concern 6: T3+T4 agent-condition creates a mandatory coupling without specifying the test entry point

**Section:** Wave 2, T3+T4

The spec states: "T3 must be immediately followed by T4 using the same agent... Must run BJT tests and confirm pass before completing." But the spec does not specify which test file(s) constitute "BJT tests." The existing BJT test file is at `src/components/semiconductors/__tests__/bjt.test.ts`. After T2 deletes `_modelParams` injection and T3+T4 rebuild the compiler and BJT, these tests will need to be rewritten (they currently test the `_modelParams` path). The spec says tests must always assert desired behaviour — but it does not describe what the new BJT tests should assert. The "test fixture rule" says test files must import from shared fixtures, but those fixtures don't exist yet (they're created in T1). The BJT test rewrite scope is unspecified.

---

### Concern 7: `model-defaults.ts` is listed as "Becomes source data for `defineModelParams()`" but no migration specified

**Section:** Files Changed table

`src/solver/analog/model-defaults.ts` currently exports named constants like `BJT_NPN_DEFAULTS`, `BJT_PNP_DEFAULTS`, etc. (confirmed: imported by `bjt.ts` at line 36). The spec says this file "Becomes source data for `defineModelParams()`" — implying the file is kept but its shape may change. However, with `defineModelParams()` as the new canonical source of defaults, the existing usage in `bjt.ts` (line 36: `import { BJT_NPN_DEFAULTS, BJT_PNP_DEFAULTS }`) would be removed in T4. But the spec does not say whether the exports from `model-defaults.ts` are preserved, renamed, or deleted. T4's implementer will find `bjt.ts` importing from `model-defaults.ts` and must decide what to do.

---

## Removed Concepts Table — Cross-check Against Codebase

The following entries in the Removed Concepts table were verified against the codebase:

| Concept | Present in Codebase? | Notes |
|---------|---------------------|-------|
| `models.mnaModels` | Yes | `src/core/registry.ts` line 212 |
| `subcircuitRefs` | Yes | `src/core/registry.ts` line 259 |
| `simulationModel` property | Yes | `src/core/registry.ts` `getActiveModelKey()` line 305 |
| `_modelParams` sidecar | Yes | `src/components/semiconductors/bjt.ts` line 173, `compiler.ts` |
| `_spiceModelOverrides` property | Yes | Multiple semiconductor files |
| `_spiceModelName` property | Yes | Multiple semiconductor files |
| `deviceType` on `MnaModel` | Yes | `src/core/registry.ts` line 196 |
| `DeviceType` union | Yes | `src/core/analog-types.ts` line 155 |
| `namedParameterSets` | Yes | `src/core/circuit.ts` line 175 |
| `modelDefinitions` | Yes | `src/core/circuit.ts` line 185 |
| `subcircuitBindings` | Yes | `src/core/circuit.ts` line 187 |
| `SubcircuitModelRegistry` | Yes | `src/solver/analog/subcircuit-model-registry.ts` |
| `ModelLibrary` class | Yes | `src/solver/analog/model-library.ts` line 118 |
| `spice-subckt-dialog.ts` | Yes | `src/app/spice-subckt-dialog.ts` |
| `getActiveModelKey()` | Yes | `src/core/registry.ts` line 301 |
| `availableModels()` | Yes | `src/core/registry.ts` line 277 |
| `hasAnalogModel()` | Yes | `src/core/registry.ts` line 272 |
| `model` + `simulationModel` (two properties) | Yes | Both present in codebase |
| `PropertyDefinition.defaultValue` for model params | Partial | `defaultValue` field exists; `defaultSource` does not |

**Missing from table:**
- `model-param-meta.ts` (`src/solver/analog/model-param-meta.ts`) — currently imported by `property-panel.ts`, holds param display metadata that `ParamDef` supersedes. Not listed.
- `getWithModel()` on `ComponentRegistry` (`src/core/registry.ts` line 481) — queries by old `mnaModels` structure; likely needs updating or removal.
- `modelKeyToDomain()` on registry (`src/core/registry.ts` line 331) — uses old `mnaModels` shape; not listed.
- `hasDigitalModel()` utility (`src/core/registry.ts` line 267) — may need updating or removal.
- `WELL_KNOWN_PROPERTY_KEYS` set — currently only has `label/showLabel/showValue`; if `model` becomes a well-known key it is not mentioned.
- `src/solver/analog/model-defaults.ts` exports (`BJT_NPN_DEFAULTS`, etc.) — used directly in `bjt.ts`; fate unspecified.
