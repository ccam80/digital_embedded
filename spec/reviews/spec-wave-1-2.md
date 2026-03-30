# Spec Review: Wave 1 + Wave 2 — New Types, Delete Old, Core Machinery + BJT

## Verdict: needs-revision

---

## Plan Coverage

This spec is self-contained (no separate plan.md was provided for this review scope). The tasks reviewed are T1–T6 as defined in `spec/unified-model-params.md` under the Migration section.

| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| T1: Add new types | yes | Present but file paths missing (see Completeness) |
| T2: Delete all old infrastructure | partial | Deletion table is incomplete — many callers and files not listed (see below) |
| T3: Compiler — ModelEntry resolution | yes | Present but agent condition wording is ambiguous (see Concreteness) |
| T4: BJT reference implementation | yes | Present but missing test assertions and param list |
| T5: Property panel — model-aware display | yes | Present but test assertions vague |
| T6: dts serializer/deserializer | yes | Present but missing test assertions and file paths |

---

## Internal Consistency Issues

**Issue 1 — T2 deletes `ModelLibrary` but T6 must rewrite the deserializer, which currently imports `ModelLibrary`.**

`src/io/dts-deserializer.ts` imports both `ModelLibrary` and `SubcircuitModelRegistry` as constructor parameters on its options type. T2 deletes both files, but T6 is in the same wave (Wave 2). If T2 and T6 are run by different agents in parallel (as the spec implies T5 and T6 can run in parallel after T3+T4), the deserializer is broken after T2 and T6 has no defined ordering relative to T2. The spec says T5 and T6 are "parallel with each other once T3+T4 complete" — but T2 precedes T3+T4. If T6 starts after T2 completes, it must rewrite the deserializer from a broken state, which is expected. But the spec does not tell the T6 agent that `dts-deserializer.ts` currently imports the two deleted files and will fail to compile — the agent needs to know this to avoid being confused by TypeScript errors that are pre-existing, not caused by their own changes.

**Issue 2 — `modelKeyToDomain` is listed for deletion in T2 but is called by `src/compile/partition.ts` and `src/compile/extract-connectivity.ts`.**

The T2 deletion table says to delete `getActiveModelKey()`, `availableModels()`, and `hasAnalogModel()` from `registry.ts`. It does not list `modelKeyToDomain()` for deletion. However, `modelKeyToDomain` uses `def.models.mnaModels` and `def.models.digital` — the old `ComponentModels` shape. After T2 deletes `models.mnaModels` from `ComponentModels`, `modelKeyToDomain` will not compile. Yet the spec does not address this. The domain-routing function must be replaced or rewritten as part of T2 or T3, but neither task mentions it.

**Issue 3 — `src/compile/partition.ts` and `src/compile/extract-connectivity.ts` use `getActiveModelKey` / `modelKeyToDomain` but are not listed anywhere in T2's deletion table or in any wave's "files to modify" list.**

After T2 deletes `getActiveModelKey` from `registry.ts`, both compile-layer files will fail to compile. These files are not mentioned in any task. An implementing agent following T2's deletion table will leave the compile layer broken with no guidance on what to replace those calls with.

---

## Completeness Gaps

**Gap 1 — T1 has no "Files to create/modify" section.**

T1 lists concepts to add (`ParamDef`, `ModelEntry`, `defineModelParams()`, partitioned `PropertyBag`, `defaultSource`, `modelRegistry`/`defaultModel` fields, shared test fixtures) but does not say where each item goes:

- Which file gets `ParamDef` and `ModelEntry`? (`src/core/registry.ts`? A new file?)
- Which file gets `defineModelParams()`? (A new utility file? `src/core/properties.ts`?)
- Which file gets `getModelParam()` / `setModelParam()`? (`src/core/properties.ts` is implied but not stated.)
- Where do the shared test fixtures live? The spec mentions `src/test-fixtures/` or `__tests__/fixtures/` but does not specify which for this project.

An implementing agent cannot start T1 without guessing file locations.

**Gap 2 — T1 has no tests.**

T1 adds all the new types. The spec mandates tests for every task (Three-Surface Testing Rule in CLAUDE.md). T1 has no test section at all — no assertions for `defineModelParams()`, `getModelParam()`, `setModelParam()`, model param partition wholesale replacement, or `defaultSource` behavior.

