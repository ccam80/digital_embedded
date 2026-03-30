# CrossEngineBoundary Deletion Spec

## Design Intent

CrossEngineBoundary is core-path poison. The flattener should not care about domains — that's the partitioner's job. ALL subcircuits are inlined unconditionally. Per-net bridge synthesis handles domain boundaries.

## Status: `route.kind === 'bridge'` is ALREADY unreachable

`resolveComponentRoute()` was changed so digital components always return `{ kind: 'skip' }`. The `'bridge'` case at compiler.ts:1146 is dead code. `synthesizeDigitalCircuit` is only called from that case. All phases can execute atomically.

## Files to DELETE

| File | Lines | Reason |
|------|-------|--------|
| `src/solver/digital/cross-engine-boundary.ts` | 81 | Type definitions only used by deleted mechanism |
| `src/solver/analog/bridge-instance.ts` | 76 | Only produced by deleted `compileBridgeInstance` and unreachable inline bridge path |
| `src/solver/digital/__tests__/flatten-bridge.test.ts` | 658 | All 10 tests assert CrossEngineBoundary behavior |
| `src/solver/analog/__tests__/digital-bridge-path.test.ts` | 346 | All 7 tests assert inline bridge path behavior |

## Files to MODIFY

### `src/solver/digital/flatten.ts`
- Delete import of `CrossEngineBoundary`, `BoundaryPinMapping` (line 33)
- Delete `domainFromAssignments()` (lines 251-270)
- Delete cross-engine detection block (lines 157-205): `outerDomain`, `resolveModelAssignments` for internal, `isCrossEngine`, the opaque boundary recording
- Delete `buildPinMappings()` helper (lines 392-403)
- Remove `crossEngineBoundaries` from `FlattenResult` (line 90)
- Simplify `flattenCircuit()` signature: remove `modelAssignments` param, `boundaries` accumulator
- Simplify `flattenCircuitScoped()` and `inlineSubcircuit()` signatures
- Remove `resolveModelAssignments` and `ModelAssignment` imports (no longer needed by flattener)
- Remove `simulationModel` attribute read (line 185)

### `src/solver/analog/compiler.ts`
- Delete import of `CrossEngineBoundary` (line 35)
- Delete import of `BridgeInstance` (line 36)
- Delete import of `SubcircuitHost` (line 34)
- Delete `route.kind === 'bridge'` case (lines 1146-1275)
- Delete Stage 8 CrossEngineBoundary loop (lines 1460-1487)
- Delete `crossEnginePlaceholderIds` (lines 1084-1086) and skip check usage
- Delete `detectHighSourceImpedance()` (lines 1527-1560)
- Delete `synthesizeDigitalCircuit()` (lines 1596-1671)
- Delete `compileBridgeInstance()` (lines 1686-1824)
- Delete `resolvePositionToNodeId()` (lines 1833-1851)
- Delete `resolveSubcircuitPinNode()` (lines 1860-1890)
- Remove `crossEnginePlaceholderIds` param from `runPassA_partition` signature
- Remove `outerCircuit` and `digitalCompiler` params from `compileAnalogPartition` if no remaining callers

### `src/compile/partition.ts`
- Remove `CrossEngineBoundary` import (line 12)
- Remove `crossEngineBoundaries` parameter from `partitionByDomain()` (line 101)
- Remove `crossEngineBoundaries` from both SolverPartition results (lines 262, 269)

### `src/compile/types.ts`
- Remove `CrossEngineBoundary` import (line 13)
- Remove `CrossEngineBoundary` re-export (line 97)
- Remove `crossEngineBoundaries` field from `SolverPartition` (line 194)

### `src/compile/compile.ts`
- Remove `crossEngineBoundaries` variable and destructuring from flattenResult
- Remove `crossEngineBoundaries` from `partitionByDomain()` call
- Simplify flattening: just use `flattenResult.circuit`

### `src/compile/index.ts`
- Remove `CrossEngineBoundary` from re-exports (line 29)

### `src/solver/analog/compiled-analog-circuit.ts`
- Remove `BridgeInstance` import (line 14)
- Remove `bridges: BridgeInstance[]` field (line 113) — always empty now
- Update constructor

### `src/solver/coordinator.ts`
- Remove `BridgeInstance` import and all bridge-instance sync code
- `_bridgeInstances` field, `_syncBeforeAnalogStep`, `_syncAfterAnalogStep`, `_stepAnalogWithBridges`, `_stampDigitalToAnalog` — all become dead when bridges array is always empty

### Test files to MODIFY
- `flatten-pipeline-reorder.test.ts`: Delete `per_instance_override` and `cross_domain_opaque` tests, rewrite `same_domain_inline` without `crossEngineBoundaries`
- `compiler.test.ts` (lines 696, 713): Remove `crossEngineBoundaries: []` from SolverPartition literals
- `partition.test.ts`: Remove `CrossEngineBoundary` import, `NO_BOUNDARIES` constant, `crossEngineBoundaries propagation` test block, update all `partitionByDomain()` calls
- `compile-analog-partition.test.ts` (lines 325, 414, 474): Remove `crossEngineBoundaries: []`
- `lrcxor-fixture.test.ts`: Update comments referencing `synthesizeDigitalCircuit`
