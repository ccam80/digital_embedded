# Phase 3: F2 — NR Reorder Gate + Per-Device xfact Predictor (diode + BJT)

## Overview

Two narrow alignment items that must land before the device-level phases (5 / 6 / 7 / 7.5) begin:

1. **NR reorder timing.** The pre-factor `NISHOULDREORDER` gate at the top of the NR loop. Phase 2.5 W2.1 (B5) landed this; Phase 3 Wave 3.1 verifies it by test and corrects citation hygiene at the two other `forceReorder()` call sites.
2. **xfact predictor inside `load()`.** Each device's unified `load()` must compute linearization voltages as `(1 + xfact) * state1 - xfact * state2` under `MODEINITPRED`, copy the corresponding `state1 → state0` history slots, and pass the extrapolated values on to pnjlim exactly as `dioload.c` / `bjtload.c` do. Current code has the state-copy scaffolding but reads voltage from `rhsOld` instead of extrapolating — a silent divergence that Phase 3 closes.

Targeted vitest scope: `src/solver/analog/__tests__/newton-raphson.test.ts`, `src/solver/analog/__tests__/analog-engine.test.ts`, `src/components/semiconductors/__tests__/diode.test.ts`, `src/components/semiconductors/__tests__/bjt.test.ts`, plus the new `src/solver/analog/__tests__/phase-3-nr-reorder.test.ts` and `src/components/semiconductors/__tests__/phase-3-xfact-predictor.test.ts` files introduced in this phase. Full-suite runs are prohibited per Appendix A until Phase 9.

**Plan corrections applied during spec authoring:**

- **Task 3.1.1** is verify-only. Phase 2.5 Wave 2.1 (B5) landed the `forceReorder()` gate at the top of the NR loop (`newton-raphson.ts:337-357`) with the exact `MODEINITJCT || (MODEINITTRAN && iteration === 0)` condition and `niiter.c:856-859` citation the plan calls for. Phase 3's Task 3.1.1 is re-expressed as an assertion-by-test guard against regression.
- **Task 3.1.2** citation target corrected AND DC-OP portion stricken (user confirmed 2026-04-24). The plan's "cite `niiter.c:474-499`" is a plan-authoring error — that range is the tail of `ni_check_convergence` and the head of `ni_send_topology`, neither of which relates to the reorder flow. The remaining live citation target is `niiter.c:888-891` for the E_SINGULAR retry `forceReorder()` at `newton-raphson.ts:396` (already present and correct). The plan's second target — a `cktop.c` citation at a `dc-operating-point.ts` `forceReorder()` call under a MODEINITJCT→MODEINITFIX transition — is **stricken**: `dc-operating-point.ts` has zero `forceReorder()` calls and zero `MODEINITFIX` usages (it transitions MODEINITJCT→MODEINITFLOAT at :536/:628/:681/:739/:751/:772, each already citing ngspice `cktop.c:179/:319/:453/:497/:603`), and ngspice `cktop.c` itself has zero `MODEINITFIX` references. The presumed call site does not exist in digiTS and the presumed ngspice analog does not exist in ngspice.
- **Task 3.2.4** narrowed to `SLOT_VSUB` state-copy only. The plan's `SLOT_RB_EFF` reference is a plan-authoring error — the effective base resistance is computed as a local (`rbpr`, `rbpi`) inside `load()` per the post-A1 rule; no `SLOT_RB_EFF` slot exists in `BJT_L1_SCHEMA`.
- **Plan's "route predicted voltages through the pnjlim-skip path" direction overridden.** Independent ngspice re-verification against `dioload.c:139-205` and `bjtload.c:276-416` confirms pnjlim runs on the MODEINITPRED-extrapolated voltage on every predictor iteration in both devices. The only `!(MODEINITPRED)` guards in those regions wrap the `#ifndef NOBYPASS` bypass test, not the `DEVpnjlim` call. Phase 3 aligns with ngspice: pnjlim runs on the extrapolated `vdRaw` / `vbeRaw` / `vbcRaw` / `vsubRaw`. Diode's current pnjlim skip mask is already correct (MODEINITPRED not present). BJT L0 and BJT L1 skip masks at `bjt.ts:862` and `bjt.ts:1310` incorrectly include `MODEINITPRED`; Phase 3 removes it.

---

## Wave 3.1: NR reorder timing

### Task 3.1.1: Verify-only — NR loop-top `forceReorder()` gate

- **Description**: *Verify-only.* Phase 2.5 Wave 2.1 (B5) landed the pre-factor `NISHOULDREORDER` gate at `newton-raphson.ts:337-357`. The implementation uses `initf(ctx.cktMode) === MODEINITJCT || (initf(ctx.cktMode) === MODEINITTRAN && iteration === 0)` which, under the mutually-exclusive `INITF` bitfield invariant enforced by `ckt-mode.ts:86-88` and `setInitf()` at `ckt-mode.ts:96-98`, is equivalent to ngspice's `(ckt->CKTmode & MODEINITJCT) || ((ckt->CKTmode & MODEINITTRAN) && (iterno==1))` at `niiter.c:856-859`. The citation comment at `newton-raphson.ts:337-345` already quotes that ngspice block verbatim. Task 3.1.1 asserts by test that the gate fires on the three relevant mode combinations and does not fire on the others, and that the `forceReorder()` call sits before the `factor()` dispatch (line ordering).

