# Review Report: Wave 1.1 — Phase 1 Infrastructure

## Summary

| Field | Value |
|-------|-------|
| Tasks reviewed | 4 (W1T1, W1T2, W1T3, W1T4) |
| Violations | 3 |
| Gaps | 2 |
| Weak tests | 1 |
| Legacy references | 1 |
| **Verdict** | **has-violations** |

---

## Violations

### V1 — `makeStubElement` does not satisfy `AnalogElement` interface (major)

**File:** `src/solver/analog/__tests__/compile-analog-partition.test.ts`, line 81–92

**Rule violated:** Tests must assert desired behaviour. Test helpers that produce structurally invalid objects mask type errors and produce untested code paths.

**Evidence:**
```typescript
function makeStubElement(nodeIds: number[]): AnalogElement {
  return {
    pinNodeIds: nodeIds,
    allNodeIds: nodeIds,
    branchIndex: -1,
    isNonlinear: false,
    isReactive: false,
    stamp(_s: SparseSolver) { /* no-op */ },
    setParam(_key: string, _value: number): void {},
    getPinCurrents(_v: Float64Array) { return nodeIds.map(() => 0); },
  };
}
```

`AnalogElement` now requires `readonly stateSize: number` and `stateBaseOffset: number` as non-optional fields (added in this same wave). `makeStubElement` omits both. TypeScript's structural typing means this compiles only because the return value is used as `AnalogElement` — TypeScript will not necessarily surface the error at the call site if strict excess property checks are not triggered. Regardless of whether the compiler silently accepts it, this stub does not satisfy the interface contract as defined in `element.ts` lines 233 and 238.

The test that asserts `element.stateBaseOffset === -1` (line 544) is exercising objects produced by elements registered in the test registry, not by `makeStubElement` directly — but the stub is used in the `BehavioralAnd` factory spy path and the inconsistency is a latent defect.

**Severity: major**

---

### V2 — `progress.md` records a backward-compatibility justification (minor)

**File:** `spec/progress.md`, line 70

**Rule violated:** Code hygiene rule — "No fallbacks. No backwards compatibility shims." The progress file itself records the implementer's rationale as backward-compatibility, which is a red flag that the design was bent.

**Evidence:**
```
Re-exported StatePoolRef from element.ts for backward compatibility
```

The `StatePoolRef` re-export from `element.ts` is described as a backward-compatibility shim. The actual code in `element.ts` line 17 does re-export `StatePoolRef` from `core/analog-types.ts`. Whether or not this re-export is strictly necessary (versus consumers importing directly from `core/analog-types.ts`), it was added with an explicit backward-compatibility rationale — a rationale that is banned by the rules. The presence of this reasoning in `progress.md` constitutes evidence that the agent introduced the re-export specifically to avoid requiring callers to update their imports, which is a compatibility shim by definition.

**Severity: minor**

---

### V3 — `compiled-analog-circuit.ts` accepts `statePool` as optional constructor parameter with fallback default (minor)

**File:** `src/solver/analog/compiled-analog-circuit.ts`, lines 133 and 150

**Rule violated:** "No fallbacks. No backwards compatibility shims. No safety wrappers." A required field that defaults to `new StatePool(0)` is a safety wrapper around incomplete callers — it masks cases where the compiler forgot to pass the pool.

**Evidence:**
```typescript
statePool?: StatePool;  // line 133 — optional in constructor params
...
this.statePool = params.statePool ?? new StatePool(0);  // line 150 — fallback default
```

The spec says `statePool` is assigned by the compiler and is always present on a compiled circuit. Making it optional in the constructor and silently defaulting to an empty pool disguises caller errors. If the compiler fails to pass the pool, the circuit silently runs with an empty pool, producing wrong results with no diagnostic. The field should be required.

**Severity: minor**

---

## Gaps

### G1 — `CompiledAnalogCircuit` interface in `analog-engine-interface.ts` does not declare `statePool`

**Spec requirement:** Phase 1, spec section "Modified AnalogElement interface" and "Slot allocation": `statePool` is added as a field on `CompiledAnalogCircuit`. The spec's Phase 1 gate check greps for `statePool` on `compiler.ts` but the canonical interface definition lives in `src/core/analog-engine-interface.ts`.

**What was found:** `src/core/analog-engine-interface.ts` lines 94–103 define `CompiledAnalogCircuit` with only `nodeCount`, `elementCount`, `labelToNodeId`, and `wireToNodeId`. There is no `statePool` field on this interface.

**File:** `src/core/analog-engine-interface.ts`, lines 94–103

The concrete class `ConcreteCompiledAnalogCircuit` does declare `statePool`, but code that holds a `CompiledAnalogCircuit` typed reference (e.g. the engine, the runner, test code) cannot access `statePool` through the interface. This means Phase 6 engine integration (which must call `statePool.checkpoint()`, `statePool.rollback()`, `statePool.acceptTimestep()`) will require a cast or a separate interface extension, indicating the interface was incompletely updated.

