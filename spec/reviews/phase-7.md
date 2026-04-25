# Review Report: Phase 7 — F5ext JFET Full Convergence Port

## Summary

- **Tasks reviewed**: 10 (Wave 7.1: 7.1.1, 7.1.2, 7.1.3, 7.1.4, 7.1.5, 7.1.6; Wave 7.2: 7.2.1, 7.2.2, 7.2.3, 7.2.4)
- **Files reviewed**: `src/components/semiconductors/njfet.ts`, `src/components/semiconductors/pjfet.ts`, `src/components/semiconductors/__tests__/jfet.test.ts`
- **Violations**: 6 (1 critical, 2 major, 3 minor)
- **Gaps**: 2
- **Weak tests**: 2
- **Legacy references**: 2
- **Verdict**: has-violations

---

## Violations

### V-1 — Critical: `makeDcOpCtx` passes stale `voltages` field instead of `rhsOld`

- **File**: `src/components/semiconductors/__tests__/jfet.test.ts`, lines 126–149
- **Rule violated**: Code Hygiene — "All replaced or edited code is removed entirely. Scorched earth." / "No fallbacks. No backwards compatibility shims."
- **Evidence**:
  ```ts
  function makeDcOpCtx(voltages: Float64Array, matrixSize: number): LoadContext {
    const solver = new SparseSolver();
    solver.beginAssembly(matrixSize);
    return {
      cktMode: MODEDCOP | MODEINITFLOAT,
      solver,
      voltages,          // <-- stale field name
      ...
    } as LoadContext;
  }
  ```
- **Explanation**: The `LoadContext` interface does not have a `voltages` field — the correct field is `rhsOld` (confirmed in `src/solver/analog/load-context.ts:82`). The function uses TypeScript's `as LoadContext` cast to suppress the type error, hiding the bug. This causes `ctx.rhsOld` to be `undefined` inside `njfet.ts` and `pjfet.ts` `load()` when `makeDcOpCtx` is used, making the general-iteration branch crash with "Cannot read properties of undefined (reading '0')". This is the documented cause of the PJFET smoke test pre-existing failure ("emits_stamps_when_conducting"). The test file was modified in Wave 7.2 (Tasks 7.2.1–7.2.4 added imports and new test cases, meaning the agent touched this file and was obligated to fix the stale field). The Task 7.2.4 `makeCtx()` helpers at lines 363–387 and 452–477 correctly use `rhsOld:` — the same agent authored correct helpers in the same file and left the broken `makeDcOpCtx` in place. This is a shim that protects a broken test path and masks a real crash in the smoke test.
- **Severity**: critical

---

### V-2 — Major: "fallback" comment in NJFET MODEINITPRED branch decorates potentially mischaracterised code

- **File**: `src/components/semiconductors/njfet.ts`, line 402
- **Rule violated**: Code Hygiene — "Any comment containing words like … 'fallback' … is almost never just a comment problem. The comment exists because an agent left dead or transitional code in place."
- **Evidence**:
  ```ts
  // rotation fallback matching the pool-rotation model.
  ```
  Full comment at lines 400–402:
  ```ts
  // jfetload.c:124-149: predictor step (#ifndef PREDICTOR default).
  // ngspice predictor is #undef by default → inert. Use state1
  // rotation fallback matching the pool-rotation model.
  ```
- **Explanation**: Per the rules, any comment containing "fallback" is a dead-code marker. The comment characterises the MODEINITPRED implementation as a "fallback" because the ngspice PREDICTOR macro is undefined by default. This means the implementation is NOT a verbatim port of `jfetload.c:124-149` — the spec requires verbatim porting (Phase 7 governing rule: "Implementers port verbatim: variable-name renames are OK, control-flow restructuring is not"). If the ngspice PREDICTOR is undefined, then the MODEINITPRED branch in ngspice simply falls through to the general-iteration else clause (there is no predictor computation). What digiTS implements as the "MODEINITPRED branch" (the xfact extrapolation code) does NOT correspond to `jfetload.c:124-149` — it is a digiTS-invented extrapolation using pool state rotation. The comment "fallback matching the pool-rotation model" confirms this is digiTS-specific code that has no ngspice verbatim counterpart, yet the citation `// jfetload.c:124-149` is present. The "fallback" word signals the agent was aware this is not a true port.
- **Severity**: major

---

### V-3 — Major: Same "fallback" comment issue in PJFET MODEINITPRED branch

