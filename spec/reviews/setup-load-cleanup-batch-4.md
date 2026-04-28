# Review Report: Batch 4 — Test harness + engine tests (3.C.* part 1)

## Summary

- **Tasks reviewed**: 8 task_groups (3.C.harness-core, 3.C.mna-buck, 3.C.coordinator, 3.C.stamp-order, 3.C.harness-tests-1, 3.C.dc-pin, 3.C.compile, 3.C.sparse, 3.C.harness-tests-2)
- **Files reviewed**: ~35 source/test files as listed in spec/progress.md for the above groups
- **Violations**: 7 (2 critical, 2 major, 3 minor)
- **Gaps**: 1
- **Weak tests**: 4
- **Legacy references**: 4
- **Verdict**: has-violations

---

## Violations

### V1 — CRITICAL
**File**: `src/solver/analog/__tests__/setup-stamp-order.test.ts`
**Lines**: 152, 153, 271, 397–400, 432–433, 455–456, 476, 608–610, 631, 679–681, 793–795, 855, 923, 1076, 1116–1118, 1199–1202 (32 total occurrences)
**Rule violated**: rules.md — "No `pytest.skip`, `pytest.xfail`, `unittest.skip`, soft assertions. Ever." (equivalent: `it.todo`)
**Evidence**:
```
152:  it.todo("PB-ADC TSTALLOC sequence");
153:  it.todo("PB-AFUSE TSTALLOC sequence");
271:  it.todo("PB-CAP TSTALLOC sequence");
397:  it.todo("PB-COMPARATOR TSTALLOC sequence");
398:  it.todo("PB-CRYSTAL TSTALLOC sequence");
399:  it.todo("PB-DAC TSTALLOC sequence");
400:  it.todo("PB-DIAC TSTALLOC sequence");
432:  it.todo("PB-FGNFET TSTALLOC sequence");
433:  it.todo("PB-FGPFET TSTALLOC sequence");
455:  it.todo("PB-IND TSTALLOC sequence");
456:  it.todo("PB-ISRC TSTALLOC sequence");
476:  it.todo("PB-MEMR TSTALLOC sequence");
608:  it.todo("PB-OPAMP TSTALLOC sequence");
609:  it.todo("PB-OPTO TSTALLOC sequence");
610:  it.todo("PB-OTA TSTALLOC sequence");
631:  it.todo("PB-PJFET TSTALLOC sequence");
679:  it.todo("PB-POLCAP TSTALLOC sequence");
680:  it.todo("PB-POT TSTALLOC sequence");
681:  it.todo("PB-REAL_OPAMP TSTALLOC sequence");
793:  it.todo("PB-RES TSTALLOC sequence");
794:  it.todo("PB-SCR TSTALLOC sequence");
795:  it.todo("PB-SCHMITT TSTALLOC sequence");
855:  it.todo("PB-SUBCKT TSTALLOC sequence");
923:  it.todo("PB-TAPXFMR TSTALLOC sequence");
1076: it.todo("PB-TLINE TSTALLOC sequence");
1116: it.todo("PB-TRIAC TSTALLOC sequence");
1117: it.todo("PB-TRIODE TSTALLOC sequence");
1118: it.todo("PB-TUNNEL TSTALLOC sequence");
1199: it.todo("PB-VSRC-AC TSTALLOC sequence");
1200: it.todo("PB-VSRC-DC TSTALLOC sequence");
1201: it.todo("PB-VSRC-VAR TSTALLOC sequence");
1202: it.todo("PB-XFMR TSTALLOC sequence");
```
**Severity**: CRITICAL

The file header (line 15) states: "Gate: every row exists with it.todo before any W3 component lands." This is an explicit acknowledgement that the agent knowingly introduced 32 `it.todo` entries as placeholders. rules.md bans `it.todo` categorically — it is equivalent to `pytest.skip`. The agent's comment justifying the ban ("before any W3 component lands") is proof of intentional rule-breaking, not a mitigating factor. progress.md claims this task_group is `complete` and "all clean" — that claim is false.

