# Spec Review: Model System Unification (Waves 0-12)

## Verdict: needs-revision

---

## Wave/Section Coverage Check

This spec has no plan.md. Per the special instructions, this section checks that every wave's "Files" column matches files discussed in the spec, that every spec section maps to at least one wave, and that the Implementation Priority table is internally consistent.

| Wave | Files Column vs. Spec Discussion | Notes |
|------|----------------------------------|-------|
| 0 | `netlist.ts`, `compiler.ts`, `flatten.ts`, ~40 test sites | Files discussed in Bug B1/B2 sections. Consistent. |
| 1 | `registry.ts`, `extract-connectivity.ts`, `compile.ts`, `digital/compiler.ts` | Discussed in "Model Resolution Chain" and "Single Canonical Infrastructure Set". Consistent. |
| 2 | `compile.ts`, `flatten.ts` | Discussed in "Pipeline Ordering". Consistent. |
| 3 | `compiler.ts` | Discussed in "Dead Code Removal". Inconsistent — `flatten.ts` also needs `resolveCircuitDomain` removed (H9) yet is absent from Wave 3 files column. |
| 4 | "All heuristic site files" | H1-H15 list specific files. Files column is too vague (see CN-1). |
| 5 | "All component files" | 139 claimed; actual non-test component files = 144, with `models:` occurrences across 144 files. Count is wrong. |
| 6 | `compile.ts`, `compiler.ts`, `circuit.ts`, `save-schema.ts` | `circuit.ts` not discussed in spec body — file path ambiguous (see IC-6). |
| 7 | `property-panel.ts`, `canvas-popup.ts` | Discussed in "Parallel Stream: UI". Consistent. |
| 8 | `menu-toolbar.ts`, context menu, rendering | "context menu" and "rendering" are not file paths (see CN-2). |
| 9 | `save-schema.ts`, `save.ts`, `load.ts`, `dts-serializer.ts` | `dts-deserializer.ts` omitted (loads overrides on read path). |
| 10 | `model-parser.ts` (extend), new `subcircuit-builder.ts` | New file `subcircuit-builder.ts` has no directory path (see CG-3). |
| 11 | New UI files, `canvas-popup.ts` context menu | "New UI files" names no actual file paths (see CG-4). |
| 12 | `save-schema.ts`, `dts-schema.ts`, `save.ts`, `load.ts`, `dts-serializer.ts`, `dts-deserializer.ts` | Discussed in "Storage and Serialization". Consistent. |

**Spec sections with no wave mapping:**
- "Subcircuit Propagation Rules" — 5 rules described, no wave implements or tests them
- "'Analog Wins' Label Precedence" — marked "Preserved unchanged" but no wave verifies it survives the rewrites
- "Migration / Runtime: Zero-Cost" — the backward-compatible `simulationMode` fallback read path is described but no wave implements it (see IM-6)

---

## Internal Consistency Issues

### IC-1: Wave 3 and Wave 4 both claim ownership of H9 (`resolveCircuitDomain` deletion)

Wave 3 description: "Delete dead code: ... `resolveCircuitDomain`". Wave 3 files column lists only `compiler.ts` but `resolveCircuitDomain` lives in `flatten.ts`.

H9 in the heuristic sites table: `src/solver/digital/flatten.ts:158-176 | resolveCircuitDomain() | Delete function` — listed under the H1-H15 section which Wave 4 covers.

The same deletion is implicitly assigned to both Wave 3 (by the dead code table) and Wave 4 (by the H9 entry). An implementer cannot determine which wave owns the deletion without noticing the cross-reference. `flatten.ts` is also missing from Wave 3's files column.

### IC-2: Wave 5 parallelization after Wave 1 is unsafe

The spec states: "Wave 5 (ComponentModels restructure) can start after Wave 1."

