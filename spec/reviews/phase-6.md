# Review Report: Phase 6 — F-MOS MOSFET MOS1 Alignment

## Summary

- **Tasks reviewed**: 14 (6.1.1, 6.1.2, 6.1.3, 6.1.4, 6.2.1, 6.2.2, 6.2.3, 6.2.4, 6.2.5, 6.2.6, 6.2.7, 6.2.8, 6.2.9, 6.2.10, 6.2.11, 6.3.1) — 16 tasks total including 6.2.10 and 6.2.11
- **Files reviewed**: `src/components/semiconductors/mosfet.ts`, `src/components/semiconductors/__tests__/mosfet.test.ts`, `src/solver/analog/__tests__/harness/tVbi-pmos.test.ts`
- **Verdict**: `has-violations`
- **Violations total**: 5 (1 critical, 2 major, 2 minor)
- **Gaps**: 4
- **Weak tests**: 7
- **Legacy references**: 3

---

## Violations

### V-1 — Historical-provenance comment decorating actively-used code (critical)

**File**: `src/components/semiconductors/mosfet.ts`
**Lines**: 551–557

**Rule violated**: Rules §Code Hygiene — "Historical-provenance comments are dead-code markers. Any comment containing words like 'legacy', 'fallback', 'workaround', 'temporary'… is almost never just a comment problem. The comment exists because an agent left dead or transitional code in place… When you find such a comment: (1) treat the **code it decorates** as dead/broken, (2) delete both the code and the comment, (3) fix or rewrite any tests that depended on the dead code path."

**Quoted evidence**:
```
// DIVERGENCE - NOT "INTENTIONAL": THESE SIGN FLIPS ARE DEFINITELY NOT APPROVED
// BY THE AUTHOR.
// The `vsb` argument uses digiTS's `vs - vb` convention; these helpers invert
// it to ngspice's `vbs` for internal use per mos1load.c:500-509.
// ---------------------------------------------------------------------------
```
followed by:
```typescript
export function computeIds(
  vgs: number,
  vds: number,
  vsb: number,         // ← VSB convention, not VBS
  ...
```

**Severity**: **critical**

The comment block at lines 551–557 contains "DIVERGENCE - NOT INTENTIONAL" (historical-provenance) and "legacy" (line 563: `VSB legacy = vs - vb → vbs = -vsb inside`). Line 563 inside the JSDoc also reads: `Inputs: vgs, vds, and vsb (VSB legacy = vs - vb → vbs = -vsb inside)`. Both are historical-provenance comments in the form the rules ban.

The decorated code (`computeIds`, `computeGm`, `computeGds`, `computeGmbs`) uses the old VSB = vs − vb sign convention rather than ngspice's VBS = vb − vs convention. These four exported standalone functions are architecturally misaligned with the ngspice G1 sign convention that `load()` now uses verbatim. The comment exists because an agent could not delete the helpers without breaking callers and left a "DIVERGENCE" marker instead of performing the correct fix. Per the rule, the code must be deleted or corrected along with the comment.

---

### V-2 — Dead variable `delvgd` declared but unused in bypass cdhat positive-mode branch (major)

**File**: `src/components/semiconductors/mosfet.ts`
**Line**: 1277

**Rule violated**: Rules §Code Hygiene — "All replaced or edited code is removed entirely." A declared but never-read local is dead code.

**Quoted evidence**:
```typescript
if (prevMode >= 0) {
  const delvgd = delvgs - delvds;   // ← DECLARED, NEVER READ
  cdhat = prevCd + prevGm * delvgs + prevGds * delvds + prevGmbs * delvbs - prevGbd * delvbd;
}
```

The positive-mode cdhat formula at line 1278 uses `delvgs`, `delvds`, `delvbs`, `delvbd` directly. `delvgd` is declared on line 1277 and is never read. This differs from the negative-mode branch at line 1280, where `delvgd` is legitimately used in the formula.

