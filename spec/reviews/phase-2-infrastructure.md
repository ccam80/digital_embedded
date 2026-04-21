# Review Report: Phase 2 Infrastructure (Waves 2.1, 2.2, 2.3, 2.5)

## Summary

| Field | Value |
|-------|-------|
| Tasks reviewed | 2.1.1, 2.1.2, 2.1.3, 2.1.4, 2.2.1, 2.3.1–2.3.8, 2.3-retry, 2.5.1, 2.5.2 |
| Violations — critical | 4 |
| Violations — major | 5 |
| Violations — minor | 2 |
| Gaps | 3 |
| Weak tests | 2 |
| Legacy references | 7 |
| Verdict | has-violations |

---

## Violations

### V-001 — CRITICAL: `ac-analysis.ts` writes deleted `LoadContext` fields (dead shim code)

**File:** `src/solver/analog/ac-analysis.ts`
**Lines:** 186–191

**Rule violated:** Rules.md — "No fallbacks. No backwards compatibility shims. No safety wrappers. All replaced or edited code is removed entirely." Also: historical-provenance comments describe the transition window, proving the agent knowingly left these writes in place.

**Evidence:**
```ts
acLoadCtx.isAc = true;
acLoadCtx.isDcOp = false;
acLoadCtx.isTransient = false;
dcCtx.isAc = true;
dcCtx.isDcOp = false;
dcCtx.isTransient = false;
```

The comment at line 183–184 reads: `"flip isAc=true / isDcOp=false / isTransient=false for the entire sweep."` These fields (`isAc`, `isDcOp`, `isTransient`) were **fully removed** from `LoadContext` by task 2.1.2. Task 2.1.3 also removed them from `CKTCircuitContext`. Writing to them on either `acLoadCtx` (a `LoadContext`) or `dcCtx` (a `CKTCircuitContext`) either (a) causes a TypeScript compile error because the fields no longer exist on the interfaces, or (b) silently adds dynamic properties that no device reads. Either way this is dead-shim code left in place from the pre-migration state. The AC analysis engine was not updated to write `cktMode = (cktMode & MODEUIC) | MODEAC` as required by the ngspice reference (acan.c:285). The `cktMode` field is never set for AC mode in this file.

**Severity:** Critical

---

### V-002 — CRITICAL: `_seedFromDcop` still writes `cac.statePool.analysisMode = "tran"` (legacy mirror left in)

**File:** `src/solver/analog/analog-engine.ts`
**Line:** 1193

**Rule violated:** Rules.md — historical-provenance comment ban; "All replaced or edited code is removed entirely." The review emphasis (point 8) calls out that spec 2.3.3 requires "No el.accept() sweep, no _firsttime write, no seedHistory() call" and that the three-statement port must be exact. The `statePool.analysisMode` write is an additional legacy mirror that has no ngspice counterpart in dctran.c:346-350.

**Evidence:**
```ts
cac.statePool.analysisMode = "tran";
```

The spec for `_seedFromDcop` (Deliverable 3, dctran.c:346-350) is an exact three-statement port:
1. `ctx.cktMode = uic | MODETRAN | MODEINITTRAN`
2. `ctx.ag[0] = 0; ctx.ag[1] = 0`
3. `cac.statePool.states[1].set(cac.statePool.states[0])`

The implementation adds a fourth write (`analysisMode = "tran"`) that has no ngspice counterpart and is a legacy mirror of statePool state that should have been removed. `statePool.analysisMode` is a pre-bitfield fanout artifact explicitly targeted for removal by the Phase 2 migration (the migration moves to `cktMode` as single source of truth). This write keeps the statePool.analysisMode string alive as a secondary mode signal, contradicting the "single source of truth" invariant.

**Severity:** Critical

---

### V-003 — CRITICAL: `behavioral-flipflop.ts` — `_prevClockVoltage` not seeded from `initState` (task 2.5.2 gap creates dead NaN guard)

**File:** `src/solver/analog/behavioral-flipflop.ts`
**Line:** 65

**Rule violated:** Spec task 2.5.2 states: "behavioral-flipflop.ts and similar must seed `_prevClockVoltage` from `initState`, NOT from the removed accept() sweep." The code initializes it to `NaN` and relies on `accept()` being called with the DC-OP voltages to prime it. Since the accept() sweep was removed from `_seedFromDcop` (task 2.3.3), the field is never primed before the first transient step.