Wave 5 transforms all component files from `analog: { factory: ... }` to `mnaModels: { behavioral: { factory: ... } }`. Waves 2-4 reorder the pipeline and rewrite the compiler to read `mnaModels`. If Wave 5 runs in parallel with Waves 2-4, there is an extended window where component files declare `mnaModels` but the compiler still reads `analog` — the entire analog simulation subsystem is broken until Wave 4 completes. Wave 5 is only safe to start after Wave 4, not Wave 1. This is a blocking error in the parallelization plan.

### IC-3: `pinElectrical` migration ownership is unassigned

The spec states `pinElectrical` and `pinElectricalOverrides` must move off `AnalogModel` (which becomes `MnaModel`) and onto `ComponentDefinition`. Verification confirms these fields are currently on `AnalogModel` in `src/core/registry.ts:193-194`. No wave explicitly removes them from `AnalogModel` or adds them to `ComponentDefinition`. Wave 1 creates the new `MnaModel` interface; Wave 5 migrates component files. Neither wave specifies who performs the `pinElectrical` field migration on `AnalogModel`/`ComponentDefinition` interfaces.

### IC-4: Wave 9 omits `dts-deserializer.ts`

Wave 9 saves and loads `digitalPinLoading` and per-net overrides. The files column lists `dts-serializer.ts` but not `dts-deserializer.ts`. Without updating the deserializer, the load path does not apply the saved overrides. The round-trip test would fail.

### IC-5: `spiceModels` field referenced in UI section but never defined in serialization schema

The `.MODEL` Import Flow UI section states: "Also adds the raw text to `circuit.metadata.spiceModels` so it persists and can be reused." The `SavedMetadata` additions block defines only `digitalPinLoading` and `digitalPinLoadingOverrides` — `spiceModels` is never added to `SavedMetadata`. `namedParameterSets` in `DtsDocument` serves a related purpose but is not on `circuit.metadata`. These two representations are not reconciled.

### IC-6: `spiceSubcircuits` field referenced in UI section but never defined

The `.SUBCKT` User Import UI section states: "Stores raw text in `DtsDocument.spiceSubcircuits`." The DTS schema additions block defines `modelDefinitions` and `namedParameterSets` — no `spiceSubcircuits` field is defined. This is a dead reference.

### IC-7: Wave 6 references `circuit.ts` — file not discussed anywhere in spec body

Wave 6 files column includes `circuit.ts`. No section of the spec discusses `circuit.ts` as requiring changes for `digitalPinLoading`. The `CircuitMetadata` type is never attributed to a specific file path. The file could be `src/core/circuit.ts`, `src/app/circuit.ts`, or elsewhere — an implementer must guess.

### IC-8: `getActiveModelKey()` spec pseudocode does not implement the migration fallback it promises

The "Migration / Runtime: Zero-Cost" section states `getActiveModelKey()` will "check both `simulationModel` and `simulationMode` keys, preferring `simulationModel`." The `getActiveModelKey()` function shown in the spec body checks only `el.getAttribute('simulationModel')` — no `simulationMode` fallback is present. The pseudocode and the migration prose directly contradict each other.

---

## Completeness Gaps

### CG-1: Wave 4 has no file list

Wave 4 files column reads "All heuristic site files." There are 15 sites across at least 8 different files. An implementer cannot scope the work from the table alone. The concrete file list from H1-H15 is: `src/compile/compile.ts` (H1), `src/app/menu-toolbar.ts` (H2, H3), `src/app/test-bridge.ts` (H4), `src/app/canvas-popup.ts` (H5), `src/compile/partition.ts` (H6, H7, H8), `src/solver/digital/flatten.ts` (H9), `src/solver/analog/compiler.ts` (H10-H15).

### CG-2: Wave 5 has no per-pattern component list and no acceptance criteria for completeness

Wave 5 migrates "139 component files" but provides no authoritative list of which components belong to which pattern. The spec uses approximations ("~80 components," "~35 components," "~35 components") that sum to ~158, inconsistent with the 139 claim and the verified 144-file count. There is no acceptance criterion for knowing when all files are migrated.

