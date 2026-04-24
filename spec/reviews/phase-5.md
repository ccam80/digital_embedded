# Review Report: Phase 5 — F-BJT BJT L0 + L1 Full Alignment

**Reviewer:** claude-orchestrator:reviewer  
**Date:** 2026-04-25  
**Scope:** All tasks in Phase 5, Waves 5.0 – 5.3  
**Files reviewed:**
- `src/solver/analog/load-context.ts`
- `src/solver/analog/ckt-context.ts` (grep only)
- `src/components/semiconductors/bjt.ts` (extensive)
- `src/components/semiconductors/__tests__/bjt.test.ts` (extensive)
- `src/solver/analog/__tests__/ckt-context.test.ts` (partial)
- `spec/progress.md` (Phase 5 entries)

---

## Summary

| Metric | Count |
|--------|-------|
| Tasks reviewed | 18 (5.0.1, 5.0.2, 5.1.1–5.1.6, 5.2.1–5.2.15, 5.3.1–5.3.4) |
| Violations — critical | 0 |
| Violations — major | 2 |
| Violations — minor | 1 |
| Gaps | 3 |
| Weak tests | 6 |
| Legacy references | 1 |

**Verdict: has-violations**

---

## Violations

### V-1 — Historical-provenance comment on `computeBjtOp` JSDoc (major)

**File:** `src/components/semiconductors/bjt.ts`  
**Line:** 474  
**Rule:** `spec/.context/rules.md` — "No historical-provenance comments. Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour."

**Evidence:**
```
 * Simple (L0) Gummel-Poon: NE/NC fixed at 1.5/2, NKF=0.5. bjtload.c:420-560
```

The claim "NE/NC fixed at 1.5/2" is no longer true. Task 5.1.5 parameterized NE and NC — the function signature at line 484 accepts `NE: number, NC: number` parameters, and the call site at line 960 passes `params.NE, params.NC`. The JSDoc still describes the old hard-coded behaviour that was replaced, making this a historical-provenance comment. The comment decorates the function itself, misleading any reader into thinking NE/NC are still fixed.

**Severity: major** — Describes removed behaviour; contradicts the current implementation; violates the provenance comment ban.

---

### V-2 — Bypass test (5.1.3) `bypass_disabled_when_ctx_bypass_false` assertions are trivially weak (major)

**File:** `src/components/semiconductors/__tests__/bjt.test.ts`  
**Lines:** 779–781  
**Rule:** `spec/.context/rules.md` — "Tests ALWAYS assert desired behaviour. Never weak assertions (is not None, bare isinstance, len(x) > 0)."

**Evidence:**
```typescript
    expect(ctx2.noncon.value).toBeGreaterThanOrEqual(0);
    // s0[CC] is finite (compute wrote it, not NaN from a skip).
    expect(Number.isFinite(s0[SLOT_CC])).toBe(true);
```

`noncon.value >= 0` is trivially true for any unsigned counter — it cannot be negative. `Number.isFinite(s0[CC])` is trivially true since any valid computation will produce a finite value; this assertion does not distinguish "compute ran" from "bypass happened to leave a finite value." The spec (task 5.1.3) required: "Assert both calls emit non-zero stamp counts (detected via a SparseSolver stamp-count probe wrapping stampG/stampRHS)." No stamp-count assertion is present in this test.

**Severity: major** — The test does not verify the specified behaviour (both calls actually ran the compute path); both assertions are trivially satisfiable regardless of whether the bypass gate is broken.

---

### V-3 — Minor: L1 bypass `else` block unindented relative to `if` (minor)

**File:** `src/components/semiconductors/bjt.ts`  
**Lines:** 1434–1436  
**Rule:** Code hygiene — consistent indentation is required for readability of a control structure that mirrors ngspice's `goto load` semantics.

**Evidence:**
```typescript
      } else {
      // bjtload.c:383-416: pnjlim on BE, BC, and substrate junctions.
      vbeLimited = vbeRaw;
```

The `if` block at line 1411 is indented at six spaces (inside `load()`). The `} else {` at line 1434 is correct, but the body of the `else` block (lines 1435 onward through the pnjlim + compute section) is not indented inside the `else` — the code is at six-space indent, same level as the `if` condition, rather than eight-space indent as required for the `else` body. This makes the scope boundary ambiguous when reading.

**Severity: minor** — Does not affect runtime behaviour; does affect readability of a critical control structure.

---

## Gaps

### G-1 — Task 5.1.3 acceptance criterion: stamp-count probe on bypass path missing

**Spec requirement (task 5.1.3):**
> `bypass_triggers_when_tolerances_met` — Assert: (a) `ctx.noncon.value` unchanged on second call, (b) stamps still emitted on second call (bypass preserves stamps), (c) a probe on `computeBjtOp` call-count shows it was invoked once (first call) not twice.

