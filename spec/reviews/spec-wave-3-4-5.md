# Spec Review: Waves 3, 4, and 5 — Component Sweep, Runtime Features, Verification

## Verdict: needs-revision

---

## Plan Coverage

There is no separate `spec/plan.md` file. The spec (`spec/unified-model-params.md`) contains the plan inline under the "Migration" section. The review treats the Migration section tasks as the plan.

| Plan Task | In Spec? | Notes |
|-----------|----------|-------|
| T7: Remaining semiconductors | partial | Diode, MOSFET, JFET, Zener, Schottky, Tunnel diode, SCR, DIAC, TRIAC are listed. `triode.ts` and `varactor.ts` also exist in `src/components/semiconductors/` and both have `mnaModels` — they are absent from T7. |
| T8: Passives (Resistor, Capacitor, Inductor) | partial | Only three passives are listed. `crystal.ts`, `memristor.ts`, `polarized-cap.ts`, `potentiometer.ts`, `tapped-transformer.ts`, `transformer.ts`, `transmission-line.ts`, and `analog-fuse.ts` all exist in `src/components/passives/` and all have `mnaModels`. None are mentioned. |
| T9: Gates | yes | AND, OR, NAND, NOR, XOR, XNOR, NOT covered. |
| T10: Flip-flops | partial | Spec says "D flip-flop + any others with CMOS model entries." In reality `d.ts`, `d-async.ts`, `jk.ts`, `jk-async.ts`, `rs.ts`, `rs-async.ts`, `t.ts`, and `monoflop.ts` all exist. Of these, `d.ts` has both `mnaModels` and `simulationModel`; `jk.ts`, `rs.ts`, and `t.ts` have `mnaModels`. The phrase "any others with CMOS model entries" does not constitute a concrete enumeration — an agent must probe the repo to know the list. |
| T11: Runtime model registry | yes | Covered in Wave 4. |
| T12: Delta serialization | yes | Covered. |
| T13: Compound undo for model switch | partial | Mentioned but missing all implementation guidance. See Completeness Gaps. |
| T14: Unified import dialog | yes | Covered. |
| T15: Model dropdown | yes | Covered. |
| T16: Zero-occurrence verification | partial | List is incomplete. See Completeness Gaps. |
| T17: E2E test updates | partial | Surfaces listed but assertions are not specified. |

### Unplanned component categories entirely absent from the spec

The following directories contain source files with `mnaModels` and are not mentioned anywhere in Wave 3 or the Files Changed table:

- `src/components/active/` — 14 source files: `adc.ts`, `analog-switch.ts`, `cccs.ts`, `ccvs.ts`, `comparator.ts`, `dac.ts`, `opamp.ts`, `optocoupler.ts`, `ota.ts`, `real-opamp.ts`, `schmitt-trigger.ts`, `timer-555.ts`, `vccs.ts`, `vcvs.ts`
- `src/components/sources/` — 4 source files: `ac-voltage-source.ts`, `current-source.ts`, `dc-voltage-source.ts`, `variable-rail.ts`
- `src/components/sensors/` — 3 source files: `ldr.ts`, `ntc-thermistor.ts`, `spark-gap.ts`

These components have `mnaModels` on their `ComponentDefinition` and must be migrated to `modelRegistry` for the zero-occurrence checks in T16 to pass. The Wave 3 post-wave check requires "full test suite passes / zero test failures," which is impossible if 21 additional component files are left in the old format.

---

## Internal Consistency Issues

### 1. Wave 3 post-wave check contradicts incomplete scope (T7–T10)

The Wave 3 post-wave check states: "`npm run test:q` — full test suite must pass. Zero test failures."

Wave 3 only covers semiconductors, three passives, gates, and flip-flops. The `active/`, `sources/`, and `sensors/` components are not assigned to any wave task. After Wave 3 completes, those 21 files will still reference `mnaModels`, and any test that exercises those components will fail because Wave 2 (T2) deletes `mnaModels` from the type system entirely. The post-wave check goal is unreachable without an additional task covering the missing components.