---

### V2 — CRITICAL
**File**: `src/solver/analog/__tests__/harness/netlist-generator.test.ts`
**Line**: 71–83
**Rule violated**: spec/setup-load-cleanup.md §C.1 — C7: `\b(readonly\s+)?pinNodeIds\s*[!?:]` is a forbidden field-decl form on AnalogElement
**Evidence**:
```typescript
function makeAnalogEl(pinNodeIds: number[]): AnalogElement {
  return {
    pinNodeIds,           // ← shorthand property assignment = field-decl form on element literal
    _pinNodes: new Map(pinNodeIds.map((id, i) => [String(i), id])),
    _stateBase: -1,
    branchIndex: -1,
    ngspiceLoadOrder: 0,
    label: "test",
    setup: (_ctx: unknown) => void 0,
    load: (_ctx: LoadContext) => void 0,
    getPinCurrents: () => [],
    setParam: () => {},
  } as unknown as AnalogElement;
}
```
**Severity**: CRITICAL

The object literal returned by `makeAnalogEl` is cast to `AnalogElement`. Including `pinNodeIds` as a named property on this literal is exactly the C7 violation: a `pinNodeIds` field on an entity typed as `AnalogElement`. The agent's justification in progress.md ("The object literal shorthand pinNodeIds, is kept because netlist-generator.ts reads el.pinNodeIds (flow-on noted below)") is proof of intentional rule-breaking. The correct remedy is to remove `pinNodeIds` from the literal and fix `netlist-generator.ts` to read `[...el._pinNodes.values()]` instead. progress.md claims this file is "all clean" for C7 — that claim is false.

---

### V3 — MAJOR
**File**: `src/solver/analog/__tests__/test-helpers.ts`
**Lines**: 3–10
**Rule violated**: rules.md — "No `# previously this was...` comments", "Historical-provenance comments are dead-code markers"
**Evidence**:
```typescript
/**
 * Solver-test infrastructure helpers.
 *
 * The legacy positional-argument element builders and the post-construction
 * node-id stamping helper were removed in the setup-load cleanup wave. Tests
 * construct elements via the production factories (e.g.
 * `makeDcVoltageSource(new Map([...]), props, () => 0)`) and invoke
 * `setupAll(elements, ctx)` against a `SetupContext` produced by
 * `makeTestSetupContext`. See spec/setup-load-cleanup.md §A.19.
 */
```
**Severity**: MAJOR

This is a historical-provenance comment: it describes what was removed, what used to exist, and references the cleanup wave that made the change. rules.md states "No `# previously this was...` comments" and "Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour." The comment should be deleted. There is no dead code it decorates — the file itself is the correct implementation — so this is a major violation rather than critical.

---

### V4 — MAJOR
**File**: `src/solver/analog/__tests__/harness/types.ts`
**Line**: 213–214
**Rule violated**: rules.md — Historical-provenance comment ban
**Evidence**:
```typescript
   * Phase 2.5 W2.3 replaced the former string union (initJct / initFix / …)
   * with this bitfield-derived label.
```
**Severity**: MAJOR

This comment in the JSDoc for `initMode: string` at line 213–214 describes what was replaced and by which wave. It is a historical-provenance comment: "replaced the former string union ... with this bitfield-derived label." rules.md bans all comments that describe historical change. The phrase "replaced" is one of the specifically banned words. The comment must be deleted.

---

### V5 — MINOR
**File**: `src/solver/analog/__tests__/digital-pin-model.test.ts`
**Lines**: 3–29 (file header), 364, 367
**Rule violated**: rules.md — Historical-provenance comment ban
**Evidence**:
```
Line 15:  * Task 6.4.4 — legacy stamp methods deleted:
Line 16:  *  - legacy_stamp_methods_deleted_output
Line 17:  *  - legacy_stamp_methods_deleted_input
...
Line 364: // Task 6.4.4 — legacy stamp methods deleted
Line 367: describe("legacy stamp methods deleted", () => {
```
**Severity**: MINOR