This dead variable appears to be a copy-paste artefact left when porting `mos1load.c:258-277`. The TypeScript compiler may (or may not) emit a warning depending on settings; regardless it is dead code that must be removed.

**Severity**: **major**

---

### V-3 — `computeTempParams` uses `instanceTemp / REFTEMP` for `fact2`, contradicting spec Task 6.2.9 description (major)

**File**: `src/components/semiconductors/mosfet.ts`
**Line**: 433

**Rule violated**: The CLAUDE.md "No Pragmatic Patches" rule and spec Task 6.2.9 completeness requirement.

**Quoted evidence (spec)**:
> `fact2 = p.TEMP / p.TNOM` (was `1`; now reflects `p.TEMP / p.TNOM`)

**Quoted evidence (code)**:
```typescript
const fact2 = instanceTemp / REFTEMP;   // line 433 — uses REFTEMP not p.TNOM
```

The tVbi-pmos.test.ts reference implementation (line 62) also uses `temp / REFTEMP`, which matches ngspice's `mos1temp.c` actual source (where `fact2 = CKTtemp / CONSTRefTemp`). The implementation and the ngspice reference match each other. However, the spec text explicitly stated `fact2 = p.TEMP / p.TNOM` as the required change.

This creates an ambiguity: either (a) the spec text is wrong and the implementation is correct (matching ngspice), or (b) the spec is right and there is a numerical difference between `TEMP/TNOM` and `TEMP/REFTEMP` when `TNOM ≠ REFTEMP`. Because the spec's acceptance criterion says "matches `mos1load.c`" and the tVbi bit-exact tests pass, this appears to be a spec-text error rather than an implementation defect — but it must be reported as the spec and code disagree on this specific formula.

**Severity**: **major** (ambiguity must be resolved; spec text and implementation are inconsistent)

---

### V-4 — Historical-provenance comment inside `computeIds` JSDoc (minor)

**File**: `src/components/semiconductors/mosfet.ts`
**Line**: 563

**Rule violated**: Rules §Code Hygiene — historical-provenance comment ban ("legacy").

**Quoted evidence**:
```
 * Inputs: `vgs`, `vds`, and `vsb` (VSB legacy = vs - vb → vbs = -vsb inside).
```

The word "legacy" in a JSDoc comment on an exported function is a historical-provenance marker. This is subordinate to V-1 (same code block) but listed separately because the JSDoc line is distinct from the block comment.

**Severity**: **minor** (subordinate to V-1 critical)

---

### V-5 — Historical-provenance comment inside body of `computeIds` function (minor)

**File**: `src/components/semiconductors/mosfet.ts`
**Line**: 579

**Rule violated**: Rules §Code Hygiene — historical-provenance comment ban ("Legacy").

**Quoted evidence**:
```typescript
  // Legacy vsb = -vbs; vsb >= 0 means vbs <= 0 → normal reverse bias.
```

Another "Legacy" marker inside the body of `computeIds`, describing the sign inversion. Subordinate to V-1 but reported individually.

**Severity**: **minor** (subordinate to V-1 critical)

---

## Gaps

### G-1 — Task 6.2.9 spec: `tp.vt` field not present on `MosfetTempParams` interface declaration

**Spec requirement**: Task 6.2.9 acceptance criterion: "Add a `vt: number` field to `MosfetTempParams` = `p.TEMP * KoverQ`."

**What was found**: The `MosfetTempParams` interface at lines 395–418 does NOT declare `vt: number`. The `vt` field IS computed inside `computeTempParams` at line 431 (`const vt = instanceTemp * KoverQ`) and returned in the return object at line 539 (`vt,`). However, the interface definition does not include `vt` as a declared member. TypeScript's structural typing means the return value carries it, but the interface contract is incomplete.

**File**: `src/components/semiconductors/mosfet.ts` lines 395–418 (interface declaration)

---

### G-2 — Task 6.2.4 spec requires `cdrain` reconstruction to use `opMode * (cd + cbd)`, but actual code reads `opMode * (cd + cbd)` after `cd = opMode * cdrain - cbd` writebacks

