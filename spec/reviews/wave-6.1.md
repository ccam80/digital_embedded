# Review Report: Wave 6.1 (G1, W6T1, W6T3)

## Summary

| Item | Value |
|------|-------|
| Tasks reviewed | 3 (G1, W6T1, W6T3) |
| Violations | 5 (1 critical, 2 major, 2 minor) |
| Gaps | 3 |
| Weak tests | 2 |
| Legacy references | 2 |
| Verdict | **has-violations** |

---

## Violations

### V1 — CRITICAL: Engine `init()` performs slot allocation that the spec assigns exclusively to the compiler

**File:** `src/solver/analog/analog-engine.ts`
**Lines:** 135-152

**Rule violated:** Completeness rules — the spec (Phase 1 migration plan, slot allocation section) states explicitly: slot allocation happens at compile time in `compiler.ts`. The Phase 6 spec states the `statePool` arrives on the compiled circuit fully allocated. The engine `init()` is responsible only for calling `initState` on each element; it must not modify `stateBaseOffset`. The code at lines 135-152 silently re-allocates `stateBaseOffset` for elements where it is still -1, which is a backwards-compatibility shim that masks compiler omissions.

**Evidence (lines 135-152):**
```
// Assign stateBaseOffset for elements that were not compiler-processed
// (stateSize > 0 but stateBaseOffset still -1). Then call initState on all
// pool-backed elements to bind them to the state pool.
const cac = compiled as CompiledWithBridges;
if (cac.statePool) {
  let nextOffset = 0;
  for (const el of elements) {
    if (el.stateSize > 0) {
      if (el.stateBaseOffset < 0) {
        el.stateBaseOffset = nextOffset;
      }
      nextOffset = el.stateBaseOffset + el.stateSize;
      if (el.initState) {
        el.initState(cac.statePool);
      }
    }
  }
}
```

The comment at lines 135-136 admits the intent: 'elements that were not compiler-processed' with 'stateBaseOffset still -1'. Under the rules, a justification comment next to a rule violation makes it worse, not better — it is proof the agent knowingly broke the rule. If an element arrives at engine init with stateBaseOffset -1 and stateSize > 0, that is a compiler bug that must be surfaced as a hard failure, not silently papered over.

**Severity:** Critical

---

### V2 — MAJOR: LTE rejection path calls `acceptTimestep()` unconditionally even when retry NR fails

**File:** `src/solver/analog/analog-engine.ts`
**Lines:** 297-328

**Rule violated:** Completeness — the spec pseudocode for `step()` in Phase 6 shows `acceptTimestep()` called only on timestep acceptance. The current code calls `statePool.acceptTimestep()` at line 328 unconditionally regardless of whether the LTE retry converged. This corrupts `state1` and `state2` with state0 from a failed retry, destroying the integration history for subsequent BDF steps.

**Evidence:**
```
if (this._timestep.shouldReject(r)) {
  this._voltages.set(this._prevVoltages);
  if (statePool && checkpoint) statePool.rollback(checkpoint);
  const rejectedDt = this._timestep.reject();
  // ... re-stamp and retry ...
  const retryResult = newtonRaphson({ ... });
  if (retryResult.converged) {
    this._voltages.set(retryResult.voltages);
    dt = rejectedDt;
  }
  // when NOT converged: falls through with no error, no return
}

// line 328 -- always reached, even on LTE retry NR failure
if (statePool) statePool.acceptTimestep();
```

**Severity:** Major

---

### V3 — MAJOR: Historical-provenance comments in `compiled-analog-circuit.ts`

**File:** `src/solver/analog/compiled-analog-circuit.ts`
**Lines:** 89-90

**Rule violated:** Rules — 'No historical-provenance comments. Any comment describing what code replaced, what it used to do, why it changed, or where it came from is banned.'

**Evidence:**
```
 *  Replaces elementPinVertices -- carries label, vertex, nodeId in one object.
 *  During migration, coexists with elementPinVertices. */
```

'Replaces elementPinVertices' names the symbol that was replaced. 'During migration, coexists with elementPinVertices' describes an in-progress migration where old and new patterns are kept alive simultaneously. Both phrases are textbook historical-provenance comments, explicitly banned. The old field `elementPinVertices` is confirmed still present at line 86, validating that the migration is incomplete.

**Severity:** Major

---

### V4 — MINOR: Workaround justification comment in `analog-engine.ts` `init()` (companion to V1)

**File:** `src/solver/analog/analog-engine.ts`
**Lines:** 135-137

**Rule violated:** Rules — 'No historical-provenance comments.' The comment explicitly names the class of shortcut being taken ('elements that were not compiler-processed', 'stateBaseOffset still -1'). Reported separately from the code violation (V1) because the comment is independently banned.

**Evidence:**
```
// Assign stateBaseOffset for elements that were not compiler-processed
// (stateSize > 0 but stateBaseOffset still -1). Then call initState on all
// pool-backed elements to bind them to the state pool.
```

**Severity:** Minor

---

### V5 — MINOR: `ConcreteCompiledAnalogCircuit` constructor accepts `statePool` as optional with silent fallback

**File:** `src/solver/analog/compiled-analog-circuit.ts`
**Lines:** 133, 150

**Rule violated:** Rules — 'No fallbacks. No backwards compatibility shims.' The spec requires every compiled circuit to have a properly allocated state pool. An empty `new StatePool(0)` fallback silently masks absent pool allocation.

**Evidence:**
```
statePool?: StatePool;                                    // line 133 -- optional param
// ...
this.statePool = params.statePool ?? new StatePool(0);   // line 150 -- silent fallback
```

