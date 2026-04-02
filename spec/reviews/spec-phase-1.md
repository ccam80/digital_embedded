# Spec Review: Domain Leak Fix — Full Spec

## Verdict: needs-revision

---

## Plan Coverage

Since there is no `plan.md`, the inventory is `docs/domain-leak-inventory.md` (36 findings). Each finding is checked against the spec.

| Finding | In Spec? | Notes |
|---------|----------|-------|
| #1 `formatNetlist` net-level pins show `[N-bit, DIRECTION]` | yes | Covered in `scripts/mcp/formatters.ts` section |
| #2 `formatNetlist` net header shows `N-bit` for analog nets | yes | Covered in formatters.ts section |
| #3 `formatDiagnostics` pin annotations show `[N-bit, DIRECTION]` | yes | Covered — delete `d.pins` appendage |
| #4 `formatComponentDefinition` shows `[terminal, INPUT]` | yes | Covered — delete `defIsAnalogOnly` heuristic and `[terminal, INPUT]` case |
| #5 `multi-driver-no-tristate` fires for analog nets | yes | Covered in `extract-connectivity.ts` section |
| #6 `unconnected-input` fires for analog terminals | yes | Covered in `extract-connectivity.ts` section |
| #7 Width-mismatch diagnostic uses `[N-bit]` for analog pins | yes | Covered in `extract-connectivity.ts` section |
| #8 `makeNetPin` always populates `pinDirection` and `declaredWidth` | yes | Covered — netlist.ts rebuild via `buildNetlistView` |
| #9 `NetPin.pinDirection` and `NetPin.declaredWidth` unconditional | yes | Covered in `netlist-types.ts` section |
| #10 `PinDescriptor.direction` and `PinDescriptor.bitWidth` unconditional | partial | `PinDescriptor` in spec retains `direction` and `bitWidth` fields (not deleted); spec only adds `domain`. The inventory finding says these fields are "unconditional" and should have a domain discriminator — spec adds `domain` but does not remove or make optional the direction/bitWidth fields on `PinDescriptor`. |
| #11 `NetDescriptor.inferredWidth` digital-only concept | yes | `inferredWidth` deleted, replaced with optional `bitWidth` |
| #12 `builder.ts` — `connect()` validates bit width for analog | yes | `validatePinConnection` deleted, width check deleted |
| #13 `circuit_describe_file` always shows `[N-bit]` | yes | Delete tool entirely |
| #14 `circuit_list` arrow notation for analog pins | yes | Drop directional arrows |
| #15 `circuit_test` driver analysis uses digital direction semantics | yes | Make domain-aware |
| #16 `sim-test` only recognizes In/Out/Clock/Port | yes | Expand to analog source typeIds |
| #17 Doc comment uses digital-only example | yes | Update doc comment in `netlist-types.ts` |
| #18 `circuit_describe_file` description frames pin discovery as digital-only | partial | Spec deletes the tool entirely rather than updating the description. The inventory finding (#18) calls for updating the description to "honestly state the limitation." The spec's choice to delete is a valid approach to fixing the underlying problem but diverges from what the inventory recommends. |
| #19 `circuit_describe_file` empty-result message assumes digital framing | partial | Same — spec deletes the tool. Finding #19 is an instance of the broader digital framing in `circuit_describe_file`. Deletion resolves it but the approach is not explicitly called out. |
| #20 `circuit_test` description says "Digital test format" | yes | Change to "test vector format" |
| #21 `circuit_patch` examples are exclusively digital | yes | Add analog example |
| #22 `circuit_compile` output only suggests digital tools | yes | Append analog tool suggestions |
| #23 `circuit_list` category examples are all digital | yes | Add "ANALOG" to examples |
| #24 `formatComponentDefinition` scaling-pin detection only probes `bitWidth` | no | Finding #24 is not addressed anywhere in the spec. The spec section on `formatComponentDefinition` says "Scaling-pin detection: no changes needed" and explicitly dismisses this finding without resolving it. The inventory says this is meaningless for analog components — the spec's dismissal may be acceptable, but it is not justified. |
| #25 `setInput`/`readOutput` method names use digital framing | yes | Rename to `setSignal`/`readSignal` |
| #26 `step()` JSDoc only describes digital behavior | yes | Add analog doc |
| #27 `runTests` error frames analog limitation as impossible | yes | Update message |
| #28 `runTests` input detection only checks `In`/`Clock`/`Port` | yes | Expand detection |
| #29 `validatePinConnection` uses over-broad analog detection heuristic | partial | Spec deletes `validatePinConnection` entirely, which removes the bad heuristic. However the inventory finding (#29) calls out the heuristic in `validatePinConnection` as a documentation/semantic issue. Deletion resolves the symptom but the spec does not explain why deletion is preferred over fixing the heuristic — this may confuse an implementer who reads the inventory alongside the spec. |
| #30 Non-convergence error advises about "cross-coupled latches" | yes | Domain-aware message |
| #31 Wire protocol names carry digital directionality | yes | Rename to `sim-set-signal`/`sim-read-signal` |
| #32 `testEquivalence` silently returns vacuous "equivalent" | yes | Throw when zero I/O found |
| #33 `connect()` JSDoc promises output→input validation as universal | yes | Update JSDoc |
| #34 `setInput`/`readOutput` JSDoc claims type-checking that doesn't exist | yes | Honest description |
| #35 `formatNetlist` checks `availableModels` instead of active model | yes | Use `modelKey` from `ComponentDescriptor` |
| #36 `runToStable` is a digital-only concept | yes | Replace with `settle()` method |