**Evidence:**
```ts
private _prevClockVoltage = NaN;
```

The `accept()` method (line 146) is the only writer of `_prevClockVoltage` (line 189). The code at lines 154–158 guards with `!Number.isNaN(this._prevClockVoltage)` — meaning the first call to `accept()` will always fail the rising-edge test, suppressing detection of any edge that occurs before the second accepted transient step. This is the exact divergence the spec identifies: without the old accept() sweep from `_seedFromDcop`, the first-step clock edge is always missed. The spec fix is to seed `_prevClockVoltage` from the DC-OP solution inside `initState()`, not from a post-DCOP accept() call that no longer fires.

The `initState` method is not shown in the reviewed file but `_prevClockVoltage` is a plain class field initialized to `NaN`, never set during `initState`. This is an incomplete implementation of task 2.5.2.

**Severity:** Critical

---

### V-004 — CRITICAL: Multiple test files still contain `iteration:` in `LoadContext` literals (task 2.5.1 incomplete migration)

**Files (production test files, incomplete migration):**
- `src/components/sensors/__tests__/spark-gap.test.ts:72`
- `src/components/sensors/__tests__/ntc-thermistor.test.ts:75`
- `src/components/passives/__tests__/memristor.test.ts:60,305,453`
- `src/solver/__tests__/coordinator-bridge.test.ts:75`
- `src/solver/__tests__/coordinator-bridge-hotload.test.ts:60`
- `src/components/passives/__tests__/analog-fuse.test.ts:64`
- `src/components/semiconductors/__tests__/zener.test.ts:79,385`
- `src/components/semiconductors/__tests__/triac.test.ts:79`
- `src/components/semiconductors/__tests__/scr.test.ts:112,474`
- `src/components/sources/__tests__/variable-rail.test.ts:194`
- `src/components/sources/__tests__/ground.test.ts:42`
- `src/components/sources/__tests__/dc-voltage-source.test.ts:50,197,238,277`
- `src/components/sources/__tests__/current-source.test.ts:50,180,222,257`
- `src/components/sources/__tests__/ac-voltage-source.test.ts:65,437,478,517`
- `src/solver/analog/__tests__/behavioral-combinational.test.ts:441`
- `src/solver/analog/__tests__/behavioral-flipflop-variants.test.ts:79`
- `src/solver/analog/__tests__/behavioral-gate.test.ts:494`
- `src/solver/analog/__tests__/behavioral-flipflop.test.ts:119,333`
- `src/solver/analog/__tests__/behavioral-integration.test.ts:500`
- `src/solver/analog/__tests__/behavioral-remaining.test.ts:371,502`
- `src/solver/analog/__tests__/behavioral-sequential.test.ts:41,487`
- `src/solver/analog/__tests__/bridge-adapter.test.ts:91`
- `src/solver/analog/__tests__/bridge-compilation.test.ts:65`
- `src/components/active/__tests__/adc.test.ts:341`

**Rule violated:** Task 2.5.1 requires: "Test helpers / harness capture use `cktMode` bitfields. No `iteration:` in test LoadContext literals." The `iteration` field was removed from the `LoadContext` interface by task 2.1.2. All inline `LoadContext` literals that still include `iteration:` are invalid against the current interface — either TypeScript rejects them (compile error) or they are excess properties silently ignored (if `as unknown as LoadContext` casts are used). Either way these are stale test literals that were not migrated.

**Evidence (representative):**
```ts
// src/components/sensors/__tests__/spark-gap.test.ts:72
iteration: 0,
```

**Severity:** Critical — this is the scope of task 2.5.1 and affects 24+ test files.

---

### V-005 — MAJOR: `dc-operating-point.ts` still references `InitMode` type in function signatures

**File:** `src/solver/analog/dc-operating-point.ts`
**Lines:** 187–188

**Rule violated:** The `InitMode` type was removed from `load-context.ts` by task 2.1.2. The type is now only kept locally in `ckt-context.ts` for the transition window. Using it as a parameter type in `dc-operating-point.ts` creates a cross-module dependency on a type that should be eliminated.

**Evidence:**
```ts
function cktop(
  ctx: CKTCircuitContext,
  firstMode: InitMode,
  _continueMode: InitMode,
  ...
```

