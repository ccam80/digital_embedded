# Review Report: Phase 0 — Dead Code Removal

## Summary

| Item | Value |
|------|-------|
| Tasks reviewed | 3 (0.1.2, 0.1.3, 0.1.4) |
| Violations | 3 |
| Gaps | 1 |
| Weak tests | 0 |
| Legacy references | 2 |
| Verdict | **has-violations** |

Task 0.1.5 is user-owned and excluded per assignment. Task 0.1.1 is spec hygiene only and excluded per assignment.

---

## Violations

### V1 — Historical-provenance comment in bjt.ts (major)

**File**: `src/components/semiconductors/bjt.ts`, line 55
**Rule violated**: rules.md § Code Hygiene — "No `# previously this was...` comments"; "Comments exist ONLY to explain complicated code to future developers. They never describe what was changed, what was removed, or historical behaviour."
**Evidence**:
```
// BJ1: VT import removed — all code now uses tp.vt (temperature-dependent thermal voltage)
```
This comment describes a historical change ("VT import removed"), not the current state of the code. It is a historical-provenance comment. The governing rules require deletion; such comments must not exist in the codebase.

**Severity**: major

---

### V2 — `Math.min(..., 80)` exp overflow clamp introduced in njfet.ts (major)

**File**: `src/components/semiconductors/njfet.ts`, lines 284, 302, 320, 381
**Rule violated**: plan.md Governing Principle 1 — "Match ngspice, or the job has failed." plan.md Phase 0 Verification — "all banned… `Math.exp(700)` guards removed"; CLAUDE.md — "SPICE-Correct Implementations Only: never watered-down 'pragmatic' versions."
**Evidence** (representative; pattern repeated at lines 302, 320, 381):
```typescript
const expArg = Math.min(this._vgs_junction / vt_n, 80);
this._gd_junction = (this._p.IS / vt_n) * Math.exp(expArg) + GMIN;
this._id_junction = this._p.IS * (Math.exp(expArg) - 1);
```
This is an exp overflow guard (clamping the exponent to 80) applied to the JFET gate junction Shockley diode calculation. ngspice `jfetload.c` does not clamp the exponent here; it relies on `pnjlim` voltage limiting upstream to keep the argument in range. This pattern is structurally identical to the `Math.exp(Math.min(..., 700))` pattern banned in bjt.ts by task 0.1.3 — the only difference is the threshold value. The Phase 0 governing principle explicitly requires that all `Math.exp(700)` guards be removed; introducing an equivalent guard at 80 in a new code path contradicts that principle. Phase 0 verification requires these guards to be absent from JFET files as much as BJT files.

Note: This code was introduced during Phase 7 (F5ext JFET work), not directly by Phase 0 agents. However it constitutes a banned pattern that exists in the codebase as of Phase 0 completion, and the Phase 0 review must record it.

**Severity**: major

---

### V3 — `Math.min(..., 80)` exp overflow clamp introduced in pjfet.ts (major)

**File**: `src/components/semiconductors/pjfet.ts`, lines 137, 155, 173, 235
**Rule violated**: Same as V2 — plan.md Governing Principle 1; CLAUDE.md "SPICE-Correct Implementations Only."
**Evidence** (representative; pattern repeated at lines 155, 173, 235):
```typescript
const expArg = Math.min(this._vgs_junction / vt_n, 80);
this._gd_junction = (this._p.IS / vt_n) * Math.exp(expArg) + GMIN;
this._id_junction = this._p.IS * (Math.exp(expArg) - 1);
```
Identical issue as V2 but in the P-channel JFET element. The `_updateOp` override in `PJfetAnalogElement` duplicates the 80-clamp across all four mode branches (MODEINITSMSIG, MODEINITTRAN, MODEINITJCT, and the general path).

**Severity**: major

---

## Gaps

### G1 — SLOT_GD_JUNCTION and SLOT_ID_JUNCTION still exported from njfet.ts and imported by name in jfet.test.ts

**Spec requirement** (plan.md task 7.3.1): "Update test imports — replace `SLOT_GD_JUNCTION`/`SLOT_ID_JUNCTION` with `stateSchema.getSlotOffset("GGS_JUNCTION")`/`("CG_JUNCTION")` per schema-lookup rule"; spec task 7.1.1 renames these slots to `SLOT_GGS_JUNCTION`/`SLOT_CG_JUNCTION`.