**Spec requirement**: Task 6.2.4, bypass branch: `cdrain = mode_stored * (cd + cbd); // MOS1mode * (cd + cbd)`. The spec uses `mode_stored` (the stored `opMode`) to reconstruct `cdrain`.

**What was found**: At line 1337, the code reads `cdrain = opMode * (cd + cbd)` where `opMode` is freshly computed from the new `vds` at line 1310 (`const opMode = vds >= 0 ? 1 : -1`), not from the stored `s0[SLOT_MODE]`. Since bypass reloads `vds = prevVds` from state0 before this point (line 1297), `opMode` derives from the reloaded `vds`, which should agree with `s0[SLOT_MODE]`. This is likely correct at runtime, but the spec explicitly said "MOS1mode * (cd + cbd)" meaning the *stored* mode (`s0[SLOT_MODE]`), not the freshly computed `opMode`. The distinction matters if, in some edge case, the reload path doesn't run first. Report for verification.

**File**: `src/components/semiconductors/mosfet.ts` lines 1310, 1337

---

### G-3 — Task 6.2.4 spec: `ctx.noncon.value` and `ctx.limitingCollector` unaffected by bypass — spec says "no limiting events posted when bypassed"

**Spec requirement**: Task 6.2.4 acceptance criterion: "`ctx.noncon.value` and `ctx.limitingCollector` unaffected by bypass (no limiting events posted when bypassed; noncon gate still runs from post-limiting `icheckLimited`)."

**What was found**: The bypass branch sets `bypassed = true` after the limiting block has already run. The limiting block (lines 1101–1208) executes before the bypass gate check (lines 1254–1307). This means pnjlim/fetlim/limvds CAN post limiting events to `ctx.limitingCollector` even when bypass subsequently fires, because the bypass decision comes after limiting. In ngspice, the bypass check in `mos1load.c:258-348` occurs BEFORE the limiting block at line 356. The order is: (1) compute cdhat/cbhat, (2) check bypass, (3) if not bypassed, run limiting. In digiTS, the order is: (1) compute voltages from rhsOld/predictor, (2) run limiting unconditionally, (3) compute cdhat/cbhat, (4) check bypass. This ordering deviation from `mos1load.c` means limiting events are emitted even when bypass fires — violating the spec acceptance criterion.

**File**: `src/components/semiconductors/mosfet.ts` lines 1101–1307

---

### G-4 — Task 6.1.3 spec: assertion that `bypass` and `voltTol` code paths are "verified by running the bypass branch introduced in Task 6.2.4"

**Spec requirement**: Task 6.1.3 test: "assert the call does not throw and the fields are read through the `ctx.bypass` / `ctx.voltTol` code paths (verified by running the bypass branch introduced in Task 6.2.4)."

**What was found**: The test at line 829–879 in mosfet.test.ts uses `MODEDCOP | MODEINITJCT` mode with `bypass: true`. The MODEINITJCT path goes through the `else` branch (line 1209), sets `icheckLimited = false`, and returns to stamps — the bypass gate at line 1285 is never reached because it's inside `if (simpleGate)`. Therefore `ctx.bypass` and `ctx.voltTol` are NOT exercised by this test call path. The test passes (no throw) but does not actually verify the bypass code path is exercised as the spec requires.

**File**: `src/components/semiconductors/__tests__/mosfet.test.ts` lines 846–879

---

## Weak Tests

### WT-1 — M-4 "bypass disabled during predictor": assertion is trivially weak

**Test**: `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-4::bypass disabled during predictor`
**Lines**: 1381–1408

**Problem**: The spec says "Assert `s0[SLOT_CD]` IS updated (bypass guard excludes MODEINITPRED)." The test only checks `ctx.solver.getCSCNonZeros().length > 0`, which is satisfied even if bypass fires (bypass still stamps). The spec's required assertion — that `S_CD` was actually updated by fresh OP evaluation — is absent. A bypass firing would also pass this assertion.