Edge cases not covered by patterns A-E:
- `src/components/pld/diode.ts` — contains 3 separate `ComponentDefinition` exports (PldDiode, PldDiodeForward, PldDiodeBackward), all digital-only. Pattern A applies but the file structure (multiple exports per file) is not addressed.
- `src/components/switching/fgpfet.ts`, `fgnfet.ts`, `nfet.ts`, `pfet.ts`, `trans-gate.ts` — FET switching components with analog models, not listed under any pattern.
- `src/components/passives/analog-fuse.ts` — separate file from `switching/fuse.ts`, pattern unspecified.
- `src/components/library-74xx.ts` — contains 2 `models:` declarations; file structure not addressed.

### CG-3: `subcircuit-builder.ts` (Wave 10) has no directory path

Wave 10 creates a new `subcircuit-builder.ts` file. No directory is specified. Given the project structure, the implementer cannot determine whether this belongs in `src/solver/analog/`, `src/compile/`, `src/io/`, or elsewhere.

### CG-4: Wave 11 "New UI files" are unnamed

Three UI flows are described (`.MODEL` import dialog, `.SUBCKT` import dialog, circuit-level model library dialog) with no file names. An implementer cannot create the files without inventing paths.

### CG-5: Wave 6 test assertions are not specific enough

Three-Surface Testing for Wave 6: "Compile with each loading mode, verify bridge adapter presence/absence/parameters." This does not specify: what circuit topology to use, what numerical bridge adapter counts are expected, or what specific matrix stamps differ between modes. The rules require "specific assertions described (not just 'test that it works')."

### CG-6: "Subcircuit Propagation Rules" section has no implementing wave

Five rules governing how model assignments interact with subcircuit host elements are stated. No wave implements or tests them. If these are currently implemented, the spec must say so and reference the existing code. If new code is required, a wave must be assigned.

### CG-7: Wave 0 test file list is incomplete

Wave 0 renames ~40 `simulationMode` occurrences. Verification shows 117 occurrences across 12 files. The Test Migration section names only `analog-compiler.test.ts` and `lrcxor-fixture.test.ts`. `src/headless/__tests__/port-analog-mixed.test.ts` (which calls `compileAnalogCircuit` and uses `simulationMode`) is not in the list but will require changes in both Wave 0 and Wave 3.

---

## Concreteness Issues

### CN-1: Wave 4 files column is not a list of file paths

"All heuristic site files" is not implementable without reading the H1-H15 table. The table should be the source of truth but the wave entry should at minimum enumerate the files for quick scoping.

### CN-2: Wave 8 "context menu" and "rendering" are not file paths

The spec body references `menu-toolbar.ts` for some context menu work (H2, H3) and `RenderContext` for pin loading indicator rendering, but never names the file that hosts pin loading rendering. A concrete version would name the file (e.g., the component render pass file) where the indicator drawing code lives.

### CN-3: Wave 11 E2E test assertions are insufficiently specific

"Import `.MODEL` dialog → paste text → verify parse preview → apply → verify SPICE panel shows values" does not specify: which component, what text to paste, what values should appear, or how the test locates the dialog element. A concrete version would specify exact model text, exact expected field values, and the DOM locator strategy.

### CN-4: `stableNetId` sorting on `elementIndex` (not `instanceId`) may be unstable across loads

The `stableNetId` helper sorts `group.pins` by `(elementIndex, pinIndex)` and uses the first entry as the canonical pin. `elementIndex` is a positional index into the `elements` array — it is not stable across save/load if element ordering changes during deserialization. The spec states `instanceId` is the stable identifier, yet the sorting key uses `elementIndex`. The spec should either: (a) confirm that element ordering is preserved across serialization, or (b) sort by `(instanceId, pinLabel)` lexicographically instead, which is unambiguously stable. As written, the implementation will produce non-reproducible canonical pins in circuits where element order changes.

### CN-5: `getActiveModelKey()` diagnostic emission attributed to "caller" without naming callers