**What was found:**
The test at `bjt.test.ts::BJT L0 NOBYPASS::bypass_triggers_when_tolerances_met` asserts (a) `noncon2.value === 0` and (b) `cc2 === cc1` (s0[CC] unchanged). There is no stamp-count probe verifying stamps were emitted on the bypass path, and there is no `computeBjtOp` call-count probe verifying it was invoked only once. The test only asserts s0[CC] is unchanged (indirect evidence of bypass) and noncon did not change.

**File:** `src/components/semiconductors/__tests__/bjt.test.ts` lines 784–855

---

### G-2 — Task 5.1.3 acceptance criterion: stamp-count probe on `bypass_disabled_when_ctx_bypass_false` missing

**Spec requirement (task 5.1.3):**
> `bypass_disabled_when_ctx_bypass_false` — Assert both calls emit non-zero stamp counts (detected via a SparseSolver stamp-count probe wrapping `stampG`/`stampRHS`).

**What was found:**
The test at `bjt.test.ts::BJT L0 NOBYPASS::bypass_disabled_when_ctx_bypass_false` (lines 758–782) constructs the stamp-count probe wrapping infrastructure (`stampCount` object, `addEntry` intercept) but then does NOT assert `stampCount.g > 0` or any non-zero stamp count. The `stampCount` object is created but never checked in `expect()`. Only the trivially-weak assertions `noncon >= 0` and `isFinite(s0[CC])` are made.

**File:** `src/components/semiconductors/__tests__/bjt.test.ts` lines 758–782

---

### G-3 — Task 5.2.8: progress.md reports 5/7 tests passing, 2 test design failures; fix pass brought to 7/7, but the original spec acceptance criterion required 7 tests

**Spec requirement (task 5.2.8):**
> 7 tests pass.

**What was found:**
Progress.md entry for task 5.2.8 reports "5/7 tests pass; 2 pre-existing test design failures" for the original implementation. A subsequent fix-pass entry ("Task 5.2.8/5.2.10 fix pass") reports 37/37 passing after correcting `makeDcInitCtx()`. The fix-pass status entry reports "Status: complete" and "37/37 passing." This is technically resolved, but the fix-pass modifies test-design logic rather than production code — the `makeDcInitCtx()` helper was corrected from `rhsOld[1] = 0.65` to `rhsOld[1] = 0.0` to produce a non-zero VBC. This is a legitimate test correction (the prior test was not exercising the right condition). No gap in production implementation exists, but the path to 7/7 required a test-design correction pass that was not part of the original wave scope, indicating the original agent did not validate test conditions before marking complete.

**File:** `src/components/semiconductors/__tests__/bjt.test.ts`  
**Note:** This gap is informational — the fix was legitimate and the final state is correct.

---

## Weak Tests

### WT-1 — `BJT L0 NOBYPASS::bypass_disabled_when_ctx_bypass_false`: trivially-true noncon assertion

**Test path:** `bjt.test.ts::BJT L0 NOBYPASS::bypass_disabled_when_ctx_bypass_false`  
**Line:** 779  
**Evidence:**
```typescript
expect(ctx2.noncon.value).toBeGreaterThanOrEqual(0);
```
`noncon.value` is unsigned; `>= 0` is always true. Does not verify compute path ran.

---

### WT-2 — `BJT L0 NOBYPASS::bypass_disabled_when_ctx_bypass_false`: isFinite is trivially weak

**Test path:** `bjt.test.ts::BJT L0 NOBYPASS::bypass_disabled_when_ctx_bypass_false`  
**Line:** 781  
**Evidence:**
```typescript
expect(Number.isFinite(s0[SLOT_CC])).toBe(true);
```
Any valid compute path (or even a zero-initialised bypass) produces a finite value. Does not distinguish "compute ran with bypass=false" from any other outcome.

---

### WT-3 — `BJT L0 MODEINITSMSIG::state0_op_slots_populated`: all assertions are `isFinite`

**Test path:** `bjt.test.ts::BJT L0 MODEINITSMSIG::state0_op_slots_populated`  
**Lines:** 1120–1128  
**Evidence:**
```typescript
expect(Number.isFinite(s0[SLOT_VBE])).toBe(true);
expect(Number.isFinite(s0[SLOT_VBC])).toBe(true);
expect(Number.isFinite(s0[SLOT_CC])).toBe(true);
// ... (6 more identical isFinite checks)
```
Nine assertions all check `isFinite`. This is a trivially-true family: `isFinite(0)` is true, so even if op-slot write-back is entirely skipped and slots remain at their zero-initialised values, all nine assertions pass. The spec requires that `s0[VBE], s0[VBC], s0[CC], ...` are populated by MODEINITSMSIG. Zero is finite, so these assertions do not distinguish populated from unpopulated.

---

### WT-4 — `BJT L1 MODEINITSMSIG::cap_values_stored`: all assertions are `isFinite`