### 2. T8 lists three passives but T2 deletes `mnaModels` from all ComponentDefinitions

T2 says: "remove `models.mnaModels` field from `ComponentModels`" as a type-system deletion. This will break all passives with `mnaModels`, not just Resistor, Capacitor, and Inductor. The seven additional passives (`crystal.ts`, `memristor.ts`, `polarized-cap.ts`, `potentiometer.ts`, `tapped-transformer.ts`, `transformer.ts`, `transmission-line.ts`) will compile-fail after T2 but have no assigned migration task.

### 3. T10 flip-flop scope is ambiguous against post-wave check

T10 says "D flip-flop + any others with CMOS model entries." The post-wave check requires the full test suite to pass. In practice, `jk.ts`, `rs.ts`, and `t.ts` have `mnaModels` entries. An agent that interprets "CMOS model entries" narrowly (only files with a `"cmos"` key today) may leave `jk.ts`, `rs.ts`, `t.ts` unmigrated, causing test failures. There is no existing CMOS entry on any flip-flop — the spec is creating them — so the conditional phrase gives no practical guidance.

### 4. T16 zero-occurrence list does not cover helpers deleted in T2

T2 explicitly deletes `getActiveModelKey()`, `availableModels()`, and `hasAnalogModel()` from `registry.ts`. These functions are actively used in `canvas-popup.ts`, `menu-toolbar.ts`, `test-bridge.ts`, `compile/extract-connectivity.ts`, and `compile/partition.ts`. The T16 zero-occurrence list does not include these symbols, so an agent running T16 will not verify they are gone. If any Wave 2–4 agent left a reference behind, T16 will not catch it.

---

## Completeness Gaps

### T7: No file paths, no test assertions, no acceptance criteria

T7 says: "Diode, MOSFET (NMOS/PMOS), JFET (N/P), Zener, Schottky, Tunnel diode, SCR, DIAC, TRIAC. `modelRegistry` + `defineModelParams()` per component. Factory reads `getModelParam()` directly. Shared paramDefs reference for models sharing a factory."

Missing:
- No file paths. The agent must discover them (e.g., `src/components/semiconductors/diode.ts`).
- No list of which params each component needs in its `paramDefs`. For example: what are the correct param keys for a Zener? For an SCR? For a DIAC/TRIAC?
- No test assertions. What should `diode.simulate()` return for given params? No expected numeric outputs.
- No acceptance criteria. "Compiles and simulates" is the only implied bar, but no specific circuit outcome is stated.
- `triode.ts` and `varactor.ts` are absent from the list entirely (see Plan Coverage).

### T8: No file paths, no param lists, no test assertions

T8 says: "Resistor, Capacitor, Inductor. `modelRegistry` + `defineModelParams()` per component."

Missing:
- No file paths (`src/components/passives/resistor.ts`, etc.).
- No param keys specified (e.g., `resistance`, `capacitance`, `inductance`). The spec shows a Resistor example in the Design section, but T8 does not reference it.
- Seven additional passives with `mnaModels` are omitted entirely.
- No test assertions.
- No acceptance criteria.

### T9: No file paths, no param lists for digital or CMOS entries

T9 says: "AND, OR, NAND, NOR, XOR, XNOR, NOT. `modelRegistry` with `"digital"` + `"cmos"` entries. Digital entries route to event-driven engine; CMOS entries are `kind: "netlist"`."

Missing:
- No file paths (`src/components/gates/and.ts`, etc.).
- No specification of what `DIGITAL_GATE_PARAM_DEFS` contains (e.g., `propDelay`). The AND gate example in the Design section shows `{ propDelay: 10e-9 }` but T9 does not reference it or confirm it applies to all seven gates.
- No specification of which CMOS netlists to use or where they come from. T9 says CMOS entries are `kind: "netlist"` but does not identify the netlist sources (`CmosAnd2Netlist`, etc.) or where they are defined/imported from.
- No test assertions for either digital or CMOS simulation paths.
- No acceptance criteria distinguishing digital engine routing from CMOS netlist routing.

