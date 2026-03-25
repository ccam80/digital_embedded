# Phase 3: Unified Netlist Extraction and Partitioning

**Goal**: One netlist pass replaces three (`traceNets`, `buildNodeMap`, `partitionMixedCircuit`). One `compile()` entry point produces a unified `CompiledCircuit`.

**Reference**: `spec/unified-component-architecture.md` Sections 4.2–4.6 for full design.

**Pre-existing test failures**: 4 tests fail due to missing git submodule (`ref/Digital` not initialized). These are NOT regressions.

---

## Wave 3.1 — Foundation types and shared union-find

### P3-1: Define unified compilation types (S)

Create `src/compile/types.ts` with all new types from spec Sections 4.3–4.6:

```typescript
// From Section 4.3
interface ConnectivityGroup {
  groupId: number;
  pins: ResolvedGroupPin[];
  wires: Wire[];
  domains: Set<string>;
  bitWidth?: number;
}

interface ResolvedGroupPin {
  elementIndex: number;
  pinIndex: number;
  pinLabel: string;
  direction: PinDirection;
  bitWidth: number;
  worldPosition: Point;
  wireVertex: Point | null;
  domain: string;
}

// From Section 4.4
interface SolverPartition {
  components: PartitionedComponent[];
  groups: ConnectivityGroup[];
  bridgeStubs: BridgeStub[];
  crossEngineBoundaries: CrossEngineBoundary[];
}

interface PartitionedComponent {
  element: CircuitElement;
  definition: ComponentDefinition;
  model: DigitalModel | AnalogModel;
  resolvedPins: ResolvedGroupPin[];
}

interface BridgeDescriptor {
  boundaryGroup: ConnectivityGroup;
  direction: "digital-to-analog" | "analog-to-digital";
  bitWidth: number;
  electricalSpec: PinElectricalSpec;
}

interface BridgeStub {
  boundaryGroupId: number;
  descriptor: BridgeDescriptor;
}

// From Section 4.6
interface CompiledCircuitUnified {
  digital: CompiledDigitalDomain | null;
  analog: CompiledAnalogDomain | null;
  bridges: BridgeAdapter[];
  wireSignalMap: Map<Wire, SignalAddress>;
  labelSignalMap: Map<string, SignalAddress>;
  diagnostics: Diagnostic[];
}

type SignalAddress =
  | { domain: "digital"; netId: number; bitWidth: number }
  | { domain: "analog"; nodeId: number };

type SignalValue =
  | { type: "digital"; value: number }
  | { type: "analog"; voltage: number; current?: number };
```

**Files to create**: `src/compile/types.ts`
**Files to read**: `src/core/engine-interface.ts`, `src/core/registry.ts`, `src/engine/cross-engine-boundary.ts`, `src/analog/compiled-analog-circuit.ts`, `src/headless/netlist-types.ts` (for `Diagnostic`)

**Notes**:
- Import existing types (`CircuitElement`, `Wire`, `ComponentDefinition`, `DigitalModel`, `AnalogModel`, `PinElectricalSpec`, `CrossEngineBoundary`, `BridgeAdapter`) — do NOT redefine them.
- `CompiledDigitalDomain` is the existing `CompiledCircuitImpl` from `src/engine/compiled-circuit.ts`.
- `CompiledAnalogDomain` is the existing `ConcreteCompiledAnalogCircuit` from `src/analog/compiled-analog-circuit.ts`.
- Export all types. Add a barrel `src/compile/index.ts` that re-exports from `types.ts`.
- Use `PinDirection` from whatever module currently defines it (check `src/core/` types).

**Acceptance**: Types compile with no errors. No runtime behaviour change.

---

### P3-2: Consolidate union-find into shared utility (S)

Three separate union-find implementations exist:
1. `src/engine/union-find.ts` — class-based, used by `traceNets`
2. Inline in `src/analog/node-map.ts` — integer-based
3. Inline in `src/engine/mixed-partition.ts` — string-keyed `PosUnionFind`

Create a single shared implementation at `src/compile/union-find.ts`:

```typescript
class UnionFind {
  constructor(size: number);
  find(x: number): number;
  union(a: number, b: number): void;
  connected(a: number, b: number): boolean;
  readonly componentCount: number;
  groups(): Map<number, number[]>;  // root → members
}
```

**Files to create**: `src/compile/union-find.ts`, `src/compile/__tests__/union-find.test.ts`
**Files to read**: `src/engine/union-find.ts` (existing implementation to consolidate)

