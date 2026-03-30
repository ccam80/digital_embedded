# Spec Review: Wave 4 — Verification + Test Audit

## Verdict: needs-revision

---

## Plan Coverage

No external plan.md exists. This is a self-contained combined spec. Wave 4 declares four tasks (4.1–4.4). All four are present in the spec. Evaluation below is on internal quality only.

| Spec Task | Present? | Notes |
|-----------|----------|-------|
| 4.1 Zero-occurrence verification (T20) | yes | Grep protocol present; several symbol claims are factually wrong per codebase check |
| 4.2 Test audit cleanup — broken imports | yes | 4 files listed; claim is partially wrong (production files also import from deleted module) |
| 4.3 Centralize shared fixtures | yes | Counts (~56 stubs, ~40 registry builders) are not accurate; `src/test-fixtures/` already partially exists |
| 4.4 E2E test updates (T21) | yes | Acceptance criteria are critically vague; three-surface requirement not enforced per-feature |

---

## Internal Consistency Issues

### Issue 1: Task 4.1 lists symbols that cannot be zero-hit — contradicting 4.2 and 4.3's own scope

Task 4.1 requires zero hits for `_spiceModelName`, `namedParameterSets`, `_spiceModelOverrides`, `_modelParams`, `subcircuitBindings`, `modelDefinitions`, `simulationModel`, `models.mnaModels`, `subcircuitRefs`, and `availableModels`. However:

- Task 4.2 instructs the implementer to fix test files that import `BJT_NPN_DEFAULTS` et al. Those tests exist and reference `_spiceModelName` and `namedParameterSets` as currently living test assertions (e.g. `spice-import-roundtrip-mcp.test.ts` contains `circuit.metadata.namedParameterSets!['Q2N2222']`). Task 4.1 demands these return zero hits; Task 4.2 does not say to delete those assertions, only to fix the broken `model-defaults` import. The two tasks directly contradict each other for `_spiceModelName` and `namedParameterSets`: 4.1 says zero, 4.2 preserves them.

- `simulationModel`, `models.mnaModels`, `subcircuitRefs`, and `availableModels` all have legitimate, intentional live uses in production and test code (gate components, netlist formatters, `src/core/registry.ts`). The spec does not explain whether these symbols should be zero in their current form or only in specific contexts. Requiring blanket zero hits will either fail immediately or force deletion of valid production code.

### Issue 2: Task 4.1 bridge-adapter verification conditions contradict codebase state created by Wave 1

Task 4.1 specifies:

> `grep -rn "branchIndex.*=.*-1" src/solver/analog/bridge-adapter.ts` — zero hits for BridgeOutputAdapter (it uses a branch variable). BridgeInputAdapter still has `branchIndex = -1` (no branch).

The live codebase shows `bridge-adapter.ts` line 49: `readonly branchIndex: number = -1;` and line 213: `readonly branchIndex: number = -1;`. Both adapters still use `-1`. Additionally, line 50: `readonly isNonlinear: true = true;` remains, and lines 31–105 of `bridge-adapter.ts` contain Norton-equivalent language throughout comments and stamps. The Wave 1 rewrite claimed by the spec has not been completed. Task 4.1's verification conditions assume Wave 1 work is done; if it is not, the implementer will find non-zero hits and have no instruction for what to do — is this a Wave 4 fix or a Wave 1 regression?

The spec is internally inconsistent: it presents Task 4.1 as a pure verification wave ("run grep, zero hits required, any remaining references are bugs — fix before closing") while the codebase evidence shows Wave 1 items are unfinished. This means Task 4.1 will immediately produce fix work that is outside its stated scope.

### Issue 3: Task 4.3 asserts `src/test-fixtures/` does not exist, but it already does

Task 4.3 says "Files to create: `src/test-fixtures/test-element.ts`" and lists four new files. However, `src/test-fixtures/model-fixtures.ts` already exists in the codebase. The spec does not acknowledge this file, does not say whether it should be modified, and does not say whether the new fixtures should be collocated with it or replace it. An implementer will find a pre-existing `src/test-fixtures/` directory and have no guidance on how to handle `model-fixtures.ts`.

---

## Completeness Gaps

### Gap 1: Task 4.1 — no instruction for what to do when a symbol has non-zero hits

