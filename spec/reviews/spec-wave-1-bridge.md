# Spec Review: Wave 1 — Bridge Architecture Rewrite

## Verdict: needs-revision

---

## Plan Coverage

There is no `plan.md` for this combined spec. Wave 1 is self-contained and defines its own scope.
Evaluating coverage of the spec's own stated goals against its tasks:

| Stated Goal | Covered by Task | Notes |
|-------------|-----------------|-------|
| Ideal voltage source output bridge (replace Norton) | 1.1, 1.3 | Covered |
| Sense-only input bridge (conditional loading) | 1.2, 1.3 | Covered |
| Domain injection for "all" mode + per-net overrides | 1.4 | Covered |
| Analog partition guard fix (bridge-only partitions) | 1.5 | Covered |
| Integrate bridge MNA elements into analog compiler | 1.6 | Covered |
| Update coordinator bridge logic | 1.7 | Covered |
| Rewrite tests encoding wrong behavior | 1.8 | Covered, but a referenced test file does not exist (see Completeness) |

---

## Internal Consistency Issues

### Issue 1: Task 1.3 `isReactive` semantics conflict with Tasks 1.1 and 1.2

Task 1.3 specifies:

> `BridgeOutputAdapter`: `isReactive` — true only when loaded and cOut > 0
> `BridgeInputAdapter`: `isReactive` — true only when loaded and cIn > 0

This means `isReactive` becomes a runtime-computed value, not a compile-time constant. However, Tasks 1.1 and 1.2 say `stampCompanion` should be conditional — "only stamp cOut companion when loaded (`cOut > 0`)" and "if loaded and `cIn > 0`, stamp companion. Otherwise no-op." If `stampCompanion` is already a conditional no-op internally, then `isReactive` can remain `true` unconditionally (the call is made but does nothing). The spec provides two different solutions to the same problem — conditional `isReactive` (Task 1.3) and conditional no-op inside `stampCompanion` (Tasks 1.1/1.2) — without saying which takes precedence or how they interact. An implementer must choose one approach, and the two tasks may produce incompatible implementations.

Concrete conflict: if Task 1.2 implementer makes `stampCompanion` a no-op internally, then Task 1.3 implementer also changes `isReactive` to `false` when unloaded, the assembler will not call `stampCompanion` at all — consistent. But if Task 1.1/1.2 makes `stampCompanion` a conditional no-op and Task 1.3 leaves `isReactive: true` (the current value), the test `unloaded output adapter does not stamp rOut` would pass but the assembler would still call `stampCompanion` (harmlessly). If Task 1.3 changes `isReactive` to a computed property and Task 1.1/1.2 already made `stampCompanion` a no-op, the assembler skips calling `stampCompanion` — also fine but redundant. The spec must specify definitively which approach governs.

### Issue 2: Task 1.3 references `BridgeOutputAdapter.isNonlinear: false` but does not address `stampNonlinear` removal from the adapter

Task 1.3 says:

> `isNonlinear: false` (ideal source is linear; logic level changes are handled via re-stamp by coordinator, not via NR iteration)
> Remove `stampNonlinear()` — the coordinator calls `stamp()` after updating logic level

This is stated under Task 1.3 (adapter rewrite). Task 1.1 also says "Remove `stampNonlinear`" — but Task 1.1 is about `DigitalOutputPinModel`, not `BridgeOutputAdapter`. The current `BridgeOutputAdapter` has its own `stampNonlinear` that delegates to `_pinModel.stamp()`. Both Task 1.1 (pin model) and Task 1.3 (adapter) say to remove `stampNonlinear`, but only Task 1.1 includes it in the acceptance criteria as a listed item. Task 1.3's acceptance criteria do not include "stampNonlinear is absent from BridgeOutputAdapter." An implementer doing Task 1.3 without re-reading Task 1.1 might miss that `BridgeOutputAdapter.stampNonlinear()` itself must be deleted.

### Issue 3: Task 1.7 says coordinator `stepMixedSignal()` is updated, but the method is named `_stepMixed()` in the actual code

