# Domain Leak Fix — Full Spec

## Overview

Fix all 36 domain leak findings from `docs/domain-leak-inventory.md` in a single parallel burst. The root cause is that the netlist data model was designed for digital circuits and has no domain concept. The fix has three structural pillars:

1. **Rebuild `resolveNets()`** on top of the compilation infrastructure (`resolveModelAssignments` + `extractConnectivityGroups`) instead of maintaining a parallel reimplementation
2. **Unify diagnostics** — merge `Diagnostic` and `SolverDiagnostic` into one rich type used by both UI and MCP
3. **Domain-aware formatting and validation** — all consumers branch on the `domain` field populated from `ModelAssignment.modelKey`, never from `availableModels` or `modelRegistry` introspection

Organized by file.

---

## `src/compile/types.ts`

### Unify Diagnostic types

Merge `Diagnostic` (compile/types.ts) and `SolverDiagnostic` (core/analog-types.ts) into a single type. `SolverDiagnostic` is the richer one — it has `explanation`, `suggestions`, `involvedNodes`, `involvedElements`, `simTime`, `detail`. `Diagnostic` adds `netId`, `subcircuitFile`, `hierarchyPath`.

The unified type lives in `compile/types.ts` (canonical home):

```typescript
export type DiagnosticCode =
  | 'width-mismatch'
  | 'unconnected-input'
  | 'unconnected-output'
  | 'multi-driver-no-tristate'
  | 'missing-subcircuit'
  | 'label-collision'
  | 'combinational-loop'
  | 'missing-property'
  | 'unknown-component'
  | 'unsupported-ctz-component'
  | 'orphaned-pin-loading-override'
  | 'invalid-simulation-model'
  | 'unresolved-model-ref'
  | 'competing-voltage-constraints'
  // solver codes (merged from SolverDiagnosticCode)
  | 'singular-matrix'
  | 'voltage-source-loop'
  | 'floating-node'
  | 'orphan-node'
  | 'inductor-loop'
  | 'no-ground'
  | 'convergence-failed'
  | 'timestep-too-small'
  | 'dc-op-converged'
  | 'dc-op-gmin'
  | 'dc-op-source-step'
  | 'dc-op-failed'
  | 'ndr-convergence-assist'
  | 'rs-flipflop-both-set'
  | 'ac-no-source'
  | 'ac-linearization-failed'
  | 'monte-carlo-trial-failed'
  | 'unconnected-analog-pin';

export interface DiagnosticSuggestion {
  text: string;
  automatable: boolean;
  patch?: unknown;
}

export interface Diagnostic {
  readonly severity: 'error' | 'warning' | 'info';
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly explanation?: string;
  readonly suggestions?: DiagnosticSuggestion[];
  readonly involvedNodes?: number[];
  readonly involvedPositions?: Point[];
  readonly involvedElements?: number[];
  readonly simTime?: number;
  readonly detail?: string;
  readonly netId?: number;
  readonly subcircuitFile?: string;
  readonly hierarchyPath?: readonly string[];
}
```

- **Files to modify:**
  - `src/compile/types.ts` — replace `DiagnosticCode` and `Diagnostic` with the unified versions above; add `DiagnosticSuggestion`; remove `import type { NetPin }` (no longer needed)
  - `src/core/analog-types.ts` — delete `SolverDiagnosticCode`, `DiagnosticSuggestion`, `SolverDiagnostic`; re-export `Diagnostic`, `DiagnosticCode`, `DiagnosticSuggestion` from `compile/types.ts`
  - `src/solver/analog/diagnostics.ts` — update `makeDiagnostic` to return `Diagnostic` instead of `SolverDiagnostic`; field rename `summary` → `message`
  - `src/compile/compile.ts:354-361` — stop stripping: pass all fields through from analog diagnostics (explanation, suggestions, involvedNodes, etc.)
  - All files importing `SolverDiagnostic` — update to import `Diagnostic` from the unified location
- **Tests:**
  - `src/solver/analog/__tests__/diagnostics.test.ts` — update to use `Diagnostic` type, `message` instead of `summary`
  - `src/core/__tests__/analog-engine-interface.test.ts` — same
