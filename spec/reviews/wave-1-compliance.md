# Wave 1 Strict Spec Compliance Review

Reviewer: code-reviewer (opus)
Date: 2026-04-02
Spec source: `spec/domain-leak-fix.md`

---

## `src/compile/types.ts` - Unified Diagnostic types

- [x] **PASS** - `DiagnosticCode` union contains ALL codes listed in spec. Verified all 42 codes match exactly (lines 23-66).
- [x] **PASS** - `DiagnosticSuggestion` interface exists with exact fields: `text: string`, `automatable: boolean`, `patch?: unknown` (lines 74-81).
- [x] **PASS** - `Diagnostic` interface has ALL fields from spec: `severity`, `code`, `message`, `explanation?`, `suggestions?`, `involvedNodes?`, `involvedPositions?`, `involvedElements?`, `simTime?`, `detail?`, `netId?`, `subcircuitFile?`, `hierarchyPath?` (lines 92-119).
- [x] **PASS** - `import type { NetPin }` removed. No such import exists in the file.
- [x] **PASS** - `labelToCircuitElement: Map<string, CircuitElement>` added to `CompiledCircuitUnified` (line 321).

---

## `src/core/analog-types.ts`

- [x] **PASS** - `SolverDiagnosticCode` not present as standalone type - re-exported as alias from `compile/types.ts` (line 155). Acceptable per spec.
- [x] **PASS** - `DiagnosticSuggestion` deleted from this file as standalone definition; re-exported from `compile/types.ts` (line 154).
- [x] **PASS** - `SolverDiagnostic` not present as standalone type - re-exported as alias (line 156). Acceptable per spec.
- [x] **PASS** - Re-exports `Diagnostic`, `DiagnosticCode`, `DiagnosticSuggestion` from `compile/types.ts` (lines 153-154).
- [x] **PASS** - `AcResult.diagnostics` is `Diagnostic[]` (line 203).

---

## `src/core/analog-engine-interface.ts`

- [x] **PASS** - Re-exports `Diagnostic` from unified location (`compile/types.ts`) at lines 16-18. Also re-exports `SolverDiagnostic` as alias (line 20), acceptable for backward compatibility.

---

## `src/solver/analog/diagnostics.ts`

- [x] **PASS** - `makeDiagnostic` returns `Diagnostic` not `SolverDiagnostic` (line 131). Import is from `compile/types.ts` (line 13).
- [x] **PASS** - Field rename: function uses `message` parameter (line 133), not `summary`. No `summary` field anywhere in the file.

---

## `src/compile/compile.ts`

- [x] **PASS** - Lines 354-358: Analog diagnostics pushed through via `diagnostics.push(d)` loop. The rename from `summary` to `message` happened at the source (`diagnostics.ts`), and compile.ts does a full pass-through preserving `explanation`, `suggestions`, `involvedNodes`, `involvedElements`, `simTime`, `detail`.
- [x] **PASS** - `labelToCircuitElement` built alongside `labelSignalMap` (lines 360-369).
- [x] **PASS** - Every labeled element in flattened circuit has entry (loop at lines 361-369 covers all `circuit.elements`).

---

## `src/headless/netlist-types.ts`

- [x] **PASS** - `NetPin` has fields: `componentIndex`, `componentType`, `componentLabel`, `pinLabel`, `domain` and NOTHING ELSE (lines 55-66).
- [x] **PASS** - `PinDescriptor` has: `label`, `domain`, `direction?`, `bitWidth?`, `netId`, `connectedTo` (lines 94-107).
- [x] **PASS** - `NetDescriptor` has: `netId`, `domain`, `bitWidth?`, `pins` - NO `inferredWidth` (lines 35-47).
- [x] **PASS** - `ComponentDescriptor` has: `index`, `typeId`, `label`, `instanceId`, `pins`, `properties`, `modelKey` - NO `availableModels`, NO `activeModel` (lines 71-86).
- [x] **PASS** - `Diagnostic` re-export DROPPED. File imports for local use only, does NOT re-export.
- [x] **PASS** - Doc comment updated with analog addressing example (line 8).

---

## `src/headless/netlist.ts`