The acceptance criteria state: "Any remaining references are bugs — fix before closing." This is the entire fix specification. There is no guidance on:
- Which files to edit
- What the replacement code should look like
- Whether the fix is a deletion, a rename, or a refactor
- Which symbols are expected to have zero hits versus which are expected to remain with scoped exceptions

For symbols like `simulationModel`, `subcircuitRefs`, `models.mnaModels`, and `availableModels` (all of which have live intentional uses), the spec provides no path forward. An implementer running 4.1 will find hits and have no actionable spec text to follow.

### Gap 2: Task 4.1 — `setParam?` verification condition is inverted

The spec states:

> `grep -rn "setParam?" src/core/analog-types.ts` — zero hits (setParam is required)

The live file at line 122 reads: `setParam?(key: string, value: number): void;` — the `?` marks it optional. The spec intends this to be made required (non-optional). But the grep for `setParam?` in shell context is ambiguous: the `?` is a glob wildcard in most shells, matching `setParam` followed by any single character or zero characters. The grep command as written will not correctly detect the optional marker. Additionally, the acceptance criterion says "zero hits" but the intent is that the optional `?` marker is removed — meaning the correct state is that `setParam` exists without `?`, not that the entire symbol is absent. This is contradictory: zero hits of `setParam?` means either the file was deleted or the optional marker was removed. The spec does not distinguish these two outcomes.

### Gap 3: Task 4.2 — production files importing `model-defaults.ts` are not listed

The spec lists 4 test files to fix. The codebase grep reveals 7 production files also import from `model-defaults.ts`:
- `src/components/semiconductors/diode.ts` — imports `DIODE_DEFAULTS`
- `src/components/semiconductors/mosfet.ts` — imports `MOSFET_NMOS_DEFAULTS`, `MOSFET_PMOS_DEFAULTS`
- `src/components/semiconductors/njfet.ts` — imports `JFET_N_DEFAULTS`
- `src/components/semiconductors/pjfet.ts` — imports `JFET_P_DEFAULTS`
- `src/components/semiconductors/schottky.ts` — imports `SCHOTTKY_DEFAULTS`
- `src/components/semiconductors/tunnel-diode.ts` — imports `TUNNEL_DIODE_DEFAULTS`
- `src/components/semiconductors/zener.ts` — imports `ZENER_DEFAULTS`

The acceptance criterion `grep -rn "model-defaults" src/` returns zero hits requires fixing all 11 files (4 test + 7 production), but the task only lists 4. An implementer following the spec will fix 4 files and then see the acceptance criterion fail with 7 remaining hits and no guidance on what to do.

### Gap 4: Task 4.3 — the 35 test files are not identified

The spec says "All 35 test files identified in the audit." No list of these 35 files appears anywhere in the spec or in a referenced appendix. The actual count of files with inline `class *Element extends AbstractCircuitElement` in test files is 36 (verified via grep). An implementer cannot know which 35 files to modify without performing their own audit. The spec references an audit that is not included.

### Gap 5: Task 4.3 — shared fixture file contents are underspecified

Four fixture files are named but their contents are described only at the level of "shared TestElement with configurable type, pins, and properties." No interface, constructor signature, export name, or example usage is provided. An implementer cannot write a file that 35 other test files will import without knowing the exact API. For example:
- What arguments does `buildDigitalRegistry()` accept?
- What is the constructor signature for `TestElement`?
- What does `executeAnd2` do exactly?
- What is the difference between `TestLeafElement` and `TestSubcircuitElement`?

### Gap 6: Task 4.4 — no files to create or modify are listed

The spec lists features to test but provides no file paths for where the new tests should go. For each of the 7 bullet points under "Tests to update/add," an implementer needs to know:
- Is this a new test file or an addition to an existing one?
- If existing, which file?
- What are the specific assertions?

The spec provides none of this. "Unified import dialog (headless + MCP + E2E)" does not tell an implementer which file, which test suite, or what to assert.

---

## Concreteness Issues

### Issue 1: Task 4.1 — several "zero hits" claims are factually incorrect for the current codebase

The spec requires the following to return zero hits, but grep confirms they do not:

| Symbol | Actual hits | Location |
|--------|------------|----------|
| `_spiceModelOverrides` | 19+ hits | `src/components/semiconductors/*.ts` (10 production files), test file (9 hits) |
| `_modelParams` | 14+ hits | `src/components/semiconductors/*.ts` and `__tests__/diode.test.ts` |
| `_spiceModelName` | 10 hits | `src/headless/__tests__/spice-import-roundtrip-mcp.test.ts`, `src/solver/analog/__tests__/spice-import-dialog.test.ts` |
| `namedParameterSets` | 10+ hits | `src/headless/__tests__/spice-import-roundtrip-mcp.test.ts` |
| `modelDefinitions` | 7 hits | `src/io/dts-deserializer.ts`, `src/io/dts-schema.ts`, `src/io/__tests__/dts-schema.test.ts` |
| `subcircuitBindings` | 6 hits | Same files as `modelDefinitions` |
| `simulationModel` | 10+ hits | `src/components/gates/*.ts`, `src/components/flipflops/d.ts`, test files |
| `models.mnaModels` | 9 hits | `src/components/io/__tests__/`, `scripts/__tests__/circuit-mcp-server.test.ts` |
| `subcircuitRefs` | 10+ hits | `src/components/gates/*.ts`, `src/components/flipflops/d.ts` |
| `availableModels` | 7 hits | `src/headless/netlist-types.ts`, `src/headless/netlist.ts`, `scripts/mcp/formatters.ts`, `scripts/__tests__/circuit-mcp-server.test.ts` |
| `spice-subckt-dialog` (import path) | 2 hits | `e2e/gui/spice-import-flows.spec.ts` (CSS selector string, not import path, but will match) |

The spec does not explain whether prior waves were supposed to eliminate these, whether they are intentionally retained, or how many are legitimate exceptions. A blanket "zero hits required" instruction against symbols that obviously still exist in active production code is not actionable.

### Issue 2: Task 4.1 — `DeviceType` exception is underspecified

The spec says: `DeviceType` (outside `src/solver/analog/model-parser.ts`) — zero. The grep command as written (`grep -rn "DeviceType" src/ e2e/ scripts/`) will include `model-parser.ts`. The spec does not provide the grep command that actually excludes the file. An implementer must derive it themselves, and the spec does not confirm how many expected hits exist inside `model-parser.ts` versus outside it.

### Issue 3: Task 4.2 — "update imports to use `defineModelParams()` exports from the migrated component files (Wave 2) or from `src/test-fixtures/model-fixtures.ts`"

The phrase "or from" leaves the choice entirely open. An implementer does not know which source to use for which test. For example, should `spice-model-overrides.test.ts` import from the component file or from `model-fixtures.ts`? The spec does not provide import paths, export names, or per-file decisions.

### Issue 4: Task 4.3 — boilerplate counts are unverifiable

The spec states "56 inline stub element classes" and "40+ inline registry builders (~1,100 lines)." Grep on the current codebase finds exactly 36 inline element class definitions in test files (not 56). No registry builder functions named `buildRegistry` or `makeRegistry` are found using standard grep; the 335 hits for those names are spread across function calls, not definitions. The counts in the spec do not match observable reality, making the scope of the task unverifiable.

### Issue 5: Task 4.4 — "every user-facing feature tested across headless API, MCP tool, and E2E surfaces" is unverifiable

The acceptance criterion does not list which features are user-facing, does not reference the seven bullet points as the complete list, and does not specify what "tested" means (one test? multiple assertions? what assertions?). A reviewer cannot verify this criterion.

---

## Implementability Concerns

### Concern 1: Task 4.1 requires fixing bugs it does not specify — scope is unbounded

The instruction "Any remaining references are bugs — fix before closing" makes Task 4.1's scope depend entirely on what the grep finds. For symbols like `_spiceModelOverrides` (19+ hits in production semiconductor components), the fix is a substantial refactor that belongs to prior waves. An implementer starting Wave 4 with no prior-wave context will encounter this and have no spec guidance. If prior waves were supposed to complete this work, the spec should confirm that Wave 4's 4.1 is purely a verification pass (grep only, no fixing) or should explicitly list the known remaining bugs and their fixes. As written, it conflates verification and fixing.

### Concern 2: Task 4.3 is too large for a single agent session