**Notes**:
- Path compression + union by rank for O(α(n)) amortized.
- The existing `src/engine/union-find.ts` is the most complete — use it as the base.
- Add `groups()` method (needed by `extractConnectivityGroups`).
- Do NOT delete the old `src/engine/union-find.ts` yet — that happens in Wave 3.5.
- Export from `src/compile/index.ts`.

**Acceptance**: Unit tests pass for find, union, connected, groups. Old union-find still exists and works.

---

## Wave 3.2 — Core extraction and partitioning algorithms

### P3-3: Write `extractConnectivityGroups()` (L)

Implement the unified netlist extraction algorithm from spec Section 4.3.

Create `src/compile/extract-connectivity.ts`:

```typescript
interface ModelAssignment {
  elementIndex: number;
  modelKey: string;  // "digital" | "analog"
  model: DigitalModel | AnalogModel;
}

function resolveModelAssignments(
  elements: readonly CircuitElement[],
  registry: ComponentRegistry,
): ModelAssignment[];

function extractConnectivityGroups(
  elements: readonly CircuitElement[],
  wires: readonly Wire[],
  registry: ComponentRegistry,
  modelAssignments: ModelAssignment[],
): ConnectivityGroup[];
```

**Algorithm** (from spec):
1. Collect slots: for each element, compute `pinWorldPosition(el, pin)` for every pin. Assign each pin a numeric slot ID. For each wire, assign two virtual slot IDs and union them.
2. Position-merge: `Map<string, number[]>` from `"${x},${y}"` → slot IDs. Union all slots at each position.
3. Tunnel-merge: for each Tunnel element, collect its pin slot by label. Union all slots sharing a Tunnel label.
4. Extract groups: walk union-find to produce `ConnectivityGroup[]`.
5. Tag domains: `domains` is the union of `domain` values of all pins in each group.
6. Validate widths: for groups with digital pins, enforce all pins agree on bit width.

**Files to create**: `src/compile/extract-connectivity.ts`, `src/compile/__tests__/extract-connectivity.test.ts`
**Files to read**: `src/engine/net-trace.ts` (existing algorithm), `src/analog/node-map.ts` (existing algorithm), `src/engine/mixed-partition.ts` (existing algorithm), `src/core/registry.ts` (for pin world position computation), `src/core/circuit.ts` or similar (for CircuitElement, Wire types)

**Critical details**:
- Pin world position computation: check how `traceNets` and `buildNodeMap` each compute pin positions. Use the same coordinate math (element position + rotation/mirror transform + pin offset).
- Tunnel label: digital uses `label` property, analog uses `NetName` property. The unified version should check both (prefer `NetName` if present, fall back to `label`). Read the Tunnel component definition to determine which property is canonical.
- Wire virtual slots: each wire has start/end points. Create two slots per wire and union them. Then position-merge will connect them to pins.
- `resolveModelAssignments()` implements spec Section 4.1: for each element, look up `def.models[modelKey]` where `modelKey = el.props.simulationModel ?? def.defaultModel ?? firstKey(def.models)`. Components with no models (like Wire, Tunnel) should be tagged as neutral/infrastructure.
- Ground elements: do NOT handle Ground specially here. Ground identification stays in the analog backend (per spec Section 4.3 table).

**Acceptance**:
- Pure digital circuit → all groups have `domains: {"digital"}`, no boundary groups.
- Pure analog circuit → all groups have `domains: {"analog"}`, no boundary groups.
- Mixed circuit → boundary groups have `domains.size > 1`.
- Width mismatch → diagnostic emitted.
- Tunnel merging works across positions.

---

### P3-4: Write `partitionByDomain()` (M)

Implement spec Section 4.4.

Create `src/compile/partition.ts`:

```typescript
interface PartitionResult {
  digital: SolverPartition;
  analog: SolverPartition;
  bridges: BridgeDescriptor[];
}

function partitionByDomain(
  groups: ConnectivityGroup[],
  elements: readonly CircuitElement[],
  registry: ComponentRegistry,
  modelAssignments: ModelAssignment[],
  crossEngineBoundaries: CrossEngineBoundary[],
): PartitionResult;
```

**Logic**:
- Split components by their `modelAssignment.modelKey`.
- Digital partition gets all groups with at least one digital pin.
- Analog partition gets all groups with at least one analog pin.
- Boundary groups (`domains.size > 1`) get `BridgeDescriptor`s.
- Bridge stubs: digital side gets virtual In/Out at boundaries; analog side gets Norton adapter stubs.
- When a partition has zero components, return an empty partition (not null).
- ID assignment is NOT done here — backends do it.