"A diagnostic is emitted by caller" does not specify which of the multiple call sites emits diagnostics. The spec must name the single location responsible (expected to be `resolveModelAssignments()`) so only one diagnostic is emitted per invalid key, not one per call site.

### CN-6: Wave 6 acceptance criterion "all three modes produce correct behavior" is not verifiable

This passes any implementation that compiles without crashing. A verifiable criterion names the circuit, the expected bridge adapter topology, and the measurable difference in simulation output between modes.

### CN-7: `.SUBCKT` element `X` (subcircuit instance) expansion is undefined

The element mapping table lists `X | Subcircuit instance | Recursive expansion` with no further detail. The spec does not state: whether referenced subcircuits must be pre-registered before the builder runs, what error to emit if a referenced subcircuit is missing, or whether `parseSubcircuit()` is called recursively. This is a required implementation decision left to the implementer.

---

## Implementability Concerns

### IM-1: Wave 5 is too large for a single agent session

With 144 files to migrate (not 139), each requiring pattern classification, plus unlisted edge cases (`fgpfet.ts`, `fgnfet.ts`, `nfet.ts`, `pfet.ts`, `trans-gate.ts`, `analog-fuse.ts`, multi-export files), and with no automated tooling described, Wave 5 is unreasonably large for a single session. The spec should split Wave 5 into sub-waves by component category (e.g., 5a: gates+flipflops, 5b: passives+sources, 5c: semiconductors, 5d: IO+wiring) or specify a codemods-based approach.

### IM-2: Wave 3 dead code deletion has insufficient safety criteria

The spec's only verification criterion for Wave 3 is "All analog tests pass via `compileAnalogPartition`." The following is unspecified:
1. Whether `compileAnalogPartition` is a complete functional replacement — the two functions have different call signatures and the spec acknowledges some tests call `compileAnalogCircuit` directly.
2. The order in which tests must be rewritten before the deletion (delete first, then rewrite? Rewrite first, then delete?).
3. That `port-analog-mixed.test.ts` also calls `compileAnalogCircuit` and must be included in the rewrite list (it is not currently named in the test migration section).

### IM-3: `stableNetId` depends on `ConnectivityGroup.pins` interface that is not quoted

The helper accesses `group.pins` as `Array<{ elementIndex: number; pinIndex: number }>`. The spec does not confirm this matches the actual runtime interface. An implementer must independently verify `ConnectivityGroup` in `src/compile/extract-connectivity.ts` before implementing the helper. The spec should quote or reference the interface definition.

### IM-4: Wave 10 `.SUBCKT` builder requires `ComponentRegistry` access — not specified

The builder maps SPICE element prefixes to registered component types. It must query a `ComponentRegistry` to find Resistor, BJT, MOSFET, etc. definitions. The spec does not state how the builder obtains a registry instance (parameter, singleton, import). This is a required architectural decision absent from the spec.

### IM-5: Wave 12 does not address DTS format version management

Wave 12 adds `modelDefinitions` and `namedParameterSets` to `DtsDocument`. The existing `validateDtsDocument()` performs version checking. The spec does not state whether the DTS version number should be incremented, and if so, what value. If not incremented, existing validation code may reject or silently drop the new fields. If incremented, previously saved `.dts` files require a migration path. Neither case is addressed.

### IM-6: `simulationMode` backward-compatibility fallback has no implementing wave

The migration section describes `getActiveModelKey()` reading both `simulationModel` and `simulationMode`, but the function pseudocode only reads `simulationModel`. No wave is assigned to implement the fallback. Old files that have `simulationMode` set will silently use the default model after Wave 1, ignoring the user's saved choice. This is a silent data loss on load of pre-existing circuits.

### IM-7: Wave 5 safe start gate is Wave 4, not Wave 1

An implementer following the spec's parallelization guidance ("Wave 5 can start after Wave 1") will transform component files to `mnaModels` while Waves 2-4 (which rewrite the compiler to read `mnaModels`) are still in progress. The analog simulation subsystem will be completely broken in this window. The spec must change the gate from "after Wave 1" to "after Wave 4."

---