The `cktop` function still accepts string-typed `InitMode` parameters and translates them to INITF bits internally (lines 193–200). This is a compatibility shim: the function receives a string and maps it to bits that the caller (lines 351–358) already knows. The correct fix is for callers to pass the INITF bit directly, removing the `InitMode` string type from production engine code entirely. The `InitMode` string type is a legacy artifact from the pre-bitfield architecture.

**Severity:** Major

---

### V-006 — MAJOR: Multiple behavioral test files still use removed `isDcOp`/`isTransient`/`isTransientDcop`/`isAc` fields in LoadContext literals

**Files:**
- `src/solver/analog/__tests__/behavioral-combinational.test.ts:451–454`
- `src/solver/analog/__tests__/behavioral-flipflop.test.ts:129–132, 343–346`
- `src/solver/analog/__tests__/behavioral-gate.test.ts:504–507`
- `src/solver/analog/__tests__/behavioral-flipflop-variants.test.ts:89–92`
- `src/solver/analog/__tests__/behavioral-integration.test.ts:510–513`
- `src/solver/analog/__tests__/behavioral-remaining.test.ts:381–384, 512–515`
- `src/solver/analog/__tests__/behavioral-sequential.test.ts:51–54, 497–500`
- `src/solver/analog/__tests__/bridge-adapter.test.ts:101–104`
- `src/solver/analog/__tests__/bridge-compilation.test.ts:75–78`
- `src/solver/analog/__tests__/digital-pin-model.test.ts:109–112`
- `src/solver/analog/__tests__/fet-base.test.ts:147–149`

**Rule violated:** Task 2.5.1 requires test LoadContext literals to use `cktMode` bitfields only. The fields `isDcOp`, `isTransient`, `isTransientDcop`, `isAc` were removed from `LoadContext` by task 2.1.2.

**Evidence (representative):**
```ts
// src/solver/analog/__tests__/behavioral-combinational.test.ts:451-454
isDcOp: false,
isTransient: false,
isTransientDcop: false,
isAc: false,
```

**Severity:** Major

---

### V-007 — MAJOR: `ac-analysis.ts` does not set `cktMode` to `MODEAC` — AC mode reads wrong bitfield

**File:** `src/solver/analog/ac-analysis.ts`
**Lines:** 183–191

**Rule violated:** The spec (F4 Deliverable 2 / ngspice acan.c:285) requires: `CKTmode = (CKTmode & MODEUIC) | MODEAC`. Instead, the implementation writes the removed boolean fields (`isAc = true`, `isDcOp = false`, `isTransient = false`) and does not write `cktMode` at all. Any device that reads `ctx.cktMode & MODEAC` to determine AC mode will see 0 (wrong) during the AC sweep. This is a functional error.

**Evidence:**
The entire AC sweep section (lines 181–204) sets boolean fields but never executes:
```ts
// Missing: acLoadCtx.cktMode = (dcCtx.cktMode & MODEUIC) | MODEAC;
acLoadCtx.isAc = true;   // field no longer exists on LoadContext
```

**Severity:** Major

---

### V-008 — MAJOR: `_seedFromDcop` spec violation — deprecated mirror block retained

**File:** `src/solver/analog/analog-engine.ts`
**Lines:** (inside `_seedFromDcop`, post-cktMode assignment)

**Rule violated:** The spec (F3 Deliverable 3b) requires "Three statements. No cktLoad, no NR, no device.accept sweep, no per-element ref refresh." The implementation retains the legacy mirrors (`ctx.initMode`, `ctx.isDcOp`, `ctx.isTransient`, etc.) inside the commented block starting "Sync deprecated mirrors..." However, reviewing the actual code at lines 1190–1214, these deprecated mirror writes are NOT present in the final implementation — that was the spec draft, not the actual code. The actual `_seedFromDcop` only does: cktMode write, analysisMode write (V-002), ag[] zeros, and states[1].set(states[0]), plus refreshElementRefs. This is three-plus-one statements.

The `refreshElementRefs` call is present and justified in a comment as "defensive resync." The spec's Deliverable 3 draft explicitly mentioned removing `refreshElementRefs` as an "artifact," but the actual wave 2.3.3 progress record says it was removed. The implementation retains it with a comment explaining why. Given the comment is architectural justification (not a historical-provenance comment), this is a borderline case. However the comment says "Kept as a defensive resync" which is a "for now" / fallback semantic — this is a dead-code-marker comment.