**Gap 3 — T2 has no tests.**

T2 is pure deletion. Deletion does not automatically produce failing tests — it produces compile errors. The spec does not say what tests should be run after T2 to confirm the right things were deleted and nothing else was accidentally removed. No test assertions are listed.

**Gap 4 — T2's deletion table is incomplete — the following callers and files are missing:**

| Missing item | File | Evidence |
|---|---|---|
| `SubcircuitModelRegistry` import + usage | `src/compile/compile.ts` | Line 23: `import type { SubcircuitModelRegistry }` |
| `SubcircuitModelRegistry` import + usage | `src/solver/analog/default-models.ts` | Entire file wraps `SubcircuitModelRegistry`; not listed for deletion |
| `SubcircuitModelRegistry` import + functions | `src/solver/analog/transistor-models/cmos-gates.ts` | `registerBuiltinSubcircuitModels(registry: SubcircuitModelRegistry)` |
| `SubcircuitModelRegistry` import + functions | `src/solver/analog/transistor-models/cmos-flipflop.ts` | `registerCmosDFlipflop(registry: SubcircuitModelRegistry)` |
| `SubcircuitModelRegistry` import + functions | `src/solver/analog/transistor-models/darlington.ts` | `registerDarlingtonModels(registry: SubcircuitModelRegistry)` |
| `ModelLibrary` import + parameter | `src/io/dts-deserializer.ts` | Lines 14–15, 192, 197 |
| `SubcircuitModelRegistry` import + parameter | `src/io/dts-deserializer.ts` | Lines 14–15, 197 |
| `SubcircuitModelRegistry` import + parameter | `src/io/dts-serializer.ts` | Line 11 |
| `namedParameterSets`, `modelDefinitions`, `subcircuitBindings` reads/writes | `src/io/dts-deserializer.ts` | Lines 231–257 |
| `namedParameterSets`, `modelDefinitions`, `subcircuitBindings` writes | `src/io/dts-serializer.ts` | (writes these fields to DtsDocument) |
| `namedParameterSets`, `modelDefinitions`, `subcircuitBindings` reads/writes | `src/app/spice-model-library-dialog.ts` | ~20 references |
| `namedParameterSets` write, `_spiceModelOverrides`, `_spiceModelName` write, `simulationModel` set | `src/app/spice-model-apply.ts` | Lines 34–66 |
| `getActiveModelKey`, `availableModels`, `modelKeyToDomain` callers | `src/compile/extract-connectivity.ts` | Line 10, 76, 79 |
| `getActiveModelKey`, `modelKeyToDomain` callers | `src/compile/partition.ts` | Lines 10, 200 |
| `getActiveModelKey`, `modelKeyToDomain` callers | `src/app/menu-toolbar.ts` | Lines 28, 168, 383 |
| `getActiveModelKey`, `modelKeyToDomain` callers | `src/app/test-bridge.ts` | Lines 17, 233 |
| `getActiveModelKey`, `modelKeyToDomain` callers | `src/app/canvas-popup.ts` | Lines 12, 75, 76 |
| `availableModels` caller | `src/editor/property-panel.ts` | Line 14, 276 |
| `modelKeyToDomain` (not listed for deletion at all) | `src/core/registry.ts` | Function exists, depends on old `models.mnaModels` shape |
| All test files for deleted infrastructure | Multiple `__tests__/` dirs | e.g. `spice-model-library.test.ts`, `model-library.test.ts`, `darlington.test.ts`, `cmos-gates.test.ts`, `cmos-flipflop.test.ts`, `dts-model-roundtrip.test.ts`, `spice-subckt-dialog.test.ts` |

The T2 deletion table lists 17 items. The actual deletion scope spans at least 30 additional locations across 15+ additional files not mentioned.

**Gap 5 — T4 has no test assertions.**

T4 says "Verify: BJT compiles and simulates end-to-end with correct results." This is not a test assertion. A concrete assertion would be: "BJT with `IS=1e-14, BF=100` biased at Vbe=0.65V stamps a collector current within 1% of the Ebers-Moll prediction; `getModelParam("IS")` on the compiled element returns `1e-14`."

**Gap 6 — T4 does not list which files to modify.**

The spec says "Declare `modelRegistry` on `NpnBjtDefinition` / `PnpBjtDefinition`" but does not give the file path. From the codebase, the relevant file is `src/components/semiconductors/bjt.ts`. An agent with no prior context must guess.