## CLAUDE.md Rules Compliance

### Three-Surface Testing Rule

The spec includes a "Three-Surface Testing Requirements" section covering all waves. However, all three surfaces for most waves lack specific assertions (see CG-5, CN-3, CN-6). The surface coverage exists structurally but the test descriptions are uniformly below the concreteness bar required by CLAUDE.md.

Additionally, the test description for Waves 7-9 groups three waves into one block, making it impossible to know which specific tests belong to Wave 7, Wave 8, and Wave 9 respectively. Waves 7-9 cover different features (model selector, pin loading menu, save/load), which should have separate test entries.

### Engine-Agnostic Editor Rule

The spec is consistent with this rule. Model resolution is in the compiler pipeline. UI changes (Waves 7-8) use compiler-layer functions (`getActiveModelKey()`, `modelKeyToDomain()`). Pin loading indicators use `RenderContext`. No violations found.

### Never Read .dig XML Rule

The spec does not involve reading `.dig` XML for topology. No violations found.

---

## Issue Tally

| Dimension | Issues |
|-----------|--------|
| Wave/section coverage gaps | 3 unmapped sections |
| Internal consistency issues | 8 (IC-1 through IC-8) |
| Completeness gaps | 7 (CG-1 through CG-7) |
| Concreteness issues | 7 (CN-1 through CN-7) |
| Implementability concerns | 7 (IM-1 through IM-7) |

---

## Blocking Issues (must fix before implementation)

### BLOCKING-1: `simulationMode` vs `simulationModel` naming split

The analog compiler reads property key `"simulationMode"` at 5 sites (`analog/compiler.ts:834,937,1286,2030`, `flatten.ts:228`). The property panel, canvas-popup, and extract-connectivity all use `"simulationModel"`. These are **different PropertyBag keys** — the UI dropdown writes `simulationModel` but the analog compiler never reads it.

The spec proposes `getActiveModelKey()` reading `simulationModel`, which would leave the analog compiler's 5 `simulationMode` reads broken.

**Fix:** Acknowledge as Bug B2. Decide the canonical key name, list all sites requiring rename, and ensure `getActiveModelKey()` replaces both.

### BLOCKING-2: Resolution chain omits `forceAnalogDomain` override

`extract-connectivity.ts:96-101` has a `forceAnalogDomain` override that silently flips dual-model components from `"digital"` to `"analog"` when `engineType === 'analog'`. This is a fifth step in the resolution chain not mentioned in the spec.

Critical interaction: if a user sets `simulationModel = "digital"` on an element but `circuitDefaultDomain = "analog"`, should the per-instance choice be respected or overridden? The current code overrides it.

**Fix:** Specify how `circuitDefaultDomain` interacts with `forceAnalogDomain`. Define precedence explicitly.

### BLOCKING-3: `modelKeyToDomain()` doesn't handle keys the spec relies on

`modelKeyToDomain()` (`extract-connectivity.ts:128-131`) maps `"digital"` and `"analog"` but returns `"neutral"` for everything else. The spec's H5 rewrite uses model keys `"logical"`, `"analog-pins"`, `"analog-internals"` — all of which would be classified as `"neutral"`.

**Fix:** Spec must define the updated `modelKeyToDomain()` mapping that covers all known model keys.

---

## Quality Issues (should fix for better implementation)

### SHOULD-FIX-1: 7 of 11 heuristic sites have drifted from spec description

The spec claims all 11 sites use `hasAnalogModel(def) && !hasDigitalModel(def)`. Only H1-H4 exactly match. The other 7 have diverged:

| Site | Actual Pattern |
|------|---------------|
| H5 | Already partially rewritten — uses `hasDigitalModel` + `simulationModel` check |
| H6 | `hasAnalogModel(def)` only, no `!hasDigitalModel` guard |
| H7 | `!hasDigitalModel(def)` only |
| H8 | Inverted: `hasDigitalModel && !hasAnalogModel` |
| H9 | Split into two flag variables |
| H10 | Uses `def.models?.analog === undefined` directly |
| H11 | Uses `def.models?.analog !== undefined` directly |