- **Acceptance criteria:**
  - Single `Diagnostic` type used everywhere; `SolverDiagnostic` type deleted
  - `makeDiagnostic` returns the unified `Diagnostic`
  - `compile.ts` passes solver diagnostic fields through without stripping
  - All existing tests pass with updated type references

### Add `labelToCircuitElement` to `CompiledCircuitUnified`

- **Files to modify:**
  - `src/compile/types.ts` — add `labelToCircuitElement: Map<string, CircuitElement>` to `CompiledCircuitUnified`
  - `src/compile/compile.ts` — build `labelToCircuitElement` in step 9 alongside `labelSignalMap`
- **Acceptance criteria:**
  - Every labeled element in the flattened circuit has an entry in `labelToCircuitElement`

---

## `src/headless/netlist-types.ts`

### Reshape types

```typescript
export interface NetPin {
  readonly componentIndex: number;
  readonly componentType: string;
  readonly componentLabel: string;
  readonly pinLabel: string;
  readonly domain: string;
}

export interface PinDescriptor {
  readonly label: string;
  readonly domain: string;
  readonly direction: PinDirection;
  readonly bitWidth: number;
  readonly netId: number;
  readonly connectedTo: NetPin[];
}

export interface NetDescriptor {
  readonly netId: number;
  readonly domain: 'digital' | 'analog' | 'mixed';
  readonly bitWidth?: number;
  readonly pins: NetPin[];
}

export interface ComponentDescriptor {
  readonly index: number;
  readonly typeId: string;
  readonly label: string | undefined;
  readonly instanceId: string;
  readonly pins: PinDescriptor[];
  readonly properties: Record<string, PropertyValue>;
  readonly modelKey: string;
}
```

- **Fields deleted:** `NetPin.pinDirection`, `NetPin.declaredWidth`, `NetPin.hierarchyPath`, `ComponentDescriptor.availableModels`, `ComponentDescriptor.activeModel`, `NetDescriptor.inferredWidth`
- **Fields added:** `NetPin.domain`, `PinDescriptor.domain`, `NetDescriptor.domain`, `NetDescriptor.bitWidth` (optional), `ComponentDescriptor.modelKey`
- **Files to modify:**
  - `src/headless/netlist-types.ts` — replace type definitions as above
  - Update doc comment at line 7-8 to include an analog addressing example
  - Drop re-export of `Diagnostic` from `netlist-types.ts` (consumers import from `compile/types.ts` directly)
- **Acceptance criteria:**
  - All deleted fields have zero remaining consumers
  - All new fields are populated by `buildNetlistView` (see netlist.ts section)

---

## `src/headless/netlist.ts`

### Delete `resolveNets()` and rebuild on compilation infrastructure

Delete the entire 380-line `resolveNets()` body (duplicate union-find algorithm). Replace with:

```typescript
export function resolveNets(circuit: Circuit, registry: ComponentRegistry): Netlist {
  const [assignments, assignDiags] = resolveModelAssignments(circuit.elements, registry);
  const [groups, groupDiags] = extractConnectivityGroups(
    circuit.elements, circuit.wires, registry, assignments
  );
  return buildNetlistView(circuit.elements, registry, assignments, groups,
    [...assignDiags, ...groupDiags]);
}
```

`buildNetlistView` is a new function (~100-120 lines) in the same file:
- Iterates `elements` + `assignments` → builds `ComponentDescriptor[]` (`modelKey` from `assignment.modelKey`)
- Iterates `groups` → builds `NetDescriptor[]` (`domain` from `group.domains`, `bitWidth` from `group.bitWidth`)
- Maps `ResolvedGroupPin[]` → `NetPin[]` (domain from `resolvedPin.domain`)
- Builds `PinDescriptor[]` with `connectedTo` cross-references by looking up which group each pin belongs to
- Passes diagnostics through unchanged

- **Files to modify:**
  - `src/headless/netlist.ts` — delete `resolveNets` body, write new `resolveNets` + `buildNetlistView`