Task 1.7 states:

> `stepMixedSignal()` — digital→analog: read digital signal → call `adapter.setLogicLevel(high)` on the BridgeOutputAdapter → analog engine re-stamps.

The actual method in `src/solver/coordinator.ts` is `_stepMixed()` (line 178), not `stepMixedSignal()`. This mismatch will cause an implementer to search for a non-existent method. A secondary problem: the spec says "analog engine re-stamps" but does not specify how or when `stamp()` is called on the bridge adapter after `setLogicLevel()` — the coordinator currently has no explicit re-stamp call; the assembler drives stamping via the engine step. The spec should clarify the re-stamp mechanism (e.g., whether the coordinator calls `adapter.stamp(solver)` directly or the engine's step loop calls it).

### Issue 4: Task 1.4 and Task 1.6 both process per-net overrides but via different mechanisms without coordination spec

Task 1.4 mutates `group.domains` (injecting `"analog"`) and sets `group.loadingMode`. Task 1.6 reads `group.loadingMode` when creating bridge adapters. However, Task 1.6 also says:

> Determine loading mode: check `group.loadingMode` (from Task 1.4). Default is `"loaded"` for `"cross-domain"`/`"all"` modes, `"ideal"` for `"none"` mode.

This is a different statement from what Task 1.4 defines: Task 1.4 says `loadingMode` is only set for the `"ideal"` per-net override on a boundary group. The absence of `loadingMode` on a group therefore means "use the circuit-level mode." But Task 1.6 says the default for `"none"` mode is `"ideal"` — which means Task 1.6 must also know the circuit-level `digitalPinLoading` value, not just `group.loadingMode`. The spec does not say how `compileAnalogPartition` receives the circuit-level `digitalPinLoading` value at the point where bridge adapters are created (it is already a parameter of the function, line ~1042 in compiler.ts, so this is technically achievable — but the spec does not explicitly say "read the existing `digitalPinLoading` parameter to determine default loading mode when `group.loadingMode` is absent").

---

## Completeness Gaps

### Gap 1: Task 1.8 references a test file that does not exist

Task 1.8 says:

> `src/solver/analog/__tests__/digital-bridge-path.test.ts` — update to test ideal voltage source bridge behavior instead of Norton equivalent

This file does not exist in the codebase. Glob search confirms: no file at that path. The spec says "rewrite" but there is nothing to rewrite. The task must either (a) create this file from scratch with the specified assertions, or (b) remove this file reference. The spec gives no "Files to create" section for Task 1.8, only "Files to modify" — so an implementer has no clear instruction on what to do when the target file is absent.

### Gap 2: Task 1.5 does not specify how `compileAnalogPartition` receives the ground group from the digital partition

Task 1.5 says:

> If a Ground element exists in the digital partition (check via the outer circuit), tie analog ground to that position

The function signature for `compileAnalogPartition` operates on a `SolverPartition` (the analog partition). The digital partition is a separate `SolverPartition`. Task 1.5 does not specify how the analog compiler accesses the digital partition, whether a new parameter is added, or how "check via the outer circuit" is implemented. The phrase "check via the outer circuit" is not a concrete instruction.

### Gap 3: Task 1.6 does not specify how to handle multi-pin boundary groups (multiple output or input pins)

Task 1.6 describes:

> For each digital output pin in the group: ... For each digital input pin in the group: ...

The spec does not address how a single boundary group with multiple digital output pins maps to multiple `BridgeOutputAdapter` instances. Specifically: how are these multiple adapters keyed in `elementBridgeAdapters`? The map is `Map<number, Array<BridgeOutputAdapter | BridgeInputAdapter>>` (keyed by element index), but bridge adapters are not per-element — they are per-pin per-group. The spec says nothing about what element index to use as the map key for bridge adapters created from group stubs rather than from `partition.components`.

### Gap 4: Task 1.7 does not specify how the coordinator knows which bridge adapter corresponds to which digital net

Task 1.7 says the coordinator should call `adapter.setLogicLevel(high)` on the `BridgeOutputAdapter`, but the coordinator currently uses `compiled.bridges` (`BridgeAdapter[]` from the compile output). The spec does not specify how the coordinator discovers which `BridgeOutputAdapter` MNA element corresponds to which `BridgeAdapter` descriptor in `compiled.bridges`. This is the central wiring problem of the rewrite and it is left unaddressed.

### Gap 5: Task 1.3 does not specify the new `getPinCurrents()` implementation for the ideal voltage source

The current `BridgeOutputAdapter.getPinCurrents()` computes current using Norton equivalent (`(vNode - vTarget) * gOut`). For an ideal voltage source, current is read from the branch variable in the solution vector. Task 1.3 says:

> `getPinCurrents()` — reads branch current from solution vector (branch variable gives current directly)

But it does not specify the index formula (e.g., `voltages[nodeCount + branchIndex]`), whether the solution vector layout is the same as for other branch elements (e.g., voltage sources), or whether the sign convention is consistent with other elements. An implementer must guess at the solution vector layout.

### Gap 6: Task 1.2 acceptance criteria count mismatches the test list

Task 1.2 lists 4 tests and acceptance criteria say "All 4 tests pass." However, the tests are specified in the same file as Task 1.1 (`digital-pin-model.test.ts`). The spec does not clarify whether Tasks 1.1 and 1.2 are executed by the same agent or different agents. If different agents share the same file, there is a write conflict. No ordering constraint is stated between 1.1 and 1.2.

### Gap 7: Task 1.8 "Files to modify" omits acceptance criteria count for `digital-bridge-path.test.ts`

Task 1.8 acceptance criteria say:

> "none" mode tests verify: bridges at real boundaries, zero loading (rIn=∞ input stamps nothing, cIn=0, cOut=0)

The acceptance criterion says "rIn=∞ input stamps nothing" but Task 1.2 specifies that unloaded input stamps nothing (a no-op), which means `rIn` is irrelevant — it does not need to be `∞`. The acceptance criterion conflates the old behavior (Norton conductance `1/rHiZ`) with the new behavior (conditional no-op stamp). This will confuse implementers writing tests that check for `rIn=∞`.

---

## Concreteness Issues

### Issue 1: Task 1.1 stamp equations use undefined index variables

Task 1.1 specifies:

> `stamp(solver)`: stamp branch equation `A[branchRow][nodeCol] = 1`, `A[nodeRow][branchCol] = 1`, `z[branchRow] = V_target`

The variables `branchRow`, `nodeCol`, `nodeRow`, `branchCol` are not defined. The MNA matrix layout for voltage sources in this codebase uses specific index formulas (typically `nodeCount + branchIndex` for branch rows). The spec should state the concrete index formula: e.g., `branchRow = nodeCount + branchIndex`, `nodeCol = nodeId - 1`. Without this, an implementer does not know whether the existing `SparseSolver.stamp(row, col, value)` signature takes zero-based node indices or branch-offset indices.

### Issue 2: Task 1.3 says "coordinator calls `stamp()` after updating logic level" but this is not how the analog engine works

The spec says:

> `isNonlinear: false` (ideal source is linear; logic level changes are handled by re-stamp by coordinator, not via NR iteration)

If `isNonlinear` is `false`, the assembler will not call `stampNonlinear`. But the RHS value `z[branchRow] = V_target` changes when `setLogicLevel` is called. An ideal voltage source with a changing RHS is nonlinear in the MNA sense unless the assembler calls `stamp()` again. The spec says the coordinator handles this but does not specify the mechanism: does the coordinator call `adapter.stamp(solver)` directly? Does it trigger a full matrix rebuild? The phrase "re-stamp by coordinator" is not implementable without knowing the coordinator's access to the solver object.

### Issue 3: Task 1.4 uses `ReadonlyMap<number, "loaded" | "ideal">` as the type for `perNetOverrides` but `resolveLoadingOverrides` returns `Map<number, 'loaded' | 'ideal'>`

The spec specifies the function signature as:

```typescript
export function applyLoadingDecisions(
  groups: ConnectivityGroup[],
  digitalPinLoading: "cross-domain" | "all" | "none",
  perNetOverrides: ReadonlyMap<number, "loaded" | "ideal">,
): void
```

The existing `compile.ts` already computes `perNetLoadingOverrides` as a `Map<number, 'loaded' | 'ideal'>` and passes it to `partitionByDomain`. The spec's choice to put `applyLoadingDecisions` in `extract-connectivity.ts` rather than `compile.ts` is not explained. Since `applyLoadingDecisions` mutates `ConnectivityGroup` objects (adding to `domains`), and `extractConnectivityGroups` returns those groups, the function would logically belong in `compile.ts` as a post-processing step. Placing it in `extract-connectivity.ts` is not wrong but will surprise implementers given the file's current scope (extraction only, no mutation).

### Issue 4: Task 1.5 acceptance criteria reference `compiledAnalog.groups` but the compiled circuit type does not expose groups

Task 1.5 test:

> `analog partition with bridge groups but no components assigns node 0` — `nodeCount >= 1`

The acceptance criterion `nodeCount >= 1` is verifiable. But the other criteria reference "bridge-only analog partitions" without specifying how the test constructs such a partition (a circuit with no analog components but with mixed-domain wiring in `"all"` mode). The test setup is not described concretely: what minimal circuit definition produces a pure-digital `"all"` mode partition? The test title says "pure-digital circuit in 'all' mode" but does not specify what components the circuit contains.

### Issue 5: Task 1.7 coordinator test assertions use approximate equality without specifying tolerance

Task 1.7 test:

> `digital output drives analog node via bridge adapter` — digital step sets output high → analog node voltage ≈ vOH

The `≈` symbol is used without specifying acceptable tolerance. For an ideal voltage source, the node voltage should be exactly `vOH` (within floating-point precision). The spec should say "within 1e-9 V" or "exactly vOH" to distinguish from the current Norton equivalent (which achieves only approximately `vOH` due to `rOut` loading). This matters because the test is verifying the architectural switch to ideal source — the tolerance defines what "ideal" means.

### Issue 6: Task 1.6 says "Resolve `ResolvedPinElectrical` for each pin in the boundary group using `resolvePinElectrical()`" without specifying inputs

`resolvePinElectrical()` exists in `src/core/pin-electrical.ts` and is already imported in `compiler.ts`. But Task 1.6 does not specify what arguments to pass: which logic family, which pin override, which component override. The existing call at line ~1210 of compiler.ts has access to `circuitFamily`, `mergedPinOverride`, and `componentOverride` from the element loop — but bridge stubs are not elements in `partition.components`. The spec does not say where these values come from for bridge stubs.

---

## Implementability Concerns

### Concern 1: Tasks 1.1 and 1.2 write the same file — wave ordering is unspecified

Both Task 1.1 and Task 1.2 modify `src/solver/analog/digital-pin-model.ts`. If run in parallel (as tasks in the same wave), they will conflict. The spec places both in Wave 1 without assigning sub-wave ordering. If Task 1.3 depends on the output of 1.1 and 1.2, and 1.1/1.2 share a file, all three must run sequentially. The spec does not state this ordering constraint.

Similarly, Task 1.3 modifies `src/solver/analog/bridge-adapter.ts` and `src/solver/analog/compiled-analog-circuit.ts`. Task 1.6 also modifies `src/solver/analog/compiler.ts` and `src/solver/analog/compiled-analog-circuit.ts`. Tasks 1.3 and 1.6 share a file — no ordering is specified.

### Concern 2: Task 1.3's `makeBridgeOutputAdapter` new signature breaks all existing call sites

The spec changes `makeBridgeOutputAdapter(spec, nodeId)` to `makeBridgeOutputAdapter(spec, nodeId, branchIdx, loaded)`. Task 1.3 does not list the existing call site in `compiler.ts` (line ~1095 area) as a file to modify. The current code does not call `makeBridgeOutputAdapter` at all (the `elementBridgeAdapters` map is populated nowhere — confirmed by grep), but `makeBridgeInputAdapter` is also exported. If Wave 2 or other tests call these factories directly, the signature change will break them. The spec provides no list of call sites to update.

### Concern 3: The spec does not say how the coordinator accesses `BridgeOutputAdapter` instances

Task 1.7 says the coordinator should call `adapter.setLogicLevel(high)` on `BridgeOutputAdapter`, but the coordinator currently iterates `compiled.bridges` (a `BridgeAdapter[]` — a different type from `BridgeOutputAdapter`). The spec does not explain how the coordinator obtains references to the new `BridgeOutputAdapter` MNA elements created in Task 1.6. Options include: (a) the compiler adds them to `compiled.bridges` replacing `BridgeAdapter`, (b) the coordinator looks them up via `compiledAnalog.elementBridgeAdapters`, or (c) a new field is added to `CompiledCircuitUnified`. The spec leaves this entirely implicit, which is the most critical missing piece of Task 1.7.

### Concern 4: Task 1.5 ground synthesis requires accessing the digital partition from within the analog compiler

Task 1.5 says:

> If a Ground element exists in the digital partition (check via the outer circuit), tie analog ground to that position

`compileAnalogPartition` in `compiler.ts` receives `partition: SolverPartition` (the analog partition only) and `circuit: CompiledCircuit`. It does not receive the digital partition. To check for a Ground element in the digital partition, the function would need access to either the digital partition or the full `compile.ts` context. The spec does not say to add a parameter to `compileAnalogPartition` for this purpose, nor does it describe the alternative (check `circuit.elements` for any Ground element regardless of partition). This is a structural gap that will block implementation.

### Concern 5: Task 1.8's `digital-bridge-path.test.ts` file does not exist — "rewrite" instruction is invalid

As noted above, `src/solver/analog/__tests__/digital-bridge-path.test.ts` does not exist. An implementer instructed to "rewrite" a non-existent file has no clear action. The task should be: create the file from scratch (and if so, specify the minimum set of tests and the circuit setup needed). The absence of this file may also indicate that the coverage Task 1.8 expects from that file is already covered elsewhere — or is a genuine gap. The spec does not address this.

### Concern 6: Task 1.6 — the `elementBridgeAdapters` map is keyed by element index, but bridge stubs have no element index

The `elementBridgeAdapters` map in `compiler.ts` is `Map<number, Array<...>>` where keys are element indices from `partition.components`. Bridge stubs (`BridgeStub`) have `boundaryGroupId` and `descriptor`, not element indices. Task 1.6 says to add bridge adapters to `elementBridgeAdapters`, but the map key for a bridge adapter is undefined. The coordinator's `setComponentProperty` at line 513 looks up `elementBridgeAdapters.get(elementIndex)` — if bridge adapters are not keyed by element index, `setComponentProperty` routing for pin-electrical params will not reach them. The spec does not provide the key strategy.

### Concern 7: No migration path for existing `compiled.bridges: BridgeAdapter[]` in coordinator

The coordinator's `_stepMixed()` iterates `this._bridges` (a `BridgeAdapter[]` with fields `direction`, `analogNodeId`, `digitalNetId`, `bitWidth`, `electricalSpec`). Task 1.7 says the coordinator should instead call `adapter.setLogicLevel()` and `adapter.readLogicLevel()` on the new bridge adapter types. But `BridgeAdapter` (the descriptor in `compiled.bridges`) and `BridgeOutputAdapter`/`BridgeInputAdapter` (the MNA elements) are two different object types. The spec does not say whether `compiled.bridges` is replaced, augmented, or preserved alongside the new MNA elements. This is a structural decision that determines whether `coordinator.ts` needs to remove its `_bridges` field entirely or keep it for other purposes (e.g., signal address routing).