**Quoted evidence**:
```typescript
// We just verify no throw and the mode gate worked.
expect(ctx.solver.getCSCNonZeros().length).toBeGreaterThan(0);
```

---

### WT-2 — M-4 "bypass disabled during SMSIG": assertion is trivially weak

**Test**: `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-4::bypass disabled during SMSIG`
**Lines**: 1410–1428

**Problem**: Same issue as WT-1. The spec requires asserting `s0[SLOT_CD]` IS updated. The test only checks stamps are non-empty, which does not distinguish bypass-fired from bypass-missed.

**Quoted evidence**:
```typescript
// SMSIG excludes bypass → OP eval ran → CD updated. Just check no throw.
expect(ctx.solver.getCSCNonZeros().length).toBeGreaterThan(0);
```

---

### WT-3 — M-4 "bypass does not fire when delvbs exceeds voltTol": assertion does not verify bypass was suppressed

**Test**: `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-4::bypass does not fire when delvbs exceeds voltTol`
**Lines**: 1430–1461

**Problem**: The spec requires asserting "`s0[SLOT_CD]` is updated (no bypass)." The test only checks `ctx.solver.getCSCNonZeros().length > 0`. The comment in the test even acknowledges "delvbs exceeded voltTol → bypass did not fire → OP updated → CD may differ" but then only asserts stamps are present, which does not verify that CD was actually updated by fresh computation.

**Quoted evidence**:
```typescript
// Verify load ran (no throw, stamps present).
expect(ctx.solver.getCSCNonZeros().length).toBeGreaterThan(0);
```

---

### WT-4 — M-6 "pnjlim limit → noncon increments": uses `toBeGreaterThan(0)` not exact count

**Test**: `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-6::pnjlim limit → noncon increments`
**Line**: 1634

**Problem**: The spec says this call should increment `ctx.noncon.value` to 1. The test asserts `toBeGreaterThan(0)`, which would also pass if noncon incremented multiple times due to a logic error. The rules say "Test the specific: exact values, exact types, exact error messages where applicable."

**Quoted evidence**:
```typescript
expect(ctx.noncon.value).toBeGreaterThan(0);
```

---

### WT-5 — M-1 "predictor voltages pass through fetlim": uses `toBeGreaterThan(0)` not exact event check

**Test**: `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-1::predictor voltages pass through fetlim`
**Line**: 1092

**Problem**: The spec says "assert `ctx.limitingCollector` contains a `junction: 'GS', limitType: 'fetlim'` event." The test only checks `fetlimEvents.length > 0`, not the specific `junction` or `limitType` fields. The filter on line 1089–1091 narrows to `limitType === "fetlim"` but does not verify `junction === "GS"`.

**Quoted evidence**:
```typescript
expect(fetlimEvents.length).toBeGreaterThan(0);
```

---

### WT-6 — M-1 "predictor voltages pass through pnjlim": uses `toBeGreaterThan(0)`, does not check junction or Gillespie bound

**Test**: `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-1::predictor voltages pass through pnjlim`
**Line**: 1128

**Problem**: The spec says "assert `ctx.limitingCollector` contains a `junction: 'BS', limitType: 'pnjlim'` event AND the limited `vbs` obeys the Gillespie bound." The test checks `pnjlimEvents.length > 0` only, neither verifying the junction label nor the Gillespie bound on the limited voltage value.

**Quoted evidence**:
```typescript
expect(pnjlimEvents.length).toBeGreaterThan(0);
```

---

### WT-7 — M-2 "SMSIG reads voltages from rhsOld": asserts `Math.abs(cd) > 1e-15` — trivially weak

**Test**: `src/components/semiconductors/__tests__/mosfet.test.ts::MOSFET M-2::SMSIG reads voltages from rhsOld`
**Line**: 1163

**Problem**: The spec says "assert the stamped currents reflect the rhsOld-derived voltages, not state0-derived." The test asserts `Math.abs(cd) > 1e-15`, which is trivially satisfied by virtually any non-cutoff operating point and does not prove that state0's different voltage (VGS=0.5, below threshold) was NOT used. The correct test would compare cd values under the two different input sets to prove rhsOld was used.