- **Acceptance criteria:**
  - `resolveNets` delegates to `resolveModelAssignments` + `extractConnectivityGroups` (single source of truth for connectivity and domain)
  - `NetPin.domain` populated from `ResolvedGroupPin.domain`
  - `NetDescriptor.domain` derived from `ConnectivityGroup.domains`
  - `ComponentDescriptor.modelKey` from `ModelAssignment.modelKey`
  - All existing netlist tests pass with updated field assertions

---

## `src/compile/extract-connectivity.ts`

### Move connectivity diagnostics here

Unconnected-input and multi-driver checks currently live only in the deleted `resolveNets`. Move them into `extractConnectivityGroups` where they belong — it has `ConnectivityGroup[]` with domain tags.

- **Add after group construction (step 6):**
  - **Unconnected input:** single-pin group where the pin is INPUT and `domain === 'digital'`. Message names the pin using `ResolvedGroupPin` data. For analog single-pin groups, reword to "Floating terminal" with no directional language.
  - **Multi-driver:** group with multiple OUTPUT digital pins. Suppress entirely when all pins on the group are analog-domain.
  - All diagnostics carry `involvedPositions: Point[]` computed from `ResolvedGroupPin.worldPosition`
  - All diagnostics carry `fix` strings
  - Width-mismatch diagnostic (already present) improved to name pins: `"Bit-width mismatch: R1:A [8-bit] ↔ gate:out [1-bit]"` instead of `"Net N: connected digital pins have mismatched bit widths: 1, 8"`

- **Files to modify:**
  - `src/compile/extract-connectivity.ts` — add diagnostic checks after group building; improve width-mismatch message
- **Acceptance criteria:**
  - Unconnected-input, multi-driver, and width-mismatch diagnostics all produced here with pin names, positions, fix text, and domain awareness
  - No diagnostic code remains in `netlist.ts`
  - Width-mismatch diagnostic for analog-digital boundary says "Analog terminal connected to multi-bit digital bus" instead of generic width mismatch
  - Width-mismatch suppressed when both sides are analog (both will be 1-bit)

---

## `src/compile/compile.ts`

### Pass solver diagnostics through without stripping

- **Files to modify:**
  - `src/compile/compile.ts:354-361` — replace the stripping conversion with a pass-through that maps `SolverDiagnostic` fields to `Diagnostic` fields (rename `summary` → `message`, keep `explanation`, `suggestions`, `involvedNodes`, `involvedElements`, `simTime`, `detail`)
- **Acceptance criteria:**
  - `compiled.diagnostics` contains full solver diagnostic data (explanation, suggestions, involvedNodes) — not just the summary string

---

## `src/app/render-pipeline.ts`

### Consume unified diagnostics for overlays

- **Files to modify:**
  - `src/app/render-pipeline.ts` — change `populateDiagnosticOverlays` to accept `Diagnostic[]` instead of `SolverDiagnostic[]`. Read both `involvedNodes` (from solver diagnostics, reverse-lookup via `wireToNodeId`) and `involvedPositions` (from connectivity diagnostics, used directly)
- **Files to modify:**
  - `src/app/simulation-controller.ts:308-309` — remove the forced `as unknown as SolverDiagnostic[]` cast; pass `Diagnostic[]` directly
- **Acceptance criteria:**
  - Compilation diagnostics (width-mismatch, unconnected-input, multi-driver) produce visual overlay circles at the involved positions
  - Solver diagnostics (singular-matrix, floating-node, dc-op-failed) continue to produce circles via `involvedNodes` lookup
  - No forced type casts

---

## `scripts/mcp/formatters.ts`

### Domain-aware formatting

- **`formatNetlist`:**
  - Component line: show `[modelKey]` tag from `comp.modelKey` (e.g. `[analog]`, `[digital]`, `[behavioral]`). Delete `isAnalogOnly`/`[mixed]` heuristics
  - Pin summary: branch on `pin.domain` — `[terminal]` for analog, `[N-bit, DIRECTION]` for digital
  - Net header: show `[N-bit, M pins]` when `net.bitWidth` exists, just `[M pins]` for analog nets
  - Net pin lines: show `label:pin [terminal]` for analog, `label:pin [N-bit, DIRECTION]` for digital — branch on `pin.domain`
- **`formatDiagnostics`:**
  - Show `message` + `explanation` (if present) + `suggestions` text (if present). Delete the `-> Pins:` appendage (the `d.pins` field no longer exists)