- [ ] **FAIL** - Old `resolveNets()` body NOT deleted. The file still contains the full ~380-line union-find algorithm (lines 41-418). The spec requires: Delete the entire 380-line resolveNets() body and replace with delegation to `resolveModelAssignments` + `extractConnectivityGroups`. The current implementation is a standalone parallel reimplementation of connectivity extraction.
- [ ] **FAIL** - New `resolveNets()` does NOT delegate to `resolveModelAssignments` + `extractConnectivityGroups`. It runs its own union-find.
- [ ] **FAIL** - `buildNetlistView` function does NOT exist. The spec requires a new ~100-120 line function.
- [ ] **FAIL** - `NetPin.domain` is populated via a local `pinDomain()` helper (lines 228-231) that uses `def?.modelRegistry !== undefined` heuristic, NOT from `ResolvedGroupPin.domain` as required.
- [ ] **FAIL** - `NetDescriptor.domain` derived from local heuristic (lines 303-309), NOT from `ConnectivityGroup.domains` as required.
- [ ] **FAIL** - `ComponentDescriptor.modelKey` comes from `el.getAttribute(model)` with fallback `digital` (lines 403-404), NOT from `ModelAssignment.modelKey` as required.
- [ ] **FAIL** - Diagnostic code remains in netlist.ts. Unconnected-input diagnostics (lines 320-339) and multi-driver diagnostics (lines 343-358) are generated directly here instead of being produced by `extractConnectivityGroups`.

---

## `src/compile/extract-connectivity.ts`

- [ ] **FAIL** - Unconnected-input diagnostic NOT present. The spec requires: single-pin group where the pin is INPUT and domain === digital. For analog single-pin groups, reword to Floating terminal. No such diagnostics exist in this file.
- [ ] **FAIL** - Multi-driver diagnostic NOT present. The spec requires: group with multiple OUTPUT digital pins. Suppress entirely when all pins on the group are analog-domain. No such diagnostics exist in this file.
- [ ] **FAIL** - Diagnostics do NOT carry `involvedPositions: Point[]`. No `involvedPositions` field appears anywhere in the diagnostics emitted by this file.
- [ ] **FAIL** - Width-mismatch diagnostic NOT improved to name pins. Current message (line 415): `Net N: connected digital pins have mismatched bit widths: 1, 8`. Spec requires: `Bit-width mismatch: R1:A [8-bit] <-> gate:out [1-bit]`.
- [ ] **FAIL** - Analog-digital boundary diagnostic (Analog terminal connected to multi-bit digital bus) NOT present.
- [ ] **FAIL** - Width-mismatch NOT suppressed when both sides are analog.

---

## `src/solver/analog/compiler.ts`

- [x] **PASS** - `labelTypesPartition` set DELETED. Grep confirms no matches in the file.
- [x] **PASS** - No `if (!labelTypesPartition.has(...))` guard. Lines 938-951 show all labeled components get entries in `labelToNodeId` without any type whitelist filtering.

---

## `src/solver/coordinator.ts` + `coordinator-types.ts`

- [ ] **FAIL** - `setSourceByLabel(label, paramKey, value)` method signature deviates from spec. The spec requires THREE parameters: `setSourceByLabel(label: string, paramKey: string, value: number)`. The actual implementation has TWO parameters: `setSourceByLabel(label: string, value: number)` (coordinator.ts line 585, coordinator-types.ts line 268). The `paramKey` parameter is missing from the signature. The spec says paramKey defaults to `paramDefs[0]` when not provided, implying it is an optional parameter the caller CAN supply.
- [x] **PASS** - Resolves label to element via `labelToCircuitElement` (coordinator.ts lines 589-591).
- [x] **PASS** - Determines primary parameter from `modelRegistry...paramDefs[0]` (coordinator.ts lines 607-609).
- [x] **PASS** - Calls `setComponentProperty` to re-stamp MNA matrix (coordinator.ts line 612).
- [x] **PASS** - Method added to `SimulationCoordinator` interface (coordinator-types.ts line 268).

---

## `src/headless/builder.ts`

- [ ] **FAIL** - `validatePinConnection` method NOT deleted. It still exists at lines 844-864 (~20 lines).
- [ ] **FAIL** - Bit-width check NOT deleted from `connect()`. Lines 281-292 still contain the width mismatch check that throws FacadeError.
- [ ] **FAIL** - `connect()` does NOT keep ONLY pin-exists validation and duplicate-wire check. It still has direction validation (line 278) and width validation (lines 281-292).
- [ ] **FAIL** - JSDoc NOT updated per spec. The method has a minimal comment instead of the specified text.

---

## `src/headless/facade.ts` + `src/headless/default-facade.ts`

- [x] **PASS** - `setInput` renamed to `setSignal` (hard cut). `setInput` does NOT exist.
- [x] **PASS** - `readOutput` renamed to `readSignal` (hard cut). `readOutput` does NOT exist.
- [x] **PASS** - `runToStable` REMOVED from interface.
- [x] **PASS** - `settle` method exists with signature `settle(coordinator, settleTime?): Promise<void>` (facade.ts:117-118).
- [x] **PASS** - Default settleTime: 0.01 (default-facade.ts:143).
- [x] **PASS** - Pure digital: single step, no iteration loop (default-facade.ts:144-146).
- [x] **PASS** - Analog/mixed: `stepToTime` (default-facade.ts:148).
- [x] **PASS** - `setSignal` auto-routes analog via `coordinator.setSourceByLabel` (default-facade.ts:159-162).
- [x] **PASS** - `step()` JSDoc includes analog/mixed timestep note (facade.ts:96-98).
- [x] **PASS** - `runTests` is async (facade.ts:175, default-facade.ts:190).
- [x] **PASS** - Hard guard rejecting analog-only circuits REMOVED.
- [x] **PASS** - Input detection uses `labelSignalMap` domain (default-facade.ts:211-213).
- [x] **PASS** - `setSignal`/`readSignal` JSDoc: Write/Read a signal value by label (facade.ts:132, 141).
- [x] **PASS** - `facade.ts:55-66` connect() JSDoc: no claims about direction/width validation.