**Gap 7 — T4 does not specify the BJT `modelRegistry` entry in full.**

The design section shows a partial `BJT_PARAM_DEFS` example with `BF`, `IS`, `NF`, `BR`, `VAF`. T4 does not say whether the full param list from `BJT_NPN_DEFAULTS` in `src/solver/analog/model-defaults.ts` should be used, or only the subset shown in the example. The implementer must guess whether `VAF`, `IKF`, `RB`, etc. are included.

**Gap 8 — T5 and T6 have no files to modify listed.**

T5 ("property panel — model-aware display") does not name the file (`src/editor/property-panel.ts`). T6 ("dts serializer/deserializer") does not name the files (`src/io/dts-schema.ts`, `src/io/dts-serializer.ts`, `src/io/dts-deserializer.ts`). These appear in the "Files Changed" table at the bottom of the spec, but that table is not linked to individual tasks. An agent assigned only T5 or T6 in isolation may miss these.

**Gap 9 — T6 has no test assertions.**

T6 says "Shared test fixtures for serialization round-trips" but specifies no assertions. A concrete assertion would be: "Serialize a circuit with `circuit.metadata.models["NpnBJT"]["2N2222"] = { kind: "inline", params: { BF: 200 } }` → deserialize → `circuit.metadata.models["NpnBJT"]["2N2222"].params.BF === 200`." The crash-on-old-format requirement also has no test: "Deserializer throws when it encounters `namedParameterSets` key in the document."

---

## Concreteness Issues

**Issue 1 — T3+T4 "agent condition" wording is ambiguous about what "same agent" means.**

The spec says: "T3 must be immediately followed by T4 using the same agent. Do not mark T3 complete until T4's tests pass." This instruction is directed at the orchestrator, not at the implementing agent. But it appears in the spec body where an implementing agent reads it. An implementing agent reading "same agent" might interpret this as an instruction they cannot act on (they are already "the agent"). The instruction should be: "This task (T3) is not complete until T4 tests pass. Implement T4 immediately after T3 without handing off. Do not stop between T3 and T4."

**Issue 2 — T1's `defineModelParams()` return type is underspecified.**

The spec shows `defineModelParams()` returning `ParamDef[]` in one place and "returns both the `ParamDef[]` (schema) and a `Record<string, number>` of default values" in another. The actual signature is not given. Does it return a tuple? A named object `{ paramDefs, defaults }`? The design section code examples use only `ParamDef[]` as the type of `BJT_PARAM_DEFS`, yet the descriptive text says it returns two things. This is contradictory.

**Issue 3 — T3 does not define what happens when `model` property is absent or empty.**

The spec says "Read `model` property → look up `ModelEntry` in component's `modelRegistry`." It does not say what the compiler does when `model` is not set on an element (new element, loaded old circuit). Does it use `defaultModel`? Does it throw? This is a branch the implementing agent must decide on without guidance.

**Issue 4 — T3 does not specify the signature of the new compiler entry point.**

The current compiler is in `src/solver/analog/compiler.ts` and is called from `src/compile/compile.ts`. T3 rewrites the compiler's model-resolution path but does not say what the new function signature looks like, what parameters it drops (e.g., `subcircuitModels`, `modelLibrary`), or what the call site in `compile.ts` must change to. An agent implementing T3 will need to modify `compile.ts` but is not told to do so.

**Issue 5 — "Crashes on old-format fields" in T6 is not concrete.**

The spec says "Deserializer reads new format; crashes on old-format fields." What constitutes a crash? `throw new Error()`? An assertion? What exact fields trigger this? The verification-conditions list names the fields (`namedParameterSets`, `modelDefinitions`, `subcircuitBindings`) but T6 doesn't connect these to the crash requirement with a specific error message or mechanism.

**Issue 6 — Wave 2 post-wave check asks to "capture which tests are still failing" but gives no baseline.**

"Capture which tests are still failing (expected: everything except BJT and infrastructure)." An implementing agent cannot know whether "infrastructure" means the new type tests from T1, the T6 serializer tests, or something else. The wave post-check should name the specific test files expected to pass and the specific test files expected to fail.

**Issue 7 — T5 "Modified indicators" behavior is not concrete.**