- **`formatComponentDefinition`:**
  - Delete `defIsAnalogOnly` heuristic. Pin display: always show `label [N-bit, DIRECTION]` — this is a definition-level view where no active model exists; direction and width describe the pin's default configuration. The `[terminal, INPUT]` special case is deleted
  - Scaling-pin detection: no changes needed (already gated by `bwPropDef` check — analog components without a `bitWidth` property skip it naturally)

- **Files to modify:**
  - `scripts/mcp/formatters.ts` — all three functions updated as above
- **Acceptance criteria:**
  - Analog components show `[terminal]` for pins, not `[N-bit, DIRECTION]`
  - Analog nets show `[M pins]` without bit-width
  - Model tag shows active `modelKey`, not capability list
  - No `isAnalogOnly`, `defIsAnalogOnly`, or `availableModels` checks remain

---

## `scripts/mcp/circuit-tools.ts`

### MCP tool fixes

- **Delete `circuit_describe_file`** — `.dig`-only, digital-only, partial reimplementation of `circuit_load` + `circuit_netlist`. Remove tool registration, remove `scanDigPins` import.
- **`circuit_list` (#14, #23):**
  - `include_pins`: drop directional arrows entirely. Show pin labels only: `And (A B out)` instead of `And (A↓ B↓ out↑)`. Arrows imply domain context that doesn't exist at the definition level.
  - Category filter description: add `"ANALOG"` to examples.
- **`circuit_test` (#15, #20):**
  - Driver analysis: make domain-aware. For digital-domain pins, keep existing INPUT→OUTPUT one-hop trace. For analog-domain pins, show all connected components without directional language.
  - Description: change "Digital test format" to "test vector format."
- **`circuit_patch` (#21):**
  - Add an analog example to the description: `{op:'set', target:'R1', props:{resistance:10000}}`
- **`circuit_compile` (#22):**
  - After the existing output (which already shows `DC op available` and `AC sweep available`), change the final guidance line: when `coordinator.supportsDcOp()` or `coordinator.supportsAcSweep()` is true, append "For analog analysis: circuit_dc_op, circuit_ac_sweep." alongside the existing digital tool suggestions.

- **Files to modify:**
  - `scripts/mcp/circuit-tools.ts` — all changes above
  - `src/io/dig-pin-scanner.ts` — check if any other consumer exists; if not, delete
- **Acceptance criteria:**
  - `circuit_describe_file` tool no longer registered
  - `circuit_list` pin display has no directional arrows
  - `circuit_compile` output suggests analog tools when available
  - Driver analysis works for digital outputs and degrades gracefully for analog

---

## `src/headless/builder.ts`

### Remove electrical validation from `connect()`

- **Delete `validatePinConnection` method entirely** (~20 lines)
- **Delete bit-width check from `connect()`** (lines 279-292)
- **`connect()` keeps only:** pin-exists validation and duplicate-wire check
- **Update `connect()` JSDoc** (#33): "Connect two component pins with a wire. Validates pin labels exist."

- **Files to modify:**
  - `src/headless/builder.ts` — delete `validatePinConnection`, delete width check, update JSDoc
- **Files to modify:**
  - `src/headless/facade.ts:55-66` — update `connect()` JSDoc to remove claims about direction/width validation
- **Acceptance criteria:**
  - `connect()` does not validate direction or bit width
  - All electrical validation deferred to `netlist()`/`compile()` (which runs after every `build()`/`patch()`)
  - Existing tests that assert on `connect()` throwing for width/direction mismatches are updated or removed

---

## `src/headless/facade.ts` + `src/headless/default-facade.ts`

### Rename `setInput`/`readOutput` → `setSignal`/`readSignal`

Hard cut, no aliases. Old names deleted.

- `setInput` → `setSignal` (facade interface + implementation)
- `readOutput` → `readSignal` (facade interface + implementation)
- `readAllSignals` — unchanged

### `setSignal` auto-routes for analog sources

When the signal's domain (from `labelSignalMap`) is analog, `setSignal` looks up the element in `labelToCircuitElement`, resolves the primary parameter from the active model's `paramDefs`, and calls `coordinator.setComponentProperty` to re-stamp the MNA matrix. For digital signals, existing `writeSignal` path. The caller doesn't need to know the domain.

### Replace `runToStable` with `settle`

- `runToStable` removed from `SimulatorFacade` interface
- New method: `settle(coordinator, opts?): Promise<void>`
  - Pure digital: snapshot-comparison loop (existing `runToStable` logic)
  - Analog/mixed: `coordinator.stepToTime(currentTime + settleTime)`
  - `settleTime` from opts or a default
- All callers switch to `await facade.settle(coordinator)`

### `step()` JSDoc (#26)

Add: "For analog/mixed circuits, advances the transient solver by one timestep."

### `runTests` changes (#27, #28)

- Remove hard guard rejecting analog-only circuits (line 243-244). Replace with "Test vectors are not yet supported for analog-only circuits" if analog test pipeline is not yet implemented — or remove entirely if it is.
- `runTests` becomes async (because `settle` is async)
- Expand input detection (lines 214-219) to include analog source typeIds from the component registry (not a hardcoded whitelist — enumerate labeled elements where `labelSignalMap` entry has `domain === 'analog'`)

### `setSignal`/`readSignal` JSDoc (#34)

Honest description: "Write a signal value by label" / "Read a signal value by label." No claims about input/output type validation.

- **Files to modify:**
  - `src/headless/facade.ts` — rename methods, update JSDoc, add `settle`, remove `runToStable`
  - `src/headless/default-facade.ts` — rename implementations, add `settle` implementation, add analog auto-routing in `setSignal`, update `runTests` to async, remove analog guard
- **Acceptance criteria:**
  - `setInput`/`readOutput` do not exist on the interface or implementation
  - `setSignal` correctly routes analog sources through `setComponentProperty`
  - `settle` uses `stepToTime` for analog/mixed, snapshot comparison for pure digital
  - `runTests` is async and does not reject analog-only circuits

---

## `src/testing/executor.ts` + `src/testing/parser.ts`

### Async executor using `settle`

- `RunnerFacade` interface: rename `setInput` → `setSignal`, `readOutput` → `readSignal`, replace `runToStable` with `settle`
- `executeTests` becomes async
- `executeVector` becomes async, calls `await facade.settle(coordinator)` instead of `facade.runToStable(coordinator)`

### TestValue extension

```typescript
export type TestValue =
  | { kind: 'value'; value: bigint }
  | { kind: 'analogValue'; value: number; tolerance?: Tolerance }
  | { kind: 'dontCare' }
  | { kind: 'clock' }
  | { kind: 'highZ' };

export interface Tolerance {
  absolute?: number;
  relative?: number;
}
```

### Parser extensions

- `#analog:` pragma lines: `tolerance`, `abstol`, `settle`
- `parseSIValue` helper for `f/p/n/u/m/k/M/G` suffixes
- `parseTestValue` gets `domain` parameter — when `'analog'`, parse as float with optional `~tolerance`, reject `C`/`Z`
- `ParsedTestData` extended with `analogPragmas` and `signalDomains: Map<string, 'digital' | 'analog'>` (populated by caller from `labelSignalMap`)
- Two-pass parsing: parse headers first, resolve domains from compiled circuit, then parse values

### Tolerance comparison

- `withinTolerance(actual, expected, tol)` — if both absolute and relative specified, passing either is sufficient
- Analog test failure message: `Expected 3.3V ±5% at "Vout", got 2.8V (delta: 500mV)`

- **Files to modify:**
  - `src/testing/executor.ts` — async, rename facade methods, use `settle`, add tolerance comparison
  - `src/testing/parser.ts` — add `analogValue` TestValue kind, pragma parsing, SI suffixes, domain-aware parsing
- **Acceptance criteria:**
  - `executeTests` is async
  - Analog test values parsed correctly with SI suffixes and tolerance
  - Tolerance comparison used for analog outputs, exact comparison for digital

---

## `src/solver/analog/compiler.ts`

### Remove label whitelist

- **Delete `labelTypesPartition`** at line 925
- Any component in the analog partition with a non-empty `label` gets an entry in `labelToNodeId`

- **Files to modify:**
  - `src/solver/analog/compiler.ts:924-931` — delete the `labelTypesPartition` set and the `if (!labelTypesPartition.has(...))` guard
- **Acceptance criteria:**
  - A labeled resistor's node voltage is discoverable via `labelToNodeId`
  - No hardcoded type whitelist for label discovery

---

## `src/solver/coordinator.ts`

### Add `setSourceByLabel`

New method: `setSourceByLabel(label: string, paramKey: string, value: number)` — resolves label → element via `labelToCircuitElement`, calls `setComponentProperty`.

- **Files to modify:**
  - `src/solver/coordinator.ts` — add method
  - `src/solver/coordinator-types.ts` — add to interface if needed
- **Acceptance criteria:**
  - `setSourceByLabel("Vdc", "voltage", 5.0)` correctly re-stamps the MNA matrix

---

## `src/io/postmessage-adapter.ts`

### Wire protocol rename (#31)

- `sim-set-input` → `sim-set-signal`
- `sim-read-output` → `sim-read-signal`
- Hard cut, old names removed

### Non-convergence error (#30)

- Lines 502-506: replace "cross-coupled latch" advice with domain-aware message. Generic: "Circuit did not converge within iteration limit." The detailed explanation and suggestions now come from the diagnostic itself (since `compile.ts` no longer strips them).

### Test signal detection (#16)

- Lines 459-466: expand to recognize analog source typeIds as test inputs. Use `labelSignalMap` domain to determine input/output partitioning instead of hardcoded `In`/`Clock`/`Port`/`Out` whitelist.

- **Files to modify:**
  - `src/io/postmessage-adapter.ts` — rename wire protocol messages, fix non-convergence message, expand test signal detection
- **Acceptance criteria:**
  - `sim-set-input` and `sim-read-output` message types do not exist
  - Non-convergence error no longer mentions "cross-coupled latches" for analog circuits
  - Analog voltage sources with labels recognized as test inputs

---

## `src/headless/equivalence.ts`

### Vacuous result fix (#32) + settle

- Throw when both circuits have zero discovered I/O (`inputLabels.length === 0 && outputLabels.length === 0`): "No input/output labels found. Equivalence testing requires labeled components."
- Replace `runToStable` calls with `await facade.settle()`
- Replace `setInput`/`readOutput` with `setSignal`/`readSignal`
- Function becomes async

- **Files to modify:**
  - `src/headless/equivalence.ts` — all changes above
- **Acceptance criteria:**
  - Two analog circuits with zero In/Out components throw instead of silently reporting "equivalent"

---

## Files with rename-only changes

These files need `setInput` → `setSignal`, `readOutput` → `readSignal`, `runToStable` → `settle` (async), and import updates for the unified `Diagnostic` type. No logic changes.

- `src/testing/comparison.ts`
- `src/testing/run-all.ts`
- `src/analysis/model-analyser.ts`
- `scripts/verify-fixes.ts`
- All test files that reference renamed methods or deleted types
- `src/headless/builder.ts` (internal `runToStable` call in build validation)

---

## Deleted files / dead code

| Item | Action |
|---|---|
| `circuit_describe_file` tool registration | Delete from `circuit-tools.ts` |
| `src/io/dig-pin-scanner.ts` | Delete if no other consumers |
| `SolverDiagnostic` type | Delete from `core/analog-types.ts` |
| `SolverDiagnosticCode` type | Delete from `core/analog-types.ts` |
| `validatePinConnection` method | Delete from `builder.ts` |
| `Diagnostic.pins` field | Delete from `compile/types.ts` |
| `NetPin.hierarchyPath` field | Delete (dead — never read) |
| `NetPin.pinDirection` field | Delete (redundant with message text) |
| `NetPin.declaredWidth` field | Delete (same) |
| `ComponentDescriptor.availableModels` field | Delete (nothing should depend on available models) |
| `ComponentDescriptor.activeModel` field | Delete (was populated but never read; replaced by `modelKey`) |
| `NetDescriptor.inferredWidth` field | Delete (cosmetic display-only; replaced by optional `bitWidth`) |
| `defIsAnalogOnly` / `isAnalogOnly` heuristics | Delete from `formatters.ts` |