**What was actually found**:
- `src/components/semiconductors/njfet.ts` lines 68–69: `SLOT_GD_JUNCTION = 46` and `SLOT_ID_JUNCTION = 47` are still exported under the old names (no rename to `SLOT_GGS_JUNCTION`/`SLOT_CG_JUNCTION` per task 7.1.1).
- `src/components/semiconductors/__tests__/jfet.test.ts` lines 20–21: imports `SLOT_GD_JUNCTION` and `SLOT_ID_JUNCTION` directly from `njfet.js`; lines 474–475, 495, 515, 519, 531–532 use these constants directly rather than through `stateSchema.getSlotOffset(...)`.

**Note**: This gap belongs to Phase 7, not Phase 0. It is recorded here because the Phase 9 spec (Wave 9.1.1) requires a repo-wide grep for `SLOT_GD_JUNCTION` and `SLOT_ID_JUNCTION` to return zero hits — they currently return 9 hits each. Recording for the Phase 9 audit.

**File**: `src/components/semiconductors/njfet.ts` lines 68–69; `src/components/semiconductors/__tests__/jfet.test.ts` lines 20–21, 474–475, 495, 515, 519, 531–532

---

## Weak Tests

None found. The jfet.test.ts state-pool tests at lines 474–532 check specific slot values (constants, zero-init, GMIN), which are concrete assertions. No trivially-true assertions observed in the Phase 0 test files.

---

## Legacy References

### L1 — "removed" in historical-provenance comment in bjt.ts

**File**: `src/components/semiconductors/bjt.ts`, line 55
**Evidence**:
```
// BJ1: VT import removed — all code now uses tp.vt (temperature-dependent thermal voltage)
```
The word "removed" in a comment is a historical-provenance marker. This is the same code flagged in V1; recorded here as a legacy reference as well per reviewer workflow.

---

### L2 — "fallback" in code-logic comment in bjt.ts

**File**: `src/components/semiconductors/bjt.ts`, line 1516
**Evidence**:
```typescript
// bjtload.c:258-276: MODEINITJCT with OFF / UIC / fallback.
```
The word "fallback" appears in this comment. After examining context (lines 1515–1530), the comment describes the three branches of the ngspice `bjtload.c:258-276` algorithm: the OFF branch (`vbeRaw=0`), the UIC/IC-values branch (`params.ICVBE`), and the default branch (`tpL1.tVcrit`). The word "fallback" here refers to the ngspice algorithm's own terminology for the default branch — it is not a dead-code marker or transitional code descriptor. The code it decorates (the `else if (mode & MODEINITJCT)` block) is live production code faithfully porting ngspice. This is a borderline case; recorded per reviewer protocol. A reviewer cannot confirm it describes historical dead code; it appears to be an ngspice algorithm citation.

**Note**: This is recorded for completeness. The decorated code block (lines 1515–1530) appears to be correct ngspice-aligned production code. The use of "fallback" as an ngspice algorithm term rather than a code-state descriptor makes this a minor concern, but it still violates the letter of the rule ("Comments exist ONLY to explain complicated code to future developers").

---

## Positive Confirmation (Phase 0 User Requirements)

The following were explicitly mandated by the review assignment for verification:

1. **`Math.exp(700)` / `Math.min(..., 700)` / `Math.exp(Math.min(..., 700))` in bjt.ts**: Grep across `bjt.ts` returns **zero hits**. All 11–13 clamps are deleted. CONFIRMED CLEAN.

2. **Banned Vds clamps in njfet.ts / pjfet.ts**: `if (vds < -10)` / `if (vds > 50)` patterns grep to **zero hits** across the entire `src/components/semiconductors/` tree. CONFIRMED CLEAN.

3. **`junctionCap` export from mosfet.ts**: Grep across all `*.ts` files in `src/` returns **zero hits**. Function and callers are fully deleted. CONFIRMED CLEAN.

4. **Comments saying "removed the clamp" / "was clamped" / legacy breadcrumbs in bjt.ts/njfet.ts/pjfet.ts**: The only hits are (a) `bjt.ts:55` "VT import removed" (recorded as V1/L1) and (b) `bjt.ts:1516` "fallback" (recorded as L2). No "removed the clamp", "was clamped", "workaround", "temporary", "for now", "shim", "previously", or "migrated from" comments found in the three target files.

5. **Re-introduction of banned exp clamps downstream in bjt.ts**: `Math.min(..., \d+)` in `bjt.ts` returns only one hit — `Math.min(Math.max(params.XCJC, 0), 1)` at line 1790, which clamps the XCJC model parameter (a fraction, not an exp argument). **Zero exp-clamp re-introductions in bjt.ts**. CONFIRMED CLEAN.

6. **New exp clamp `Math.min(..., 80)` in njfet.ts/pjfet.ts**: Present. Recorded as V2 and V3.