**Evidence:**
```ts
// refreshElementRefs is pure reference-rebinding. ... Kept as a defensive
// resync; it is pure rebinding and cannot drift from ngspice.
cac.statePool.refreshElementRefs(
  ctx.poolBackedElements as unknown as PoolBackedAnalogElement[],
);
```

The spec draft comments "No per-element ref refresh" and "pool-architecture artifact with no ngspice counterpart." The words "Kept as a defensive resync" are a fallback marker. The code block should be absent per the spec's three-statement requirement.

**Severity:** Major

---

### V-009 — MINOR: `ckt-context.ts` loadCtx initializer has no `iteration` field — confirmed compliant, but `makeSimpleCtx` in test-helpers has not been fully audited

**File:** `src/solver/analog/__tests__/test-helpers.ts`
**Status:** `makeDiode.load()` at line 341 no longer references `ctx.iteration` — the `iteration` guard removal is confirmed. The `makeSimpleCtx` function was not shown in detail but the import at line 30 imports from `ckt-mode.ts` and the test helper file does not construct LoadContext literals with `iteration:`. Test helpers are compliant for the in-scope fields.

**Severity:** Minor (informational)

---

### V-010 — MINOR: `dc-operating-point.ts` comment at line 239 still references `isTransientDcop` as field name

**File:** `src/solver/analog/dc-operating-point.ts`
**Line:** 239

**Rule violated:** Rules.md — "Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour." The comment text "Runs ONLY on the standalone .OP path (isTransientDcop === false)" references a deleted field name as the gating criterion. The correct description is "Runs ONLY when isTranOp(ctx.cktMode) is false."

**Evidence:**
```ts
 * Runs ONLY on the standalone .OP path (isTransientDcop === false). The
```

**Severity:** Minor

---

## Gaps

### G-001: Task 2.5.2 — `_prevClockVoltage` seeding from `initState` not implemented

**Spec requirement:** Task 2.5.2 states: "behavioral-flipflop.ts and similar must seed `_prevClockVoltage` from `initState`, NOT from the removed accept() sweep."

**What was found:** `_prevClockVoltage` is initialized to `NaN` as a class field (line 65). No `initState` method or equivalent reads the DC-OP pool state to prime this field. The `accept()` method is the sole writer. Without the accept() sweep from `_seedFromDcop`, this field is never primed before the first transient NR call.

**File:** `src/solver/analog/behavioral-flipflop.ts`

---

### G-002: Task 2.1.2 — `LoadContext.uic` retained but spec says it should be removed

**Spec requirement (F4 Deliverable 2):** The F4 spec's NEW LoadContext interface removes `isDcOp`, `isTransient`, `isTransientDcop`, `isAc`, and `iteration`. It retains `uic: boolean` with the note "Remove once every reader is migrated to cktMode." The review emphasis (point 2) says `InitMode` type and those fields are "fully removed — Not renamed, not deprecated — gone." The `uic` field retention is explicitly permitted by both the spec and the progress record.

However, the review emphasis (point 2) says to "grep for any remaining `loadCtx.initMode` / `loadCtx.iteration` / `loadCtx.isDcOp` etc. in `src/` outside `ref/`." The grep confirms `loadCtx.isDcOp` and `loadCtx.isTransient` still exist in `ac-analysis.ts` (covered by V-001). The `uic` retention is within spec.

**Assessment:** No gap — `uic` retention is explicitly spec-authorized.

---

### G-003: Task 2.3.5 — `ctx.isTransient` derivation check

**Spec requirement:** Task 2.3.5 (progress record line 283): "Removed `ctx.isTransient = false` in `runNR`; replaced with `ctx.isTransient = (ctx.cktMode & MODETRAN) !== 0` (derived from cktMode)."

**What was found:** The `runNR` function in `dc-operating-point.ts` (lines 145–171) does not set `ctx.isTransient` at all. The progress record says this was done in `dc-operating-point.ts` but the actual `runNR` function contains no such assignment. This could mean the assignment was removed entirely (correct) or it was never added to begin with. However, since `CKTCircuitContext` no longer declares `isTransient` as a field (per task 2.1.3 which marked it `@deprecated`), reading or setting it should produce TypeScript errors — unless the `@deprecated` fields are still present on the class.