### T10: No file paths, no complete component list, no param specs

T10 says: "D flip-flop + any others with CMOS model entries. Same pattern as gates."

Missing:
- No file paths.
- No explicit list of all flip-flop files requiring migration. "Any others with CMOS model entries" is not a concrete list — it requires the agent to perform discovery.
- `monoflop.ts` is not mentioned. It has `mnaModels`. An agent may miss it.
- No specification of what params flip-flops need (e.g., propagation delay).
- No test assertions.
- No acceptance criteria.

### T13: No implementation guidance for compound undo

T13 says: "Model switch is a single undoable operation. Undo restores previous model selection + entire param state."

The existing undo system (`src/editor/undo-redo.ts`) implements a simple command pattern: `EditCommand` with `execute()` and `undo()`. There is no compound command, no `GroupCommand`, no `BatchCommand` mechanism anywhere in the codebase. An agent implementing T13 must:
1. Decide whether to add a `CompoundCommand` class or implement model-switch as a single `EditCommand` that captures both old model key and old param partition.
2. Know where model switches are triggered in the UI (which file/method calls the undo stack).
3. Know the current shape of the model param partition to snapshot it.

None of this is in T13. The task provides only the desired outcome, not how to achieve it. A fresh agent with no project context cannot implement this from T13 alone.

Missing specifically:
- No description of how the compound operation should be implemented (single `EditCommand` that captures the full state? New `CompoundCommand` wrapper?).
- No file paths for where model-switch UI logic lives.
- No specification of what "entire param state" means in terms of data structure to snapshot/restore.
- No test assertions (e.g., "after undo, `props.getModelParam('BF')` returns the pre-switch value").
- No acceptance criteria.

### T16: Zero-occurrence list is incomplete

The T16 verification list does not include:

| Missing symbol | Why it must be checked |
|----------------|------------------------|
| `getActiveModelKey` | Deleted in T2; used in 4 non-test files currently |
| `availableModels` | Deleted in T2; used in `canvas-popup.ts` |
| `hasAnalogModel` | Deleted in T2; used in `registry.ts` |
| `modelKeyToDomain` | Deleted functionally (replaced by `modelRegistry` lookup); used in 5 non-test files |
| `models.mnaModels` (as a property access, not field declaration) | T16 lists it but only as a field declaration pattern; property accesses like `def.models.mnaModels?.[key]` in `canvas-popup.ts` and `extract-connectivity.ts` use the access pattern, not the declaration |
| `spice-subckt-dialog` (import references) | File is deleted in T2; any remaining import will break the build |

Additionally, `DeviceType` has a carve-out: "outside `src/solver/analog/model-parser.ts`." The list does not specify what the grep command should look like to implement this carve-out. An agent running a plain `grep -r "DeviceType"` will get false positives from the parser file and may interpret results incorrectly.

### T17: No specific test assertions

T17 says: "Update or add E2E tests for: Unified import dialog, Model dropdown with runtime entries, Model switch in property panel, Delta serialization round-trip."

Missing:
- No test file paths (new file? extend `e2e/gui/spice-import-flows.spec.ts`?).
- No specific assertions. For example: after importing `.MODEL 2N2222 NPN(BF=200)`, what exact DOM state should the test assert? What property panel value should be visible?
- No description of what a "delta serialization round-trip" test should do step by step.
- The three-surface testing rule (CLAUDE.md) requires headless API tests and MCP tool tests in addition to E2E. T17 only specifies E2E tests. There is no headless API test or MCP tool test specified for any Wave 4 or Wave 5 feature.

---

## Concreteness Issues

### 1. T7 component param definitions are absent

T7 references "the BJT pattern from T4" but T4 only specifies that BJT params come from `defineModelParams()`. It does not list the param keys for Diode, MOSFET, JFET, Zener, Schottky, Tunnel diode, SCR, DIAC, or TRIAC. An agent must guess or derive these from the existing `_spiceModelOverrides`-based implementation. This produces implementation variance across agents.