**Files to create**: `src/compile/partition.ts`, `src/compile/__tests__/partition.test.ts`
**Files to read**: `src/compile/types.ts` (from P3-1), `src/engine/mixed-partition.ts` (existing logic to port)

**Acceptance**:
- Pure digital → analog partition is empty, no bridges.
- Pure analog → digital partition is empty, no bridges.
- Mixed → both partitions populated, bridges at boundary groups.
- Bridge direction correctly determined (which domain drives).

---

### P3-5: Adapt `flattenCircuit()` to use activeModel (S)

Modify `src/engine/flatten.ts` so that same-vs-cross-domain classification uses `activeModel` (from model assignment) instead of `engineType`.

**Files to modify**: `src/engine/flatten.ts`
**Files to read**: `src/engine/flatten.ts`, `src/compile/extract-connectivity.ts` (for `resolveModelAssignments`), `src/core/registry.ts`

**Changes**:
- Import `resolveModelAssignments` from `src/compile/extract-connectivity.ts`.
- Replace any `engineType` comparisons with model-based domain checks.
- A subcircuit whose internal components all resolve to the same domain as the parent is same-domain (inline). Otherwise cross-domain (preserve as placeholder).
- Ensure `FlattenResult` still carries `crossEngineBoundaries`.

**Acceptance**: Existing flatten tests pass. Mixed circuits still produce correct cross-engine boundaries.

---

## Wave 3.3 — Backend compiler adaptation

### P3-6: Adapt digital compiler to accept SolverPartition (L)

Modify `src/engine/compiler.ts` to accept a `SolverPartition` as input instead of (or in addition to) a raw `Circuit`.

**Files to modify**: `src/engine/compiler.ts`
**Files to read**: `src/engine/compiler.ts` (full file), `src/compile/types.ts`, `src/engine/compiled-circuit.ts`

**Changes**:
- Add new entry point: `compileDigitalPartition(partition: SolverPartition, registry: ComponentRegistry): CompiledCircuitImpl`
- This function receives pre-computed `ConnectivityGroup[]` and `PartitionedComponent[]`.
- Map `ConnectivityGroup.groupId` → sequential net IDs as the first step.
- Skip calling `traceNets()` — connectivity is pre-computed in the groups.
- Skip the wire→netId propagation pass (Steps A–C) — wire→netId comes from groups' `wires` arrays.
- Keep all digital-specific logic: multi-driver detection, SCC decomposition, topological sort, wiring table construction.
- Keep the existing `compileCircuit()` function working (it can internally create groups and call `compileDigitalPartition`). This maintains backwards compatibility during transition.
- `labelToNetId` is still computed from In/Out/Probe labels in the partition's components.

**Acceptance**:
- Existing `compileCircuit()` tests still pass (backwards compat).
- New `compileDigitalPartition()` produces identical `CompiledCircuitImpl` for the same circuit.
- A targeted test: build a simple circuit, extract groups, partition, compile via new path, verify net IDs and wiring table match.

---

### P3-7: Adapt analog compiler to accept SolverPartition (L)

Modify `src/analog/compiler.ts` to accept a `SolverPartition` as input.

**Files to modify**: `src/analog/compiler.ts`
**Files to read**: `src/analog/compiler.ts` (full file), `src/compile/types.ts`, `src/analog/node-map.ts`, `src/analog/compiled-analog-circuit.ts`

**Changes**:
- Add new entry point: `compileAnalogPartition(partition: SolverPartition, registry: ComponentRegistry, transistorModels?: TransistorModelRegistry): ConcreteCompiledAnalogCircuit`
- This function receives pre-computed `ConnectivityGroup[]` and `PartitionedComponent[]`.
- Map groups → MNA node IDs: identify Ground group → node 0, others → sequential from 1.
- Skip calling `buildNodeMap()` — connectivity is pre-computed.
- Keep all analog-specific logic: internal node allocation, branch row allocation, MNA matrix sizing, factory invocation, topology validation.
- Keep the existing `compileAnalogCircuit()` function working for backwards compatibility.
- Handle bridge stubs from the partition's `bridgeStubs` and `crossEngineBoundaries`.

**Acceptance**:
- Existing `compileAnalogCircuit()` tests still pass.
- New `compileAnalogPartition()` produces identical compiled output for the same circuit.
- A targeted test: build a simple analog circuit, extract groups, partition, compile via new path, verify node IDs match.

---

## Wave 3.4 — Unified compile entry point and bridge assembly

### P3-8: Write unified `compile()` entry point (M)

Create `src/compile/compile.ts` — the single entry point from spec Section 4 flowchart.