The header comment at lines 15–17 uses "legacy stamp methods deleted" — both "legacy" and "deleted" describe historical change. Line 364 is an inline comment of the same form. The describe block name on line 367 uses the word "legacy" — while describe block names cannot be changed without affecting test identity, the comment at line 364 must be removed. The file header at lines 15–17 must also be cleaned of the historical reference.

---

### V6 — MINOR
**File**: `src/solver/analog/__tests__/test-helpers.ts`
**Lines**: 387–389
**Rule violated**: rules.md — "No fallbacks."
**Evidence**:
```typescript
  const fallback = new Float64Array(0);
  const rhs = opts.rhs ?? fallback;
  const rhsOld = opts.rhsOld ?? fallback;
```
**Severity**: MINOR

A variable explicitly named `fallback` is used as a backwards-compatibility shim for callers that do not pass `rhs`/`rhsOld`. rules.md states "No fallbacks." The variable name makes the intent explicit. The correct approach is to make `rhs` and `rhsOld` required in `MakeLoadCtxOptions`, or derive them from a non-fallback default. The name `fallback` alone triggers the rule.

---

### V7 — MINOR
**File**: `src/solver/analog/__tests__/dc-operating-point.test.ts`
**Lines**: 6–7, 201, 268, 416, 436
**Rule violated**: rules.md — Historical-provenance comment ban (the word "fallback" used as a feature description in comments and test names)
**Evidence**:
```
Line 6:   *   - Gmin stepping fallback (Level 1)
Line 7:   *   - Source stepping fallback (Level 2)
Line 201: // gmin stepping fallback is reliably entered.
Line 268: // srcFact=1 and fail here, triggering the source-stepping fallback.
Line 416: it("gmin_stepping_fallback", () => {
Line 436: it("source_stepping_fallback", () => {
```
**Severity**: MINOR

"Fallback" is explicitly used to describe the gmin stepping and source stepping procedures. rules.md bans "fallback" in comments. The test names at lines 416 and 436 use the word in their identifiers — changing test names would require updating any reference to those tests by name, but the comments at lines 6, 7, 201, and 268 must be removed. Note: the production algorithm these tests exercise is legitimately called "fallback" in ngspice literature; however the rule bans the word in comments regardless of domain usage.

---

## Gaps

### G1 — Spec requirement not implemented
**Spec requirement**: spec/setup-load-cleanup.md §B.11 — `netlist-generator.ts` (the production file) reads `el.pinNodeIds` (a C10 violation: `el.pinNodeIds` access on an AnalogElement at runtime). The agent's progress.md entry for `3.C.harness-tests-1 — netlist-generator.test.ts` acknowledges this: "src/solver/analog/__tests__/harness/netlist-generator.ts: reads el.pinNodeIds (C10 violation) — out of my file scope."
**What was found**: `netlist-generator.ts` (the production harness module, not the test file) was not included in any batch 4 task group. The test file `netlist-generator.test.ts` provides `pinNodeIds` on the fake element specifically because the production `netlist-generator.ts` reads `el.pinNodeIds`. This means the production file still uses the forbidden `el.pinNodeIds` access pattern, and the test file's C7 violation is a direct consequence.
**File path**: `src/solver/analog/__tests__/harness/netlist-generator.ts`

---

## Weak Tests

### WT1
**Test path**: `src/solver/analog/__tests__/harness/harness-integration.test.ts::findLargestDelta identifies worst convergence point`
**Line**: 566
**Problem**: `expect(result).not.toBeNull()` is a trivially weak assertion. It only proves the function returned something non-null; it does not verify that the returned delta is from the expected step/iteration, or that the correct element was identified.
**Evidence**:
```typescript
const result = findLargestDelta(session, 1);
expect(result).not.toBeNull();
expect(result!.delta).toBeGreaterThan(0);
```
The `expect(result).not.toBeNull()` on its own would pass even if `findLargestDelta` returned a dummy object. The `delta > 0` check on the next line is stronger but still does not verify which element caused the largest delta or what the expected value range is.