Concrete version would specify: for each component, the exact `primary` and `secondary` param keys, their types, units, and default values — matching what `defineModelParams()` will receive.

### 2. T9 CMOS netlist sources are unspecified

T9 says CMOS entries are `kind: "netlist"`. The AND gate example in the Design section references `CmosAnd2Netlist` with no indication of where this netlist is defined, whether it already exists, or whether the agent must create it. An agent implementing T9 faces an open question: does the CMOS netlist already exist? If not, what topology does it have? Where should the netlist object live in the source tree?

Concrete version would specify: for each gate, the netlist object name, its current file location (or that it must be created), and the pin mapping.

### 3. T13 "entire param state" is undefined

T13 says "Undo restores previous model selection + entire param state." The phrase "entire param state" is undefined. Does it mean the full `PropertyBag` model param partition? A `Record<string, number>` snapshot? The spec section on "Partitioned PropertyBag" describes that model params are wholesale-replaced on model switch, but T13 does not reference this or specify what data structure the undo command must capture.

### 4. Wave 4 post-wave check: "E2E tests pass" is not verifiable

The Wave 4 post-wave check states: "E2E tests pass. Import a `.MODEL`, save circuit, reload, verify model persists with correct params. Import a `.SUBCKT`, verify paramDefs differ from base component."

This is described as an orchestrator-mandated check, but it reads as a manual procedure, not a mechanical test command. Which E2E test file should the orchestrator run? Is this the test created in T17, or an existing test? The orchestrator cannot execute this check mechanically without a specific test command and a specific test name.

### 5. T16 grep commands are not specified

T16 says: "Run grep for every item in the verification conditions list. Zero hits required across entire codebase."

It does not specify:
- What grep pattern to use for each symbol (e.g., `"_spiceModelOverrides"` as a literal string, or as a property access pattern).
- Whether to include test files, or only production source.
- How to handle the `DeviceType` carve-out mechanically (e.g., `grep -r "DeviceType" src/ | grep -v "model-parser.ts"`).
- Which directories constitute "entire codebase" (src only? e2e? circuits/? scripts/?).

An orchestrator agent implementing T16 mechanically will make different choices than intended, potentially producing false negatives.

---

## Implementability Concerns

### 1. T7–T10: Wave 3 is blocked without a complete component inventory

All Wave 3 tasks instruct agents to use "the BJT pattern from T4 as template" and apply it to listed components. But the component lists are incomplete (21 files across `active/`, `sources/`, `sensors/` plus extras in `passives/` and `semiconductors/`). The Wave 3 post-wave check requires zero test failures, but agents will complete their assigned components and hand off — they won't know to check `active/` because it's not in their task. The orchestrator also has no task to assign those components to.

Result: the post-wave check will fail because no agent was ever assigned the missing components, and there is no task they can be deferred to.

### 2. T13 requires knowledge of the undo integration point

The current undo system is a clean command pattern (`UndoRedoStack.push(command)`). There is no compound command support. An agent implementing T13 must:
- Find where in the UI code model switches are currently triggered (not specified in T13).
- Decide how to implement the compound behavior (two options: single command that captures the snapshot, or new CompoundCommand class — both require architectural decisions not addressed in the spec).
- Know the full shape of the model param partition to snapshot it (not referenced in T13; the relevant API is `setModelParam`/`getModelParam` on PropertyBag, described elsewhere in the spec but not linked from T13).

A fresh agent cannot complete T13 without reading substantial portions of the spec and codebase that T13 does not reference.

### 3. Three-surface testing rule is not satisfied for any Wave 4 feature

CLAUDE.md mandates: "Every user-facing feature MUST be tested across all three surfaces: Headless API test, MCP tool test, E2E / UI test."

Wave 4 introduces four user-facing features: runtime model registry (T11), delta serialization (T12), compound undo (T13), and unified import dialog (T14). The spec specifies:
- T17 covers E2E tests for T11/T12/T14/T15.
- No headless API tests are specified for any Wave 4 task.
- No MCP tool tests are specified for any Wave 4 task.