Modifying 35 test files, creating 4 shared fixture files with precisely correct APIs, running `npm run test:q` to zero failures — all as a single task — is an extremely broad scope. This is especially true because the fixture API must be designed before any of the 35 files can be migrated, and the design is not given in the spec. There is no wave ordering within 4.3 to sequence "define fixtures first, then migrate files."

### Concern 3: Task 4.4 depends on Wave 1–3 completion but gives no dependency declaration

Task 4.4 says "update E2E tests for the new architecture." If the new architecture (bridge rewrite, hot-loadable params, model selector) is not fully implemented by Wave 3, there is nothing to write E2E tests against. The spec does not state this dependency explicitly, leaving an implementer uncertain whether to proceed with 4.4 if prior waves are incomplete.

### Concern 4: Task 4.2 instructs use of `defineModelParams()` but does not confirm it exists

The instruction says "Update imports to use `defineModelParams()` exports from the migrated component files (Wave 2)." The spec does not confirm that `defineModelParams()` is the correct export name, that it exists in the component files after Wave 2, or what its call signature is. If Wave 2 named it differently, the implementer will import a non-existent function and have no fallback.

### Concern 5: `src/test-fixtures/model-fixtures.ts` already exists — Task 4.3 doesn't acknowledge it

The existing file at `src/test-fixtures/model-fixtures.ts` may already contain some of the shared fixtures the spec asks for. An implementer might duplicate its contents or conflict with it. The spec should have audited the existing file and stated what it contains, what needs to be added, and whether any of the four new fixture files overlap with it.

---

## Summary of Symbol Verification Results

The following table records what the grep actually found for each Task 4.1 symbol, compared to the spec's "zero hits required" claim:

| Symbol | Spec requires | Actual result |
|--------|--------------|---------------|
| `_spiceModelOverrides` | zero | NON-ZERO (19+ hits in production + test files) |
| `_modelParams` | zero | NON-ZERO (14+ hits in production + test files) |
| `_spiceModelName` | zero | NON-ZERO (10 hits in test files) |
| `namedParameterSets` | zero | NON-ZERO (10+ hits in test files) |
| `modelDefinitions` | zero | NON-ZERO (7 hits — in schema validation code) |
| `subcircuitBindings` | zero | NON-ZERO (6 hits — in schema validation code) |
| `simulationModel` (property key) | zero | NON-ZERO (10+ hits in gate/flipflop components) |
| `SubcircuitModelRegistry` | zero | ZERO (confirmed) |
| `ModelLibrary` (import or reference) | zero | NON-ZERO (2 hits via `spice-model-library-dialog`) |
| `DeviceType` (outside model-parser.ts) | zero | Unverifiable as written (no exclusion grep given) |
| `models.mnaModels` | zero | NON-ZERO (9 hits in test + MCP server tests) |
| `ComponentDefinition.subcircuitRefs` | zero | NON-ZERO (10+ hits in production gate files) |
| `getActiveModelKey` | zero | ZERO (confirmed) |
| `availableModels` (function name) | zero | NON-ZERO (7 hits — live production use in MCP formatter) |
| `modelKeyToDomain` | zero | ZERO (confirmed) |
| `model-param-meta` (import path) | zero | ZERO (confirmed) |
| `model-library` (import path) | zero | ZERO (confirmed) |
| `subcircuit-model-registry` (import path) | zero | ZERO (confirmed) |
| `default-models` (import path) | zero | ZERO (confirmed) |
| `transistor-expansion` (import path) | zero | ZERO (confirmed) |
| `transistor-models` (import path) | zero | ZERO (confirmed) |
| `spice-subckt-dialog` (import path) | zero | NON-ZERO (2 hits in e2e — CSS selector, not import, but grep matches) |
| Norton in bridge-adapter.ts | zero | NON-ZERO (7+ hits — Wave 1 not complete) |
| Norton in digital-pin-model.ts | zero | NON-ZERO (5+ hits — Wave 1 not complete) |
| `isNonlinear.*true` in bridge-adapter.ts | zero | NON-ZERO (line 50: `readonly isNonlinear: true = true`) |
| `branchIndex.*=.*-1` in bridge-adapter.ts | BridgeOutput zero, BridgeInput non-zero | Both are -1 (Wave 1 not complete) |
| `setParam?` in analog-types.ts | zero | NON-ZERO (line 122 — optional marker still present) |