**Coverage gaps: 2 definite (finding #10 PinDescriptor fields not removed, finding #24 not addressed), 2 divergences from inventory recommendations (#18/#19 — deletion vs. description update, #29 — deletion vs. fix).**

---

## Internal Consistency Issues

### 1. `Diagnostic` type: `involvedPositions` field not in unified type definition

The spec defines a unified `Diagnostic` interface (under `src/compile/types.ts`) with fields including `involvedPositions?: Point[]`. This field does not exist in the current `Diagnostic` type in `compile/types.ts` (confirmed by inspection — the current type has `netId`, `pins`, `subcircuitFile`, `hierarchyPath`, `fix` but no `involvedPositions`). The `extract-connectivity.ts` section says diagnostics should carry `involvedPositions: Point[] computed from ResolvedGroupPin.worldPosition`. However, the unified `Diagnostic` type definition in the spec body (the code block under `src/compile/types.ts` → "Unify Diagnostic types") does not include an `involvedPositions` field. An implementer reading the type definition code block will not add `involvedPositions`, but will then be told by the `extract-connectivity.ts` section to populate it. These two spec sections contradict each other.

Spec reference: `src/compile/types.ts` Diagnostic interface code block vs. `src/compile/extract-connectivity.ts` section ("All diagnostics carry `involvedPositions: Point[]`").

### 2. `render-pipeline.ts` section references `involvedPositions` but unified `Diagnostic` has no such field

The `src/app/render-pipeline.ts` section says `populateDiagnosticOverlays` should "Read both `involvedNodes` (from solver diagnostics) and `involvedPositions` (from connectivity diagnostics, used directly)." This requires `involvedPositions` to exist on `Diagnostic`. As noted above, the unified `Diagnostic` type defined in the spec does not include this field. The render-pipeline section assumes a field that the type definition section does not declare.

Spec reference: `src/app/render-pipeline.ts` section vs. `src/compile/types.ts` Diagnostic type definition.

### 3. `setSignal` analog routing references `labelToCircuitElement` but that map is not in `CompiledCircuitUnified` until a separate task adds it

The `facade.ts`/`default-facade.ts` section describes `setSignal` auto-routing for analog sources using `labelToCircuitElement`. The `src/compile/types.ts` section adds `labelToCircuitElement: Map<string, CircuitElement>` to `CompiledCircuitUnified`. These are two separate task entries in the spec. However, both are in the same parallel burst — there is no wave ordering between them. The `setSignal` implementation depends on `labelToCircuitElement` existing on `CompiledCircuitUnified`. If an implementer works on `default-facade.ts` before `compile/types.ts` is updated, the field will not exist. The spec does not state that the `compile/types.ts` changes are a prerequisite.

Spec reference: `src/headless/facade.ts` + `src/headless/default-facade.ts` section vs. `src/compile/types.ts` "Add `labelToCircuitElement`" section.

### 4. `setSourceByLabel` described in `coordinator.ts` section conflicts with `setSignal` routing design in `facade.ts` section

The `src/solver/coordinator.ts` section defines `setSourceByLabel(label, paramKey, value)` — resolves label via `labelToCircuitElement`. The `src/headless/facade.ts` section says `setSignal` "looks up the element in `labelToCircuitElement`, resolves the primary parameter from the active model's `paramDefs`, and calls `coordinator.setComponentProperty`." These are two different routing designs: one routes through a new `setSourceByLabel` coordinator method, the other routes through `setComponentProperty` directly from the facade. The spec does not clarify which design takes precedence or whether `setSignal` calls `setSourceByLabel` or calls `setComponentProperty` directly.

Spec reference: `src/solver/coordinator.ts` "Add `setSourceByLabel`" section vs. `src/headless/facade.ts` "`setSignal` auto-routes for analog sources" section.

### 5. `RunnerFacade` interface in `executor.ts` uses old method names; spec describes renaming without explicitly addressing `RunnerFacade`

The spec renames `setInput`→`setSignal` and `readOutput`→`readSignal` on `SimulatorFacade`. The current `RunnerFacade` interface in `src/testing/executor.ts` declares `setInput`, `readOutput`, and `runToStable` separately from `SimulatorFacade`. The spec's `executor.ts` section says "rename `setInput` → `setSignal`, `readOutput` → `readSignal`, replace `runToStable` with `settle`" on the `RunnerFacade` interface but does not reconcile that `RunnerFacade` is a structurally separate interface in the existing code. An implementer must know to rename both the `SimulatorFacade` and the `RunnerFacade` simultaneously or the executor will fail to compile.

Spec reference: `src/testing/executor.ts` + `src/testing/parser.ts` section.

### 6. `PinDescriptor.domain` added but `PinDescriptor.direction`/`bitWidth` kept — breaks the stated goal of the structural fix

The inventory's root-cause section states: "The structural fix is to add a `domain` field to `NetPin`/`PinDescriptor`… then use it everywhere to suppress digital-specific formatting and diagnostics for analog pins/nets." The spec's `netlist-types.ts` code block shows `PinDescriptor` with both a new `domain` field AND the retained `direction: PinDirection` and `bitWidth: number` fields (not shown as removed or made optional). Downstream code that currently reads `direction` and `bitWidth` unconditionally from `PinDescriptor` will continue to do so, and the analog-awareness must be added by checking `domain`. This is consistent but means analog-unaware consumers still get misleading values. The spec should either remove/make-optional the digital-only fields or explicitly state they are retained with the domain field as the discriminator, so implementers know not to remove them.

---

## Completeness Gaps

### 1. No tests specified for three-surface coverage of renamed postMessage protocol

The spec renames `sim-set-input`→`sim-set-signal` and `sim-read-output`→`sim-read-signal` (postmessage-adapter.ts section). CLAUDE.md requires three-surface testing for every user-facing feature: headless API test, MCP tool test, and E2E/UI test. The spec mentions no E2E test to verify the renamed postMessage wire protocol. The `e2e/parity/` test suite exercises postMessage API — those tests will break after the rename, and the spec does not direct an implementer to update them.

### 2. No tests specified for the `settle()` method

The `facade.ts`/`default-facade.ts` section introduces the new `settle()` method as a replacement for `runToStable()`. No test file path or test assertions are given for `settle()`. The acceptance criteria say `settle` uses `stepToTime` for analog/mixed and snapshot comparison for pure digital, but there are no tests specified to verify this branching logic.

### 3. No tests specified for `setSourceByLabel`

The `src/solver/coordinator.ts` section says `setSourceByLabel("Vdc", "voltage", 5.0)` correctly re-stamps the MNA matrix, but specifies no test file or test assertions. No headless API test, MCP tool test, or E2E test is described.

### 4. No tests specified for `buildNetlistView` or the rebuilt `resolveNets`

The `src/headless/netlist.ts` section says "All existing netlist tests pass with updated field assertions" but specifies no new tests to verify the new fields (`NetPin.domain`, `NetDescriptor.domain`, `ComponentDescriptor.modelKey`). There are no test assertions described for the new behavior — only a backward-compatibility claim.

### 5. No tests specified for `labelToCircuitElement` population

The `src/compile/types.ts` "Add `labelToCircuitElement`" section acceptance criteria say "Every labeled element in the flattened circuit has an entry in `labelToCircuitElement`." No test file or assertion is given to verify this.

### 6. No tests for render-pipeline diagnostic overlay changes (third surface missing)

The `src/app/render-pipeline.ts` section acceptance criteria state that compilation diagnostics produce visual overlay circles. No test is specified — not headless, not MCP, and not E2E. CLAUDE.md requires all three surfaces. The visual overlay behavior is a user-facing feature with no test coverage specified.

### 7. No test for `testEquivalence` vacuous-result fix

The `src/headless/equivalence.ts` section says two analog circuits with zero In/Out components should throw. No test file or test assertion is specified.

### 8. `src/app/render-pipeline.ts` section lists "Files to modify" twice

The section has two separate "Files to modify" bullets both labeled "Files to modify" (one for `render-pipeline.ts` and one for `simulation-controller.ts`). This is likely a copy/paste artifact, but it makes the section structurally ambiguous — an implementer might misread it as two alternative sets of changes rather than two files to change in the same task.

Spec reference: `src/app/render-pipeline.ts` section.

### 9. `src/headless/builder.ts` "Files to modify" section appears twice

The `builder.ts` section lists "Files to modify: `src/headless/builder.ts`" and then "Files to modify: `src/headless/facade.ts:55-66`" as two separate "Files to modify" headers. This is the same formatting issue as above — reads as duplicated header rather than a list.

### 10. `src/testing/parser.ts` — two-pass parsing algorithm incompletely specified

The spec says "Two-pass parsing: parse headers first, resolve domains from compiled circuit, then parse values." The `ParsedTestData` extension adds `signalDomains: Map<string, 'digital' | 'analog'> (populated by caller from labelSignalMap)`. It is not specified: (a) what the caller is — is this the facade, the executor, or the parser itself? (b) What the exact API change to `parseTestData` is (new parameter? new overload?). (c) How the two-pass flow integrates with the existing single-call `parseTestData(resolvedData, inputCount)` call sites in `default-facade.ts` and `postmessage-adapter.ts`.

### 11. "Files with rename-only changes" section — no acceptance criteria or tests

The "Files with rename-only changes" section lists 6 files with only the statement "rename-only changes." No per-file acceptance criteria and no test assertions are given. For `src/analysis/model-analyser.ts` and `scripts/verify-fixes.ts` in particular, an implementer has no way to know what specific method calls to update without reading those files themselves.

---

## Concreteness Issues

### 1. `buildNetlistView` function — cross-reference algorithm is underspecified

The spec says `buildNetlistView` "Builds `PinDescriptor[]` with `connectedTo` cross-references by looking up which group each pin belongs to." The algorithm is not described. An implementer must independently devise a method to map each pin to its group, then build the `connectedTo` list. The existing `resolveNets` does this via union-find slot addresses — the spec deletes that code and replaces it with a vague description. The ~100-120 line estimate is provided but the cross-reference algorithm is the hardest part and is left implicit.

Spec reference: `src/headless/netlist.ts` section, `buildNetlistView` description.

### 2. `settle()` implementation — the `settleTime` default and `opts` parameter type are not defined

The spec says `settle(coordinator, opts?): Promise<void>` with "`settleTime` from opts or a default." No type definition for `opts` is given, no field name (is it `settleTime`? `settle`? `duration`?), no default value (the inventory's Design section mentions `10ms` as default but the spec does not repeat this), and no interface name for the opts type. An implementer cannot write this method without guessing the API contract.

Spec reference: `src/headless/facade.ts` + `src/headless/default-facade.ts` section, "Replace `runToStable` with `settle`."

### 3. `setSignal` analog auto-routing — "resolves the primary parameter from the active model's `paramDefs`" is vague

The spec says `setSignal` "resolves the primary parameter from the active model's `paramDefs`." It does not say what "primary parameter" means (first entry? a convention?), what `paramDefs` is (is this a field on the model definition? the `modelRegistry` entry?), or how to obtain it for a given element. The inventory Design section says "auto-resolves primary param from `modelRegistry.behavioral.paramDefs[0]`" — the spec does not reproduce this concrete detail.

Spec reference: `src/headless/facade.ts` + `src/headless/default-facade.ts` section, "`setSignal` auto-routes for analog sources."

### 4. `extract-connectivity.ts` — domain-awareness of multi-driver check is underspecified

The spec says: "Multi-driver: group with multiple OUTPUT digital pins. Suppress entirely when all pins on the group are analog-domain." The condition "all pins on the group are analog-domain" is not concrete — is a mixed-domain group (some analog, some digital) a multi-driver? The inventory says "Multi-domain nets (analog + digital pins) are analog — the digital portion is behind a bridge" — so mixed nets should also suppress this check. The spec does not reproduce this clarification.

Spec reference: `src/compile/extract-connectivity.ts` section.

### 5. `formatNetlist` net header: analog net detection method not specified

The spec says net header shows `[N-bit, M pins]` when `net.bitWidth` exists and `[M pins]` for analog nets. But after the type reshape, `NetDescriptor` no longer has `inferredWidth` — it has optional `bitWidth`. So the check is `if (net.bitWidth !== undefined)`. The spec says "Net-level code currently has no domain info per pin" then adds `NetDescriptor.domain` to the new type. The formatter section should explicitly state "branch on `net.domain`" for the header display, but does not. An implementer could reasonably implement this in at least two ways (check `net.domain === 'analog'` or check `net.bitWidth === undefined`) with different behavior on edge cases.

Spec reference: `scripts/mcp/formatters.ts` section, "`formatNetlist`" net header description.

### 6. `src/compile/compile.ts:354-361` line numbers are stale

The spec references `compile.ts:354-361` for the stripping conversion. The actual stripping code exists at lines 354-362 (confirmed: `for (const d of compiledAnalog.diagnostics)` loop at line 354). The spec says "lines 354-361" — this is approximately correct, but the spec also references this same range in two separate sections (the `compile/types.ts` section and the `compile/compile.ts` section) with slightly different descriptions. The `types.ts` section says "stop stripping: pass all fields through from analog diagnostics" while the `compile.ts` section says "replace the stripping conversion with a pass-through that maps `SolverDiagnostic` fields to `Diagnostic` fields (rename `summary` → `message`, keep explanation, suggestions…)." These are consistent descriptions but the field mapping (`summary`→`message`, etc.) is only specified in the `compile.ts` section and should also appear in the `types.ts` section where the field rename is first introduced.

### 7. `coordinator-types.ts` — spec says "add to interface if needed" without determining whether it is needed

The `src/solver/coordinator.ts` section says "`src/solver/coordinator-types.ts` — add to interface if needed." Inspection of the file confirms `setSourceByLabel` is not currently in `coordinator-types.ts`. The spec should either definitively say "add to interface" or "do not add to interface" — not "if needed." An implementer must independently decide whether `setSourceByLabel` is public API.

---

## Implementability Concerns

### 1. Scope is too large for a "single parallel burst"

The spec covers 18 distinct file sections affecting at minimum 25 files, including: a new `resolveNets` entry point, a new `buildNetlistView` function (~100-120 lines), a unified `Diagnostic` type merge, MNA matrix integration for analog signal setting, async test pipeline with SI-suffix parsing and tolerance comparison, and three-surface testing gaps. The inventory itself notes that findings #16/#27/#28/#36 require a "deeper investigation into what an analog/mixed test process would actually look like." Implementing all of this in a single parallel burst carries a high risk of inter-agent conflicts (multiple agents modifying `compile/types.ts`, `compile/compile.ts`, `default-facade.ts` simultaneously) and integration failures where partial changes leave the codebase in a non-compiling state.

### 2. No compilation checkpoints or wave ordering

The spec groups all work as a "single parallel burst" with no wave ordering. Many of the changes are load-bearing for others: the `Diagnostic` type unification must happen before `compile.ts` pass-through changes, `netlist-types.ts` reshape must happen before `netlist.ts` rebuild, `facade.ts` method renames must happen before `executor.ts` and `equivalence.ts` updates. Without wave ordering, parallel implementers will encounter undefined types and missing method signatures.

### 3. `SolverDiagnostic` → `Diagnostic` migration: no mapping table for all fields

The spec says `SolverDiagnostic.summary` → `Diagnostic.message` and lists other fields to keep. However, `SolverDiagnostic` has fields not mentioned in the mapping: `SolverDiagnosticCode` has codes like `"model-param-ignored"`, `"model-level-unsupported"`, `"bridge-inner-compile-error"`, `"bridge-unconnected-pin"`, `"bridge-missing-inner-pin"`, `"bridge-indeterminate-input"`, `"bridge-oscillating-input"`, `"bridge-impedance-mismatch"`, `"transmission-line-low-segments"`, `"reverse-biased-cap"`, `"fuse-blown"` — none of these appear in the spec's proposed `DiagnosticCode` union. The spec's unified `DiagnosticCode` does not include these 11 existing solver codes. An implementer must either add them to the union or silently drop them, but the spec gives no guidance. Dropping codes that the solver currently emits would be a silent regression.

### 4. `analog-types.ts` re-export strategy conflicts with `AcResult` which still uses `SolverDiagnostic`

The spec deletes `SolverDiagnostic` from `core/analog-types.ts`. However, the actual `AcResult` interface in `src/core/analog-types.ts` contains `diagnostics: SolverDiagnostic[]` (confirmed at line 299). If `SolverDiagnostic` is deleted and re-exported as `Diagnostic`, `AcResult.diagnostics` must be updated to `Diagnostic[]`. The spec does not mention `AcResult` or any of the other types in `analog-types.ts` that currently reference `SolverDiagnostic`. An implementer may delete `SolverDiagnostic` and break `AcResult`, `AcParams`, and any caller of `acSweep()` that processes the diagnostics array.

### 5. CLAUDE.md three-surface testing rule not met for most changes

CLAUDE.md requires every user-facing feature to be tested on three surfaces: headless API test, MCP tool test, and E2E/UI test. The spec provides tests only for:
- `src/solver/analog/__tests__/diagnostics.test.ts` (type update)
- `src/core/__tests__/analog-engine-interface.test.ts` (type update)

The following user-facing changes have no E2E tests specified:
- postMessage protocol rename (`sim-set-signal`/`sim-read-signal`) — the E2E parity tests in `e2e/parity/` test the wire protocol and will break
- `settle()` method — no E2E test
- Analog test vector execution (parser/executor changes) — no E2E test
- `circuit_compile` analog tool suggestions — no MCP integration test
- `circuit_list` pin display change — no MCP integration test

### 6. `render-pipeline.ts` depends on `SolverDiagnostic` from `analog-engine-interface.ts` — path not described

The current `render-pipeline.ts` imports `SolverDiagnostic` from `../core/analog-engine-interface.js` (confirmed at line 16). The spec section says to change `populateDiagnosticOverlays` to accept `Diagnostic[]`. But `analog-engine-interface.ts` is not in the spec's list of files to modify and is not the same as `analog-types.ts`. The import path change required in `render-pipeline.ts` is not specified. `SolverDiagnostic` is currently re-exported via `analog-engine-interface.ts` — that file also needs updating if the type is deleted from `analog-types.ts`.

### 7. `src/headless/builder.ts` "rename-only" claim conflicts with `runToStable` removal

The "Files with rename-only changes" section lists `src/headless/builder.ts` as needing only renames. However, the `builder.ts` section earlier in the spec says to delete `validatePinConnection`, delete the bit-width check, and update `connect()` JSDoc. These are logic changes, not rename-only changes. Including `builder.ts` in the rename-only section contradicts the earlier dedicated section for the same file.

Spec reference: `src/headless/builder.ts` section vs. "Files with rename-only changes" section.

### 8. `src/io/dig-pin-scanner.ts` deletion is conditional ("if no other consumers") — non-deterministic for implementer

The spec says "check if any other consumer exists; if not, delete." An implementer has no way to know from the spec alone whether other consumers exist — they must search the codebase. The spec should either state the result of that investigation (it is a review-time findable fact) or list the definite consumers, leaving the implementer with a deterministic instruction. The same ambiguity exists for the `circuit_describe_file` tool — the spec says delete it, but does not list what imports `scanDigPins`.

---

## Additional Observations (not fitting cleanly into categories above)

### `Diagnostic.pins` field to be deleted — but still referenced in `formatDiagnostics`

The "Deleted files / dead code" table says delete `Diagnostic.pins`. The `formatDiagnostics` section says "Delete the `-> Pins:` appendage (the `d.pins` field no longer exists)." This is consistent. However, the current `compile/types.ts` `Diagnostic` interface has `readonly pins?: NetPin[]` (confirmed at line 59). The spec's new unified `Diagnostic` type definition code block does not include `pins`. The spec is internally consistent on this, but implementers should note that removing `pins` from the type will cause a TypeScript error in the existing `formatDiagnostics` function at `scripts/mcp/formatters.ts:19` (`if (d.pins && d.pins.length > 0)`) — the spec's formatter section correctly describes deleting this code, so this is not a gap, just a dependency ordering note.

### `import type { NetPin }` removal from `compile/types.ts` — condition check needed

The spec says "remove `import type { NetPin }` (no longer needed)" from `compile/types.ts`. This import is currently at line 15 of `compile/types.ts`. After removing `Diagnostic.pins`, `NetPin` is indeed unused in `compile/types.ts`. This is correct. However, `NetPin` is still needed in `netlist-types.ts` where it is used by `PinDescriptor.connectedTo`. The spec says to drop the `Diagnostic` re-export from `netlist-types.ts`, not the `NetPin` type itself — this is consistent.