- **File**: `src/components/semiconductors/pjfet.ts`, line 375
- **Rule violated**: Same as V-2
- **Evidence**:
  ```ts
  // inert in ngspice). Use state1 rotation fallback.
  ```
  Full comment at lines 373–375:
  ```ts
  // jfetload.c:124-149: predictor step (#ifndef PREDICTOR default is
  // inert in ngspice). Use state1 rotation fallback.
  ```
- **Explanation**: Identical issue to V-2. The "fallback" word in PJFET's MODEINITPRED comment marks the same digiTS-invented xfact extrapolation code that is not a verbatim port of `jfetload.c:124-149`.
- **Severity**: major

---

### V-4 — Minor: "quirk" appears in njfet.ts comment (Task 7.1.6 acceptance criterion violated)

- **File**: `src/components/semiconductors/njfet.ts`, line 719
- **Rule violated**: Task 7.1.6 acceptance criterion: "No occurrence of the substring `'quirk'` in njfet.ts or pjfet.ts."
- **Evidence**:
  ```ts
  // to logical `||` — no "quirk," just C convention ported verbatim.
  ```
- **Explanation**: The spec acceptance criterion for Task 7.1.6 states verbatim: "No occurrence of the substring `'quirk'` in njfet.ts or pjfet.ts." The progress.md entry for Task 7.1.6 acknowledges this ("Note: both files contain the word 'quirk' in the corrected comment (in the phrase `no "quirk,"`) — this matches the spec-specified comment text and the acceptance criterion intent (the old framing is removed)"). However, the spec acceptance criterion is unambiguous: zero occurrences of the substring, regardless of the phrase context. The criterion does not say "zero occurrences of the old quirk framing" — it says zero occurrences of the substring. The agent self-approved a deviation from the literal acceptance criterion.
- **Severity**: minor

---

### V-5 — Minor: "quirk" appears in pjfet.ts comment (same violation as V-4)

- **File**: `src/components/semiconductors/pjfet.ts`, line 681
- **Rule violated**: Same as V-4
- **Evidence**:
  ```ts
  // to logical `||` — no "quirk," just C convention ported verbatim.
  ```
- **Severity**: minor

---

### V-6 — Minor: Duplicate `// cite: jfetload.c:165-174` comment appears in njfet.ts at both function-scope variable declaration site and inside the `else` block

- **File**: `src/components/semiconductors/njfet.ts`, lines 366–369 and lines 472–473
- **Rule violated**: Code Hygiene — comments exist only to explain complicated code; duplicated citations add noise and can mislead parity auditors into reading the wrong site as the port location.
- **Evidence**:
  Lines 366–369 (inside the variable declarations at function scope):
  ```ts
  // cite: jfetload.c:165-174 — extrapolated currents for bypass + noncon;
  // set only in the general-iteration branch.
  let cghat = 0;
  let cdhat = 0;
  ```
  Lines 472–473 (inside the `else` block, the actual computation site):
  ```ts
  // cite: jfetload.c:165-174 — extrapolated currents for bypass + noncon gates
  const delvgs = vgs - s0[base + SLOT_VGS];
  ```
  The same citation `jfetload.c:165-174` appears twice in the same function. The same duplication exists in `pjfet.ts` at lines 340–343 and lines 444–445.
- **Severity**: minor

---

## Gaps

### G-1: Task 7.1.6 acceptance criterion — "No occurrence of the substring 'quirk'" — not met

- **Spec requirement**: Task 7.1.6 Acceptance criteria: "No occurrence of the substring `'quirk'` in njfet.ts or pjfet.ts."
- **What was found**: One occurrence each in njfet.ts:719 and pjfet.ts:681 in the phrase `no "quirk,"`. The progress.md entry self-rationalises this as "matching the spec-specified comment text" but the spec's comment text (`// cite: jfetload.c:498-507 — suppress noncon bump only when both / MODEINITFIX and MODEUIC are set (UIC-forced IC at init step). / Bitwise ...`) does not contain the word "quirk". The extra phrase `no "quirk," just C convention ported verbatim` was added beyond the specified comment text.
- **File**: `src/components/semiconductors/njfet.ts:719`, `src/components/semiconductors/pjfet.ts:681`

### G-2: Task 7.2.2 acceptance criterion — "Each file contains exactly one `const temp = p.TEMP;` line inside `computeJfetTempParams`" — needs verification