---

## `src/testing/executor.ts` + `src/testing/parser.ts`

- [x] **PASS** - `RunnerFacade`: `setInput` -> `setSignal`, `readOutput` -> `readSignal`, `runToStable` -> `settle` (async). All three renames confirmed (executor.ts:32-35).
- [x] **PASS** - `executeTests` is async (executor.ts:69).
- [x] **PASS** - `executeVector` is async, calls `await facade.settle(coordinator)` (executor.ts:104, 150, 159, 164).
- [ ] **MISSING** - `TestValue` union does NOT include `analogValue` kind. Current: value/dontCare/clock/highZ. Spec requires analogValue with number value and optional Tolerance.
- [ ] **MISSING** - `Tolerance` interface does not exist. Spec requires: { absolute?: number; relative?: number }.
- [ ] **MISSING** - `parseSIValue` helper for f/p/n/u/m/k/M/G suffixes does not exist.
- [ ] **MISSING** - `parseTestValue` does NOT get `domain` parameter. Current signature: parseTestValue(text, line).
- [ ] **MISSING** - `ParsedTestData` NOT extended with `analogPragmas` and `signalDomains`.
- [ ] **MISSING** - `withinTolerance(actual, expected, tol)` function does not exist.
- [ ] **MISSING** - Analog test failure message format not implemented. No Expected 3.3V +/-5% format.

---

## `src/headless/equivalence.ts`

- [x] **PASS** - Throws when both circuits have zero I/O: No input/output labels found (lines 51-55).
- [x] **PASS** - `runToStable` -> `await facade.settle()` (lines 86-87).
- [x] **PASS** - `setInput`/`readOutput` -> `setSignal`/`readSignal` (lines 81-82, 90-91).
- [x] **PASS** - Function is async (line 21).

---

## Summary

| Result    | Count |
|-----------|-------|
| PASS      | 39    |
| FAIL      | 18    |
| MISSING   | 7     |
| **Total** | **64** |

### Critical Failures (structural - algorithm not rebuilt)

**1. `netlist.ts`: `resolveNets()` body NOT deleted/rebuilt (7 FAIL items).**
The entire file retains a parallel union-find implementation instead of delegating to `resolveModelAssignments` + `extractConnectivityGroups`. This is the single largest spec violation - it means the netlist view uses a different algorithm than compilation, defeating the single source of truth goal. The `buildNetlistView` function is also absent.

**2. `extract-connectivity.ts`: Missing ALL connectivity diagnostics (6 FAIL items).**
Unconnected-input, multi-driver, floating-terminal, analog-digital boundary, and improved width-mismatch diagnostics are all absent from this file. These exist only in the un-deleted `netlist.ts` (in an inferior form without domain awareness, without `involvedPositions`, and without pin-naming in width-mismatch messages).

**3. `builder.ts`: `validatePinConnection` and width check NOT deleted (4 FAIL items).**
The spec explicitly requires removing electrical validation from `connect()`, deferring it to `netlist()`/`compile()`.

### High Failures

**4. `coordinator.ts`: `setSourceByLabel` signature missing `paramKey` parameter (1 FAIL).**
The two-argument signature (label, value) removes the caller ability to specify which parameter to set. The spec requires three arguments: (label, paramKey, value) with paramKey being optional (defaulting to paramDefs[0]).

### Missing Features (testing pipeline)

**5. `parser.ts` + `executor.ts`: Entire analog test infrastructure missing (7 MISSING items).**
`analogValue` TestValue kind, `Tolerance` interface, `parseSIValue`, domain-aware `parseTestValue`, `analogPragmas`/`signalDomains` on `ParsedTestData`, `withinTolerance`, and analog failure messages - none exist.

---

### Recommendation

**REQUEST CHANGES** - 18 FAIL + 7 MISSING items prevent approval. The three structural failures (netlist.ts rebuild, extract-connectivity.ts diagnostics, builder.ts validation removal) are HIGH severity and block the core goals of Wave 1. The testing pipeline items are MEDIUM severity (analog test support is new functionality). All items must be addressed before Wave 2 can begin.