**Severity:** Minor

---

## Gaps

### G1 — `compiled_analog_extends_compiled` test does not include the new `statePool` field

**Spec requirement:** G1 added `readonly statePool: StatePoolRef` as a required (non-optional) field to `CompiledAnalogCircuit` in `src/core/analog-engine-interface.ts` (confirmed at line 104). The test `compiled_analog_extends_compiled` in `src/core/__tests__/analog-engine-interface.test.ts` (lines 77-98) constructs a `CompiledAnalogCircuit` literal without `statePool`. Since the interface declares `readonly statePool: StatePoolRef` without `?`, this literal is type-invalid and would fail TypeScript compilation. The test was not updated when G1 was implemented.

**What was found:**
```
const compiled: CompiledAnalogCircuit = {
  netCount: 5, componentCount: 3, nodeCount: 4, elementCount: 3,
  labelToNodeId: new Map([["R1", 1], ["R2", 2]]),
  wireToNodeId: new Map(),
  // statePool: absent
};
```

**File:** `src/core/__tests__/analog-engine-interface.test.ts` lines 77-98

---

### G2 — No W6T1 behavioural tests for checkpoint/rollback/acceptTimestep in engine test suite

**Spec requirement (Phase 6 gate + Test Strategy):** The spec mandates smoke tests verifying:
- `statePool.reset()` is called in `reset()` and `dcOperatingPoint()`
- `state1`/`state2` are initialised from `state0` after DC convergence
- Checkpoint is taken before NR; rollback restores `state0` on NR failure
- `acceptTimestep()` is called after an accepted timestep
- A circuit exercising the NR retry path confirms rollback is called and `state0` is restored

**What was found:** `src/solver/analog/__tests__/analog-engine.test.ts` has no assertions that inspect `statePool` state at any point. The strings 'checkpoint', 'rollback', 'acceptTimestep', 'state1', 'state2' do not appear in the test file. The pool-state machinery introduced by W6T1 is entirely untested.

**File:** `src/solver/analog/__tests__/analog-engine.test.ts`

---

### G3 — LTE retry NR failure is silently unhandled (incomplete `step()` implementation)

**Spec requirement (Phase 6 pseudocode):** The spec shows the LTE rejection path retrying with smaller dt. The NR convergence failure path (lines 268-286) transitions to `EngineState.ERROR` on unrecoverable failure. The LTE retry path is missing equivalent error handling.

**What was found:** Lines 310-328: when `retryResult.converged` is false, no diagnostic is emitted, no `EngineState.ERROR` transition occurs. Execution falls through to `statePool.acceptTimestep()` and `this._simTime += dt` with the original (non-corrected) `dt`, silently advancing simulation on a bad solution.

**File:** `src/solver/analog/analog-engine.ts` lines 310-328

---

## Weak Tests

### WT1 — `transient_rc_decay` asserts only that simulation did not crash

**Test path:** `src/solver/analog/__tests__/analog-engine.test.ts::MNAEngine::transient_rc_decay`

**Problem:** The test comment at lines 243-251 explicitly states: 'For a true RC discharge we'd need Vs switched off. Here we verify the simulation runs stably and simTime advances.' The assertions `expect(engine.simTime).toBeGreaterThan(0)` and `expect(steps).toBeGreaterThan(0)` are trivially true as long as the engine does not crash. The voltage range check is a loose band. No assertion verifies any pool state, checkpoint, or rollback behavior relevant to W6T1.

**Evidence:**
```
expect(engine.simTime).toBeGreaterThan(0);   // trivially true if engine runs at all
expect(steps).toBeGreaterThan(0);            // trivially true if engine runs at all
const v2 = engine.getNodeVoltage(2);
expect(v2).toBeGreaterThan(4.5);             // loose range, not spec-tied value
expect(v2).toBeLessThanOrEqual(5.01);
```

---

### WT2 — `reset_clears_state` does not assert `statePool.state0` was zeroed

**Test path:** `src/solver/analog/__tests__/analog-engine.test.ts::MNAEngine::reset_clears_state`

**Problem:** The spec requires `statePool.reset()` to be called inside `reset()`. This is the primary W6T1 behavior for `reset()`. The test verifies `simTime`, node voltages, and `engineState` but makes no assertion about `statePool.state0` (or any pool vector) after reset. The pool reset behavior tested by W6T1 is absent.

**Evidence:**
```
engine.reset();
expect(engine.simTime).toBe(0);
expect(engine.getNodeVoltage(1)).toBe(0);
expect(engine.getNodeVoltage(2)).toBe(0);
expect(engine.getState()).toBe(EngineState.STOPPED);
// statePool.state0 contents not checked
```

---

## Legacy References

### LR1 — `compiled-analog-circuit.ts` line 89: 'Replaces elementPinVertices'

**File:** `src/solver/analog/compiled-analog-circuit.ts`
**Line:** 89

**Quoted evidence:**
```
 *  Replaces elementPinVertices -- carries label, vertex, nodeId in one object.
```

Names the symbol that was replaced. Banned historical-provenance reference to a replaced API.

---

### LR2 — `compiled-analog-circuit.ts` line 90: 'During migration, coexists with elementPinVertices'

**File:** `src/solver/analog/compiled-analog-circuit.ts`
**Line:** 90

**Quoted evidence:**
```
 *  During migration, coexists with elementPinVertices. */
```

Describes an ongoing migration and explicit coexistence of old and new fields. The old field `elementPinVertices` is confirmed still present at line 86, confirming the migration is incomplete. This is a banned historical-provenance reference and a signal that old code has not been removed.