- **Spec requirement**: Task 7.2.2 Acceptance criteria: "Each file contains exactly one `const temp = p.TEMP;` line inside `computeJfetTempParams`."
- **What was found**: njfet.ts line 230 has `const temp = p.TEMP;` — one occurrence (correct). pjfet.ts line 206 has `const temp = p.TEMP;` — one occurrence (correct). Both correct. No gap here. _(Noted as verified-clean; included because spec mandates enumeration.)_
- **File**: `src/components/semiconductors/njfet.ts:230`, `src/components/semiconductors/pjfet.ts:206`
- **Status**: Clean (verified, no gap).

> **Correction**: G-2 above is verified clean. The only genuine gap is G-1.

---

## Weak Tests

### WT-1: `PJFET::emits_stamps_when_conducting` — weak assertion `toBeGreaterThan(0)` on stamp count

- **Test path**: `src/components/semiconductors/__tests__/jfet.test.ts::PJFET::emits_stamps_when_conducting`
- **What is wrong**: The assertion `expect(nonzeroStamps.length).toBeGreaterThan(0)` is trivially weak. It passes as long as at least one non-zero stamp exists anywhere in the matrix, which is true even for a completely non-conducting device with only GMIN contributions. It does not verify that gate, drain, or source junction stamps have correct conductances, that the drain current is physically reasonable, or that polarity=-1 stamps differ from polarity=+1. A device with only GMIN stamps (zero transconductance) would pass this test.
- **Evidence**:
  ```ts
  const nonzeroStamps = entries.filter((e) => Math.abs(e.value) > 1e-15);
  expect(nonzeroStamps.length).toBeGreaterThan(0);
  ```
- **Additional concern**: This test is also broken at runtime because `makeDcOpCtx` passes `voltages:` instead of `rhsOld:` (see V-1), causing the PJFET `load()` to crash with "Cannot read properties of undefined (reading '0')" in the general-iteration branch. The test passes only because the loop at lines 195–197 runs `makeDcOpCtx` which crashes — but the previous MODEINITJCT/MODEINITSMSIG mode seedings in earlier iterations leave state0 populated, so subsequent calls with MODEDCOP|MODEINITFLOAT (which goes to the `else` branch and reads `ctx.rhsOld`) crash, meaning the test is exercising an exception path rather than the intended conductor path.

### WT-2: `NR::converges_within_10_iterations` — assertion checks convergence only, not correctness of operating point

- **Test path**: `src/components/semiconductors/__tests__/jfet.test.ts::NR::converges_within_10_iterations`
- **What is wrong**: The test verifies `result.converged === true` and `result.iterations <= 10` but does not assert anything about the operating point voltages or drain current. A JFET circuit converging to `vds = 0` (cutoff) would pass. The test confirms the NR loop terminates but not that the solution is physically meaningful. The spec's testing strategy explicitly defers detailed parity tests to Phase 10 — this is documented and expected. Recorded here per reviewer mandate to flag all weak assertions.
- **Evidence**:
  ```ts
  expect(result.converged).toBe(true);
  expect(result.iterations).toBeLessThanOrEqual(10);
  ```

---

## Legacy References

### LR-1: `njfet.ts` — "rotation fallback" in MODEINITPRED comment is a legacy/transitional phrase

- **File**: `src/components/semiconductors/njfet.ts`, line 402
- **Stale reference**:
  ```ts
  // rotation fallback matching the pool-rotation model.
  ```
  The phrase "pool-rotation model" refers to the internal digiTS state-pool rotation mechanism, not any ngspice concept. This is a historical-provenance comment referencing internal architecture that "replaced" the ngspice PREDICTOR path.

### LR-2: `pjfet.ts` — "state1 rotation fallback" in MODEINITPRED comment is a legacy/transitional phrase

- **File**: `src/components/semiconductors/pjfet.ts`, line 375
- **Stale reference**:
  ```ts
  // inert in ngspice). Use state1 rotation fallback.
  ```
  Same issue as LR-1 — "state1 rotation fallback" characterises the implementation as a digiTS substitute for something ngspice does not do, which is a historical-provenance comment.

---

## Additional Observations (not counted as violations)

### Structural correctness confirmed

The following spec requirements were verified as correctly implemented:

- **Task 7.1.1**: Both njfet.ts (lines 411–418) and pjfet.ts (lines 384–391) copy all 7 additional slots (CG, CD, CGD, GM, GDS, GGS, GGD) from state1 to state0 inside the MODEINITPRED branch, with citation `// cite: jfetload.c:135-148`. Correct.