---

### WT2
**Test path**: `src/solver/analog/__tests__/harness/query-methods.test.ts::51. No Map, Float64Array, NaN, or Infinity in JSON.stringify(session.toJSON())`
**Line**: 731
**Problem**: `expect(typeof parsed).toBe("object")` is a trivially weak type assertion. Any non-null JSON value that is not a primitive would satisfy this. It does not verify that `parsed` has the expected structure, keys, or content.
**Evidence**:
```typescript
const parsed = JSON.parse(str);
expect(typeof parsed).toBe("object");
```
The assertion proves only that `JSON.parse` returned an object — which is true for any valid JSON object literal. The test should assert that specific expected keys are present and have valid types/values.

---

### WT3
**Test path**: `src/solver/analog/__tests__/dcop-init-jct.test.ts::dcopInitJct::BJT simple (L0) primeJunctions::NPN: arms Vbe=tVcrit...`
**Lines**: 153–154
**Problem**: The range assertions for `tVcrit` check that the computed value is between 0.6 and 0.85, but do not assert the exact expected value. This is a loose range check that would pass even if the formula was slightly wrong.
**Evidence**:
```typescript
expect(tVcrit).toBeGreaterThan(0.6);
expect(tVcrit).toBeLessThan(0.85);
```
The test computes `tVcrit` from the same formula as the production code, so it is also not testing independence of the expected value. A better assertion would use the known ngspice-derived value at T=300.15K and IS=1e-14 to assert an exact (or tight-tolerance) result.

---

### WT4
**Test path**: `src/solver/analog/__tests__/dcop-init-jct.test.ts::dcopInitJct::Diode primeJunctions::arms Vd=tVcrit as per-device local override`
**Lines**: 256–257
**Problem**: Same issue as WT3: range assertions instead of exact value for the diode `tVcrit`.
**Evidence**:
```typescript
expect(tVcrit).toBeGreaterThan(0.3);
expect(tVcrit).toBeLessThan(0.9);
```
The range [0.3, 0.9] is extremely wide — 0.6 V of tolerance. This would pass even if the formula diverged significantly from the ngspice reference value.

---

## Legacy References

### LR1
**File**: `src/solver/analog/__tests__/test-helpers.ts`
**Lines**: 3–10
**Stale reference**: `"The legacy positional-argument element builders and the post-construction node-id stamping helper were removed in the setup-load cleanup wave."`
This describes what was historically present and is no longer. The word "legacy" appears in the JSDoc comment body.

---

### LR2
**File**: `src/solver/analog/__tests__/harness/types.ts`
**Line**: 213
**Stale reference**: `"Phase 2.5 W2.3 replaced the former string union (initJct / initFix / …) with this bitfield-derived label."`
References a named phase and wave ("Phase 2.5 W2.3") and uses "replaced" to describe historical change.

---

### LR3
**File**: `src/solver/analog/__tests__/digital-pin-model.test.ts`
**Lines**: 15–17, 364
**Stale reference**: `"Task 6.4.4 — legacy stamp methods deleted"` (lines 15, 364). Uses the word "legacy" and "deleted" to describe removed functionality.

---

### LR4
**File**: `src/solver/analog/__tests__/behavioral-remaining.test.ts`
**Line**: 96
**Stale reference**: `"// CMOS 3.3V parameters (matches behavioral-remaining.ts CMOS_3V3_FALLBACK)"`
Note: `behavioral-remaining.test.ts` is not strictly in batch 4 scope (not listed in the 3.C.* task groups), but the reference to a symbol named `CMOS_3V3_FALLBACK` in a comment is a legacy/fallback reference that indicates a production symbol using the banned word "FALLBACK". Flagged for completeness.

---

*End of report.*