```typescript
function compileUnified(
  circuit: Circuit,
  registry: ComponentRegistry,
  transistorModels?: TransistorModelRegistry,
): CompiledCircuitUnified;
```

**Pipeline**:
1. `resolveModelAssignments()` — assign each component to a domain.
2. `flattenCircuit()` — inline same-domain subcircuits, preserve cross-domain as placeholders.
3. `extractConnectivityGroups()` — unified netlist extraction.
4. `partitionByDomain()` — split into digital/analog partitions + bridge descriptors.
5. If digital partition non-empty: `compileDigitalPartition()` → `CompiledDigitalDomain`.
6. If analog partition non-empty: `compileAnalogPartition()` → `CompiledAnalogDomain`.
7. Build bridge cross-reference map: `{ boundaryGroupId → digitalNetId, analogNodeId }`.
8. Build `wireSignalMap`: for each group, map group's wires to appropriate `SignalAddress`.
9. Build `labelSignalMap`: for each In/Out/Probe label, map to `SignalAddress`.
10. Assemble and return `CompiledCircuitUnified`.

**Files to create**: `src/compile/compile.ts`, `src/compile/__tests__/compile.test.ts`
**Files to read**: `src/compile/types.ts`, `src/compile/extract-connectivity.ts`, `src/compile/partition.ts`, `src/engine/compiler.ts`, `src/analog/compiler.ts`, `src/engine/flatten.ts`

**Acceptance**:
- Pure digital circuit compiles correctly through unified path.
- Pure analog circuit compiles correctly through unified path.
- Mixed circuit compiles with correct bridge cross-reference map.
- `wireSignalMap` contains entries for all wires.
- `labelSignalMap` contains entries for all labeled In/Out/Probe components.

---

### P3-9: Integration tests for unified compilation (M)

Write comprehensive integration tests that verify the unified pipeline produces correct results by comparing against the old pipeline.

Create `src/compile/__tests__/compile-integration.test.ts`:

**Test cases**:
1. Simple AND gate (2 inputs, 1 output) — digital only, verify net IDs match old compiler.
2. SR latch with feedback — digital, verify SCC handling preserved.
3. Simple resistor divider — analog only, verify node IDs match old compiler.
4. RC circuit — analog with capacitor, verify branch allocation.
5. Mixed digital+analog circuit — verify bridge descriptors, both partitions compile, cross-reference map populated.
6. Circuit with Tunnels — verify tunnel merging works across domains.
7. Width mismatch — verify diagnostic emitted.
8. Empty circuit — verify graceful handling.

**Files to create**: `src/compile/__tests__/compile-integration.test.ts`
**Files to read**: Existing test files for patterns: `src/engine/__tests__/compiler.test.ts`, `src/analog/__tests__/compiler.test.ts`, `src/engine/__tests__/mixed-partition.test.ts`

**Acceptance**: All integration tests pass. Results match old pipeline for equivalent circuits.

---

## Wave 3.5 — Cleanup and verification

### P3-10: Remove old extraction code (M)

Remove the three old algorithms that are now replaced. This is a two-step process: migrate callers, then delete.

**Step 1 — Migrate callers:**
- Rewrite `compileCircuit()` internals to delegate to the new partition path (call `extractConnectivityGroups` + `partitionByDomain` + `compileDigitalPartition`). Remove its call to `traceNets()` and its inline wire→netId propagation pass.
- Rewrite `compileAnalogCircuit()` internals to delegate to the new partition path. Remove its call to `buildNodeMap()`.
- Replace all uses of `detectEngineMode()` with model-based checks (`hasDigitalModel`/`hasAnalogModel`).
- Replace all uses of `partitionMixedCircuit()` — the unified `compileUnified()` handles partitioning internally.
- Replace all imports of `UnionFind` from `src/engine/union-find` with `src/compile/union-find`.

**Step 2 — Delete:**
- Delete `src/engine/union-find.ts` entirely.
- Delete `src/engine/mixed-partition.ts` entirely.
- Delete `traceNets` export from `src/engine/net-trace.ts` (or delete the file if nothing else is exported).
- Delete `buildNodeMap` export from `src/analog/node-map.ts` (or delete the file if nothing else is exported).

**Files to modify**: `src/engine/compiler.ts`, `src/analog/compiler.ts`, any file importing from deleted modules
**Files to delete**: `src/engine/union-find.ts`, `src/engine/mixed-partition.ts`, possibly `src/engine/net-trace.ts`, possibly `src/analog/node-map.ts`
**Files to read**: Grep results for all imports/usages before deleting.