- **Task 7.1.2**: Both files compute `delvgs`, `delvgd`, `delvds`, `cghat`, `cdhat` in the general-iteration `else` branch. The noncon gate in both files uses the 3-trigger form with `>=`/`>` asymmetry (cghat uses `>=`, cdhat uses `>`). Both files have `// cite: jfetload.c:498-507`. Correct.

- **Task 7.1.3**: Both files have the four-level nested `if` bypass block (not `&&`-collapsed). The `bypassed` flag controls `if (!bypassed)` around the compute block. The noncon gate and state-writeback run unconditionally outside `if (!bypassed)`. The bypass block is gated on `ctx.bypass && !(mode & MODEINITPRED)`. Correct.

- **Task 7.1.4**: Both njfet.ts and pjfet.ts contain zero occurrences of `primeJunctions` or `primedFromJct` (confirmed by Grep). Correct.

- **Task 7.1.5**: Both files import `fetlim` from `newton-raphson.js` and use exactly two `fetlim(` calls each (for vgs and vgd). No `vtsthi`/`vtstlo`/`vtox`/`delv` locals remain. Correct.

- **Task 7.2.1**: Both files have `TEMP: { default: 300.15, unit: "K", description: "Per-instance operating temperature" }` in secondary params. Correct.

- **Task 7.2.2**: Both files have `const temp = p.TEMP;` inside `computeJfetTempParams`/`computePjfetTempParams` with `// cite: jfettemp.c:83`. No `const temp = REFTEMP;` remains in either file. Correct.

- **Task 7.2.3**: Both files contain zero occurrences of `ctx.vt`. Confirmed by Grep. Tests `no_ctx_vt_read_in_njfet_ts` and `no_ctx_vt_read_in_pjfet_ts` use `readFileSync` + regex count assertions. Correct.

- **Task 7.2.4**: `setParam` routes through `computeJfetTempParams`/`computePjfetTempParams` because it checks `if (key in params)` and TEMP is in params. Tests verify VGS differs between 300.15K and 400K. Correct.

### `ctx.bypass` access

Both files access `ctx.bypass` directly through the context object (no destructuring into top-of-function locals). Spec requirement met.

### `bypassed` flag initialisation location

The `bypassed` flag is declared at function scope (`let bypassed = false;` at njfet.ts:352, pjfet.ts:326) BEFORE the mode-dispatch `if/else` chain. The bypass block is inside the `else` clause (the general-iteration branch), consistent with the spec's requirement that the bypass block follows the cghat/cdhat compute.

### PJFET `setParam_TEMP_recomputes_tp` test uses correct `rhsOld` field

The Task 7.2.4 test for both NJFET and PJFET correctly uses `rhsOld:` in the local `makeCtx()` helpers (lines 363–387 and 452–477). These helpers are correct; only the module-level `makeDcOpCtx` (V-1) is broken.

---

## Detailed Finding Index

| ID | Severity | File | Line | Category |
|----|----------|------|------|----------|
| V-1 | critical | jfet.test.ts | 126–149 | Violation — stale `voltages` field in `makeDcOpCtx` |
| V-2 | major | njfet.ts | 402 | Violation — "fallback" comment / non-verbatim port characterisation |
| V-3 | major | pjfet.ts | 375 | Violation — "fallback" comment / non-verbatim port characterisation |
| V-4 | minor | njfet.ts | 719 | Violation — "quirk" substring present (Task 7.1.6 acceptance criterion) |
| V-5 | minor | pjfet.ts | 681 | Violation — "quirk" substring present (Task 7.1.6 acceptance criterion) |
| V-6 | minor | njfet.ts + pjfet.ts | 366+472 / 340+444 | Violation — duplicate `jfetload.c:165-174` citation in same function |
| G-1 | — | njfet.ts:719, pjfet.ts:681 | — | Gap — Task 7.1.6 acceptance criterion not met |
| WT-1 | — | jfet.test.ts | 204 | Weak test — `toBeGreaterThan(0)` on stamp count |
| WT-2 | — | jfet.test.ts | 231–232 | Weak test — NR convergence only, no OP value assertion |
| LR-1 | — | njfet.ts | 402 | Legacy reference — "rotation fallback matching the pool-rotation model" |
| LR-2 | — | pjfet.ts | 375 | Legacy reference — "state1 rotation fallback" |