**Quoted evidence**:
```typescript
const cd = pool.states[0][S_CD];
expect(Math.abs(cd)).toBeGreaterThan(1e-15);
```

---

## Legacy References

### LR-1 — `VSB legacy` comment in `computeIds` docstring

**File**: `src/components/semiconductors/mosfet.ts`
**Line**: 563

**Quoted evidence**:
```
 * Inputs: `vgs`, `vds`, and `vsb` (VSB legacy = vs - vb → vbs = -vsb inside).
```

The word "legacy" marks the VSB sign convention as a relic of the old (pre-G1) digiTS convention. This is a legacy reference per rules §Code Hygiene.

---

### LR-2 — `Legacy vsb = -vbs` comment inside `computeIds` body

**File**: `src/components/semiconductors/mosfet.ts`
**Line**: 579

**Quoted evidence**:
```typescript
  // Legacy vsb = -vbs; vsb >= 0 means vbs <= 0 → normal reverse bias.
```

Same legacy reference, inside the function body.

---

### LR-3 — `DIVERGENCE - NOT "INTENTIONAL"` comment block

**File**: `src/components/semiconductors/mosfet.ts`
**Lines**: 553–554

**Quoted evidence**:
```
// DIVERGENCE - NOT "INTENTIONAL": THESE SIGN FLIPS ARE DEFINITELY NOT APPROVED
// BY THE AUTHOR.
```

This comment references the historical divergence between the VSB convention used in these helpers and the VBS convention required by ngspice/G1. Per rules §Code Hygiene and CLAUDE.md §ngspice Parity Vocabulary — Banned Closing Verdicts, "DIVERGENCE" used as an in-line comment (rather than in `spec/architectural-alignment.md`) is an unauthorized inline justification for code that doesn't conform to specification.

---

## Detailed Finding Notes

### Ordering deviation in bypass gate vs limiting block (Gap G-3 elaboration)

The `mos1load.c` structure is:
1. Lines 200–254: Compute voltages (predictor or rhsOld)
2. Lines 258–348: Bypass gate — if bypass fires, jump to stamp section
3. Lines 356–406: Limiting block (only reaches here if NOT bypassed)

The digiTS `load()` structure is:
1. Compute voltages (predictor or rhsOld)
2. **Run limiting block unconditionally** (lines 1101–1208)
3. Compute cdhat/cbhat (lines 1255–1283)
4. Check bypass gate (lines 1285–1306)

This means digiTS runs limiting before the bypass check, so pnjlim/fetlim/limvds events are emitted into `ctx.limitingCollector` even when bypass subsequently fires. This is a structural deviation from `mos1load.c` that violates the spec's acceptance criterion for Task 6.2.4: "no limiting events posted when bypassed."

It also means `icheckLimited` can be set to `true` before bypass fires, potentially causing `ctx.noncon.value` to increment in the bypass path — although the test "noncon increments even on bypass" (line 1489–1509) uses a converged state where pnjlim would not limit, so this edge case is not caught by the existing tests.

The fix per ngspice requires moving the bypass computation block BEFORE the limiting block, so that when bypass fires, the limiting block is entirely skipped.

### `MosfetTempParams` interface missing `vt` field (Gap G-1 elaboration)

The Task 6.2.9 spec acceptance criterion says: "Add a `vt: number` field to `MosfetTempParams`." The interface at lines 395–418 declares `tTransconductance`, `tPhi`, `tVbi`, `tVto`, `tSatCur`, etc. — but there is no `vt: number` in the interface declaration. The value IS in the returned object (line 539: `vt,`) due to TypeScript's structural typing, so callers like `load()` at line 1037 can access `tp.vt`. However, the interface contract is formally incomplete. Any consumer that types against `MosfetTempParams` (rather than using an inferred type) would not see `vt` as a declared member.