The three-surface rule is not mentioned anywhere in the spec. Agents implementing Wave 4 will produce code that satisfies the spec but violates CLAUDE.md. The post-wave check ("E2E tests pass") does not catch this gap.

### 4. T11 import code location is unspecified

T11 says: "Import code creates `ModelEntry`: `.MODEL` copies factory + paramDefs from component's default entry; `.SUBCKT` derives paramDefs from subcircuit parameter declarations."

It does not identify which file contains the import code that must be modified. The Files Changed table lists `src/app/spice-model-apply.ts` and `src/io/spice-model-builder.ts` as relevant, but T11 does not reference either. An agent reading only T11 will not know where to implement the change.

### 5. T14 "primary/secondary assignment step" for `.SUBCKT` is underspecified

T14 says: "`.SUBCKT` imports: paramDefs derived from subcircuit declarations, primary/secondary assignment step."

It does not describe:
- What UI element implements the assignment step (a second dialog? inline in the import dialog?).
- How the user makes the primary/secondary designation.
- What data structure is written as a result.
- How an agent should test this step.

This is a non-trivial UI feature described in one clause. A fresh agent cannot implement it from this description.

### 6. Wave 3 "all tasks parallel" conflicts with test suite dependency

The spec says "All tasks parallel" for Wave 3. However, if an agent implements T8 (passives) and runs `npm run test:q`, the test suite will be in an intermediate broken state because `active/`, `sources/`, and `sensors/` components still have `mnaModels`. The parallelism assumption is only safe if every component with `mnaModels` is assigned to some parallel agent. Currently, no agent is assigned the 21 missing components. If those missing files cause compilation errors, all parallel Wave 3 agents will be working in a broken build.

---

## Summary of Missing Components Not in Any Wave Task

For completeness, the following files have `mnaModels` and are not assigned to any migration task:

**Semiconductors (T7 omissions):**
- `src/components/semiconductors/triode.ts`
- `src/components/semiconductors/varactor.ts`

**Passives (T8 omissions):**
- `src/components/passives/crystal.ts`
- `src/components/passives/memristor.ts`
- `src/components/passives/polarized-cap.ts`
- `src/components/passives/potentiometer.ts`
- `src/components/passives/tapped-transformer.ts`
- `src/components/passives/transformer.ts`
- `src/components/passives/transmission-line.ts`
- `src/components/passives/analog-fuse.ts` (has `mnaModels` in test file; source file needs checking)

**Active (no task assigned):**
- `src/components/active/adc.ts`
- `src/components/active/analog-switch.ts`
- `src/components/active/cccs.ts`
- `src/components/active/ccvs.ts`
- `src/components/active/comparator.ts`
- `src/components/active/dac.ts`
- `src/components/active/opamp.ts`
- `src/components/active/optocoupler.ts`
- `src/components/active/ota.ts`
- `src/components/active/real-opamp.ts`
- `src/components/active/schmitt-trigger.ts`
- `src/components/active/timer-555.ts`
- `src/components/active/vccs.ts`
- `src/components/active/vcvs.ts`

**Sources (no task assigned):**
- `src/components/sources/ac-voltage-source.ts`
- `src/components/sources/current-source.ts`
- `src/components/sources/dc-voltage-source.ts`
- `src/components/sources/variable-rail.ts`

**Sensors (no task assigned):**
- `src/components/sensors/ldr.ts`
- `src/components/sensors/ntc-thermistor.ts`
- `src/components/sensors/spark-gap.ts`

**Flip-flops (T10 under-enumerated):**
- `src/components/flipflops/d-async.ts`
- `src/components/flipflops/jk.ts`
- `src/components/flipflops/jk-async.ts`
- `src/components/flipflops/rs.ts`
- `src/components/flipflops/rs-async.ts`
- `src/components/flipflops/t.ts`
- `src/components/flipflops/monoflop.ts`