**Test path:** `bjt.test.ts::BJT L1 MODEINITSMSIG::cap_values_stored`  
**Lines:** 1263–1266  
**Evidence:**
```typescript
expect(Number.isFinite(s0[SLOT_CQBE])).toBe(true);
expect(Number.isFinite(s0[SLOT_CQBC])).toBe(true);
expect(Number.isFinite(s0[SLOT_CQSUB])).toBe(true);
expect(Number.isFinite(s0[SLOT_CQBX])).toBe(true);
```
Same issue as WT-3. With `CJE=CJC=1e-12`, the cap values should be non-zero positive numbers. The test should assert `s0[SLOT_CQBE] > 0` (or a specific expected value range), not merely `isFinite`.

---

### WT-5 — `BJT L1 NOBYPASS::bypass_disabled_when_ctx_bypass_false`: noncon >= 0 is trivially weak

**Test path:** `bjt.test.ts::BJT L1 NOBYPASS::bypass_disabled_when_ctx_bypass_false`  
**Line:** 1482  
**Evidence:**
```typescript
expect(ctx.noncon.value).toBeGreaterThanOrEqual(0);
```
Same problem as WT-1. Trivially true for an unsigned counter.

---

### WT-6 — `BJT L0 MODEINITJCT::on_path_seeds_tVcrit`: bare `toBeGreaterThan(0)` without magnitude check

**Test path:** `bjt.test.ts::BJT L0 MODEINITJCT::on_path_seeds_tVcrit`  
**Line:** 681  
**Evidence:**
```typescript
expect(s0[SLOT_VBE]).toBeGreaterThan(0);
```
The spec says: "Assert `s0[SLOT_VBE] > 0` (magnitude near thermal voltage)." The implementation-specified value is `tVcrit`, which for NPN with IS=1e-16 at 300.15K is approximately 0.57 V. The test only asserts `> 0`, which would pass even for a value of 1e-300. A tighter bound (`toBeCloseTo(0.57, 1)` or `expect(s0[SLOT_VBE]).toBeGreaterThan(0.4)`) was specified but not implemented.

---

## Legacy References

### LR-1 — JSDoc describes removed NE/NC hard-coding

**File:** `src/components/semiconductors/bjt.ts`  
**Line:** 474  
**Evidence:**
```
 * Simple (L0) Gummel-Poon: NE/NC fixed at 1.5/2, NKF=0.5. bjtload.c:420-560
```
This is the same finding as V-1. The string "fixed at 1.5/2" is a stale reference to the pre-task-5.1.5 hard-coded values that are now removed. Listed here as a legacy reference as well since the phrase "fixed at" describes the old hardcoded state that no longer exists.

---

## Positive Observations (non-binding, informational)

The following acceptance criteria from the phase-5 spec were verified as correctly implemented:

1. `LoadContext` has `bypass: boolean` and `voltTol: number` with correct citation (`load-context.ts` lines 125–131). Defaults in `ckt-context.ts` match ngspice (`bypass: false`, `voltTol: 1e-6`).
2. `ctx.deltaOld[1] > 0 ? :` papering guard is deleted. Direct `ctx.deltaOld[1]` divide is in place at `bjt.ts:1417` area (verified via progress.md and grep of the bypass gate).
3. `isLateral` branching is present at all three area-scaling sites: `c4` (line 1295), `ctot` (line 1599), `czsub` (line 1605), with the correct AREAB/AREAC swap for `czsub`.
4. `ctx.bypass` and `ctx.voltTol` used by both L0 (lines 897–902) and L1 (lines 1411–1416) bypass gates.
5. No `1.5` or `2.0` NE/NC literal remains in L0 `load()` call to `computeBjtOp` (line 960 passes `params.NE, params.NC`).
6. `TEMP` is a first-class per-instance param on both NPN (`BJT_PARAM_DEFS` line 75) and PNP (`BJT_PNP_DEFAULTS` line 102) and on L1 NPN (line 165) and PNP (line 225) with default 300.15 K.
7. `computeBjtTempParams` accepts required positional `T: number` (no default). Call sites pass `params.TEMP`.
8. `ctx.vt` has zero occurrences in `bjt.ts` (verified via grep).
9. L0 MODEINITPRED copies 7 new slots (CC, CB, GPI, GMU, GM, GO, GX) at lines 866–872. VBE/VBC were already present.
10. L1 MODEINITPRED copies same 7 slots at lines 1365–1371. VSUB at 1356–1358 was from Phase 3.
11. L1 bypass restore list contains 15 values (vbeLimited, vbcLimited, cc, cb, gpi, gmu, gm, go, gx, geqcb, gcsub, geqbx, vsubLimited, gdsub, cdsub) at lines 1418–1432.
12. SUBS and AREAB/AREAC present in both NPN (lines 161–162, 169) and PNP (lines 221–222, 229) L1 param defs.
13. L0 MODEINITSMSIG early-return at line 995, correctly positioned after op-slot write-back and before stamp block.
14. L1 3-branch MODEINITJCT citation comments refreshed at bjt.ts lines 847, 852, 856.