**Fix:** Update the heuristic table to show actual current expressions. Mark H5 as partially complete.

### SHOULD-FIX-2: At least 3 unlisted heuristic sites

The analog compiler has additional sites not covered by H1-H11:
- `analog/compiler.ts:804-806, 909-912` — inline `def.models?.analog !== undefined` checks
- `analog/compiler.ts:1276-1278, 2023-2025` — inline `hasAnalogModel`/`hasBothModels` patterns with `simulationMode` reads

**Fix:** Add H12-H14 to the inventory with actual line numbers and expressions.

### SHOULD-FIX-3: Subcircuit domain propagation unspecified

`resolveCircuitDomain()` is called recursively for subcircuit internals. The spec doesn't address:
- Whether parent's `defaultDomain` propagates to child circuits
- The `simulationMode` attribute on subcircuit host elements (`flatten.ts:228`)
- Whether `deriveCircuitDomain` needs parent circuit metadata

**Fix:** Add a "Subcircuits" section specifying propagation rules.

### SHOULD-FIX-4: No handling for invalid `simulationModel` values

What happens when `simulationModel` is set to a key that doesn't exist in `def.models`? Current code falls back to `neutral` with `model: null`. The proposed `getActiveModelKey()` doesn't define this.

**Fix:** Specify fallback behavior (continue down chain? emit diagnostic?).

### SHOULD-FIX-5: Three-surface testing rule not satisfied

Per `CLAUDE.md`, every feature needs headless API, MCP tool, and E2E tests. P5 just says "Tests + docs — Multiple".

**Fix:** Break P5 into:
1. Headless: unit tests for `getActiveModelKey()` and `deriveCircuitDomain()` covering full resolution chain
2. MCP: `circuit_compile` and `circuit_netlist` honor `defaultDomain`
3. E2E: bulk domain menu + per-component dropdown produce correct compilation

### SHOULD-FIX-6: Undo/redo for bulk domain setting

Bulk domain menu operations mutate `circuit.metadata.defaultDomain`. Without undo integration, users can't revert accidental changes.

**Fix:** State whether this is undoable and which mechanism it uses.

---

## Informational

### INFO-1: File paths are bare/ambiguous

The spec uses bare filenames (`canvas-popup.ts:84`, `netlist.ts:393`) instead of full paths (`src/app/canvas-popup.ts:84`, `src/headless/netlist.ts:393`). Use full relative paths consistently.

### INFO-2: `SavedMetadata.engineType` vs `defaultDomain` overlap

`save-schema.ts` already has `engineType?: string`. The spec adds `defaultDomain?: string`. Clarify the relationship — is `engineType` being superseded? Should old files with `engineType: "analog"` migrate to `defaultDomain`?

### INFO-3: "Model changes force recompilation" — no enforcement location

Design Principle 3 states this but no implementation task covers it. If already wired up via property-panel callbacks, say so. If not, add a task.

### INFO-4: `hasAnalogModel`/`hasDigitalModel` are not fully "replaced"

These remain needed as low-level predicates inside `getActiveModelKey` and `deriveCircuitDomain`. Say "no longer called at heuristic sites" rather than "replaced."

### INFO-5: H5 rewrite's `showSpiceModelParameters(...)` is out of scope

Mark explicitly as future/out-of-scope to avoid shipping dead code.

---

## Verified Claims (no issues)

- **Bug B1** (`netlist.ts:393` reads `'defaultModel'` instead of `'simulationModel'`) — confirmed real
- **21+ dual-model components** — confirmed (AND, Switch, Ground, LED all verified with both `models.digital` and `models.analog`)
- **Resolution chain** (3-step current: simulationModel > def.defaultModel > first key) — accurate
- **Backward compatibility** via absent `defaultDomain` — sound
- **Priority ordering P0-P5** — well structured
- **Performance** of per-element `getActiveModelKey` — negligible, not a concern