T5 says "Modified indicators (compare against active model entry's defaults)." It does not say: what UI element shows the indicator (a dot? an asterisk? a color change?), where in the DOM/component tree it appears, or what the test assertion would look like. An implementer cannot verify this without additional context.

---

## Implementability Concerns

**Concern 1 — T2 is far too large for a single agent session as specified.**

The deletion table lists 17 items but the actual scope (per Gap 4 above) is at least 30+ locations across 15+ files, including app-layer files (`canvas-popup.ts`, `menu-toolbar.ts`, `test-bridge.ts`), compile-layer files (`partition.ts`, `extract-connectivity.ts`, `compile.ts`), IO files (`dts-serializer.ts`, `dts-deserializer.ts`), solver files (`default-models.ts`, `transistor-models/` directory), and all the test files for the deleted infrastructure. The spec warns that "state after wave: nothing compiles" — but an agent that follows only the listed deletions will leave half the old infrastructure intact, producing a partially broken state rather than a clean break. The T2 agent cannot complete the task without discovering callers through grep/search — the spec should list them all, or explicitly instruct the agent to grep for each deleted symbol and delete all call sites.

**Concern 2 — The Wave 2 post-wave check is not executable with only BJT migrated.**

"BJT tests pass end-to-end" is stated as the post-wave goal. But `src/compile/partition.ts` calls `modelKeyToDomain` from `registry.ts`, and `src/compile/extract-connectivity.ts` calls `getActiveModelKey`. After T2 deletes those functions, the entire compile pipeline is broken — including BJT compilation. T3 cannot restore the compile pipeline without also fixing `partition.ts` and `extract-connectivity.ts`. These files are not mentioned in T3's scope. An agent implementing T3 will fix `compiler.ts` but may not know to also fix the upstream compile files. BJT tests cannot pass until `partition.ts` and `extract-connectivity.ts` are also updated.

**Concern 3 — T1's partitioned PropertyBag (`getModelParam` / `setModelParam`) has no specification of the storage mechanism.**

The spec says model params are stored in a "partition" on `PropertyBag` that is "wholesale-replaced on model switch." It does not say how this partition is stored internally — a separate `Map`? A key-prefix convention? A separate field on `PropertyBag`? An agent implementing T1 must design the storage mechanism without guidance, and T3/T4 then depend on that design. If the T3/T4 agent is different from the T1 agent (as is possible under the parallel-agent model), they may make incompatible assumptions.

**Concern 4 — `src/solver/analog/default-models.ts` is not mentioned in any task.**

This file creates and exports `getTransistorModels()`, which returns a `SubcircuitModelRegistry`. It is called from `src/headless/default-facade.ts`, `src/app/canvas-popup.ts`, and `src/app/spice-model-library-dialog.ts`. After T2 deletes `SubcircuitModelRegistry`, `default-models.ts` is dead code with no replacement specified. CMOS gate subcircuits (`cmos-gates.ts`, `cmos-flipflop.ts`) and Darlington models (`darlington.ts`) are all registered through this file — after T2 their registration mechanism has no replacement. The spec does not say when or how these subcircuit registrations move to the new `modelRegistry` on `ComponentDefinition`.

**Concern 5 — Wave 3 (T7–T10) depends on patterns established in T4 for semiconductors other than BJT, including MOSFET, JFET, Diode, etc. But the CMOS gate subcircuit models (currently registered via `SubcircuitModelRegistry`) have no specified migration path in Wave 2 or Wave 3.**

T9 adds `"cmos"` entries with `kind: "netlist"` to gate components. But the netlist data currently lives in `transistor-models/cmos-gates.ts` and `transistor-models/cmos-flipflop.ts`, which construct `MnaSubcircuitNetlist` objects. After T2 deletes `SubcircuitModelRegistry`, these files are partially broken. T9 must rewrite them but is not scoped to do so. An agent implementing T9 would encounter unexpected compilation failures.

**Concern 6 — No test fixture file paths are specified for T1.**

The spec mandates: "All test files must import model entries, paramDefs, and PropertyBag construction from shared fixture modules." T1 creates these fixtures, but neither T1 nor any other task specifies the fixture file path, the exported names, or the shapes. Every subsequent task that writes tests (T4, T5, T6, T7–T10) depends on these fixtures. If T1 chooses names or paths that differ from what later agents expect, every later test will import nothing and fail silently.