**Acceptance**: No imports from deleted modules. All tests pass. `npm test` green.

---

### P3-11: Full test suite verification (S)

Run the complete test suite (`npm test`). Compare against baseline.

**Acceptance**: Same pass/fail count as baseline (7405+ passing, only pre-existing submodule failures).

---

### P3-12: Hard-delete verification — nothing deprecated, nothing shimmed (S)

**This is the final scorched-earth pass.** After P3-10 and P3-11, grep the entire codebase to confirm that every trace of the old code is gone. Nothing deprecated, nothing shimmed, nothing left behind "for backwards compat".

**Grep checklist** — each of these must return ZERO hits (excluding this spec file, progress.md, and git history):

1. `traceNets` — function name, imports, references, comments mentioning it
2. `buildNodeMap` — function name, imports, references, comments mentioning it
3. `detectEngineMode` — function name, imports, references, comments mentioning it
4. `partitionMixedCircuit` — function name, imports, references, comments mentioning it
5. `MixedModePartition` — type name (replaced by `SolverPartition`)
6. `MixedModeCutPoint` — type name (replaced by `BridgeDescriptor`)
7. `PosUnionFind` — the inline string-keyed union-find class from mixed-partition
8. `from.*engine/union-find` — old union-find import path
9. `from.*engine/net-trace` — old net-trace import path
10. `from.*analog/node-map` — old node-map import path
11. `from.*engine/mixed-partition` — old mixed-partition import path
12. `@deprecated.*traceNets\|@deprecated.*buildNodeMap\|@deprecated.*detectEngineMode` — no deprecated shims allowed

**For each grep hit found**:
- If it's a live import or function call → the caller was missed in P3-10. Fix it: rewrite the caller to use the new unified path, then delete the old reference.
- If it's a comment referencing the old function (e.g. "// formerly used traceNets") → delete the comment. The git history is the record, not stale comments.
- If it's a test that directly imports the old function → rewrite the test to use the new API. If the test was testing internal behaviour of the old function, decide: does the new API cover this case? If yes, delete. If no, port the test to the new function.
- If it's a `@deprecated` annotation or re-export shim → delete it. No shims. The old code is gone.

**After all grep hits are resolved**, run `npm test` one final time.

**Files to modify**: Whatever the grep finds — this is a mop-up task.
**Files to delete**: Any files that become empty after removing old references.

**Acceptance**:
- All 12 grep patterns return zero hits in source code (`.ts` files under `src/`).
- `npm test` passes with same count as baseline.
- No `@deprecated` annotations referencing any of the removed functions.
- No backwards-compatibility re-exports of removed functions.
- No comments explaining what the old code used to do.

---

## Dependency Graph

```
Wave 3.1: [P3-1, P3-2]           (parallel — types + union-find)
    ↓
Wave 3.2: [P3-3, P3-4, P3-5]    (P3-3 and P3-5 parallel; P3-4 depends on P3-3 types but can be parallel since types are from P3-1)
    ↓
Wave 3.3: [P3-6, P3-7]           (parallel — independent backend adaptations)
    ↓
Wave 3.4: [P3-8, P3-9]           (parallel — unified entry point + integration tests)
    ↓
Wave 3.5: [P3-10, P3-11, P3-12]  (sequential — remove old code, verify tests, scorched-earth grep pass)
```

## Files Summary

### New files
| File | Task |
|------|------|
| `src/compile/types.ts` | P3-1 |
| `src/compile/index.ts` | P3-1 |
| `src/compile/union-find.ts` | P3-2 |
| `src/compile/__tests__/union-find.test.ts` | P3-2 |
| `src/compile/extract-connectivity.ts` | P3-3 |
| `src/compile/__tests__/extract-connectivity.test.ts` | P3-3 |
| `src/compile/partition.ts` | P3-4 |
| `src/compile/__tests__/partition.test.ts` | P3-4 |
| `src/compile/compile.ts` | P3-8 |
| `src/compile/__tests__/compile.test.ts` | P3-8 |
| `src/compile/__tests__/compile-integration.test.ts` | P3-9 |

### Modified files
| File | Task |
|------|------|
| `src/engine/flatten.ts` | P3-5 |
| `src/engine/compiler.ts` | P3-6, P3-10 |
| `src/analog/compiler.ts` | P3-7, P3-10 |

### Deleted files (Wave 3.5)
| File | Task |
|------|------|
| `src/engine/union-find.ts` | P3-10 |
| `src/engine/mixed-partition.ts` (or gutted) | P3-10 |