---

### G2 — `updateOperatingPoint` signature narrowing to `Readonly<Float64Array>` was not applied

**Spec requirement:** Section "Modified AnalogElement interface":
> `updateOperatingPoint` signature changes: `voltages: Float64Array` → `voltages: Readonly<Float64Array>`. Compile-time enforcement that devices cannot write back.

**What was found:** `AnalogElementCore` in `src/core/analog-types.ts` line 105 still declares:
```typescript
updateOperatingPoint?(voltages: Float64Array): void;
```
And `AnalogElement` in `src/solver/analog/element.ts` line 103 still declares:
```typescript
updateOperatingPoint?(voltages: Float64Array): void;
```

Neither was narrowed to `Readonly<Float64Array>`. The spec explicitly states this narrowing is Phase 1 work, providing compile-time enforcement against write-back. Without it, the entire enforcement mechanism described in the spec is absent — devices can still write back to `voltages[]` without a type error.

---

## Weak Tests

### WT1 — `state-pool.test.ts` allocation loop tests re-implement compiler logic inline rather than exercising the compiler

**File:** `src/solver/analog/__tests__/state-pool.test.ts`, lines 197–333 (describe block "allocation loop — offset assignment (mirrors compiler logic)")

**What is wrong:** These tests manually reproduce the compiler's allocation loop in the test body itself, then assert the results of their own in-test loop. They do not call `compileAnalogPartition` or any compiler function — they test a hand-written copy of the algorithm, not the actual compiler implementation. If the compiler's loop were changed to contain a bug, these tests would not catch it because they never invoke the compiler.

**Evidence:**
```typescript
let stateOffset = 0;
for (const el of elements) {
  const size = el.stateSize ?? 0;
  if (size > 0) {
    el.stateBaseOffset = stateOffset;
    stateOffset += size;
  } else {
    el.stateBaseOffset = -1;
  }
}
const pool = new StatePool(stateOffset);
```
This is the same loop that `compiler.ts` runs, written again in the test. The test asserts what the test's own loop produced — not what the compiler produced. These tests belong in `compile-analog-partition.test.ts` exercising the actual compiler, not as self-verifying loop reproductions in the `StatePool` unit test file.

Note: the tests in `compile-analog-partition.test.ts` do test the compiler path. The issue is that the `state-pool.test.ts` tests give a false sense of coverage for the compiler's allocation logic.

---

## Legacy References

### LR1 — `fet-base.ts` line 124 contains a historical-provenance comment

**File:** `src/solver/analog/fet-base.ts`, line 124

**Rule violated:** "No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned."

**Evidence:**
```typescript
* Capacitance companion model entries are stamped here from previously
* computed companion coefficients (updated once per timestep in stampCompanion).
```

The word "previously" describes historical execution order — it is a provenance comment explaining when the computation happened relative to the current call, framing it in terms of temporal history. This is pre-existing code that was not modified in Wave 1.1 and is noted here for completeness. If this file is touched in a future wave, this comment must be cleaned.

**Note:** This file (`fet-base.ts`) was not modified in Wave 1.1 (confirmed via git diff). It is flagged here because the review scope includes the `src/solver/analog/` directory and the rules apply to all code, but this specific violation predates the current wave.

---

## Spec Cross-Check

### Phase 1 gate checks (from spec)

| Check | Expected | Found | Status |
|-------|----------|-------|--------|
| `state-pool.ts` exists | yes | yes | PASS |
| `stateSize` in `analog-types.ts` | ≥ 1 | yes (line 167) | PASS |
| `stateBaseOffset` in `analog-types.ts` | ≥ 1 | yes (line 172) | PASS |
| `initState` in `analog-types.ts` | ≥ 1 | yes (line 177) | PASS |
| `stateBaseOffset` in `compiler.ts` | ≥ 1 | yes (line 1303) | PASS |
| `StatePool` in `compiler.ts` | ≥ 1 | yes (line 1309) | PASS |
| `statePool` in `compiler.ts` | ≥ 1 | yes (line 1332) | PASS |
| Smoke test: `checkpoint()` returns copy | yes | yes (state-pool.test.ts) | PASS |
| Smoke test: `rollback()` restores | yes | yes | PASS |
| Smoke test: `acceptTimestep()` shifts | yes | yes | PASS |
| Smoke test: `reset()` zeros all vectors | yes | yes | PASS |
| `updateOperatingPoint` narrowed to `Readonly<Float64Array>` | yes | NO — still `Float64Array` | FAIL |
| `statePool` on `CompiledAnalogCircuit` interface | yes | NO — not on the interface | FAIL |

### W1T4 status

The wave completion report states W1T4 was "covered by W1T1" (which created the test file with 27 tests). The `state-pool.test.ts` file contains 27+ tests and was created in W1T1's commit. The requeue rationale in `progress.md` references a file lock conflict, but the tests were included. This is acceptable — the tests exist and pass.