**Checking:** `ckt-context.ts` line 256 shows: `cktMode: number = MODEDCOP | MODEINITFLOAT;` and no `initMode`, `isDcOp`, `isTransient`, `isTransientDcop`, or `isAc` fields visible in the read range (lines 240–261). The progress record for 2.1.3 says "Marked initMode, isDcOp, isTransient, isTransientDcop, isAc as @deprecated." The F3 spec says these should remain as deprecated mirrors "for the transition window."

**Assessment:** The `@deprecated` fields appear to be removed from the `CKTCircuitContext` class (not merely marked deprecated), based on what was read. However `ac-analysis.ts` still writes to them (V-001), suggesting they may still exist at runtime or the TypeScript compiler is not checking the output. This warrants further investigation but is not a gap per the F4 spec (which says they should be removed from the class).

---

## Weak Tests

### WT-001: `ckt-load.test.ts` — `single_pass_stamps_all_contributions` uses trivially-weak assertions

**Test path:** `src/solver/analog/__tests__/ckt-load.test.ts::CKTload::single_pass_stamps_all_contributions`

**What is wrong:** The test asserts only `Number.isFinite(solution[0])` and `Number.isFinite(solution[1])`. These are trivially satisfied — any non-NaN, non-Inf value passes. The test does not verify that device contributions were actually stamped correctly (e.g. that the diode's conductance appears in the matrix, or that the solution matches an expected operating point).

**Evidence:**
```ts
expect(Number.isFinite(solution[0])).toBe(true);
expect(Number.isFinite(solution[1])).toBe(true);
```

---

### WT-002: `newton-raphson.test.ts` — `forceReorder_called_on_initTran_first_iteration` uses `toBeGreaterThanOrEqual(1)` tolerance

**Test path:** `src/solver/analog/__tests__/newton-raphson.test.ts::NR INITF dispatcher::forceReorder_called_on_initTran_first_iteration`

**What is wrong:** The assertion `expect(forceReorderCallCount).toBeGreaterThanOrEqual(1)` does not verify the exact call count. The spec (niiter.c NR loop) guarantees forceReorder fires exactly once on MODEINITTRAN at iteration 0. A count of 5 would pass this test even if there is a regression causing spurious reorders.

**Evidence:**
```ts
expect(forceReorderCallCount).toBeGreaterThanOrEqual(1);
```

---

## Legacy References

### LR-001: `ac-analysis.ts:183–184` — historical comment referencing deleted fields

**File:** `src/solver/analog/ac-analysis.ts`
**Lines:** 183–184

**Evidence:**
```ts
// params.uic at ctx construction) and flip isAc=true / isDcOp=false /
// isTransient=false for the entire sweep.
```

This comment describes writes to deleted fields as a current design decision.

---

### LR-002: `ac-analysis.ts:186–191` — writes to deleted `LoadContext` fields

**File:** `src/solver/analog/ac-analysis.ts`
**Lines:** 186–191

**Evidence:**
```ts
acLoadCtx.isAc = true;
acLoadCtx.isDcOp = false;
acLoadCtx.isTransient = false;
dcCtx.isAc = true;
dcCtx.isDcOp = false;
dcCtx.isTransient = false;
```

These fields (`isAc`, `isDcOp`, `isTransient`) were removed from `LoadContext` by task 2.1.2 and from `CKTCircuitContext` by task 2.1.3. Writing to them on either object type is a legacy reference to the removed fanout architecture.

---

### LR-003: `analog-engine.ts:857–858` — historical comment referencing `analysisMode` fanout

**File:** `src/solver/analog/analog-engine.ts`
**Lines:** 857–858

**Evidence:**
```ts
// Uses MODETRANOP flags (analysisMode="dcOp" with
// statePool.analysisMode still in dcOp mode) to distinguish this run
```

The `analysisMode` string on `statePool` is a legacy artifact of the pre-bitfield architecture. Referencing it in a current-design comment suggests it is still functionally relied upon.

---

### LR-004: `analog-engine.ts:1193` — statePool.analysisMode write (removed field still written)

**File:** `src/solver/analog/analog-engine.ts`
**Line:** 1193

**Evidence:**
```ts
cac.statePool.analysisMode = "tran";
```

See V-002 for full analysis.

---

### LR-005: `dc-operating-point.ts:239` — stale field name in comment

**File:** `src/solver/analog/dc-operating-point.ts`
**Line:** 239

**Evidence:**
```ts
 * Runs ONLY on the standalone .OP path (isTransientDcop === false).
```

---

### LR-006: `dc-operating-point.ts:368` — stale comment text "Gate on isTransientDcop"

**File:** `src/solver/analog/dc-operating-point.ts`
**Line:** 368

**Evidence:**
```ts
    // (dcop.c:127,153) on the standalone .OP path. Gate on isTransientDcop
```

The actual gate uses `isTranOp(ctx.cktMode)` but the comment still refers to the deleted `isTransientDcop` field name.

---

### LR-007: `state-pool.ts:41` — `initMode` string reference survives in comment

**File:** `src/solver/analog/state-pool.ts`
**Line:** 41

**Evidence:**
```ts
   * When true and initMode === "initTran", reactive elements apply their
```

This references `initMode === "initTran"` as a current semantic, but `initMode` was removed as a field. The current equivalent is `cktMode & MODEINITTRAN`.

---

## Spec Compliance — Per Task

### Task 2.1.1 — ckt-mode.ts: 14 constants with ngspice hex verbatim

**Status:** Compliant with F4/ngspice source. The implementation uses the correct ngspice hex values (MODETRAN=0x0001, MODEAC=0x0002, MODEDCOP=0x0010, MODETRANOP=0x0020, MODEUIC=0x10000, etc.) verified against `ref/ngspice/src/include/ngspice/cktdefs.h:165-185` as cited in the F4 spec. All 8 helpers (`setInitf`, `setAnalysis`, `isDcop`, `isTran`, `isTranOp`, `isAc`, `isUic`, `initf`) are present with correct semantics.

**Note on `isTranOp`:** The spec (F3 Deliverable 0) defines `isTranOp` as `(mode & MODETRANOP) === MODETRANOP`. The implementation defines it as `(mode & MODETRANOP) !== 0`. Since `MOTETRANOP` is a single bit (0x0020), these are equivalent. Compliant.

**Note on `isDcop`:** The spec says "True if this is any kind of DC-OP (standalone .OP or transient-boot)." The implementation: `return (mode & MODEDCOP) !== 0`. Since MODEDCOP=0x0010 and MOTETRANOP=0x0020, `isDcop` returns `true` only for standalone .OP (MODEDCOP bit), NOT for transient-boot DCOP (MOTETRANOP). This is a semantic divergence: the spec says isDcop should cover both, but the implementation only covers standalone .OP. The correct bitfield for "any DC-OP" is `(mode & MODEDC) !== 0` where MODEDC=0x0070. **This is a gap in the helper semantics** — however, usage of `isDcop()` in `newton-raphson.ts:431` for node-damping gate and `newton-raphson.ts:482` for nodeset pass gating may produce wrong behavior during transient-boot DCOP.

**Severity of isDcop gap:** Major (misidentifies transient-boot DCOP as non-DCOP in damping and nodeset-ipass logic).

---

### Task 2.1.2 — LoadContext migration

**Status:** Compliant. `LoadContext` has `cktMode: number` as first field. `iteration`, `initMode`, `isDcOp`, `isTransient`, `isTransientDcop`, `isAc` are absent. `uic: boolean` retained per spec authorization.

---

### Task 2.1.3 — CKTCircuitContext cktMode field

**Status:** Compliant. `cktMode: number = MODEDCOP | MODEINITFLOAT` present at line 256. The `@deprecated` fields (`initMode`, `isDcOp`, `isTransient`, `isTransientDcop`, `isAc`) appear to have been removed from the class body (not merely marked deprecated) based on the reviewed range. The loadCtx initializer correctly includes `cktMode: MODEDCOP | MODEINITFLOAT` (line 555).

---

### Task 2.1.4 — ctx.noncon getter/setter, troubleNode field

**Status:** Compliant. `get noncon()` / `set noncon()` forwarding through `loadCtx.noncon.value` at lines 237–238. `troubleNode: number | null` declared at line 358, initialized to `null` at line 596.

---

### Task 2.2.1 — cktLoad rewrite

**Status:** Largely compliant. Iteration param dropped; cktMode propagated; null-guard present; troubleNode zeroed when noncon rises; nodeset gate is `(cktMode & MODEDC) && (cktMode & (MODEINITJCT|MODEINITFIX))`; IC gate is `(cktMode & MOTETRANOP) && !(cktMode & MODEUIC)`. No duplicate noncon reset. No legacy field propagation inside cktLoad itself.

---

### Task 2.3.1 — dcopFinalize rewrite

**Status:** Compliant. Single `cktLoad(ctx)` after `setInitf(ctx.cktMode, MODEINITSMSIG)`. No runNR call. No save/restore dance. Post-call `setInitf(ctx.cktMode, MODEINITFLOAT)` present as described.

---

### Task 2.3.2 — dcopFinalize call sites gated on !isTranOp

**Status:** Compliant. Three call sites (direct/gmin/src convergence paths) all use `if (!isTranOp(ctx.cktMode))` gate correctly.

---

### Task 2.3.3 — _seedFromDcop three-statement port

**Status:** Partially compliant. The cktMode write, ag[] zeros, and states[1].set(states[0]) are present. However the `refreshElementRefs` call is retained (V-008) and the `analysisMode = "tran"` write is present (V-002). The spec says "Three statements. No cktLoad, no NR, no device.accept sweep, no per-element ref refresh." The accept() sweep is correctly absent.

---

### Task 2.3.4 — _firsttime deletion

**Status:** Compliant. `_firsttime` field is absent from `analog-engine.ts`. `firstNrForThisStep` is absent. `"transient"` initMode sentinel is absent. `step()` branches use `_stepCount === 0` correctly. Post-NIiter `cktMode = MOTETRAN | MODEINITPRED` write is present at line 656.

---

### Task 2.3.6 — cktMode writes at callers

**Status:** Compliant. `_transientDcop` sets `ctx.cktMode = uicBitTransDcop | MOTETRANOP | MODEINITJCT` (line 909). `dcOperatingPoint` sets `ctx.cktMode = uicBitDcop | MODEDCOP | MODEINITJCT` (line 811). `srcFact = 1` (not `?? 1`) in both (lines 809, 907).

---

### Task 2.3.7 — 10 initMode writes migrated in dc-operating-point sub-solvers

**Status:** Compliant in the reviewed infrastructure. The `cktop` function translates `InitMode` string to INITF bits (lines 193–201) and calls `setInitf`. The sub-solver ladder transitions use `setInitf` via the INITF dispatcher in `newton-raphson.ts`. The InitMode string parameter on `cktop` is a remaining shim (V-005).

---

### Task 2.3.8 — UIC early-exit gate

**Status:** Compliant. `newtonRaphson.ts:279`: `if (isTranOp(ctx.cktMode) && isUic(ctx.cktMode))` — correct bitfield gate.

---

### Task 2.3-retry — INITF dispatcher reads `initf(ctx.cktMode)`

**Status:** Compliant. `newton-raphson.ts:478`: `const curInitf = initf(ctx.cktMode);` — correctly reads bitfield, not legacy `ctx.initMode`. All mode transitions write `ctx.cktMode = setInitf(...)`.

---

### Task 2.5.1 — Test migration (cktMode bitfields in test helpers)

**Status:** Incomplete (V-004). The infrastructure test helpers (`test-helpers.ts`) appear to be migrated — `makeDiode.load()` no longer references `ctx.iteration`. However 24+ component and integration test files still include `iteration:` in `LoadContext` literals. The behavioral test files in `src/solver/analog/__tests__/` also still use the removed `isDcOp`/`isTransient`/`isTransientDcop`/`isAc` fields (V-006). Task 2.5.1 is incomplete.

---

### Task 2.5.2 — behavioral-flipflop accept() audit

**Status:** Incomplete (V-003). `_prevClockVoltage` is not seeded from `initState`; it remains initialized to `NaN` with a runtime guard. The accept() sweep removal from `_seedFromDcop` means this field is never primed before the first transient step.

---

## Additional: `isDcop()` helper semantic gap (ungrouped)

**File:** `src/solver/analog/ckt-mode.ts`
**Line:** 106–108

The `isDcop()` helper returns `(mode & MODEDCOP) !== 0`, which is true only for standalone .OP (MODEDCOP=0x0010). The spec says "True if this is any kind of DC-OP (standalone .OP or transient-boot)." Transient-boot DCOP uses MOTETRANOP=0x0020, which does NOT have the MODEDCOP bit set. Therefore `isDcop()` returns `false` during transient-boot DCOP. This is incorrect: users of `isDcop()` (e.g. `newton-raphson.ts:431` for node damping, line 482 for nodeset-ipass) will fail to apply these behaviors during transient-boot DCOP. The correct check would be `(mode & MODEDC) !== 0` (using the 0x0070 mask).

**Severity:** Major

---