- **Files to modify**: none. *(This task has zero production-code changes. Any diff in `newton-raphson.ts` within the scope of Task 3.1.1 must be rejected at review — the pattern must be Phase 2.5's landing, unmodified.)*

- **Files to create**:
  - `src/solver/analog/__tests__/phase-3-nr-reorder.test.ts` — new file. Contains both Task 3.1.1 and Task 3.1.2 assertions.

- **Tests** (`src/solver/analog/__tests__/phase-3-nr-reorder.test.ts`):
  - `describe("Task 3.1.1 — NR loop-top forceReorder gate")::it("fires forceReorder when cktMode has MODEINITJCT")` — construct a minimal 2-element NR fixture (resistor + diode) with `ctx.cktMode = MODEDCOP | MODEINITJCT`, spy on `solver.forceReorder`, invoke `newtonRaphson(ctx)`, assert `solver.forceReorder.mock.calls.length >= 1` AND that the first call happened on iteration 0 before any `solver.factor` call.
  - `describe("Task 3.1.1 — NR loop-top forceReorder gate")::it("fires forceReorder only on iteration 0 when cktMode has MODEINITTRAN")` — same fixture with `ctx.cktMode = MODETRAN | MODEINITTRAN`. Spy captures iteration index (via interleaving with a `cktLoad` spy). Assert `forceReorder` called during iteration 0, NOT called during iteration 1+.
  - `describe("Task 3.1.1 — NR loop-top forceReorder gate")::it("does not fire forceReorder on MODEINITFLOAT or MODEINITFIX")` — `ctx.cktMode = MODEDCOP | MODEINITFLOAT` then `MODEDCOP | MODEINITFIX`. Assert `solver.forceReorder` not called from the loop-top path on either (may still be called from the E_SINGULAR retry at `newton-raphson.ts:396` or from the init-transition at `newton-raphson.ts:567`; distinguish by call-site identity via `Error().stack` or by wrapping).
  - `describe("Task 3.1.1 — NR loop-top forceReorder gate")::it("precedes factor() in call order")` — instrument both `solver.forceReorder` and `solver.factor`. Run one NR iteration with `MODEINITJCT`. Assert recorded call order: `preorder` → `forceReorder` → `factor`.
  - `describe("Task 3.1.1 — NR loop-top forceReorder gate")::it("cites niiter.c:856-859 in the loop-top gate comment")` — source-text assertion: read `newton-raphson.ts` as a string, assert the substring `"niiter.c:856-859"` appears within 30 lines preceding the first `solver.forceReorder()` call inside `newtonRaphson`. Guards against future comment churn that would lose the citation anchor.

- **Acceptance criteria**:
  - Zero lines of production code changed by Task 3.1.1.
  - All five `phase-3-nr-reorder.test.ts::describe("Task 3.1.1 …")` tests pass.
  - The existing `newton-raphson.ts:354-357` forceReorder block is present verbatim at phase end.

### Task 3.1.2: Citation hygiene for non-top-of-loop `forceReorder()` call sites (verify-only after DC-OP portion stricken)

- **Description**: One `forceReorder()` call sits outside the Task 3.1.1 loop-top gate: the E_SINGULAR retry at `newton-raphson.ts:396`. The E_SINGULAR retry already cites `niiter.c:888-891` at `newton-raphson.ts:392-394` — Task 3.1.2 asserts by test that the citation is present and unchanged.

  The plan's second target — a `cktop.c` citation at a `dc-operating-point.ts` `forceReorder()` call under a MODEINITJCT→MODEINITFIX transition — is **stricken** (2026-04-24 user clarification). Verification against `ref/ngspice/src/spicelib/analysis/cktop.c` and `src/solver/analog/dc-operating-point.ts` confirms that (a) `dc-operating-point.ts` has zero `forceReorder()` calls and zero `MODEINITFIX` usages (it transitions MODEINITJCT→MODEINITFLOAT at :536/:628/:681/:739/:751/:772, each already citing specific ngspice cktop.c line ranges), and (b) ngspice `cktop.c` itself has zero `MODEINITFIX` references. The presumed call site does not exist in digiTS and the presumed ngspice analog does not exist in ngspice — there is no citation to add. The plan-authoring assumption was wrong on both sides.

  The plan's "`niiter.c:474-499`" reference is a separate plan-authoring error (that ngspice range is unrelated `ni_check_convergence` / `ni_send_topology` code). Task 3.1.2 retains a regression-guard test asserting neither `newton-raphson.ts` nor `dc-operating-point.ts` contains that stale string.

- **Files to modify**:
  - `src/solver/analog/newton-raphson.ts` — audit-only. Verify the comment block at lines 391-398 still cites `niiter.c:888-891` at the E_SINGULAR retry; if the citation has drifted or been reformatted during Phase 2.5 cleanup, restore it verbatim. No control-flow edits.
  - `src/solver/analog/dc-operating-point.ts` — no edits (no matching call site exists).

- **Tests** (appended to `src/solver/analog/__tests__/phase-3-nr-reorder.test.ts`):
  - `describe("Task 3.1.2 — non-top-of-loop forceReorder citations")::it("cites niiter.c:888-891 at the E_SINGULAR retry")` — read `newton-raphson.ts` as text, locate the `forceReorder()` call inside the `!factorResult.success` block (anchor: preceding line contains `lastFactorUsedReorder`), assert the substring `"niiter.c:888-891"` appears within the 10 lines preceding it.
  - `describe("Task 3.1.2 — non-top-of-loop forceReorder citations")::it("rejects a stale niiter.c:474-499 citation anywhere in NR path")` — grep `newton-raphson.ts` + `dc-operating-point.ts` for `"niiter.c:474-499"`; assert zero hits. Guards against a future partial revert that would reintroduce the plan's bogus reference.
  - The previously-specified cktop.c citation test is **stricken**. If the existing test file contains that test (per the first-pass clarification-stop implementer), delete it along with any `MODEINITFIX`-gated defensive logic.

- **Acceptance criteria**:
  - `newton-raphson.ts:391-398` comment block remains present and cites `niiter.c:888-891`.
  - Neither `newton-raphson.ts` nor `dc-operating-point.ts` contains the substring `niiter.c:474-499`.
  - Both remaining Task 3.1.2 tests pass.
  - The `cites cktop.c at the MODEINITJCT→MODEINITFIX transition` test is absent from `phase-3-nr-reorder.test.ts` (if the first-pass implementer added it, the retry implementer deletes it).

---

## Wave 3.2: Device xfact predictor — diode + BJT

### Task 3.2.1: Diode `MODEINITPRED` xfact extrapolation

- **Description**: The diode `load()` at `diode.ts:519-533` currently has the MODEINITPRED branch scaffolding — it copies `s0 = s1` for the three ngspice-analog state slots (`SLOT_VD`, `SLOT_ID`, `SLOT_GEQ`) — but then falls through to the standard `rhsOld` read for `vdRaw`. ngspice `dioload.c:141-148` instead sets `vd = DEVpred(ckt, here->DIOvoltage)`, which expands (under the default `#ifndef PREDICTOR` build with transient-integration extrapolation) to `(1+xfact) * state1[DIOvoltage] - xfact * state2[DIOvoltage]`. Phase 3 replaces the rhsOld read under MODEINITPRED with the full extrapolation formula.

  After the edit the MODEINITPRED block reads:

  ```
  if (mode & MODEINITPRED) {
    // dioload.c:141-148: state1→state0 copies + DEVpred extrapolation.
    s0[base + SLOT_VD]  = s1[base + SLOT_VD];
    s0[base + SLOT_ID]  = s1[base + SLOT_ID];
    s0[base + SLOT_GEQ] = s1[base + SLOT_GEQ];
    // cite: dioload.c:144 — vd = DEVpred(ckt, DIOvoltage) =
    //       (1+xfact)*state1[vd] - xfact*state2[vd] under #ifndef PREDICTOR.
    vdRaw = (1 + ctx.xfact) * s1[base + SLOT_VD] - ctx.xfact * s2[base + SLOT_VD];
  } else {
    // dioload.c:151-152: normal NR — read from CKTrhsOld.
    const va = nodeJunction > 0 ? voltages[nodeJunction - 1] : 0;
    const vc = nodeCathode > 0 ? voltages[nodeCathode - 1] : 0;
    vdRaw = va - vc;
  }
  ```

  Note that this hoists the `else`-branch rhsOld read INTO an explicit `else`, whereas the current diode.ts has the PRED block as a conditional prefix inside a larger `else` and then always runs the rhsOld read. The rewrite makes the two branches mutually exclusive, matching ngspice's `#ifndef PREDICTOR { ... } else { rhsOld }` structure exactly.

  **pnjlim direction is unchanged.** The skip mask at `diode.ts:540` remains `(MODEINITJCT | MODEINITSMSIG | MODEINITTRAN)` — `MODEINITPRED` stays out of the skip set, and pnjlim runs on the newly-extrapolated `vdRaw` using `vdOld = s0[base + SLOT_VD]` (which equals `s1[base + SLOT_VD]` after the state-copy above, matching `dioload.c:156`'s `delvd = vd - state0[DIOvoltage]` where state0 has just been seeded from state1).

  **xfact source.** Use `ctx.xfact` — the `LoadContext` field set by `analog-engine.ts:430` as `deltaOld[0] / deltaOld[1]` every transient step. Do NOT compute xfact as a local inside `load()` — that would duplicate the engine's computation.

  **Zero-allocation constraint.** No `new`, `{}`, `[]`, or closures inside the MODEINITPRED branch. Only scalar arithmetic on `s1[...]` and `s2[...]` reads.

- **Files to modify**:
  - `src/components/semiconductors/diode.ts` — replace the MODEINITPRED block at lines 518-532 with the explicit `if (mode & MODEINITPRED) { ... } else { ... }` structure above. The outer `else` branch (current lines 515-517 for `MODEINITFIX && OFF`) is unchanged — the new PRED/rhsOld split lives inside what was the bottom-most `else`. Update the existing `// D-W3-3:` comment to read `// cite: dioload.c:141-152` and describe state-copies (:142-148), DEVpred extrapolation (:144), and the `else` rhsOld fallthrough (:151-152) separately.

- **Tests** (new file `src/components/semiconductors/__tests__/phase-3-xfact-predictor.test.ts`, diode section):
  - `describe("Task 3.2.1 — Diode MODEINITPRED xfact")::it("extrapolates vdRaw as (1+xfact)*s1 - xfact*s2")` — instantiate a diode element via `createDiodeElement`, allocate a StatePool, seed `s1[SLOT_VD] = 0.65`, `s2[SLOT_VD] = 0.60`. Build a `LoadContext` with `cktMode = MODETRAN | MODEINITPRED`, `xfact = 0.5`. Call `load(ctx)`. Read back `vdRaw` via instrumentation: add a `(ctx as any).__phase3ProbeVdRaw` write at the end of the MODEINITPRED branch that the test reads. Assert: `ctx.__phase3ProbeVdRaw === (1 + 0.5) * 0.65 - 0.5 * 0.60 = 0.675`. Exact numerical equality (no `toBeCloseTo` — zero-tolerance is the standard per CLAUDE.md).
  - `describe("Task 3.2.1 — Diode MODEINITPRED xfact")::it("copies s1→s0 for VD, ID, GEQ before extrapolation")` — seed `s1[SLOT_VD]=0.65, s1[SLOT_ID]=1e-3, s1[SLOT_GEQ]=4e-2`; ensure `s0` slots are different (`0.1, 2e-3, 8e-2`). After `load(ctx)` with MODEINITPRED + xfact=0.5, assert `s0[SLOT_VD] === 0.65`, `s0[SLOT_ID] === 1e-3`, `s0[SLOT_GEQ] === 4e-2` (the copy must happen before any downstream load() writes, and the downstream writes overwrite SLOT_VD only; ID and GEQ stay at the copied value until the final write-back at end of load()).
  - `describe("Task 3.2.1 — Diode MODEINITPRED xfact")::it("runs pnjlim on the extrapolated vdRaw")` — seed `s1[SLOT_VD]=0.9` (above tVcrit for a typical diode), `s2[SLOT_VD]=0.85`, `xfact=2.0` (so extrapolation `(1+2)*0.9 - 2*0.85 = 1.0` — above `vcrit ≈ 0.65`). Spy on `pnjlim` (module-level). Call `load(ctx)` with `MODEINITPRED`. Assert `pnjlim` was called exactly once with first argument `=== 1.0` (the extrapolated value) and second argument `=== 0.9` (the post-copy `s0[SLOT_VD]`).
  - `describe("Task 3.2.1 — Diode MODEINITPRED xfact")::it("falls through to rhsOld when MODEINITPRED is not set")` — `cktMode = MODETRAN` (MODEINITFLOAT implied). Seed rhsOld node voltages so that `va - vc = 0.72`. Seed `s1[SLOT_VD] = 0.65`, `s2[SLOT_VD] = 0.60`. Call `load(ctx)`. Assert the probe `ctx.__phase3ProbeVdRaw === 0.72` — confirms the `else` branch reads rhsOld, not extrapolation.
  - `describe("Task 3.2.1 — Diode MODEINITPRED xfact")::it("does not allocate during the MODEINITPRED branch")` — wrap the `load(ctx)` call in a `v8`/`--expose-gc`-independent allocation counter fixture (use `performance.memory.usedJSHeapSize` snapshot pre/post if available under Node test runner, otherwise rely on a manual fixture that asserts no `new`/`{}`/`[]` appears in the MODEINITPRED block via source-text substring checks). Source-text fallback: read `diode.ts`, extract the MODEINITPRED branch body (between `if (mode & MODEINITPRED) {` and its matching `}`), assert the body does NOT match the regex `/new\s+\w|\[\s*[^\]]/` (forbids `new X` and non-empty array literals) and does NOT match `/=>|function/` (forbids closures).

- **Acceptance criteria**:
  - `diode.ts` contains an explicit `if (mode & MODEINITPRED) { ... } else { ... }` two-way split at the linearization-voltage dispatch site; the `else` branch reads from `rhsOld`; the `if` branch reads from `s1` / `s2` and computes `(1 + ctx.xfact) * s1[SLOT_VD] - ctx.xfact * s2[SLOT_VD]`.
  - `MODEINITPRED` does NOT appear in the pnjlim skip mask at `diode.ts:540`.
  - All five `Task 3.2.1` tests pass.

### Task 3.2.2: BJT L0 `MODEINITPRED` xfact extrapolation + pnjlim skip-mask fix

- **Description**: Apply the same pattern to the L0 (simple-model) BJT factory `createBjtElement`. Current MODEINITPRED block at `bjt.ts:839-846` copies `s0 = s1` for `SLOT_VBE` / `SLOT_VBC` and then uses the copied values as `vbeRaw` / `vbcRaw` — it never extrapolates. Replace with:

  ```
  } else if (mode & MODEINITPRED) {
    // bjtload.c:278-287: #ifndef PREDICTOR state1→state0 copy + xfact extrapolation.
    s0[base + SLOT_VBE] = s1[base + SLOT_VBE];
    s0[base + SLOT_VBC] = s1[base + SLOT_VBC];
    vbeRaw = (1 + ctx.xfact) * s1[base + SLOT_VBE] - ctx.xfact * s2[base + SLOT_VBE];
    vbcRaw = (1 + ctx.xfact) * s1[base + SLOT_VBC] - ctx.xfact * s2[base + SLOT_VBC];
  } else {
    // bjtload.c:311-319: normal NR iteration — read from CKTrhsOld.
    const vB = nodeB > 0 ? voltages[nodeB - 1] : 0;
    const vC = nodeC > 0 ? voltages[nodeC - 1] : 0;
    const vE = nodeE > 0 ? voltages[nodeE - 1] : 0;
    vbeRaw = polarity * (vB - vE);
    vbcRaw = polarity * (vB - vC);
  }
  ```

  **pnjlim skip-mask fix.** Remove `MODEINITPRED` from the skip mask at `bjt.ts:862`. After the edit:

  ```
  if ((mode & (MODEINITJCT | MODEINITSMSIG | MODEINITTRAN)) === 0) {
    const vbeResult = pnjlim(vbeRaw, s0[base + SLOT_VBE], tp.vt, tp.tVcrit);
    ...
  }
  ```

  Under MODEINITPRED the condition is now true (MODEINITPRED bit not matched by the mask), so pnjlim runs on the extrapolated `vbeRaw` / `vbcRaw` against `s0[SLOT_VBE]` / `s0[SLOT_VBC]` — which after the state-copy equal `s1[SLOT_VBE]` / `s1[SLOT_VBC]` (the previous accepted values). This matches ngspice `bjtload.c:386-403`.

  **noncon gate.** The existing gate `if (icheckLimited && (params.OFF === 0 || !(mode & MODEINITFIX))) ctx.noncon.value++` at `bjt.ts:873` is unchanged — Phase 3 does not touch the noncon path for L0 (that's Phase 5 Task 5.1.4's scope). But the addition of MODEINITPRED to the pnjlim-active set means `icheckLimited` may now be `true` under MODEINITPRED, which would increment `noncon` and block transient convergence on the predictor iteration. This matches ngspice — `bjtload.c:752-753` increments `CKTnoncon` under pnjlim limiting regardless of MODEINITPRED. If this causes an observable test regression, that regression is diagnostic, not a bug.

- **Files to modify**:
  - `src/components/semiconductors/bjt.ts` — (a) inside `createBjtElement::load()`, replace the `else if (mode & MODEINITPRED) { ... }` block at lines 839-846 with the state-copy + xfact-extrapolation version above; (b) at line 862, remove `| MODEINITPRED` from the pnjlim skip mask. Update the adjacent citation comment at line 856-857 to read `// bjtload.c:383-416: pnjlim on BE/BC. pnjlim runs under MODEINITPRED — ngspice has no MODEINITPRED skip (bjtload.c:386 unconditional; !(MODEINITPRED) guard at :347 is for bypass only).`

- **Tests** (appended to `phase-3-xfact-predictor.test.ts`, BJT L0 section):
  - `describe("Task 3.2.2 — BJT L0 MODEINITPRED xfact")::it("extrapolates vbeRaw and vbcRaw as (1+xfact)*s1 - xfact*s2")` — instantiate L0 via `createBjtElement` with default NPN params. Seed `s1[SLOT_VBE]=0.72, s2[SLOT_VBE]=0.70, s1[SLOT_VBC]=-0.3, s2[SLOT_VBC]=-0.28`. `cktMode = MODETRAN | MODEINITPRED`, `xfact = 0.25`. Probe `vbeRaw` / `vbcRaw` via test-instrumented writes `(ctx as any).__phase3ProbeVbeRaw / __phase3ProbeVbcRaw` at the end of the MODEINITPRED branch. Assert `__phase3ProbeVbeRaw === (1+0.25)*0.72 - 0.25*0.70 = 0.74` and `__phase3ProbeVbcRaw === (1+0.25)*(-0.3) - 0.25*(-0.28) = -0.305`.
  - `describe("Task 3.2.2 — BJT L0 MODEINITPRED xfact")::it("copies s1→s0 for VBE and VBC at the start of the PRED branch")` — seed `s1[SLOT_VBE]=0.72, s0[SLOT_VBE]=0.10, s1[SLOT_VBC]=-0.3, s0[SLOT_VBC]=0.05`. After `load(ctx)` with MODEINITPRED, assert `s0[SLOT_VBE] === 0.72` and `s0[SLOT_VBC] === -0.3` (where those reads happen between the state-copy and the downstream `s0[SLOT_VBE] = vbeLimited` write-back — requires the test to inspect an intermediate probe; in practice the cleanest anchor is the value pnjlim is called with for its `vold` arg).
  - `describe("Task 3.2.2 — BJT L0 MODEINITPRED xfact")::it("runs pnjlim under MODEINITPRED")` — spy on the `pnjlim` module export. Seed state to drive extrapolation above tVcrit. Call `load(ctx)` with MODEINITPRED. Assert `pnjlim` was called exactly twice (once for BE, once for BC) — not zero times. This is the key ngspice-alignment assertion that Phase 3 guarantees.
  - `describe("Task 3.2.2 — BJT L0 MODEINITPRED xfact")::it("skips pnjlim under MODEINITJCT / MODEINITSMSIG / MODEINITTRAN")` — three sub-cases, each confirming `pnjlim` was called zero times. Guards against an accidental over-correction that removes too many bits from the skip mask.
  - `describe("Task 3.2.2 — BJT L0 MODEINITPRED xfact")::it("falls through to rhsOld when MODEINITPRED is not set (MODEINITFLOAT)")` — seed rhsOld node voltages so `polarity*(vB-vE)=0.68` and `polarity*(vB-vC)=-0.25`; seed s1 / s2 to different values. `cktMode = MODETRAN` (MODEINITFLOAT). Assert probe `__phase3ProbeVbeRaw === 0.68` and `__phase3ProbeVbcRaw === -0.25`.

- **Acceptance criteria**:
  - `bjt.ts::createBjtElement::load()` contains an `else if (mode & MODEINITPRED)` branch whose body includes both the `s0 = s1` copies and the `(1 + ctx.xfact) * s1[...] - ctx.xfact * s2[...]` extrapolations for `SLOT_VBE` and `SLOT_VBC`.
  - The pnjlim skip mask at `bjt.ts:862` reads `(MODEINITJCT | MODEINITSMSIG | MODEINITTRAN)` — `MODEINITPRED` is absent.
  - All five `Task 3.2.2` tests pass.

### Task 3.2.3: BJT L1 `MODEINITPRED` xfact extrapolation + pnjlim skip-mask fix

- **Description**: Same pattern for the L1 (Gummel-Poon) BJT factory `createSpiceL1BjtElement`. Current MODEINITPRED block at `bjt.ts:1287-1294` copies `s0 = s1` for `SLOT_VBE` / `SLOT_VBC`, reads `vbxRaw` / `vsubRaw` from rhsOld, and uses the copied values directly as `vbeRaw` / `vbcRaw`. Replace with the three-voltage extrapolation that matches `bjtload.c:278-305`:

  ```
  } else if (mode & MODEINITPRED) {
    // bjtload.c:278-305: #ifndef PREDICTOR state1→state0 copy + xfact extrapolation.
    s0[base + SLOT_VBE]  = s1[base + SLOT_VBE];
    s0[base + SLOT_VBC]  = s1[base + SLOT_VBC];
    s0[base + SLOT_VSUB] = s1[base + SLOT_VSUB];
    vbeRaw  = (1 + ctx.xfact) * s1[base + SLOT_VBE]  - ctx.xfact * s2[base + SLOT_VBE];
    vbcRaw  = (1 + ctx.xfact) * s1[base + SLOT_VBC]  - ctx.xfact * s2[base + SLOT_VBC];
    vsubRaw = (1 + ctx.xfact) * s1[base + SLOT_VSUB] - ctx.xfact * s2[base + SLOT_VSUB];
    // bjtload.c:325-330: vbx and vsub recompute from rhsOld after the predictor
    // block (unconditional, not gated on MODEINITPRED). vbx is not extrapolated —
    // ngspice reads it from CKTrhsOld at :325-327 regardless of predictor state.
    vbxRaw = polarity * (vBe_ext - vCi);
  }
  ```

  Note that ngspice's structure at `bjtload.c:323-330` unconditionally recomputes `vbx` (:325-327) and re-reads `vsub` (:328-330) from rhsOld AFTER the else-block closes — both extrapolated and rhsOld paths end with the same `vbx` / `vsub` reads. That second `vsub` recompute at :328-330 overwrites the predictor-extrapolated `vsub` with the rhsOld read. Our current code at `bjt.ts:1293-1294` already reads `vbxRaw` and `vsubRaw` from node voltages under MODEINITPRED; after this edit, `vsubRaw` is first computed as the predictor extrapolation, then the existing `vbxRaw` computation stays. The downstream `vsubRaw` re-read from rhsOld at the end of the extrapolation branch is unnecessary IF we mirror the exact ngspice control flow — but to match `bjtload.c:328-330`'s unconditional rewrite, we keep the rhsOld read inside the MODEINITPRED branch AFTER the extrapolation, so the net effect is: `vsubRaw` gets the rhsOld value, which aligns with ngspice's final `vsub` binding. Similarly for `vbx`. Implementation detail: the cleanest structure mirrors ngspice verbatim — extrapolate inside the `#ifndef PREDICTOR` block, then unconditionally read `vbx` / `vsub` from rhsOld at the end of the `else` body. See the L1 test fixtures for verification that the MODEINITPRED branch ends with `vsubRaw` equal to the rhsOld read, not the extrapolated value.

  Actually, to avoid that semantic trap and match ngspice line-for-line, the PRED branch extrapolates `vbe` / `vbc` / `vsub` but then the unconditional `vbx` / `vsub` recompute at the end overwrites `vsub`. We preserve `vbe` / `vbc` from the extrapolation (they are NOT recomputed after the `if/else` chain in ngspice). Final structure:

  ```
  } else if (mode & MODEINITPRED) {
    // bjtload.c:278-305: #ifndef PREDICTOR state1→state0 copy + xfact extrapolation
    //                    for vbe / vbc / vsub.
    s0[base + SLOT_VBE]  = s1[base + SLOT_VBE];
    s0[base + SLOT_VBC]  = s1[base + SLOT_VBC];
    s0[base + SLOT_VSUB] = s1[base + SLOT_VSUB];
    vbeRaw  = (1 + ctx.xfact) * s1[base + SLOT_VBE]  - ctx.xfact * s2[base + SLOT_VBE];
    vbcRaw  = (1 + ctx.xfact) * s1[base + SLOT_VBC]  - ctx.xfact * s2[base + SLOT_VBC];
    vsubRaw = (1 + ctx.xfact) * s1[base + SLOT_VSUB] - ctx.xfact * s2[base + SLOT_VSUB];
    // bjtload.c:325-327: vbx unconditional rhsOld read (not extrapolated in ngspice).
    vbxRaw = polarity * (vBe_ext - vCi);
    // bjtload.c:328-330: ngspice re-reads vsub from rhsOld at :328-330, overwriting
    // the :304-305 extrapolation. Match this with an explicit re-read HERE so the
    // PRED branch ends with the ngspice-equivalent binding: extrapolated vbe/vbc
    // flow downstream; vsub is rhsOld.
    vsubRaw = polarity * subs * (0 - vSubCon);
  }
  ```

  This is a verbatim mirror of `bjtload.c:278-330`'s control flow. The `vsub` extrapolation is computed, then immediately overwritten by the rhsOld read — exactly what ngspice does. The state-copy `s0[SLOT_VSUB] = s1[SLOT_VSUB]` still happens (needed so the bypass block landing in Phase 5 Wave 5.2.3 reads a correct `s0[SLOT_VSUB]` baseline). The wasted compute for `vsubRaw` extrapolation is ngspice's own structure — removing it would drift from the verbatim port.

  **pnjlim skip-mask fix.** Remove `MODEINITPRED` from the skip mask at `bjt.ts:1310`. Same rationale as Task 3.2.2 — ngspice `bjtload.c:386-414` runs pnjlim on all three junctions under MODEINITPRED.

- **Files to modify**:
  - `src/components/semiconductors/bjt.ts` — (a) inside `createSpiceL1BjtElement::load()`, replace the `else if (mode & MODEINITPRED)` branch at lines 1287-1294 with the state-copy + extrapolation + rhsOld-vbx + rhsOld-vsub sequence above; (b) at line 1310, remove `| MODEINITPRED` from the pnjlim skip mask. Update the adjacent citation comment at lines 1303-1304.

- **Tests** (appended to `phase-3-xfact-predictor.test.ts`, BJT L1 section):
  - `describe("Task 3.2.3 — BJT L1 MODEINITPRED xfact")::it("extrapolates vbeRaw and vbcRaw via xfact")` — instantiate L1 via `createSpiceL1BjtElement` with default NPN model params. Seed `s1[SLOT_VBE]=0.72, s2[SLOT_VBE]=0.70`, `s1[SLOT_VBC]=-0.3, s2[SLOT_VBC]=-0.28`. `cktMode = MODETRAN | MODEINITPRED`, `xfact = 0.25`. Probe via `__phase3ProbeVbeRaw / __phase3ProbeVbcRaw` at end of MODEINITPRED branch (captured BEFORE the `vsubRaw = polarity*subs*(...)` overwrite). Assert exact values (same arithmetic as Task 3.2.2).
  - `describe("Task 3.2.3 — BJT L1 MODEINITPRED xfact")::it("writes extrapolated vsubRaw then overwrites with rhsOld per bjtload.c:328-330")` — seed `s1[SLOT_VSUB]=0.01, s2[SLOT_VSUB]=0.005`. Probe `vsubRaw` TWICE via two instrumented writes: `__phase3ProbeVsubExtrap` immediately after the extrapolation, `__phase3ProbeVsubFinal` after the rhsOld re-read. Seed rhsOld for the substrate-connection node so `polarity*subs*(0 - vSubCon) = 0.002`. Assert `__phase3ProbeVsubExtrap === (1+0.25)*0.01 - 0.25*0.005 = 0.01125` AND `__phase3ProbeVsubFinal === 0.002`. Guards against dropping either the extrapolation (ngspice computes it) or the rhsOld re-read (ngspice overwrites it) — both are required for verbatim port.
  - `describe("Task 3.2.3 — BJT L1 MODEINITPRED xfact")::it("copies s1→s0 for VBE, VBC, VSUB at the start of the PRED branch")` — verify the three state-slot copies happen by reading `s0[SLOT_VBE] / [VBC] / [VSUB]` at the point pnjlim is called (via pnjlim spy inspecting second arg).
  - `describe("Task 3.2.3 — BJT L1 MODEINITPRED xfact")::it("runs pnjlim on all three junctions under MODEINITPRED")` — spy on `pnjlim`. Seed extrapolation to push all three above their respective `vcrit` values. Assert `pnjlim` called exactly three times — BE, BC, substrate. Not zero.
  - `describe("Task 3.2.3 — BJT L1 MODEINITPRED xfact")::it("skips pnjlim under MODEINITJCT / MODEINITSMSIG / MODEINITTRAN")` — three sub-cases confirm `pnjlim` called zero times.
  - `describe("Task 3.2.3 — BJT L1 MODEINITPRED xfact")::it("falls through to rhsOld when MODEINITPRED is not set (MODEINITFLOAT)")` — `cktMode = MODETRAN` (MODEINITFLOAT). Assert `__phase3ProbeVbeRaw` / `VbcRaw` / `VsubRaw` equal their rhsOld-derived node-voltage values.

- **Acceptance criteria**:
  - `bjt.ts::createSpiceL1BjtElement::load()` contains an `else if (mode & MODEINITPRED)` branch that (a) copies `s0 = s1` for VBE, VBC, VSUB; (b) extrapolates `vbeRaw` / `vbcRaw` / `vsubRaw` using `ctx.xfact`; (c) reads `vbxRaw` and re-reads `vsubRaw` from rhsOld at the end of the branch.
  - The pnjlim skip mask at `bjt.ts:1310` reads `(MODEINITJCT | MODEINITSMSIG | MODEINITTRAN)` — `MODEINITPRED` is absent.
  - All six `Task 3.2.3` tests pass.

### Task 3.2.4: BJT L1 MODEINITPRED `SLOT_VSUB` state-copy (narrowed from plan)

- **Description**: Task 3.2.3 already adds the `s0[base + SLOT_VSUB] = s1[base + SLOT_VSUB]` copy as part of the predictor-extrapolation block. Task 3.2.4 is a standalone assertion task that verifies this state-copy exists — the plan's "ensure `SLOT_VSUB` is copied" maps to a verify-only test that will fail if Task 3.2.3's landing accidentally omits it. The plan's `SLOT_RB_EFF` reference is struck per the `Plan corrections applied` preamble (no such slot exists in `BJT_L1_SCHEMA`).

- **Files to modify**: none (Task 3.2.3 delivers the edit; Task 3.2.4 is test-only).

- **Tests** (appended to `phase-3-xfact-predictor.test.ts`):
  - `describe("Task 3.2.4 — BJT L1 VSUB state-copy")::it("copies s1[SLOT_VSUB] → s0[SLOT_VSUB] inside MODEINITPRED")` — seed `s0[SLOT_VSUB]=0.0`, `s1[SLOT_VSUB]=0.008`. After `load(ctx)` with `MODEINITPRED` AND under a load flow that does NOT terminate in a `s0[SLOT_VSUB] = vsubLimited` write (easiest: use params.SUBS=0 so the substrate junction is inactive and the end-of-load writeback bypasses SLOT_VSUB), assert `s0[SLOT_VSUB] === 0.008`. If every code path through MODEINITPRED ends with a SLOT_VSUB write-back that overwrites the copy, probe instead by spying on the exact sequence of writes to `s0[SLOT_VSUB]` and asserting the FIRST write in the MODEINITPRED branch is `0.008`.

- **Acceptance criteria**:
  - The `Task 3.2.4` test passes.
  - `grep -n "SLOT_RB_EFF" src/components/semiconductors/bjt.ts` returns zero hits (guards against reintroduction of the plan-authoring error).

### Task 3.2.5: xfact scope audit

- **Description**: Grep for every `.xfact` / `ctx.xfact` read across `src/components/` and `src/solver/analog/`. Confirm every read (except the one write at `analog-engine.ts:430` where the engine sets `ctx.loadCtx.xfact = deltaOld[0] / deltaOld[1]`) sits inside a code path guarded by `(ctx.cktMode & MODEINITPRED) !== 0`. No read outside that guard is permitted — using `xfact` when MODEINITPRED is not set would extrapolate against a stale or uninitialized predictor ratio.

  Expected reads after Phase 3:
  - `diode.ts` — one read inside the `if (mode & MODEINITPRED)` branch of the diode `load()` linearization dispatch.
  - `bjt.ts` — two reads inside the L0 `createBjtElement::load()` MODEINITPRED branch (vbe and vbc); three reads inside the L1 `createSpiceL1BjtElement::load()` MODEINITPRED branch (vbe, vbc, vsub).

  All other `xfact` reads (including any outside `load()` methods, any in tests, any in harness code) must be either inside a MODEINITPRED guard or be a test fixture. Production reads outside MODEINITPRED are a regression — STOP and escalate if found.

- **Files to create**:
  - `src/solver/analog/__tests__/phase-3-xfact-scope-audit.test.ts` — new file. Manifest-driven scope audit.

- **Files to modify**: none (audit-only).

- **Tests** (`phase-3-xfact-scope-audit.test.ts`):
  - `describe("Task 3.2.5 — xfact scope audit")::it("has zero unguarded xfact reads in src/components/")` — read each `.ts` file under `src/components/` (excluding `__tests__/`), extract every `ctx.xfact` / `.xfact` reference, for each reference assert that the enclosing `if` block condition (walking up the source AST, or using a simplified source-text parser) tests `mode & MODEINITPRED` or `ctx.cktMode & MODEINITPRED` or `(ctx.cktMode & MODEINITPRED) !== 0`. Any unguarded read fails the test with the file path + line number. Allowlist: empty (post-Phase-3 state).
  - `describe("Task 3.2.5 — xfact scope audit")::it("has zero unguarded xfact reads in src/solver/analog/")` — same audit for the solver directory. Allowlist contains exactly one entry: `analog-engine.ts:430` — the `ctx.loadCtx.xfact = ...` WRITE (not a read, but the grep will match on the identifier). Per-entry reason strings: `{ file: "analog-engine.ts", line: 430, reason: "engine-side xfact computation (write, not a guarded read)" }`.
  - `describe("Task 3.2.5 — xfact scope audit")::it("allowlist is exhaustive — no stale entries")` — for each allowlist entry, assert the cited line still exists AND still contains `.xfact`. Guards against drift: if `analog-engine.ts` is refactored and the xfact write moves, the test fails, forcing the allowlist to stay in sync.

- **Acceptance criteria**:
  - `phase-3-xfact-scope-audit.test.ts` passes with an allowlist of exactly one entry (the `analog-engine.ts` write).
  - Any future `.xfact` read added to `src/components/` or `src/solver/analog/` outside a MODEINITPRED guard will cause Task 3.2.5's audit to fail, forcing the author to either gate the read or update the allowlist with an explicit reason string.

---

## Wave 3.3: IntegrationMethod ngspice alignment (delete bdf1 / bdf2 / auto)

**Scope:** collapse the `IntegrationMethod` type to ngspice's exact 2-variant set; delete the `"bdf1"` and `"bdf2"` invented identifiers from live code, tests, and the public API; delete the `"auto"` public-API selector (never resolved anywhere — a silent invention). Rewrite the two behavioral-relay coil-inductor companions to delegate to the standard inductor element via the composite-child pattern landed in Phase 0 Wave 0.2.3. Extend the Phase 0 identifier audit to ban the three tokens across `src/`.

**ngspice citation anchor:** `ref/ngspice/src/include/ngspice/cktdefs.h:104-108` and `ref/ngspice/src/spicelib/analysis/cktntask.c:99`:

```c
int CKTintegrateMethod;     /* the integration method to be used */

/* known integration methods */
#define TRAPEZOIDAL 1
#define GEAR 2
```

```c
tsk->TSKintegrateMethod = TRAPEZOIDAL;  /* cktntask.c:99 — default */
```

Zero is "unset / not selected"; 1 and 2 are the two user-selectable methods. There is no BDF-1 in ngspice. There is no `"auto"` in ngspice. GEAR in ngspice is Gear's BDF (orders 2..6 via Vandermonde collocation at `nicomcof.c:52-127`); what digiTS called `"bdf2"` is mathematically GEAR at order 2 under a hand-unrolled formula.

**Design decisions (author-approved 2026-04-24):**

1. **Type form: string union** `"trapezoidal" | "gear"` — kept as a straight rename. Numeric enum rejected; debugging / JSON-serialization ergonomics win; semantic equivalence to ngspice's `int CKTintegrateMethod` holds at every port site.
2. **`"auto"` deleted from the public API.** Audit confirms it is set as `DEFAULT_SIMULATION_PARAMS.integrationMethod` but never resolved to a concrete method anywhere in the engine. Post-Wave-3.3 default is `"trapezoidal"` per `cktntask.c:99`.
3. **Clean break.** No deprecation shims, no string aliases, no runtime `"auto"` → `"trapezoidal"` coercion. Per the "no legacy shims" durable rule and CLAUDE.md "no pragmatic patches."
4. **The dedicated `"bdf2"` branch at `integration.ts:314-328` is deleted outright.** Bit-exact equivalence with GEAR order 2 on our own dead invented method is not worth a gate test. Order 2 routes through `solveGearVandermonde` under `method === "gear"` post-deletion. If a numerical regression surfaces at Phase 10 acceptance, it is diagnosed there, not pre-empted here.
5. **Behavioral relay rewritten to use the standard inductor element.** The two hand-rolled relay coil-inductor companions (`behavioral-remaining.ts:624-651, 734-753`) are rewritten to delegate coil integration to a child `AnalogInductorElement` via the composite-child pattern landed in Phase 0 Wave 0.2.3 (DigitalPinModel → AnalogCapacitorElement). The relay factory exposes `getChildElements()` returning one inductor element per coil; the relay's own `load()` stamps only the contact conductances; the relay's `accept()` reads the child inductor's accepted current to drive mechanical contact state. The `method === "bdf1"` / `"bdf2"` factor dispatch disappears because the child inductor consumes `ctx.ag[]` directly.
6. **`ni-integrate.ts` and `ni-pred.ts` alias comments deleted.** Each method routes to its ngspice-correct primitive exactly once: trap → `niinteg.c:28-34` + `nipred.c:46-66`; gear → `niinteg.c:43-63` + `nipred.c:79-137` (Adams-Gear predictor, already implemented as `_predictVoltagesGear`). The `|| method === "bdf1" || method === "bdf2"` disjunction in `ni-integrate.ts:38` collapses to `else if (method === "gear")`.
7. **DCOP synthetic convergence-log records (`analog-engine.ts:815, 816, 823`)** change from `method: "bdf1"` to `method: "trapezoidal"`. DCOP has no integration method; the field is non-optional, and `"trapezoidal"` is the post-init default.
8. **Public-surface consumer audit** covers `scripts/`, `src/io/`, `src/app/`, and `e2e/fixtures/` — any `integrationMethod: "auto" | "bdf1" | "bdf2"` literal is remapped to the new set; no silent back-compat shims. Scope is grep-driven at task start.
9. **Phase 0 identifier audit extended** with three banned-literal rules: `"bdf1"`, `"bdf2"`, and `integrationMethod: "auto"`. Allowlists empty; any hit fails the test. Re-introduction fails the Phase 9 sweep.
10. **`ctx.xfact` scope unchanged.** Wave 3.2.5's allowlist carries forward. The `xfact = deltaOld[0] / deltaOld[1]` write is the ngspice device-side MODEINITPRED extrapolation ratio per `bjtload.c:278-287` — applies under both methods.

**Sequencing:** Wave 3.3 runs after Wave 3.2 lands, before Phase 4. Wave 3.2's changes do not read `ctx.method`; Wave 3.3's changes do not read `ctx.xfact`; the two waves are independent but serialize for single-purpose commit hygiene. Running Wave 3.3 before Phase 4 means downstream device phases (5 / 6 / 7 / 7.5) port device `load()` bodies against the ngspice-correct method set on first contact.

**Upstream review correction:** the Phase 0 review statement *"ngspice CKTintegrateMethod (see cktdefs.h:131-139) has exactly two numeric values: TRAPEZOIDAL = 0, GEAR = 1"* is off by one. The actual ngspice values are `TRAPEZOIDAL = 1` and `GEAR = 2` at `cktdefs.h:107-108`. This spec cites the real values.

Targeted vitest scope: `src/solver/analog/__tests__/integration.test.ts`, `src/solver/analog/__tests__/ckt-terr.test.ts`, `src/solver/analog/__tests__/compute-refs.test.ts`, `src/solver/analog/__tests__/timestep.test.ts`, `src/solver/analog/__tests__/analog-engine.test.ts`, `src/core/__tests__/analog-engine-interface.test.ts`, `src/components/passives/__tests__/capacitor.test.ts`, `src/components/passives/__tests__/inductor.test.ts`, `src/components/passives/__tests__/polarized-cap.test.ts`, `src/components/passives/__tests__/transmission-line.test.ts`, `src/solver/analog/__tests__/behavioral-flipflop.test.ts`, `src/solver/analog/__tests__/behavioral-flipflop-variants.test.ts`, `src/solver/analog/__tests__/ckt-context.test.ts`, `src/solver/analog/__tests__/phase-0-identifier-audit.test.ts`.

---

### Task 3.3.1: Collapse `IntegrationMethod` to `"trapezoidal" | "gear"`; delete bdf1 / bdf2 in core + solver primitives

- **Description**: Narrow the `IntegrationMethod` type at `src/core/analog-types.ts:23` from `"trapezoidal" | "bdf1" | "bdf2" | "gear"` to `"trapezoidal" | "gear"` and rewrite the doc-comment at lines 15-22 to cite `cktdefs.h:107-108` with the correct values (`TRAPEZOIDAL = 1`, `GEAR = 2`; order 1 regardless of method uses the trap-1 coefficients per `nicomcof.c:40-41`). Delete the misleading "backwards compatibility" comment block above `method` at `src/solver/analog/load-context.ts:87-91` — there is no prior numeric form in digiTS history; the string union is the original type.

  Delete the dedicated bdf2 branch at `src/solver/analog/integration.ts:314-328`. Delete the trailing `else { /* BDF-1 */ }` branch at lines 331-335. Final `computeNIcomCof` dispatch reads:

  ```
  if (dt <= 0) { ag.fill(0); return; }
  if (method === "trapezoidal") {
    // nicomcof.c:33-51 — trap order 1 and trap order 2
    if (order === 1) {
      ag[0] = 1 / dt;
      ag[1] = -1 / dt;
    } else {
      const xmu = 0.5;
      ag[0] = 1.0 / dt / (1.0 - xmu);
      ag[1] = xmu / (1 - xmu);
    }
  } else {
    // method === "gear"
    // nicomcof.c:40-41 — order 1 regardless of method uses the trap-1 formula.
    if (order === 1) {
      ag[0] = 1 / dt;
      ag[1] = -1 / dt;
    } else {
      // nicomcof.c:52-127 — GEAR order 2..6 via Vandermonde collocation.
      solveGearVandermonde(dt, deltaOld, order, ag, scratch);
    }
  }
  ```

  Update the `ni-integrate.ts:38` dispatch from `else if (method === "gear" || method === "bdf1" || method === "bdf2")` to `else if (method === "gear")`. Delete the "bdf1 and bdf2 are aliases" comment at line 40.

  Strip every "bdf1 / bdf2 / all three" alias comment in `ni-pred.ts` at lines 17, 32, 41, 54, 171. No control-flow change — the existing `method !== "gear"` gate already routes correctly. Rename the dispatch-comment at lines 54 and 171 from "All our methods (bdf1, trapezoidal, bdf2) use the TRAPEZOIDAL predictor" to "TRAPEZOIDAL method uses the trap predictor; GEAR method uses the Adams-Gear predictor (`_computeAgpGear`, `_predictVoltagesGear`)".

  Update `ckt-terr.ts:88` doc-comment from `@param order Integration order (1 for bdf1/trap, 2 for bdf2)` to `@param order Integration order (1 for trap; 1..6 for gear)`.

  Update `analog-engine.ts:815, 816, 823` — replace the `"bdf1"` literal with `"trapezoidal"` in the DCOP synthetic convergence-log record.

  Update `src/app/convergence-log-panel.ts:115-116` — delete the `'bdf1' → 'BDF-1'` and `'bdf2' → 'BDF-2'` cases; keep only `'trapezoidal' → 'Trap'` and `'gear' → 'Gear'`.

  **Task 3.3.1 does NOT touch `src/solver/analog/behavioral-remaining.ts`.** That file's relay method-dispatch is rewritten by Task 3.3.3 via the composite-child pattern.

- **Files to modify**:
  - `src/core/analog-types.ts` — narrow the `IntegrationMethod` type literal; rewrite the doc-comment to cite `cktdefs.h:107-108` with correct values.
  - `src/solver/analog/load-context.ts` — delete the misleading "backwards compatibility" comment block at lines 87-91.
  - `src/solver/analog/integration.ts` — delete the bdf2 branch at lines 314-328; delete the trailing BDF-1 fallback at lines 331-335; rewrite the gear branch to handle order 1 inline per `nicomcof.c:40-41` and enter `solveGearVandermonde` only for order >= 2.
  - `src/solver/analog/ni-integrate.ts` — dispatch update at line 38; alias comment deletion at line 40.
  - `src/solver/analog/ni-pred.ts` — comment cleanup at lines 17, 32, 41, 54, 171.
  - `src/solver/analog/ckt-terr.ts` — doc-comment update at line 88.
  - `src/solver/analog/analog-engine.ts` — three `"bdf1"` → `"trapezoidal"` literal replacements at lines 815, 816, 823.
  - `src/app/convergence-log-panel.ts` — delete the bdf1 / bdf2 label cases at lines 115-116.

- **Tests**:
  - `src/solver/analog/__tests__/integration.test.ts` — remap every `computeNIcomCof(…, "bdf1", …)` call to `"trapezoidal"` with `order === 1`; remap every `"bdf2"` call to `"gear"` with `order === 2`. Assertions against the returned `ag[]` unchanged.
  - `src/solver/analog/__tests__/ckt-terr.test.ts` — literal remap; "order 1 bdf1: returns finite positive timestep" → "order 1 trapezoidal: ..."; "order 2 bdf2: returns sqrt-scaled timestep" → "order 2 gear: ...". Numerical assertions unchanged.
  - `src/solver/analog/__tests__/compute-refs.test.ts` — literal remap; test labels updated; golden values unchanged.
  - `src/solver/analog/__tests__/analog-engine.test.ts:898, 900` — delete the `not.toBe("bdf2")` assertion (type-level: `"bdf2"` no longer constructable); collapse the `.toContain(["trapezoidal", "bdf1"])` assertion to `expect(engine.integrationMethod).toBe("trapezoidal")`.
  - `src/solver/analog/__tests__/behavioral-flipflop.test.ts` — 13 literal remaps `'bdf1'` → `'trapezoidal'`. No assertion changes.
  - `src/solver/analog/__tests__/behavioral-flipflop-variants.test.ts` — same literal remap (scope by grep).
  - `src/solver/analog/__tests__/ckt-context.test.ts` — any `"bdf1" | "bdf2"` literal remap.
  - `src/solver/analog/__tests__/timestep.test.ts:234-272` — test "post_breakpoint_bdf1_reset_preserved" rename to "post_breakpoint_order1_trap_preserved"; assertions change from `ctrl.currentMethod === "bdf1"` to `ctrl.currentMethod === "trapezoidal" && ctrl.currentOrder === 1` — the ngspice-correct post-breakpoint shape is "order 1 trap," not a separate method identity.

- **Acceptance criteria**:
  - `src/core/analog-types.ts:23` reads `export type IntegrationMethod = "trapezoidal" | "gear";`.
  - `src/solver/analog/integration.ts` contains no `method === "bdf2"` branch and no trailing BDF-1 fallback.
  - `src/solver/analog/ni-integrate.ts:38` reads `else if (method === "gear")` with no `bdf1` / `bdf2` disjunction.
  - `src/solver/analog/load-context.ts` lines 87-91 "backwards compatibility" comment block is deleted.
  - `src/app/convergence-log-panel.ts` contains no `'bdf1'` or `'bdf2'` case.
  - `grep -n '"bdf1"\|"bdf2"' src/core/ src/solver/analog/` returns hits ONLY in tests that Task 3.3.1 is authorized to modify (and only if those tests still reference the literals as scope markers; post-remap grep should be zero).
  - All targeted tests pass with 120 s per-test timeout.
  - `tsc --noEmit` over `src/` zero errors.

---

### Task 3.3.2: `SimulationParams.integrationMethod` public API — delete `"auto"`, match internal type exactly

- **Description**: Narrow `SimulationParams.integrationMethod` at `src/core/analog-engine-interface.ts:63` from the inline union `"auto" | "trapezoidal" | "bdf1" | "bdf2"` to the imported `IntegrationMethod` type (now `"trapezoidal" | "gear"` post-Task-3.3.1). Extend the existing `import type { ... }` statement at line 15 to include `IntegrationMethod`. Update `DEFAULT_SIMULATION_PARAMS.integrationMethod` at line 153 from `"auto"` to `"trapezoidal"` (the only value `cktntask.c:99` writes; the engine behaves identically since `"auto"` never resolved anywhere). Update the doc-comment at line 62 from `Integration method. Default: 'auto'` to `Integration method. Default: 'trapezoidal' per ngspice cktntask.c:99. No "auto" mode exists in ngspice; GEAR is user-selectable.`

  Audit known caller sites and update literals:

  - `src/core/__tests__/analog-engine-interface.test.ts:40, 52, 63, 272-281` — rewrite the literal-list test to enumerate only `["trapezoidal", "gear"]`; rewrite the `DEFAULT_SIMULATION_PARAMS.integrationMethod`-is-`"auto"` assertion to assert `"trapezoidal"`.
  - `src/solver/analog/__tests__/timestep.test.ts:35` — test fixture `integrationMethod: "auto"` → `"trapezoidal"`.
  - `src/solver/analog/__tests__/harness/types.ts:53, 497, 994` — tighten `integrationMethod: string | null` to `IntegrationMethod | null`. Add `import type { IntegrationMethod } from "../../../core/analog-types.js";` (adjust path per current directory structure).

  `src/solver/analog/__tests__/harness/comparison-session.ts` needs no literal updates — all consumers of `this._engine.integrationMethod` receive the narrower string via type inference.

- **Files to modify**:
  - `src/core/analog-engine-interface.ts` — line 15 import extension; line 62 doc-comment; line 63 field type (inline union → `IntegrationMethod`); line 153 default literal.
  - `src/core/__tests__/analog-engine-interface.test.ts` — literal remap and default-value assertion update.
  - `src/solver/analog/__tests__/timestep.test.ts` — fixture literal update at line 35.
  - `src/solver/analog/__tests__/harness/types.ts` — tighten three `string | null` types and add the `IntegrationMethod` import.

- **Tests**: (covered by the modified test files above; no new test file in this task — Task 3.3.5 adds the compile-time assertion guarding against re-drift.)

- **Acceptance criteria**:
  - `src/core/analog-engine-interface.ts:63` reads `integrationMethod: IntegrationMethod;` (type imported, no inline union).
  - `src/core/analog-engine-interface.ts:153` reads `integrationMethod: "trapezoidal",`.
  - `grep -n '"auto"' src/core/analog-engine-interface.ts` returns zero hits.
  - `grep -rn 'integrationMethod: "auto"\|integrationMethod: "bdf1"\|integrationMethod: "bdf2"' src/` returns zero hits.
  - `src/solver/analog/__tests__/harness/types.ts` has no `string | null` for `integrationMethod`; every such field is typed `IntegrationMethod | null`.
  - Targeted tests pass.
  - `tsc --noEmit` zero errors.

---

### Task 3.3.3: Behavioral relay — delegate coil inductor to standard `AnalogInductorElement` via composite-child pattern

- **Description**: The two relay factories in `src/solver/analog/behavioral-remaining.ts` each carry a hand-rolled inductor companion with a method-dispatched factor:

  - `createRelayAnalogElement` (SPDT, ~line 580) — closure vars `iL`, `geqL`, `ieqL`; `load()` lines 624-651 stamp coil + contacts with the `factor = method === "bdf1" ? 1 : method === "bdf2" ? 2/3 : 0.5` dispatch at line 636; `accept()` at line 653 updates `iL` with the trap-only `factor = 0.5` formula.
  - `createRelayDTAnalogElement` (DPDT, ~line 697) — same pattern at lines 734-753 with the method-dispatch at line 743.

  Rewrite both factories to delegate coil integration to a child `AnalogInductorElement` via the composite-child protocol landed in Phase 0 Wave 0.2.3 (DigitalPinModel → AnalogCapacitorElement precedent in `src/solver/analog/digital-pin-model.ts`).

  Shape of the rewrite per factory:

  1. Import the standard inductor factory — `import { createInductorAnalogElement } from "../../components/passives/inductor.js";` (adjust path per current directory structure; confirm the factory name at implementation time).
  2. Construct one child inductor per coil: `const coilInductor = createInductorAnalogElement(<coil-pin-nodes>, <branch-idx>, { inductance: L });` — the coil inductor owns its own branch row allocation, state pool slots, and `load()` integration using `ctx.ag[]`.
  3. Expose `getChildElements()` on the relay's returned `AnalogElementCore`, returning `[coilInductor]`. The compiler's element-discovery pass (landed in Phase 0 Wave 0.2.3) registers the child as an independent MNA element with its own branch row.
  4. The relay's own `load()` stamps ONLY the contact conductances (`stampG(s, nodeContactA, nodeContactB, contactG())` for SPDT; `stampG(s, nodeCommon, nodeThrow, gThrow())` + `stampG(s, nodeCommon, nodeRest, gRest())` for DPDT). All coil-inductor stamping is handled by the child inductor's `load()`.
  5. The relay's `accept()` reads the child inductor's accepted coil current — exposed via `coilInductor.getElementCurrent()` or the equivalent accessor the inductor factory provides (confirm at implementation time by grepping the inductor's public surface). That current drives the `energised = Math.abs(iCoil) > iPull` decision and the `contactClosed` state update.
  6. Delete the `iL`, `geqL`, `ieqL` closure vars — they are fully subsumed by the child inductor's state pool.
  7. Delete every `method === "bdf1"` / `"bdf2"` / `"trapezoidal"` branch. The child inductor consumes `ctx.ag[]` through the standard `niIntegrate` path; no method-name dispatch is needed in relay code.

  The relay's `getPinCurrents()` method aggregates per-pin currents from both the child inductor (coil terminals `in1`, `in2`) and the relay's own contact stamps (contact terminals `A1`, `B1`, `C1`). Read the child inductor's branch current via its published accessor.

  **State persistence under NR-retry and LTE-rejection.** The child inductor's state is in the pool and is checkpointed/rolled-back by the engine on retry. The relay's `contactClosed` and `energised` closure scalars are NOT in the pool — they are updated in `accept()` (post-acceptance only, never on a rejected step), so they correctly lag behind the accepted solution by exactly one accepted step. This matches the current behavior; no regression. The relay's `poolBacked` flag and `stateSize` need to include the child inductor's state size via `collectPinModelChildren`-style aggregation (confirm the helper name by reading the DigitalPinModel composite precedent at `digital-pin-model.ts`).

  **E2 exemption still applies.** Relay is APPROVED ACCEPT behavioral per `architectural-alignment.md`; this rewrite does not claim ngspice parity for the relay as a component — it simply replaces the hand-rolled method-dispatched inductor companion with the standard inductor element, which is itself ngspice-aligned. Add a brief comment at each relay factory citing the composite-child delegation and linking to the DigitalPinModel precedent.

- **Files to modify**:
  - `src/solver/analog/behavioral-remaining.ts` — rewrite both `createRelayAnalogElement` and `createRelayDTAnalogElement` factories to use `AnalogInductorElement` children via `getChildElements()`. Delete the hand-rolled `iL` / `geqL` / `ieqL` state + method-dispatch. Import the inductor factory.

- **Tests**:
  - `src/solver/analog/__tests__/behavioral-flipflop.test.ts`, `src/solver/analog/__tests__/behavioral-flipflop-variants.test.ts` — the existing `'bdf1'` literals on `accept` ctx builders are already remapped by Task 3.3.1 to `'trapezoidal'`. No further changes needed from this task's scope.
  - `src/solver/analog/__tests__/behavioral-remaining.test.ts` (or whatever the relay-specific test file is — confirm by grep at task start) — existing relay tests must continue to pass. Add one new test asserting that the relay factory's returned `AnalogElementCore` exposes `getChildElements()` returning exactly one `AnalogInductorElement` per coil, and that the coil current read from the child matches the relay's pre-rewrite `iL` value to within the standard inductor integration tolerance (method-agnostic since the child consumes `ctx.ag[]` directly).
  - If a dedicated relay unit-test file does not exist, create `src/solver/analog/__tests__/phase-3-relay-composite.test.ts` with two tests:
    - `it("SPDT relay exposes coil inductor as composite child")` — instantiate `createRelayAnalogElement` with default props, assert `getChildElements().length === 1` and the child element has `isReactive === true`.
    - `it("DPDT relay exposes coil inductor as composite child")` — same assertion for `createRelayDTAnalogElement`.

- **Acceptance criteria**:
  - `grep -n 'ctx\.method' src/solver/analog/behavioral-remaining.ts` returns zero hits.
  - `grep -n '"bdf1"\|"bdf2"' src/solver/analog/behavioral-remaining.ts` returns zero hits.
  - `grep -n 'let iL\|let geqL\|let ieqL' src/solver/analog/behavioral-remaining.ts` returns zero hits (coil state moved to child inductor's pool slots).
  - Both relay factories expose `getChildElements()` returning a single `AnalogInductorElement`.
  - Existing relay-dependent tests (flipflop + any direct relay tests) pass.
  - `phase-3-relay-composite.test.ts` (new or existing file) passes the two child-existence assertions.

---

### Task 3.3.4: `getLteTimestep` signature narrowing audit

- **Description**: `AnalogElementCore.getLteTimestep` at `src/core/analog-types.ts:163-165` takes `method: IntegrationMethod`. After Task 3.3.1 narrows `IntegrationMethod`, every device implementing `getLteTimestep` sees the narrower type for free — no per-device signature edit needed. Task 3.3.4 is a grep-audit regression guard: assert every device's `getLteTimestep` implementation has no live `method === "bdf1"` or `method === "bdf2"` branch, and no device `load()` body reads `ctx.method` to dispatch on invented names.

  Grep scope: `src/components/**/*.ts` excluding `__tests__/`. Expected result post-Tasks 3.3.1 and 3.3.3: zero hits. If any hit, STOP and escalate — the spec did not anticipate that site.

- **Files to modify**: none in isolation. Covered by Task 3.3.6's identifier-audit test extension (which asserts zero hits on the three banned literals across the entire `src/` tree).

- **Tests**: covered by Task 3.3.6.

- **Acceptance criteria**:
  - `grep -rn '"bdf1"\|"bdf2"' src/components/ | grep -v __tests__/` returns zero hits.
  - Every reactive-element `getLteTimestep` implementation compiles with the narrowed `IntegrationMethod` type.

---

### Task 3.3.5: Compile-time assertion — public `SimulationParams.integrationMethod` equals internal `IntegrationMethod`

- **Description**: Add a module-scope TypeScript assertion to `src/core/analog-engine-interface.ts` that the public-API field type equals the internal `IntegrationMethod` type exactly. Guards against a future drift where one surface adds a new literal and the other doesn't — the exact bug class the Phase 0 review surfaced.

  Append near the bottom of the file (after the `DEFAULT_SIMULATION_PARAMS` export):

  ```ts
  // --- Compile-time guard: public SimulationParams.integrationMethod must
  // equal the internal IntegrationMethod type exactly (no drift between the
  // UI / MCP / postMessage public surface and the solver-facing type).
  // If this line fails to compile, the two types have diverged — realign
  // before shipping. See spec/phase-3-f2-nr-reorder-xfact.md Wave 3.3.
  type _AssertPublicInternalEq =
    SimulationParams["integrationMethod"] extends IntegrationMethod
      ? IntegrationMethod extends SimulationParams["integrationMethod"]
        ? true
        : never
      : never;
  const _assertPublicInternalEq: _AssertPublicInternalEq = true;
  void _assertPublicInternalEq;
  ```

  If either side is a strict subset/superset of the other, the conditional type resolves to `never` and the `const` initialization fails type-check.

- **Files to modify**:
  - `src/core/analog-engine-interface.ts` — append the type + const at module scope. `IntegrationMethod` import already covered by Task 3.3.2.

- **Tests**: compilation is the test. `tsc --noEmit` fails if the assertion fails.

- **Acceptance criteria**:
  - `tsc --noEmit` over `src/` zero errors.
  - `grep -n '_AssertPublicInternalEq' src/core/analog-engine-interface.ts` returns exactly one hit (the type declaration) plus the `const` initializer line.
  - If either `SimulationParams.integrationMethod` or `IntegrationMethod` is subsequently widened or narrowed out of sync, the file fails to compile.

---

### Task 3.3.6: Identifier-audit manifest extension — ban `"bdf1"`, `"bdf2"`, `integrationMethod: "auto"`

- **Description**: Extend the Phase 0 identifier-audit vitest at `src/solver/analog/__tests__/phase-0-identifier-audit.test.ts` with three new banned-literal rules:

  1. String literal `"bdf1"` (double or single quotes) — scope: all `*.ts` files under `src/` excluding the audit file itself and `spec/` / `ref/ngspice/`. Allowlist empty.
  2. String literal `"bdf2"` — same scope, allowlist empty.
  3. Regex `/integrationMethod\s*:\s*["']auto["']/` — same scope, allowlist empty. Narrower than banning `"auto"` wholesale because `"auto"` legitimately appears elsewhere (CSS defaults in `svg-render-context.ts`, digital-solver fixture IDs in `flatten-*` tests).

  The existing audit-test structure at Wave 0.3 drives banned-identifier manifests with per-entry `{ id, pattern, scopeGlob, allowlist, reason }` records. Append three records:

  ```ts
  {
    id: "bdf1-literal",
    pattern: /(["'])bdf1\1/,
    scopeGlob: "src/**/*.ts",
    allowlist: [],
    reason: "Phase 3 Wave 3.3: 'bdf1' is an invented integration method; " +
            "ngspice has no BDF-1 as a selectable method (cktdefs.h:107-108). " +
            "Order 1 under either 'trapezoidal' or 'gear' uses the trap-1 " +
            "coefficients per nicomcof.c:40-41.",
  },
  {
    id: "bdf2-literal",
    pattern: /(["'])bdf2\1/,
    scopeGlob: "src/**/*.ts",
    allowlist: [],
    reason: "Phase 3 Wave 3.3: 'bdf2' is a digiTS rename of ngspice GEAR. " +
            "Collapsed into 'gear' per cktdefs.h:107-108 (TRAPEZOIDAL=1, " +
            "GEAR=2). Order 2 routes through solveGearVandermonde.",
  },
  {
    id: "integrationMethod-auto",
    pattern: /integrationMethod\s*:\s*["']auto["']/,
    scopeGlob: "src/**/*.ts",
    allowlist: [],
    reason: "Phase 3 Wave 3.3: 'auto' is never resolved to a concrete " +
            "method anywhere in the engine — a silent invention. Default " +
            "is 'trapezoidal' per cktntask.c:99.",
  },
  ```

  Append matching per-rule documentation to `spec/phase-0-audit-report.md` in the same table format as the Phase 0 landing.

- **Files to modify**:
  - `src/solver/analog/__tests__/phase-0-identifier-audit.test.ts` — append three records to the banned-identifiers manifest array.
  - `spec/phase-0-audit-report.md` — append three rule rows.

- **Tests** (the existing audit test, now with three new rules):
  - Post-Tasks 3.3.1, 3.3.2, 3.3.3: the audit passes with zero hits on the three new rules. If any hit, the test fails with file path + line number, forcing correction before commit.

- **Acceptance criteria**:
  - `npx vitest run src/solver/analog/__tests__/phase-0-identifier-audit.test.ts --testTimeout=120000` — PASS.
  - `spec/phase-0-audit-report.md` has three new rule rows.
  - Any future re-introduction of `"bdf1"`, `"bdf2"`, or `integrationMethod: "auto"` fails Phase 9's re-run of this audit.

---

### Task 3.3.7: Public-surface consumer audit — postMessage / MCP / UI / E2E

- **Description**: `SimulationParams.integrationMethod` is imported by non-solver consumers that may construct literals with the old four-variant set:

  - MCP server entry point (`scripts/circuit-mcp-server.ts`) — any JSON schema documenting `integrationMethod` valid values must be updated to `["trapezoidal", "gear"]`.
  - postMessage adapter (`src/io/postmessage-adapter.ts`) — message payload validation / coercion. Any silent `"auto"` → concrete-method shim is removed per the clean-break decision.
  - UI / app init (`src/app/app-init.ts`) — default params flow; no-op if it only reads from `DEFAULT_SIMULATION_PARAMS`.
  - E2E fixtures under `e2e/fixtures/` — any `SimulatorHarness` or test-fixture literal passing `integrationMethod: "auto"` or the invented names.

  Task 3.3.7 is a grep-audit + targeted edit. At task start, run:

  ```
  grep -rn 'integrationMethod' scripts/ src/io/ src/app/ e2e/ --include='*.ts'
  grep -rn '"auto"\|"bdf1"\|"bdf2"' scripts/ src/io/ src/app/ e2e/ --include='*.ts' | grep -iE 'integration|method'
  ```

  Edit every hit to the new two-variant set. No silent backward-compat shims. If a consumer has no test, do not add one in Wave 3.3 — the type-level narrowing is the primary guard; runtime regressions surface at Phase 10 acceptance if they exist.

  **STOP-and-escalate trigger:** if any consumer currently relies on `"auto"` being valid at *runtime* (not just as a type literal) — e.g. runtime-dispatched coercion that maps `"auto"` to a chosen method by inspecting some other state — STOP and escalate. Do NOT insert a shim. The spec's clean-break decision assumes `"auto"` has no live runtime consumer.

- **Files to modify**: determined by grep at task start. Expected sites listed above; implementer confirms and edits each.

- **Tests**:
  - Per-consumer targeted tests if they exist (postMessage adapter test suite under `e2e/parity/` or `src/io/__tests__/`) — re-run after literal remap; assertions unchanged.
  - No new tests added by this task.

- **Acceptance criteria**:
  - `grep -rn '"auto"\|"bdf1"\|"bdf2"' scripts/ src/io/ src/app/ e2e/ --include='*.ts' | grep -iE 'integration|method'` returns zero hits.
  - `tsc --noEmit` over the full `src/` + `scripts/` + `e2e/` tree: zero errors.
  - Any JSON schema documenting `integrationMethod` valid values reads exactly `["trapezoidal", "gear"]`.

---

## Commit

One commit for Wave 3.1, one commit for Wave 3.2, one commit for Wave 3.3 (device edits of Wave 3.2 are coupled; the xfact extrapolation + pnjlim skip-mask fix land together per device file but all three device sections live in one commit to avoid intermediate states where diode has extrapolation but BJT still has stale PRED-in-skip-mask; Wave 3.3's type collapse + public-API break + relay composite-child rewrite ship as a single commit to keep `"bdf1"` / `"bdf2"` / `"auto"` out of every intermediate tree state):

```
Phase 3.1 — NR reorder verify-only + forceReorder citation hygiene
Phase 3.2 — F2 diode + BJT MODEINITPRED xfact extrapolation (ngspice-aligned: pnjlim runs on predicted voltages)
Phase 3.3 — IntegrationMethod ngspice alignment (collapse to "trapezoidal" | "gear"; delete bdf1 / bdf2 / auto; relay via composite-child inductor)
```

All three commits include the commit-body evidence protocol from `spec/phase-10-bit-exact-ngspice-parity.md` (targeted vitest command line, exit code, pass/fail count, failure names if any, and — for Wave 3.2 — the `ctx.xfact` value used in extrapolation unit tests).
